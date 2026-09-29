import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rawTransactionSchema } from '@flowza/contracts';
import { describeProviderConformance } from '../../conformance.js';
import { createTestProviderContext } from '../../testing.js';
import { ProviderError, type ProviderContext, type SyncCursor } from '../../types.js';
import { SUPREMA_BIOSTAR2_DEFINITION } from './definition.js';
import { createMockBioStarServer, mockBioStarUser, type MockBioStarEvent, type MockBioStarServer } from './mock-server.js';
import { BIOSTAR_OPERATOR, bioStarName, classifyBioStarEvent, mapBioStarTnaKey, parseBioStarCursor, SupremaBioStar2Provider } from './provider.js';

const NOW = new Date('2026-03-10T12:00:00.000Z');
const clock = (): Date => NOW;
const DEVICE = '541531029';

/** 8 events in the last 30 days: 5 authentication successes, a door event, a failure and a success without a user. */
function fixtures(): MockBioStarEvent[] {
  return [
    { id: 1001, datetime: '2026-03-01T04:00:00.00Z', code: 0x1303, userId: '101', tnaKey: 1 },             // identify face, key 1 → in
    { id: 1002, datetime: '2026-03-01T04:01:00.00Z', code: 0x1400, userId: '102' },                       // identify FAIL → dropped
    { id: 1003, datetime: '2026-03-01T05:00:00.00Z', code: 0x1008, userId: '102', tnaKey: 2 },             // verify card+finger → out
    { id: 1004, datetime: '2026-03-01T06:00:00.00Z', code: 0x5000 },                                     // door event, no user
    { id: 1005, datetime: '2026-03-01T13:30:15.00Z', code: 0x1301, userId: '101', tnaKey: 2 },             // identify fingerprint
    { id: 1006, datetime: '2026-03-02T03:59:00.00Z', code: 0x1306, userId: '103', deviceId: '541531030' }, // other terminal
    { id: 1007, datetime: '2026-03-02T04:00:00.00Z', code: 0x1300 },                                     // success but no user
    { id: 1008, datetime: '2026-03-02T04:10:00Z', code: 0x1006, userId: '104', tnaKey: 0 },              // verify card only
  ];
}

let server: MockBioStarServer;

function ctxFor(overrides: Partial<ProviderContext> & { acquireCalls?: { count: number } } = {}): ProviderContext & { acquireCalls: { count: number } } {
  return createTestProviderContext({
    config: { baseUrl: server.baseUrl, loginId: server.loginId },
    credentials: { password: server.password },
    ...overrides,
  });
}
const provider = (): SupremaBioStar2Provider => new SupremaBioStar2Provider({ allowPrivateHosts: true, clock });

beforeAll(async () => {
  server = await createMockBioStarServer({ events: fixtures(), users: [mockBioStarUser('101', 'Aisha Al Balushi'), mockBioStarUser('102', 'Omar Al Harthy'), mockBioStarUser('103', 'Sara', { disabled: 'true' })] });
  server.devices.push({ id: '541531030', name: 'FaceStation F2 Gate', status: '0', device_type_id: { id: '20', name: 'FaceStation F2' } });
});
afterAll(async () => { await server.close(); });
beforeEach(() => { server.requests.length = 0; server.events = fixtures(); server.ignoreIdCondition = false; });

describe('suprema_biostar2 definition + mapping', () => {
  it('declares an honest beta definition', () => {
    const d = SUPREMA_BIOSTAR2_DEFINITION;
    expect(d.key).toBe('suprema_biostar2');
    expect(d.vendor).toBe('Suprema');
    expect(d.integrationType).toBe('ON_PREM_SERVER_API');
    expect(d.status).toBe('beta');
    expect(d.verificationStatus).toBe('REPORTED');
    expect(d.secretFields).toEqual(['password']);
    expect(d.capabilities).toMatchObject({ attendancePull: true, employeePull: true, employeePush: true, employeeDelete: true, deviceStatus: true, remoteRestart: false, webhooks: false, devicePush: false, biometricTemplatePush: false, card: false });
    expect(d.configSchema.fields.map((f) => f.key)).toEqual(['baseUrl', 'loginId', 'password', 'deviceId']);
  });

  it('keeps only authentication successes and maps sub-codes to the presence factor', () => {
    expect(BIOSTAR_OPERATOR).toEqual({ EQUAL: 0, NOT_EQUAL: 1, CONTAINS: 2, BETWEEN: 3, LIKE: 4, GREATER: 5, LESS: 6 });
    expect(classifyBioStarEvent(4865)?.method).toBe('fingerprint'); // 0x1301 identify finger
    expect(classifyBioStarEvent(4867)?.method).toBe('face');        // 0x1303 identify face
    expect(classifyBioStarEvent(4097)?.method).toBe('pin');         // 0x1001 verify ID + PIN
    expect(classifyBioStarEvent(4102)?.method).toBe('card');        // 0x1006 verify card
    expect(classifyBioStarEvent(4106)?.method).toBe('face');        // 0x100A card + face
    expect(classifyBioStarEvent(0x1016)?.method).toBe('mobile');
    expect(classifyBioStarEvent(4096)?.method).toBe('unknown');
    expect(classifyBioStarEvent(0x1204)).toMatchObject({ duress: true, method: 'face' });
    expect(classifyBioStarEvent(0x1600)).toMatchObject({ mode: 'dual', method: 'unknown' });
    for (const failure of [0x1100, 0x1400, 0x1700, 0x1800, 0x1900, 0x1b00, 0x5000, -1, 70000]) expect(classifyBioStarEvent(failure)).toBeNull();
    expect(mapBioStarTnaKey('1')).toBe('in');
    expect(mapBioStarTnaKey(2)).toBe('out');
    expect(mapBioStarTnaKey('0')).toBe('unknown');
    expect(mapBioStarTnaKey('5')).toBe('unknown');
    expect(bioStarName("Mary O'Neil")).toEqual({ value: 'Mary O’Neil', adjusted: true });
    expect(bioStarName('x'.repeat(60)).value).toHaveLength(48);
  });

  it('validates cursors it did not issue as INVALID_CONFIG / invalid_cursor', () => {
    expect(parseBioStarCursor(null)).toBeNull();
    expect(parseBioStarCursor({})).toBeNull();
    expect(parseBioStarCursor({ since: '2026-01-01T00:00:00.000Z', lastId: '12' })).toEqual({ since: '2026-01-01T00:00:00.000Z', lastId: '12' });
    for (const bad of [{ bogus: 'cursor' }, { since: 'yesterday', lastId: null }, { since: '2026-01-01T00:00:00Z', lastId: '-1' }, { since: '2026-01-01T00:00:00Z', lastId: 12 }] as SyncCursor[]) {
      try { parseBioStarCursor(bad); expect.unreachable(); } catch (e) {
        expect(ProviderError.is(e) && e.code === 'INVALID_CONFIG' && e.details?.['reason'] === 'invalid_cursor').toBe(true);
      }
    }
  });
});

describe('suprema_biostar2 against the mock server', () => {
  it('testConnection logs in and reads the device list', async () => {
    const ctx = ctxFor();
    const r = await provider().testConnection(ctx);
    expect(r.ok).toBe(true);
    expect(r.details).toMatchObject({ deviceCount: 2, connected: 1, disconnected: 1 });
    const login = server.requests.find((q) => q.path === '/api/login');
    expect(login?.body).toEqual({ User: { login_id: server.loginId, password: server.password } });
    const devices = server.requests.find((q) => q.path === '/api/devices');
    expect(typeof devices?.headers['bs-session-id']).toBe('string');
    expect(ctx.acquireCalls.count).toBe(server.requests.length);
  });

  it('getDeviceInfo / getDeviceStatus for the whole server and for one terminal', async () => {
    const p = provider();
    const server_ = await p.getDeviceInfo(ctxFor());
    expect(server_).toMatchObject({ model: 'BioStar 2 server', extra: { deviceCount: 2 } });
    const one = await p.getDeviceInfo(ctxFor({ config: { baseUrl: server.baseUrl, loginId: server.loginId, deviceId: DEVICE } }));
    expect(one).toMatchObject({ serialNumber: DEVICE, model: 'BioStation 2', firmwareVersion: '1.9.0' });
    expect(await p.getDeviceStatus(ctxFor())).toMatchObject({ online: true, lastSeenAt: NOW.toISOString() });
    expect(await p.getDeviceStatus(ctxFor({ config: { baseUrl: server.baseUrl, loginId: server.loginId, deviceId: DEVICE } }))).toMatchObject({ online: true, details: { biostarStatus: '1' } });
    const off = await p.getDeviceStatus(ctxFor({ config: { baseUrl: server.baseUrl, loginId: server.loginId, deviceId: '541531030' } }));
    expect(off.online).toBe(false);
    await expect(p.getDeviceStatus(ctxFor({ config: { baseUrl: server.baseUrl, loginId: server.loginId, deviceId: '999' } }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const probe = await p.testConnection(ctxFor({ config: { baseUrl: server.baseUrl, loginId: server.loginId, deviceId: '999' } }));
    expect(probe).toMatchObject({ ok: false, details: { code: 'NOT_FOUND' } });
  });

  it('pulls pages by event id with hasMore, UTC times, local wall clock and only authenticated users', async () => {
    const p = provider();
    const ctx = ctxFor();
    const first = await p.pullAttendance(ctx, null, { pageSize: 3 });
    const search = server.requests.find((q) => q.path === '/api/events/search');
    expect(search?.body).toEqual({ Query: { limit: 3, conditions: [{ column: 'datetime', operator: 3, values: ['2026-02-08T00:00:00.000Z', '2037-12-31T23:59:59.000Z'] }], orders: [{ column: 'id', descending: false }] } });
    expect(first.transactions.map((t) => t.providerTransactionId)).toEqual(['1001', '1003']); // 1002 is a failure
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toEqual({ since: '2026-02-08T00:00:00.000Z', lastId: '1003' });
    const t0 = first.transactions[0]!;
    expect(rawTransactionSchema.safeParse(t0).success).toBe(true);
    expect(t0).toMatchObject({ deviceEmployeeId: '101', punchedAt: '2026-03-01T04:00:00Z', deviceLocalTime: '2026-03-01 08:00:00', verificationMethod: 'face', direction: 'in' });
    expect(t0.rawPayload).toMatchObject({ biostarEventId: '1001', eventCode: 0x1303, subCode: 3, tnaKey: '1', biostarDeviceId: DEVICE, datetime: '2026-03-01T04:00:00.00Z' });
    expect(first.transactions[1]).toMatchObject({ verificationMethod: 'fingerprint', direction: 'out' });

    const second = await p.pullAttendance(ctx, first.nextCursor, { pageSize: 3 });
    const search2 = server.requests.filter((q) => q.path === '/api/events/search')[1];
    expect((search2?.body as { Query: { conditions: unknown[] } }).Query.conditions).toContainEqual({ column: 'id', operator: 5, values: ['1003'] });
    expect(second.transactions.map((t) => t.providerTransactionId)).toEqual(['1005', '1006']); // 1004 door event
    expect(second.transactions[0]).toMatchObject({ punchedAt: '2026-03-01T13:30:15Z', deviceLocalTime: '2026-03-01 17:30:15' });
    expect(second.hasMore).toBe(true);
    const third = await p.pullAttendance(ctx, second.nextCursor, { pageSize: 3 });
    expect(third.transactions.map((t) => t.providerTransactionId)).toEqual(['1008']); // 1007 has no user
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toEqual({ since: '2026-02-08T00:00:00.000Z', lastId: '1008' });
    expect(third.transactions[0]).toMatchObject({ verificationMethod: 'card', direction: 'unknown' });

    // nothing new: the cursor stays; a late-uploaded punch (older datetime, newer id) is still picked up
    const idle = await p.pullAttendance(ctx, third.nextCursor, { pageSize: 3 });
    expect(idle).toMatchObject({ transactions: [], hasMore: false, nextCursor: third.nextCursor });
    server.events.push({ id: 1009, datetime: '2026-02-20T05:00:00.00Z', code: 0x1303, userId: '105' });
    const late = await p.pullAttendance(ctx, third.nextCursor, { pageSize: 3 });
    expect(late.transactions.map((t) => t.providerTransactionId)).toEqual(['1009']);
    expect(ctx.acquireCalls.count).toBe(server.requests.length);
  });

  it('respects since, the configured terminal and a different device timezone', async () => {
    const p = provider();
    const ctx = ctxFor({ timezone: 'Asia/Dubai', config: { baseUrl: server.baseUrl, loginId: server.loginId, deviceId: '541531030' } });
    const r = await p.pullAttendance(ctx, null, { since: '2026-03-02T00:00:00+04:00' });
    const search = server.requests.find((q) => q.path === '/api/events/search');
    expect((search?.body as { Query: { conditions: unknown[] } }).Query.conditions).toEqual([
      { column: 'datetime', operator: 3, values: ['2026-03-01T20:00:00.000Z', '2037-12-31T23:59:59.000Z'] },
      { column: 'device_id', operator: 0, values: ['541531030'] },
    ]);
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]).toMatchObject({ providerTransactionId: '1006', punchedAt: '2026-03-02T03:59:00Z', deviceLocalTime: '2026-03-02 07:59:00', deviceEmployeeId: '103' });
  });

  it('never re-delivers rows at or below the cursor even if the server ignores the id condition', async () => {
    server.ignoreIdCondition = true;
    const r = await provider().pullAttendance(ctxFor(), { since: '2026-02-01T00:00:00.000Z', lastId: '1005' }, { pageSize: 50 });
    expect(r.transactions.map((t) => t.providerTransactionId)).toEqual(['1006', '1008']);
    expect(r.nextCursor).toEqual({ since: '2026-02-01T00:00:00.000Z', lastId: '1008' });
  });

  it('lists users page by page and maps them without secrets', async () => {
    const extra = Array.from({ length: 205 }, (_, i) => mockBioStarUser(`9${String(i).padStart(4, '0')}`, `Bulk ${i}`));
    for (const u of extra) server.users.set(u.user_id, u);
    try {
      const p = provider();
      const ctx = ctxFor();
      const page1 = await p.listEmployees(ctx, null);
      expect(page1.employees).toHaveLength(200);
      expect(page1.nextCursor).toBe('offset:200');
      expect(server.requests.find((q) => q.path === '/api/users')?.query).toMatchObject({ group_id: '1', limit: '200', offset: '0' });
      const page2 = await p.listEmployees(ctx, page1.nextCursor);
      expect(page2.employees).toHaveLength(8);
      expect(page2.nextCursor).toBeNull();
      const sara = [...page1.employees, ...page2.employees].find((e) => e.deviceUserId === '103');
      expect(sara).toMatchObject({ name: 'Sara', enabled: false, pin: null, cardNumber: null, privilege: 'user' });
      await expect(p.listEmployees(ctx, 'page-2')).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    } finally { for (const u of extra) server.users.delete(u.user_id); }
  });

  it('creates, updates (keeping group and validity) and deletes users idempotently', async () => {
    const p = provider();
    const ctx = ctxFor();
    const created = await p.upsertEmployee(ctx, { deviceUserId: '501', name: "Khalid O'Hara", cardNumber: '12345', pin: '4321', privilege: 'user', enabled: true, photoUrl: null, extra: {} });
    expect(created).toMatchObject({ ok: true, deviceUserId: '501', details: { created: true, nameAdjusted: true, notApplied: ['cardNumber'] } });
    const post = server.requests.find((q) => q.method === 'POST' && q.path === '/api/users');
    expect(post?.body).toEqual({ User: { user_id: '501', name: 'Khalid O’Hara', disabled: 'false', user_group_id: { id: '1' }, start_datetime: '2001-01-01T00:00:00.00Z', expiry_datetime: '2037-12-31T23:59:00.00Z', pin: '4321' } });
    expect(server.users.get('501')?.pin).toBe('4321');

    server.users.set('501', { ...server.users.get('501')!, user_group_id: { id: '7', name: 'Night shift' }, expiry_datetime: '2027-01-01T00:00:00.00Z' });
    const updated = await p.upsertEmployee(ctx, { deviceUserId: '501', name: 'Khalid Hara', cardNumber: null, pin: null, privilege: 'user', enabled: false, photoUrl: null, extra: {} });
    expect(updated).toMatchObject({ ok: true, details: { created: false } });
    expect(server.users.get('501')).toMatchObject({ name: 'Khalid Hara', disabled: 'true', user_group_id: { id: '7' }, expiry_datetime: '2027-01-01T00:00:00.00Z', pin: '4321' });

    expect(await p.deleteEmployee(ctx, '501')).toMatchObject({ ok: true });
    expect(server.users.has('501')).toBe(false);
    expect(server.requests.find((q) => q.method === 'DELETE')?.query).toEqual({ id: '501' });
    expect(await p.deleteEmployee(ctx, '501')).toMatchObject({ ok: true, details: { alreadyAbsent: true } });

    await expect(p.upsertEmployee(ctx, { deviceUserId: '1 2', name: 'x', privilege: 'user', enabled: true, extra: {} })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(p.deleteEmployee(ctx, '1+2')).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(p.upsertEmployee(ctx, { deviceUserId: '502', name: 'x', pin: '12', privilege: 'user', enabled: true, extra: {} })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(ctx.acquireCalls.count).toBe(server.requests.length);
  });

  it('a delete BioStar refuses for a user that still exists is an error, not a success', async () => {
    server.users.set('777', mockBioStarUser('777', 'Keep'));
    try {
      server.failNext({ status: 400, body: { Response: { code: '20', message: 'Permission denied' } }, path: '/api/users' });
      await expect(provider().deleteEmployee(ctxFor(), '777')).rejects.toMatchObject({ code: 'VENDOR_ERROR' });
    } finally { server.users.delete('777'); }
  });
});

describe('suprema_biostar2 failures', () => {
  it('wrong password → AUTH_FAILED, testConnection ok:false without leaking the secret', async () => {
    const ctx = ctxFor({ credentials: { password: 'wrong-password' } });
    await expect(provider().getDeviceInfo(ctx)).rejects.toMatchObject({ code: 'AUTH_FAILED', retryable: false });
    const probe = await provider().testConnection(ctx);
    expect(probe.ok).toBe(false);
    expect(probe.details).toMatchObject({ code: 'AUTH_FAILED' });
    expect(JSON.stringify(probe)).not.toContain('wrong-password');
  });

  it('reuses the session, re-logs in once on expiry and keys sessions by the password', async () => {
    const p = provider();
    const ctx = ctxFor();
    const before = server.logins;
    await p.getDeviceStatus(ctx);
    await p.getDeviceStatus(ctx);
    expect(server.logins - before).toBe(1);
    server.expireSessions();
    await p.getDeviceStatus(ctx); // 401 → login → retry
    expect(server.logins - before).toBe(2);
    expect(server.requests.filter((q) => q.path === '/api/devices')).toHaveLength(4);
    // a password change never reuses the session opened with the old one
    const changed = ctxFor({ credentials: { password: 'another-password' } });
    await expect(p.getDeviceStatus(changed)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    // a server that keeps rejecting the fresh session → AUTH_FAILED after exactly one re-login
    server.failNext({ status: 401, body: { Response: { code: '10', message: 'Login required' } }, path: '/api/devices', times: 2 });
    const loginsBefore = server.logins;
    await expect(p.getDeviceStatus(ctx)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(server.logins - loginsBefore).toBe(1);
  });

  it('maps 429, 5xx, a non-zero response code and an unexpected body', async () => {
    const p = provider();
    const ctx = ctxFor();
    await p.getDeviceStatus(ctx); // open a session first
    server.failNext({ status: 429, headers: { 'retry-after': '30' }, path: '/api/events/search' });
    await expect(p.pullAttendance(ctx, null)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterMs: 30_000 });
    server.failNext({ status: 500, path: '/api/events/search' });
    await expect(p.pullAttendance(ctx, null)).rejects.toMatchObject({ code: 'VENDOR_ERROR', retryable: true });
    server.failNext({ status: 503, path: '/api/devices' });
    await expect(p.getDeviceStatus(ctx)).rejects.toMatchObject({ code: 'DEVICE_OFFLINE', retryable: true });
    server.failNext({ status: 200, body: { Response: { code: '4', message: 'Device timeout' } }, path: '/api/devices' });
    await expect(p.getDeviceInfo(ctx)).rejects.toMatchObject({ code: 'VENDOR_ERROR', retryable: true });
    server.failNext({ status: 200, body: { EventCollection: { rows: 'nope' } }, path: '/api/events/search' });
    // never INVALID_CONFIG / PROTOCOL_ERROR: those would make the worker rewind the cursor
    await expect(p.pullAttendance(ctx, { since: '2026-02-01T00:00:00.000Z', lastId: '1' })).rejects.toMatchObject({ code: 'VENDOR_ERROR' });
  });

  it('empty envelope (no EventCollection) is an empty page', async () => {
    server.events = [];
    const r = await provider().pullAttendance(ctxFor(), { since: '2026-02-01T00:00:00.000Z', lastId: '10' });
    expect(r).toMatchObject({ transactions: [], hasMore: false, nextCursor: { since: '2026-02-01T00:00:00.000Z', lastId: '10' } });
  });

  it('bad or missing config → INVALID_CONFIG; https only unless private hosts are allowed', async () => {
    const p = provider();
    await expect(p.getDeviceInfo(ctxFor({ config: { loginId: 'x' } }))).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(p.getDeviceInfo(ctxFor({ config: { baseUrl: server.baseUrl } }))).rejects.toMatchObject({ code: 'INVALID_CONFIG', details: { field: 'loginId' } });
    await expect(p.getDeviceInfo(ctxFor({ credentials: {} }))).rejects.toMatchObject({ code: 'INVALID_CONFIG', details: { field: 'password' } });
    await expect(p.getDeviceInfo(ctxFor({ config: { baseUrl: server.baseUrl, loginId: 'x', deviceId: 'lobby' } }))).rejects.toMatchObject({ code: 'INVALID_CONFIG', details: { field: 'deviceId' } });
    await expect(p.pullAttendance(ctxFor(), { bogus: 'cursor' })).rejects.toMatchObject({ code: 'INVALID_CONFIG', details: { reason: 'invalid_cursor' } });
    const strict = new SupremaBioStar2Provider({ clock });
    await expect(strict.getDeviceInfo(ctxFor())).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('https') });
    const ctx = ctxFor({ config: { baseUrl: server.baseUrl.replace('http:', 'https:'), loginId: 'x' } });
    await expect(strict.getDeviceInfo(ctx)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(ctx.acquireCalls.count).toBe(1); // the egress guard refused the loopback address after throttling
    const probe = await strict.testConnection(ctxFor());
    expect(probe).toMatchObject({ ok: false, details: { code: 'INVALID_CONFIG' } });
  });

  it('unsupported operations throw UNSUPPORTED', async () => {
    await expect(provider().restart(ctxFor())).rejects.toMatchObject({ code: 'UNSUPPORTED', retryable: false });
    expect(await provider().getCapabilities(ctxFor())).toEqual(SUPREMA_BIOSTAR2_DEFINITION.capabilities);
  });
});

describeProviderConformance('suprema_biostar2', () => ({ provider: provider(), ctx: ctxFor(), maxPages: 20 }), { describe, it });
