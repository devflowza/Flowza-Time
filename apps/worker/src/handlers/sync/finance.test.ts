import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createMockFinanceServer, defaultRegistry, encodeFinanceCursor, financePunchFixtures, type MockFinanceServer } from '@flowza/device-providers';
import { withContext } from '@flowza/database';
import { AppError } from '@flowza/shared';
import { createHarness, fakeJob, type TestHarness } from '../../test/harness.js';
import type { JobContext } from '../types.js';
import { normalizeRaw } from '../attendance/normalize.js';
import { scheduleFinancePushes } from '../../tasks/finance.js';
import { createSyncJob } from './api.js';
import { pullAttendance } from './attendance.js';
import { pushAttendance } from './finance-push.js';
import { FINANCE_FAILURE_ALERT_THRESHOLD } from './finance-state.js';

const ORG = '0f000000-0000-0000-0000-000000000000';
const BRANCH = '0f000000-0000-0000-0000-00000000000b';
const CONNECTOR = '0f000000-0000-0000-0000-0000000000c1';
const TERMINAL = '0f000000-0000-0000-0000-0000000000d1';
const SERIAL = 'FLOWZA-TIME-FIN';
const TOKEN = 'finance-token-0123456789abcdef';
const EMP = { e100: '0f000000-0000-0000-0000-0000000000e1', e101: '0f000000-0000-0000-0000-0000000000e2', e102: '0f000000-0000-0000-0000-0000000000e3' };

let h: TestHarness;
let server: MockFinanceServer;
let queueSeq = 500;
const clock = () => new Date();

beforeAll(async () => {
  // five Finance punches covering every identity path of the normaliser:
  //  0 E0100 → employee number; 1 'e0101' → case-insensitive employee number (citext); 2 E9999 → unknown, stays unmatched;
  //  3 no employee number, PIN '3' → unmatched even though an employee has device_user_id '3' (no generic fallback);
  //  4 E7777 → explicit provider identity mapping (what reconciliation writes) → E0102
  const punches = financePunchFixtures(5, '2026-03-02T04:00:00.000Z');
  punches[1] = { ...punches[1]!, employee_number: 'e0101' };
  punches[2] = { ...punches[2]!, employee_number: 'E9999', pin: '9999' };
  punches[3] = { ...punches[3]!, employee_number: null, pin: '3' };
  punches[4] = { ...punches[4]!, employee_number: 'E7777', pin: '7777' };
  server = await createMockFinanceServer({ serial: SERIAL, token: TOKEN, punches, knownPins: ['E0100', 'E0101', 'E0102'] });
  h = await createHarness(`flowza_worker_finance_${process.pid}`, defaultRegistry({ flowzaFinance: { allowPrivateHosts: true } }), clock);
  const a = h.tdb.adminDb;
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'FIN', legalName: 'Finance Org', displayName: 'Finance Org' }).execute();
  await a.insertInto('organizationSettings').values({ organizationId: ORG, sync: JSON.stringify({ defaultIntervalMinutes: 5 }) }).execute();
  await a.insertInto('branches').values({ id: BRANCH, organizationId: ORG, code: 'HQ', name: 'HQ', timezone: 'Asia/Muscat' }).execute();
  await a.insertInto('employees').values([
    { id: EMP.e100, organizationId: ORG, branchId: BRANCH, employeeNumber: 'E0100', firstName: 'A', lastName: 'One', displayName: 'A One', deviceUserId: '1', cardNumber: 'CARD-100', joiningDate: '2025-01-01' },
    { id: EMP.e101, organizationId: ORG, branchId: BRANCH, employeeNumber: 'E0101', firstName: 'B', lastName: 'Two', displayName: 'B Two', deviceUserId: '2', cardNumber: null, joiningDate: '2025-01-01' },
    { id: EMP.e102, organizationId: ORG, branchId: BRANCH, employeeNumber: 'E0102', firstName: 'C', lastName: 'Three', displayName: 'C Three', deviceUserId: '3', cardNumber: 'CARD-102', joiningDate: '2025-01-01' },
  ]).execute();
  await a.insertInto('devices').values([
    { id: CONNECTOR, organizationId: ORG, branchId: BRANCH, code: 'FLOWZA-FINANCE', name: 'Flowza Finance connector', providerKey: 'flowza_finance', manufacturer: 'FlowZa', integrationType: 'VENDOR_CLOUD_PULL', timezone: 'Asia/Muscat', serialNumber: SERIAL, endpointUrl: server.baseUrl,
      config: JSON.stringify({ baseUrl: server.baseUrl, deviceSerial: SERIAL, direction: 'both', pinKey: 'employee_number', pollMinutes: 10 }), syncIntervalMinutes: 10 },
    { id: TERMINAL, organizationId: ORG, branchId: BRANCH, code: 'TERM-1', name: 'Terminal 1', providerKey: 'mock', manufacturer: 'FlowZa', integrationType: 'VENDOR_CLOUD_PULL', timezone: 'Asia/Muscat', config: JSON.stringify({ scenario: 'healthy' }) },
  ]).execute();
  await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => h.deps.credentials.put(trx, { organizationId: ORG, deviceId: CONNECTOR }, { token: TOKEN }, { token: '****cdef' }, null));
  await a.insertInto('employeeProviderIdentities').values({ organizationId: ORG, providerKey: 'flowza_finance', deviceUserId: 'E7777', employeeId: EMP.e102 }).execute();
});
afterAll(async () => { await h?.close(); await server?.close(); });

async function itemJob(operation: 'PULL_ATTENDANCE' | 'PUSH_ATTENDANCE', options: Record<string, unknown> = {}) {
  const prefix = operation === 'PUSH_ATTENDANCE' ? 'finance-push' : 'pull';
  await sql`delete from jobs.queue where dedupe_key = ${`${prefix}:${CONNECTOR}`}`.execute(h.tdb.adminDb);
  const created = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => createSyncJob(trx, h.deps.queue, { organizationId: ORG, jobType: operation, trigger: 'MANUAL', items: [{ deviceId: CONNECTOR, operation, options }] }));
  const item = await h.tdb.adminDb.selectFrom('syncJobItems').select(['id', 'queueJobId']).where('syncJobId', '=', created.syncJobId).executeTakeFirstOrThrow();
  const ctx: JobContext = { job: { id: String(item.queueJobId ?? ++queueSeq), queueName: 'sync', jobType: operation, organizationId: ORG, payload: { syncJobId: created.syncJobId, syncJobItemId: item.id, organizationId: ORG, deviceId: CONNECTOR, employeeId: null, operation, options }, priority: 5, attempts: 1, maxAttempts: 6, correlationId: 'c', lockedBy: 'test', runAt: clock() }, log: h.deps.log, deps: h.deps, signal: new AbortController().signal };
  return { syncJobId: created.syncJobId, itemId: item.id, ctx };
}
const normalizeCtx = (): JobContext => ({ job: fakeJob('NORMALIZE_RAW', { organizationId: ORG }, ORG), deps: h.deps, log: h.deps.log, signal: new AbortController().signal });
const state = () => h.tdb.adminDb.selectFrom('financeSyncState').selectAll().where('deviceId', '=', CONNECTOR).executeTakeFirstOrThrow();
const rawRows = () => h.tdb.adminDb.selectFrom('attendanceRawTransactions').selectAll().where('deviceId', '=', CONNECTOR).orderBy('punchedAt').execute();
const events = (type: string) => h.tdb.adminDb.selectFrom('domainEvents').selectAll().where('eventType', '=', type as never).execute();
async function insertEvent(input: { employeeId: string; punchedAt: string; source?: 'DEVICE' | 'MANUAL' | 'MOBILE' | 'IMPORT' | 'CORRECTION'; eventType?: 'PUNCH' | 'PUNCH_IN' | 'PUNCH_OUT' | 'BREAK_START'; deviceId?: string | null; verificationMethod?: 'fingerprint' | 'face' | 'mobile' | 'unknown'; rawTransactionId?: string; voided?: boolean }): Promise<string> {
  const row = await h.tdb.adminDb.insertInto('attendanceEvents').values({ organizationId: ORG, employeeId: input.employeeId, branchId: BRANCH, deviceId: input.deviceId === undefined ? TERMINAL : input.deviceId, source: input.source ?? 'DEVICE', eventType: input.eventType ?? 'PUNCH_IN', punchedAt: new Date(input.punchedAt), verificationMethod: input.verificationMethod ?? 'fingerprint', rawTransactionId: input.rawTransactionId ?? null, voidedAt: input.voided ? new Date() : null }).returning('id').executeTakeFirstOrThrow();
  return row.id;
}
/** A raw punch of an ordinary terminal carrying GPS in its payload (what a mobile check-in stores). */
async function insertRawWithGps(punchedAt: string, gps: { lat: number; lng: number; accuracy: number }): Promise<string> {
  const row = await h.tdb.adminDb.insertInto('attendanceRawTransactions').values({ organizationId: ORG, deviceId: TERMINAL, branchId: BRANCH, providerKey: 'mock', deviceEmployeeId: '3', punchedAt: new Date(punchedAt), source: 'POLL', dedupeHash: `gps-${punchedAt}`, processingStatus: 'normalized', rawPayload: JSON.stringify(gps) }).returning('id').executeTakeFirstOrThrow();
  return String(row.id);
}

describe('Flowza Finance connector — pull', () => {
  it('ingests Finance punches as raw rows of the connector device and stores the Finance cursor + pull state', async () => {
    const j = await itemJob('PULL_ATTENDANCE');
    const res = await pullAttendance(j.ctx);
    expect(res['status']).toBe('SUCCESS');
    expect(res['inserted']).toBe(5);
    const rows = await rawRows();
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.deviceEmployeeId)).toEqual(['E0100', 'e0101', 'E9999', '3', 'E7777']);
    expect(rows.every((r) => r.providerKey === 'flowza_finance' && r.source === 'POLL' && r.processingStatus === 'pending')).toBe(true);
    expect(rows[0]!.rawPayload).toMatchObject({ financeId: server.punches[0]!.id, source: 'mobile', connectorSerial: SERIAL });
    const cursor = await h.tdb.adminDb.selectFrom('syncCursors').selectAll().where('deviceId', '=', CONNECTOR).where('stream', '=', 'attendance').executeTakeFirstOrThrow();
    expect(cursor.cursor).toEqual({ since: encodeFinanceCursor(server.punches[4]!.time_utc, server.punches[4]!.id) });
    const s = await state();
    expect(s.lastPullCount).toBe(5);
    expect(s.lastPullAt).not.toBeNull();
    expect(s.consecutiveFailures).toBe(0);
    // the next pull is due after the connector's own interval (10 min), whatever the org's adaptive polling does
    const d = await h.tdb.adminDb.selectFrom('devices').select(['nextAttendanceSyncAt', 'adaptiveIntervalMinutes']).where('id', '=', CONNECTOR).executeTakeFirstOrThrow();
    expect(d.adaptiveIntervalMinutes).toBe(10);
    expect(server.requests.at(-1)!.body).toMatchObject({ device_serial: SERIAL, token: TOKEN });
  });

  it('is idempotent: the next pull finds nothing new and a full re-sync dedupes every replayed punch', async () => {
    const again = await pullAttendance((await itemJob('PULL_ATTENDANCE')).ctx);
    expect(again).toMatchObject({ status: 'SUCCESS', inserted: 0, duplicates: 0 });
    for (let i = 0; i < 3; i++) await pullAttendance((await itemJob('PULL_ATTENDANCE')).ctx); // empty polls never stretch the interval
    expect(await h.tdb.adminDb.selectFrom('devices').select('adaptiveIntervalMinutes').where('id', '=', CONNECTOR).executeTakeFirstOrThrow()).toEqual({ adaptiveIntervalMinutes: 10 });
    const resync = await pullAttendance((await itemJob('PULL_ATTENDANCE', { fullResync: true })).ctx);
    expect(resync).toMatchObject({ status: 'SUCCESS', inserted: 0, duplicates: 5, fullResync: true });
    expect(await rawRows()).toHaveLength(5);
  });

  it('resolves pulled punches by the configured employee field, then explicit mappings; everything else stays unmatched for reconciliation', async () => {
    const res = await normalizeRaw(normalizeCtx());
    expect(res).toMatchObject({ normalized: 3, unmatched: 2, events: 3 });
    const rows = await rawRows();
    const by = (id: string) => rows.find((r) => r.deviceEmployeeId === id);
    expect(by('E0100')).toMatchObject({ processingStatus: 'normalized', employeeId: EMP.e100 });
    expect(by('e0101')).toMatchObject({ processingStatus: 'normalized', employeeId: EMP.e101 });
    expect(by('E7777')).toMatchObject({ processingStatus: 'normalized', employeeId: EMP.e102 });
    expect(by('E9999')).toMatchObject({ processingStatus: 'unmatched', employeeId: null });
    // PIN '3' equals an employee's device_user_id, but a Finance identity never falls through to that generic match
    expect(by('3')).toMatchObject({ processingStatus: 'unmatched', employeeId: null });
    const pulled = await h.tdb.adminDb.selectFrom('attendanceEvents').select(['deviceId', 'employeeId', 'eventType']).where('organizationId', '=', ORG).execute();
    expect(pulled).toHaveLength(3);
    expect(pulled.every((e) => e.deviceId === CONNECTOR)).toBe(true);
  });
});

describe('Flowza Finance connector — push', () => {
  it('pushes FlowZa Time punches in creation order, never the ones pulled from Finance, and advances the keyset only after 2xx', async () => {
    await insertEvent({ employeeId: EMP.e100, punchedAt: '2026-03-03T04:00:00Z', eventType: 'PUNCH_IN', verificationMethod: 'fingerprint' });
    const second = await insertEvent({ employeeId: EMP.e101, punchedAt: '2026-03-03T12:30:00Z', eventType: 'PUNCH_OUT', verificationMethod: 'face' });
    const manual = await insertEvent({ employeeId: EMP.e102, punchedAt: '2026-03-03T05:00:00Z', source: 'MANUAL', deviceId: null }); // HR bookkeeping: not a punch
    await insertEvent({ employeeId: EMP.e101, punchedAt: '2026-03-03T06:00:00Z', voided: true }); // voided by a correction: never sent
    const gpsRaw = await insertRawWithGps('2026-03-03T07:15:00Z', { lat: 23.5859, lng: 58.4059, accuracy: 9 });
    await insertEvent({ employeeId: EMP.e102, punchedAt: '2026-03-03T07:15:00Z', source: 'MOBILE', eventType: 'PUNCH', verificationMethod: 'mobile', rawTransactionId: gpsRaw });
    const last = await insertEvent({ employeeId: EMP.e100, punchedAt: '2026-03-03T09:00:00Z', source: 'CORRECTION', eventType: 'BREAK_START', deviceId: null, verificationMethod: 'unknown' });
    const j = await itemJob('PUSH_ATTENDANCE', { settleSeconds: 0 });
    const res = await pushAttendance(j.ctx);
    expect(res).toMatchObject({ status: 'SUCCESS', pushed: 4, ingested: 4, duplicates: 0, unmapped: 0, skippedNoPin: 0, batches: 1, hasMore: false, pinKey: 'employee_number' });
    expect(server.ingested).toHaveLength(1);
    expect(server.ingested[0]).toEqual([
      { pin: 'E0100', time: '2026-03-03T04:00:00.000Z', verify: 'fingerprint', state: 'check_in', workcode: null, lat: null, lng: null, accuracy: null },
      { pin: 'E0101', time: '2026-03-03T12:30:00.000Z', verify: 'face', state: 'check_out', workcode: null, lat: null, lng: null, accuracy: null },
      { pin: 'E0102', time: '2026-03-03T07:15:00.000Z', verify: 'mobile', state: null, workcode: null, lat: 23.5859, lng: 58.4059, accuracy: 9 },
      { pin: 'E0100', time: '2026-03-03T09:00:00.000Z', verify: null, state: 'break_out', workcode: null, lat: null, lng: null, accuracy: null },
    ]);
    expect(server.ingested.flat().map((p) => p.time)).not.toContain('2026-03-03T05:00:00.000Z'); // the MANUAL entry
    expect(server.ingested.flat().map((p) => p.time)).not.toContain('2026-03-03T06:00:00.000Z'); // the voided event
    // loop guard: the two events created from pulled Finance punches (device_id = connector) never travelled back
    const sentTimes = server.ingested.flat().map((p) => p.time);
    for (const p of server.punches) expect(sentTimes).not.toContain(new Date(p.time_utc).toISOString());
    const s = await state();
    expect(s.lastPushedEventId).toBe(last);
    expect(s.lastPushedEventId).not.toBe(manual);
    expect(s.lastPushCount).toBe(4);
    expect(s.lastPushAt).not.toBeNull();
    expect(new Date(s.nextPushAt!).getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    const item = await h.tdb.adminDb.selectFrom('syncJobItems').selectAll().where('id', '=', j.itemId).executeTakeFirstOrThrow();
    expect(item).toMatchObject({ status: 'SUCCESS', recordsIngested: 4 });
    expect((await h.tdb.adminDb.selectFrom('syncJobs').selectAll().where('id', '=', j.syncJobId).executeTakeFirstOrThrow()).status).toBe('SUCCESS');
    const logs = await h.tdb.adminDb.selectFrom('deviceLogs').select(['event']).where('deviceId', '=', CONNECTOR).execute();
    expect(logs.some((l) => l.event === 'attendance_pushed')).toBe(true);
    // a second run has nothing new: the position does not move and nothing is sent
    const again = await pushAttendance((await itemJob('PUSH_ATTENDANCE', { settleSeconds: 0 })).ctx);
    expect(again).toMatchObject({ status: 'SUCCESS', pushed: 0, batches: 0 });
    expect(server.ingested).toHaveLength(1);
    expect((await state()).lastPushedEventId).toBe(last);
    expect(second).not.toBe(last);
  });

  it('batches by the configured size and continues from the last delivered event; employees without the PIN field are skipped, not invented', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await insertEvent({ employeeId: [EMP.e100, EMP.e101, EMP.e102][i % 3]!, punchedAt: `2026-03-04T0${i}:00:00Z`, eventType: i % 2 ? 'PUNCH_OUT' : 'PUNCH_IN' }));
    // pinKey card_number: E0101 has no card → skipped; the position still advances past it
    await h.tdb.adminDb.updateTable('devices').set({ config: JSON.stringify({ baseUrl: server.baseUrl, deviceSerial: SERIAL, direction: 'both', pinKey: 'card_number', pollMinutes: 10 }) }).where('id', '=', CONNECTOR).execute();
    const before = server.ingested.length;
    const res = await pushAttendance((await itemJob('PUSH_ATTENDANCE', { settleSeconds: 0, batchSize: 2 })).ctx);
    expect(res).toMatchObject({ status: 'SUCCESS', events: 5, pushed: 3, skippedNoPin: 2, batches: 3, hasMore: false, pinKey: 'card_number' });
    const batches = server.ingested.slice(before);
    // batches of 2 events: [e100, e101] → 1 punch, [e102, e100] → 2, [e101] → nothing to send (no request made)
    expect(batches.map((b) => b.length)).toEqual([1, 2]);
    expect(batches.flat().map((p) => p.pin)).toEqual(['CARD-100', 'CARD-102', 'CARD-100']);
    expect((await state()).lastPushedEventId).toBe(ids[4]);
    // maxBatches bounds a run and leaves the connector due immediately when more remains
    await h.tdb.adminDb.updateTable('devices').set({ config: JSON.stringify({ baseUrl: server.baseUrl, deviceSerial: SERIAL, direction: 'both', pinKey: 'employee_number', pollMinutes: 10 }) }).where('id', '=', CONNECTOR).execute();
    for (let i = 0; i < 3; i++) await insertEvent({ employeeId: EMP.e100, punchedAt: `2026-03-05T0${i}:00:00Z` });
    const bounded = await pushAttendance((await itemJob('PUSH_ATTENDANCE', { settleSeconds: 0, batchSize: 1, maxBatches: 2 })).ctx);
    expect(bounded).toMatchObject({ status: 'SUCCESS', pushed: 2, batches: 2, hasMore: true });
    expect(new Date((await state()).nextPushAt!).getTime()).toBeLessThanOrEqual(Date.now());
    const rest = await pushAttendance((await itemJob('PUSH_ATTENDANCE', { settleSeconds: 0 })).ctx);
    expect(rest).toMatchObject({ status: 'SUCCESS', pushed: 1, hasMore: false });
  });

  it('counts consecutive failures, keeps the position, emits sync.finance.failed once at the threshold and resets on success', async () => {
    const posBefore = (await state()).lastPushedEventId;
    await insertEvent({ employeeId: EMP.e100, punchedAt: '2026-03-06T04:00:00Z' });
    const sentBefore = server.ingested.length;
    for (let n = 1; n <= FINANCE_FAILURE_ALERT_THRESHOLD; n++) {
      server.failNext({ status: 503, path: 'attendance-ingest' });
      const j = await itemJob('PUSH_ATTENDANCE', { settleSeconds: 0 });
      let err: unknown;
      try { await pushAttendance(j.ctx); } catch (e) { err = e; }
      expect(AppError.is(err) || (err as Error) instanceof Error).toBe(true);
      expect((err as { retryable?: boolean }).retryable).toBe(true);
      const s = await state();
      expect(s.consecutiveFailures).toBe(n);
      expect(s.lastPushedEventId).toBe(posBefore);
      expect(s.lastError).toContain('VENDOR_ERROR');
      expect(await events('sync.finance.failed')).toHaveLength(n >= FINANCE_FAILURE_ALERT_THRESHOLD ? 1 : 0);
      const item = await h.tdb.adminDb.selectFrom('syncJobItems').selectAll().where('id', '=', j.itemId).executeTakeFirstOrThrow();
      expect(item.status).toBe('RETRYING');
      expect(item.lastErrorCode).toBe('VENDOR_ERROR');
    }
    const alert = (await events('sync.finance.failed'))[0]!;
    expect(alert.aggregateId).toBe(CONNECTOR);
    expect(alert.payload).toMatchObject({ deviceId: CONNECTOR, direction: 'push', consecutiveFailures: 3, code: 'VENDOR_ERROR' });
    expect(JSON.stringify(alert.payload)).not.toContain(TOKEN);
    const ok = await pushAttendance((await itemJob('PUSH_ATTENDANCE', { settleSeconds: 0 })).ctx);
    expect(ok).toMatchObject({ status: 'SUCCESS', pushed: 1 });
    expect(server.ingested).toHaveLength(sentBefore + 1);
    const s = await state();
    expect(s.consecutiveFailures).toBe(0);
    expect(s.lastError).toBeNull();
    expect(s.lastPushedEventId).not.toBe(posBefore);
  });

  it('a failed pull counts towards the same streak and an auth failure flags the connector', async () => {
    server.failNext({ status: 401, path: 'attendance-export' });
    const res = await pullAttendance((await itemJob('PULL_ATTENDANCE')).ctx);
    expect(res).toMatchObject({ status: 'FAILED', errorCode: 'AUTH_FAILED' });
    const s = await state();
    expect(s.consecutiveFailures).toBe(1);
    expect(s.lastError).toContain('AUTH_FAILED');
    expect((await h.tdb.adminDb.selectFrom('devices').select(['connectionStatus', 'lastErrorCode']).where('id', '=', CONNECTOR).executeTakeFirstOrThrow())).toMatchObject({ connectionStatus: 'error', lastErrorCode: 'AUTH_FAILED' });
    const fine = await pullAttendance((await itemJob('PULL_ATTENDANCE')).ctx);
    expect(fine['status']).toBe('SUCCESS');
    expect((await state()).consecutiveFailures).toBe(0);
  });

  it('a pull-only connector skips the push without touching Finance', async () => {
    await h.tdb.adminDb.updateTable('devices').set({ config: JSON.stringify({ baseUrl: server.baseUrl, deviceSerial: SERIAL, direction: 'pull', pinKey: 'employee_number', pollMinutes: 10 }) }).where('id', '=', CONNECTOR).execute();
    const before = server.requests.length;
    await insertEvent({ employeeId: EMP.e100, punchedAt: '2026-03-07T04:00:00Z' });
    const res = await pushAttendance((await itemJob('PUSH_ATTENDANCE', { settleSeconds: 0 })).ctx);
    expect(res).toMatchObject({ status: 'SUCCESS', skipped: 'direction_pull' });
    expect(server.requests.length).toBe(before);
    await h.tdb.adminDb.updateTable('devices').set({ config: JSON.stringify({ baseUrl: server.baseUrl, deviceSerial: SERIAL, direction: 'both', pinKey: 'employee_number', pollMinutes: 10 }) }).where('id', '=', CONNECTOR).execute();
  });
});

describe('Flowza Finance connector — scheduler', () => {
  it('admits due push/both connectors once, pushes next_push_at forward and skips connectors with a push in flight', async () => {
    await sql`delete from jobs.queue where dedupe_key = ${`finance-push:${CONNECTOR}`}`.execute(h.tdb.adminDb);
    await sql`update public.sync_job_items set status = 'SUCCESS' where device_id = ${CONNECTOR}::uuid and status in ('PENDING', 'QUEUED', 'RUNNING', 'RETRYING')`.execute(h.tdb.adminDb);
    await h.tdb.adminDb.updateTable('financeSyncState').set({ nextPushAt: new Date(Date.now() - 60_000) }).where('deviceId', '=', CONNECTOR).execute();
    const first = await scheduleFinancePushes(h.deps);
    expect(first.devices).toBe(1);
    expect(first.jobs).toHaveLength(1);
    const job = await h.tdb.adminDb.selectFrom('syncJobs').selectAll().where('id', '=', first.jobs[0]!).executeTakeFirstOrThrow();
    expect(job).toMatchObject({ jobType: 'PUSH_ATTENDANCE', trigger: 'SCHEDULED', itemsTotal: 1 });
    const queued = await sql<{ n: string }>`select count(*) as n from jobs.queue where job_type = 'PUSH_ATTENDANCE' and dedupe_key = ${`finance-push:${CONNECTOR}`}`.execute(h.tdb.adminDb);
    expect(Number(queued.rows[0]!.n)).toBe(1);
    expect(new Date((await state()).nextPushAt!).getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    // the item is in flight → not admitted again even when due
    await h.tdb.adminDb.updateTable('financeSyncState').set({ nextPushAt: new Date(Date.now() - 60_000) }).where('deviceId', '=', CONNECTOR).execute();
    const second = await scheduleFinancePushes(h.deps);
    expect(second.devices).toBe(0);
    // a pull-only connector is never admitted
    await sql`update public.sync_job_items set status = 'SUCCESS' where device_id = ${CONNECTOR}::uuid and status in ('PENDING', 'QUEUED', 'RUNNING', 'RETRYING')`.execute(h.tdb.adminDb);
    await h.tdb.adminDb.updateTable('devices').set({ config: JSON.stringify({ baseUrl: server.baseUrl, deviceSerial: SERIAL, direction: 'pull', pinKey: 'employee_number', pollMinutes: 10 }) }).where('id', '=', CONNECTOR).execute();
    expect((await scheduleFinancePushes(h.deps)).devices).toBe(0);
  });
});
