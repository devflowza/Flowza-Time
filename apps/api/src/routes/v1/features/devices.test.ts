import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { auditRows, createApiHarness, queueJobs, seedDevice, seedOrg, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
beforeAll(async () => { h = await createApiHarness(`flowza_api_devices_${process.pid}`); f = await seedOrg(h.admin, 'dev'); });
afterAll(async () => { await h?.close(); });

const base = () => `/api/v1/orgs/${f.orgId}`;
const mockDevice = (code: string, branchId: string, config: Record<string, unknown> = { scenario: 'healthy', apiKey: 'valid' }) => ({ code, name: `Mock ${code}`, branchId, providerKey: 'mock', manufacturer: 'FlowZa', endpointUrl: 'https://mock.example.com/api', config });

describe('device providers and registration', () => {
  it('lists providers with secret flags and never lists deprecated ones', async () => {
    const r = await h.request('GET', `/api/v1/device-providers?orgId=${f.orgId}`, { token: f.owner });
    expect(r.status).toBe(200);
    const mock = r.body.data.find((p: { key: string }) => p.key === 'mock');
    expect(mock.secretFields).toEqual(['apiKey', 'webhookSecret']);
    expect(mock.configSchema.fields.find((x: { key: string }) => x.key === 'apiKey').secret).toBe(true);
    expect(r.body.data.some((p: { status: string }) => p.status === 'deprecated')).toBe(false);
    const models = await h.request('GET', '/api/v1/device-models?providerKey=mock', { token: f.owner });
    expect(models.body.data.map((m: { model: string }) => m.model).sort()).toEqual(['SIM-100', 'SIM-200-FACE']);
  });

  it('requires device.create and enforces branch scope', async () => {
    const denied = await h.request('POST', `${base()}/devices`, { token: f.hrUser, body: mockDevice('D-HR', f.branchA) });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN');
    // branch manager of B has no device.create at all → 403 even for own branch; an attendance admin scoped to A cannot touch B
    const bm = await h.request('POST', `${base()}/devices`, { token: f.branchManagerB, body: mockDevice('D-BM', f.branchB) });
    expect(bm.status).toBe(403);
  });

  it('creates a device, splits secrets, audits without secrets and queues TEST_CONNECTION', async () => {
    const r = await h.request('POST', `${base()}/devices`, { token: f.owner, body: mockDevice('D1', f.branchA, { scenario: 'healthy', apiKey: 'sk-live-abcd1234', employeeCount: 5 }) });
    expect(r.status).toBe(201);
    expect(r.text).not.toContain('sk-live-abcd1234');
    expect(r.body.data.device.config).toEqual({ scenario: 'healthy', employeeCount: 5, seed: 42, transactionsPerEmployeePerDay: 0, latencyMs: 2000 });
    expect(r.body.data.credentialsStored).toBe(true);
    expect(r.body.data.pushToken).toBeTypeOf('string'); // mock supports webhooks → a token is issued for the webhook URL
    expect(r.body.data.webhookUrl).toContain(`/webhooks/providers/mock/${r.body.data.device.id}/`);
    expect(r.body.data.testConnectionJobId).toBeTypeOf('string');
    const deviceId = r.body.data.device.id as string;
    const audit = await auditRows(h.admin, 'device.created');
    expect(JSON.stringify(audit[0]!.newValue)).not.toContain('sk-live');
    expect((audit[0]!.newValue as { secretFieldsProvided: string[] }).secretFieldsProvided).toEqual(['apiKey']);
    const creds = await h.admin.selectFrom('deviceCredentials').select(['deviceId', 'masked']).where('deviceId', '=', deviceId).executeTakeFirst();
    expect(creds?.masked).toEqual({ apiKey: '****1234' });
    const jobs = await queueJobs(h.admin, 'TEST_CONNECTION');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ organizationId: f.orgId, deviceId, operation: 'TEST_CONNECTION' });
    expect(jobs[0]!.payload.syncJobId).toBeTypeOf('string');
    const get = await h.request('GET', `${base()}/devices/${deviceId}`, { token: f.owner });
    expect(get.status).toBe(200);
    expect(get.body.data.maskedCredentials.apiKey).toBe('****1234');
    expect(get.text).not.toContain('sk-live');
    expect(get.body.data.hasPushToken).toBe(true);
  });

  it('rejects unknown config fields and private endpoints for cloud providers', async () => {
    const bad = await h.request('POST', `${base()}/devices`, { token: f.owner, body: mockDevice('D-BAD', f.branchA, { scenario: 'healthy', nope: 1 }) });
    expect(bad.status).toBe(400);
    const priv = await h.request('POST', `${base()}/devices`, { token: f.owner, body: { ...mockDevice('D-PRIV', f.branchA), endpointUrl: 'http://10.0.0.5/api' } });
    expect(priv.status).toBe(400);
  });

  it('enforces the plan device limit (trial = 3)', async () => {
    const r2 = await h.request('POST', `${base()}/devices`, { token: f.owner, body: mockDevice('D2', f.branchA) });
    const r3 = await h.request('POST', `${base()}/devices`, { token: f.owner, body: mockDevice('D3', f.branchB) });
    expect([r2.status, r3.status]).toEqual([201, 201]);
    const r4 = await h.request('POST', `${base()}/devices`, { token: f.owner, body: mockDevice('D4', f.branchB) });
    expect(r4.status).toBe(402);
    expect(r4.body.code).toBe('ENTITLEMENT_EXCEEDED');
    // decommissioning frees a slot
    await h.request('DELETE', `${base()}/devices/${r3.body.data.device.id}?decommission=true`, { token: f.owner });
    const again = await h.request('POST', `${base()}/devices`, { token: f.owner, body: mockDevice('D4', f.branchB) });
    expect(again.status).toBe(201);
  });

  it('invalidates stored credentials when the endpoint changes and lets device.manage re-enter them', async () => {
    const list = await h.request('GET', `${base()}/devices?search=D1`, { token: f.owner });
    const deviceId = list.body.data[0].id as string;
    expect(list.body.data[0].employeeCount).toBe(0);
    const patched = await h.request('PATCH', `${base()}/devices/${deviceId}`, { token: f.owner, body: { endpointUrl: 'https://mock2.example.com/api' } });
    expect(patched.status).toBe(200);
    expect(patched.body.data.credentialsRequired).toBe(true);
    expect(await h.admin.selectFrom('deviceCredentials').select('deviceId').where('deviceId', '=', deviceId).executeTakeFirst()).toBeUndefined();
    expect((await auditRows(h.admin, 'device.credentials_invalidated')).length).toBe(1);
    const unknown = await h.request('POST', `${base()}/devices/${deviceId}/credentials`, { token: f.owner, body: { scenario: 'x' } });
    expect(unknown.status).toBe(400);
    const hrUser = await h.request('POST', `${base()}/devices/${deviceId}/credentials`, { token: f.hrUser, body: { apiKey: 'valid' } });
    expect(hrUser.status).toBe(403);
    const ok = await h.request('POST', `${base()}/devices/${deviceId}/credentials`, { token: f.owner, body: { apiKey: 'valid' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.masked).toEqual({ apiKey: '****alid' });
    expect(ok.text).not.toContain('"valid"');
    expect((await auditRows(h.admin, 'device.credentials_changed')).length).toBe(1);
  });

  it('tests connections with the mock provider (healthy, auth_failed, stored credentials)', async () => {
    const healthy = await h.request('POST', `${base()}/devices/test-connection`, { token: f.owner, body: { providerKey: 'mock', config: { scenario: 'healthy' } } });
    expect(healthy.status).toBe(200);
    expect(healthy.body.data.ok).toBe(true);
    expect(healthy.body.data.deviceInfo.model).toBe('SIM-100');
    const auth = await h.request('POST', `${base()}/devices/test-connection`, { token: f.owner, body: { providerKey: 'mock', config: { scenario: 'auth_failed', apiKey: 'wrong' } } });
    expect(auth.body.data.ok).toBe(false);
    expect(auth.body.data.code).toBe('AUTH_FAILED');
    expect(auth.text).not.toContain('wrong');
    const list = await h.request('GET', `${base()}/devices?search=D1`, { token: f.owner });
    const deviceId = list.body.data[0].id as string;
    const stored = await h.request('POST', `${base()}/devices/test-connection`, { token: f.owner, body: { providerKey: 'mock', deviceId, config: { scenario: 'auth_failed' } } });
    expect(stored.body.data.ok).toBe(true);
    expect(stored.body.data.usedStoredCredentials).toBe(true);
    // a changed endpoint in the same request must not reuse the stored secret
    const changed = await h.request('POST', `${base()}/devices/test-connection`, { token: f.owner, body: { providerKey: 'mock', deviceId, config: { scenario: 'auth_failed', endpointUrl: 'https://other.example.com' } } });
    expect(changed.status).toBe(400); // endpointUrl is not a mock config field → validation error, never a silent reuse
    const forbidden = await h.request('POST', `${base()}/devices/test-connection`, { token: f.payrollUser, body: { providerKey: 'mock', config: { scenario: 'healthy' } } });
    expect(forbidden.status).toBe(403);
  });

  it('issues a push token once for DEVICE_PUSH providers and rotates it', async () => {
    await h.admin.insertInto('entitlements').values({ organizationId: f.orgId, key: 'devices', limitValue: 10, source: 'override', reason: 'test' }).execute(); // plan limit reached above
    const r = await h.request('POST', `${base()}/devices`, { token: f.owner, body: { code: 'ZK1', name: 'Gate', branchId: f.branchA, providerKey: 'zkteco_push', manufacturer: 'ZKTeco', config: { serialNumber: 'ZK-0001' } } });
    expect(r.status).toBe(201);
    expect(r.body.data.pushToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(r.body.data.pushUrl).toBe(`https://api.test/device-push/iclock/~${r.body.data.pushToken}`);
    expect(r.body.data.device.integrationType).toBe('DEVICE_PUSH');
    expect(r.body.data.device.serialNumber).toBe('ZK-0001');
    expect(r.body.data.testConnectionJobId).toBeNull();
    const deviceId = r.body.data.device.id as string;
    const row = await h.admin.selectFrom('devices').select('pushTokenHash').where('id', '=', deviceId).executeTakeFirstOrThrow();
    expect(row.pushTokenHash).toMatch(/^[0-9a-f]{64}$/);
    const rot = await h.request('POST', `${base()}/devices/${deviceId}/push-token/rotate`, { token: f.owner });
    expect(rot.status).toBe(200);
    expect(rot.body.data.pushToken).not.toBe(r.body.data.pushToken);
    const after = await h.admin.selectFrom('devices').select('pushTokenHash').where('id', '=', deviceId).executeTakeFirstOrThrow();
    expect(after.pushTokenHash).not.toBe(row.pushTokenHash);
    const dup = await h.request('POST', `${base()}/devices`, { token: f.owner, body: { code: 'ZK2', name: 'Gate 2', branchId: f.branchA, providerKey: 'zkteco_push', manufacturer: 'ZKTeco', config: { serialNumber: 'ZK-0001' } } });
    expect(dup.status).toBe(409);
  });

  it('runs device actions as sync jobs and manages groups', async () => {
    const list = await h.request('GET', `${base()}/devices?search=D1`, { token: f.owner });
    const deviceId = list.body.data[0].id as string;
    const act = await h.request('POST', `${base()}/devices/${deviceId}/actions/sync-attendance`, { token: f.hrUser });
    expect(act.status).toBe(202);
    expect(act.body.data).toMatchObject({ status: 'QUEUED', itemsTotal: 1 });
    const job = await h.admin.selectFrom('syncJobs').selectAll().where('id', '=', act.body.data.jobId).executeTakeFirstOrThrow();
    expect(job.jobType).toBe('PULL_ATTENDANCE');
    expect(job.itemsPending).toBe(1);
    const emp = await h.request('POST', `${base()}/devices/${deviceId}/actions/sync-employees`, { token: f.owner });
    expect(emp.status).toBe(202);
    expect(emp.body.data.itemsTotal).toBe(2); // two active employees in branch A
    const unknownAction = await h.request('POST', `${base()}/devices/${deviceId}/actions/explode`, { token: f.owner });
    expect(unknownAction.status).toBe(400);
    const g = await h.request('POST', `${base()}/device-groups`, { token: f.owner, body: { name: 'Branch B gates', branchId: f.branchB } });
    expect(g.status).toBe(201);
    const wrongBranch = await h.request('POST', `${base()}/device-groups/${g.body.data.id}/members`, { token: f.owner, body: { deviceIds: [deviceId] } });
    expect(wrongBranch.status).toBe(400);
    const bDevice = await seedDevice(h.admin, f.orgId, f.branchB, { code: 'GRP-B' });
    const added = await h.request('POST', `${base()}/device-groups/${g.body.data.id}/members`, { token: f.owner, body: { deviceIds: [bDevice] } });
    expect(added.body.data.deviceCount).toBe(1);
    const groups = await h.request('GET', `${base()}/device-groups`, { token: f.branchManagerB });
    expect(groups.body.data).toHaveLength(1);
    const logs = await h.request('GET', `${base()}/devices/${deviceId}/logs`, { token: f.owner });
    expect(logs.status).toBe(200);
    const cmds = await h.request('GET', `${base()}/devices/${deviceId}/commands`, { token: f.owner });
    expect(cmds.body.meta.total).toBe(0);
  });

  it('decommissions a device, expiring its commands and deleting credentials', async () => {
    const r = await h.request('POST', `${base()}/devices`, { token: f.owner, body: mockDevice('D-DEL', f.branchB, { scenario: 'healthy', apiKey: 'k' }) });
    expect(r.status).toBe(201);
    const id = r.body.data.device.id as string;
    await sql`insert into public.device_commands (organization_id, device_id, command_type, payload) values (${f.orgId}::uuid, ${id}::uuid, 'RESTART', '{}')`.execute(h.admin);
    const del = await h.request('DELETE', `${base()}/devices/${id}?decommission=true`, { token: f.owner });
    expect(del.status).toBe(200);
    expect(del.body.data.status).toBe('decommissioned');
    expect(await h.admin.selectFrom('deviceCredentials').select('deviceId').where('deviceId', '=', id).executeTakeFirst()).toBeUndefined();
    const cmd = await h.admin.selectFrom('deviceCommands').select('status').where('deviceId', '=', id).executeTakeFirstOrThrow();
    expect(cmd.status).toBe('expired');
    const hidden = await h.request('GET', `${base()}/devices`, { token: f.owner });
    expect(hidden.body.data.some((d: { id: string }) => d.id === id)).toBe(false);
  });
});

describe('device fleet summary', () => {
  it('counts devices by connection status and status within the caller branch scope; excludes decommissioned by default', async () => {
    const all = await h.request('GET', `${base()}/devices/summary`, { token: f.owner });
    expect(all.status).toBe(200);
    const dbAll = await h.admin.selectFrom('devices').select(({ fn }) => fn.countAll<string>().as('n')).where('organizationId', '=', f.orgId).where('status', '!=', 'decommissioned').executeTakeFirstOrThrow();
    expect(all.body.data.total).toBe(Number(dbAll.n));
    expect(Object.values(all.body.data.byConnectionStatus as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(all.body.data.total);
    expect(all.body.data.byStatus.decommissioned).toBeUndefined();
    expect(all.body.data.staleHeartbeats).toBeGreaterThanOrEqual(0);
    const withDecommissioned = await h.request('GET', `${base()}/devices/summary?includeDecommissioned=true`, { token: f.owner });
    expect(withDecommissioned.body.data.byStatus.decommissioned).toBeGreaterThanOrEqual(1); // D-DEL above
    // branch-scoped manager sees only branch B
    const scoped = await h.request('GET', `${base()}/devices/summary`, { token: f.branchManagerB });
    expect(scoped.status).toBe(200);
    const dbB = await h.admin.selectFrom('devices').select(({ fn }) => fn.countAll<string>().as('n')).where('organizationId', '=', f.orgId).where('branchId', '=', f.branchB).where('status', '!=', 'decommissioned').executeTakeFirstOrThrow();
    expect(scoped.body.data.total).toBe(Number(dbB.n));
    expect(all.body.data.total).toBeGreaterThan(scoped.body.data.total);
    // no device.view → 403
    const denied = await h.request('GET', `${base()}/devices/summary`, { token: f.employeeUser });
    expect(denied.status).toBe(403);
  });
});

describe('device restart', () => {
  it('queues a RESTART_DEVICE job for a capable device, refuses one that cannot restart, and needs device.sync', async () => {
    const capable = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'RB-1', capabilities: { attendancePull: true, employeePush: true, deviceStatus: true, remoteRestart: true } });
    const r = await h.request('POST', `${base()}/devices/${capable}/actions/restart`, { token: f.owner });
    expect(r.status).toBe(202);
    expect(r.body.data.status).toBe('QUEUED');
    const jobs = await queueJobs(h.admin, 'RESTART_DEVICE');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ organizationId: f.orgId, deviceId: capable, operation: 'RESTART_DEVICE' });
    expect(jobs[0]!.dedupeKey).toBe(`restart:${capable}`); // a second reboot while one is pending is a duplicate, not a second reboot
    const syncJob = await h.admin.selectFrom('syncJobs').select(['jobType', 'itemsTotal']).where('id', '=', r.body.data.jobId).executeTakeFirstOrThrow();
    expect(syncJob.jobType).toBe('RESTART_DEVICE');
    expect(syncJob.itemsTotal).toBe(1);
    expect((await auditRows(h.admin, 'device.action_restart'))).toHaveLength(1);

    const again = await h.request('POST', `${base()}/devices/${capable}/actions/restart`, { token: f.owner });
    expect(again.status).toBe(202);
    expect(again.body.data.itemsSkipped).toBe(1); // covered by the pending reboot
    expect(await queueJobs(h.admin, 'RESTART_DEVICE')).toHaveLength(1);

    const incapable = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'RB-2', capabilities: { attendancePull: true, remoteRestart: false } });
    const denied = await h.request('POST', `${base()}/devices/${incapable}/actions/restart`, { token: f.owner });
    expect(denied.status).toBe(422);
    expect(denied.body.code).toBe('DEVICE_UNSUPPORTED_OPERATION');

    // hr_user holds device.sync, so restart is theirs to run; a plain employee (no device permissions) is refused
    const noPermission = await h.request('POST', `${base()}/devices/${capable}/actions/restart`, { token: f.employeeUser });
    expect(noPermission.status).toBe(403);
  });
});

describe('device user (PIN) ↔ employee mapping', () => {
  const rawRow = (deviceId: string, branchId: string, pin: string, at: string, hash: string, status = 'unmatched') =>
    sql`insert into public.attendance_raw_transactions (organization_id, device_id, branch_id, provider_key, device_employee_id, punched_at, dedupe_hash, source, processing_status)
      values (${f.orgId}::uuid, ${deviceId}::uuid, ${branchId}::uuid, 'mock', ${pin}, ${at}::timestamptz, ${hash}, 'POLL', ${status})`.execute(h.admin);

  it('lists PINs with no employee behind them — from unmatched punches and from device-only enrolments', async () => {
    const device = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'MAP-1' });
    await rawRow(device, f.branchA, '7788', '2026-08-10T04:00:00Z', 'map-h1');
    await rawRow(device, f.branchA, '7788', '2026-08-10T13:00:00Z', 'map-h2');
    await rawRow(device, f.branchA, '1001', '2026-08-10T04:05:00Z', 'map-h3', 'normalized'); // resolved → not listed
    await h.admin.insertInto('deviceEmployeeStates').values({ organizationId: f.orgId, deviceId: device, branchId: f.branchA, employeeId: null, deviceUserId: '9001', syncStatus: 'OUT_OF_SYNC', desired: false, deviceRecord: JSON.stringify({ deviceUserId: '9001', name: 'Ali on device' }) }).execute();

    const r = await h.request('GET', `${base()}/devices/unmapped-users?deviceId=${device}`, { token: f.owner });
    expect(r.status).toBe(200);
    const byPin = Object.fromEntries((r.body.data as Array<Record<string, unknown>>).map((x) => [x['deviceUserId'], x]));
    expect(Object.keys(byPin).sort()).toEqual(['7788', '9001']);
    expect(byPin['7788']).toMatchObject({ unmatchedPunches: 2, enrolledOnDevice: false, deviceUserName: null, providerKey: 'mock' });
    expect(byPin['7788']!['firstPunchAt']).toBe('2026-08-10T04:00:00.000Z');
    expect(byPin['9001']).toMatchObject({ unmatchedPunches: 0, enrolledOnDevice: true, deviceUserName: 'Ali on device' });
    expect(r.body.meta.total).toBe(2);

    expect((await h.request('GET', `${base()}/devices/unmapped-users?deviceId=${device}&origin=punches`, { token: f.owner })).body.data.map((x: { deviceUserId: string }) => x.deviceUserId)).toEqual(['7788']);
    expect((await h.request('GET', `${base()}/devices/unmapped-users?deviceId=${device}&origin=enrolled`, { token: f.owner })).body.data.map((x: { deviceUserId: string }) => x.deviceUserId)).toEqual(['9001']);
    expect((await h.request('GET', `${base()}/devices/unmapped-users?deviceId=${device}&search=Ali`, { token: f.owner })).body.data.map((x: { deviceUserId: string }) => x.deviceUserId)).toEqual(['9001']);
    // a branch manager scoped to B sees nothing from a branch A device, and cannot ask for it by id
    expect((await h.request('GET', `${base()}/devices/unmapped-users`, { token: f.branchManagerB })).body.data.filter((x: { deviceId: string }) => x.deviceId === device)).toHaveLength(0);
    expect((await h.request('GET', `${base()}/devices/unmapped-users?deviceId=${device}`, { token: f.branchManagerB })).status).toBe(404);
  });

  it('links a PIN to an employee, replays the punches it already collected and audits the change', async () => {
    const device = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'MAP-2' });
    await rawRow(device, f.branchA, '4242', '2026-08-11T04:00:00Z', 'map-h4');
    await rawRow(device, f.branchA, '4242', '2026-08-11T13:00:00Z', 'map-h5');

    const r = await h.request('POST', `${base()}/devices/${device}/user-links`, { token: f.owner, body: { deviceUserId: '4242', employeeId: f.e1 } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ deviceUserId: '4242', employeeId: f.e1, scope: 'DEVICE', requeued: 2 });
    const state = await h.admin.selectFrom('deviceEmployeeStates').select(['employeeId', 'syncStatus', 'desired']).where('deviceId', '=', device).where('deviceUserId', '=', '4242').executeTakeFirstOrThrow();
    expect(state).toMatchObject({ employeeId: f.e1, syncStatus: 'OUT_OF_SYNC', desired: true });
    const statuses = await sql<{ processingStatus: string }>`select processing_status from public.attendance_raw_transactions where device_id = ${device}::uuid and device_employee_id = '4242'`.execute(h.admin);
    expect(statuses.rows.every((x) => x.processingStatus === 'pending')).toBe(true);
    expect((await queueJobs(h.admin, 'NORMALIZE_RAW')).some((j) => j.dedupeKey === `normalize:${f.orgId}`)).toBe(true);
    expect(await auditRows(h.admin, 'device.user_linked')).toHaveLength(1);
    // the PIN has left the unmapped list
    expect((await h.request('GET', `${base()}/devices/unmapped-users?deviceId=${device}`, { token: f.owner })).body.data).toHaveLength(0);

    // one employee cannot hold two PINs on the same device
    const second = await h.request('POST', `${base()}/devices/${device}/user-links`, { token: f.owner, body: { deviceUserId: '4243', employeeId: f.e1 } });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('CONFLICT');

    const unlink = await h.request('DELETE', `${base()}/devices/${device}/user-links/4242`, { token: f.owner });
    expect(unlink.status).toBe(200);
    expect((await h.admin.selectFrom('deviceEmployeeStates').select(['employeeId']).where('deviceId', '=', device).where('deviceUserId', '=', '4242').executeTakeFirstOrThrow()).employeeId).toBeNull();
    expect(await auditRows(h.admin, 'device.user_unlinked')).toHaveLength(1);
    expect((await h.request('DELETE', `${base()}/devices/${device}/user-links/4242`, { token: f.owner })).status).toBe(404);
  });

  it('links vendor-wide with PROVIDER scope and refuses a PIN another employee already owns', async () => {
    const d1 = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'MAP-3' });
    const d2 = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'MAP-4' });
    await rawRow(d1, f.branchA, '5150', '2026-08-12T04:00:00Z', 'map-h6');
    await rawRow(d2, f.branchA, '5150', '2026-08-12T13:00:00Z', 'map-h7');

    const r = await h.request('POST', `${base()}/devices/${d1}/user-links`, { token: f.owner, body: { deviceUserId: '5150', employeeId: f.e3, scope: 'PROVIDER' } });
    expect(r.status).toBe(200);
    expect(r.body.data.requeued).toBe(2); // both mock devices, not just the one addressed
    const identity = await h.admin.selectFrom('employeeProviderIdentities').select(['employeeId', 'deviceUserId']).where('organizationId', '=', f.orgId).where('providerKey', '=', 'mock').executeTakeFirstOrThrow();
    expect(identity).toMatchObject({ employeeId: f.e3, deviceUserId: '5150' });

    const taken = await h.request('POST', `${base()}/devices/${d2}/user-links`, { token: f.owner, body: { deviceUserId: '5150', employeeId: f.e1, scope: 'PROVIDER' } });
    expect(taken.status).toBe(409);
    // re-linking the same employee moves their vendor identity instead of adding a second row
    const moved = await h.request('POST', `${base()}/devices/${d2}/user-links`, { token: f.owner, body: { deviceUserId: '5151', employeeId: f.e3, scope: 'PROVIDER', requeueUnmatched: false } });
    expect(moved.status).toBe(200);
    expect(await h.admin.selectFrom('employeeProviderIdentities').select(['deviceUserId']).where('employeeId', '=', f.e3).execute()).toEqual([{ deviceUserId: '5151' }]);

    const unlink = await h.request('DELETE', `${base()}/devices/${d2}/user-links/5151?scope=PROVIDER`, { token: f.owner });
    expect(unlink.status).toBe(200);
    expect(await h.admin.selectFrom('employeeProviderIdentities').select(['id']).where('employeeId', '=', f.e3).execute()).toEqual([]);
  });

  it('enforces permissions and branch scope on linking', async () => {
    const device = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'MAP-5' });
    // employee role holds neither device.sync nor employee.update
    expect((await h.request('POST', `${base()}/devices/${device}/user-links`, { token: f.employeeUser, body: { deviceUserId: '6001', employeeId: f.e1 } })).status).toBe(403);
    // hr_user has device.sync but not attendance.view_raw → may link, but not replay raw punches
    expect((await h.request('POST', `${base()}/devices/${device}/user-links`, { token: f.hrUser, body: { deviceUserId: '6001', employeeId: f.e1 } })).status).toBe(403);
    const noReplay = await h.request('POST', `${base()}/devices/${device}/user-links`, { token: f.hrUser, body: { deviceUserId: '6001', employeeId: f.e1, requeueUnmatched: false } });
    expect(noReplay.status).toBe(200);
    expect(noReplay.body.data.requeued).toBe(0);
    // a branch manager of B cannot touch a branch A device — RLS hides it, so the device does not even exist for them
    expect((await h.request('POST', `${base()}/devices/${device}/user-links`, { token: f.branchManagerB, body: { deviceUserId: '6002', employeeId: f.e2, requeueUnmatched: false } })).status).toBe(404);
    // an employee id that is not in this organisation is not linkable
    expect((await h.request('POST', `${base()}/devices/${device}/user-links`, { token: f.owner, body: { deviceUserId: '6003', employeeId: '00000000-0000-4000-8000-00000000dead', requeueUnmatched: false } })).status).toBe(404);
  });
});
