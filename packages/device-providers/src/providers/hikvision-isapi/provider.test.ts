import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rawTransactionSchema } from '@flowza/contracts';
import { describeProviderConformance } from '../../conformance.js';
import { createTestProviderContext } from '../../testing.js';
import { ProviderError, type AttendancePullResult, type DeviceProvider, type ProviderContext, type SyncCursor } from '../../types.js';
import { HIK_PASS_EVENTS } from '../hikvision/push-protocol.js';
import { HIKVISION_ISAPI_DEFINITION } from './definition.js';
import { createMockIsapiServer, mockIsapiEvents, type MockIsapiServer } from './mock-server.js';
import { HIK_ISAPI_INVALID_CURSOR_REASON, HikvisionIsapiProvider, hikIsapiSearchTime, parseHikIsapiCursor, readIsapiStatus } from './provider.js';

const NOW = new Date('2026-09-10T00:00:00Z');
const clock = (): Date => NOW;
let server: MockIsapiServer;

const provider = (): HikvisionIsapiProvider => new HikvisionIsapiProvider({ allowPrivateHosts: true, clock });
function ctxFor(s: MockIsapiServer, overrides: Partial<ProviderContext> = {}): ProviderContext & { acquireCalls: { count: number } } {
  return createTestProviderContext({
    serialNumber: 'Q12345678',
    config: { baseUrl: s.baseUrl, username: s.username },
    credentials: { password: s.password },
    ...overrides,
  });
}
async function expectCode(p: Promise<unknown>, code: string): Promise<ProviderError> {
  try { await p; } catch (e) {
    expect(ProviderError.is(e)).toBe(true);
    expect((e as ProviderError).code).toBe(code);
    return e as ProviderError;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}
async function pullAll(p: HikvisionIsapiProvider, ctx: ProviderContext, cursor: SyncCursor | null, opts: { pageSize?: number; since?: string } = {}): Promise<{ pages: AttendancePullResult[]; cursor: SyncCursor }> {
  const pages: AttendancePullResult[] = [];
  let c = cursor;
  for (let i = 0; i < 50; i++) {
    const page = await p.pullAttendance(ctx, c, opts);
    pages.push(page);
    c = page.nextCursor;
    if (!page.hasMore) break;
  }
  return { pages, cursor: c ?? {} };
}

beforeAll(async () => {
  server = await createMockIsapiServer({ clock, events: mockIsapiEvents(70) });
});
afterAll(async () => { await server.close(); });
beforeEach(() => { server.requests.length = 0; server.eventSearches.length = 0; server.failedAuth = 0; server.locked = false; });

describe('hikvision_isapi definition', () => {
  it('keeps the registry key, vendor, LAN type and an honest capability matrix', () => {
    const d = HIKVISION_ISAPI_DEFINITION;
    expect(d).toMatchObject({ key: 'hikvision_isapi', vendor: 'Hikvision', integrationType: 'LAN', status: 'beta', verificationStatus: 'REPORTED' });
    expect(d.capabilities).toMatchObject({ attendancePull: true, employeePush: true, employeePull: true, employeeDelete: true, card: true, face: true, fingerprint: true, deviceStatus: true, remoteRestart: true, webhooks: false, devicePush: false, biometricTemplatePush: false, pin: false, attendancePush: false });
    expect(d.configSchema.fields.map((f) => [f.key, f.type, f.required])).toEqual([['baseUrl', 'url', true], ['username', 'text', true], ['password', 'password', true]]);
    expect(d.secretFields).toEqual(['password']);
    const p: DeviceProvider = provider();
    expect(p.pushProtocol).toBeUndefined();
    expect(p.handleWebhook).toBeUndefined();
  });
});

describe('hikvision_isapi helpers', () => {
  it('formats search bounds in the device zone with its offset (Luxon, never hand-computed)', () => {
    expect(hikIsapiSearchTime('2026-09-01T04:00:00Z', 'Asia/Muscat')).toBe('2026-09-01T08:00:00+04:00');
    expect(hikIsapiSearchTime('2026-01-15T10:00:00Z', 'Europe/Berlin')).toBe('2026-01-15T11:00:00+01:00');
  });
  it('validates cursors and flags foreign ones with reason invalid_cursor', () => {
    expect(parseHikIsapiCursor(null)).toBeNull();
    expect(parseHikIsapiCursor({})).toBeNull();
    expect(parseHikIsapiCursor({ since: '2026-09-01T04:00:00Z', position: 3, lastSerialNo: 7 })).toEqual({ since: '2026-09-01T04:00:00Z', position: 3, lastSerialNo: 7 });
    for (const bad of [{ bogus: 'cursor' }, { since: 'yesterday', position: 0 }, { since: '2026-09-01T04:00:00Z', position: -1 }, { since: '2026-09-01T04:00:00+04:00', position: 0 }, { since: '2026-09-01T04:00:00Z', position: 0, lastSerialNo: 'x' }]) {
      let err: unknown;
      try { parseHikIsapiCursor(bad as SyncCursor); } catch (e) { err = e; }
      expect(ProviderError.is(err) && err.code === 'INVALID_CONFIG' && err.details?.['reason'] === HIK_ISAPI_INVALID_CURSOR_REASON).toBe(true);
    }
  });
  it('reads ISAPI ResponseStatus from JSON and XML bodies', () => {
    expect(readIsapiStatus({ json: { statusCode: 6, statusString: 'Invalid Content', subStatusCode: 'employeeNoAlreadyExist' }, text: '' })).toMatchObject({ statusCode: 6, subStatusCode: 'employeeNoAlreadyExist' });
    expect(readIsapiStatus({ json: undefined, text: '<ResponseStatus><statusCode>4</statusCode><statusString>Invalid Operation</statusString><subStatusCode>notSupport</subStatusCode></ResponseStatus>' })).toMatchObject({ statusCode: 4, subStatusCode: 'notSupport' });
    expect(readIsapiStatus({ json: { AcsEvent: {} }, text: '' })).toBeNull();
  });
});

describe('hikvision_isapi against the mock terminal', () => {
  it('testConnection authenticates with Digest and proves the event search works', async () => {
    const ctx = ctxFor(server);
    const r = await provider().testConnection(ctx);
    expect(r.ok).toBe(true);
    expect(r.deviceInfo).toMatchObject({ model: 'DS-K1T341AMF', firmwareVersion: 'V3.2.30', serialNumber: 'DS-K1T341AMF20240101V030000ENGQ12345678' });
    expect(r.details).toMatchObject({ eventSearch: 'ok', serialMatches: true });
    expect(server.requests.filter((q) => q.authorized).map((q) => q.path)).toEqual(['/ISAPI/System/deviceInfo', '/ISAPI/AccessControl/AcsEvent']);
    expect(ctx.acquireCalls.count).toBe(server.requests.length); // one throttle slot per HTTP request (challenge + answer)
    expect(JSON.stringify(r)).not.toContain(server.password);
  });

  it('a wrong password is AUTH_FAILED, tried exactly once per call (lockout protection), and testConnection reports ok:false', async () => {
    const ctx = ctxFor(server, { credentials: { password: 'wrong' } });
    const r = await provider().testConnection(ctx);
    expect(r.ok).toBe(false);
    expect(r.details).toMatchObject({ code: 'AUTH_FAILED', retryable: false });
    expect(r.message).toMatch(/lock/);
    expect(server.requests).toHaveLength(2); // unauthenticated challenge + ONE answer
    expect(server.failedAuth).toBe(1);
    const err = await expectCode(provider().pullAttendance(ctx, null), 'AUTH_FAILED');
    expect(err.retryable).toBe(false);
    expect(server.failedAuth).toBe(2);
    expect(JSON.stringify(r)).not.toContain('wrong');
  });

  it('a locked account stays AUTH_FAILED even with the right password', async () => {
    server.locked = true;
    await expectCode(provider().getDeviceStatus(ctxFor(server)), 'AUTH_FAILED');
    server.locked = false;
  });

  it('every exchange answers a fresh challenge, so expired nonces are transparent', async () => {
    const p = provider();
    const ctx = ctxFor(server);
    await p.getDeviceStatus(ctx);
    server.expireNonces();
    const s = await p.getDeviceStatus(ctx);
    expect(s.online).toBe(true);
  });

  it('getDeviceInfo reads deviceInfo, time and the user count', async () => {
    const info = await provider().getDeviceInfo(ctxFor(server));
    expect(info).toMatchObject({ model: 'DS-K1T341AMF', serialNumber: 'DS-K1T341AMF20240101V030000ENGQ12345678', firmwareVersion: 'V3.2.30', deviceTime: '2026-09-10T04:00:00+04:00', userCount: 0 });
    expect(info.extra).toMatchObject({ deviceName: 'Main Gate', deviceTimeUtc: '2026-09-10T00:00:00Z', timezoneMismatch: false, timeMode: 'NTP' });
  });

  it('getDeviceStatus reports clock skew and a zone mismatch', async () => {
    const fast = await createMockIsapiServer({ clock: () => new Date(NOW.getTime() + 95_000), timezone: 'Asia/Dubai' });
    try {
      const s = await provider().getDeviceStatus(ctxFor(fast));
      expect(s).toMatchObject({ online: true, clockSkewSeconds: 95, deviceTime: '2026-09-10T04:01:35+04:00' });
      const berlin = await provider().getDeviceStatus(ctxFor(fast, { timezone: 'Europe/Berlin' }));
      expect(berlin.details).toMatchObject({ timezoneMismatch: true });
      expect(berlin.clockSkewSeconds).toBe(95); // the device's own offset wins over the configured zone
    } finally { await fast.close(); }
  });

  it('pullAttendance pages through AcsEvent with a rebasing cursor, converting device time to UTC', async () => {
    const p = provider();
    const ctx = ctxFor(server);
    const first = await p.pullAttendance(ctx, null);
    expect(first.transactions).toHaveLength(30);
    expect(first.hasMore).toBe(true);
    const t = first.transactions[0]!;
    expect(rawTransactionSchema.safeParse(t).success).toBe(true);
    expect(t).toMatchObject({ providerTransactionId: '1000', deviceEmployeeId: 'E0100', punchedAt: '2026-09-01T04:00:00Z', deviceLocalTime: '2026-09-01T08:00:00+04:00', verificationMethod: 'face', direction: 'in' });
    expect(t.rawPayload).toMatchObject({ protocol: 'hikvision_isapi', eventType: 'AcsEvent', serialNo: 1000, subEventType: 0x4b, attendanceStatus: 'checkIn' });
    const raw = JSON.stringify(first.transactions);
    for (const secret of ['Secret Name', '99887766', 'picture']) expect(raw).not.toContain(secret);
    expect(first.transactions.map((x) => x.verificationMethod).slice(0, 4)).toEqual(['face', 'card', 'fingerprint', 'face']);
    expect(first.transactions.map((x) => x.direction).slice(0, 4)).toEqual(['in', 'out', 'break_out', 'break_in']);
    // default window: 30 days back, bounds in the device's own offset
    expect(server.eventSearches[0]).toMatchObject({ searchResultPosition: 0, maxResults: 30, major: 5, minor: 0, startTime: '2026-08-11T04:00:00+04:00', endTime: '2026-09-10T04:15:00+04:00' });
    // the cursor rebased onto the newest event of the page
    expect(first.nextCursor).toEqual({ since: '2026-09-01T04:29:00Z', position: 1, lastSerialNo: 1029 });

    const rest = await pullAll(p, ctx, first.nextCursor);
    const all = [first, ...rest.pages].flatMap((pg) => pg.transactions);
    expect(all).toHaveLength(70);
    expect(new Set(all.map((x) => x.providerTransactionId)).size).toBe(70);
    expect(rest.pages.at(-1)!.hasMore).toBe(false);

    // nothing new: no rows, cursor unchanged
    const idle = await p.pullAttendance(ctx, rest.cursor);
    expect(idle.transactions).toHaveLength(0);
    expect(idle.nextCursor).toEqual(rest.cursor);
    expect(idle.hasMore).toBe(false);

    // a new punch arrives: exactly that one is delivered
    server.events.push({ major: 5, minor: 0x4b, serialNo: 1070, time: '2026-09-02T09:00:00+04:00', employeeNoString: 'E0200', attendanceStatus: 'checkOut' });
    try {
      const fresh = await p.pullAttendance(ctx, rest.cursor);
      expect(fresh.transactions.map((x) => [x.providerTransactionId, x.punchedAt, x.direction])).toEqual([['1070', '2026-09-02T05:00:00Z', 'out']]);
    } finally { server.events.pop(); }
    expect(ctx.acquireCalls.count).toBe(server.requests.length);
  });

  it('is idempotent: the same cursor yields the same page', async () => {
    const p = provider();
    const ctx = ctxFor(server);
    const a = await p.pullAttendance(ctx, { since: '2026-09-01T04:10:00Z', position: 1, lastSerialNo: 1010 });
    const b = await p.pullAttendance(ctx, { since: '2026-09-01T04:10:00Z', position: 1, lastSerialNo: 1010 });
    expect(b.transactions).toEqual(a.transactions);
    expect(b.nextCursor).toEqual(a.nextCursor);
    expect(a.transactions[0]!.providerTransactionId).toBe('1011');
  });

  it('respects pageSize (clamped to the device cap) and since', async () => {
    const p = provider();
    const ctx = ctxFor(server);
    const small = await p.pullAttendance(ctx, null, { pageSize: 5, since: '2026-09-01T05:00:00Z' });
    expect(server.eventSearches[0]).toMatchObject({ maxResults: 5, startTime: '2026-09-01T09:00:00+04:00' });
    expect(small.transactions.map((x) => x.providerTransactionId)).toEqual(['1060', '1061', '1062', '1063', '1064']);
    await p.pullAttendance(ctx, null, { pageSize: 500 });
    expect(server.eventSearches[1]).toMatchObject({ maxResults: 30 });
  });

  it('keeps same-second bursts and non-attendance events exact across page boundaries', async () => {
    const burst = [
      ...Array.from({ length: 35 }, (_, i) => ({ major: 5, minor: 0x4b, serialNo: 10 + i, time: '2026-09-05T08:00:00+04:00', employeeNoString: `B${i}` })),
      { major: 5, minor: 0x15, serialNo: 45, time: '2026-09-05T08:00:01+04:00' }, // door unlocked: not attendance
      { major: 5, minor: 0x4b, serialNo: 46, time: '2026-09-05T08:00:02+04:00', employeeNoString: '0' }, // stranger
      { major: 5, minor: 0x06, serialNo: 47, time: '2026-09-05T08:00:03+04:00', employeeNoString: 'E1' }, // card no permission
      { major: 5, minor: 0x01, serialNo: 48, time: 'garbage', employeeNoString: 'E2' },
      { major: 5, minor: 0x01, serialNo: 49, time: '2026-09-05T08:00:04+04:00', employeeNoString: 'bad id!' },
      { major: 5, minor: 0x01, serialNo: 50, time: '2026-09-05T08:00:05+04:00', employeeNoString: 'E3' },
    ];
    const s = await createMockIsapiServer({ clock, events: burst });
    try {
      const p = provider();
      const ctx = ctxFor(s);
      const first = await p.pullAttendance(ctx, null);
      expect(first.transactions).toHaveLength(30);
      expect(first.nextCursor).toEqual({ since: '2026-09-05T04:00:00Z', position: 30, lastSerialNo: 39 });
      const rest = await pullAll(p, ctx, first.nextCursor);
      const all = [first, ...rest.pages].flatMap((pg) => pg.transactions);
      expect(all.map((x) => x.deviceEmployeeId)).toEqual([...Array.from({ length: 35 }, (_, i) => `B${i}`), 'E3']);
      expect(rest.pages[0]!.meta).toMatchObject({ skipped: { notPass: 2, noEmployee: 1, badEmployee: 1 } });
      // a record whose time cannot be read is skipped but still consumed (the position moves past it)
      s.failNext({ status: 200, body: JSON.stringify({ AcsEvent: { searchID: 'x', responseStatusStrg: 'OK', numOfMatches: 2, totalMatches: 2, InfoList: [{ major: 5, minor: 1, time: 'garbage', employeeNoString: 'E2', serialNo: 48 }, { major: 5, minor: 1, time: '2026-09-05T08:00:00+04:00', employeeNoString: 'E4', serialNo: 51 }] } }) });
      const odd = await p.pullAttendance(ctx, { since: '2026-09-05T04:00:00Z', position: 0, lastSerialNo: null });
      expect(odd.transactions.map((x) => x.deviceEmployeeId)).toEqual(['E4']);
      expect(odd.meta).toMatchObject({ skipped: { badTime: 1 } });
      expect(odd.nextCursor).toEqual({ since: '2026-09-05T04:00:00Z', position: 2, lastSerialNo: 51 });
      // exhausted: replays nothing, keeps the cursor
      const tail = await p.pullAttendance(ctx, rest.cursor);
      expect(tail.transactions).toHaveLength(0);
      expect(tail.nextCursor).toEqual(rest.cursor);
    } finally { await s.close(); }
  });

  it('classifies events with the push path table (HIK_PASS_EVENTS)', async () => {
    const minors = Object.keys(HIK_PASS_EVENTS).map(Number);
    const s = await createMockIsapiServer({ clock, events: minors.map((minor, i) => ({ major: 5, minor, serialNo: i + 1, time: `2026-09-06T08:00:${String(i).padStart(2, '0')}+04:00`, employeeNoString: 'E9' })) });
    try {
      const page = await provider().pullAttendance(ctxFor(s), null);
      expect(page.transactions.map((t) => t.verificationMethod)).toEqual(minors.map((m) => HIK_PASS_EVENTS[m]));
    } finally { await s.close(); }
  });

  it('an unparseable cursor is INVALID_CONFIG before any request', async () => {
    const err = await expectCode(provider().pullAttendance(ctxFor(server), { bogus: 'cursor' }), 'INVALID_CONFIG');
    expect(err.details?.['reason']).toBe(HIK_ISAPI_INVALID_CURSOR_REASON);
    expect(server.requests).toHaveLength(0);
  });

  it('lists users page by page', async () => {
    const s = await createMockIsapiServer({ clock, users: Array.from({ length: 65 }, (_, i) => ({ employeeNo: `U${i}`, name: i === 0 ? '' : `User ${i}`, userType: 'normal', localUIRight: i === 1, Valid: { enable: i !== 2, beginTime: '2020-01-01T00:00:00', endTime: '2037-12-31T23:59:59' }, cards: [] })) });
    try {
      const p = provider();
      const ctx = ctxFor(s);
      const pages = [];
      let cursor: string | null = null;
      do { const page = await p.listEmployees(ctx, cursor); pages.push(page); cursor = page.nextCursor; } while (cursor !== null);
      expect(pages.map((pg) => pg.employees.length)).toEqual([30, 30, 5]);
      const all = pages.flatMap((pg) => pg.employees);
      expect(all[0]).toMatchObject({ deviceUserId: 'U0', name: 'U0', privilege: 'user', enabled: true, cardNumber: null, pin: null });
      expect(all[1]).toMatchObject({ privilege: 'admin' });
      expect(all[2]).toMatchObject({ enabled: false });
      await expectCode(p.listEmployees(ctx, 'page-2'), 'INVALID_CONFIG');
    } finally { await s.close(); }
  });

  it('upsert creates, falls back to Modify on employeeNoAlreadyExist, enrols the card best-effort; delete removes', async () => {
    const p = provider();
    const ctx = ctxFor(server);
    const created = await p.upsertEmployee(ctx, { deviceUserId: 'E500', name: 'سالم الحارثي', cardNumber: '12345678', pin: '1234', privilege: 'user', enabled: true, photoUrl: null, extra: {} });
    expect(created).toMatchObject({ ok: true, deviceUserId: 'E500', details: { action: 'created', card: { status: 'created' }, pin: 'not_managed' } });
    expect(server.users.get('E500')).toMatchObject({ name: 'سالم الحارثي', cards: ['12345678'], Valid: { enable: true } });
    const recordBody = server.requests.find((q) => q.authorized && q.path.endsWith('/UserInfo/Record'))!.body as { UserInfo: Record<string, unknown> };
    expect(recordBody.UserInfo).toMatchObject({ employeeNo: 'E500', userType: 'normal', doorRight: '1', RightPlan: [{ doorNo: 1, planTemplateNo: '1' }] });
    expect(JSON.stringify(recordBody)).not.toContain('1234"'); // the PIN is never sent

    const updated = await p.upsertEmployee(ctx, { deviceUserId: 'E500', name: 'Salem', cardNumber: '12345678', pin: null, privilege: 'user', enabled: false, photoUrl: null, extra: {} });
    expect(updated).toMatchObject({ ok: true, details: { action: 'updated', card: { status: 'already_exists' } } });
    expect(server.users.get('E500')).toMatchObject({ name: 'Salem', Valid: { enable: false } });

    server.failNext({ status: 500, path: '/ISAPI/AccessControl/CardInfo/Record' });
    const cardFails = await p.upsertEmployee(ctx, { deviceUserId: 'E501', name: 'Card Fail', cardNumber: '555', pin: null, privilege: 'user', enabled: true, photoUrl: null, extra: {} });
    expect(cardFails).toMatchObject({ ok: true, details: { action: 'created', card: { status: 'failed', code: 'VENDOR_ERROR' } } });
    expect(cardFails.message).toMatch(/card/);

    await expectCode(p.upsertEmployee(ctx, { deviceUserId: 'bad id', name: 'x', privilege: 'user', enabled: true, extra: {} }), 'INVALID_CONFIG');

    expect((await p.deleteEmployee(ctx, 'E500')).ok).toBe(true);
    expect((await p.deleteEmployee(ctx, 'E501')).ok).toBe(true);
    expect(server.users.has('E500')).toBe(false);
    const list = await p.listEmployees(ctx, null);
    expect(list.employees.some((e) => e.deviceUserId === 'E500')).toBe(false);
    expect(ctx.acquireCalls.count).toBe(server.requests.length);
  });

  it('restart asks the terminal to reboot', async () => {
    const before = server.reboots;
    const r = await provider().restart(ctxFor(server));
    expect(r.ok).toBe(true);
    expect(server.reboots).toBe(before + 1);
  });

  it('maps 429, 5xx and ISAPI sub-status codes', async () => {
    const p = provider();
    const ctx = ctxFor(server);
    server.failNext({ status: 429, headers: { 'retry-after': '12' } });
    const limited = await expectCode(p.getDeviceStatus(ctx), 'RATE_LIMITED');
    expect(limited.retryable).toBe(true);
    expect(limited.retryAfterMs).toBe(12_000);
    server.failNext({ status: 503 });
    expect((await expectCode(p.getDeviceStatus(ctx), 'DEVICE_OFFLINE')).retryable).toBe(true);
    server.failNext({ status: 500 });
    expect((await expectCode(p.pullAttendance(ctx, null), 'VENDOR_ERROR')).retryable).toBe(true);
    server.failNext({ status: 400, body: JSON.stringify({ statusCode: 6, statusString: 'Invalid Content', subStatusCode: 'badJsonContent', errorMsg: 'x'.repeat(5000) }) });
    const bad = await expectCode(p.pullAttendance(ctx, null), 'VENDOR_ERROR');
    expect(bad.retryable).toBe(false);
    expect(bad.message).toContain('badJsonContent');
    expect(bad.message).not.toContain('xxxx');
    server.failNext({ status: 400, body: JSON.stringify({ statusCode: 4, subStatusCode: 'deviceBusy' }) });
    expect((await expectCode(p.pullAttendance(ctx, null), 'VENDOR_ERROR')).retryable).toBe(true);
    server.failNext({ status: 200, body: '<html>proxy login</html>' });
    expect((await expectCode(p.getDeviceInfo(ctx), 'VENDOR_ERROR')).retryable).toBe(false);
    // an odd answer must never look like a cursor problem (the worker rewinds on PROTOCOL_ERROR / INVALID_CONFIG)
    server.failNext({ status: 200, body: JSON.stringify({ unexpected: true }) });
    expect((await expectCode(p.pullAttendance(ctx, { since: '2026-09-01T04:00:00Z', position: 0, lastSerialNo: null }), 'VENDOR_ERROR')).retryable).toBe(true);
  });

  it('firmware without the endpoint → UNSUPPORTED (and testConnection ok:false)', async () => {
    const s = await createMockIsapiServer({ clock, unsupportedPaths: ['/ISAPI/AccessControl/AcsEvent', '/ISAPI/AccessControl/UserInfo/Count'] });
    try {
      const p = provider();
      await expectCode(p.pullAttendance(ctxFor(s), null), 'UNSUPPORTED');
      const r = await p.testConnection(ctxFor(s));
      expect(r).toMatchObject({ ok: false, details: { code: 'UNSUPPORTED' } });
      const info = await p.getDeviceInfo(ctxFor(s)); // the optional user count is skipped, not fatal
      expect(info.userCount).toBeUndefined();
    } finally { await s.close(); }
  });

  it('missing or unsafe configuration is INVALID_CONFIG', async () => {
    const p = provider();
    await expectCode(p.pullAttendance(ctxFor(server, { config: { username: 'admin' } }), null), 'INVALID_CONFIG');
    await expectCode(p.pullAttendance(ctxFor(server, { config: { baseUrl: server.baseUrl } }), null), 'INVALID_CONFIG');
    await expectCode(p.pullAttendance(ctxFor(server, { credentials: {} }), null), 'INVALID_CONFIG');
    await expectCode(p.pullAttendance(ctxFor(server, { config: { baseUrl: 'https://admin:pw@example.com', username: 'admin' } }), null), 'INVALID_CONFIG');
    await expectCode(p.pullAttendance(ctxFor(server, { timezone: 'Mars/Olympus' }), null), 'INVALID_CONFIG');
    const r = await p.testConnection(ctxFor(server, { credentials: {} }));
    expect(r).toMatchObject({ ok: false, details: { code: 'INVALID_CONFIG', field: 'password' } });
    // production egress: https only
    const strict = new HikvisionIsapiProvider({ clock });
    const err = await expectCode(strict.getDeviceStatus(ctxFor(server)), 'INVALID_CONFIG');
    expect(err.message).toMatch(/https/);
    expect(server.requests).toHaveLength(0);
  });

  it('accepts a device URL pasted with the /ISAPI suffix', async () => {
    const s = await provider().getDeviceStatus(ctxFor(server, { config: { baseUrl: `${server.baseUrl}/ISAPI`, username: server.username } }));
    expect(s.online).toBe(true);
  });
});

describe('hikvision_isapi conformance', () => {
  let conf: MockIsapiServer;
  beforeAll(async () => { conf = await createMockIsapiServer({ clock, events: mockIsapiEvents(45, { start: '2026-09-03T07:00:00', stepSeconds: 20 }) }); });
  afterAll(async () => { await conf.close(); });
  describeProviderConformance('hikvision_isapi', () => ({ provider: provider(), ctx: ctxFor(conf) }), { describe, it });
});
