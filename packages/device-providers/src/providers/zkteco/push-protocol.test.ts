import { describe, expect, it } from 'vitest';
import { rawTransactionSchema } from '@flowza/contracts';
import { describeProviderConformance } from '../../conformance.js';
import { ProtocolError } from '../../errors.js';
import { createTestProviderContext } from '../../testing.js';
import { ProviderError } from '../../types.js';
import { createZkPushProtocol, ICLOCK_PROTOCOL_KEY, iclockRoute, parseAttlogLine, parseDeviceCmdBody, parseInfoParam, parseOperlogBody, renderCommandLine, renderHandshake, ZK_DEFAULT_TZ } from './push-protocol.js';
import { PUSH_NOT_VERIFIED_MESSAGE, ZKTecoPushProvider } from './provider.js';

const SN = 'AEXR200460001';
const ctx = { timezone: 'Asia/Muscat', serialNumber: SN };
const req = (method: string, path: string, query: Record<string, string> = {}, rawBody = '') => ({ method, path, query, headers: {}, rawBody });
const proto = createZkPushProtocol();
const T = '\t';

describe('iclock routing / identification', () => {
  it('recognises routes regardless of mount prefix', () => {
    expect(iclockRoute('/device-push/iclock/cdata')).toBe('cdata');
    expect(iclockRoute('/iclock/getrequest?SN=1')).toBe('getrequest');
    expect(iclockRoute('/iclock/devicecmd/')).toBe('devicecmd');
    expect(iclockRoute('/iclock/nope')).toBeNull();
  });
  it('identifies the device from SN (case-insensitive) and rejects bad serials', () => {
    expect(proto.identifyDevice(req('GET', '/iclock/cdata', { SN, options: 'all', pushver: '2.4.1' }))).toEqual({ serialNumber: SN, extra: { route: 'cdata', pushver: '2.4.1' } });
    expect(proto.identifyDevice(req('GET', '/iclock/cdata', { sn: SN }))).toMatchObject({ serialNumber: SN });
    expect(proto.identifyDevice(req('GET', '/iclock/cdata', {}))).toBeNull();
    expect(proto.identifyDevice(req('GET', '/iclock/cdata', { SN: 'bad serial!' }))).toBeNull();
    expect(proto.identifyDevice(req('GET', '/other', { SN }))).toBeNull();
    expect(proto.protocolKey).toBe(ICLOCK_PROTOCOL_KEY);
  });
});

describe('handshake', () => {
  it('returns the option block with None stamps by default', () => {
    const r = proto.parseInbound(req('GET', '/iclock/cdata', { SN, options: 'all', pushver: '2.4.1', language: '69' }), ctx);
    expect(r.kind).toBe('handshake');
    expect(r.deviceInfo).toEqual({ serialNumber: SN, extra: { options: 'all', pushver: '2.4.1', language: '69' } });
    expect(r.response.status).toBe(200);
    expect(r.response.body).toBe(['GET OPTION FROM: ' + SN, 'ATTLOGStamp=None', 'OPERLOGStamp=None', 'ATTPHOTOStamp=None', 'ErrorDelay=30', 'Delay=10', 'TransTimes=00:00;14:05', 'TransInterval=1', `TransFlag=TransData AttLog${T}OpLog${T}EnrollUser${T}ChgUser`, 'Realtime=1', 'Encrypt=None'].join('\n') + '\n');
  });
  it('echoes persisted stamps and custom options; ignores invalid stamps', () => {
    const body = renderHandshake(SN, { ATTLOG: '1234567', OPERLOG: 'bad stamp!' }, { errorDelay: 60, delay: 30, transTimes: '00:00;12:00', transInterval: 5, realtime: false });
    expect(body).toContain('ATTLOGStamp=1234567\n');
    expect(body).toContain('OPERLOGStamp=None\n');
    expect(body).toContain('ErrorDelay=60\nDelay=30\nTransTimes=00:00;12:00\nTransInterval=5\n');
    expect(body).toContain('Realtime=0\n');
    const r = proto.parseInbound(req('GET', '/iclock/cdata', { SN }), { ...ctx, stamps: { ATTLOG: '99' } });
    expect(r.response.body).toContain('ATTLOGStamp=99');
  });
});

describe('ATTLOG', () => {
  it('parses tab-separated punches, converting Muscat local time to UTC', () => {
    const body = [`1${T}2026-03-10 08:30:00${T}0${T}1${T}0${T}0${T}0`, `2${T}2026-03-10 17:45:10${T}1${T}15${T}0`, `3${T}2026-03-10 12:00:00${T}255${T}99`, `4${T}2026-03-10 12:30:00`].join('\r\n') + '\r\n';
    const r = proto.parseInbound(req('POST', '/device-push/iclock/cdata', { SN, table: 'ATTLOG', Stamp: '9999' }, body), ctx);
    expect(r.kind).toBe('attendance');
    expect(r.response).toEqual({ status: 200, body: 'OK: 4', headers: { 'content-type': 'text/plain; charset=utf-8' } });
    expect(r.meta).toEqual({ table: 'ATTLOG', stamp: '9999', lines: 4 });
    expect(r.transactions[0]).toEqual({
      providerTransactionId: null,
      deviceEmployeeId: '1',
      punchedAt: '2026-03-10T04:30:00Z',
      deviceLocalTime: '2026-03-10 08:30:00',
      verificationMethod: 'fingerprint',
      direction: 'in',
      rawPayload: { protocol: 'iclock', table: 'ATTLOG', serialNumber: SN, pin: '1', time: '2026-03-10 08:30:00', status: 0, verify: 1, workCode: '0', reserved: ['0', '0'] },
    });
    expect(r.transactions[1]).toMatchObject({ deviceEmployeeId: '2', punchedAt: '2026-03-10T13:45:10Z', verificationMethod: 'face', direction: 'out' });
    expect(r.transactions[2]).toMatchObject({ verificationMethod: 'unknown', direction: 'unknown' });
    expect(r.transactions[3]).toMatchObject({ verificationMethod: 'unknown', direction: 'unknown', punchedAt: '2026-03-10T08:30:00Z' });
    for (const t of r.transactions) expect(rawTransactionSchema.safeParse(t).success).toBe(true);
  });
  it('bounds unknown trailing columns so raw_payload cannot be inflated or used to smuggle binary data', () => {
    const blob = 'Q'.repeat(5000);
    const many = Array.from({ length: 20 }, (_, i) => `r${i}`);
    const t = parseAttlogLine([`1`, `2026-03-10 08:30:00`, `0`, `1`, blob, ...many].join(T), 0, 'Asia/Muscat', SN);
    expect(JSON.stringify(t.rawPayload).length).toBeLessThan(1024);
    expect(t.rawPayload).toMatchObject({ workCode: 'Q'.repeat(64), reserved: many.slice(0, 8), truncated: true });
    const plain = parseAttlogLine(`1${T}2026-03-10 08:30:00${T}0${T}1${T}0${T}0`, 0, 'Asia/Muscat', SN);
    expect(plain.rawPayload).not.toHaveProperty('truncated');
    expect(plain.deviceLocalTime).toBe('2026-03-10 08:30:00');
  });
  it('only lets well-formed stamps through to meta (they are persisted and echoed to the device)', () => {
    const body = `1${T}2026-03-10 08:30:00${T}0${T}1`;
    expect(proto.parseInbound(req('POST', '/iclock/cdata', { SN, table: 'ATTLOG', Stamp: 'bad stamp!' }, body), ctx).meta).toMatchObject({ stamp: null });
    expect(proto.parseInbound(req('POST', '/iclock/cdata', { SN, table: 'ATTLOG', Stamp: 'x'.repeat(33) }, body), ctx).meta).toMatchObject({ stamp: null });
    expect(proto.parseInbound(req('POST', '/iclock/cdata', { SN, table: 'OPERLOG', OpStamp: '../etc' }, ''), ctx).meta).toMatchObject({ stamp: null });
  });
  it('refuses oversize bodies with 413 and reports a bad device timezone as INVALID_CONFIG (not a device error)', () => {
    const body = `1${T}2026-03-10 08:30:00${T}0${T}1\n`.repeat(50_000); // ~1.3 MB, above the 1 MiB cap
    const err = (() => { try { proto.parseInbound(req('POST', '/iclock/cdata', { SN, table: 'ATTLOG' }, body), ctx); return undefined; } catch (e) { return e as ProtocolError; } })();
    expect(err?.httpStatus).toBe(413);
    const tz = (() => { try { proto.parseInbound(req('POST', '/iclock/cdata', { SN, table: 'ATTLOG' }, `1${T}2026-03-10 08:30:00`), { ...ctx, timezone: 'Nope/Zone' }); return undefined; } catch (e) { return e; } })();
    expect(ProviderError.is(tz) && tz.code === 'INVALID_CONFIG').toBe(true);
    expect(ProtocolError.is(tz)).toBe(false);
  });
  it('maps every documented status and verify code', () => {
    const line = (status: number, verify: number) => parseAttlogLine(`7${T}2026-01-01 00:00:00${T}${status}${T}${verify}`, 0, 'UTC', SN);
    expect([0, 1, 2, 3, 4, 5].map((s) => line(s, 1).direction)).toEqual(['in', 'out', 'break_out', 'break_in', 'overtime_in', 'overtime_out']);
    expect([0, 1, 2, 15].map((v) => line(0, v).verificationMethod)).toEqual(['password', 'fingerprint', 'card', 'face']);
  });
  it('accepts an empty body and rejects malformed lines strictly', () => {
    expect(proto.parseInbound(req('POST', '/iclock/cdata', { SN, table: 'ATTLOG' }, '\n'), ctx)).toMatchObject({ transactions: [], response: { body: 'OK: 0' } });
    const bad = (body: string) => () => proto.parseInbound(req('POST', '/iclock/cdata', { SN, table: 'ATTLOG' }, body), ctx);
    expect(bad('1 2026-03-10 08:30:00')).toThrow(ProtocolError); // no tabs
    expect(bad(`bad pin${T}2026-03-10 08:30:00`)).toThrow(ProtocolError);
    expect(bad(`1${T}10/03/2026 08:30`)).toThrow(ProtocolError);
    expect(bad(`1${T}2026-03-10 08:30:00${T}x`)).toThrow(ProtocolError);
    expect(bad(`1${T}2026-03-10 08:30:00${T}0${T}y`)).toThrow(ProtocolError);
    const err = (() => { try { bad(`1${T}2026-03-10 08:30:00\n2${T}nope`)(); return undefined; } catch (e) { return e as ProtocolError; } })();
    expect(err).toBeInstanceOf(ProtocolError);
    expect(err?.httpStatus).toBe(400);
    expect(err?.retryable).toBe(false);
    expect(err?.code).toBe('PROTOCOL_ERROR');
    expect(ProviderError.is(err)).toBe(true);
  });
});

describe('OPERLOG', () => {
  it('parses USER lines into DeviceEmployee and never keeps templates', () => {
    const body = [
      `OPLOG 4${T}0${T}2026-03-10 08:00:00${T}1${T}0${T}0${T}0`,
      `USER PIN=1${T}Name=Ahmed Al Balushi${T}Pri=14${T}Passwd=1234${T}Card=1234567${T}Grp=1${T}TZ=0000000100000000${T}Verify=0`,
      `USER PIN=2${T}Name=${T}Pri=0${T}Passwd=${T}Card=0${T}Grp=1`,
      `FP PIN=1${T}FID=6${T}Size=1${T}Valid=1${T}TMP=QUJDRA==`,
      `FACE PIN=1${T}FID=0${T}SIZE=4${T}VALID=1${T}TMP=QUJDRA==`,
    ].join('\n');
    const r = proto.parseInbound(req('POST', '/iclock/cdata', { SN, table: 'OPERLOG', OpStamp: '77' }, body), ctx);
    expect(r.kind).toBe('user_data');
    expect(r.response.body).toBe('OK: 5');
    expect(r.meta).toEqual({ table: 'OPERLOG', stamp: '77', lines: 5, ignored: 3 });
    expect(r.employees).toEqual([
      { deviceUserId: '1', name: 'Ahmed Al Balushi', cardNumber: '1234567', pin: '1234', privilege: 'admin', enabled: true, photoUrl: null, extra: { protocol: 'iclock', pri: 14, grp: '1', tz: '0000000100000000', verify: '0' } },
      { deviceUserId: '2', name: '2', cardNumber: null, pin: null, privilege: 'user', enabled: true, photoUrl: null, extra: { protocol: 'iclock', pri: 0, grp: '1', tz: null, verify: null } },
    ]);
    expect(JSON.stringify(r)).not.toContain('QUJDRA==');
  });
  it('bounds free-text USER fields kept in extra', () => {
    const [u] = parseOperlogBody(`USER PIN=9${T}Name=Z${T}Grp=${'7'.repeat(500)}${T}TZ=${'1'.repeat(100)}`).employees;
    expect(u?.extra).toMatchObject({ grp: '7'.repeat(64), tz: '1'.repeat(64), verify: null });
  });
  it('rejects USER lines without a PIN; unknown tables are acknowledged without storage', () => {
    expect(() => parseOperlogBody(`USER Name=NoPin${T}Pri=0`)).toThrow(ProtocolError);
    const r = proto.parseInbound(req('POST', '/iclock/cdata', { SN, table: 'ATTPHOTO' }, 'binary...'), ctx);
    expect(r).toMatchObject({ kind: 'unknown', transactions: [], response: { body: 'OK' }, meta: { table: 'ATTPHOTO', ignored: true } });
    expect(() => proto.parseInbound(req('POST', '/iclock/cdata', { SN }, 'x'), ctx)).toThrow(/table/);
  });
});

describe('getrequest / commands / devicecmd', () => {
  it('answers OK when idle and parses INFO', () => {
    const idle = proto.parseInbound(req('GET', '/iclock/getrequest', { SN }), ctx);
    expect(idle).toMatchObject({ kind: 'heartbeat', response: { body: 'OK' } });
    expect(idle.deviceInfo).toBeUndefined();
    const info = proto.parseInbound(req('GET', '/iclock/getrequest', { SN, INFO: 'Ver 6.60,12,30,1500,192.168.1.20,10' }), ctx);
    expect(info.deviceInfo).toMatchObject({ serialNumber: SN, firmwareVersion: 'Ver 6.60', userCount: 12, fingerprintCount: 30, transactionCount: 1500 });
    expect(parseInfoParam('')).toBeUndefined();
  });
  it('renders pending commands one per line and OK when none', () => {
    const employee = { deviceUserId: '42', name: `Fatima${T}Al Harthi with a very long name indeed`, cardNumber: '99', pin: '1234', privilege: 'admin' as const, enabled: true, photoUrl: null, extra: {} };
    const built = proto.buildCommands({ type: 'UPSERT_EMPLOYEE', employee });
    expect(built).toEqual([{ commandType: 'UPSERT_EMPLOYEE', payload: { pin: '42', name: 'Fatima Al Harthi with a', pri: 14, passwd: '1234', card: '99', grp: 1, tz: ZK_DEFAULT_TZ } }]);
    const cmds = [
      { id: '1', ...built[0]! },
      { id: '2', ...proto.buildCommands({ type: 'DELETE_EMPLOYEE', deviceUserId: '7' })[0]! },
      { id: '3', ...proto.buildCommands({ type: 'RESTART' })[0]! },
      { id: '4', ...proto.buildCommands({ type: 'QUERY_USERS' })[0]! },
    ];
    const r = proto.renderCommands(cmds, { serialNumber: SN });
    expect(r.body).toBe([
      `C:1:DATA UPDATE USERINFO PIN=42${T}Name=Fatima Al Harthi with a${T}Pri=14${T}Passwd=1234${T}Card=99${T}Grp=1${T}TZ=${ZK_DEFAULT_TZ}`,
      'C:2:DATA DELETE USERINFO PIN=7',
      'C:3:REBOOT',
      'C:4:DATA QUERY USERINFO',
    ].join('\n') + '\n');
    expect(proto.renderCommands([], { serialNumber: SN }).body).toBe('OK');
    expect(renderCommandLine({ id: 'u1', commandType: 'UPSERT_EMPLOYEE', payload: { deviceUserId: '5', name: 'X', privilege: 'user', cardNumber: null, pin: null } })).toBe(`C:u1:DATA UPDATE USERINFO PIN=5${T}Name=X${T}Pri=0${T}Passwd=${T}Card=${T}Grp=1${T}TZ=${ZK_DEFAULT_TZ}`);
  });
  it('validates command ids and payloads before anything reaches a device', () => {
    const codeOf = (fn: () => unknown): string => { try { fn(); return 'OK'; } catch (e) { return ProviderError.is(e) ? e.code : 'NOT_PROVIDER_ERROR'; } };
    expect(codeOf(() => renderCommandLine({ id: 'has space', commandType: 'RESTART', payload: {} }))).toBe('INVALID_CONFIG');
    expect(codeOf(() => renderCommandLine({ id: '1', commandType: 'FORMAT_DISK', payload: {} }))).toBe('UNSUPPORTED');
    expect(codeOf(() => renderCommandLine({ id: '1', commandType: 'DELETE_EMPLOYEE', payload: { deviceUserId: 'no pin!' } }))).toBe('INVALID_CONFIG');
    expect(codeOf(() => renderCommandLine({ id: '1', commandType: 'UPSERT_EMPLOYEE', payload: { garbage: true } }))).toBe('INVALID_CONFIG');
    expect(codeOf(() => renderCommandLine({ id: '1', commandType: 'UPSERT_EMPLOYEE', payload: { pin: '1', name: 'X', pri: 99, passwd: '', card: '', grp: 1, tz: ZK_DEFAULT_TZ } }))).toBe('INVALID_CONFIG');
    expect(codeOf(() => renderCommandLine({ id: '1', commandType: 'UPSERT_EMPLOYEE', payload: { pin: '1', name: 'X', pri: 0, passwd: 'abc', card: '', grp: 1, tz: ZK_DEFAULT_TZ } }))).toBe('INVALID_CONFIG');
    expect(codeOf(() => renderCommandLine({ id: '1', commandType: 'UPSERT_EMPLOYEE', payload: { pin: '1', name: 'X', pri: 0, passwd: '', card: '', grp: 1, tz: 'short' } }))).toBe('INVALID_CONFIG');
    const base = { name: 'Ok', privilege: 'user' as const, enabled: true, photoUrl: null, extra: {} };
    expect(codeOf(() => proto.buildCommands({ type: 'UPSERT_EMPLOYEE', employee: { ...base, deviceUserId: 'not valid' } }))).toBe('INVALID_CONFIG');
    expect(codeOf(() => proto.buildCommands({ type: 'UPSERT_EMPLOYEE', employee: { ...base, deviceUserId: '1', pin: 'abcd' } }))).toBe('INVALID_CONFIG');
    expect(codeOf(() => proto.buildCommands({ type: 'UPSERT_EMPLOYEE', employee: { ...base, deviceUserId: '1', cardNumber: 'ABC' } }))).toBe('INVALID_CONFIG');
    expect(codeOf(() => proto.buildCommands({ type: 'UPSERT_EMPLOYEE', employee: { ...base, deviceUserId: '1', name: ' ' } }))).toBe('INVALID_CONFIG');
    expect(codeOf(() => proto.buildCommands({ type: 'DELETE_EMPLOYEE', deviceUserId: '' }))).toBe('INVALID_CONFIG');
  });
  it('parses devicecmd results', () => {
    const r = proto.parseInbound(req('POST', '/iclock/devicecmd', { SN }, 'ID=1&Return=0&CMD=DATA\nID=2&Return=-1&CMD=REBOOT\r\n'), ctx);
    expect(r.kind).toBe('command_result');
    expect(r.commandResults).toEqual([{ commandId: '1', ok: true, message: 'Return=0 CMD=DATA' }, { commandId: '2', ok: false, message: 'Return=-1 CMD=REBOOT' }]);
    expect(r.response.body).toBe('OK');
    expect(parseDeviceCmdBody('')).toEqual([]);
    expect(() => parseDeviceCmdBody('Return=0')).toThrow(ProtocolError);
    expect(() => parseDeviceCmdBody('ID=1&Return=ok')).toThrow(ProtocolError);
  });
  it('is strict about routes, methods and serial mismatches', () => {
    expect(() => proto.parseInbound(req('GET', '/iclock/cdata', {}), ctx)).toThrow(/SN/);
    expect(() => proto.parseInbound(req('GET', '/iclock/cdata', { SN: 'OTHER' }), ctx)).toThrow(/mismatch/);
    expect(() => proto.parseInbound(req('POST', '/iclock/getrequest', { SN }), ctx)).toThrow(ProtocolError);
    expect(() => proto.parseInbound(req('GET', '/iclock/devicecmd', { SN }), ctx)).toThrow(ProtocolError);
    const notFound = (() => { try { proto.parseInbound(req('GET', '/somewhere', { SN }), ctx); return undefined; } catch (e) { return e as ProtocolError; } })();
    expect(notFound?.httpStatus).toBe(404);
    expect(proto.parseInbound(req('GET', '/iclock/ping', { SN }), ctx)).toMatchObject({ kind: 'unknown', response: { body: 'OK' } });
  });
});

describe('ZKTecoPushProvider', () => {
  const now = new Date('2026-03-15T10:00:00Z');
  const provider = new ZKTecoPushProvider({ clock: () => now });
  const employee = { deviceUserId: '12', name: 'Salim', cardNumber: null, pin: null, privilege: 'user' as const, enabled: true, photoUrl: null, extra: {} };

  it('testConnection/status depend on lastSeenAt', async () => {
    const cold = createTestProviderContext({ serialNumber: SN, config: { serialNumber: SN } });
    expect(await provider.testConnection(cold)).toMatchObject({ ok: false, message: PUSH_NOT_VERIFIED_MESSAGE });
    expect(await provider.getDeviceStatus(cold)).toMatchObject({ online: false });
    const warm = createTestProviderContext({ serialNumber: SN, config: { serialNumber: SN, lastSeenAt: '2026-03-15T09:59:00Z' } });
    expect(await provider.testConnection(warm)).toMatchObject({ ok: true, message: 'Device contacted FlowZa 60s ago', deviceInfo: { serialNumber: SN } });
    expect(await provider.getDeviceStatus(warm)).toMatchObject({ online: true, lastSeenAt: '2026-03-15T09:59:00Z' });
    const stale = createTestProviderContext({ serialNumber: SN, config: { lastSeenAt: '2026-03-15T09:00:00Z', pushInterval: 30 } });
    expect((await provider.testConnection(stale)).ok).toBe(false);
    const wideInterval = createTestProviderContext({ serialNumber: SN, config: { lastSeenAt: '2026-03-15T09:00:00Z', pushInterval: 3600 } });
    expect((await provider.testConnection(wideInterval)).ok).toBe(true);
    const stringInterval = createTestProviderContext({ serialNumber: SN, config: { lastSeenAt: '2026-03-15T09:00:00Z', pushInterval: '3600' } });
    expect((await provider.testConnection(stringInterval)).ok).toBe(true); // wizard config values may arrive as strings
    const garbage = createTestProviderContext({ serialNumber: SN, config: { lastSeenAt: 'yesterday' } });
    expect((await provider.getDeviceStatus(garbage)).online).toBe(false);
    expect(await provider.getDeviceInfo(cold)).toMatchObject({ serialNumber: SN });
    expect((await provider.getCapabilities(cold)).devicePush).toBe(true);
  });
  it('queues protocol commands for outbound operations (async results)', async () => {
    const c = createTestProviderContext({ serialNumber: SN });
    const up = await provider.upsertEmployee(c, employee);
    expect(up).toMatchObject({ ok: true, async: true, deviceUserId: '12', details: { protocolKey: 'iclock', commands: [{ commandType: 'UPSERT_EMPLOYEE', payload: { pin: '12', name: 'Salim' } }] } });
    expect(await provider.deleteEmployee(c, '12')).toMatchObject({ ok: true, async: true, details: { commands: [{ commandType: 'DELETE_EMPLOYEE', payload: { deviceUserId: '12' } }] } });
    expect(await provider.restart(c)).toMatchObject({ ok: true, async: true, details: { commands: [{ commandType: 'RESTART' }] } });
    await expect(provider.upsertEmployee(c, { ...employee, deviceUserId: 'bad id' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });
  it('refuses to pull attendance or list employees synchronously (honest UNSUPPORTED)', async () => {
    const c = createTestProviderContext({ serialNumber: SN });
    await expect(provider.pullAttendance(c, null)).rejects.toMatchObject({ code: 'UNSUPPORTED', retryable: false });
    const err = await provider.listEmployees(c, null).catch((e: unknown) => e);
    expect(ProviderError.is(err) && err.code === 'UNSUPPORTED').toBe(true);
    expect((err as ProviderError).details).toMatchObject({ async: true, commands: [{ commandType: 'QUERY_USERS' }] });
  });
});

describeProviderConformance('zkteco_push', () => ({
  provider: new ZKTecoPushProvider(),
  ctx: createTestProviderContext({ serialNumber: SN }),
  sampleEmployee: { deviceUserId: '1', name: 'Conformance', cardNumber: null, pin: null, privilege: 'user', enabled: true, photoUrl: null, extra: {} },
}), { describe, it });
