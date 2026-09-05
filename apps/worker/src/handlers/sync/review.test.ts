import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { defaultRegistry } from '@flowza/device-providers';
import { withContext, type JobQueue } from '@flowza/database';
import { sha256Hex } from '@flowza/shared';
import { createHarness, type TestHarness } from '../../test/harness.js';
import type { JobContext } from '../types.js';
import { pullAttendance } from './attendance.js';
import { deviceHealthCheck, deviceClockSkewSeconds, webhookEvent } from './device.js';
import { createSyncJob } from './api.js';
import { checkCircuit, DEFAULT_CIRCUIT_POLICY } from './circuit.js';
import { dedupeHash, ingestRawTransactions, isLocked } from './ingest.js';
import { pollDueDevices, scheduleHealthChecks } from '../../tasks/sync.js';

/**
 * Adversarial-review regressions for the sync engine: every test here failed against the pre-review implementation.
 */
const ORG = '0e000000-0000-0000-0000-000000000000';
const ORG2 = '0f000000-0000-0000-0000-000000000000';
const BRANCH = '0e000000-0000-0000-0000-00000000000b';
const BRANCH2 = '0f000000-0000-0000-0000-00000000000b';
const D = { healthy: '0e000000-0000-0000-0000-0000000000d1', auth: '0e000000-0000-0000-0000-0000000000d2', offline: '0e000000-0000-0000-0000-0000000000d3', hook: '0e000000-0000-0000-0000-0000000000d4' };
const S = { one: '0f000000-0000-0000-0000-0000000000d1', two: '0f000000-0000-0000-0000-0000000000d2' };
const clock = new Date('2026-09-05T08:00:00Z');
let h: TestHarness;
let queueSeq = 700;

beforeAll(async () => {
  h = await createHarness(`flowza_worker_sync_rev_${process.pid}`, defaultRegistry({ clock: () => clock }), () => clock);
  const a = h.tdb.adminDb;
  await a.insertInto('organizations').values([{ id: ORG, companyCode: 'REV', legalName: 'Rev', displayName: 'Rev' }, { id: ORG2, companyCode: 'RV2', legalName: 'Rev2', displayName: 'Rev2' }]).execute();
  await a.insertInto('branches').values([{ id: BRANCH, organizationId: ORG, code: 'HQ', name: 'HQ', timezone: 'Asia/Muscat' }, { id: BRANCH2, organizationId: ORG2, code: 'HQ', name: 'HQ', timezone: 'Asia/Muscat' }]).execute();
  const startDate = DateTime.fromJSDate(clock, { zone: 'utc' }).minus({ days: 2 }).toISODate()!;
  const dev = (id: string, organizationId: string, branchId: string, code: string, scenario: string, extra: Record<string, unknown> = {}) => ({
    id, organizationId, branchId, code, name: code, providerKey: 'mock', manufacturer: 'FlowZa', integrationType: 'VENDOR_CLOUD_PULL' as const, timezone: 'Asia/Muscat',
    config: JSON.stringify({ scenario, employeeCount: 3, startDate, ...extra }), syncIntervalMinutes: 5, createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  await a.insertInto('devices').values([
    dev(D.healthy, ORG, BRANCH, 'HEALTHY', 'healthy'), dev(D.auth, ORG, BRANCH, 'AUTH', 'auth_failed'), dev(D.offline, ORG, BRANCH, 'OFFLINE', 'offline'),
    { ...dev(D.hook, ORG, BRANCH, 'HOOK', 'healthy'), integrationType: 'VENDOR_WEBHOOK' as const, serialNumber: 'REV-HOOK-1' },
    dev(S.one, ORG2, BRANCH2, 'S1', 'offline'), { ...dev(S.two, ORG2, BRANCH2, 'S2', 'offline'), createdAt: new Date('2026-02-01T00:00:00Z') },
  ]).execute();
});
afterAll(async () => { await h?.close(); });

async function itemJob(organizationId: string, deviceId: string, operation = 'PULL_ATTENDANCE', options: Record<string, unknown> = {}) {
  await sql`delete from jobs.queue where dedupe_key = ${`${operation === 'DEVICE_HEALTH_CHECK' ? 'health' : 'pull'}:${deviceId}`}`.execute(h.tdb.adminDb);
  const created = await withContext(h.deps.db, { kind: 'system', organizationId }, (trx) => createSyncJob(trx, h.deps.queue, { organizationId, jobType: operation as never, trigger: 'MANUAL', items: [{ deviceId, operation: operation as never, options }] }));
  const item = await h.tdb.adminDb.selectFrom('syncJobItems').selectAll().where('syncJobId', '=', created.syncJobId).executeTakeFirstOrThrow();
  const ctx: JobContext = {
    job: { id: String(item.queueJobId ?? ++queueSeq), queueName: 'sync', jobType: operation, organizationId, payload: { syncJobId: created.syncJobId, syncJobItemId: item.id, organizationId, deviceId, employeeId: null, operation, options }, priority: 5, attempts: 1, maxAttempts: 6, correlationId: 'c', lockedBy: 'test', runAt: clock },
    log: h.deps.log, deps: h.deps, signal: new AbortController().signal,
  };
  return { syncJobId: created.syncJobId, itemId: item.id, ctx };
}
const job = (id: string) => h.tdb.adminDb.selectFrom('syncJobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const item = (id: string) => h.tdb.adminDb.selectFrom('syncJobItems').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const device = (id: string) => h.tdb.adminDb.selectFrom('devices').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const events = (type: string, aggregateId: string) => h.tdb.adminDb.selectFrom('domainEvents').selectAll().where('eventType', '=', type as never).where('aggregateId', '=', aggregateId).execute();
const circuit = () => h.tdb.adminDb.selectFrom('providerCircuitStates').selectAll().where('organizationId', '=', ORG).where('providerKey', '=', 'mock').where('accountKey', '=', 'default').executeTakeFirst();
/** A JobQueue whose enqueue fails like a dropped connection (everything else delegates). */
function failingQueue(): JobQueue {
  const q = h.deps.queue;
  return { enqueue: async () => { throw new Error('connection reset by peer'); }, dequeue: (...a) => q.dequeue(...a), complete: (...a) => q.complete(...a), fail: (...a) => q.fail(...a), cancel: (...a) => q.cancel(...a), reapStale: (...a) => q.reapStale(...a), stats: () => q.stats() };
}

describe('pure helpers', () => {
  it('dedupe hash uses the canonical UTC punched_at (no zero milliseconds) — identical to the API device-push ingest', () => {
    const viaOffset = dedupeHash(D.healthy, 1, { deviceEmployeeId: 'E1', punchedAt: '2026-09-05T07:00:00+04:00', verificationMethod: 'card', direction: 'in' });
    expect(viaOffset).toBe(sha256Hex(`${D.healthy}|1|E1|2026-09-05T03:00:00Z|card|in`));
    expect(dedupeHash(D.healthy, 1, { deviceEmployeeId: 'E1', punchedAt: '2026-09-05T03:00:00.000Z', verificationMethod: 'card', direction: 'in' })).toBe(viaOffset);
    expect(dedupeHash(D.healthy, 1, { deviceEmployeeId: 'E1', punchedAt: '2026-09-05T03:00:00.250Z' })).toBe(sha256Hex(`${D.healthy}|1|E1|2026-09-05T03:00:00.250Z|unknown|unknown`));
  });

  it('device clock skew interprets offset-less device time in the device zone (never the server zone)', () => {
    const now = new Date('2026-09-05T08:00:00Z');
    expect(deviceClockSkewSeconds('2026-09-05T12:00:00', 'Asia/Muscat', now)).toBe(0);
    expect(deviceClockSkewSeconds('2026-09-05 12:00:30', 'Asia/Muscat', now)).toBe(30);
    expect(deviceClockSkewSeconds('2026-09-05T12:00:00Z', 'Asia/Muscat', now)).toBe(4 * 3600);
    expect(deviceClockSkewSeconds('2026-09-05T11:59:00+04:00', 'Asia/Muscat', now)).toBe(-60);
    expect(deviceClockSkewSeconds('garbage', 'Asia/Muscat', now)).toBeNull();
    expect(deviceClockSkewSeconds(undefined, 'Asia/Muscat', now)).toBeNull();
  });

  it('locked-period dates are read back in the zone node-pg materialised them in (no off-by-one east of Greenwich)', () => {
    const previous = process.env['TZ'];
    process.env['TZ'] = 'Asia/Muscat';
    try {
      // node-pg turns a SQL `date` into local midnight: new Date(y, m, d)
      const locks = [{ branchId: null, periodStart: new Date(2026, 6, 1), periodEnd: new Date(2026, 6, 31) }];
      expect(isLocked(locks, '2026-07-01')).toBe(true);
      expect(isLocked(locks, '2026-07-31')).toBe(true);
      expect(isLocked(locks, '2026-06-30')).toBe(false);
      expect(isLocked(locks, '2026-08-01')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env['TZ']; else process.env['TZ'] = previous;
    }
  });
});

describe('runItem ↔ queue attempt accounting', () => {
  it('finishes the item terminally when the queue is about to dead-letter, even if the item itself has attempts left', async () => {
    const j = await itemJob(ORG, D.offline);
    // the queue already delivered this job 3 times (earlier deliveries failed before the item started); item.attempts is still 0
    const ctx: JobContext = { ...j.ctx, job: { ...j.ctx.job, attempts: 3, maxAttempts: 3 } };
    const res = await pullAttendance(ctx); // must NOT throw: a throw would dead-letter the queue job with the item stuck OFFLINE/RETRYING
    expect(res).toMatchObject({ status: 'OFFLINE', errorCode: 'DEVICE_OFFLINE' });
    const it = await item(j.itemId);
    expect(it.status).toBe('OFFLINE');
    expect(it.finishedAt).not.toBeNull();
    expect(it.nextAttemptAt).toBeNull();
    const jb = await job(j.syncJobId);
    expect(jb).toMatchObject({ status: 'FAILED', itemsPending: 0, itemsOffline: 1, errorCode: 'DEVICE_OFFLINE' });
    expect(await events('sync.failed', j.syncJobId)).toHaveLength(1);
  });
});

describe('circuit breaker recovery', () => {
  const key = { organizationId: ORG, providerKey: 'mock', accountKey: 'default' };
  const run = <T,>(fn: (trx: Parameters<typeof checkCircuit>[0]) => Promise<T>) => withContext(h.deps.db, { kind: 'system', organizationId: ORG }, fn);
  const setCircuit = (state: 'open' | 'half_open' | 'closed', halfOpenAt: Date | null) => h.tdb.adminDb.insertInto('providerCircuitStates')
    .values({ organizationId: ORG, providerKey: 'mock', accountKey: 'default', state, failureCount: 5, openedAt: clock, halfOpenAt })
    .onConflict((oc) => oc.columns(['organizationId', 'providerKey', 'accountKey']).doUpdateSet({ state, failureCount: 5, halfOpenAt })).execute();

  it('hands out a new probe when the previous half-open probe never reported back (worker died)', async () => {
    await setCircuit('half_open', new Date(clock.getTime() - DEFAULT_CIRCUIT_POLICY.openMs - 1));
    const probe = await run((trx) => checkCircuit(trx, key, clock));
    expect(probe).toMatchObject({ state: 'half_open', allow: true });
    expect(await run((trx) => checkCircuit(trx, key, clock))).toMatchObject({ state: 'half_open', allow: false }); // fresh probe now in flight
    expect((await circuit())!.halfOpenAt!.getTime()).toBe(clock.getTime());
  });

  it('a probe answered by the vendor with a non-vendor error (AUTH_FAILED) closes the circuit instead of pinning it half-open', async () => {
    await setCircuit('open', new Date(clock.getTime() - 1));
    const j = await itemJob(ORG, D.auth);
    const res = await pullAttendance(j.ctx); // this item becomes the probe; the vendor answers AUTH_FAILED (terminal for the item)
    expect(res).toMatchObject({ status: 'FAILED', errorCode: 'AUTH_FAILED' });
    const c = await circuit();
    expect(c).toMatchObject({ state: 'closed', failureCount: 0 });
    // and the next caller talks to the vendor normally
    expect(await run((trx) => checkCircuit(trx, key, clock))).toMatchObject({ state: 'closed', allow: true });
  });

  it('a health check that reaches the vendor but finds the device offline also resolves the probe', async () => {
    await setCircuit('open', new Date(clock.getTime() - 1));
    const j = await itemJob(ORG, D.offline, 'DEVICE_HEALTH_CHECK');
    expect(await deviceHealthCheck(j.ctx)).toMatchObject({ status: 'SUCCESS', online: false });
    expect(await circuit()).toMatchObject({ state: 'closed', failureCount: 0 });
  });
});

describe('failure bookkeeping', () => {
  it('an internal failure (our DB) is not blamed on the device and the item retries', async () => {
    const j = await itemJob(ORG, D.healthy, 'PULL_ATTENDANCE', { pageSize: 5 });
    const before = await device(D.healthy);
    expect(before.lastErrorCode).toBeNull();
    const ctx: JobContext = { ...j.ctx, deps: { ...h.deps, queue: failingQueue() } };
    await expect(pullAttendance(ctx)).rejects.toMatchObject({ retryable: true });
    const it = await item(j.itemId);
    expect(it).toMatchObject({ status: 'RETRYING', lastErrorCode: 'INTERNAL' });
    const after = await device(D.healthy);
    expect(after.lastErrorCode).toBeNull();
    expect(after.connectionStatus).toBe(before.connectionStatus);
    const logs = await h.tdb.adminDb.selectFrom('deviceLogs').select('event').where('deviceId', '=', D.healthy).where('event', '=', 'sync_failed').execute();
    expect(logs).toHaveLength(0);
    // the page was rolled back with the failed enqueue: nothing half-ingested, no cursor advanced
    const raw = await h.tdb.adminDb.selectFrom('attendanceRawTransactions').select((eb) => eb.fn.countAll<string>().as('n')).where('deviceId', '=', D.healthy).executeTakeFirstOrThrow();
    expect(Number(raw.n)).toBe(0);
    expect(await h.tdb.adminDb.selectFrom('syncCursors').selectAll().where('deviceId', '=', D.healthy).executeTakeFirst()).toBeUndefined();
  });

  it('a device declared offline that answers a poll emits device.online once (same as a health check would)', async () => {
    await h.tdb.adminDb.updateTable('devices').set({ connectionStatus: 'offline', consecutiveFailures: 3 }).where('id', '=', D.hook).execute();
    const dev = await device(D.hook);
    const tx = (id: string, punchedAt: string) => ({ providerTransactionId: id, deviceEmployeeId: 'E001', punchedAt, deviceLocalTime: null, verificationMethod: 'card' as const, direction: 'in' as const, rawPayload: {} });
    const res = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => ingestRawTransactions(trx, { organizationId: ORG, device: dev, source: 'POLL', syncJobId: null, now: clock, queue: h.deps.queue, transactions: [tx('t1', '2026-09-05T07:00:00Z')] }));
    expect(res.inserted).toBe(1);
    expect(await device(D.hook)).toMatchObject({ connectionStatus: 'online', consecutiveFailures: 0 });
    const online = await events('device.online', D.hook);
    expect(online).toHaveLength(1);
    expect(online[0]!.payload).toMatchObject({ deviceId: D.hook, deviceName: 'HOOK', branchId: BRANCH });
    // already online → no second event
    await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => ingestRawTransactions(trx, { organizationId: ORG, device: { ...dev, connectionStatus: 'online' }, source: 'POLL', syncJobId: null, now: clock, transactions: [tx('t2', '2026-09-05T07:05:00Z')] }));
    expect(await events('device.online', D.hook)).toHaveLength(1);
  });
});

describe('WEBHOOK_EVENT retry semantics', () => {
  it('a transient failure leaves the event queued and rethrows (queue retries); only the last delivery gives up', async () => {
    const row = await h.tdb.adminDb.insertInto('providerWebhookEvents').values({
      providerKey: 'mock', organizationId: ORG, eventId: 'rev-evt-1', eventType: 'attendance', payloadHash: 'rev-h1', status: 'queued',
      payload: JSON.stringify({ vendorDeviceId: 'REV-HOOK-1', transactions: [{ providerTransactionId: 'w1', deviceEmployeeId: 'E002', punchedAt: '2026-09-05T06:30:00Z', rawPayload: {} }] }),
    }).returning('id').executeTakeFirstOrThrow();
    const base: JobContext = { job: { id: '950', queueName: 'sync', jobType: 'WEBHOOK_EVENT', organizationId: ORG, payload: { webhookEventId: row.id, organizationId: ORG }, priority: 6, attempts: 1, maxAttempts: 3, correlationId: null, lockedBy: 't', runAt: clock }, log: h.deps.log, deps: { ...h.deps, queue: failingQueue() }, signal: new AbortController().signal };
    await expect(webhookEvent(base)).rejects.toThrow(/connection reset/);
    expect((await h.tdb.adminDb.selectFrom('providerWebhookEvents').select(['status', 'error']).where('id', '=', row.id).executeTakeFirstOrThrow())).toMatchObject({ status: 'queued', error: null });
    // last delivery: give up and record why
    const last = await webhookEvent({ ...base, job: { ...base.job, attempts: 3 } });
    expect(last).toMatchObject({ status: 'failed' });
    expect((await h.tdb.adminDb.selectFrom('providerWebhookEvents').select(['status', 'error']).where('id', '=', row.id).executeTakeFirstOrThrow()).error).toMatch(/gave up after 3 attempts/);
    // an intact queue processes the same event normally when it is queued again
    await h.tdb.adminDb.updateTable('providerWebhookEvents').set({ status: 'queued', error: null }).where('id', '=', row.id).execute();
    expect(await webhookEvent({ ...base, deps: h.deps })).toMatchObject({ status: 'processed', inserted: 1 });
  });
});

describe('scheduler fairness', () => {
  it('health-check admission rotates: a device whose check failed goes to the back of the queue', async () => {
    const first = await scheduleHealthChecks(h.deps, { cap: 1 });
    const admitted = async () => (await h.tdb.adminDb.selectFrom('syncJobItems').select('deviceId').where('organizationId', '=', ORG2).where('operation', '=', 'DEVICE_HEALTH_CHECK').orderBy('createdAt').execute()).map((r) => r.deviceId);
    expect(first.devices).toBeGreaterThan(0);
    expect(await admitted()).toEqual([S.one]); // oldest device first
    // run the admitted check (device is unreachable → observation recorded, item SUCCESS)
    const items = await h.tdb.adminDb.selectFrom('syncJobItems').selectAll().where('organizationId', '=', ORG2).where('deviceId', '=', S.one).execute();
    const it = items[0]!;
    const ctx: JobContext = { job: { id: String(it.queueJobId), queueName: 'sync', jobType: 'DEVICE_HEALTH_CHECK', organizationId: ORG2, payload: { syncJobId: it.syncJobId, syncJobItemId: it.id, organizationId: ORG2, deviceId: S.one, employeeId: null, operation: 'DEVICE_HEALTH_CHECK', options: {} }, priority: 2, attempts: 1, maxAttempts: 3, correlationId: 'c', lockedBy: 't', runAt: clock }, log: h.deps.log, deps: h.deps, signal: new AbortController().signal };
    expect(await deviceHealthCheck(ctx)).toMatchObject({ status: 'SUCCESS', online: false });
    await sql`delete from jobs.queue where id = ${String(it.queueJobId)}::bigint`.execute(h.tdb.adminDb); // as the runner's complete() would
    await scheduleHealthChecks(h.deps, { cap: 1 });
    expect(await admitted()).toEqual([S.one, S.two]); // the never-checked device is admitted before re-checking the failed one
  });

  it('poll-due-devices leaves devices declared offline to the health check until their offline threshold has passed', async () => {
    await h.tdb.adminDb.updateTable('devices').set({ connectionStatus: 'offline', consecutiveFailures: 3, lastErrorAt: clock, nextAttendanceSyncAt: null }).where('id', '=', S.two).execute();
    await pollDueDevices(h.deps);
    const polled = async () => (await h.tdb.adminDb.selectFrom('syncJobItems').select('id').where('deviceId', '=', S.two).where('operation', '=', 'PULL_ATTENDANCE').execute()).length;
    expect(await polled()).toBe(0);
    await h.tdb.adminDb.updateTable('devices').set({ lastErrorAt: new Date(clock.getTime() - 16 * 60_000) }).where('id', '=', S.two).execute();
    await pollDueDevices(h.deps);
    expect(await polled()).toBe(1);
    expect((await device(S.two)).nextAttendanceSyncAt!.getTime()).toBe(clock.getTime() + 5 * 60_000);
  });
});
