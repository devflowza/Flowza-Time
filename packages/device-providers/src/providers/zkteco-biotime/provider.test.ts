import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rawTransactionSchema } from '@flowza/contracts';
import { describeProviderConformance } from '../../conformance.js';
import { createTestProviderContext } from '../../testing.js';
import { ProviderError, type AttendancePullResult, type ProviderContext, type SyncCursor } from '../../types.js';
import { ZKTECO_BIOTIME_DEFINITION } from './definition.js';
import { bioTimeTerminalFixture, bioTimeTransactionFixtures, createMockBioTimeServer, type MockBioTimeServer, type MockBioTimeTransaction } from './mock-server.js';
import { BIOTIME_INVALID_CURSOR_REASON, BIOTIME_MAX_SCAN_RESTARTS, mapBioTimePunchState, mapBioTimeTransaction, mapBioTimeVerifyType, parseBioTimeCursor, ZKBioTimeProvider } from './provider.js';

const USER = 'api-user';
const PASS = 'api-secret-pass';
const SN = 'CQZ7232460001';
/** Fixed clock: 2026-03-03 16:00 in Asia/Muscat (UTC+4). */
const NOW = new Date('2026-03-03T12:00:00Z');
const clock = (): Date => NOW;

let server: MockBioTimeServer;
const fixtures = (): MockBioTimeTransaction[] => bioTimeTransactionFixtures(48); // 2026-03-01 08:00 … 2026-03-03 07:00 local

function ctxFor(overrides: Partial<ProviderContext> & { config?: Record<string, unknown> } = {}, srv: MockBioTimeServer = server): ProviderContext & { acquireCalls: { count: number } } {
  const { config, ...rest } = overrides;
  return createTestProviderContext({
    timezone: 'Asia/Muscat',
    config: { baseUrl: srv.baseUrl, username: USER, pageSize: 10, departmentId: 1, areaId: 2, ...(config ?? {}) },
    credentials: { password: PASS },
    ...rest,
  });
}
const provider = (extra: Partial<ConstructorParameters<typeof ZKBioTimeProvider>[0]> = {}): ZKBioTimeProvider => new ZKBioTimeProvider({ allowPrivateHosts: true, clock, ...extra });

async function pullAll(p: ZKBioTimeProvider, ctx: ProviderContext, cursor: SyncCursor | null = null, max = 50): Promise<{ pages: AttendancePullResult[]; ids: string[]; cursor: SyncCursor }> {
  const pages: AttendancePullResult[] = [];
  let c = cursor;
  for (let i = 0; i < max; i++) {
    const page = await p.pullAttendance(ctx, c);
    pages.push(page);
    c = page.nextCursor;
    if (!page.hasMore) break;
  }
  return { pages, ids: pages.flatMap((pg) => pg.transactions.map((t) => t.providerTransactionId ?? '')), cursor: c ?? {} };
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<ProviderError> {
  try { await fn(); } catch (e) {
    expect(ProviderError.is(e)).toBe(true);
    expect((e as ProviderError).code).toBe(code);
    return e as ProviderError;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

beforeAll(async () => {
  server = await createMockBioTimeServer({ username: USER, password: PASS, transactions: fixtures(), terminals: [bioTimeTerminalFixture()], now: () => NOW.getTime() });
});
afterAll(async () => { await server.close(); });
beforeEach(() => {
  server.requests.length = 0;
  server.transactions.splice(0, server.transactions.length, ...fixtures());
});

describe('zkteco_biotime definition and mapping', () => {
  it('declares an honest beta definition', () => {
    const d = ZKTECO_BIOTIME_DEFINITION;
    expect(d).toMatchObject({ key: 'zkteco_biotime', vendor: 'ZKTeco', integrationType: 'ON_PREM_SERVER_API', status: 'beta', verificationStatus: 'REPORTED' });
    expect(d.secretFields).toEqual(['password']);
    expect(d.capabilities).toMatchObject({ attendancePull: true, employeePull: true, employeePush: true, employeeDelete: true, remoteRestart: false, webhooks: false, devicePush: false, biometricTemplatePush: false });
  });

  it('maps punch_state and verify_type codes (REPORTED tables)', () => {
    expect(['0', '1', '2', '3', '4', '5', '255', 'x', null].map(mapBioTimePunchState)).toEqual(['in', 'out', 'break_out', 'break_in', 'overtime_in', 'overtime_out', 'unknown', 'unknown', 'unknown']);
    expect([1, '15', 4, 3, 2, 25, 0, 6, undefined].map(mapBioTimeVerifyType)).toEqual(['fingerprint', 'face', 'card', 'password', 'pin', 'palm', 'unknown', 'unknown', 'unknown']);
  });

  it('converts server-local punch time with the device timezone and keeps an allowlisted payload', () => {
    const [row] = fixtures();
    const m = mapBioTimeTransaction({ ...row!, id: row!.id, verify_type: String(row!.verify_type), punch_state: row!.punch_state, source: '1', purpose: '9', is_attendance: '1' } as never, 'Asia/Muscat');
    expect(m.transaction).toMatchObject({ providerTransactionId: '1', deviceEmployeeId: '1000', punchedAt: '2026-03-01T04:00:00Z', deviceLocalTime: '2026-03-01 08:00:00', direction: 'in', verificationMethod: 'face' });
    expect(rawTransactionSchema.safeParse(m.transaction).success).toBe(true);
    const payload = m.transaction!.rawPayload;
    expect(payload).not.toHaveProperty('temperature');
    expect(payload).not.toHaveProperty('is_mask');
    expect(JSON.stringify(payload).length).toBeLessThan(16_384);
    expect(mapBioTimeTransaction({ id: 9, emp_code: '', punch_time: '2026-03-01 08:00:00' }, 'Asia/Muscat').reason).toBe('no_identity');
    expect(mapBioTimeTransaction({ id: 9, emp_code: '7', punch_time: 'yesterday' }, 'Asia/Muscat').reason).toBe('bad_time');
  });

  it('validates cursors: {} / null start fresh, anything foreign is INVALID_CONFIG(invalid_cursor)', () => {
    expect(parseBioTimeCursor(null)).toBeNull();
    expect(parseBioTimeCursor({})).toBeNull();
    expect(parseBioTimeCursor({ v: 1, next: '2026-03-01T00:00:00Z' })).toEqual({ v: 1, next: '2026-03-01T00:00:00Z' });
    for (const bad of [{ bogus: 'cursor' }, { v: 2, next: '2026-03-01T00:00:00Z' }, { v: 1, next: 'not-a-date' }, { v: 1, next: '2026-03-01T00:00:00Z', extra: 1 },
      { v: 1, scan: { from: '2026-03-02T00:00:00Z', to: '2026-03-01T00:00:00Z', page: 1, size: 10, count: null, restarts: 0 } },
      { v: 1, scan: { from: '2026-03-01T00:00:00Z', to: '2026-03-02T00:00:00Z', page: 0, size: 10, count: null, restarts: 0 } }]) {
      let err: unknown;
      try { parseBioTimeCursor(bad); } catch (e) { err = e; }
      expect(ProviderError.is(err)).toBe(true);
      expect((err as ProviderError).code).toBe('INVALID_CONFIG');
      expect((err as ProviderError).details?.['reason']).toBe(BIOTIME_INVALID_CURSOR_REASON);
    }
  });
});

describe('zkteco_biotime connection, info and status', () => {
  it('testConnection logs in with JWT and reads the terminal list', async () => {
    const ctx = ctxFor();
    const r = await provider().testConnection(ctx);
    expect(r).toMatchObject({ ok: true, details: { authScheme: 'JWT', terminalCount: 1 } });
    expect(server.requests.map((q) => `${q.method} ${q.path}`)).toEqual(['POST /jwt-api-token-auth/', 'GET /iclock/api/terminals/']);
    expect(server.requests[1]!.authorization).toMatch(/^JWT /);
    expect(ctx.acquireCalls.count).toBe(server.requests.length);
  });

  it('testConnection with a terminal serial reports that terminal; an unknown serial is ok:false', async () => {
    const r = await provider().testConnection(ctxFor({ config: { terminalSn: SN } }));
    expect(r.ok).toBe(true);
    expect(r.deviceInfo).toMatchObject({ serialNumber: SN, firmwareVersion: 'Ver 6.60 Apr 28 2021', userCount: 120 });
    const miss = await provider().testConnection(ctxFor({ config: { terminalSn: 'NOPE' } }));
    expect(miss).toMatchObject({ ok: false, details: { code: 'NOT_FOUND', field: 'terminalSn' } });
  });

  it('bad credentials → AUTH_FAILED, and testConnection answers ok:false without throwing or leaking the password', async () => {
    const ctx = ctxFor({ credentials: { password: 'wrong-password' } });
    await expectCode(() => provider().getDeviceInfo(ctx), 'AUTH_FAILED');
    const r = await provider().testConnection(ctx);
    expect(r).toMatchObject({ ok: false, details: { code: 'AUTH_FAILED' } });
    expect(JSON.stringify(r)).not.toContain('wrong-password');
  });

  it('falls back to /api-token-auth/ with `Token` when the JWT route does not exist', async () => {
    const legacy = await createMockBioTimeServer({ username: USER, password: PASS, jwt: false, terminals: [bioTimeTerminalFixture()] });
    try {
      const r = await provider().testConnection(ctxFor({}, legacy));
      expect(r).toMatchObject({ ok: true, details: { authScheme: 'Token' } });
      expect(legacy.requests.map((q) => q.path)).toEqual(['/jwt-api-token-auth/', '/api-token-auth/', '/iclock/api/terminals/']);
      expect(legacy.requests[2]!.authorization).toMatch(/^Token [0-9a-f]{40}$/);
    } finally { await legacy.close(); }
  });

  it('getDeviceInfo describes the terminal (or the server) and getDeviceStatus follows the terminal state', async () => {
    const p = provider();
    expect(await p.getDeviceInfo(ctxFor({ config: { terminalSn: SN } }))).toMatchObject({ serialNumber: SN, faceCount: 110, fingerprintCount: 230, transactionCount: 5321, extra: { alias: 'Main gate', state: 1 } });
    expect(await p.getDeviceInfo(ctxFor())).toMatchObject({ model: 'ZKBio Time server', extra: { terminalCount: 1, terminals: [{ sn: SN }] } });
    await expectCode(() => p.getDeviceInfo(ctxFor({ config: { terminalSn: 'NOPE' } })), 'NOT_FOUND');

    const status = await p.getDeviceStatus(ctxFor({ config: { terminalSn: SN } }));
    expect(status).toMatchObject({ online: true, lastSeenAt: '2026-03-02T05:58:00Z', details: { serverReachable: true, terminalState: 1 } });
    const t = server.terminals[0]!;
    const saved = { ...t };
    Object.assign(t, { state: 0, last_activity: '2026-03-03 15:55:00' }); // 5 minutes ago local → still online
    expect((await p.getDeviceStatus(ctxFor({ config: { terminalSn: SN } }))).online).toBe(true);
    Object.assign(t, { state: 0, last_activity: '2026-03-02 09:00:00' });
    expect((await p.getDeviceStatus(ctxFor({ config: { terminalSn: SN } }))).online).toBe(false);
    expect(await p.getDeviceStatus(ctxFor())).toMatchObject({ online: true, details: { terminalCount: 1, onlineTerminals: 0 } });
    Object.assign(t, saved);
  });

  it('restart is honestly unsupported', async () => {
    await expectCode(() => provider().restart(ctxFor()), 'UNSUPPORTED');
  });
});

describe('zkteco_biotime attendance pull', () => {
  it('pages a frozen window with the cursor, converts the timezone and reports hasMore honestly', async () => {
    const p = provider();
    const ctx = ctxFor();
    const { pages, ids, cursor } = await pullAll(p, ctx);
    expect(pages).toHaveLength(5);
    expect(pages.map((pg) => pg.hasMore)).toEqual([true, true, true, true, false]);
    expect(pages.slice(0, 4).map((pg) => (pg.nextCursor as { scan: { page: number } }).scan.page)).toEqual([2, 3, 4, 5]);
    expect(new Set(ids).size).toBe(48);
    const first = pages[0]!.transactions[0]!;
    expect(first).toMatchObject({ providerTransactionId: '1', punchedAt: '2026-03-01T04:00:00Z', deviceLocalTime: '2026-03-01 08:00:00' });
    for (const pg of pages) for (const t of pg.transactions) expect(rawTransactionSchema.safeParse(t).success).toBe(true);
    // default start = now - 30 days, window frozen at "now", both as server-local wall time
    const q = server.requests.filter((r) => r.path === '/iclock/api/transactions/');
    expect(q[0]!.query).toMatchObject({ start_time: '2026-02-01 16:00:00', end_time: '2026-03-03 16:00:00', page: '1', limit: '10', page_size: '10' });
    expect(new Set(q.map((r) => `${r.query['start_time']}|${r.query['end_time']}`)).size).toBe(1);
    // completed scan → next scan starts 24 h (lateArrivalHours) before the frozen end
    expect(cursor).toEqual({ v: 1, next: '2026-03-02T12:00:00Z' });
    // one login for the whole run, one acquire per HTTP request
    expect(server.requests.filter((r) => r.path === '/jwt-api-token-auth/')).toHaveLength(1);
    expect(ctx.acquireCalls.count).toBe(server.requests.length);
  });

  it('the same cursor yields the same page; a replay-only rescan keeps the cursor', async () => {
    const p = provider();
    const ctx = ctxFor();
    const a = await p.pullAttendance(ctx, null);
    const b = await p.pullAttendance(ctx, null);
    expect(b.transactions).toEqual(a.transactions);
    expect(b.nextCursor).toEqual(a.nextCursor);
    const mid1 = await p.pullAttendance(ctx, a.nextCursor);
    const mid2 = await p.pullAttendance(ctx, a.nextCursor);
    expect(mid2).toMatchObject({ transactions: mid1.transactions, nextCursor: mid1.nextCursor });

    const { cursor, ids } = await pullAll(p, ctx);
    const tail = await pullAll(p, ctx, cursor);
    // the 24 h overlap re-reads the 16 punches of 03-02 16:00 … 03-03 07:00 (2 pages of 10), then settles on the same cursor
    expect(tail.pages.map((pg) => pg.hasMore)).toEqual([true, false]);
    expect(tail.ids).toHaveLength(16);
    expect(tail.ids.every((id) => ids.includes(id))).toBe(true); // overlap only replays delivered rows
    expect(tail.ids.length).toBeGreaterThan(0);
    expect(tail.cursor).toEqual(cursor);
  });

  it('honours opts.since and opts.pageSize when there is no cursor', async () => {
    const p = provider();
    const page = await p.pullAttendance(ctxFor(), null, { since: '2026-03-03T00:00:00Z', pageSize: 2 });
    const q = server.requests.filter((r) => r.path === '/iclock/api/transactions/').at(-1)!;
    expect(q.query).toMatchObject({ start_time: '2026-03-03 04:00:00', limit: '2' });
    expect(page.transactions.map((t) => t.deviceLocalTime)).toEqual(['2026-03-03 04:00:00', '2026-03-03 05:00:00']);
    await expectCode(() => p.pullAttendance(ctxFor(), null, { since: 'garbage' }), 'INVALID_CONFIG');
  });

  it('catches a punch uploaded late (inside the late-upload window) on the next pull', async () => {
    const p = provider();
    const ctx = ctxFor();
    const { cursor } = await pullAll(p, ctx);
    // terminal was offline: a punch from 10 hours ago arrives now with a new id
    server.transactions.push({ ...bioTimeTransactionFixtures(1, '2026-03-03 06:00:00', SN, 500)[0]!, emp_code: '2000', upload_time: '2026-03-03 15:59:00' });
    const next = await pullAll(p, ctx, cursor);
    expect(next.ids).toContain('500');
  });

  it('restarts a scan when the result set changes under it, so no shifted row is skipped', async () => {
    const p = provider();
    // ordering undocumented: use newest-first so a late row lands on an already-read page and shifts the rest
    const shifting = await createMockBioTimeServer({ username: USER, password: PASS, transactions: fixtures(), terminals: [bioTimeTerminalFixture()], order: '-punch_time', now: () => NOW.getTime() });
    try {
      const sctx = ctxFor({}, shifting);
      shifting.afterNext('/iclock/api/transactions/', () => { shifting.transactions.push({ ...bioTimeTransactionFixtures(1, '2026-03-03 07:30:00', SN, 900)[0]!, emp_code: '3000' }); });
      const { pages, ids } = await pullAll(p, sctx);
      expect(pages.some((pg) => pg.meta?.['restarted'] === true)).toBe(true);
      expect(new Set(ids).size).toBe(49);
      expect(ids).toContain('900');
      // a page past the (shrunken) end → 404 "Invalid page." → restart, not a failure
      const first = await p.pullAttendance(sctx, null);
      shifting.transactions.splice(0, 45);
      const vanished = await p.pullAttendance(sctx, { v: 1, scan: { ...(first.nextCursor as { scan: object }).scan, page: 5 } } as SyncCursor);
      expect(vanished).toMatchObject({ transactions: [], hasMore: true, meta: { restarted: true } });
      expect((vanished.nextCursor as { scan: { page: number; restarts: number } }).scan).toMatchObject({ page: 1, restarts: 1 });
    } finally { await shifting.close(); }
  });

  it('stops restarting after the cap and keeps paging', async () => {
    const p = provider();
    const scan = { from: '2026-02-01T12:00:00Z', to: '2026-03-03T12:00:00Z', page: 2, size: 10, count: 999, restarts: BIOTIME_MAX_SCAN_RESTARTS };
    const r = await p.pullAttendance(ctxFor(), { v: 1, scan });
    expect(r.hasMore).toBe(true);
    expect((r.nextCursor as { scan: { page: number; count: number } }).scan).toMatchObject({ page: 3, count: 48 });
  });

  it('does not depend on the server honouring the page size (follows `next`)', async () => {
    const odd = await createMockBioTimeServer({ username: USER, password: PASS, transactions: fixtures(), terminals: [bioTimeTerminalFixture()], forcedPageSize: 7, order: '-punch_time', now: () => NOW.getTime() });
    try {
      const { pages, ids } = await pullAll(provider(), ctxFor({}, odd));
      expect(pages).toHaveLength(7);
      expect(new Set(ids).size).toBe(48);
    } finally { await odd.close(); }
  });

  it('restricts to one terminal when terminalSn is set', async () => {
    server.transactions.push({ ...bioTimeTransactionFixtures(1, '2026-03-02 10:30:00', 'OTHER-SN', 700)[0]! });
    const all = await pullAll(provider(), ctxFor());
    expect(all.ids).toContain('700');
    const one = await pullAll(provider(), ctxFor({ config: { terminalSn: SN } }));
    expect(one.ids).not.toContain('700');
    expect(server.requests.filter((r) => r.path === '/iclock/api/transactions/').at(-1)!.query['terminal_sn']).toBe(SN);
  });

  it('skips unattributable rows instead of failing the page', async () => {
    server.transactions.push({ ...bioTimeTransactionFixtures(1, '2026-03-02 10:30:00', SN, 800)[0]!, emp_code: '' });
    const all = await pullAll(provider(), ctxFor());
    expect(all.ids).not.toContain('800');
    expect(all.pages.some((pg) => (pg.meta?.['skipped'] as { noIdentity?: number } | undefined)?.noIdentity === 1)).toBe(true);
  });

  it('a garbage cursor is INVALID_CONFIG(invalid_cursor) before any request', async () => {
    const ctx = ctxFor();
    const err = await expectCode(() => provider().pullAttendance(ctx, { bogus: 'cursor' }), 'INVALID_CONFIG');
    expect(err.details?.['reason']).toBe(BIOTIME_INVALID_CURSOR_REASON);
    expect(ctx.acquireCalls.count).toBe(0);
  });
});

describe('zkteco_biotime auth lifecycle and error mapping', () => {
  it('re-logs in transparently when the cached token is refused', async () => {
    const p = provider();
    const ctx = ctxFor();
    await p.getDeviceInfo(ctx);
    server.expireTokens();
    server.requests.length = 0;
    await p.getDeviceInfo(ctx);
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /iclock/api/terminals/', 'POST /jwt-api-token-auth/', 'GET /iclock/api/terminals/']);
  });

  it('refreshes a JWT before its exp claim without waiting for a 401', async () => {
    let now = NOW.getTime();
    const srv = await createMockBioTimeServer({ username: USER, password: PASS, terminals: [bioTimeTerminalFixture()], jwtTtlSeconds: 300, now: () => now });
    try {
      const p = provider({ clock: () => new Date(now) });
      const ctx = ctxFor({}, srv);
      await p.getDeviceInfo(ctx);
      now += 250_000; // inside the 60 s refresh margin
      await p.getDeviceInfo(ctx);
      expect(srv.requests.map((r) => r.path)).toEqual(['/jwt-api-token-auth/', '/iclock/api/terminals/', '/jwt-api-token-auth/', '/iclock/api/terminals/']);
    } finally { await srv.close(); }
  });

  it('a changed password never reuses the old token', async () => {
    const p = provider();
    await p.getDeviceInfo(ctxFor());
    server.requests.length = 0;
    await expectCode(() => p.getDeviceInfo(ctxFor({ credentials: { password: 'changed-password' } })), 'AUTH_FAILED');
    expect(server.requests.map((r) => r.path)).toEqual(['/jwt-api-token-auth/']);
  });

  it('a freshly issued token that is refused is AUTH_FAILED (no login loop)', async () => {
    server.failNext({ status: 403, path: '/iclock/api/terminals/' });
    await expectCode(() => provider().getDeviceInfo(ctxFor()), 'AUTH_FAILED');
    expect(server.requests.filter((r) => r.path === '/jwt-api-token-auth/')).toHaveLength(1);
  });

  it('maps 429 → RATE_LIMITED (Retry-After), 5xx → retryable, API error codes → VENDOR_ERROR', async () => {
    const p = provider();
    await p.getDeviceInfo(ctxFor()); // warm the token
    server.failNext({ status: 429, path: '/iclock/api/transactions/', headers: { 'retry-after': '7' } });
    const rl = await expectCode(() => p.pullAttendance(ctxFor(), null), 'RATE_LIMITED');
    expect(rl).toMatchObject({ retryable: true, retryAfterMs: 7000 });
    server.failNext({ status: 500, path: '/iclock/api/transactions/' });
    expect((await expectCode(() => p.pullAttendance(ctxFor(), null), 'VENDOR_ERROR')).retryable).toBe(true);
    server.failNext({ status: 503, path: '/iclock/api/transactions/' });
    expect((await expectCode(() => p.pullAttendance(ctxFor(), null), 'DEVICE_OFFLINE')).retryable).toBe(true);
    server.failNext({ status: 200, path: '/iclock/api/transactions/', body: { code: 1, msg: 'license expired', data: [] } });
    await expectCode(() => p.pullAttendance(ctxFor(), null), 'VENDOR_ERROR');
    server.failNext({ status: 200, path: '/iclock/api/transactions/', body: '<html>proxy</html>' });
    const shape = await expectCode(() => p.pullAttendance(ctxFor(), null), 'VENDOR_ERROR');
    expect(shape.retryable).toBe(true); // never PROTOCOL_ERROR / INVALID_CONFIG: those would rewind the cursor
  });

  it('missing or unsafe configuration → INVALID_CONFIG; https only outside development', async () => {
    const p = provider();
    await expectCode(() => p.getDeviceInfo(ctxFor({ config: { baseUrl: '' } })), 'INVALID_CONFIG');
    await expectCode(() => p.getDeviceInfo(ctxFor({ config: { username: '' } })), 'INVALID_CONFIG');
    await expectCode(() => p.getDeviceInfo(ctxFor({ credentials: {} })), 'INVALID_CONFIG');
    await expectCode(() => p.pullAttendance(ctxFor({ timezone: 'Mars/Olympus' }), null), 'INVALID_CONFIG');
    const prod = new ZKBioTimeProvider({ clock });
    await expectCode(() => prod.getDeviceInfo(ctxFor()), 'INVALID_CONFIG'); // http:// refused
    const ctx = ctxFor({ config: { baseUrl: server.baseUrl.replace('http://', 'https://') } });
    await expectCode(() => prod.getDeviceInfo(ctx), 'INVALID_CONFIG'); // https to a loopback address refused by the egress guard
    const r = await prod.testConnection(ctx);
    expect(r.ok).toBe(false);
  });
});

describe('zkteco_biotime employees', () => {
  it('lists employees page by page without ever returning device passwords', async () => {
    server.employees.splice(0, server.employees.length,
      ...Array.from({ length: 5 }, (_, i) => ({ id: i + 1, emp_code: `E${i + 1}`, first_name: `First${i + 1}`, last_name: 'Last', card_no: i === 0 ? '12345' : '', device_password: '9999', department: 1, area: [2], dev_privilege: i === 4 ? 14 : 0 })));
    const p = provider();
    const ctx = ctxFor({ config: { pageSize: 2 } });
    const first = await p.listEmployees(ctx, null);
    expect(first.nextCursor).toBe('page:2');
    expect(first.employees[0]).toEqual({ deviceUserId: 'E1', name: 'First1 Last', cardNumber: '12345', pin: null, privilege: 'user', enabled: true, photoUrl: null, extra: { biotimeId: 1, departmentId: 1, areaIds: [2] } });
    const second = await p.listEmployees(ctx, first.nextCursor);
    const third = await p.listEmployees(ctx, second.nextCursor);
    expect(third).toMatchObject({ nextCursor: null, employees: [{ deviceUserId: 'E5', privilege: 'admin' }] });
    expect(JSON.stringify([first, second, third])).not.toContain('9999');
    await expectCode(() => p.listEmployees(ctx, 'offset:3'), 'INVALID_CONFIG');
  });

  it('creates, updates (exact emp_code match) and deletes employees', async () => {
    server.employees.splice(0, server.employees.length, { id: 1, emp_code: '100', first_name: 'Other', last_name: '', card_no: '', device_password: '', department: 1, area: [2], dev_privilege: 0 });
    const p = provider();
    const ctx = ctxFor();
    const emp = { deviceUserId: '10', name: 'سالم البلوشي', cardNumber: '0012345', pin: '4321', privilege: 'user' as const, enabled: true, photoUrl: null, extra: {} };
    const created = await p.upsertEmployee(ctx, emp);
    expect(created).toMatchObject({ ok: true, deviceUserId: '10', details: { created: true } });
    const post = server.requests.find((r) => r.method === 'POST' && r.path === '/personnel/api/employees/')!;
    expect(post.body).toEqual({ emp_code: '10', first_name: 'سالم البلوشي', last_name: '', card_no: '0012345', device_password: '4321', department: 1, area: [2] });
    expect(server.employees.find((e) => e.emp_code === '100')!.first_name).toBe('Other'); // "10" is not "100"

    const updated = await p.upsertEmployee(ctx, { ...emp, name: 'Salim', cardNumber: null, pin: null });
    expect(updated.details).toMatchObject({ created: false });
    const patch = server.requests.find((r) => r.method === 'PATCH')!;
    expect(patch.path).toMatch(/^\/personnel\/api\/employees\/\d+\/$/);
    expect(patch.body).toEqual({ first_name: 'Salim', last_name: '', card_no: '' });
    expect(server.employees.find((e) => e.emp_code === '10')).toMatchObject({ first_name: 'Salim', card_no: '', device_password: '4321' });

    expect(await p.deleteEmployee(ctx, '10')).toMatchObject({ ok: true, deviceUserId: '10' });
    expect(server.employees.map((e) => e.emp_code)).toEqual(['100']);
    await expectCode(() => p.deleteEmployee(ctx, '10'), 'NOT_FOUND');
    expect(ctx.acquireCalls.count).toBe(server.requests.length);
  });

  it('refuses what the API cannot do honestly', async () => {
    const p = provider();
    const base = { deviceUserId: 'X1', name: 'X', cardNumber: null, pin: null, privilege: 'user' as const, enabled: true, photoUrl: null, extra: {} };
    await expectCode(() => p.upsertEmployee(ctxFor({ config: { departmentId: undefined } }), base), 'INVALID_CONFIG');
    await expectCode(() => p.upsertEmployee(ctxFor({ config: { areaId: 'abc' } }), base), 'INVALID_CONFIG');
    await expectCode(() => p.upsertEmployee(ctxFor(), { ...base, enabled: false }), 'UNSUPPORTED');
    await expectCode(() => p.upsertEmployee(ctxFor(), { ...base, privilege: 'admin' }), 'UNSUPPORTED');
    server.failNext({ status: 400, path: '/personnel/api/employees/', body: { emp_code: ['bad'] } });
    const e = await expectCode(() => p.deleteEmployee(ctxFor(), 'X1'), 'VENDOR_ERROR');
    expect(e.retryable).toBe(false);
  });
});

describeProviderConformance('zkteco_biotime', () => ({
  provider: new ZKBioTimeProvider({ allowPrivateHosts: true, clock }),
  ctx: ctxFor({ config: { pageSize: 10, lateArrivalHours: 1 } }),
}), { describe, it });
