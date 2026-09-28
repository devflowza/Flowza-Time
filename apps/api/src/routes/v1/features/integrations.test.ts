import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import { defaultRegistry } from '@flowza/device-providers';
import { createMockFinanceServer, financePunchFixtures, type MockFinanceServer } from '@flowza/device-providers/testing';
import { withContext } from '@flowza/database';
import type { FinanceIntegrationInput } from '@flowza/contracts';
import { auditRows, createApiHarness, queueJobs, seedDevice, seedOrg, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';
import type { Actor } from '../../../lib/service.js';
import * as integrations from '../../../services/features/integrations.service.js';

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

describe('Flowza Finance integration API — review fixes (Prompt 9)', () => {
  const devicesUrl = () => `/api/v1/orgs/${f.orgId}/devices`;
  const connectorId = async () => (await h.request('GET', base(), { token: f.owner })).body.data.deviceId as string;
  const connectorRow = async () => h.admin.selectFrom('devices').selectAll().where('organizationId', '=', f.orgId).where('providerKey', '=', 'flowza_finance').executeTakeFirstOrThrow();
  const storedToken = async (deviceId: string) => withContext(h.tdb.adminDb, { kind: 'system', organizationId: f.orgId }, (trx) => h.deps.credentials.get(trx, { organizationId: f.orgId, deviceId }));
  /** What a connector that has synchronised looks like: a pull cursor, a push position and ledger rows. */
  async function seedProgress(deviceId: string): Promise<void> {
    await h.admin.insertInto('syncCursors').values({ organizationId: f.orgId, deviceId, stream: 'attendance', cursor: JSON.stringify({ since: 'MjAyNi0wMy0wMVQwNDowMDowMFp8MDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAx' }) })
      .onConflict((oc) => oc.columns(['deviceId', 'stream']).doUpdateSet({ cursor: JSON.stringify({ since: 'MjAyNi0wMy0wMVQwNDowMDowMFp8MDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAx' }), rewindReason: null, previousCursor: null })).execute();
    await h.admin.updateTable('financeSyncState').set({ pushPositionAt: new Date('2026-03-01T04:00:00Z'), lastPushedEventId: '00000000-0000-4000-8000-0000000000aa', lastPushedEventAt: new Date('2026-03-01T04:00:00Z'), consecutiveFailures: 2, lastError: 'VENDOR_ERROR: old Finance' }).where('deviceId', '=', deviceId).execute();
    await h.admin.insertInto('financePushedEvents').values({ organizationId: f.orgId, deviceId, eventId: '00000000-0000-4000-8000-0000000000aa' }).onConflict((oc) => oc.doNothing()).execute();
  }

  it('D13: the generic reconcile action and generic test-connection refuse the connector with 409 CONNECTOR_MANAGED_IN_INTEGRATIONS', async () => {
    const id = await connectorId();
    server.requests.length = 0;
    const refused = [
      await h.request('POST', `${devicesUrl()}/${id}/actions/reconcile`, { token: f.owner }),
      await h.request('POST', `${devicesUrl()}/test-connection`, { token: f.owner, body: { providerKey: 'flowza_finance', deviceId: id, config: {} } }),
      await h.request('POST', `${devicesUrl()}/test-connection`, { token: f.owner, body: { providerKey: 'flowza_finance', config: { baseUrl: server.baseUrl, deviceSerial: SERIAL, token: TOKEN } } }),
      await h.request('PATCH', `${devicesUrl()}/${id}`, { token: f.owner, body: { name: 'Renamed' } }),
    ];
    for (const r of refused) {
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'CONNECTOR_MANAGED_IN_INTEGRATIONS' } });
    }
    expect(server.requests).toHaveLength(0); // the stored token never left through the generic endpoints
    expect(await h.admin.selectFrom('syncJobItems').select('id').where('deviceId', '=', id).where('operation', '=', 'RECONCILIATION').execute()).toHaveLength(0);
  });

  it('D6: a push-only connector is not pull-capable: sync-all skips it, its sync-attendance action is refused, sync-now queues only the push', async () => {
    expect((await put({ direction: 'push' })).status).toBe(200);
    let device = await connectorRow();
    expect(device.capabilities).toMatchObject({ attendancePull: false });
    expect(device.autoSyncEnabled).toBe(false);
    const all = await h.request('POST', `/api/v1/orgs/${f.orgId}/sync/attendance`, { token: f.owner, body: { all: true } });
    expect(all.status).toBe(202);
    const items = await h.admin.selectFrom('syncJobItems').select('deviceId').where('syncJobId', '=', all.body.data.jobId).execute();
    expect(items.map((i) => i.deviceId)).not.toContain(device.id);
    const action = await h.request('POST', `${devicesUrl()}/${device.id}/actions/sync-attendance`, { token: f.owner });
    expect(action.status).toBe(422);
    const direct = await h.request('POST', `/api/v1/orgs/${f.orgId}/sync/attendance`, { token: f.owner, body: { deviceIds: [device.id] } });
    expect(direct.status).toBe(400);
    const now = await h.request('POST', `${base()}/sync-now`, { token: f.owner });
    expect(now.body.data).toMatchObject({ pullJobId: null });
    expect(now.body.data.pushJobId).toBeTypeOf('string');
    expect((await put({ direction: 'both' })).status).toBe(200);
    device = await connectorRow();
    expect(device.capabilities).toMatchObject({ attendancePull: true });
    expect(device.autoSyncEnabled).toBe(true);
  });

  it('D9: re-pointing (serial or base URL) resets the pull cursor, the push position and ledger, bumps the generation, replaces the token and is audited', async () => {
    const id = await connectorId();
    await seedProgress(id);
    const before = await connectorRow();
    const r = await put({ deviceSerial: 'FLOWZA-TIME-PROD', token: 'production-token-0123456789' });
    expect(r.status).toBe(200);
    const after = await connectorRow();
    expect(after.generation).toBe(before.generation + 1);
    expect(after.config).toMatchObject({ deviceSerial: 'FLOWZA-TIME-PROD' });
    expect((after.config as { previousSerials: string[] }).previousSerials).toContain(SERIAL); // pulled punches Finance holds under the old serial are ours
    const cursor = await h.admin.selectFrom('syncCursors').selectAll().where('deviceId', '=', id).where('stream', '=', 'attendance').executeTakeFirstOrThrow();
    expect(cursor).toMatchObject({ cursor: {}, rewindReason: 'connector_repointed' });
    expect(cursor.previousCursor).toMatchObject({ since: expect.any(String) });
    const s = await h.admin.selectFrom('financeSyncState').selectAll().where('deviceId', '=', id).executeTakeFirstOrThrow();
    expect(s).toMatchObject({ pushPositionAt: null, lastPushedEventId: null, lastPushedEventAt: null, consecutiveFailures: 0, lastError: null });
    expect(await h.admin.selectFrom('financePushedEvents').select('eventId').where('deviceId', '=', id).execute()).toHaveLength(0);
    expect(await storedToken(id)).toEqual({ token: 'production-token-0123456789' });
    const audit = (await auditRows(h.admin, 'integration.finance_repointed'))[0]!;
    expect(audit.newValue).toMatchObject({ deviceSerial: 'FLOWZA-TIME-PROD', tokenReplaced: true, cursorReset: true, pushPositionReset: true, generation: before.generation + 1 });
    expect(audit.oldValue).toMatchObject({ deviceSerial: SERIAL });
    expect(JSON.stringify(audit)).not.toContain('production-token');
    // a base-URL change without a new token: the old token belongs to the old Finance and is deleted (the connector cannot be
    // enabled without one)
    const enabledNoToken = await put({ deviceSerial: 'FLOWZA-TIME-PROD', baseUrl: 'http://127.0.0.1:1/functions/v1' });
    expect(enabledNoToken.status).toBe(400);
    const disabledNoToken = await put({ enabled: false, deviceSerial: 'FLOWZA-TIME-PROD', baseUrl: 'http://127.0.0.1:1/functions/v1' });
    expect(disabledNoToken.status).toBe(200);
    expect(disabledNoToken.body.data).toMatchObject({ enabled: false, hasToken: false, tokenMasked: null });
    expect(await storedToken(id)).toBeNull();
    // back to the mock server's identity for the remaining tests
    expect((await put({ token: TOKEN })).status).toBe(200);
  });

  it('start date: defaults to 30 days back, is never in the future, and moving it earlier re-reads Finance and re-sends from it', async () => {
    const id = await connectorId();
    const current = (await h.request('GET', base(), { token: f.owner })).body.data;
    // the connector was created earlier in this file without a start date: 30 days before that day, in the organisation timezone
    const orgTz = (await h.admin.selectFrom('organizations').select('timezone').where('id', '=', f.orgId).executeTakeFirstOrThrow()).timezone;
    expect(current.syncFrom).toBe(DateTime.now().setZone(orgTz).minus({ days: 30 }).toISODate());
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const refused = await put({ syncFrom: future });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/syncFrom/);
    await seedProgress(id);
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const later = await put({ syncFrom: day(-3) });
    expect(later.status).toBe(200);
    expect(later.body.data.syncFrom).toBe(day(-3));
    expect((await h.admin.selectFrom('syncCursors').select('rewindReason').where('deviceId', '=', id).where('stream', '=', 'attendance').executeTakeFirstOrThrow()).rewindReason).toBeNull();
    const ledger = () => h.admin.selectFrom('financePushedEvents').select('eventId').where('deviceId', '=', id).execute();
    expect(await ledger()).toHaveLength(1); // a later start date only narrows what is synchronised from now on
    const generation = (await connectorRow()).generation;
    const earlier = await put({ syncFrom: day(-60) });
    expect(earlier.status).toBe(200);
    expect((await h.admin.selectFrom('syncCursors').select(['rewindReason', 'cursor']).where('deviceId', '=', id).where('stream', '=', 'attendance').executeTakeFirstOrThrow())).toMatchObject({ rewindReason: 'sync_from_changed', cursor: {} });
    expect((await h.admin.selectFrom('financeSyncState').select('pushPositionAt').where('deviceId', '=', id).executeTakeFirstOrThrow()).pushPositionAt).toBeNull();
    // an earlier start date re-sends everything from it (Finance dedupes): the ledger is emptied too, and runs in flight are superseded
    expect(await ledger()).toHaveLength(0);
    expect((await connectorRow()).generation).toBe(generation + 1);
    expect((await auditRows(h.admin, 'integration.finance_sync_from_moved'))[0]!.newValue).toMatchObject({ syncFrom: day(-60), cursorReset: true, pushPositionReset: true });
    // omitting the field keeps the stored date (a PUT of the other settings does not reset it to the default)
    expect((await put({ pollMinutes: 12 })).body.data.syncFrom).toBe(day(-60));
  });

  it('D1: the test endpoint reports a Finance it cannot reach generically — no socket error code, no response body', async () => {
    const dead = await createMockFinanceServer({ serial: SERIAL, token: TOKEN });
    const deadUrl = dead.baseUrl;
    await dead.close();
    const r = await h.request('POST', `${base()}/test`, { token: f.owner, body: { baseUrl: deadUrl, deviceSerial: SERIAL, token: TOKEN } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ ok: false, code: 'VENDOR_ERROR', message: 'Flowza Finance attendance-export is unreachable' });
    expect(r.text).not.toMatch(/ECONN|EPROTO|ERR_SSL|ENOTFOUND/);
  });

  it('Disconnect: disables the connector, deletes the token, clears cursor, state and ledger, and audits; reconnecting needs a token', async () => {
    const id = await connectorId();
    await seedProgress(id);
    expect((await h.request('DELETE', base(), { token: f.hrUser })).status).toBe(403);
    const r = await h.request('DELETE', base(), { token: f.owner });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ configured: true, enabled: false, hasToken: false, tokenMasked: null, deviceId: id });
    expect(r.text).not.toContain(TOKEN);
    const device = await connectorRow();
    expect(device).toMatchObject({ status: 'disabled', autoSyncEnabled: false, nextAttendanceSyncAt: null });
    expect(await storedToken(id)).toBeNull();
    expect((await h.admin.selectFrom('syncCursors').select(['cursor', 'rewindReason']).where('deviceId', '=', id).where('stream', '=', 'attendance').executeTakeFirstOrThrow())).toMatchObject({ cursor: {}, rewindReason: 'connector_disconnected' });
    expect(await h.admin.selectFrom('financeSyncState').selectAll().where('deviceId', '=', id).executeTakeFirstOrThrow()).toMatchObject({ pushPositionAt: null, lastPushedEventId: null, consecutiveFailures: 0, lastError: null, nextPushAt: null });
    expect(await h.admin.selectFrom('financePushedEvents').select('eventId').where('deviceId', '=', id).execute()).toHaveLength(0);
    expect(await auditRows(h.admin, 'integration.finance_disconnected')).toHaveLength(1);
    expect((await h.request('POST', `${base()}/sync-now`, { token: f.owner })).status).toBe(409);
    expect((await put({})).status).toBe(400); // enabling again needs the token
    expect((await put({ token: TOKEN })).body.data).toMatchObject({ enabled: true, hasToken: true });
  });
});

describe('Flowza Finance integration API — authorization twice (AGENTS rule 2)', () => {
  it('a principal that claims integration.manage without the live grant is refused by the database re-check before any system step or outbound call', async () => {
    // hr_user holds no integration.manage in the database; the principal below claims it (a stale or forged principal)
    const forged: Actor = {
      principal: { userId: f.hrUser, email: 'hrUser-fin@test.local', isPlatformAdmin: false, memberships: [{ membershipId: 'forged', organizationId: f.orgId, roleId: 'forged', roleKey: 'hr_user', permissions: ['integration.manage'], allBranches: true, branchIds: [], employeeId: null, teamEmployeeIds: [] }] },
      userId: f.hrUser, email: 'hrUser-fin@test.local', requestId: 'forged-request', ip: null, userAgent: null,
    };
    const connector = () => h.admin.selectFrom('devices').select(['status', 'config', 'generation']).where('organizationId', '=', f.orgId).where('providerKey', '=', 'flowza_finance').executeTakeFirstOrThrow();
    const before = await connector();
    server.requests.length = 0;
    const input: FinanceIntegrationInput = { enabled: true, baseUrl: server.baseUrl, deviceSerial: 'FLOWZA-TIME-FORGED', direction: 'both', pinKey: 'employee_number', pollMinutes: 10, token: 'forged-token-0123456789' };
    for (const call of [
      () => integrations.getFinanceIntegration(h.deps, forged, f.orgId),
      () => integrations.getFinanceStatus(h.deps, forged, f.orgId),
      () => integrations.putFinanceIntegration(h.deps, forged, f.orgId, input),
      () => integrations.testFinanceIntegration(h.deps, forged, f.orgId, {}),
      () => integrations.syncFinanceNow(h.deps, forged, f.orgId),
      () => integrations.disconnectFinanceIntegration(h.deps, forged, f.orgId),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    }
    expect(server.requests).toHaveLength(0); // the stored token never left
    expect(await connector()).toEqual(before);
    // the same principal shape backed by the live grant (the owner) passes
    const owner: Actor = { ...forged, principal: { ...forged.principal, userId: f.owner, email: 'owner-fin@test.local' }, userId: f.owner, email: 'owner-fin@test.local' };
    expect((await integrations.getFinanceIntegration(h.deps, owner, f.orgId)).configured).toBe(true);
  });
});
