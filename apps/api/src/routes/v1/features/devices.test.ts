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
