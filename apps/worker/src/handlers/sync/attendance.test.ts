import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { defaultRegistry } from '@flowza/device-providers';
import { withContext } from '@flowza/database';
import { AppError } from '@flowza/shared';
import { createHarness, type TestHarness } from '../../test/harness.js';
import type { JobContext } from '../types.js';
import { pullAttendance } from './attendance.js';
import { webhookEvent } from './device.js';
import { createSyncJob } from './api.js';
import { checkCircuit, recordFailure, recordSuccess } from './circuit.js';
import { ingestRawTransactions, dedupeHash } from './ingest.js';
import { accountKeyFor } from './context.js';

const ORG = '0a000000-0000-0000-0000-000000000000';
const BRANCH = '0a000000-0000-0000-0000-00000000000b';
const D = {
  healthy: '0a000000-0000-0000-0000-0000000000d1', duplicates: '0a000000-0000-0000-0000-0000000000d2', flaky: '0a000000-0000-0000-0000-0000000000d3', offline: '0a000000-0000-0000-0000-0000000000d4',
  unknown: '0a000000-0000-0000-0000-0000000000d5', auth: '0a000000-0000-0000-0000-0000000000d6', rate: '0a000000-0000-0000-0000-0000000000d7', push: '0a000000-0000-0000-0000-0000000000d8', webhook: '0a000000-0000-0000-0000-0000000000d9',
};
let clock = new Date('2026-09-05T08:00:00Z');
const startDate = () => DateTime.fromJSDate(clock, { zone: 'utc' }).minus({ days: 4 }).toISODate()!;
let h: TestHarness;
let queueSeq = 100;

beforeAll(async () => {
  h = await createHarness(`flowza_worker_sync_att_${process.pid}`, defaultRegistry({ clock: () => clock }), () => clock);
  const a = h.tdb.adminDb;
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'SYA', legalName: 'Sync A', displayName: 'Sync A' }).execute();
  await a.insertInto('organizationSettings').values({ organizationId: ORG, sync: JSON.stringify({ defaultIntervalMinutes: 5, maxIntervalMinutes: 40 }) }).execute();
  await a.insertInto('branches').values({ id: BRANCH, organizationId: ORG, code: 'HQ', name: 'HQ', timezone: 'Asia/Muscat' }).execute();
  await a.insertInto('employees').values([1, 2, 3].map((i) => ({ organizationId: ORG, branchId: BRANCH, employeeNumber: `EMP${i}`, firstName: `F${i}`, lastName: `L${i}`, displayName: `Emp ${i}`, deviceUserId: `E00${i}`, joiningDate: '2025-01-01' }))).execute();
  const cfg = (scenario: string, extra: Record<string, unknown> = {}) => JSON.stringify({ scenario, employeeCount: 3, startDate: startDate(), ...extra });
  const dev = (id: string, code: string, scenario: string, extra: Record<string, unknown> = {}) => ({ id, organizationId: ORG, branchId: BRANCH, code, name: code, providerKey: 'mock', manufacturer: 'FlowZa', integrationType: 'VENDOR_CLOUD_PULL' as const, timezone: 'Asia/Muscat', config: cfg(scenario, extra), syncIntervalMinutes: 5 });
  await a.insertInto('devices').values([
    dev(D.healthy, 'HEALTHY', 'healthy'), dev(D.duplicates, 'DUPES', 'duplicates'), dev(D.flaky, 'FLAKY', 'flaky'), dev(D.offline, 'OFFLINE', 'offline'),
    dev(D.unknown, 'UNKNOWN', 'unknown_employees', { employeeCount: 20 }), dev(D.auth, 'AUTH', 'auth_failed'), dev(D.rate, 'RATE', 'rate_limited', { retryAfterMs: 120_000 }),
    { ...dev(D.push, 'PUSH', 'healthy'), providerKey: 'zkteco_push', integrationType: 'DEVICE_PUSH' as const, serialNumber: 'ZK-PUSH-1', config: '{}' },
    { ...dev(D.webhook, 'HOOK', 'healthy'), integrationType: 'VENDOR_WEBHOOK' as const, serialNumber: 'HOOK-SERIAL-1' },
  ]).execute();
  await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => h.deps.credentials.put(trx, { organizationId: ORG, deviceId: D.healthy }, { apiKey: 'valid' }, { apiKey: '****alid' }, null));
});
afterAll(async () => { await h?.close(); });

/** Creates a one-item sync job for the device and returns a JobContext like the runner would build. */
async function itemJob(deviceId: string, operation = 'PULL_ATTENDANCE', options: Record<string, unknown> = {}, opts: { trigger?: 'MANUAL' | 'SCHEDULED' | 'SYSTEM'; devices?: string[] } = {}) {
  const devices = opts.devices ?? [deviceId];
  // handlers are invoked directly (no Runner), so the queue rows of earlier runs are still "pending": clear them like a
  // completed run would, otherwise the dedupe key would mark the new item SKIPPED (which is exercised separately below)
  await sql`delete from jobs.queue where dedupe_key = any(${sql.val(devices.map((d) => `${operation === 'DEVICE_HEALTH_CHECK' ? 'health' : 'pull'}:${d}`))}::text[])`.execute(h.tdb.adminDb);
  const created = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => createSyncJob(trx, h.deps.queue, {
    organizationId: ORG, jobType: operation as never, trigger: opts.trigger ?? 'MANUAL', items: devices.map((d) => ({ deviceId: d, operation: operation as never, options })),
  }));
  const items = await h.tdb.adminDb.selectFrom('syncJobItems').select(['id', 'deviceId', 'queueJobId']).where('syncJobId', '=', created.syncJobId).execute();
  const ctxFor = (dId: string): JobContext => {
    const item = items.find((i) => i.deviceId === dId)!;
    return { job: { id: String(item.queueJobId ?? ++queueSeq), queueName: 'sync', jobType: operation, organizationId: ORG, payload: { syncJobId: created.syncJobId, syncJobItemId: item.id, organizationId: ORG, deviceId: dId, employeeId: null, operation, options }, priority: 5, attempts: 1, maxAttempts: 6, correlationId: 'c', lockedBy: 'test', runAt: clock }, log: h.deps.log, deps: h.deps, signal: new AbortController().signal };
  };
  return { syncJobId: created.syncJobId, items, ctxFor, ctx: ctxFor(deviceId) };
}

const job = (id: string) => h.tdb.adminDb.selectFrom('syncJobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const item = (id: string) => h.tdb.adminDb.selectFrom('syncJobItems').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const rawCount = (deviceId: string, status?: string) => { let q = h.tdb.adminDb.selectFrom('attendanceRawTransactions').select((eb) => eb.fn.countAll<string>().as('n')).where('deviceId', '=', deviceId); if (status) q = q.where('processingStatus', '=', status as never); return q.executeTakeFirstOrThrow().then((r) => Number(r.n)); };
const events = (type: string, aggregateId?: string) => { let q = h.tdb.adminDb.selectFrom('domainEvents').selectAll().where('eventType', '=', type as never); if (aggregateId) q = q.where('aggregateId', '=', aggregateId); return q.execute(); };
const device = (id: string) => h.tdb.adminDb.selectFrom('devices').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

describe('PULL_ATTENDANCE', () => {
  it('ingests deterministic mock punches, stores the cursor, schedules the adaptive next poll and completes the job with one sync.completed', async () => {
    const j = await itemJob(D.healthy, 'PULL_ATTENDANCE', { pageSize: 10 });
    const res = await pullAttendance(j.ctx);
    expect(res['status']).toBe('SUCCESS');
    const n = await rawCount(D.healthy);
    expect(n).toBeGreaterThan(20);
    expect(res['inserted']).toBe(n);
    expect(res['duplicates']).toBe(0);
    expect(Number(res['pages'])).toBeGreaterThan(1);
    const rows = await h.tdb.adminDb.selectFrom('attendanceRawTransactions').select(['dedupeHash', 'deviceEmployeeId', 'punchedAt', 'verificationMethod', 'direction', 'assumedTimezone', 'deviceGeneration', 'source', 'providerKey', 'branchId', 'processingStatus']).where('deviceId', '=', D.healthy).limit(3).execute();
    for (const r of rows) {
      expect(r.dedupeHash).toBe(dedupeHash(D.healthy, 1, { deviceEmployeeId: r.deviceEmployeeId, punchedAt: new Date(r.punchedAt).toISOString(), verificationMethod: r.verificationMethod, direction: r.direction }));
      expect(r).toMatchObject({ assumedTimezone: 'Asia/Muscat', deviceGeneration: 1, source: 'POLL', providerKey: 'mock', branchId: BRANCH, processingStatus: 'pending' });
    }
    const cursor = await h.tdb.adminDb.selectFrom('syncCursors').selectAll().where('deviceId', '=', D.healthy).where('stream', '=', 'attendance').executeTakeFirstOrThrow();
    expect((cursor.cursor as { lastSeq: number }).lastSeq).toBe(n);
    expect(cursor.lastPulledAt).not.toBeNull();
    expect(cursor.lastTransactionAt).not.toBeNull();
    const d = await device(D.healthy);
    expect(d.connectionStatus).toBe('online');
    expect(d.lastAttendanceSyncAt).not.toBeNull();
    expect(d.emptyPollCount).toBe(0);
    expect(d.adaptiveIntervalMinutes).toBe(5);
    expect(new Date(d.nextAttendanceSyncAt!).getTime()).toBe(clock.getTime() + 5 * 60_000);
    const jb = await job(j.syncJobId);
    expect(jb).toMatchObject({ status: 'SUCCESS', itemsTotal: 1, itemsSuccess: 1, itemsPending: 0, recordsIngested: n });
    expect(jb.finishedAt).not.toBeNull();
    expect(await events('sync.completed', j.syncJobId)).toHaveLength(1);
    expect(await events('sync.failed', j.syncJobId)).toHaveLength(0);
    const it = await item(j.items[0]!.id);
    expect(it.status).toBe('SUCCESS');
    expect(it.attempts).toBe(1);
    const attempts = await h.tdb.adminDb.selectFrom('syncAttempts').selectAll().where('syncJobItemId', '=', it.id).execute();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attemptNo: 1, status: 'SUCCESS', workerId: 'test-worker' });
    // the normaliser was woken exactly once for the organisation
    const norm = await sql<{ n: string }>`select count(*) as n from jobs.queue where job_type = 'NORMALIZE_RAW' and dedupe_key = ${`normalize:${ORG}`}`.execute(h.tdb.adminDb);
    expect(Number(norm.rows[0]!.n)).toBe(1);
    const logs = await h.tdb.adminDb.selectFrom('deviceLogs').select(['event']).where('deviceId', '=', D.healthy).execute();
    expect(logs.some((l) => l.event === 'attendance_pulled')).toBe(true);
  });

  it('is idempotent: a second run ingests nothing new and the adaptive interval grows after empty polls', async () => {
    const before = await rawCount(D.healthy);
    const j = await itemJob(D.healthy);
    const res = await pullAttendance(j.ctx);
    expect(res['inserted']).toBe(0);
    expect(await rawCount(D.healthy)).toBe(before);
    let d = await device(D.healthy);
    expect(d.emptyPollCount).toBe(1);
    expect(d.adaptiveIntervalMinutes).toBe(5);
    for (let i = 0; i < 2; i++) await pullAttendance((await itemJob(D.healthy)).ctx);
    d = await device(D.healthy);
    expect(d.emptyPollCount).toBe(3);
    expect(d.adaptiveIntervalMinutes).toBe(10); // doubled after 3 empty polls, capped by org maxIntervalMinutes (40)
    // re-running the same (already final) item is a no-op
    expect(await pullAttendance(j.ctx)).toEqual({ skipped: 'already_success' });
  });

  it('counts duplicates the provider replays and never stores them twice', async () => {
    const j = await itemJob(D.duplicates, 'PULL_ATTENDANCE', { pageSize: 10 });
    const res = await pullAttendance(j.ctx);
    expect(res['status']).toBe('SUCCESS');
    expect(Number(res['duplicates'])).toBeGreaterThan(0);
    expect(res['inserted']).toBe(await rawCount(D.duplicates));
    const dupHashes = await sql<{ n: string }>`select count(*) as n from (select dedupe_hash from public.attendance_raw_transactions where device_id = ${D.duplicates}::uuid group by dedupe_hash having count(*) > 1) x`.execute(h.tdb.adminDb);
    expect(Number(dupHashes.rows[0]!.n)).toBe(0);
  });

  it('keeps punches of unknown device users as pending raw rows for the normaliser', async () => {
    const j = await itemJob(D.unknown);
    await pullAttendance(j.ctx);
    const ghosts = await h.tdb.adminDb.selectFrom('attendanceRawTransactions').select(['deviceEmployeeId', 'processingStatus', 'employeeId']).where('deviceId', '=', D.unknown).where('deviceEmployeeId', 'like', 'GHOST-%').execute();
    expect(ghosts.length).toBeGreaterThan(0);
    expect(ghosts.every((g) => g.processingStatus === 'pending' && g.employeeId === null)).toBe(true);
  });

  it('flaky provider: retryable failures keep committed pages + cursor, item RETRYING with next_attempt_at, and eventually succeeds', async () => {
    const j = await itemJob(D.flaky, 'PULL_ATTENDANCE', { pageSize: 5 });
    let err: unknown;
    try { await pullAttendance(j.ctx); } catch (e) { err = e; }
    expect(AppError.is(err) && err.retryable).toBe(true);
    const afterFirst = await rawCount(D.flaky);
    expect(afterFirst).toBe(10); // two pages of 5 were committed before call 3 failed
    const cursor = await h.tdb.adminDb.selectFrom('syncCursors').select('cursor').where('deviceId', '=', D.flaky).executeTakeFirstOrThrow();
    expect((cursor.cursor as { lastSeq: number }).lastSeq).toBe(10);
    let it = await item(j.items[0]!.id);
    expect(it.status).toBe('RETRYING');
    expect(it.attempts).toBe(1);
    expect(it.lastErrorCode).toBe('VENDOR_ERROR');
    expect(it.nextAttemptAt).not.toBeNull();
    expect(new Date(it.nextAttemptAt!).getTime()).toBeGreaterThan(clock.getTime());
    expect((await job(j.syncJobId)).status).toBe('RUNNING');
    expect((await job(j.syncJobId)).itemsPending).toBe(1);
    // the runner re-delivers until the provider cooperates
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await pullAttendance({ ...j.ctx, job: { ...j.ctx.job, attempts: attempt + 2 } }); break; } catch (e) { expect(AppError.is(e) && e.retryable).toBe(true); }
    }
    it = await item(j.items[0]!.id);
    expect(it.status).toBe('SUCCESS');
    expect(it.attempts).toBeGreaterThan(1);
    expect(await rawCount(D.flaky)).toBeGreaterThan(afterFirst);
    const attempts = await h.tdb.adminDb.selectFrom('syncAttempts').select(['attemptNo', 'status', 'errorCode']).where('syncJobItemId', '=', it.id).orderBy('attemptNo').execute();
    expect(attempts.length).toBe(it.attempts);
    expect(attempts.at(-1)!.status).toBe('SUCCESS');
    expect(attempts.some((a) => a.errorCode === 'VENDOR_ERROR' || a.errorCode === 'TIMEOUT')).toBe(true);
    expect((await job(j.syncJobId)).status).toBe('SUCCESS');
    expect(await events('sync.completed', j.syncJobId)).toHaveLength(1);
  });

  it('offline device: item OFFLINE, retryable error thrown, device failure counted with hysteresis', async () => {
    const j = await itemJob(D.offline);
    await expect(pullAttendance(j.ctx)).rejects.toMatchObject({ retryable: true });
    const it = await item(j.items[0]!.id);
    expect(it.status).toBe('OFFLINE');
    expect(it.lastErrorCode).toBe('DEVICE_OFFLINE');
    expect(it.finishedAt).toBeNull();
    const d = await device(D.offline);
    expect(d.consecutiveFailures).toBe(1);
    expect(d.connectionStatus).toBe('degraded'); // not yet offline (needs 3 consecutive failures)
    expect(d.lastErrorCode).toBe('DEVICE_OFFLINE');
    expect((await job(j.syncJobId)).status).toBe('RUNNING');
    expect(await events('device.offline', D.offline)).toHaveLength(0);
  });

  it('auth failure is terminal: item FAILED, no throw, device flagged error, job FAILED with exactly one sync.failed', async () => {
    const j = await itemJob(D.auth);
    const res = await pullAttendance(j.ctx);
    expect(res['status']).toBe('FAILED');
    const it = await item(j.items[0]!.id);
    expect(it).toMatchObject({ status: 'FAILED', lastErrorCode: 'AUTH_FAILED' });
    expect(it.finishedAt).not.toBeNull();
    expect((await device(D.auth)).connectionStatus).toBe('error');
    const jb = await job(j.syncJobId);
    expect(jb).toMatchObject({ status: 'FAILED', itemsFailed: 1, itemsPending: 0, errorCode: 'AUTH_FAILED' });
    expect(await events('sync.failed', j.syncJobId)).toHaveLength(1);
    expect(await events('sync.completed', j.syncJobId)).toHaveLength(0);
    expect(await pullAttendance(j.ctx)).toEqual({ skipped: 'already_failed' });
  });

  it('rate limited: retryAfterMs from the provider is honoured for the reschedule', async () => {
    const j = await itemJob(D.rate, 'PULL_ATTENDANCE', { pageSize: 5 });
    let err: unknown;
    try { await pullAttendance(j.ctx); } catch (e) { err = e; }
    expect(AppError.is(err)).toBe(true);
    expect((err as AppError).retryable).toBe(true);
    expect((err as AppError).retryAfterMs).toBe(120_000);
    const it = await item(j.items[0]!.id);
    expect(it.status).toBe('RETRYING');
    expect(it.lastErrorCode).toBe('RATE_LIMITED');
    expect(new Date(it.nextAttemptAt!).getTime() - clock.getTime()).toBe(120_000);
    expect(await rawCount(D.rate)).toBe(5); // first page landed before the limit hit
  });

  it('a DEVICE_PUSH device is never pulled: the item only refreshes health from the heartbeat', async () => {
    await h.tdb.adminDb.updateTable('devices').set({ lastHeartbeatAt: new Date(clock.getTime() - 60_000) }).where('id', '=', D.push).execute();
    const j = await itemJob(D.push);
    const res = await pullAttendance(j.ctx);
    expect(res).toMatchObject({ status: 'SUCCESS', mode: 'push', pending: true, online: true });
    expect((await device(D.push)).connectionStatus).toBe('online');
    expect(await rawCount(D.push)).toBe(0);
  });

  it('a manual full resync ignores the cursor and re-offers everything (all duplicates)', async () => {
    const before = await rawCount(D.healthy);
    const j = await itemJob(D.healthy, 'PULL_ATTENDANCE', { fullResync: true });
    const res = await pullAttendance(j.ctx);
    expect(res['inserted']).toBe(0);
    expect(res['duplicates']).toBe(before);
    expect(res['fullResync']).toBe(true);
  });

  it('resets an unparseable cursor to a 7-day rewind with history and a warning', async () => {
    await h.tdb.adminDb.updateTable('syncCursors').set({ cursor: JSON.stringify({ garbage: true }) }).where('deviceId', '=', D.healthy).execute();
    const j = await itemJob(D.healthy);
    const res = await pullAttendance(j.ctx);
    expect(res['status']).toBe('SUCCESS');
    expect(res['cursorResets']).toBe(1);
    const cursor = await h.tdb.adminDb.selectFrom('syncCursors').selectAll().where('deviceId', '=', D.healthy).executeTakeFirstOrThrow();
    expect(cursor.invalidSince).not.toBeNull();
    expect(cursor.previousCursor).toEqual({ garbage: true });
    expect(cursor.rewindReason).toMatch(/^invalid_cursor:/);
    expect(typeof (cursor.cursor as { lastSeq?: number }).lastSeq).toBe('number');
    const logs = await h.tdb.adminDb.selectFrom('deviceLogs').select(['event', 'level']).where('deviceId', '=', D.healthy).where('event', '=', 'cursor_reset').execute();
    expect(logs).toEqual([{ event: 'cursor_reset', level: 'warn' }]);
  });
});

describe('sync job roll-up', () => {
  it('mixed outcomes → PARTIAL_SUCCESS with exactly one sync.completed', async () => {
    const j = await itemJob(D.healthy, 'PULL_ATTENDANCE', {}, { devices: [D.healthy, D.auth] });
    await pullAttendance(j.ctxFor(D.healthy));
    expect((await job(j.syncJobId)).status).toBe('RUNNING');
    expect(await events('sync.completed', j.syncJobId)).toHaveLength(0);
    await pullAttendance(j.ctxFor(D.auth));
    const jb = await job(j.syncJobId);
    expect(jb).toMatchObject({ status: 'PARTIAL_SUCCESS', itemsTotal: 2, itemsSuccess: 1, itemsFailed: 1, itemsPending: 0 });
    expect(await events('sync.completed', j.syncJobId)).toHaveLength(1);
    expect(await events('sync.failed', j.syncJobId)).toHaveLength(0);
  });

  it('createSyncJob skips items whose dedupe key is already in flight and closes an item-less job immediately', async () => {
    // the offline device still has a RETRYING item → its queue job is pending under pull:<device>
    const created = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => createSyncJob(trx, h.deps.queue, { organizationId: ORG, jobType: 'PULL_ATTENDANCE', trigger: 'MANUAL', items: [{ deviceId: D.offline, operation: 'PULL_ATTENDANCE' }] }));
    expect(created.skipped).toBe(1);
    expect(created.queued).toBe(0);
    const jb = await job(created.syncJobId);
    expect(jb.status).toBe('SUCCESS');
    const its = await h.tdb.adminDb.selectFrom('syncJobItems').select(['status', 'result']).where('syncJobId', '=', created.syncJobId).execute();
    expect(its[0]!.status).toBe('SKIPPED');
    expect(await events('sync.queued', created.syncJobId)).toHaveLength(1);
    const empty = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => createSyncJob(trx, h.deps.queue, { organizationId: ORG, jobType: 'PULL_ATTENDANCE', trigger: 'MANUAL', items: [] }));
    expect((await job(empty.syncJobId)).status).toBe('SUCCESS');
  });
});

describe('ingestRawTransactions', () => {
  it('quarantines future punches, holds punches in locked periods and dedupes within the batch', async () => {
    await h.tdb.adminDb.insertInto('attendancePeriodLocks').values({ organizationId: ORG, branchId: null, periodStart: '2026-07-01', periodEnd: '2026-07-31' }).execute();
    const dev = await device(D.webhook);
    const tx = (id: string, punchedAt: string) => ({ providerTransactionId: id, deviceEmployeeId: 'E001', punchedAt, deviceLocalTime: null, verificationMethod: 'card' as const, direction: 'in' as const, rawPayload: { id } });
    const res = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => ingestRawTransactions(trx, {
      organizationId: ORG, device: dev, source: 'MANUAL', syncJobId: null, now: clock, queue: h.deps.queue,
      transactions: [tx('ok', '2026-09-05T07:00:00Z'), tx('ok', '2026-09-05T07:00:00Z'), tx('future', '2026-09-05T09:00:00Z'), tx('locked', '2026-07-10T05:00:00Z'), tx('edge', '2026-09-05T08:09:00Z')],
    }));
    expect(res).toMatchObject({ inserted: 4, duplicates: 1, quarantined: 1, held: 1 });
    expect(res.ids).toHaveLength(4);
    const rows = await h.tdb.adminDb.selectFrom('attendanceRawTransactions').select(['providerTransactionId', 'processingStatus', 'processingError']).where('deviceId', '=', D.webhook).orderBy('punchedAt').execute();
    expect(rows.map((r) => [r.providerTransactionId, r.processingStatus])).toEqual([['locked', 'held'], ['ok', 'pending'], ['edge', 'pending'], ['future', 'quarantined']]);
    // provider-id conflict on re-offer → duplicate, nothing thrown
    const again = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => ingestRawTransactions(trx, { organizationId: ORG, device: dev, source: 'MANUAL', syncJobId: null, now: clock, transactions: [tx('ok', '2026-09-05T07:00:00Z')] }));
    expect(again).toMatchObject({ inserted: 0, duplicates: 1 });
  });
});

describe('WEBHOOK_EVENT', () => {
  it('maps the vendor device to a device, ingests the normalised transactions and marks the event processed', async () => {
    const row = await h.tdb.adminDb.insertInto('providerWebhookEvents').values({
      providerKey: 'mock', organizationId: ORG, eventId: 'evt-1', eventType: 'attendance', payloadHash: 'h1', status: 'queued',
      payload: JSON.stringify({ vendorDeviceId: 'HOOK-SERIAL-1', transactions: [{ providerTransactionId: 'w1', deviceEmployeeId: 'E002', punchedAt: '2026-09-05T06:30:00Z', verificationMethod: 'face', direction: 'in', rawPayload: {} }, { providerTransactionId: 'w2', deviceEmployeeId: 'E002', punchedAt: '2026-09-05T07:30:00Z', rawPayload: {} }] }),
    }).returning('id').executeTakeFirstOrThrow();
    const ctx: JobContext = { job: { id: '900', queueName: 'sync', jobType: 'WEBHOOK_EVENT', organizationId: ORG, payload: { webhookEventId: row.id, organizationId: ORG }, priority: 6, attempts: 1, maxAttempts: 3, correlationId: null, lockedBy: 't', runAt: clock }, log: h.deps.log, deps: h.deps, signal: new AbortController().signal };
    const res = await webhookEvent(ctx);
    expect(res).toMatchObject({ status: 'processed', deviceId: D.webhook, inserted: 2, duplicates: 0 });
    const ev = await h.tdb.adminDb.selectFrom('providerWebhookEvents').select(['status', 'deviceId', 'processedAt']).where('id', '=', row.id).executeTakeFirstOrThrow();
    expect(ev).toMatchObject({ status: 'processed', deviceId: D.webhook });
    expect(ev.processedAt).not.toBeNull();
    const src = await h.tdb.adminDb.selectFrom('attendanceRawTransactions').select('source').where('deviceId', '=', D.webhook).where('providerTransactionId', '=', 'w1').executeTakeFirstOrThrow();
    expect(src.source).toBe('WEBHOOK');
    expect(await webhookEvent(ctx)).toEqual({ skipped: 'already_processed' });
    // unknown vendor device → failed with error
    const bad = await h.tdb.adminDb.insertInto('providerWebhookEvents').values({ providerKey: 'mock', organizationId: ORG, eventId: 'evt-2', payloadHash: 'h2', status: 'queued', payload: JSON.stringify({ vendorDeviceId: 'NOPE', transactions: [] }) }).returning('id').executeTakeFirstOrThrow();
    const r2 = await webhookEvent({ ...ctx, job: { ...ctx.job, payload: { webhookEventId: bad.id, organizationId: ORG } } });
    expect(r2).toMatchObject({ status: 'failed' });
    expect((await h.tdb.adminDb.selectFrom('providerWebhookEvents').select('error').where('id', '=', bad.id).executeTakeFirstOrThrow()).error).toMatch(/no active device/);
  });
});

describe('circuit breaker', () => {
  const key = { organizationId: ORG, providerKey: 'mock', accountKey: 'default' };
  it('opens after 5 consecutive vendor errors, marks devices vendor_degraded, rejects pulls until half-open, closes on success', async () => {
    expect(accountKeyFor(await device(D.healthy))).toBe('default');
    await h.tdb.adminDb.deleteFrom('providerCircuitStates').where('organizationId', '=', ORG).execute(); // earlier scenarios (rate limit) left a count behind
    const run = <T,>(fn: (trx: Parameters<typeof recordFailure>[0]) => Promise<T>) => withContext(h.deps.db, { kind: 'system', organizationId: ORG }, fn);
    for (let i = 1; i <= 4; i++) {
      const r = await run((trx) => recordFailure(trx, key, { code: 'VENDOR_ERROR', message: `boom ${i}` }, clock));
      expect(r).toMatchObject({ state: 'closed', failureCount: i, opened: false });
    }
    const fifth = await run((trx) => recordFailure(trx, key, { code: 'VENDOR_ERROR', message: 'boom 5' }, clock));
    expect(fifth).toMatchObject({ state: 'open', failureCount: 5, opened: true });
    const st = await h.tdb.adminDb.selectFrom('providerCircuitStates').selectAll().where('organizationId', '=', ORG).executeTakeFirstOrThrow();
    expect(st.state).toBe('open');
    expect(new Date(st.halfOpenAt!).getTime()).toBe(clock.getTime() + 5 * 60_000);
    expect((await device(D.healthy)).connectionStatus).toBe('vendor_degraded');
    expect((await device(D.push)).connectionStatus).toBe('online'); // other provider untouched
    expect(await run((trx) => checkCircuit(trx, key, clock))).toMatchObject({ state: 'open', allow: false });
    // a pull while open is rescheduled to the half-open time and does not touch the provider
    const j = await itemJob(D.duplicates);
    let err: unknown;
    try { await pullAttendance(j.ctx); } catch (e) { err = e; }
    expect(AppError.is(err) && err.retryable).toBe(true);
    expect((err as AppError).retryAfterMs).toBe(5 * 60_000);
    expect((await item(j.items[0]!.id)).status).toBe('RETRYING');
    expect((await h.tdb.adminDb.selectFrom('providerCircuitStates').select('failureCount').where('id', '=', st.id).executeTakeFirstOrThrow()).failureCount).toBe(5); // not counted as a vendor failure
    // half-open probe after the window
    clock = new Date(clock.getTime() + 5 * 60_000 + 1);
    const probe = await run((trx) => checkCircuit(trx, key, clock));
    expect(probe).toMatchObject({ state: 'half_open', allow: true });
    expect(await run((trx) => checkCircuit(trx, key, clock))).toMatchObject({ state: 'half_open', allow: false }); // only one probe
    // a probe failure re-opens immediately
    expect(await run((trx) => recordFailure(trx, key, { code: 'TIMEOUT', message: 'still down' }, clock))).toMatchObject({ state: 'open', opened: true });
    clock = new Date(clock.getTime() + 5 * 60_000 + 1);
    await run((trx) => checkCircuit(trx, key, clock));
    expect(await run((trx) => recordSuccess(trx, key))).toEqual({ closed: true });
    expect((await device(D.healthy)).connectionStatus).toBe('unknown');
    expect((await h.tdb.adminDb.selectFrom('providerCircuitStates').select(['state', 'failureCount']).where('id', '=', st.id).executeTakeFirstOrThrow())).toEqual({ state: 'closed', failureCount: 0 });
    // and a real pull now goes through and sets the device online again
    const j2 = await itemJob(D.duplicates);
    expect((await pullAttendance(j2.ctx))['status']).toBe('SUCCESS');
    expect((await device(D.duplicates)).connectionStatus).toBe('online');
  });
});
