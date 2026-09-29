import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rawTransactionSchema } from '@flowza/contracts';
import { describeProviderConformance } from '../../conformance.js';
import { createTestProviderContext } from '../../testing.js';
import { ProviderError, type AttendancePullResult, type ProviderContext, type SyncCursor } from '../../types.js';
import { ANVIZ_CROSSCHEX_CLOUD_DEFINITION } from './definition.js';
import { createMockCrossChexServer, crossChexRecordFixtures, isLoginRequest, isRecordRequest, type MockCrossChexServer } from './mock-server.js';
import {
  AnvizCrossChexCloudProvider, classifyCrossChexError, CROSSCHEX_OVERLAP_MS, crossChexRegionUrl, mapCrossChexCheckType, mapCrossChexRecord, parseCrossChexCursor,
  type AnvizCrossChexProviderOptions,
} from './provider.js';

const NOW = new Date('2026-09-20T12:00:00.000Z');
const clock = (): Date => NOW;
const H = 3600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

let server: MockCrossChexServer;
let confServer: MockCrossChexServer;

function ctxFor(s: MockCrossChexServer = server, overrides: Partial<ProviderContext> = {}): ProviderContext & { acquireCalls: { count: number } } {
  return createTestProviderContext({ config: { apiKey: s.apiKey, region: 'us' }, credentials: { apiSecret: s.apiSecret }, ...overrides });
}
const providerFor = (s: MockCrossChexServer = server, extra: Partial<AnvizCrossChexProviderOptions> = {}): AnvizCrossChexCloudProvider =>
  new AnvizCrossChexCloudProvider({ allowPrivateHosts: true, baseUrlOverride: s.baseUrl, clock, ...extra });

async function expectCode(p: Promise<unknown>, code: string): Promise<ProviderError> {
  try { await p; } catch (e) {
    expect(ProviderError.is(e)).toBe(true);
    expect((e as ProviderError).code).toBe(code);
    return e as ProviderError;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

beforeAll(async () => {
  server = await createMockCrossChexServer({ now: clock, timezone: 'Asia/Muscat' });
  confServer = await createMockCrossChexServer({
    now: clock,
    records: [...crossChexRecordFixtures(3, iso(NOW.getTime() - 20 * 24 * H), {}, 'old'), ...crossChexRecordFixtures(230, iso(NOW.getTime() - 5 * H), {}, 'new')],
  });
});
afterAll(async () => { await server.close(); await confServer.close(); });
beforeEach(() => {
  server.requests.length = 0;
  server.records.length = 0;
  server.rejectAllTokens = false;
  server.apiSecret = 'as_super_secret_abcdef';
});

describe('anviz_crosschex_cloud definition', () => {
  it('declares only what the research supports', () => {
    const d = ANVIZ_CROSSCHEX_CLOUD_DEFINITION;
    expect(d).toMatchObject({ key: 'anviz_crosschex_cloud', vendor: 'Anviz', integrationType: 'VENDOR_CLOUD_PULL', status: 'beta', verificationStatus: 'REPORTED' });
    expect(d.capabilities).toEqual({
      attendancePull: true, attendancePush: false, employeePush: false, employeePull: false, employeeDelete: false,
      fingerprint: false, face: false, card: false, pin: false, deviceStatus: false, remoteRestart: false, webhooks: false, devicePush: false, biometricTemplatePush: false,
    });
    expect(d.secretFields).toEqual(['apiSecret']);
    expect(d.configSchema.fields.map((f) => f.key)).toEqual(['apiKey', 'apiSecret', 'region', 'deviceSerial']);
    expect(d.configSchema.fields.find((f) => f.key === 'region')).toMatchObject({ type: 'select', options: ['us', 'eu', 'ap'], default: 'us' });
    expect(new AnvizCrossChexCloudProvider().restart).toBeUndefined();
    expect(new AnvizCrossChexCloudProvider().handleWebhook).toBeUndefined();
  });
});

describe('anviz_crosschex_cloud mapping', () => {
  it('maps a record: uuid as transaction id, workno as identity, offset times as-is, allowlisted payload without names', () => {
    const [rec] = crossChexRecordFixtures(1, '2026-09-20T04:00:00Z');
    const { transaction } = mapCrossChexRecord({ ...rec!, checktype: 'Check In', employee: { workno: ' 42 ' } }, 'Asia/Muscat');
    expect(rawTransactionSchema.safeParse(transaction).success).toBe(true);
    expect(transaction).toMatchObject({ providerTransactionId: 'r-000001', deviceEmployeeId: '42', punchedAt: '2026-09-20T04:00:00Z', deviceLocalTime: '2026-09-20T04:00:00+00:00', verificationMethod: 'unknown', direction: 'in' });
    expect(transaction!.rawPayload).toEqual({ uuid: 'r-000001', checktime: '2026-09-20T04:00:00+00:00', checktype: 'Check In', workno: '42', deviceSerial: 'CXC00001', deviceName: 'Main gate' });
    expect(JSON.stringify(transaction!.rawPayload)).not.toMatch(/Person|first_name|last_name/);
  });

  it('reads times without an offset in the device timezone and keeps them verbatim', () => {
    const at = (checktime: string, tz = 'Asia/Muscat') => mapCrossChexRecord({ checktime, employee: { workno: '1' } }, tz).transaction;
    expect(at('2026-09-20 08:00:00')).toMatchObject({ punchedAt: '2026-09-20T04:00:00Z', deviceLocalTime: '2026-09-20 08:00:00', providerTransactionId: null });
    expect(at('2026-09-20T08:00:00')!.punchedAt).toBe('2026-09-20T04:00:00Z');
    expect(at('2026-09-20T08:00:00+04:00', 'UTC')!.punchedAt).toBe('2026-09-20T04:00:00Z');
    expect(at('2026-09-20T04:00:00.000Z')!.punchedAt).toBe('2026-09-20T04:00:00Z');
  });

  it('skips unattributable or unreadable records instead of inventing data', () => {
    expect(mapCrossChexRecord({ checktime: '2026-09-20 08:00:00', employee: null }, 'UTC')).toEqual({ transaction: null, reason: 'no_identity' });
    expect(mapCrossChexRecord({ checktime: 'yesterday', employee: { workno: '1' } }, 'UTC')).toEqual({ transaction: null, reason: 'bad_time' });
  });

  it('maps only unambiguous check types; numeric codes stay unknown', () => {
    expect(mapCrossChexCheckType('check_out')).toBe('out');
    expect(mapCrossChexCheckType('IN')).toBe('in');
    expect(mapCrossChexCheckType('Break Start')).toBe('break_out');
    expect(mapCrossChexCheckType('0')).toBe('unknown');
    expect(mapCrossChexCheckType('1')).toBe('unknown');
    expect(mapCrossChexCheckType(null)).toBe('unknown');
  });

  it('classifies vendor exceptions by keyword without echoing vendor text', () => {
    expect(classifyCrossChexError('TOKEN_EXPIRED', 'token has expired', 'x')).toEqual({ kind: 'token' });
    expect(classifyCrossChexError('ERROR', 'Invalid token', 'x')).toEqual({ kind: 'token' });
    const auth = classifyCrossChexError('API_KEY_ERROR', 'secret s3cr3t is wrong', 'x');
    expect(auth.kind === 'error' && auth.error.code).toBe('AUTH_FAILED');
    expect(auth.kind === 'error' && auth.error.message).not.toContain('s3cr3t');
    const rate = classifyCrossChexError('FREQUENCY_LIMIT', null, 'x');
    expect(rate.kind === 'error' && rate.error).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    const param = classifyCrossChexError('PARAM_ERROR', null, 'x');
    expect(param.kind === 'error' && param.error).toMatchObject({ code: 'VENDOR_ERROR', retryable: false });
    const other = classifyCrossChexError('<script>', 'boom', 'x');
    expect(other.kind === 'error' && other.error).toMatchObject({ code: 'VENDOR_ERROR', retryable: true, details: { vendorErrorType: 'script' } });
  });

  it('validates cursors and flags foreign ones as invalid_cursor', () => {
    expect(parseCrossChexCursor(null)).toBeNull();
    expect(parseCrossChexCursor({})).toBeNull();
    expect(parseCrossChexCursor({ v: 1, begin: '2026-09-01T00:00:00.000Z', page: 1 })).toEqual({ begin: Date.parse('2026-09-01T00:00:00Z'), page: 1 });
    expect(parseCrossChexCursor({ v: 1, begin: '2026-09-01T00:00:00.000Z', end: '2026-09-02T00:00:00.000Z', page: 3, perPage: 50 })).toMatchObject({ page: 3, perPage: 50 });
    for (const bad of [
      { bogus: 'cursor' }, { lastSeq: 3 }, { v: 2, begin: '2026-09-01T00:00:00Z', page: 1 }, { v: 1, begin: 'nope', page: 1 },
      { v: 1, begin: '2026-09-01T00:00:00Z', page: 2 }, // a page > 1 without a pinned window
      { v: 1, begin: '2026-09-02T00:00:00Z', end: '2026-09-01T00:00:00Z', page: 1 }, // end before begin
      { v: 1, begin: '2026-08-01T00:00:00Z', end: '2026-09-01T00:00:00Z', page: 1 }, // window wider than 7 days
      { v: 1, begin: '2026-09-01T00:00:00Z', page: 1, extra: true }, { v: 1, begin: '2026-09-01T00:00:00Z', page: 1, perPage: 500 },
    ]) {
      let err: unknown;
      try { parseCrossChexCursor(bad as SyncCursor); } catch (e) { err = e; }
      expect(ProviderError.is(err) && err.code === 'INVALID_CONFIG' && err.details?.['reason'] === 'invalid_cursor', JSON.stringify(bad)).toBe(true);
    }
  });
});

describe('anviz_crosschex_cloud config', () => {
  it('builds the region URL and never takes a base URL from the device config', () => {
    expect(crossChexRegionUrl('eu')).toBe('https://api.eu.crosschexcloud.com/');
    const p = new AnvizCrossChexCloudProvider();
    const cfg = p.resolveConfig(createTestProviderContext({ config: { apiKey: 'k', region: 'EU', baseUrl: 'https://evil.example.com' }, endpointUrl: 'https://evil.example.com', credentials: { apiSecret: 's' } }));
    expect(cfg).toMatchObject({ baseUrl: 'https://api.eu.crosschexcloud.com', region: 'eu', apiKey: 'k', apiSecret: 's' });
    expect(p.resolveConfig(createTestProviderContext({ config: { apiKey: 'k' }, credentials: { apiSecret: 's' } })).baseUrl).toBe('https://api.us.crosschexcloud.com');
  });

  it('rejects missing credentials and unknown regions with INVALID_CONFIG', async () => {
    const p = providerFor();
    await expectCode(p.pullAttendance(ctxFor(server, { config: { region: 'us' } }), null), 'INVALID_CONFIG');
    await expectCode(p.pullAttendance(ctxFor(server, { credentials: {} }), null), 'INVALID_CONFIG');
    const bad = await expectCode(p.pullAttendance(ctxFor(server, { config: { apiKey: server.apiKey, region: 'me' } }), null), 'INVALID_CONFIG');
    expect(bad.details).toMatchObject({ field: 'region' });
    await expectCode(p.getDeviceInfo(ctxFor(server, { config: { region: 'cn' } })), 'INVALID_CONFIG');
    await expectCode(p.pullAttendance(ctxFor(server, { timezone: 'Mars/Olympus' }), null), 'INVALID_CONFIG');
    expect(server.requests).toHaveLength(0);
  });

  it('is https-only unless private egress is explicitly allowed', async () => {
    const p = new AnvizCrossChexCloudProvider({ baseUrlOverride: server.baseUrl, clock });
    await expectCode(p.pullAttendance(ctxFor(), null), 'INVALID_CONFIG');
    const res = await p.testConnection(ctxFor());
    expect(res).toMatchObject({ ok: false, details: { code: 'INVALID_CONFIG' } });
    expect(server.requests).toHaveLength(0);
  });
});

describe('anviz_crosschex_cloud against the mock cloud', () => {
  it('testConnection logs in, makes one authenticated call and reports ok', async () => {
    server.records.push(...crossChexRecordFixtures(3, iso(NOW.getTime() - 2 * H)));
    const ctx = ctxFor(server, { config: { apiKey: server.apiKey, region: 'us', deviceSerial: 'CXC00001' } });
    const res = await providerFor().testConnection(ctx);
    expect(res).toMatchObject({ ok: true, deviceInfo: { model: 'CrossChex Cloud', serialNumber: 'CXC00001' }, details: { region: 'us', recordsLast24h: 3, deviceSerialFilter: 'CXC00001' } });
    expect(ctx.acquireCalls.count).toBe(2);
    const [login, records] = server.requests;
    expect(isLoginRequest(login!)).toBe(true);
    expect(login!.authorize).toBeNull();
    expect(login!.payload).toEqual({ api_key: server.apiKey, api_secret: server.apiSecret });
    expect(isRecordRequest(records!)).toBe(true);
    expect(records!.header).toMatchObject({ version: '1.0', timestamp: NOW.toISOString() });
    expect(records!.header['requestId']).toMatch(/^[0-9a-f-]{36}$/);
    expect(records!.header['requestId']).not.toBe(login!.header['requestId']);
    expect(records!.authorize).toEqual({ type: 'token', token: server.issuedTokens.at(-1) });
    expect(records!.payload).toEqual({ begin_time: '2026-09-19T12:00:00+00:00', end_time: '2026-09-20T12:00:00+00:00', order: 'asc', page: 1, per_page: 1 });
    const text = JSON.stringify(res);
    for (const t of server.issuedTokens) expect(text).not.toContain(t);
    expect(text).not.toContain(server.apiSecret);
  });

  it('testConnection reports AUTH_FAILED for a wrong secret without leaking it', async () => {
    const res = await providerFor().testConnection(ctxFor(server, { credentials: { apiSecret: 'wrong-secret-value' } }));
    expect(res).toMatchObject({ ok: false, details: { code: 'AUTH_FAILED', retryable: false } });
    expect(JSON.stringify(res)).not.toContain('wrong-secret-value');
    expect(server.requests.filter(isRecordRequest)).toHaveLength(0);
  });

  it('getDeviceInfo answers from configuration; getDeviceStatus and employee operations are unsupported', async () => {
    const p = providerFor();
    const ctx = ctxFor(server, { config: { apiKey: server.apiKey, region: 'ap', deviceSerial: 'CXC9' }, credentials: {} });
    expect(await p.getDeviceInfo(ctx)).toEqual({ model: 'CrossChex Cloud', serialNumber: 'CXC9', extra: { region: 'ap' } });
    expect(await p.getCapabilities(ctx)).toEqual(ANVIZ_CROSSCHEX_CLOUD_DEFINITION.capabilities);
    await expectCode(p.getDeviceStatus(ctxFor()), 'UNSUPPORTED');
    await expectCode(p.listEmployees(ctxFor(), null), 'UNSUPPORTED');
    await expectCode(p.upsertEmployee(ctxFor(), { deviceUserId: '1', name: 'A', privilege: 'user', enabled: true, extra: {} }), 'UNSUPPORTED');
    await expectCode(p.deleteEmployee(ctxFor(), '1'), 'UNSUPPORTED');
    expect(server.requests).toHaveLength(0);
    expect(ctx.acquireCalls.count).toBe(0);
  });

  it('pages through a sweep with a pinned window, caches the token and closes the sweep with an overlap', async () => {
    const start = NOW.getTime() - 20 * H;
    server.records.push(...crossChexRecordFixtures(250, iso(start)));
    const p = providerFor();
    const ctx = ctxFor();
    const since = iso(NOW.getTime() - 24 * H);

    const first = await p.pullAttendance(ctx, null, { since, pageSize: 100 });
    expect(first.transactions).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toEqual({ v: 1, begin: since, end: NOW.toISOString(), page: 2, perPage: 100 });
    expect(first.transactions[0]).toMatchObject({ providerTransactionId: 'r-000001', punchedAt: iso(start).replace('.000', ''), deviceEmployeeId: '100' });
    for (const t of first.transactions) expect(rawTransactionSchema.safeParse(t).success).toBe(true);

    const again = await p.pullAttendance(ctx, null, { since, pageSize: 100 });
    expect(again.nextCursor).toEqual(first.nextCursor);
    expect(again.transactions).toEqual(first.transactions);

    // A different pageSize mid-sweep must not shift offsets: the cursor's perPage wins.
    const second = await p.pullAttendance(ctx, first.nextCursor, { pageSize: 10 });
    expect(second.transactions).toHaveLength(100);
    expect(second.transactions[0]!.providerTransactionId).toBe('r-000101');
    const third = await p.pullAttendance(ctx, second.nextCursor);
    expect(third.transactions).toHaveLength(50);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toEqual({ v: 1, begin: iso(NOW.getTime() - CROSSCHEX_OVERLAP_MS), page: 1 });

    const recordCalls = server.requests.filter(isRecordRequest);
    expect(recordCalls.map((r) => r.payload['page'])).toEqual([1, 1, 2, 3]);
    expect(recordCalls.every((r) => r.payload['per_page'] === 100 && r.payload['end_time'] === '2026-09-20T12:00:00+00:00')).toBe(true);
    expect(server.requests.filter(isLoginRequest)).toHaveLength(1);
    expect(ctx.acquireCalls.count).toBe(server.requests.length);

    // The next sweep re-reads only the overlap: replays, cursor unchanged, no hasMore.
    const tail = await p.pullAttendance(ctx, third.nextCursor);
    expect(tail.hasMore).toBe(false);
    expect(tail.nextCursor).toEqual(third.nextCursor);
    const lastTwoHours = server.records.filter((r) => Date.parse(r.checktime) >= NOW.getTime() - CROSSCHEX_OVERLAP_MS).length;
    expect(tail.transactions).toHaveLength(lastTwoHours);
  });

  it('catches up on history in bounded windows and stops at the present', async () => {
    server.records.push(
      ...crossChexRecordFixtures(2, iso(NOW.getTime() - 29 * 24 * H), {}, 'a'),
      ...crossChexRecordFixtures(2, iso(NOW.getTime() - 10 * 24 * H), {}, 'b'),
      ...crossChexRecordFixtures(2, iso(NOW.getTime() - 3 * H), {}, 'c'),
    );
    const p = providerFor();
    const ctx = ctxFor();
    let cursor: SyncCursor | null = null;
    let res: AttendancePullResult;
    const ids: string[] = [];
    let pulls = 0;
    do {
      res = await p.pullAttendance(ctx, cursor);
      ids.push(...res.transactions.map((t) => t.providerTransactionId!));
      if (res.hasMore) expect(res.nextCursor).not.toEqual(cursor);
      cursor = res.nextCursor;
      pulls += 1;
    } while (res.hasMore && pulls < 20);
    expect(res.hasMore).toBe(false);
    expect(pulls).toBe(5); // 30 days in ≤ 7-day windows
    expect([...new Set(ids)].sort()).toEqual(['a-000001', 'a-000002', 'b-000001', 'b-000002', 'c-000001', 'c-000002']);
    for (const r of server.requests.filter(isRecordRequest)) {
      expect(Date.parse(String(r.payload['end_time'])) - Date.parse(String(r.payload['begin_time']))).toBeLessThanOrEqual(7 * 24 * H);
    }
  });

  it('converts offset-less checktimes from the device timezone and filters by device serial', async () => {
    server.records.push(
      { uuid: 'x1', checktime: '2026-09-20 09:30:00', checktype: 'in', device: { serial_number: 'CXC00001' }, employee: { workno: 7 } },
      { uuid: 'x2', checktime: '2026-09-20 10:30:00', checktype: 'out', device: { serial_number: 'OTHER' }, employee: { workno: 8 } },
      { uuid: 'x3', checktime: '2026-09-20 11:30:00', device: { serial_number: 'cxc00001' }, employee: null },
    );
    const ctx = ctxFor(server, { config: { apiKey: server.apiKey, deviceSerial: 'CXC00001' } });
    const res = await providerFor().pullAttendance(ctx, null, { since: iso(NOW.getTime() - 12 * H) });
    expect(res.transactions).toEqual([expect.objectContaining({ providerTransactionId: 'x1', deviceEmployeeId: '7', punchedAt: '2026-09-20T05:30:00Z', deviceLocalTime: '2026-09-20 09:30:00', direction: 'in' })]);
    expect(res.meta).toMatchObject({ received: 3, skipped: { otherDevice: 1, noIdentity: 1 } });
  });

  it('logs in again transparently when the token expires (vendor exception or HTTP 401)', async () => {
    server.records.push(...crossChexRecordFixtures(3, iso(NOW.getTime() - H)));
    const p = providerFor();
    const ctx = ctxFor();
    const since = iso(NOW.getTime() - 2 * H);
    await p.pullAttendance(ctx, null, { since });
    server.expireTokens();
    const res = await p.pullAttendance(ctx, null, { since });
    expect(res.transactions).toHaveLength(3);
    expect(server.requests.filter(isLoginRequest)).toHaveLength(2);

    server.failNext({ status: 401, nameSpace: 'attendance.record' });
    const res2 = await p.pullAttendance(ctx, null, { since });
    expect(res2.transactions).toHaveLength(3);
    expect(server.requests.filter(isLoginRequest)).toHaveLength(3);
    expect(ctx.acquireCalls.count).toBe(server.requests.length);
  });

  it('gives up with AUTH_FAILED when a fresh token is rejected too (one re-login only)', async () => {
    const p = providerFor();
    server.rejectAllTokens = true;
    const err = await expectCode(p.pullAttendance(ctxFor(), null), 'AUTH_FAILED');
    expect(err.retryable).toBe(false);
    expect(server.requests.filter(isLoginRequest)).toHaveLength(2);
    expect(server.requests.filter(isRecordRequest)).toHaveLength(2);
  });

  it('never reuses a token issued for a different secret', async () => {
    const p = providerFor();
    await p.pullAttendance(ctxFor(), null);
    server.apiSecret = 'rotated-secret';
    await p.pullAttendance(ctxFor(server, { credentials: { apiSecret: 'rotated-secret' } }), null);
    const logins = server.requests.filter(isLoginRequest);
    expect(logins.map((l) => l.payload['api_secret'])).toEqual(['as_super_secret_abcdef', 'rotated-secret']);
  });

  it('maps throttling and server failures to retryable provider errors', async () => {
    const p = providerFor();
    server.failNext({ status: 429, headers: { 'retry-after': '7' } });
    const rl = await expectCode(p.pullAttendance(ctxFor(), null), 'RATE_LIMITED');
    expect(rl).toMatchObject({ retryable: true, retryAfterMs: 7000 });
    server.failNext({ status: 500, nameSpace: 'attendance.record' });
    expect((await expectCode(p.pullAttendance(ctxFor(), null), 'VENDOR_ERROR')).retryable).toBe(true);
    server.failNext({ status: 503 });
    expect((await expectCode(p.pullAttendance(ctxFor(), null), 'DEVICE_OFFLINE')).retryable).toBe(true);
    server.exceptionNext({ type: 'FREQUENCY_LIMIT', message: 'too many requests', nameSpace: 'attendance.record' });
    expect((await expectCode(p.pullAttendance(ctxFor(), null), 'RATE_LIMITED')).retryable).toBe(true);
    server.failNext({ status: 200, body: { hello: 'world' }, nameSpace: 'attendance.record' });
    expect((await expectCode(p.pullAttendance(ctxFor(), null), 'VENDOR_ERROR')).retryable).toBe(true);
    server.failNext({ status: 200, body: { header: { nameSpace: 'attendance.record', nameAction: 'getrecord' }, payload: { count: 'many', list: 3 } }, nameSpace: 'attendance.record' });
    await expectCode(p.pullAttendance(ctxFor(), null), 'VENDOR_ERROR');
  });

  it('refuses an unparseable cursor before calling the vendor', async () => {
    const err = await expectCode(providerFor().pullAttendance(ctxFor(), { lastSeq: 5 }), 'INVALID_CONFIG');
    expect(err.details).toMatchObject({ reason: 'invalid_cursor' });
    expect(server.requests).toHaveLength(0);
  });
});

describeProviderConformance('anviz_crosschex_cloud', () => ({
  provider: providerFor(confServer),
  ctx: ctxFor(confServer),
  maxPages: 20,
}), { describe, it });
