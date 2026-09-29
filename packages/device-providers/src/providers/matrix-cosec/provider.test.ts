import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rawTransactionSchema, type DeviceEmployee } from '@flowza/contracts';
import { describeProviderConformance } from '../../conformance.js';
import { createTestProviderContext } from '../../testing.js';
import { ProviderError, type ProviderContext } from '../../types.js';
import { MATRIX_COSEC_DEFINITION } from './definition.js';
import { cosecEventFixtures, createMockCosecServer, type MockCosecServer, type MockCosecServerOptions } from './mock-server.js';
import { COSEC_INITIAL_BACKFILL_EVENTS, cosecCodeError, cosecName, cosecUserIdFor, isCosecCursorError, mapCosecDirection, mapCosecVerification, MatrixCosecProvider, parseCosecBody, parseCosecCursor } from './provider.js';

const PASSWORD = 'cosec-pass';
const NOW = new Date('2026-03-10T06:00:00Z');
let server: MockCosecServer;
const extra: MockCosecServer[] = [];

function ctxFor(srv: MockCosecServer, overrides: Partial<ProviderContext> = {}): ProviderContext & { acquireCalls: { count: number } } {
  return createTestProviderContext({ config: { baseUrl: srv.baseUrl, username: 'admin' }, credentials: { password: PASSWORD }, ...overrides });
}
const provider = (): MatrixCosecProvider => new MatrixCosecProvider({ allowPrivateHosts: true, clock: () => NOW });
async function another(opts: MockCosecServerOptions): Promise<MockCosecServer> {
  const s = await createMockCosecServer({ password: PASSWORD, ...opts });
  extra.push(s);
  return s;
}
async function providerError(p: Promise<unknown>): Promise<ProviderError> {
  try { await p; } catch (e) { if (ProviderError.is(e)) return e; throw e; }
  throw new Error('expected a ProviderError');
}
const employee = (over: Partial<DeviceEmployee> = {}): DeviceEmployee => ({ deviceUserId: '1001', name: 'Aisha Al Balushi', cardNumber: '1234567890', pin: '4321', privilege: 'user', enabled: true, photoUrl: null, extra: {}, ...over });

beforeAll(async () => { server = await createMockCosecServer({ password: PASSWORD, events: cosecEventFixtures(7) }); });
afterAll(async () => { await server.close(); });
beforeEach(() => { server.requests.length = 0; server.users.clear(); });
afterEach(async () => { while (extra.length > 0) await extra.pop()!.close(); });

describe('matrix_cosec definition', () => {
  it('is the DAPI (device.cgi) LAN adapter, beta / REPORTED, with honest capabilities', () => {
    const d = MATRIX_COSEC_DEFINITION;
    expect(d).toMatchObject({ key: 'matrix_cosec', vendor: 'Matrix Comsec', name: 'Matrix COSEC device API (device.cgi)', integrationType: 'LAN', status: 'beta', verificationStatus: 'REPORTED' });
    expect(d.capabilities).toMatchObject({ attendancePull: true, employeePush: true, employeeDelete: true, deviceStatus: true, card: true, pin: true, employeePull: false, remoteRestart: false, fingerprint: false, face: false, devicePush: false, biometricTemplatePush: false });
    expect(d.secretFields).toEqual(['password']);
    expect(d.configSchema.fields.map((f) => [f.key, f.type, f.required])).toEqual([['baseUrl', 'url', true], ['username', 'text', true], ['password', 'password', true]]);
    expect(d.configSchema.fields.find((f) => f.key === 'username')?.default).toBe('admin');
  });
});

describe('matrix_cosec parsing and mapping', () => {
  it('parses XML answers (fields, Events records, entities, prolog) and key=value text', () => {
    const doc = parseCosecBody('<?xml version="1.0"?>\n<COSEC_API><Events><roll-over-count>0</roll-over-count><seq-No>5</seq-No><detail-1>A&amp;B</detail-1></Events><Events><seq-No>6</seq-No></Events></COSEC_API>');
    expect(doc.events).toEqual([{ 'roll-over-count': '0', 'seq-No': '5', 'detail-1': 'A&B' }, { 'seq-No': '6' }]);
    expect(parseCosecBody('<COSEC_API><Response-Code>13</Response-Code></COSEC_API>').fields).toEqual({ 'Response-Code': '13' });
    expect(parseCosecBody('<COSEC_API>Invalid argument</COSEC_API>')).toMatchObject({ fields: {}, events: [], text: 'Invalid argument' });
    expect(parseCosecBody('<COSEC_API/>')).toEqual({ fields: {}, events: [], text: '' });
    expect(parseCosecBody('Response-Code=0 name=John Doe user-id=7').fields).toEqual({ 'Response-Code': '0', name: 'John Doe', 'user-id': '7' });
    expect(() => parseCosecBody('<COSEC_API><broken>')).toThrow(ProviderError);
  });

  it('maps special function → direction and credential mask → verification without inventing either', () => {
    expect(['1', '3', '5', '11'].map(mapCosecDirection)).toEqual(['in', 'in', 'in', 'in']);
    expect(['2', '4', '6', '12'].map(mapCosecDirection)).toEqual(['out', 'out', 'out', 'out']);
    expect(['7', '8', '9', '10'].map(mapCosecDirection)).toEqual(['break_in', 'break_out', 'overtime_in', 'overtime_out']);
    expect(['0', '98', '99', '', undefined].map(mapCosecDirection)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
    expect(mapCosecVerification('4')).toBe('fingerprint');
    expect(mapCosecVerification('6')).toBe('fingerprint'); // card + finger: the biometric factor wins
    expect(mapCosecVerification('64')).toBe('face');
    expect(mapCosecVerification('8')).toBe('palm');
    expect(mapCosecVerification('2')).toBe('card');
    expect(mapCosecVerification('1')).toBe('pin');
    expect(mapCosecVerification('128')).toBe('mobile');
    expect(mapCosecVerification('x')).toBe('unknown');
    expect(mapCosecVerification('0')).toBe('unknown');
  });

  it('validates cursors (bad ones are INVALID_CONFIG with the cursor reason)', () => {
    expect(parseCosecCursor(null)).toBeNull();
    expect(parseCosecCursor({})).toBeNull();
    expect(parseCosecCursor({ rollOverCount: 1, seqNumber: 9 })).toEqual({ rollOverCount: 1, seqNumber: 9 });
    for (const bad of [{ bogus: 1 }, { rollOverCount: -1, seqNumber: 1 }, { rollOverCount: 0, seqNumber: 0 }, { rollOverCount: 0, seqNumber: '5' }, { rollOverCount: 0, seqNumber: 1, notBefore: 'yesterday' }]) {
      let err: unknown;
      try { parseCosecCursor(bad); } catch (e) { err = e; }
      expect(isCosecCursorError(err)).toBe(true);
    }
  });

  it('validates user ids and names for the device', () => {
    expect(cosecUserIdFor('42')).toBe('42');
    for (const bad of ['0', '007', 'E-1', 'ABC', '123456789', '']) expect(() => cosecUserIdFor(bad)).toThrow(/number from 1 to 99999999/);
    expect(cosecName('Mohammed bin Rashid Al Maktoum')).toEqual({ name: 'Mohammed bin Ra', truncated: true });
    expect(() => cosecName('Evil\r\nName')).toThrow(/control characters/);
  });

  it('maps Response-Codes to provider error codes', () => {
    expect(cosecCodeError('1', 'x').code).toBe('AUTH_FAILED');
    expect(cosecCodeError('21', 'x').code).toBe('CONFLICT');
    expect(cosecCodeError('13', 'x').code).toBe('NOT_FOUND');
    expect(cosecCodeError('33', 'x').code).toBe('INVALID_CONFIG');
    expect(cosecCodeError('16', 'x')).toMatchObject({ code: 'VENDOR_ERROR', retryable: true });
    expect(cosecCodeError('4', 'x')).toMatchObject({ code: 'VENDOR_ERROR', retryable: false });
  });
});

describe('matrix_cosec provider against the mock controller', () => {
  it('testConnection reads the device (Basic auth) and reports its identity without secrets', async () => {
    const ctx = ctxFor(server);
    const r = await provider().testConnection(ctx);
    expect(r.ok).toBe(true);
    expect(r.deviceInfo).toMatchObject({ serialNumber: '64694E36B7E7', model: 'COSEC ARGO', firmwareVersion: 'V3R5', deviceTime: '2026-03-01T04:00:00Z', userCount: 0 });
    expect(JSON.stringify(r)).not.toContain('must-not-leak');
    expect(JSON.stringify(r)).not.toContain(PASSWORD);
    expect(server.requests.every((q) => q.authScheme === 'Basic' && q.query['format'] === 'xml')).toBe(true);
    expect(server.requests.map((q) => `${q.resource}:${q.action}`)).toEqual(['device-basic-config:get', 'date-time:get', 'command:getusercount']);
    expect(ctx.acquireCalls.count).toBe(server.requests.length);
  });

  it('wrong password → AUTH_FAILED and testConnection ok:false', async () => {
    const ctx = ctxFor(server, { credentials: { password: 'nope' } });
    const r = await provider().testConnection(ctx);
    expect(r).toMatchObject({ ok: false, details: { code: 'AUTH_FAILED', retryable: false } });
    expect(r.message).not.toContain('nope');
    expect((await providerError(provider().getDeviceStatus(ctx))).code).toBe('AUTH_FAILED');
  });

  it('Response-Code 1 inside a 200 is AUTH_FAILED too', async () => {
    server.failNext({ status: 200, body: '<COSEC_API><Response-Code>1</Response-Code></COSEC_API>', headers: { 'content-type': 'text/xml' } });
    expect((await providerError(provider().getDeviceStatus(ctxFor(server)))).code).toBe('AUTH_FAILED');
  });

  it('switches to Digest when the firmware challenges Digest, then stays on Digest (fresh nonce every call)', async () => {
    const digest = await another({ auth: 'digest', events: cosecEventFixtures(3) });
    const p = provider();
    const ctx = ctxFor(digest);
    const status = await p.getDeviceStatus(ctx);
    expect(status.online).toBe(true);
    expect(digest.requests.map((r) => r.authScheme)).toEqual(['Basic', null, 'Digest']);
    digest.requests.length = 0;
    await p.getDeviceStatus(ctx);
    expect(digest.requests.map((r) => r.authScheme)).toEqual([null, 'Digest']); // no Basic header once Digest is known
    expect(ctx.acquireCalls.count).toBe(5);
    const bad = await p.testConnection(ctxFor(digest, { credentials: { password: 'wrong' } }));
    expect(bad).toMatchObject({ ok: false, details: { code: 'AUTH_FAILED' } });
  });

  it('getDeviceStatus reports the device clock (Asia/Muscat wall time → UTC) and the skew', async () => {
    const s = await provider().getDeviceStatus(ctxFor(server));
    expect(s).toMatchObject({ online: true, deviceTime: '2026-03-01T04:00:00Z', details: { deviceLocalTime: '2026-03-01 08:00:00' } });
    expect(s.clockSkewSeconds).toBe(Math.round((Date.parse('2026-03-01T04:00:00Z') - NOW.getTime()) / 1000));
  });

  it('pulls attendance page by page: cursor (roll-over-count, seq-No), hasMore, timezone, door events skipped but passed', async () => {
    const p = provider();
    const ctx = ctxFor(server);
    const since = '2026-02-01T00:00:00Z';
    const first = await p.pullAttendance(ctx, null, { pageSize: 3, since });
    // 7 events on the device → current seq 7 → start at max(1, 7 - 1000 + 1) = 1
    expect(server.requests.map((r) => `${r.action}`)).toEqual(['getcurrentseqnumber', 'getevent']);
    expect(server.requests[1]?.query).toMatchObject({ 'roll-over-count': '0', 'seq-number': '1', 'no-of-events': '3', format: 'xml' });
    expect(first.transactions.map((t) => t.providerTransactionId)).toEqual(['0:1', '0:2']); // seq 3 is a door event
    expect(first.transactions[0]).toMatchObject({ deviceEmployeeId: '1001', punchedAt: '2026-03-01T04:00:05Z', deviceLocalTime: '01/03/2026 08:00:05', direction: 'in', verificationMethod: 'fingerprint' });
    expect(first.transactions[1]).toMatchObject({ deviceEmployeeId: '1002', direction: 'out', verificationMethod: 'card' });
    expect(first.transactions[0]?.rawPayload).toMatchObject({ rollOverCount: 0, seqNo: 1, eventId: '101', detail1: '1001', specialFunction: 'official-work-in' });
    for (const t of first.transactions) expect(rawTransactionSchema.safeParse(t).success).toBe(true);
    expect(first.nextCursor).toEqual({ rollOverCount: 0, seqNumber: 4 }); // notBefore crossed → dropped
    expect(first.hasMore).toBe(true);

    const second = await p.pullAttendance(ctx, first.nextCursor, { pageSize: 3 });
    expect(second.transactions.map((t) => t.providerTransactionId)).toEqual(['0:4', '0:5']);
    expect(second.nextCursor).toEqual({ rollOverCount: 0, seqNumber: 7 });
    expect(second.hasMore).toBe(true);
    const third = await p.pullAttendance(ctx, second.nextCursor, { pageSize: 3 });
    expect(third.transactions.map((t) => t.providerTransactionId)).toEqual(['0:7']);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toEqual({ rollOverCount: 0, seqNumber: 8 });
    // same cursor → same page; an exhausted stream does not move
    expect((await p.pullAttendance(ctx, second.nextCursor, { pageSize: 3 })).transactions).toEqual(third.transactions);
    const tail = await p.pullAttendance(ctx, third.nextCursor);
    expect(tail).toMatchObject({ transactions: [], hasMore: false, nextCursor: third.nextCursor });
    expect(ctx.acquireCalls.count).toBe(server.requests.length);
  });

  it('a first pull backfills at most the last 1000 events and drops punches before `since` (default 30 days)', async () => {
    const old = cosecEventFixtures(1500, { start: { y: 2025, m: 12, d: 1, h: 0 } }).map((e, i) => (i >= 1400 ? { ...e, date: '05/03/2026' } : e));
    const dev = await another({ events: old });
    const ctx = ctxFor(dev);
    const r = await provider().pullAttendance(ctx, null, { pageSize: 100 });
    const get = dev.requests.find((q) => q.action === 'getevent');
    expect(get?.query['seq-number']).toBe(String(1500 - COSEC_INITIAL_BACKFILL_EVENTS + 1));
    expect(r.transactions).toEqual([]); // all 2025-12-01 punches predate 2026-02-08 (NOW − 30 d, local midnight)
    expect(r.nextCursor).toMatchObject({ rollOverCount: 0, seqNumber: 601, notBefore: '2026-02-07T20:00:00Z' });
    expect(r.hasMore).toBe(true);
    let page = r;
    let delivered = 0;
    for (let i = 0; i < 20 && page.hasMore; i += 1) {
      page = await provider().pullAttendance(ctx, page.nextCursor, { pageSize: 100 });
      delivered += page.transactions.length;
    }
    expect(delivered).toBe(66); // events 1401–1500 minus the 34 door events
    expect(page.nextCursor).toEqual({ rollOverCount: 0, seqNumber: 1501 });
  });

  it('falls back to the start of the log when the firmware has no current-sequence call', async () => {
    const dev = await another({ events: cosecEventFixtures(4, { start: { y: 2026, m: 3, d: 9, h: 8 } }), supportsCurrentSeq: false });
    const r = await provider().pullAttendance(ctxFor(dev), null);
    expect(dev.requests.find((q) => q.action === 'getevent')?.query['seq-number']).toBe('1');
    expect(r.transactions.map((t) => t.providerTransactionId)).toEqual(['0:1', '0:2', '0:4']);
    expect(r.meta).toMatchObject({ started: 'beginning' });
  });

  it('follows a roll-over of the event log to the next generation', async () => {
    const dev = await another({ events: [...cosecEventFixtures(2, { roll: 0, startSeq: 99 }), ...cosecEventFixtures(2, { roll: 1, startSeq: 1 })] });
    const p = provider();
    const ctx = ctxFor(dev);
    const a = await p.pullAttendance(ctx, { rollOverCount: 0, seqNumber: 99 });
    expect(a.transactions.map((t) => t.providerTransactionId)).toEqual(['0:99', '0:100']);
    expect(a.nextCursor).toEqual({ rollOverCount: 0, seqNumber: 101 });
    const b = await p.pullAttendance(ctx, a.nextCursor);
    expect(b).toMatchObject({ transactions: [], hasMore: true, nextCursor: { rollOverCount: 1, seqNumber: 1 }, meta: { rolledOver: true } });
    const c = await p.pullAttendance(ctx, b.nextCursor);
    expect(c.transactions.map((t) => t.providerTransactionId)).toEqual(['1:1', '1:2']);
  });

  it('flags (without moving) a cursor that is ahead of a reset device', async () => {
    const r = await provider().pullAttendance(ctxFor(server), { rollOverCount: 0, seqNumber: 500 });
    expect(r).toMatchObject({ transactions: [], hasMore: false, nextCursor: { rollOverCount: 0, seqNumber: 500 }, meta: { cursorAhead: true, deviceSequence: { rollOverCount: 0, seqNumber: 7 } } });
  });

  it('rejects a bad cursor before touching the device', async () => {
    const ctx = ctxFor(server);
    const err = await providerError(provider().pullAttendance(ctx, { bogus: 'cursor' }));
    expect(err.code).toBe('INVALID_CONFIG');
    expect(isCosecCursorError(err)).toBe(true);
    expect(ctx.acquireCalls.count).toBe(0);
  });

  it('upserts a user with user-id = ref-user-id, percent-encoded values, card and PIN; updates in place', async () => {
    const p = provider();
    const ctx = ctxFor(server);
    const r = await p.upsertEmployee(ctx, employee({ name: 'Ali & Sons+Co LLC Muscat' }));
    expect(r).toMatchObject({ ok: true, deviceUserId: '1001', details: { created: true, nameTruncated: true } });
    const set = server.requests.find((q) => q.action === 'set');
    expect(set?.query).toMatchObject({ 'user-id': '1001', 'ref-user-id': '1001', name: 'Ali & Sons+Co L', 'user-active': '1', card1: '1234567890', 'user-pin': '4321' });
    expect(set?.rawUrl).toContain('name=Ali%20%26%20Sons%2BCo%20L');
    expect(server.users.get('1001')).toMatchObject({ refUserId: '1001', name: 'Ali & Sons+Co L' });
    const again = await p.upsertEmployee(ctx, employee({ enabled: false, cardNumber: null, pin: null }));
    expect(again).toMatchObject({ ok: true, details: { created: false } });
    expect(server.users.get('1001')).toMatchObject({ active: '0', card1: '1234567890', pin: '4321' });
    expect(ctx.acquireCalls.count).toBe(server.requests.length);
  });

  it('refuses invalid employee data with INVALID_CONFIG before any request', async () => {
    const ctx = ctxFor(server);
    for (const e of [employee({ deviceUserId: 'EMP-7' }), employee({ deviceUserId: '123456789' }), employee({ name: 'Bad\u0007Name' }), employee({ pin: '12ab' }), employee({ pin: '1234567' }), employee({ cardNumber: 'A1B2' }), employee({ cardNumber: '99999999999999999999' })]) {
      expect((await providerError(provider().upsertEmployee(ctx, e))).code).toBe('INVALID_CONFIG');
    }
    expect(ctx.acquireCalls.count).toBe(0);
  });

  it('reports conflicts: an existing user with another reference id, or a reference id taken on the device', async () => {
    server.users.set('1001', { userId: '1001', refUserId: '55', name: 'Old', active: '1' });
    expect((await providerError(provider().upsertEmployee(ctxFor(server), employee()))).code).toBe('CONFLICT');
    expect(server.requests.some((q) => q.action === 'set')).toBe(false);
    server.users.clear();
    server.users.set('X9', { userId: 'X9', refUserId: '1001', name: 'Someone', active: '1' });
    const err = await providerError(provider().upsertEmployee(ctxFor(server), employee()));
    expect(err).toMatchObject({ code: 'CONFLICT', details: { responseCode: '21' } });
  });

  it('deletes users idempotently', async () => {
    const p = provider();
    const ctx = ctxFor(server);
    await p.upsertEmployee(ctx, employee());
    expect(await p.deleteEmployee(ctx, '1001')).toMatchObject({ ok: true, details: { alreadyAbsent: false } });
    expect(server.users.has('1001')).toBe(false);
    expect(await p.deleteEmployee(ctx, '1001')).toMatchObject({ ok: true, details: { alreadyAbsent: true } });
    expect((await providerError(p.deleteEmployee(ctx, 'bad id!'))).code).toBe('INVALID_CONFIG');
  });

  it('listEmployees and restart are UNSUPPORTED (no DAPI call exists)', async () => {
    const ctx = ctxFor(server);
    expect((await providerError(provider().listEmployees(ctx, null))).code).toBe('UNSUPPORTED');
    expect((await providerError(provider().restart(ctx))).code).toBe('UNSUPPORTED');
    expect(ctx.acquireCalls.count).toBe(0);
  });

  it('maps HTTP failures: 429 → RATE_LIMITED with Retry-After, 5xx → retryable, 503 → DEVICE_OFFLINE', async () => {
    const ctx = ctxFor(server);
    server.failNext({ status: 429, headers: { 'retry-after': '7' } });
    expect(await providerError(provider().pullAttendance(ctx, { rollOverCount: 0, seqNumber: 1 }))).toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterMs: 7000 });
    server.failNext({ status: 500 });
    expect(await providerError(provider().getDeviceStatus(ctx))).toMatchObject({ code: 'VENDOR_ERROR', retryable: true });
    server.failNext({ status: 503 });
    expect(await providerError(provider().getDeviceStatus(ctx))).toMatchObject({ code: 'DEVICE_OFFLINE', retryable: true });
    server.failNext({ status: 200, body: 'garbage without pairs' });
    expect(await providerError(provider().getDeviceStatus(ctx))).toMatchObject({ code: 'VENDOR_ERROR', retryable: false });
    const off = await provider().testConnection(ctxFor(server, { config: { baseUrl: 'http://127.0.0.1:1', username: 'admin' } }));
    expect(off).toMatchObject({ ok: false, details: { code: 'DEVICE_OFFLINE' } });
  });

  it('bad or missing config → INVALID_CONFIG; https is mandatory outside local development', async () => {
    const base = { baseUrl: server.baseUrl, username: 'admin' };
    expect((await providerError(provider().getDeviceStatus(ctxFor(server, { config: { username: 'admin' } })))).code).toBe('INVALID_CONFIG');
    expect((await providerError(provider().getDeviceStatus(ctxFor(server, { credentials: {} })))).code).toBe('INVALID_CONFIG');
    expect((await providerError(provider().getDeviceStatus(ctxFor(server, { config: { baseUrl: server.baseUrl } })))).code).toBe('INVALID_CONFIG');
    expect((await providerError(provider().getDeviceStatus(ctxFor(server, { config: { ...base, username: 'a:b' } })))).code).toBe('INVALID_CONFIG');
    const strict = new MatrixCosecProvider();
    const err = await providerError(strict.getDeviceStatus(ctxFor(server)));
    expect(err.code).toBe('INVALID_CONFIG');
    expect(err.message).toMatch(/https/);
    const r = await strict.testConnection(ctxFor(server, { config: { ...base, baseUrl: 'https://10.0.0.5' } }));
    expect(r).toMatchObject({ ok: false, details: { code: 'INVALID_CONFIG' } });
  });
});

describeProviderConformance('matrix_cosec', () => ({ provider: provider(), ctx: ctxFor(server), sampleEmployee: employee({ deviceUserId: '4242' }), maxPages: 10 }), { describe, it });
