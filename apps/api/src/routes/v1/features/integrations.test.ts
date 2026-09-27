import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockFinanceServer, defaultRegistry, financePunchFixtures, type MockFinanceServer } from '@flowza/device-providers';
import { withContext } from '@flowza/database';
import { auditRows, createApiHarness, queueJobs, seedDevice, seedOrg, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture; let server: MockFinanceServer;
const SERIAL = 'FLOWZA-TIME-ORG';
const TOKEN = 'push-token-abcdef0123456789';

beforeAll(async () => {
  server = await createMockFinanceServer({ serial: SERIAL, token: TOKEN, punches: financePunchFixtures(2, '2026-03-01T04:00:00.000Z') });
  // the mock Finance server is a loopback http endpoint: the connector accepts it only under the local-development flag
  h = await createApiHarness(`flowza_api_integrations_${process.pid}`, { config: { FLOWZA_ALLOW_PRIVATE_EGRESS: true } as never, providers: defaultRegistry({ flowzaFinance: { allowPrivateHosts: true } }) });
  f = await seedOrg(h.admin, 'fin');
});
afterAll(async () => { await h?.close(); await server?.close(); });
const base = () => `/api/v1/orgs/${f.orgId}/integrations/finance`;
const put = (body: Record<string, unknown>, token = f.owner) => h.request('PUT', base(), { token, body: { baseUrl: server.baseUrl, deviceSerial: SERIAL, direction: 'both', pinKey: 'employee_number', pollMinutes: 10, ...body } });

describe('Flowza Finance integration API', () => {
  it('reads an unconfigured connector and enforces integration.manage', async () => {
    const r = await h.request('GET', base(), { token: f.owner });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ configured: false, enabled: false, deviceId: null, hasToken: false, tokenMasked: null, direction: 'both', pinKey: 'employee_number' });
    expect((await h.request('GET', base(), { token: f.hrUser })).status).toBe(403);
    expect((await h.request('GET', base(), { token: f.hrAdmin })).status).toBe(403);
    expect((await h.request('GET', base(), { token: f.outsider })).status).toBe(403);
    expect((await put({ token: TOKEN }, f.hrUser)).status).toBe(403);
    expect((await h.request('GET', `${base()}/status`, { token: f.hrUser })).status).toBe(403);
    expect((await h.request('POST', `${base()}/sync-now`, { token: f.hrUser })).status).toBe(403);
  });

  it('requires the token on creation and rejects base URLs the egress rule refuses', async () => {
    const noToken = await put({});
    expect(noToken.status).toBe(400);
    expect(JSON.stringify(noToken.body)).toMatch(/token/i);
    expect((await put({ token: TOKEN, baseUrl: 'https://user:pw@example.supabase.co/functions/v1' })).status).toBe(400);
    expect((await put({ token: TOKEN, baseUrl: 'ftp://example.supabase.co/functions/v1' })).status).toBe(400);
    expect((await put({ token: TOKEN, deviceSerial: 'bad serial!' })).status).toBe(400);
    expect((await put({ token: TOKEN, pollMinutes: 2 })).status).toBe(400);
    expect((await h.request('GET', base(), { token: f.owner })).body.data.configured).toBe(false);
  });

  it('creates the connector device, stores the token through the credentials store and never returns it', async () => {
    const r = await put({ token: TOKEN });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ configured: true, enabled: true, baseUrl: server.baseUrl, deviceSerial: SERIAL, direction: 'both', pinKey: 'employee_number', pollMinutes: 10, hasToken: true, branchId: f.branchA });
    expect(r.body.data.tokenMasked).toMatch(/^\*+\w{2,4}$/);
    expect(r.text).not.toContain(TOKEN);
    const deviceId = r.body.data.deviceId as string;
    const device = await h.admin.selectFrom('devices').selectAll().where('id', '=', deviceId).executeTakeFirstOrThrow();
    expect(device).toMatchObject({ providerKey: 'flowza_finance', code: 'FLOWZA-FINANCE', serialNumber: SERIAL, endpointUrl: server.baseUrl, status: 'active', autoSyncEnabled: true, syncIntervalMinutes: 10 });
    expect(device.config).toMatchObject({ baseUrl: server.baseUrl, deviceSerial: SERIAL, direction: 'both', pinKey: 'employee_number', pollMinutes: 10 });
    expect(JSON.stringify(device.config)).not.toContain(TOKEN);
    const stored = await withContext(h.tdb.adminDb, { kind: 'system', organizationId: f.orgId }, (trx) => h.deps.credentials.get(trx, { organizationId: f.orgId, deviceId }));
    expect(stored).toEqual({ token: TOKEN });
    expect(await h.admin.selectFrom('financeSyncState').selectAll().where('deviceId', '=', deviceId).executeTakeFirst()).toBeDefined();
    const audit = await auditRows(h.admin, 'integration.finance_created');
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.newValue)).not.toContain(TOKEN);
    expect(audit[0]!.newValue).toMatchObject({ deviceSerial: SERIAL, tokenReplaced: true });
    // the connector never appears as an ordinary device in the wizard's device count (plan seats) — it is still listed for device.view holders
    const list = await h.request('GET', `/api/v1/orgs/${f.orgId}/devices`, { token: f.owner });
    expect(list.body.data.some((d: { id: string }) => d.id === deviceId)).toBe(true);
  });

  it('is managed only through Settings → Integrations: generic device mutations refuse the connector, and it takes no plan seat', async () => {
    const deviceId = (await h.request('GET', base(), { token: f.owner })).body.data.deviceId as string;
    const devices = `/api/v1/orgs/${f.orgId}/devices`;
    const refused = [
      await h.request('PATCH', `${devices}/${deviceId}`, { token: f.owner, body: { endpointUrl: 'https://evil.example/functions/v1' } }),
      await h.request('POST', `${devices}/${deviceId}/credentials`, { token: f.owner, body: { token: 'attacker-token-0123456789' } }),
      await h.request('DELETE', `${devices}/${deviceId}`, { token: f.owner }),
      await h.request('POST', devices, { token: f.owner, body: { code: 'FIN-2', name: 'Second connector', branchId: f.branchA, providerKey: 'flowza_finance', manufacturer: 'FlowZa', config: { baseUrl: server.baseUrl, deviceSerial: SERIAL, token: TOKEN } } }),
    ];
    for (const r of refused) {
      expect(r.status).toBe(409);
      expect(r.text).toMatch(/Settings → Integrations/);
    }
    const device = await h.admin.selectFrom('devices').select(['endpointUrl', 'status']).where('id', '=', deviceId).executeTakeFirstOrThrow();
    expect(device).toMatchObject({ endpointUrl: server.baseUrl, status: 'active' });
    const stored = await withContext(h.tdb.adminDb, { kind: 'system', organizationId: f.orgId }, (trx) => h.deps.credentials.get(trx, { organizationId: f.orgId, deviceId }));
    expect(stored).toEqual({ token: TOKEN });
    // trial plan: 3 devices. connector + 2 terminals is still room for a third terminal (the connector is not a seat)
    await seedDevice(h.admin, f.orgId, f.branchA, { code: 'T1' });
    await seedDevice(h.admin, f.orgId, f.branchA, { code: 'T2' });
    const third = await h.request('POST', devices, { token: f.owner, body: { code: 'T3', name: 'Terminal 3', branchId: f.branchA, providerKey: 'mock', manufacturer: 'FlowZa', endpointUrl: 'https://mock.example.com/api', config: { scenario: 'healthy', apiKey: 'valid' } } });
    expect(third.status).toBe(201);
    const fourth = await h.request('POST', devices, { token: f.owner, body: { code: 'T4', name: 'Terminal 4', branchId: f.branchA, providerKey: 'mock', manufacturer: 'FlowZa', endpointUrl: 'https://mock.example.com/api', config: { scenario: 'healthy', apiKey: 'valid' } } });
    expect(fourth.status).toBe(402);
    // reconciliation compares device users with employees: the connector has none, so it is never a target
    const recon = await h.request('POST', `/api/v1/orgs/${f.orgId}/sync/reconcile`, { token: f.owner, body: { all: true } });
    expect(recon.status).toBe(202);
    const items = await h.admin.selectFrom('syncJobItems').select('deviceId').where('syncJobId', '=', recon.body.data.jobId).execute();
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.deviceId)).not.toContain(deviceId);
  });

  it('keeps the stored token on an unchanged identity and demands it again when base URL or serial change', async () => {
    const keep = await put({ direction: 'pull', pollMinutes: 15 });
    expect(keep.status).toBe(200);
    expect(keep.body.data).toMatchObject({ hasToken: true, direction: 'pull', pollMinutes: 15 });
    const changed = await put({ deviceSerial: 'FLOWZA-TIME-OTHER' });
    expect(changed.status).toBe(400);
    expect(JSON.stringify(changed.body)).toMatch(/token again/i);
    const withToken = await put({ deviceSerial: 'FLOWZA-TIME-OTHER', token: 'another-token-0123456789' });
    expect(withToken.status).toBe(200);
    expect(withToken.body.data.deviceSerial).toBe('FLOWZA-TIME-OTHER');
    expect(await h.admin.selectFrom('devices').select('id').where('organizationId', '=', f.orgId).where('providerKey', '=', 'flowza_finance').execute()).toHaveLength(1);
    // back to the mock server's identity for the remaining tests
    expect((await put({ token: TOKEN })).status).toBe(200);
  });

  it('tests the connection against attendance-export with limit 1, reusing the stored token only for the stored identity', async () => {
    server.requests.length = 0;
    const ok = await h.request('POST', `${base()}/test`, { token: f.owner });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ ok: true, code: null, usedStoredCredentials: true, firstPunchAt: server.punches[0]!.time_utc });
    expect(typeof ok.body.data.serverTime).toBe('string');
    expect(ok.text).not.toContain(TOKEN);
    expect(server.requests.at(-1)!.body).toMatchObject({ device_serial: SERIAL, token: TOKEN, limit: 1 });
    const bad = await h.request('POST', `${base()}/test`, { token: f.owner, body: { token: 'wrong-token-0123456789' } });
    expect(bad.status).toBe(200);
    expect(bad.body.data).toMatchObject({ ok: false, code: 'AUTH_FAILED', retryable: false, usedStoredCredentials: false });
    expect(bad.text).not.toContain(TOKEN);
    // another serial without a token: the stored secret is not reused for a different identity
    const other = await h.request('POST', `${base()}/test`, { token: f.owner, body: { deviceSerial: 'FLOWZA-TIME-X' } });
    expect(other.status).toBe(400);
    expect((await h.request('POST', `${base()}/test`, { token: f.hrUser })).status).toBe(403);
  });

  it('sync-now queues a pull and a push with the worker payload contract; status reflects them', async () => {
    const r = await h.request('POST', `${base()}/sync-now`, { token: f.owner });
    expect(r.status).toBe(202);
    expect(r.body.data.pullJobId).toBeTypeOf('string');
    expect(r.body.data.pushJobId).toBeTypeOf('string');
    const deviceId = (await h.request('GET', base(), { token: f.owner })).body.data.deviceId as string;
    const pulls = (await queueJobs(h.admin, 'PULL_ATTENDANCE')).filter((j) => j.payload.deviceId === deviceId);
    const pushes = await queueJobs(h.admin, 'PUSH_ATTENDANCE');
    expect(pulls).toHaveLength(1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.dedupeKey).toBe(`finance-push:${deviceId}`);
    expect(Object.keys(pushes[0]!.payload).sort()).toEqual(['deviceId', 'employeeId', 'operation', 'options', 'organizationId', 'syncJobId', 'syncJobItemId']);
    expect(pushes[0]!.payload.syncJobId).toBe(r.body.data.pushJobId);
    const status = await h.request('GET', `${base()}/status`, { token: f.owner });
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({ configured: true, enabled: true, deviceId, unmatchedCount: 0, pendingCount: 0 });
    expect(status.body.data.state).toMatchObject({ consecutiveFailures: 0, lastPushCount: 0, lastPullCount: 0 });
    expect(status.body.data.lastJobs.map((j: { jobType: string }) => j.jobType).sort()).toEqual(['PULL_ATTENDANCE', 'PUSH_ATTENDANCE']);
    expect(status.text).not.toContain(TOKEN);
    expect(await auditRows(h.admin, 'integration.finance_sync_requested')).toHaveLength(1);
  });

  it('a disabled connector is kept but neither polled nor syncable', async () => {
    const r = await put({ enabled: false });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ configured: true, enabled: false, hasToken: true });
    const device = await h.admin.selectFrom('devices').select(['status', 'autoSyncEnabled', 'nextAttendanceSyncAt']).where('organizationId', '=', f.orgId).where('providerKey', '=', 'flowza_finance').executeTakeFirstOrThrow();
    expect(device).toMatchObject({ status: 'disabled', autoSyncEnabled: false, nextAttendanceSyncAt: null });
    expect((await h.request('POST', `${base()}/sync-now`, { token: f.owner })).status).toBe(409);
    expect((await put({ enabled: true })).body.data.enabled).toBe(true);
  });
});
