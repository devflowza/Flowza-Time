import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rawTransactionSchema } from '@flowza/contracts';
import { describeProviderConformance } from '../../conformance.js';
import { createTestProviderContext } from '../../testing.js';
import { ProviderError, type ProviderContext } from '../../types.js';
import { FLOWZA_FINANCE_DEFINITION } from './definition.js';
import { FINANCE_STATE_BY_EVENT_TYPE, financeCursorFromTime, isPrivateHostname, mapFinancePunch, mapFinanceState, mapFinanceVerify, parseFinanceCursor, resolveFinanceBaseUrl, toFinanceVerify } from './mapping.js';
import { createMockFinanceServer, encodeFinanceCursor, financePunchFixtures, type MockFinanceServer } from './mock-finance-server.js';
import { FlowzaFinanceProvider, hasFinancePush } from './provider.js';

let server: MockFinanceServer;
const SERIAL = 'FLOWZA-TIME-ACME';
const TOKEN = 'tok_super_secret_0123456789';

function ctxFor(overrides: Partial<ProviderContext> = {}): ProviderContext & { acquireCalls: { count: number } } {
  return createTestProviderContext({
    serialNumber: SERIAL,
    config: { baseUrl: server.baseUrl, deviceSerial: SERIAL, direction: 'both', pinKey: 'employee_number', pollMinutes: 10 },
    credentials: { token: TOKEN },
    ...overrides,
  });
}
const provider = () => new FlowzaFinanceProvider({ allowPrivateHosts: true });

beforeAll(async () => { server = await createMockFinanceServer({ serial: SERIAL, token: TOKEN, punches: financePunchFixtures(7) }); });
afterAll(async () => { await server.close(); });
beforeEach(() => { server.requests.length = 0; });

describe('flowza_finance mapping', () => {
  it('maps Finance verify vocabularies (incl. ADMS codes) and states', () => {
    expect(mapFinanceVerify('face')).toBe('face');
    expect(mapFinanceVerify('Fingerprint')).toBe('fingerprint');
    expect(mapFinanceVerify('1')).toBe('fingerprint');
    expect(mapFinanceVerify('15')).toBe('face');
    expect(mapFinanceVerify('rfid')).toBe('card');
    expect(mapFinanceVerify('selfie')).toBe('mobile');
    expect(mapFinanceVerify(null)).toBe('unknown');
    expect(mapFinanceVerify('telepathy')).toBe('unknown');
    expect(mapFinanceState('check_in')).toBe('in');
    expect(mapFinanceState('OUT')).toBe('out');
    expect(mapFinanceState('0')).toBe('in');
    expect(mapFinanceState('1')).toBe('out');
    expect(mapFinanceState('break_out')).toBe('break_out');
    expect(mapFinanceState('overtime_in')).toBe('overtime_in');
    expect(mapFinanceState(undefined)).toBe('unknown');
    expect(FINANCE_STATE_BY_EVENT_TYPE.PUNCH_IN).toBe('check_in');
    expect(FINANCE_STATE_BY_EVENT_TYPE.PUNCH).toBeNull();
    expect(toFinanceVerify('unknown')).toBeNull();
    expect(toFinanceVerify('face')).toBe('face');
  });

  it('maps a Finance punch to a RawTransaction with an allowlisted payload, preferring employee_number over pin', () => {
    const [p] = financePunchFixtures(1, '2026-03-01T04:00:00.000Z');
    const { transaction } = mapFinancePunch(p!, SERIAL);
    expect(transaction).not.toBeNull();
    expect(rawTransactionSchema.safeParse(transaction).success).toBe(true);
    expect(transaction!.providerTransactionId).toBe(p!.id);
    expect(transaction!.deviceEmployeeId).toBe('E0100');
    expect(transaction!.punchedAt).toBe('2026-03-01T04:00:00Z');
    expect(transaction!.deviceLocalTime).toBe('2026-03-01 08:00:00');
    expect(transaction!.verificationMethod).toBe('face');
    expect(transaction!.direction).toBe('in');
    expect(transaction!.rawPayload).toMatchObject({ financeId: p!.id, employeeNumber: 'E0100', pin: '100', source: 'mobile', deviceSerial: 'FIN-MOBILE', geofenceVerdict: 'inside', geoFlagged: false, lat: 23.588, connectorSerial: SERIAL });
    expect(Object.keys(transaction!.rawPayload)).not.toContain('token');
  });

  it('reads Finance times in every rendering PostgREST or Postgres produce, always as UTC', () => {
    const [p] = financePunchFixtures(1);
    const at = (time_utc: string) => mapFinancePunch({ ...p!, time_utc }, SERIAL).transaction?.punchedAt;
    expect(at('2026-09-27T04:58:31+00:00')).toBe('2026-09-27T04:58:31Z');
    expect(at('2026-09-27T06:02:49.9175+00:00')).toBe('2026-09-27T06:02:49.917Z');
    expect(at('2026-09-27T08:58:31+04:00')).toBe('2026-09-27T04:58:31Z');
    expect(at('2026-09-27 04:58:31+00')).toBe('2026-09-27T04:58:31Z');
    expect(at('2026-09-27T04:58:31')).toBe('2026-09-27T04:58:31Z'); // no offset: UTC by contract, never the host's zone
  });

  it('falls back to the device PIN and skips rows without any identity or with a bad time', () => {
    const [p] = financePunchFixtures(1);
    expect(mapFinancePunch({ ...p!, employee_number: null }, SERIAL).transaction?.deviceEmployeeId).toBe('100');
    expect(mapFinancePunch({ ...p!, employee_number: null, pin: '  ' }, SERIAL)).toEqual({ transaction: null, reason: 'no_identity' });
    expect(mapFinancePunch({ ...p!, time_utc: 'yesterday' }, SERIAL)).toEqual({ transaction: null, reason: 'bad_time' });
    expect(mapFinancePunch({ ...p!, device_timezone: 'Mars/Olympus' }, SERIAL).transaction?.deviceLocalTime).toBeNull();
  });

  it('parses only cursors it issued and synthesises a rewind cursor in Finance format', () => {
    expect(parseFinanceCursor(null)).toBeUndefined();
    expect(parseFinanceCursor({})).toBeUndefined();
    expect(parseFinanceCursor({ since: 'abc_DEF-123' })).toBe('abc_DEF-123');
    expect(() => parseFinanceCursor({ bogus: 'cursor' })).toThrow(ProviderError);
    expect(() => parseFinanceCursor({ since: 'has spaces!' })).toThrow(ProviderError);
    expect(() => parseFinanceCursor({ since: 42 })).toThrow(ProviderError);
    const rewind = financeCursorFromTime('2026-03-01T04:03:00+04:00');
    expect(Buffer.from(rewind, 'base64url').toString('utf8')).toBe('2026-03-01T00:03:00.000Z|00000000-0000-0000-0000-000000000000');
    expect(() => financeCursorFromTime('not a time')).toThrow(ProviderError);
  });

  it('validates the base URL: https + public host by default, local hosts only when allowed', () => {
    expect(resolveFinanceBaseUrl(undefined)).toBe('https://ucjtxdmklhhhvayirwqe.supabase.co/functions/v1');
    expect(resolveFinanceBaseUrl('https://example.supabase.co/functions/v1/')).toBe('https://example.supabase.co/functions/v1');
    expect(() => resolveFinanceBaseUrl('http://example.supabase.co/functions/v1')).toThrow(/https/);
    expect(() => resolveFinanceBaseUrl('https://user:pw@example.supabase.co/functions/v1')).toThrow(/credentials/);
    expect(() => resolveFinanceBaseUrl('https://example.supabase.co/functions/v1?x=1')).toThrow(/query/);
    expect(() => resolveFinanceBaseUrl('https://127.0.0.1/functions/v1')).toThrow(/public host/);
    expect(() => resolveFinanceBaseUrl('https://10.1.2.3/functions/v1')).toThrow(/public host/);
    expect(() => resolveFinanceBaseUrl('https://finance.internal/functions/v1')).toThrow(/public host/);
    expect(() => resolveFinanceBaseUrl('https://intranet/functions/v1')).toThrow(/public host/);
    expect(() => resolveFinanceBaseUrl('not a url')).toThrow(ProviderError);
    expect(resolveFinanceBaseUrl('http://127.0.0.1:9999/functions/v1', { allowPrivateHosts: true })).toBe('http://127.0.0.1:9999/functions/v1');
    expect(isPrivateHostname('192.168.1.1')).toBe(true);
    expect(isPrivateHostname('172.20.0.5')).toBe(true);
    expect(isPrivateHostname('172.32.0.5')).toBe(false);
    expect(isPrivateHostname('[::1]')).toBe(true);
    expect(isPrivateHostname('fd00::1')).toBe(true);
    expect(isPrivateHostname('ucjtxdmklhhhvayirwqe.supabase.co')).toBe(false);
    expect(isPrivateHostname('8.8.8.8')).toBe(false);
  });
});

describe('flowza_finance provider', () => {
  it('has the expected definition: pull + status only, token secret, sensible defaults', () => {
    expect(FLOWZA_FINANCE_DEFINITION.key).toBe('flowza_finance');
    expect(FLOWZA_FINANCE_DEFINITION.capabilities.attendancePull).toBe(true);
    expect(FLOWZA_FINANCE_DEFINITION.capabilities.employeePush).toBe(false);
    expect(FLOWZA_FINANCE_DEFINITION.capabilities.devicePush).toBe(false);
    expect([...FLOWZA_FINANCE_DEFINITION.secretFields]).toEqual(['token']);
    expect(FLOWZA_FINANCE_DEFINITION.integrationType).toBe('VENDOR_CLOUD_PULL');
    expect(hasFinancePush(provider())).toBe(true);
  });

  it('refuses a public-host rule violation and missing credentials as INVALID_CONFIG without a network call', async () => {
    const strict = new FlowzaFinanceProvider();
    await expect(strict.pullAttendance(ctxFor(), null)).rejects.toMatchObject({ code: 'INVALID_CONFIG', retryable: false });
    await expect(provider().pullAttendance(ctxFor({ credentials: {} }), null)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(provider().pullAttendance(ctxFor({ config: { baseUrl: server.baseUrl }, serialNumber: null }), null)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(server.requests).toHaveLength(0);
  });

  it('pulls the first page, maps it, stores Finance\'s next_cursor and throttles once per request', async () => {
    const ctx = ctxFor();
    const r = await provider().pullAttendance(ctx, null, { pageSize: 3 });
    expect(r.transactions).toHaveLength(3);
    expect(r.hasMore).toBe(true);
    expect(r.nextCursor).toEqual({ since: encodeFinanceCursor(server.punches[2]!.time_utc, server.punches[2]!.id) });
    expect(r.meta).toMatchObject({ received: 3, limit: 3, connectorDeviceId: '22222222-2222-4222-8222-222222222222' });
    expect(ctx.acquireCalls.count).toBe(1);
    const sent = server.requests[0]!;
    expect(sent.path).toBe('attendance-export');
    expect(sent.body).toEqual({ device_serial: SERIAL, token: TOKEN, limit: 3 });
    expect(sent.headers['content-type']).toBe('application/json');
  });

  it('follows the cursor to the end, reports hasMore=false at the tail and keeps the cursor on an empty page', async () => {
    const ctx = ctxFor();
    const p = provider();
    const seen: string[] = [];
    let cursor: Record<string, unknown> | null = null;
    let pages = 0;
    for (;;) {
      const r = await p.pullAttendance(ctx, cursor, { pageSize: 3 });
      seen.push(...r.transactions.map((t) => t.providerTransactionId!));
      cursor = r.nextCursor;
      pages += 1;
      if (!r.hasMore || pages > 10) break;
    }
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    const tail = await p.pullAttendance(ctx, cursor, { pageSize: 3 });
    expect(tail.transactions).toHaveLength(0);
    expect(tail.hasMore).toBe(false);
    expect(tail.nextCursor).toEqual(cursor);
  });

  it('rewinds from opts.since when no cursor is stored, and ignores since when a cursor exists', async () => {
    const p = provider();
    const fromMinute4 = await p.pullAttendance(ctxFor(), null, { since: '2026-03-01T04:04:00Z' });
    expect(fromMinute4.transactions.map((t) => t.deviceEmployeeId)).toEqual(['E0104', 'E0105', 'E0106']);
    const stored = { since: encodeFinanceCursor(server.punches[5]!.time_utc, server.punches[5]!.id) };
    const fromCursor = await p.pullAttendance(ctxFor(), stored, { since: '2026-03-01T04:00:00Z' });
    expect(fromCursor.transactions.map((t) => t.deviceEmployeeId)).toEqual(['E0106']);
  });

  it('keeps the rewind position on an empty page and never follows has_more without an advancing cursor (loop bound)', async () => {
    const p = provider();
    const future = await p.pullAttendance(ctxFor(), null, { since: '2030-01-01T00:00:00Z' });
    expect(future.transactions).toHaveLength(0);
    expect(future.hasMore).toBe(false);
    expect(future.nextCursor).toEqual({ since: financeCursorFromTime('2030-01-01T00:00:00Z') }); // not {} = "from the beginning"
    // a Finance answering has_more=true with the cursor it was given: stop instead of re-reading the same page forever
    const stuck = encodeFinanceCursor(server.punches[0]!.time_utc, server.punches[0]!.id);
    server.failNext({ status: 200, body: { punches: [server.punches[1]], has_more: true, next_cursor: stuck, server_time: new Date().toISOString() } });
    const r = await p.pullAttendance(ctxFor(), { since: stuck });
    expect(r.transactions).toHaveLength(1);
    expect(r.hasMore).toBe(false);
    expect(r.nextCursor).toEqual({ since: stuck });
    // and an empty page that still claims has_more ends the loop as well
    server.failNext({ status: 200, body: { punches: [], has_more: true, next_cursor: null, server_time: new Date().toISOString() } });
    const empty = await p.pullAttendance(ctxFor(), { since: stuck });
    expect(empty).toMatchObject({ transactions: [], hasMore: false, nextCursor: { since: stuck } });
  });

  it('skips unattributable rows instead of failing the page', async () => {
    const local = await createMockFinanceServer({ serial: SERIAL, token: TOKEN, punches: [
      ...financePunchFixtures(2),
      { ...financePunchFixtures(1, '2026-03-01T05:00:00Z')[0]!, id: '00000000-0000-4000-8000-00000000ffff', employee_number: null, pin: null },
      { id: 'garbage-row', pin: '7', time_utc: 'nope' } as never,
      { id: 42, time_utc: '2026-03-01T06:00:00Z' } as never,
    ] });
    try {
      const r = await provider().pullAttendance(ctxFor({ config: { baseUrl: local.baseUrl, deviceSerial: SERIAL } }), null);
      expect(r.transactions).toHaveLength(2);
      expect(r.meta?.['skipped']).toEqual({ invalid: 1, noIdentity: 1, badTime: 1 });
    } finally { await local.close(); }
  });

  it('maps HTTP failures to ProviderError codes and never leaks the token', async () => {
    const p = provider();
    const ctx = ctxFor();
    server.failNext({ status: 401 });
    const auth = await p.pullAttendance(ctx, null).catch((e: unknown) => e);
    expect(auth).toMatchObject({ code: 'AUTH_FAILED', retryable: false });
    server.failNext({ status: 503, body: { error: 'upstream down' } });
    const vendor = await p.pullAttendance(ctx, null).catch((e: unknown) => e);
    expect(vendor).toMatchObject({ code: 'VENDOR_ERROR', retryable: true });
    expect((vendor as Error).message).toContain('503');
    server.failNext({ status: 429, headers: { 'retry-after': '7' } });
    const limited = await p.pullAttendance(ctx, null).catch((e: unknown) => e);
    expect(limited).toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterMs: 7000 });
    server.failNext({ status: 302, headers: { location: 'http://evil.example/steal' } });
    const redirect = await p.pullAttendance(ctx, null).catch((e: unknown) => e);
    expect(redirect).toMatchObject({ code: 'PROTOCOL_ERROR', retryable: false });
    server.failNext({ status: 404 });
    const missing = await p.pullAttendance(ctx, null).catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: 'INVALID_CONFIG' });
    server.failNext({ status: 400, body: { error: 'limit must be 1..1000' } });
    const bad = await p.pullAttendance(ctx, null).catch((e: unknown) => e);
    expect(bad).toMatchObject({ code: 'PROTOCOL_ERROR' });
    server.failNext({ status: 200, body: { punches: 'not-a-list' } });
    const shape = await p.pullAttendance(ctx, null).catch((e: unknown) => e);
    expect(shape).toMatchObject({ code: 'PROTOCOL_ERROR' });
    for (const e of [auth, vendor, limited, redirect, missing, bad, shape]) {
      expect(ProviderError.is(e)).toBe(true);
      expect(JSON.stringify({ m: (e as Error).message, d: (e as ProviderError).details })).not.toContain(TOKEN);
    }
  });

  it('turns an aborted request into TIMEOUT and an unreachable host into a retryable VENDOR_ERROR', async () => {
    const p = provider();
    const ac = new AbortController();
    server.failNext({ status: 200, hang: true });
    const pending = p.pullAttendance(ctxFor({ signal: ac.signal }), null);
    setTimeout(() => ac.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    const dead = await createMockFinanceServer({ serial: SERIAL, token: TOKEN });
    const deadUrl = dead.baseUrl;
    await dead.close();
    await expect(p.pullAttendance(ctxFor({ config: { baseUrl: deadUrl, deviceSerial: SERIAL } }), null)).rejects.toMatchObject({ code: 'VENDOR_ERROR', retryable: true });
  });

  it('testConnection reports ok with server time + first punch, and ok:false (never a throw) on bad credentials', async () => {
    const p = provider();
    const good = await p.testConnection(ctxFor());
    expect(good.ok).toBe(true);
    expect(good.details).toMatchObject({ firstPunchAt: server.punches[0]!.time_utc, hasPunches: true });
    expect(typeof good.details?.['serverTime']).toBe('string');
    expect(JSON.stringify(good)).not.toContain(TOKEN);
    const bad = await p.testConnection(ctxFor({ credentials: { token: 'wrong-token-1234567890' } }));
    expect(bad.ok).toBe(false);
    expect(bad.details).toMatchObject({ code: 'AUTH_FAILED', retryable: false });
    const misconfigured = await new FlowzaFinanceProvider().testConnection(ctxFor());
    expect(misconfigured).toMatchObject({ ok: false, details: { code: 'INVALID_CONFIG' } });
    const status = await p.getDeviceStatus(ctxFor());
    expect(status.online).toBe(true);
    expect(typeof status.clockSkewSeconds).toBe('number');
  });

  it('pushes a batch to attendance-ingest and enforces the 1..500 batch bound locally', async () => {
    const p = provider();
    const ctx = ctxFor();
    const punches = [
      { pin: 'E0100', time: '2026-03-02T05:00:00.000Z', verify: 'fingerprint', state: 'check_in', workcode: null, lat: null, lng: null, accuracy: null },
      { pin: 'E0100', time: '2026-03-02T13:00:00.000Z', verify: null, state: 'check_out', workcode: null, lat: 23.5, lng: 58.4, accuracy: 9 },
    ];
    const first = await p.pushAttendance(ctx, punches);
    expect(first).toMatchObject({ ok: true, received: 2, ingested: 2, duplicates: 0 });
    const again = await p.pushAttendance(ctx, punches);
    expect(again).toMatchObject({ received: 2, ingested: 0, duplicates: 2 });
    expect(server.ingested[0]).toEqual(punches);
    expect(server.requests.at(-1)!.body).toMatchObject({ device_serial: SERIAL, token: TOKEN, punches });
    await expect(p.pushAttendance(ctx, [])).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    await expect(p.pushAttendance(ctx, Array.from({ length: 501 }, () => punches[0]!))).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    server.failNext({ status: 500, path: 'attendance-ingest' });
    await expect(p.pushAttendance(ctx, punches)).rejects.toMatchObject({ code: 'VENDOR_ERROR', retryable: true });
  });

  it('declares employee operations unsupported (Finance owns its employee mapping)', async () => {
    const p = provider();
    await expect(p.listEmployees(ctxFor(), null)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(p.upsertEmployee(ctxFor(), { deviceUserId: '1', name: 'x', cardNumber: null, pin: null, privilege: 'user', enabled: true, photoUrl: null, extra: {} })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(p.deleteEmployee(ctxFor(), '1')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(p.restart).toBeUndefined();
    expect(p.pushProtocol).toBeUndefined();
  });
});

describeProviderConformance('flowza_finance', () => ({ provider: provider(), ctx: ctxFor(), maxPages: 10 }), { describe, it });
