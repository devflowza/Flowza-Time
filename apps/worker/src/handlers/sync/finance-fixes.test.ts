import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import pg from 'pg';
import { defaultRegistry } from '@flowza/device-providers';
import { createMockFinanceServer, encodeFinanceCursor, financePunchFixtures, type MockFinanceServer } from '@flowza/device-providers/testing';
import { withContext } from '@flowza/database';
import { createHarness, fakeJob, type TestHarness } from '../../test/harness.js';
import type { JobContext } from '../types.js';
import { applyApprovedCorrection } from '../attendance/corrections.js';
import { normalizeRaw } from '../attendance/normalize.js';
import { meterUsage } from '../maintenance/index.js';
import { relayOutbox } from '../notifications/outbox.js';
import { pollDueDevices } from '../../tasks/sync.js';
import { createSyncJob } from './api.js';
import { pullAttendance } from './attendance.js';
import { accountKeyFor, throttlerFor } from './context.js';
import { FINANCE_POISON_MAX_ATTEMPTS, pushAttendance } from './finance-push.js';

/**
 * Regression tests for the Prompt 9 review (/tmp/p9-review.md): each block reproduces one reviewer probe (W1…W14) against the
 * real worker handlers, a real database and the mock Finance server.
 */
const ORG = '0e000000-0000-0000-0000-000000000000';
const BRANCH = '0e000000-0000-0000-0000-00000000000b';
const CONNECTOR = '0e000000-0000-0000-0000-0000000000c1';
const TERMINAL = '0e000000-0000-0000-0000-0000000000d1';
const SERIAL = 'FLOWZA-TIME-FIX';
const TOKEN = 'finance-token-fix-0123456789';
const EMP = { e100: '0e000000-0000-0000-0000-0000000000e1', e101: '0e000000-0000-0000-0000-0000000000e2', e107: '0e000000-0000-0000-0000-0000000000e7', e199: '0e000000-0000-0000-0000-0000000000e9' };
const USERS = { owner: '0e000000-0000-0000-0000-0000000000a1', hrAdmin: '0e000000-0000-0000-0000-0000000000a2' };
const BASE_CONFIG = () => ({ baseUrl: server.baseUrl, deviceSerial: SERIAL, direction: 'both', pinKey: 'employee_number', pollMinutes: 10 });

let h: TestHarness;
let server: MockFinanceServer;
let seq = 900;

beforeAll(async () => {
  server = await createMockFinanceServer({ serial: SERIAL, token: TOKEN, punches: [] });
  h = await createHarness(`flowza_worker_finfix_${process.pid}`, defaultRegistry({ flowzaFinance: { allowPrivateHosts: true } }));
  const a = h.tdb.adminDb;
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'FFX', legalName: 'Finance Fix Org', displayName: 'Finance Fix Org' }).execute();
  await a.insertInto('organizationSettings').values({ organizationId: ORG }).execute();
  await a.insertInto('branches').values({ id: BRANCH, organizationId: ORG, code: 'HQ', name: 'HQ', timezone: 'Asia/Muscat' }).execute();
  await a.insertInto('employees').values([
    { id: EMP.e100, organizationId: ORG, branchId: BRANCH, employeeNumber: 'E0100', firstName: 'A', lastName: 'One', displayName: 'A One', deviceUserId: '1', joiningDate: '2025-01-01' },
    { id: EMP.e101, organizationId: ORG, branchId: BRANCH, employeeNumber: 'E0101', firstName: 'B', lastName: 'Two', displayName: 'B Two', deviceUserId: '2', joiningDate: '2025-01-01' },
    // device user id 7 = the raw PIN of a Finance terminal in W7: it must never attract that terminal's punches
    { id: EMP.e107, organizationId: ORG, branchId: BRANCH, employeeNumber: 'E0107', firstName: 'G', lastName: 'Seven', displayName: 'G Seven', deviceUserId: '7', cardNumber: '7', joiningDate: '2025-01-01' },
    { id: EMP.e199, organizationId: ORG, branchId: BRANCH, employeeNumber: 'E0199', firstName: 'T', lastName: 'Left', displayName: 'T Left', deviceUserId: '99', joiningDate: '2020-01-01', employmentStatus: 'terminated' },
  ]).execute();
  await a.insertInto('devices').values([
    { id: CONNECTOR, organizationId: ORG, branchId: BRANCH, code: 'FLOWZA-FINANCE', name: 'Flowza Finance connector', providerKey: 'flowza_finance', manufacturer: 'FlowZa', integrationType: 'VENDOR_CLOUD_PULL', timezone: 'Asia/Muscat', serialNumber: SERIAL, endpointUrl: server.baseUrl, config: JSON.stringify(BASE_CONFIG()), syncIntervalMinutes: 10 },
    { id: TERMINAL, organizationId: ORG, branchId: BRANCH, code: 'TERM-1', name: 'Terminal 1', providerKey: 'mock', manufacturer: 'FlowZa', integrationType: 'VENDOR_CLOUD_PULL', timezone: 'Asia/Muscat', config: JSON.stringify({ scenario: 'healthy' }) },
  ]).execute();
  await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => h.deps.credentials.put(trx, { organizationId: ORG, deviceId: CONNECTOR }, { token: TOKEN }, { token: '****6789' }, null));
  await sql`insert into auth.users (id, email) values (${USERS.owner}::uuid, 'owner@ffx.local'), (${USERS.hrAdmin}::uuid, 'hradmin@ffx.local')`.execute(a);
  await a.insertInto('userProfiles').values([{ id: USERS.owner, email: 'owner@ffx.local', fullName: 'Owner' }, { id: USERS.hrAdmin, email: 'hradmin@ffx.local', fullName: 'HR Admin' }]).execute();
  await a.insertInto('orgMemberships').values([
    { organizationId: ORG, userId: USERS.owner, roleId: '10000000-0000-0000-0000-000000000001', status: 'active', allBranches: true }, // owner: integration.manage
    { organizationId: ORG, userId: USERS.hrAdmin, roleId: '10000000-0000-0000-0000-000000000003', status: 'active', allBranches: true }, // hr_admin: device.sync, not integration.manage
  ]).execute();
});
afterAll(async () => { await h?.close(); await server?.close(); });

const a = () => h.tdb.adminDb;
async function setConfig(patch: Record<string, unknown>): Promise<void> {
  await a().updateTable('devices').set({ config: JSON.stringify({ ...BASE_CONFIG(), ...patch }) }).where('id', '=', CONNECTOR).execute();
}
async function itemJob(operation: 'PULL_ATTENDANCE' | 'PUSH_ATTENDANCE', options: Record<string, unknown> = {}) {
  const prefix = operation === 'PUSH_ATTENDANCE' ? 'finance-push' : 'pull';
  await sql`delete from jobs.queue where dedupe_key = ${`${prefix}:${CONNECTOR}`}`.execute(a());
  const created = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => createSyncJob(trx, h.deps.queue, { organizationId: ORG, jobType: operation, trigger: 'MANUAL', items: [{ deviceId: CONNECTOR, operation, options }] }));
  const item = await a().selectFrom('syncJobItems').select(['id', 'queueJobId']).where('syncJobId', '=', created.syncJobId).executeTakeFirstOrThrow();
  const ctx: JobContext = { job: { id: String(item.queueJobId ?? ++seq), queueName: 'sync', jobType: operation, organizationId: ORG, payload: { syncJobId: created.syncJobId, syncJobItemId: item.id, organizationId: ORG, deviceId: CONNECTOR, employeeId: null, operation, options }, priority: 5, attempts: 1, maxAttempts: 6, correlationId: 'c', lockedBy: 'test', runAt: new Date() }, log: h.deps.log, deps: h.deps, signal: new AbortController().signal };
  return { syncJobId: created.syncJobId, itemId: item.id, ctx };
}
const push = async (options: Record<string, unknown> = {}) => pushAttendance((await itemJob('PUSH_ATTENDANCE', { settleSeconds: 0, ...options })).ctx);
const pull = async (options: Record<string, unknown> = {}) => pullAttendance((await itemJob('PULL_ATTENDANCE', options)).ctx).catch((e: unknown) => ({ threw: e }));
const state = () => a().selectFrom('financeSyncState').selectAll().where('deviceId', '=', CONNECTOR).executeTakeFirstOrThrow();
const ledger = (eventId: string) => a().selectFrom('financePushedEvents').selectAll().where('deviceId', '=', CONNECTOR).where('eventId', '=', eventId).executeTakeFirst();
const alerts = async () => (await a().selectFrom('domainEvents').selectAll().where('eventType', '=', 'sync.finance.failed' as never).where('aggregateId', '=', CONNECTOR).execute()).length;
const sentTimes = () => server.ingested.flat().map((p) => p.time);
async function insertEvent(input: { employeeId?: string; punchedAt: string; source?: 'DEVICE' | 'MANUAL' | 'MOBILE' | 'IMPORT' | 'CORRECTION'; eventType?: 'PUNCH' | 'PUNCH_IN' | 'PUNCH_OUT'; deviceId?: string | null; correctionId?: string | null }): Promise<string> {
  const row = await a().insertInto('attendanceEvents').values({ organizationId: ORG, employeeId: input.employeeId ?? EMP.e100, branchId: BRANCH, deviceId: input.deviceId === undefined ? TERMINAL : input.deviceId, source: input.source ?? 'DEVICE', eventType: input.eventType ?? 'PUNCH_IN', punchedAt: new Date(input.punchedAt), verificationMethod: 'fingerprint', correctionId: input.correctionId ?? null }).returning('id').executeTakeFirstOrThrow();
  return row.id;
}
/** Drains everything pending so a test starts from a quiet connector. */
async function drain(): Promise<void> { for (let i = 0; i < 3; i++) { const r = await push(); if (r['pushed'] === 0) break; } }
const ingestRequests = () => server.requests.filter((r) => r.path === 'attendance-ingest').length;
const exportRequests = () => server.requests.filter((r) => r.path === 'attendance-export').length;
beforeEach(async () => { await setConfig({}); });

describe('D3 — per-punch errors in a 2xx answer', () => {
  it('W1: an answer with errors > 0 does not deliver the batch; it is retried (Finance dedupes) and delivered when Finance stores it', async () => {
    await drain();
    const ev = await insertEvent({ punchedAt: '2026-04-01T04:00:00Z' });
    const failuresBefore = (await state()).consecutiveFailures;
    server.failNext({ status: 200, path: 'attendance-ingest', body: { ok: true, received: 1, ingested: 0, duplicates: 0, unmapped: 0, errors: 1, skipped: 0 } });
    const first = await push();
    expect(first).toMatchObject({ status: 'FAILED', errors: 1 });
    expect(await ledger(ev)).toBeUndefined();
    let s = await state();
    expect(s).toMatchObject({ pushRetryEventId: ev, pushRetryAttempts: 1, consecutiveFailures: failuresBefore + 1 });
    expect(s.lastError).toMatch(/rejected 1 of 1 punch/);
    const second = await push();
    expect(second).toMatchObject({ status: 'SUCCESS', pushed: 1, ingested: 1, errors: 0 });
    expect(sentTimes()).toContain('2026-04-01T04:00:00.000Z');
    expect(await ledger(ev)).toMatchObject({ outcome: 'pushed' });
    s = await state();
    expect(s).toMatchObject({ pushRetryEventId: null, pushRetryAttempts: 0, consecutiveFailures: 0, lastError: null });
    expect((await push())['pushed']).toBe(0);
  });

  it(`a batch Finance keeps rejecting is retried ${FINANCE_POISON_MAX_ATTEMPTS} times, then skipped as poison with an alert, and never sent again`, async () => {
    await drain();
    const ev = await insertEvent({ punchedAt: '2026-04-02T04:00:00Z' });
    const alertsBefore = await alerts();
    for (let attempt = 1; attempt <= FINANCE_POISON_MAX_ATTEMPTS; attempt++) {
      server.failNext({ status: 200, path: 'attendance-ingest', body: { ok: true, received: 1, ingested: 0, duplicates: 0, unmapped: 0, errors: 1, skipped: 0 } });
      const r = await push();
      expect(r['status']).toBe('FAILED');
      const s = await state();
      if (attempt < FINANCE_POISON_MAX_ATTEMPTS) {
        expect(s.pushRetryAttempts).toBe(attempt);
        expect(await ledger(ev)).toBeUndefined();
      } else {
        expect(r).toMatchObject({ poisonSkipped: 1 });
        expect(await ledger(ev)).toMatchObject({ outcome: 'poison_skipped' });
        expect(s).toMatchObject({ pushRetryEventId: null, pushRetryAttempts: 0 });
        expect(s.lastError).toMatch(/skipped/);
      }
    }
    // the streak alert (3rd failure) and the skip alert: an administrator hears about the skipped punch
    const skipAlerts = await a().selectFrom('domainEvents').select('payload').where('eventType', '=', 'sync.finance.failed' as never).where('aggregateId', '=', CONNECTOR).execute();
    expect(await alerts()).toBeGreaterThan(alertsBefore);
    expect(skipAlerts.some((e) => (e.payload as { reason?: string }).reason === 'batch_skipped')).toBe(true);
    const requestsBefore = ingestRequests();
    expect(await push()).toMatchObject({ status: 'SUCCESS', pushed: 0 });
    expect(ingestRequests()).toBe(requestsBefore);
  });
});

describe('D4 — events committed late', () => {
  it('W2: an event whose transaction commits after a run moved past its created_at is still pushed', async () => {
    await drain();
    const client = new pg.Client({ connectionString: h.tdb.connectionString });
    await client.connect();
    try {
      await client.query('begin');
      await client.query(`insert into public.attendance_events (organization_id, employee_id, branch_id, device_id, source, event_type, punched_at, verification_method)
        values ($1, $2, $3, $4, 'DEVICE', 'PUNCH_IN', '2026-04-03T04:00:00Z', 'fingerprint')`, [ORG, EMP.e100, BRANCH, TERMINAL]);
      await new Promise((r) => setTimeout(r, 50));
      const b = await insertEvent({ employeeId: EMP.e101, punchedAt: '2026-04-03T05:00:00Z' }); // created (and committed) after A's transaction began
      const first = await push();
      expect(first).toMatchObject({ status: 'SUCCESS', pushed: 1 });
      expect(await ledger(b)).toMatchObject({ outcome: 'pushed' });
      await client.query('commit');
    } finally { await client.end(); }
    const second = await push();
    expect(second).toMatchObject({ status: 'SUCCESS', pushed: 1 });
    expect(sentTimes().filter((t) => t === '2026-04-03T04:00:00.000Z')).toHaveLength(1);
  });
});

describe('D11 — one push per connector at a time', () => {
  it('W9: two concurrent runs send every punch once (the second run is a no-op)', async () => {
    await drain();
    const times = ['2026-04-04T04:00:00Z', '2026-04-04T05:00:00Z', '2026-04-04T06:00:00Z'];
    for (const t of times) await insertEvent({ punchedAt: t });
    const requestsBefore = ingestRequests();
    server.delayNext(800, 'attendance-ingest');
    const first = push();
    const deadline = Date.now() + 10_000;
    while (ingestRequests() === requestsBefore && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const second = await push();
    expect(second).toMatchObject({ status: 'SUCCESS', skipped: 'already_running' });
    expect(await first).toMatchObject({ status: 'SUCCESS', pushed: 3 });
    expect(ingestRequests()).toBe(requestsBefore + 1);
    for (const t of times) expect(sentTimes().filter((x) => x === new Date(t).toISOString())).toHaveLength(1);
  });
});

describe('D5 — failure streak', () => {
  it('W5: pull failures between push runs that had nothing to send reach the threshold and alert once; only a Finance success resets', async () => {
    await drain();
    expect((await pull())).toMatchObject({ status: 'SUCCESS' }); // reset the streak with a real Finance answer
    const before = await alerts();
    for (let n = 1; n <= 3; n++) {
      server.failNext({ status: 401, path: 'attendance-export' });
      expect(await pull()).toMatchObject({ status: 'FAILED', errorCode: 'AUTH_FAILED' });
      expect(await push()).toMatchObject({ status: 'SUCCESS', pushed: 0, requests: 0 });
      const s = await state();
      expect(s.consecutiveFailures).toBe(n); // the push that never contacted Finance neither reset the streak …
      expect(s.lastError).toMatch(/AUTH_FAILED/); // … nor cleared the error the card shows
    }
    expect(await alerts()).toBe(before + 1);
    server.failNext({ status: 401, path: 'attendance-export' });
    await pull();
    expect(await alerts()).toBe(before + 1); // 4th failure of the same streak: no second alert
    expect(await pull()).toMatchObject({ status: 'SUCCESS' });
    expect(await state()).toMatchObject({ consecutiveFailures: 0, lastError: null });
    for (let n = 1; n <= 3; n++) { server.failNext({ status: 401, path: 'attendance-export' }); await pull(); }
    expect(await alerts()).toBe(before + 2); // a new streak after a success alerts again
    expect(await pull()).toMatchObject({ status: 'SUCCESS' });
  });
});

describe('D6 — a push-only connector never pulls', () => {
  it('W6: the pull handler skips it without calling Finance, and the scheduler never plans a pull for it', async () => {
    server.punches.push(...financePunchFixtures(2, '2026-04-05T04:00:00.000Z').map((p, i) => ({ ...p, id: `00000000-0000-4000-8000-0000000006${String(i).padStart(2, '0')}` })));
    await setConfig({ direction: 'push' });
    // even a connector row whose capability flag was never narrowed (saved before the fix) is not pulled
    await a().updateTable('devices').set({ autoSyncEnabled: true, nextAttendanceSyncAt: new Date(Date.now() - 60_000), capabilities: JSON.stringify({}) }).where('id', '=', CONNECTOR).execute();
    const exportsBefore = exportRequests();
    const rawBefore = (await a().selectFrom('attendanceRawTransactions').select('id').where('deviceId', '=', CONNECTOR).execute()).length;
    expect(await pull()).toMatchObject({ status: 'SUCCESS', skipped: 'direction_push' });
    expect(exportRequests()).toBe(exportsBefore);
    expect((await a().selectFrom('attendanceRawTransactions').select('id').where('deviceId', '=', CONNECTOR).execute()).length).toBe(rawBefore);
    await sql`update public.sync_job_items set status = 'SUCCESS' where device_id = ${CONNECTOR}::uuid and status in ('PENDING', 'QUEUED', 'RUNNING', 'RETRYING')`.execute(a());
    const planned = await pollDueDevices(h.deps);
    const items = planned.jobs.length ? await a().selectFrom('syncJobItems').select('deviceId').where('syncJobId', 'in', planned.jobs).execute() : [];
    expect(items.map((i) => i.deviceId)).not.toContain(CONNECTOR);
    await a().updateTable('devices').set({ autoSyncEnabled: false }).where('id', '=', CONNECTOR).execute();
  });
});

describe('D7 — identity of pulled punches', () => {
  it('W7: resolved only by Finance employee number; a raw terminal PIN never matches a device user id or card, whatever pinKey says', async () => {
    await setConfig({ pinKey: 'device_user_id' });
    const [pinOnly, byNumber, leaver] = financePunchFixtures(3, '2026-04-06T04:00:00.000Z', { device_serial: 'FIN-GATE' });
    server.punches.push(
      { ...pinOnly!, id: '00000000-0000-4000-8000-000000000701', employee_number: null, pin: '7' },
      { ...byNumber!, id: '00000000-0000-4000-8000-000000000702', employee_number: ' e0100 ', pin: '555' },
      { ...leaver!, id: '00000000-0000-4000-8000-000000000703', employee_number: 'E0199', pin: '99' },
    );
    expect(await pull()).toMatchObject({ status: 'SUCCESS' });
    await normalizeRaw({ job: fakeJob('NORMALIZE_RAW', { organizationId: ORG }, ORG), deps: h.deps, log: h.deps.log, signal: new AbortController().signal });
    const rows = await a().selectFrom('attendanceRawTransactions').select(['providerTransactionId', 'deviceEmployeeId', 'processingStatus', 'employeeId']).where('deviceId', '=', CONNECTOR).where('providerTransactionId', 'in', ['00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000702', '00000000-0000-4000-8000-000000000703']).orderBy('providerTransactionId').execute();
    expect(rows).toEqual([
      { providerTransactionId: '00000000-0000-4000-8000-000000000701', deviceEmployeeId: 'pin:FIN-GATE:7', processingStatus: 'unmatched', employeeId: null },
      { providerTransactionId: '00000000-0000-4000-8000-000000000702', deviceEmployeeId: 'e0100', processingStatus: 'normalized', employeeId: EMP.e100 },
      { providerTransactionId: '00000000-0000-4000-8000-000000000703', deviceEmployeeId: 'E0199', processingStatus: 'unmatched', employeeId: null },
    ]);
  });
});

describe('D8 — corrections of pulled punches', () => {
  async function applyCorrection(input: { type: 'ADD_PUNCH' | 'EDIT_PUNCH'; originalEventId?: string; originalPunchedAt?: string; proposedPunchedAt: string }): Promise<string> {
    const c = await a().insertInto('attendanceCorrections').values({
      organizationId: ORG, employeeId: EMP.e100, branchId: BRANCH, attendanceDate: input.proposedPunchedAt.slice(0, 10), type: input.type, originalEventId: input.originalEventId ?? null,
      originalPunchedAt: input.originalPunchedAt ? new Date(input.originalPunchedAt) : null, proposedPunchedAt: new Date(input.proposedPunchedAt), proposedEventType: 'PUNCH_IN', reason: 'review fix test', status: 'APPROVED',
    }).returning('id').executeTakeFirstOrThrow();
    const res = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => applyApprovedCorrection(trx, c.id, { queue: h.deps.queue, appliedBy: null }));
    return res.appliedEventId!;
  }

  it('W10: an EDIT of a pulled punch (and an edit of that edit) is never pushed back; an ADD_PUNCH correction is', async () => {
    await drain();
    const pulledAt = '2026-04-07T04:31:00Z';
    const pulled = await insertEvent({ punchedAt: pulledAt, deviceId: CONNECTOR }); // a punch that came from Finance
    const edited = await applyCorrection({ type: 'EDIT_PUNCH', originalEventId: pulled, originalPunchedAt: pulledAt, proposedPunchedAt: '2026-04-07T05:30:00Z' });
    await applyCorrection({ type: 'EDIT_PUNCH', originalEventId: edited, originalPunchedAt: '2026-04-07T05:30:00Z', proposedPunchedAt: '2026-04-07T05:45:00Z' });
    await applyCorrection({ type: 'ADD_PUNCH', proposedPunchedAt: '2026-04-07T13:00:00Z' });
    const r = await push();
    expect(r).toMatchObject({ status: 'SUCCESS', pushed: 1 });
    expect(sentTimes()).toContain('2026-04-07T13:00:00.000Z');
    expect(sentTimes()).not.toContain('2026-04-07T05:30:00.000Z');
    expect(sentTimes()).not.toContain('2026-04-07T05:45:00.000Z');
    expect(sentTimes()).not.toContain('2026-04-07T04:31:00.000Z');
  });
});

describe('D10 — cursor safety', () => {
  it('W8: a gateway 404 / 400 / 503 / malformed answer keeps the cursor; the next run resumes and misses nothing', async () => {
    const day = 86_400_000;
    const at = (ms: number) => new Date(Date.now() - ms).toISOString();
    const anchor = { ...financePunchFixtures(1, at(10 * day))[0]!, id: '00000000-0000-4000-8000-000000000801' };
    const nineDays = { ...financePunchFixtures(1, at(9 * day))[0]!, id: '00000000-0000-4000-8000-000000000802', employee_number: 'E0101' };
    const oneDay = { ...financePunchFixtures(1, at(1 * day))[0]!, id: '00000000-0000-4000-8000-000000000803', employee_number: 'E0101' };
    server.punches.push(anchor, nineDays, oneDay);
    const stored = { since: encodeFinanceCursor(anchor.created_at!, anchor.id) };
    await a().updateTable('syncCursors').set({ cursor: JSON.stringify(stored), rewindReason: null, previousCursor: null }).where('deviceId', '=', CONNECTOR).where('stream', '=', 'attendance').execute();
    for (const fault of [{ status: 404 }, { status: 400, body: { error: 'bad' } }, { status: 503 }, { status: 200, body: { punches: 'x' } }] as const) {
      server.failNext({ ...fault, path: 'attendance-export' });
      const r = await pull();
      expect('threw' in r ? r.threw : r).toMatchObject({ retryable: true }); // retried with backoff
      const cursor = await a().selectFrom('syncCursors').select(['cursor', 'rewindReason', 'invalidSince']).where('deviceId', '=', CONNECTOR).where('stream', '=', 'attendance').executeTakeFirstOrThrow();
      expect(cursor).toMatchObject({ cursor: stored, rewindReason: null, invalidSince: null });
    }
    expect(await pull()).toMatchObject({ status: 'SUCCESS', inserted: 2, cursorResets: 0 });
    const got = await a().selectFrom('attendanceRawTransactions').select('providerTransactionId').where('deviceId', '=', CONNECTOR).where('providerTransactionId', 'in', [nineDays.id, oneDay.id]).execute();
    expect(got).toHaveLength(2);
  });
});

describe('D12 — per-tenant throttle and circuit account', () => {
  it('two tenants\' connectors on the same Finance URL never share an account key', () => {
    const cfg = JSON.stringify({ baseUrl: 'https://ucjtxdmklhhhvayirwqe.supabase.co/functions/v1', deviceSerial: 'X' });
    const mk = (organizationId: string, id: string) => ({ id, organizationId, providerKey: 'flowza_finance', config: JSON.parse(cfg), endpointUrl: 'https://ucjtxdmklhhhvayirwqe.supabase.co/functions/v1', serialNumber: 'X', integrationType: 'VENDOR_CLOUD_PULL' as const });
    const k1 = accountKeyFor(mk(ORG, CONNECTOR));
    const k2 = accountKeyFor(mk('0e000000-0000-0000-0000-00000000ffff', CONNECTOR));
    const k3 = accountKeyFor(mk(ORG, '0e000000-0000-0000-0000-0000000000c2'));
    expect(new Set([k1, k2, k3]).size).toBe(3);
  });

  it('W14: a throttle wait this worker gives up on is its own queueing, not Finance failing — no streak, no circuit failure, device not marked offline', async () => {
    await drain();
    await insertEvent({ punchedAt: '2026-04-12T04:00:00Z' });
    const circuit = () => a().selectFrom('providerCircuitStates').select(['accountKey', 'state', 'failureCount']).where('organizationId', '=', ORG).where('providerKey', '=', 'flowza_finance').execute();
    const before = { state: await state(), circuit: await circuit() };
    const device = await a().selectFrom('devices').selectAll().where('id', '=', CONNECTOR).executeTakeFirstOrThrow();
    // another conversation of this connector holds its only device slot (maxConcurrentPerDevice = 1), so this run waits locally
    const held = await throttlerFor(h.deps.providers.get('flowza_finance')).acquire(accountKeyFor(device), { deviceKey: CONNECTOR });
    const requests = ingestRequests();
    try {
      const { ctx } = await itemJob('PUSH_ATTENDANCE', { settleSeconds: 0 });
      const gaveUp = new AbortController();
      setTimeout(() => gaveUp.abort(), 300);
      const r = await pushAttendance({ ...ctx, signal: gaveUp.signal }).catch((e: unknown) => ({ threw: e }));
      expect(JSON.stringify('threw' in r ? { message: (r.threw as Error).message, ...(r.threw as object) } : r)).toMatch(/Throttle wait/);
    } finally {
      held.release();
    }
    expect(ingestRequests()).toBe(requests); // Finance was never contacted
    expect(await state()).toMatchObject({ consecutiveFailures: before.state.consecutiveFailures, lastError: before.state.lastError });
    expect(await circuit()).toEqual(before.circuit);
    expect((await a().selectFrom('devices').select('lastErrorCode').where('id', '=', CONNECTOR).executeTakeFirstOrThrow()).lastErrorCode).not.toBe('TIMEOUT');
    expect(await push()).toMatchObject({ status: 'SUCCESS', pushed: 1 }); // with the slot free, the next run delivers it
  });
});

describe('D16 — who hears about a failing connector', () => {
  it('sync.finance.failed notifies integration.manage holders (who can act on /settings/integrations), not device.sync-only roles', async () => {
    await a().insertInto('domainEvents').values({ organizationId: ORG, eventType: 'sync.finance.failed' as never, aggregateType: 'device', aggregateId: CONNECTOR, payload: JSON.stringify({ deviceId: CONNECTOR, direction: 'pull', consecutiveFailures: 3, code: 'AUTH_FAILED', error: 'x' }) }).execute();
    await relayOutbox({ job: fakeJob('RELAY_OUTBOX'), log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
    const notes = await a().selectFrom('notifications').select(['userId', 'link']).where('type', '=', 'sync.finance.failed').execute();
    expect(notes.map((n) => n.userId)).toContain(USERS.owner);
    expect(notes.map((n) => n.userId)).not.toContain(USERS.hrAdmin);
    expect(notes.every((n) => n.link === '/settings/integrations')).toBe(true);
  });
});

describe('start date and usage metering', () => {
  it('the push never sends a punch dated before the connector start date', async () => {
    await drain();
    await setConfig({ syncFrom: '2026-04-10' });
    await insertEvent({ punchedAt: '2026-04-09T19:00:00Z' }); // 23:00 on the 9th in Muscat: before the start date
    await insertEvent({ punchedAt: '2026-04-09T21:00:00Z' }); // 01:00 on the 10th in Muscat
    const r = await push();
    expect(r).toMatchObject({ status: 'SUCCESS', pushed: 1 });
    expect(sentTimes()).toContain('2026-04-09T21:00:00.000Z');
    expect(sentTimes()).not.toContain('2026-04-09T19:00:00.000Z');
  });

  it('usage metering counts terminals, not the connector', async () => {
    await meterUsage({ job: fakeJob('USAGE_METERING'), log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
    const devices = await a().selectFrom('usageRecords').select('value').where('organizationId', '=', ORG).where('metric', '=', 'devices').executeTakeFirstOrThrow();
    expect(devices.value).toBe('1');
  });
});

describe('D9 — a run that outlives a re-pointing', () => {
  it('writes neither the position nor the ledger once the connector generation changed under it', async () => {
    await drain();
    const ev = await insertEvent({ punchedAt: '2026-04-11T04:00:00Z' });
    server.delayNext(600, 'attendance-ingest');
    const running = push();
    const deadline = Date.now() + 10_000;
    const before = ingestRequests();
    while (ingestRequests() === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    // what the API does on a re-pointing: generation + 1, push state and ledger cleared
    await sql`update public.devices set generation = generation + 1 where id = ${CONNECTOR}::uuid`.execute(a());
    await sql`update public.finance_sync_state set push_position_at = null, last_pushed_event_id = null, last_pushed_event_at = null where device_id = ${CONNECTOR}::uuid`.execute(a());
    await sql`delete from public.finance_pushed_events where device_id = ${CONNECTOR}::uuid`.execute(a());
    await running;
    expect(await ledger(ev)).toBeUndefined();
    expect(await state()).toMatchObject({ pushPositionAt: null, lastPushedEventId: null });
  });
});
