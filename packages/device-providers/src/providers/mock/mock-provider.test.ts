import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { rawTransactionSchema, type RawTransaction } from '@flowza/contracts';
import { describeProviderConformance } from '../../conformance.js';
import { ProtocolError } from '../../errors.js';
import { createTestProviderContext } from '../../testing.js';
import { ProviderError, type ProviderContext } from '../../types.js';
import { createMockProvider, createMockState, LARGE_BATCH_PAGE_SIZE, type MockAttendanceProvider } from './mock-provider.js';
import { countStream, employeeId, hash32, sliceStream, streamDays, type MockStreamConfig } from './stream.js';
import { canonicalMockPayload, MOCK_SIGNATURE_HEADER, mockWebhookSignature, signMockWebhook, signMockWebhookInline } from './webhook.js';

const NOW = new Date('2026-03-15T10:00:00Z'); // 14:00 in Asia/Muscat
const clock = (): Date => NOW;
const baseConfig = { startDate: '2026-03-01', employeeCount: 5, seed: 7 };

function setup(config: Record<string, unknown> = {}, ctxOverrides: Partial<ProviderContext> = {}): { provider: MockAttendanceProvider; ctx: ReturnType<typeof createTestProviderContext> } {
  const provider = createMockProvider({ clock });
  const ctx = createTestProviderContext({ config: { ...baseConfig, ...config }, ...ctxOverrides });
  return { provider, ctx };
}
async function drain(provider: MockAttendanceProvider, ctx: ProviderContext, pageSize?: number): Promise<RawTransaction[]> {
  const out: RawTransaction[] = [];
  let cursor: Record<string, unknown> | null = null;
  for (let i = 0; i < 200; i += 1) {
    const page = await provider.pullAttendance(ctx, cursor, pageSize ? { pageSize } : {});
    out.push(...page.transactions);
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  }
  return out;
}
async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK'; } catch (e) { return ProviderError.is(e) ? e.code : 'NOT_PROVIDER_ERROR'; }
}

describe('mock stream (pure)', () => {
  const cfg: MockStreamConfig = { seed: 7, employeeCount: 5, punchesPerDay: 0, startDate: '2026-03-01', timezone: 'Asia/Muscat', now: DateTime.fromJSDate(NOW), unknownEmployees: false, deviceCode: 'D1', scenario: 'healthy' };
  it('hash32 is deterministic and order-sensitive', () => {
    expect(hash32(1, 2, 3)).toBe(hash32(1, 2, 3));
    expect(hash32(1, 2, 3)).not.toBe(hash32(1, 3, 2));
    expect(hash32(-1)).toBe(hash32(-1));
  });
  it('covers each local day from startDate to today', () => {
    expect(streamDays(cfg)).toHaveLength(15);
    expect(streamDays({ ...cfg, startDate: '2026-04-01' })).toEqual([]);
  });
  it('is ordered, unique, within 2-4 punches per employee-day and stops at now', () => {
    const total = countStream(cfg);
    const { items } = sliceStream(cfg, 0, total);
    expect(items).toHaveLength(total);
    expect(total).toBeGreaterThanOrEqual(14 * 5 * 2);
    expect(total).toBeLessThanOrEqual(15 * 5 * 4);
    const ids = new Set(items.map((t) => t.providerTransactionId));
    expect(ids.size).toBe(items.length);
    for (let i = 1; i < items.length; i += 1) expect(items[i]!.punchedAt >= items[i - 1]!.punchedAt).toBe(true);
    for (const t of items) {
      expect(rawTransactionSchema.safeParse(t).success).toBe(true);
      expect(new Date(t.punchedAt).getTime()).toBeLessThanOrEqual(NOW.getTime());
      expect(t.deviceLocalTime).toMatch(/^2026-03-\d{2}T\d{2}:\d{2}:\d{2}$/);
    }
    expect(new Set(items.map((t) => t.verificationMethod))).toEqual(new Set(['fingerprint', 'face', 'card']));
    expect(items.some((t) => t.direction === 'unknown')).toBe(true);
    expect(items.some((t) => t.direction === 'in')).toBe(true);
    // local -> UTC: Muscat is UTC+4, so a 08:xx local punch is 04:xx UTC
    const first = items[0]!;
    expect(Number(first.deviceLocalTime?.slice(11, 13))).toBe(Number(first.punchedAt.slice(11, 13)) + 4);
  });
  it('slices are consistent with the full stream', () => {
    const total = countStream(cfg);
    const all = sliceStream(cfg, 0, total).items;
    expect(sliceStream(cfg, 7, 5).items).toEqual(all.slice(7, 12));
    expect(sliceStream(cfg, total - 2, 10).items).toEqual(all.slice(total - 2));
    expect(sliceStream(cfg, total, 10).items).toEqual([]);
  });
  it('honours a fixed punches-per-day', () => {
    const fixed = { ...cfg, punchesPerDay: 6, now: DateTime.fromISO('2026-03-16T00:00:00Z') };
    expect(countStream(fixed)).toBe(15 * 5 * 6);
  });
});

describe('MockAttendanceProvider', () => {
  it('rejects invalid configuration and cursors with INVALID_CONFIG', async () => {
    const { provider, ctx } = setup({ scenario: 'nope' });
    await expect(provider.pullAttendance(ctx, null)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    const ok = setup();
    await expect(ok.provider.pullAttendance(ok.ctx, { lastSeq: -1 })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(ok.provider.listEmployees(ok.ctx, 'page-3')).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  describe('healthy', () => {
    it('pages deterministically with a { lastSeq } cursor and calls acquire once per request', async () => {
      const { provider, ctx } = setup();
      const p1 = await provider.pullAttendance(ctx, null, { pageSize: 10 });
      expect(p1.transactions).toHaveLength(10);
      expect(p1.nextCursor).toEqual({ lastSeq: 10 });
      expect(p1.hasMore).toBe(true);
      expect(p1.transactions[0]?.providerTransactionId).toBe('mock-DEV-1-0');
      expect(ctx.acquireCalls.count).toBe(1);
      const again = await provider.pullAttendance(ctx, null, { pageSize: 10 });
      expect(again.transactions).toEqual(p1.transactions);
      const p2 = await provider.pullAttendance(ctx, p1.nextCursor, { pageSize: 10 });
      expect(p2.transactions[0]?.providerTransactionId).toBe('mock-DEV-1-10');
      const all = await drain(provider, ctx, 25);
      expect(new Set(all.map((t) => t.providerTransactionId)).size).toBe(all.length);
      expect(all.length).toBe(Number(p1.meta?.total));
      const tail = await provider.pullAttendance(ctx, { lastSeq: all.length });
      expect(tail).toMatchObject({ transactions: [], hasMore: false, nextCursor: { lastSeq: all.length } });
    });
    it('supports `since` on the first pull', async () => {
      const { provider, ctx } = setup();
      const all = await drain(provider, ctx);
      const since = all[20]!.punchedAt;
      const page = await provider.pullAttendance(ctx, null, { since, pageSize: 5 });
      expect(page.transactions[0]!.punchedAt >= since).toBe(true);
      expect(page.transactions[0]?.providerTransactionId).toBe(all.find((t) => t.punchedAt >= since)?.providerTransactionId);
      await expect(provider.pullAttendance(ctx, null, { since: 'not-a-date' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    });
    it('only uses known employee ids', async () => {
      const { provider, ctx } = setup();
      const all = await drain(provider, ctx);
      const known = new Set(Array.from({ length: 5 }, (_, i) => employeeId(i + 1)));
      expect(all.every((t) => known.has(t.deviceEmployeeId))).toBe(true);
    });
    it('exposes info/status/testConnection/capabilities/restart', async () => {
      const { provider, ctx } = setup({ model: 'SIM-200-FACE' });
      const conn = await provider.testConnection(ctx);
      expect(conn.ok).toBe(true);
      expect(conn.deviceInfo?.model).toBe('SIM-200-FACE');
      const info = await provider.getDeviceInfo(ctx);
      expect(info).toMatchObject({ serialNumber: 'SIM0001', userCount: 5, fingerprintCount: 0, deviceTime: '2026-03-15T10:00:00Z' });
      expect(info.transactionCount).toBeGreaterThan(0);
      const caps = await provider.getCapabilities(ctx);
      expect(caps.fingerprint).toBe(false);
      expect(caps.face).toBe(true);
      expect(await provider.getDeviceStatus(ctx)).toMatchObject({ online: true, clockSkewSeconds: 0 });
      expect(await provider.restart(ctx)).toMatchObject({ ok: true });
      expect((await provider.getDeviceInfo(ctx)).extra?.restarts).toBe(1);
    });
    it('manages an in-memory, paginated, per-device employee store shared through state', async () => {
      const state = createMockState();
      const provider = createMockProvider({ clock, state });
      const ctx = createTestProviderContext({ config: { ...baseConfig, listPageSize: 2 } });
      const p1 = await provider.listEmployees(ctx, null);
      expect(p1.employees.map((e) => e.deviceUserId)).toEqual(['E001', 'E002']);
      expect(p1.nextCursor).toBe('offset:2');
      const p3 = await provider.listEmployees(ctx, 'offset:4');
      expect(p3.employees).toHaveLength(1);
      expect(p3.nextCursor).toBeNull();
      const up = await provider.upsertEmployee(ctx, { deviceUserId: 'E900', name: 'New Person', cardNumber: '42', pin: null, privilege: 'user', enabled: true, photoUrl: null, extra: {} });
      expect(up).toMatchObject({ ok: true, deviceUserId: 'E900', details: { created: true } });
      const other = createMockProvider({ clock, state }); // shares the world
      const ctx2 = createTestProviderContext({ config: { ...baseConfig, listPageSize: 100 } });
      expect((await other.listEmployees(ctx2, null)).employees.map((e) => e.deviceUserId)).toContain('E900');
      const otherDevice = createTestProviderContext({ config: baseConfig, deviceId: '00000000-0000-0000-0000-0000000000d2' });
      expect((await other.listEmployees(otherDevice, null)).employees.map((e) => e.deviceUserId)).not.toContain('E900');
      expect(await provider.deleteEmployee(ctx, 'E900')).toMatchObject({ ok: true });
      await expect(provider.deleteEmployee(ctx, 'E900')).rejects.toMatchObject({ code: 'NOT_FOUND', retryable: false });
      await expect(provider.upsertEmployee(ctx, { deviceUserId: '', name: 'x', privilege: 'user', enabled: true, extra: {} })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    });
  });

  it('duplicates: re-sends ~10% of the previous page without moving the cursor for them', async () => {
    const clean = setup({ scenario: 'healthy' });
    const dup = setup({ scenario: 'duplicates' });
    const c1 = await clean.provider.pullAttendance(clean.ctx, null, { pageSize: 20 });
    const d1 = await dup.provider.pullAttendance(dup.ctx, null, { pageSize: 20 });
    const key = (t: RawTransaction): string => `${t.providerTransactionId}|${t.punchedAt}|${t.deviceEmployeeId}`;
    expect(d1.transactions.map(key)).toEqual(c1.transactions.map(key)); // first page has nothing to replay
    const c2 = await clean.provider.pullAttendance(clean.ctx, c1.nextCursor, { pageSize: 20 });
    const d2 = await dup.provider.pullAttendance(dup.ctx, d1.nextCursor, { pageSize: 20 });
    expect(d2.nextCursor).toEqual(c2.nextCursor);
    expect(d2.transactions).toHaveLength(22);
    expect(d2.meta?.duplicatesInjected).toBe(2);
    expect(d2.transactions.slice(2).map(key)).toEqual(c2.transactions.map(key));
    const replayed = d2.transactions.slice(0, 2).map((t) => t.providerTransactionId);
    expect(c1.transactions.map((t) => t.providerTransactionId)).toEqual(expect.arrayContaining(replayed));
  });

  it('unknown_employees: includes device user ids that are not in the employee list', async () => {
    const { provider, ctx } = setup({ scenario: 'unknown_employees', employeeCount: 40 });
    const all = await drain(provider, ctx, 1000);
    const listed = new Set((await provider.listEmployees(ctx, null)).employees.map((e) => e.deviceUserId));
    const ghosts = all.filter((t) => !listed.has(t.deviceEmployeeId));
    expect(ghosts.length).toBeGreaterThan(0);
    expect(ghosts.length / all.length).toBeLessThan(0.25);
    expect(ghosts[0]?.deviceEmployeeId).toMatch(/^GHOST-\d+$/);
  });

  it('flaky: every 3rd call fails, alternating VENDOR_ERROR / TIMEOUT (both retryable)', async () => {
    const { provider, ctx } = setup({ scenario: 'flaky' });
    const codes: string[] = [];
    for (let i = 0; i < 12; i += 1) codes.push(await code(provider.pullAttendance(ctx, null)));
    expect(codes).toEqual(['OK', 'OK', 'VENDOR_ERROR', 'OK', 'OK', 'TIMEOUT', 'OK', 'OK', 'VENDOR_ERROR', 'OK', 'OK', 'TIMEOUT']);
    const fresh = setup({ scenario: 'flaky' });
    await fresh.provider.getDeviceInfo(fresh.ctx);
    await fresh.provider.getDeviceInfo(fresh.ctx);
    const err = await fresh.provider.getDeviceInfo(fresh.ctx).catch((e: unknown) => e);
    expect(ProviderError.is(err) && err.retryable).toBe(true);
  });

  it('offline: operations throw DEVICE_OFFLINE, status reports offline, testConnection fails gracefully', async () => {
    const { provider, ctx } = setup({ scenario: 'offline' });
    await expect(provider.pullAttendance(ctx, null)).rejects.toMatchObject({ code: 'DEVICE_OFFLINE', retryable: true });
    await expect(provider.listEmployees(ctx, null)).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' });
    await expect(provider.getDeviceInfo(ctx)).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' });
    expect(await provider.getDeviceStatus(ctx)).toMatchObject({ online: false });
    const conn = await provider.testConnection(ctx);
    expect(conn.ok).toBe(false);
    expect(conn.details?.code).toBe('DEVICE_OFFLINE');
  });

  it('slow: waits latencyMs and maps abort to TIMEOUT', async () => {
    const fast = setup({ scenario: 'slow', latencyMs: 5 });
    const started = Date.now();
    await fast.provider.pullAttendance(fast.ctx, null);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
    const ac = new AbortController();
    const slow = setup({ scenario: 'slow', latencyMs: 5000 }, { signal: ac.signal });
    const p = slow.provider.pullAttendance(slow.ctx, null);
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    const pre = new AbortController();
    pre.abort();
    const dead = setup({ scenario: 'slow', latencyMs: 5000 }, { signal: pre.signal });
    await expect(dead.provider.getDeviceInfo(dead.ctx)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('large_batches: 5000 per page with hasMore, ignoring the requested page size', async () => {
    const { provider, ctx } = setup({ scenario: 'large_batches', employeeCount: undefined });
    const p1 = await provider.pullAttendance(ctx, null, { pageSize: 10 });
    expect(p1.transactions).toHaveLength(LARGE_BATCH_PAGE_SIZE);
    expect(p1.hasMore).toBe(true);
    expect(p1.nextCursor).toEqual({ lastSeq: 5000 });
    const p2 = await provider.pullAttendance(ctx, p1.nextCursor);
    expect(p2.transactions[0]?.providerTransactionId).toBe('mock-DEV-1-5000');
    expect(Number(p1.meta?.total)).toBeGreaterThan(10_000);
  });

  it('auth_failed: AUTH_FAILED unless credentials.apiKey === "valid"', async () => {
    const bad = setup({ scenario: 'auth_failed' }, { credentials: { apiKey: 'wrong' } });
    await expect(bad.provider.pullAttendance(bad.ctx, null)).rejects.toMatchObject({ code: 'AUTH_FAILED', retryable: false });
    await expect(bad.provider.getDeviceStatus(bad.ctx)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect((await bad.provider.testConnection(bad.ctx)).ok).toBe(false);
    const good = setup({ scenario: 'auth_failed' }, { credentials: { apiKey: 'valid' } });
    expect((await good.provider.pullAttendance(good.ctx, null)).transactions.length).toBeGreaterThan(0);
  });

  it('rate_limited: every other call throws RATE_LIMITED with retryAfterMs', async () => {
    const { provider, ctx } = setup({ scenario: 'rate_limited', retryAfterMs: 750 });
    const codes: string[] = [];
    for (let i = 0; i < 4; i += 1) codes.push(await code(provider.listEmployees(ctx, null)));
    expect(codes).toEqual(['OK', 'RATE_LIMITED', 'OK', 'RATE_LIMITED']);
    await provider.listEmployees(ctx, null);
    const err = await provider.listEmployees(ctx, null).catch((e: unknown) => e);
    expect(ProviderError.is(err) && err.retryAfterMs === 750 && err.retryable).toBe(true);
  });
});

describe('mock webhook', () => {
  const secret = 's3cret';
  const payload = {
    eventId: 'evt-1',
    deviceSerial: 'SIM0001',
    transactions: [
      { id: 'tx-1', deviceUserId: 'E001', punchedAt: '2026-03-15T04:00:00Z', method: 'face' as const, direction: 'in' as const },
      { deviceUserId: 'E002', punchedAt: '2026-03-15T04:05:00+04:00' },
    ],
  };
  const provider = createMockProvider({ clock });
  const req = (rawBody: string, headers: Record<string, string> = {}) => ({ headers, rawBody, body: JSON.parse(rawBody) as unknown, query: {} });

  it('accepts a header-signed payload', async () => {
    const signed = signMockWebhook(secret, payload);
    const res = await provider.handleWebhook(req(signed.rawBody, signed.headers), { webhookSecret: secret });
    expect(res).toMatchObject({ accepted: true, signatureValid: true, eventId: 'evt-1', vendorDeviceId: 'SIM0001', response: { status: 200, body: { received: 2 } } });
    expect(res.transactions[0]).toMatchObject({ providerTransactionId: 'tx-1', deviceEmployeeId: 'E001', verificationMethod: 'face', direction: 'in' });
    expect(res.transactions[1]).toMatchObject({ providerTransactionId: 'evt-1:1', verificationMethod: 'unknown', direction: 'unknown' });
    expect(signed.headers[MOCK_SIGNATURE_HEADER]).toBe(mockWebhookSignature(secret, signed.rawBody));
    for (const t of res.transactions) expect(rawTransactionSchema.safeParse(t).success).toBe(true);
  });
  it('accepts an inline (body) signature over the canonical payload', async () => {
    const signed = signMockWebhookInline(secret, payload);
    const parsed = JSON.parse(signed.rawBody) as { signature: string };
    expect(parsed.signature).toBe(mockWebhookSignature(secret, canonicalMockPayload(payload)));
    const res = await provider.handleWebhook(req(signed.rawBody), { webhookSecret: secret });
    expect(res.accepted).toBe(true);
  });
  it('rejects a bad or missing signature / secret / body', async () => {
    const signed = signMockWebhook(secret, payload);
    const wrong = await provider.handleWebhook(req(signed.rawBody, { [MOCK_SIGNATURE_HEADER]: 'f'.repeat(64) }), { webhookSecret: secret });
    expect(wrong).toMatchObject({ accepted: false, signatureValid: false, response: { status: 401 }, transactions: [] });
    const otherSecret = await provider.handleWebhook(req(signed.rawBody, signed.headers), { webhookSecret: 'other' });
    expect(otherSecret.signatureValid).toBe(false);
    const missing = await provider.handleWebhook(req(signed.rawBody), { webhookSecret: secret });
    expect(missing).toMatchObject({ accepted: false, signatureValid: false, response: { status: 401, body: { error: 'missing_signature' } } });
    const noSecret = await provider.handleWebhook(req(signed.rawBody, signed.headers), {});
    expect(noSecret).toMatchObject({ accepted: false, signatureValid: null, response: { status: 401 } });
    const badJson = await provider.handleWebhook({ headers: {}, rawBody: '{nope', body: null, query: {} }, { webhookSecret: secret });
    expect(badJson.response.status).toBe(400);
    const badShape = signMockWebhook(secret, { ...payload, transactions: [{ deviceUserId: '', punchedAt: 'x' }] } as never);
    expect((await provider.handleWebhook(req(badShape.rawBody, badShape.headers), { webhookSecret: secret })).response.status).toBe(400);
  });
});

describe('mock push protocol', () => {
  const provider = createMockProvider({ clock });
  const proto = provider.pushProtocol;
  const ctx = { timezone: 'Asia/Muscat', serialNumber: 'SIM0001' };
  const req = (method: string, path: string, rawBody = '') => ({ method, path, query: {}, headers: {}, rawBody });

  it('identifies devices from the route', () => {
    expect(proto.identifyDevice(req('POST', '/device-push/mock/SIM0001/attendance'))).toEqual({ serialNumber: 'SIM0001', extra: { route: 'attendance' } });
    expect(proto.identifyDevice(req('GET', '/mock/SIM0001/commands'))).toMatchObject({ serialNumber: 'SIM0001' });
    expect(proto.identifyDevice(req('GET', '/device-push/iclock/cdata'))).toBeNull();
  });
  it('parses attendance lines, converting local time to UTC', () => {
    const body = 'E001,2026-03-15T08:00:00,fingerprint,in\nE002,2026-03-15 08:01:00\nE003,2026-03-15T08:02:00Z,card,out,tx-9\n';
    const r = proto.parseInbound(req('POST', '/device-push/mock/SIM0001/attendance', body), ctx);
    expect(r.kind).toBe('attendance');
    expect(r.response.body).toBe('OK: 3');
    expect(r.transactions[0]).toMatchObject({ deviceEmployeeId: 'E001', punchedAt: '2026-03-15T04:00:00Z', deviceLocalTime: '2026-03-15T08:00:00', verificationMethod: 'fingerprint', direction: 'in', providerTransactionId: null });
    expect(r.transactions[1]).toMatchObject({ punchedAt: '2026-03-15T04:01:00Z', verificationMethod: 'unknown', direction: 'unknown' });
    expect(r.transactions[2]).toMatchObject({ punchedAt: '2026-03-15T08:02:00Z', providerTransactionId: 'tx-9' });
    for (const t of r.transactions) expect(rawTransactionSchema.safeParse(t).success).toBe(true);
  });
  it('rejects malformed input with ProtocolError', () => {
    expect(() => proto.parseInbound(req('POST', '/device-push/mock/SIM0001/attendance', 'E001'), ctx)).toThrow(ProtocolError);
    expect(() => proto.parseInbound(req('POST', '/device-push/mock/SIM0001/attendance', 'E001,2026-03-15T08:00:00,laser'), ctx)).toThrow(ProtocolError);
    expect(() => proto.parseInbound(req('POST', '/device-push/mock/SIM0001/attendance', 'E001,soon'), ctx)).toThrow(ProtocolError);
    expect(() => proto.parseInbound(req('GET', '/device-push/mock/SIM0001/attendance'), ctx)).toThrow(ProtocolError);
    expect(() => proto.parseInbound(req('GET', '/device-push/mock/OTHER/commands'), ctx)).toThrow(ProtocolError);
    expect(() => proto.parseInbound(req('GET', '/device-push/mock/SIM0001/handshake', '{bad'), ctx)).toThrow(ProtocolError);
    expect(() => proto.parseInbound(req('GET', '/nothing'), ctx)).toThrow(ProtocolError);
  });
  it('handles commands / handshake / command-results and renders commands as JSON', () => {
    expect(proto.parseInbound(req('GET', '/device-push/mock/SIM0001/commands'), ctx)).toMatchObject({ kind: 'heartbeat', response: { status: 200, body: '[]' } });
    const hs = proto.parseInbound(req('POST', '/device-push/mock/SIM0001/handshake', JSON.stringify({ model: 'SIM-100', firmwareVersion: '1.2' })), ctx);
    expect(hs).toMatchObject({ kind: 'handshake', deviceInfo: { serialNumber: 'SIM0001', model: 'SIM-100', firmwareVersion: '1.2' } });
    const cr = proto.parseInbound(req('POST', '/device-push/mock/SIM0001/command-results', 'c1,ok\nc2,error,boom, really'), ctx);
    expect(cr.commandResults).toEqual([{ commandId: 'c1', ok: true }, { commandId: 'c2', ok: false, message: 'boom,really' }]);
    const cmds = proto.buildCommands({ type: 'DELETE_EMPLOYEE', deviceUserId: 'E1' }).map((c, i) => ({ id: `c${i}`, ...c }));
    const rendered = proto.renderCommands(cmds, { serialNumber: 'SIM0001' });
    expect(JSON.parse(rendered.body)).toEqual([{ id: 'c0', commandType: 'DELETE_EMPLOYEE', payload: { deviceUserId: 'E1' } }]);
    expect(proto.buildCommands({ type: 'RESTART' })).toEqual([{ commandType: 'RESTART', payload: {} }]);
    expect(proto.buildCommands({ type: 'QUERY_USERS' })).toHaveLength(1);
    expect(proto.buildCommands({ type: 'UPSERT_EMPLOYEE', employee: { deviceUserId: 'E1', name: 'A', privilege: 'user', enabled: true, extra: {} } })[0]?.commandType).toBe('UPSERT_EMPLOYEE');
  });
});

for (const scenario of ['healthy', 'duplicates', 'unknown_employees', 'large_batches'] as const) {
  describeProviderConformance(`mock/${scenario}`, () => {
    const provider = createMockProvider({ clock });
    const ctx = createTestProviderContext({ config: { ...baseConfig, scenario, employeeCount: scenario === 'large_batches' ? 200 : 5 } });
    return { provider, ctx, maxPages: 5 };
  }, { describe, it });
}
