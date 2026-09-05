import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { defaultRegistry } from '@flowza/device-providers';
import { withContext } from '@flowza/database';
import { createHarness, type TestHarness } from '../../test/harness.js';
import type { JobContext } from '../types.js';
import { createSyncJob } from './api.js';
import { deviceHealthCheck, testConnection } from './device.js';
import { buildDeviceEmployee, deleteEmployee, hashDeviceEmployee, pullEmployees, pushEmployee, pushEmployees, reconciliation } from './employees.js';
import { pollDueDevices, scheduleHealthChecks, scheduleReconciliation, POLL_ADMISSION_CAP } from '../../tasks/sync.js';

const ORG = '0c000000-0000-0000-0000-000000000000';
const ORG_B = '0d000000-0000-0000-0000-000000000000';
const BRANCH = '0c000000-0000-0000-0000-00000000000b';
const BRANCH2 = '0c000000-0000-0000-0000-00000000000c';
const BRANCH_B = '0d000000-0000-0000-0000-00000000000b';
const DEV_A = '0c000000-0000-0000-0000-0000000000a1';
const DEV_B = '0c000000-0000-0000-0000-0000000000a2';
const DEV_ZK = '0c000000-0000-0000-0000-0000000000a3';
const DEV_OFF = '0c000000-0000-0000-0000-0000000000a4';
const DEV_AUTH = '0c000000-0000-0000-0000-0000000000a5';
const EMP = ['0c000000-0000-0000-0000-0000000000e1', '0c000000-0000-0000-0000-0000000000e2', '0c000000-0000-0000-0000-0000000000e3', '0c000000-0000-0000-0000-0000000000e4'] as const;
const clock = new Date('2026-09-05T08:00:00Z');
let h: TestHarness;
let seq = 500;

beforeAll(async () => {
  h = await createHarness(`flowza_worker_sync_emp_${process.pid}`, defaultRegistry({ clock: () => clock }), () => clock);
  const a = h.tdb.adminDb;
  await a.insertInto('organizations').values([{ id: ORG, companyCode: 'SYE', legalName: 'E', displayName: 'E' }, { id: ORG_B, companyCode: 'SYB', legalName: 'B', displayName: 'B' }]).execute();
  await a.insertInto('branches').values([{ id: BRANCH, organizationId: ORG, code: 'HQ', name: 'HQ' }, { id: BRANCH2, organizationId: ORG, code: 'B2', name: 'B2' }, { id: BRANCH_B, organizationId: ORG_B, code: 'HQ', name: 'HQ' }]).execute();
  await a.insertInto('employees').values([
    { id: EMP[0], organizationId: ORG, branchId: BRANCH, employeeNumber: 'EMP1', firstName: 'Ahmed', lastName: 'Al Balushi', displayName: 'Ahmed Al Balushi', deviceUserId: 'E001', cardNumber: '100001', joiningDate: '2025-01-01' },
    { id: EMP[1], organizationId: ORG, branchId: BRANCH, employeeNumber: 'EMP2', firstName: 'Fatima', lastName: 'Al Harthi', displayName: 'فاطمة الحارثي', deviceUserId: 'E002', joiningDate: '2025-01-01' },
    { id: EMP[2], organizationId: ORG, branchId: BRANCH, employeeNumber: 'EMP3', firstName: 'Salim', lastName: 'X', displayName: 'Salim X', deviceUserId: 'E003', joiningDate: '2025-01-01', employmentStatus: 'terminated' },
    { id: EMP[3], organizationId: ORG, branchId: BRANCH2, employeeNumber: 'EMP4', firstName: 'Noor', lastName: 'Y', displayName: 'Noor Y', deviceUserId: 'E004', joiningDate: '2025-01-01' },
  ]).execute();
  const startDate = DateTime.fromJSDate(clock, { zone: 'utc' }).minus({ days: 2 }).toISODate()!;
  const dev = (id: string, code: string, branchId: string, scenario: string, extra: Record<string, unknown> = {}) => ({ id, organizationId: ORG, branchId, code, name: code, providerKey: 'mock', manufacturer: 'FlowZa', integrationType: 'VENDOR_CLOUD_PULL' as const, config: JSON.stringify({ scenario, employeeCount: 5, startDate, ...extra }) });
  await a.insertInto('devices').values([
    dev(DEV_A, 'A', BRANCH, 'healthy', { asciiNames: true }), dev(DEV_B, 'B', BRANCH, 'healthy'), dev(DEV_OFF, 'OFF', BRANCH2, 'offline'), dev(DEV_AUTH, 'AUTH', BRANCH2, 'auth_failed'),
    { id: DEV_ZK, organizationId: ORG, branchId: BRANCH2, code: 'ZK', name: 'ZK', providerKey: 'zkteco_push', manufacturer: 'ZKTeco', integrationType: 'DEVICE_PUSH' as const, serialNumber: 'ZK1', config: '{}' },
  ]).execute();
  // org B: many devices for the scheduler admission cap
  const many = Array.from({ length: POLL_ADMISSION_CAP + 5 }, (_, i) => ({ organizationId: ORG_B, branchId: BRANCH_B, code: `M${i}`, name: `M${i}`, providerKey: 'mock', manufacturer: 'FlowZa', integrationType: 'VENDOR_CLOUD_PULL' as const, config: JSON.stringify({ scenario: 'healthy', employeeCount: 1, startDate }) }));
  await a.insertInto('devices').values(many).execute();
});
afterAll(async () => { await h?.close(); });

const ctxOf = (jobType: string, payload: Record<string, unknown>, id = String(++seq)): JobContext => ({ job: { id, queueName: 'sync', jobType, organizationId: ORG, payload, priority: 5, attempts: 1, maxAttempts: 6, correlationId: 'c', lockedBy: 't', runAt: clock }, log: h.deps.log, deps: h.deps, signal: new AbortController().signal });

/** A per-item JobContext for every item of a sync job (as the Runner would deliver them). */
async function itemContexts(syncJobId: string) {
  const items = await h.tdb.adminDb.selectFrom('syncJobItems').selectAll().where('syncJobId', '=', syncJobId).orderBy('createdAt').execute();
  return items.map((it) => ({ item: it, ctx: ctxOf(it.operation, { syncJobId, syncJobItemId: it.id, organizationId: ORG, deviceId: it.deviceId, employeeId: it.employeeId, operation: it.operation, options: {} }, String(it.queueJobId ?? ++seq)) }));
}
async function oneItem(deviceId: string, operation: string, options: Record<string, unknown> = {}, employeeId: string | null = null) {
  await sql`delete from jobs.queue where dedupe_key like ${`${operation === 'DEVICE_HEALTH_CHECK' ? 'health' : operation.toLowerCase()}:${deviceId}%`}`.execute(h.tdb.adminDb);
  const created = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => createSyncJob(trx, h.deps.queue, { organizationId: ORG, jobType: operation as never, trigger: 'MANUAL', items: [{ deviceId, employeeId, operation: operation as never, options }] }));
  const [first] = await itemContexts(created.syncJobId);
  return { syncJobId: created.syncJobId, ctx: { ...first!.ctx, job: { ...first!.ctx.job, payload: { ...first!.ctx.job.payload, options } } }, itemId: first!.item.id };
}
const states = (deviceId: string) => h.tdb.adminDb.selectFrom('deviceEmployeeStates').selectAll().where('deviceId', '=', deviceId).orderBy('deviceUserId').execute();
const job = (id: string) => h.tdb.adminDb.selectFrom('syncJobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const item = (id: string) => h.tdb.adminDb.selectFrom('syncJobItems').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const device = (id: string) => h.tdb.adminDb.selectFrom('devices').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const events = (type: string, aggregateId: string) => h.tdb.adminDb.selectFrom('domainEvents').selectAll().where('eventType', '=', type as never).where('aggregateId', '=', aggregateId).execute();

describe('device employee representation', () => {
  it('falls back to the employee number for non-ASCII names on ASCII-only devices, truncates to 24 chars and hashes without the pin', () => {
    const arabic = buildDeviceEmployee({ employeeNumber: 'EMP2', displayName: 'فاطمة الحارثي', deviceUserId: 'E002', cardNumber: null }, null, { ascii: true });
    expect(arabic.name).toBe('EMP2');
    const utf8 = buildDeviceEmployee({ employeeNumber: 'EMP2', displayName: 'فاطمة الحارثي', deviceUserId: 'E002', cardNumber: null }, null, { ascii: false });
    expect(utf8.name).toBe('فاطمة الحارثي');
    const long = buildDeviceEmployee({ employeeNumber: 'EMP9', displayName: 'A very long display name that exceeds the limit', deviceUserId: 'E009', cardNumber: '1' }, { deviceUserId: 'ZK-9', cardNumber: '99' }, { ascii: true, pin: '1234' });
    expect(long.name).toHaveLength(24);
    expect(long).toMatchObject({ deviceUserId: 'ZK-9', cardNumber: '99', pin: '1234', privilege: 'user', enabled: true });
    expect(hashDeviceEmployee(long)).toBe(hashDeviceEmployee({ ...long, pin: null }));
    expect(hashDeviceEmployee(long)).not.toBe(hashDeviceEmployee({ ...long, name: 'other' }));
  });
});

describe('PUSH_EMPLOYEES → PUSH_EMPLOYEE', () => {
  let fanoutJobId: string;

  it('fans out one item per (active employee, device of the branch) from the API payload shape and pushes them IN_SYNC', async () => {
    const res = await pushEmployees(ctxOf('PUSH_EMPLOYEES', { scope: { employeeIds: [EMP[0], EMP[1], EMP[2]] }, trigger: 'MANUAL', requestedBy: null }));
    fanoutJobId = String(res['syncJobId']);
    // EMP3 is terminated → 2 employees × 2 devices in the branch (the push device sits in another branch)
    expect(res).toMatchObject({ employees: 2, items: 4, queued: 4, skipped: 0 });
    let jb = await job(fanoutJobId);
    expect(jb).toMatchObject({ jobType: 'PUSH_EMPLOYEES', trigger: 'MANUAL', status: 'QUEUED', itemsTotal: 4, itemsPending: 4 });
    const q = await sql<{ n: string }>`select count(*) as n from jobs.queue where job_type = 'PUSH_EMPLOYEE' and dedupe_key like ${`push:%:${fanoutJobId}`}`.execute(h.tdb.adminDb);
    expect(Number(q.rows[0]!.n)).toBe(4);
    // re-running the fan-out is idempotent
    expect(await pushEmployees(ctxOf('PUSH_EMPLOYEES', { syncJobId: fanoutJobId, employeeIds: [EMP[0], EMP[1], EMP[2]] }))).toMatchObject({ items: 0 });
    for (const { ctx } of await itemContexts(fanoutJobId)) {
      const r = await pushEmployee(ctx);
      expect(r['status']).toBe('SUCCESS');
      expect(r['async']).toBe(false);
    }
    jb = await job(fanoutJobId);
    expect(jb).toMatchObject({ status: 'SUCCESS', itemsSuccess: 4, itemsPending: 0 });
    expect(await events('sync.completed', fanoutJobId)).toHaveLength(1);
    const sa = await states(DEV_A);
    expect(sa.map((s) => [s.deviceUserId, s.employeeId, s.syncStatus, s.deviceHash === s.cloudHash])).toEqual([['E001', EMP[0], 'IN_SYNC', true], ['E002', EMP[1], 'IN_SYNC', true]]);
    expect(sa[0]!.lastSuccessAt).not.toBeNull();
    expect((sa[1]!.deviceRecord as { name: string }).name).toBe('EMP2'); // ASCII-only device → employee number
    const sb = await states(DEV_B);
    expect((sb[1]!.deviceRecord as { name: string }).name).toBe('فاطمة الحارثي');
    expect((await device(DEV_A)).lastEmployeeSyncAt).not.toBeNull();
  });

  it('skips unchanged employees (hash equal) unless forced', async () => {
    const skip = await oneItem(DEV_A, 'PUSH_EMPLOYEE', {}, EMP[0]);
    expect(await pushEmployee(skip.ctx)).toMatchObject({ status: 'SUCCESS', skipped: 'in_sync', deviceUserId: 'E001' });
    const forced = await oneItem(DEV_A, 'PUSH_EMPLOYEE', { force: true }, EMP[0]);
    expect(await pushEmployee(forced.ctx)).toMatchObject({ status: 'SUCCESS', async: false, deviceUserId: 'E001' });
    // a changed card number changes the cloud hash → pushed again without force
    await h.tdb.adminDb.updateTable('employees').set({ cardNumber: '100002' }).where('id', '=', EMP[0]).execute();
    const changed = await oneItem(DEV_A, 'PUSH_EMPLOYEE', {}, EMP[0]);
    expect(await pushEmployee(changed.ctx)).toMatchObject({ status: 'SUCCESS', async: false });
    const s = (await states(DEV_A)).find((x) => x.employeeId === EMP[0])!;
    expect((s.deviceRecord as { cardNumber: string }).cardNumber).toBe('100002');
    expect(s.cloudHash).toBe(s.deviceHash);
  });

  it('refuses inactive employees (terminal FAILED) and unsupported devices (UNSUPPORTED)', async () => {
    const terminated = await oneItem(DEV_A, 'PUSH_EMPLOYEE', {}, EMP[2]);
    expect(await pushEmployee(terminated.ctx)).toMatchObject({ status: 'FAILED', errorCode: 'INVALID_CONFIG' });
    expect((await job(terminated.syncJobId)).status).toBe('FAILED');
    await h.tdb.adminDb.updateTable('devices').set({ capabilities: JSON.stringify({ employeePush: false }) }).where('id', '=', DEV_B).execute();
    const unsupported = await oneItem(DEV_B, 'PUSH_EMPLOYEE', {}, EMP[0]);
    expect(await pushEmployee(unsupported.ctx)).toMatchObject({ status: 'UNSUPPORTED', errorCode: 'UNSUPPORTED' });
    expect((await job(unsupported.syncJobId))).toMatchObject({ status: 'FAILED', itemsUnsupported: 1 });
    expect((await states(DEV_B)).find((x) => x.employeeId === EMP[0])!.syncStatus).toBe('UNSUPPORTED');
    await h.tdb.adminDb.updateTable('devices').set({ capabilities: '{}' }).where('id', '=', DEV_B).execute();
  });

  it('push-protocol devices answer asynchronously: device_commands rows + state PENDING', async () => {
    const zk = await oneItem(DEV_ZK, 'PUSH_EMPLOYEE', {}, EMP[3]);
    const r = await pushEmployee(zk.ctx);
    expect(r).toMatchObject({ status: 'SUCCESS', async: true, deviceUserId: 'E004' });
    expect(Number(r['commands'])).toBeGreaterThan(0);
    const cmds = await h.tdb.adminDb.selectFrom('deviceCommands').selectAll().where('deviceId', '=', DEV_ZK).execute();
    expect(cmds.length).toBe(Number(r['commands']));
    expect(cmds.every((c) => c.syncJobItemId === zk.itemId && c.status === 'pending')).toBe(true);
    expect((await states(DEV_ZK))[0]).toMatchObject({ employeeId: EMP[3], syncStatus: 'PENDING', deviceHash: null });
    // deleting is queued the same way; the state stays REMOVING (desired = false) until the device acknowledges
    const del = await oneItem(DEV_ZK, 'DELETE_EMPLOYEE', {}, EMP[3]);
    expect(await deleteEmployee(del.ctx)).toMatchObject({ status: 'SUCCESS', async: true });
    expect((await states(DEV_ZK))[0]).toMatchObject({ syncStatus: 'REMOVING', desired: false });
  });
});

describe('DELETE_EMPLOYEE / PULL_EMPLOYEES / RECONCILIATION', () => {
  it('removes the employee from the device, treats NOT_FOUND as already removed, and can remove device-only users', async () => {
    const del = await oneItem(DEV_A, 'DELETE_EMPLOYEE', {}, EMP[1]);
    expect(await deleteEmployee(del.ctx)).toMatchObject({ status: 'SUCCESS', async: false, deviceUserId: 'E002', alreadyRemoved: false });
    const s = (await states(DEV_A)).find((x) => x.employeeId === EMP[1])!;
    expect(s).toMatchObject({ syncStatus: 'REMOVED', desired: false, deviceHash: null });
    const again = await oneItem(DEV_A, 'DELETE_EMPLOYEE', {}, EMP[1]);
    expect(await deleteEmployee(again.ctx)).toMatchObject({ status: 'SUCCESS', alreadyRemoved: true });
    const ghost = await oneItem(DEV_A, 'DELETE_EMPLOYEE', { deviceUserId: 'E005' });
    expect(await deleteEmployee(ghost.ctx)).toMatchObject({ status: 'SUCCESS', deviceUserId: 'E005' });
    expect((await states(DEV_A)).find((x) => x.deviceUserId === 'E005')).toMatchObject({ employeeId: null, syncStatus: 'REMOVED', desired: false });
  });

  it('pulls the device user list into device_employee_states with device-only users and out-of-sync flags', async () => {
    const pull = await oneItem(DEV_B, 'PULL_EMPLOYEES');
    const r = await pullEmployees(pull.ctx);
    // device B simulates 5 users: E002 was pushed by us (in sync), E001 too but its card changed since (out of sync), E003 is a terminated
    // employee (known, not desired), E004 belongs to another branch (known, not desired), E005 is nobody (device-only)
    expect(r).toMatchObject({ status: 'SUCCESS', async: false, listed: 5, known: 4, unknown: 1, inSync: 1, outOfSync: 3 });
    const sb = await states(DEV_B);
    expect(sb.map((s) => [s.deviceUserId, s.employeeId === null, s.syncStatus, s.desired])).toEqual([
      ['E001', false, 'OUT_OF_SYNC', true], ['E002', false, 'IN_SYNC', true], ['E003', false, 'OUT_OF_SYNC', false], ['E004', false, 'OUT_OF_SYNC', false], ['E005', true, 'OUT_OF_SYNC', false],
    ]);
    expect(sb[4]!.deviceRecord).toMatchObject({ deviceUserId: 'E005' });
    expect(sb.every((s) => s.deviceHash !== null)).toBe(true);
    expect((await device(DEV_B)).lastEmployeeSyncAt).not.toBeNull();
  });

  it('reconciliation reports device-only, missing, differing and stale users and can create a repair job', async () => {
    const rec = await oneItem(DEV_B, 'RECONCILIATION', { repair: true });
    const r = await reconciliation(rec.ctx);
    expect(r).toMatchObject({ status: 'SUCCESS', deviceId: DEV_B, expected: 2, onDevice: 4, deviceOnlyCount: 1, missingOnDeviceCount: 0, differingCount: 1, staleCount: 2, unmatchedRaw: 0, duplicateTransactions: 0 });
    expect(r['deviceOnly']).toEqual([{ deviceUserId: 'E005' }]);
    expect(r['differing']).toEqual([{ employeeId: EMP[0], deviceUserId: 'E001' }]);
    expect((r['stale'] as unknown[]).length).toBe(2); // E003 (terminated) and E004 (other branch) should not be on this device
    const summary = (await job(rec.syncJobId)).summary as { devices: Record<string, { repairJobId: string; repairItems: number }> };
    expect(summary.devices[DEV_B]!.repairItems).toBe(4);
    const repair = await job(summary.devices[DEV_B]!.repairJobId);
    expect(repair).toMatchObject({ jobType: 'PUSH_EMPLOYEES', trigger: 'SYSTEM', parentJobId: rec.syncJobId, itemsTotal: 4, status: 'QUEUED' });
    const ops = await h.tdb.adminDb.selectFrom('syncJobItems').select(['operation', 'employeeId']).where('syncJobId', '=', repair.id).execute();
    expect(ops.map((o) => o.operation).sort()).toEqual(['DELETE_EMPLOYEE', 'DELETE_EMPLOYEE', 'DELETE_EMPLOYEE', 'PUSH_EMPLOYEE']);
    expect(ops.find((o) => o.operation === 'PUSH_EMPLOYEE')!.employeeId).toBe(EMP[0]);
    // device A: E002 was removed → missing on device
    const recA = await oneItem(DEV_A, 'RECONCILIATION');
    const ra = await reconciliation(recA.ctx);
    expect(ra).toMatchObject({ missingOnDeviceCount: 1, deviceOnlyCount: 0 });
    expect(ra['missingOnDevice']).toEqual([{ employeeId: EMP[1], employeeNumber: 'EMP2' }]);
  });
});

describe('DEVICE_HEALTH_CHECK / TEST_CONNECTION', () => {
  it('needs 3 consecutive failures before offline, emits device.offline once and device.online once on recovery', async () => {
    for (let i = 1; i <= 2; i++) {
      const hc = await oneItem(DEV_OFF, 'DEVICE_HEALTH_CHECK');
      const r = await deviceHealthCheck(hc.ctx);
      expect(r).toMatchObject({ status: 'SUCCESS', online: false, connectionStatus: 'degraded', consecutiveFailures: i, transition: null });
    }
    expect(await events('device.offline', DEV_OFF)).toHaveLength(0);
    const third = await oneItem(DEV_OFF, 'DEVICE_HEALTH_CHECK');
    expect(await deviceHealthCheck(third.ctx)).toMatchObject({ online: false, connectionStatus: 'offline', consecutiveFailures: 3, transition: 'offline' });
    const fourth = await oneItem(DEV_OFF, 'DEVICE_HEALTH_CHECK');
    expect(await deviceHealthCheck(fourth.ctx)).toMatchObject({ connectionStatus: 'offline', consecutiveFailures: 4, transition: null });
    const offline = await events('device.offline', DEV_OFF);
    expect(offline).toHaveLength(1);
    expect(offline[0]!.payload).toMatchObject({ deviceId: DEV_OFF, deviceName: 'OFF' });
    expect((await device(DEV_OFF))).toMatchObject({ connectionStatus: 'offline', consecutiveFailures: 4, lastErrorCode: 'DEVICE_OFFLINE' });
    // the device comes back
    await h.tdb.adminDb.updateTable('devices').set({ config: JSON.stringify({ scenario: 'healthy', employeeCount: 5 }) }).where('id', '=', DEV_OFF).execute();
    const back = await oneItem(DEV_OFF, 'DEVICE_HEALTH_CHECK');
    expect(await deviceHealthCheck(back.ctx)).toMatchObject({ online: true, connectionStatus: 'online', transition: 'online', consecutiveFailures: 0, clockSkewSeconds: 0, firmwareVersion: 'mock-1.0.0' });
    expect(await events('device.online', DEV_OFF)).toHaveLength(1);
    const d = await device(DEV_OFF);
    expect(d).toMatchObject({ connectionStatus: 'online', consecutiveFailures: 0, firmwareVersion: 'mock-1.0.0', lastClockSkewSeconds: 0 });
    expect(d.lastHeartbeatAt).not.toBeNull();
    const again = await oneItem(DEV_OFF, 'DEVICE_HEALTH_CHECK');
    expect(await deviceHealthCheck(again.ctx)).toMatchObject({ transition: null });
    expect(await events('device.online', DEV_OFF)).toHaveLength(1);
    const logs = await h.tdb.adminDb.selectFrom('deviceLogs').select(['event', 'level']).where('deviceId', '=', DEV_OFF).where('event', '=', 'health_check').execute();
    expect(logs.length).toBe(6);
    expect(logs.filter((l) => l.level === 'error')).toHaveLength(1); // the transition to offline
  });

  it('judges push devices by heartbeat age', async () => {
    await h.tdb.adminDb.updateTable('devices').set({ lastHeartbeatAt: new Date(clock.getTime() - 3 * 3_600_000), offlineThresholdMinutes: 15 }).where('id', '=', DEV_ZK).execute();
    const hc = await oneItem(DEV_ZK, 'DEVICE_HEALTH_CHECK');
    expect(await deviceHealthCheck(hc.ctx)).toMatchObject({ online: false, connectionStatus: 'degraded', consecutiveFailures: 1 });
    await h.tdb.adminDb.updateTable('devices').set({ lastHeartbeatAt: new Date(clock.getTime() - 60_000) }).where('id', '=', DEV_ZK).execute();
    const hc2 = await oneItem(DEV_ZK, 'DEVICE_HEALTH_CHECK');
    expect(await deviceHealthCheck(hc2.ctx)).toMatchObject({ online: true, connectionStatus: 'online', consecutiveFailures: 0 });
  });

  it('stores the sanitised connection test result on the item; a negative answer is a terminal FAILED item without throwing', async () => {
    const ok = await oneItem(DEV_A, 'TEST_CONNECTION');
    const r = await testConnection(ok.ctx);
    expect(r).toMatchObject({ status: 'SUCCESS', ok: true });
    const it = await item(ok.itemId);
    expect(it.status).toBe('SUCCESS');
    expect(it.result).toMatchObject({ ok: true, deviceInfo: { firmwareVersion: 'mock-1.0.0' } });
    expect(JSON.stringify(it.result)).not.toMatch(/apiKey|secret/i);
    const bad = await oneItem(DEV_AUTH, 'TEST_CONNECTION');
    const rb = await testConnection(bad.ctx);
    expect(rb).toMatchObject({ status: 'FAILED', ok: false, errorCode: 'AUTH_FAILED' });
    const ib = await item(bad.itemId);
    expect(ib).toMatchObject({ status: 'FAILED', lastErrorCode: 'AUTH_FAILED' });
    expect(ib.result).toMatchObject({ ok: false });
    expect((await job(bad.syncJobId)).status).toBe('FAILED');
  });
});

describe('scheduler ticks', () => {
  it('poll-due-devices enqueues due devices per org with dedupe keys and an admission cap, skipping in-flight devices', async () => {
    const first = await pollDueDevices(h.deps);
    expect(first.organizations).toBe(2);
    const jobsB = await h.tdb.adminDb.selectFrom('syncJobs').selectAll().where('organizationId', '=', ORG_B).where('jobType', '=', 'PULL_ATTENDANCE').execute();
    expect(jobsB).toHaveLength(1);
    expect(jobsB[0]).toMatchObject({ trigger: 'SCHEDULED', status: 'QUEUED', itemsTotal: POLL_ADMISSION_CAP, itemsPending: POLL_ADMISSION_CAP, priority: 4 });
    const jobA = await h.tdb.adminDb.selectFrom('syncJobs').selectAll().where('organizationId', '=', ORG).where('jobType', '=', 'PULL_ATTENDANCE').where('trigger', '=', 'SCHEDULED').executeTakeFirstOrThrow();
    // org A: A, B, OFF, AUTH are pull devices; the push device is never polled
    expect(jobA.itemsTotal).toBe(4);
    const q = await sql<{ n: string }>`select count(*) as n from jobs.queue where job_type = 'PULL_ATTENDANCE' and dedupe_key like 'pull:%' and status = 'pending'`.execute(h.tdb.adminDb);
    expect(Number(q.rows[0]!.n)).toBe(POLL_ADMISSION_CAP + 4);
    expect((await device(DEV_A)).nextAttendanceSyncAt).not.toBeNull();
    // second tick: the 5 devices over the cap are admitted; nothing already in flight is re-enqueued
    const second = await pollDueDevices(h.deps);
    expect(second.devices).toBe(5);
    const jobsB2 = await h.tdb.adminDb.selectFrom('syncJobs').select('itemsTotal').where('organizationId', '=', ORG_B).where('jobType', '=', 'PULL_ATTENDANCE').orderBy('createdAt').execute();
    expect(jobsB2.map((j) => j.itemsTotal)).toEqual([POLL_ADMISSION_CAP, 5]);
    const third = await pollDueDevices(h.deps);
    expect(third).toMatchObject({ devices: 0, organizations: 0 });
  });

  it('health-check enqueues devices not seen within their offline threshold, once', async () => {
    const r = await scheduleHealthChecks(h.deps);
    expect(r.organizations).toBe(2);
    const jobA = await h.tdb.adminDb.selectFrom('syncJobs').selectAll().where('organizationId', '=', ORG).where('jobType', '=', 'DEVICE_HEALTH_CHECK').where('trigger', '=', 'SCHEDULED').executeTakeFirstOrThrow();
    // only AUTH was never reached: A/B answered employee operations, OFF and ZK were seen by the health checks above
    expect(jobA.itemsTotal).toBe(1);
    expect(jobA.priority).toBe(2);
    const q = await sql<{ n: string }>`select count(*) as n from jobs.queue where job_type = 'DEVICE_HEALTH_CHECK' and dedupe_key like 'health:%' and status = 'pending' and organization_id = ${ORG_B}::uuid`.execute(h.tdb.adminDb);
    expect(Number(q.rows[0]!.n)).toBe(POLL_ADMISSION_CAP + 5);
    expect(await scheduleHealthChecks(h.deps)).toMatchObject({ devices: 0 });
  });

  it('reconciliation runs per org at the configured interval', async () => {
    // org A reconciled manually minutes ago (tests above) → only org B is due
    const r = await scheduleReconciliation(h.deps);
    expect(r).toMatchObject({ organizations: 2 });
    expect(r.jobs).toHaveLength(1);
    const jobB = await job(r.jobs[0]!);
    expect(jobB).toMatchObject({ organizationId: ORG_B, jobType: 'RECONCILIATION', trigger: 'SCHEDULED', itemsTotal: POLL_ADMISSION_CAP + 5, priority: 3 });
    expect(await scheduleReconciliation(h.deps)).toMatchObject({ jobs: [] }); // within the default 24 h
    await h.tdb.adminDb.insertInto('organizationSettings').values({ organizationId: ORG, sync: JSON.stringify({ reconciliationIntervalHours: 1 }) }).execute();
    await sql`update public.sync_jobs set created_at = now() - interval '2 hours' where organization_id = ${ORG}::uuid and job_type = 'RECONCILIATION'`.execute(h.tdb.adminDb);
    const later = await scheduleReconciliation(h.deps);
    expect(later.jobs).toHaveLength(1); // only org A (1 h interval) is due again
    const jobA = await job(later.jobs[0]!);
    expect(jobA).toMatchObject({ organizationId: ORG, itemsTotal: 5 });
  });
});
