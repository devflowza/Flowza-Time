import { describe, expect, it } from 'vitest';
import { rawTransactionSchema } from '@flowza/contracts';
import { describeProviderConformance } from '../../conformance.js';
import { ProtocolError } from '../../errors.js';
import { createTestProviderContext } from '../../testing.js';
import { ProviderError } from '../../types.js';
import { createHikvisionPushProtocol, decodeBody, HIKVISION_MAX_REQUESTS_PER_MINUTE, HIKVISION_PROTOCOL_KEY, mapEvent, parseEventXml, serialFromRequest } from './push-protocol.js';
import { HIKVISION_PUSH_NOT_VERIFIED_MESSAGE, HikvisionPushProvider } from './provider.js';

const SN = 'DS-K1T341AMF20230101V030500ENK12345678';
const ctx = { timezone: 'Asia/Muscat', serialNumber: SN };
const proto = createHikvisionPushProtocol();
const req = (method: string, rawBody = '', headers: Record<string, string> = {}, path = `/hikvision/${SN}`, query: Record<string, string> = {}) => ({ method, path, query, headers, rawBody });

/** Shape posted by MinMoe firmware V3.x (public ISAPI examples); name and FaceRect must never reach the raw payload. */
function faceEvent(overrides: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    ipAddress: '192.168.1.64', portNo: 80, protocol: 'HTTP', macAddress: 'a4:d5:c2:00:11:22', channelID: 1,
    dateTime: '2026-03-10T08:02:11+04:00', activePostCount: 1, eventType: 'AccessControllerEvent', eventState: 'active', eventDescription: 'Access Controller Event',
    AccessControllerEvent: {
      deviceName: 'Main entrance', majorEventType: 5, subEventType: 75, name: 'Aisha Al Balushi', cardReaderKind: 1, cardReaderNo: 1, verifyNo: 176,
      employeeNoString: '1001', serialNo: 4521, userType: 'normal', currentVerifyMode: 'cardOrFace', attendanceStatus: 'checkIn', label: 'Check In', mask: 'no',
      picturesNumber: 1, FaceRect: { height: 0.3, width: 0.2, x: 0.4, y: 0.2 }, ...overrides,
    },
    ...top,
  };
}
const JSON_HEADERS = { 'content-type': 'application/json' };
const multipart = (json: string, boundary = 'MIME_boundary', picture = true) => [
  `--${boundary}`, 'Content-Disposition: form-data; name="event_log"', 'Content-Type: application/json', `Content-Length: ${json.length}`, '', json,
  ...(picture ? [`--${boundary}`, 'Content-Disposition: form-data; name="Picture"; filename="Picture.jpg"', 'Content-Type: image/jpeg', '', 'ÿØÿà binary face picture \u0000\u0001'] : []),
  `--${boundary}--`, '',
].join('\r\n');

describe('hikvision identification', () => {
  it('takes the serial from the path segment after the protocol key (query as fallback)', () => {
    expect(serialFromRequest({ path: `/hikvision/${SN}`, query: {} })).toBe(SN);
    expect(serialFromRequest({ path: `/hikvision/${SN}/`, query: {} })).toBe(SN);
    expect(serialFromRequest({ path: '/hikvision', query: { SN } })).toBe(SN);
    expect(serialFromRequest({ path: '/hikvision/bad%20serial', query: {} })).toBeNull();
    expect(serialFromRequest({ path: '/hikvision/%E0%A4%A', query: {} })).toBeNull();
    expect(serialFromRequest({ path: '/hikvision', query: {} })).toBeNull();
    expect(proto.identifyDevice(req('POST', '', JSON_HEADERS))).toEqual({ serialNumber: SN, extra: { format: 'application/json' } });
    expect(proto.protocolKey).toBe(HIKVISION_PROTOCOL_KEY);
    expect(proto.maxRequestsPerMinute).toBe(HIKVISION_MAX_REQUESTS_PER_MINUTE);
    expect(proto.pushPath?.(SN)).toBe(`/${SN}`);
  });
});

describe('hikvision event → punch', () => {
  it('maps a face-pass event (JSON body) to a UTC punch with an allowlisted raw payload', () => {
    const r = proto.parseInbound(req('POST', JSON.stringify(faceEvent()), JSON_HEADERS), ctx);
    expect(r.kind).toBe('attendance');
    expect(r.response.status).toBe(200);
    expect(JSON.parse(r.response.body)).toMatchObject({ statusCode: 1, statusString: 'OK' });
    expect(r.transactions).toHaveLength(1);
    const tx = r.transactions[0]!;
    expect(rawTransactionSchema.safeParse(tx).success).toBe(true);
    expect(tx).toMatchObject({ providerTransactionId: '4521', deviceEmployeeId: '1001', punchedAt: '2026-03-10T04:02:11Z', deviceLocalTime: '2026-03-10T08:02:11+04:00', verificationMethod: 'face', direction: 'in' });
    const raw = JSON.stringify(tx.rawPayload);
    expect(raw).not.toContain('Aisha');
    expect(raw).not.toContain('FaceRect');
    expect(raw).not.toContain('192.168');
    expect(r.meta).toMatchObject({ format: 'json', events: 1, punches: 1, pictures: 0 });
  });

  it('reads the JSON part of a multipart post and discards the picture', () => {
    const body = multipart(JSON.stringify(faceEvent({ attendanceStatus: 'checkOut', subEventType: 38 })));
    const r = proto.parseInbound(req('POST', body, { 'content-type': 'multipart/form-data; boundary=MIME_boundary' }), ctx);
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]).toMatchObject({ verificationMethod: 'fingerprint', direction: 'out' });
    expect(r.meta).toMatchObject({ format: 'multipart', pictures: 1 });
    expect(JSON.stringify(r)).not.toContain('binary face picture');
  });

  it('sniffs the boundary when the header omits it', () => {
    const d = decodeBody(multipart(JSON.stringify(faceEvent()), 'xyz123', false), 'multipart/form-data');
    expect(d.documents).toHaveLength(1);
    expect(d.format).toBe('multipart');
  });

  it('interprets offset-less times in the device timezone and maps statuses/methods', () => {
    const r = mapEvent(faceEvent({ subEventType: 1, attendanceStatus: 'breakOut' }, { dateTime: '2026-03-10 13:00:00' }), 'Asia/Muscat', SN);
    expect(r).toMatchObject({ kind: 'punch', transaction: { punchedAt: '2026-03-10T09:00:00Z', verificationMethod: 'card', direction: 'break_out' } });
    const u = mapEvent(faceEvent({ attendanceStatus: 'undefined' }), 'Asia/Muscat', SN);
    expect(u).toMatchObject({ kind: 'punch', transaction: { direction: 'unknown' } });
    const numeric = mapEvent(faceEvent({ employeeNoString: undefined, employeeNo: 77, serialNo: undefined }), 'Asia/Muscat', SN);
    expect(numeric).toMatchObject({ kind: 'punch', transaction: { deviceEmployeeId: '77', providerTransactionId: null } });
  });

  it('ignores failed verifications, door events, strangers and non-access events (acknowledged, nothing stored)', () => {
    expect(mapEvent(faceEvent({ subEventType: 76 }), 'UTC', SN)).toEqual({ kind: 'ignored', reason: 'not_pass_event' });  // face verify failed
    expect(mapEvent(faceEvent({ majorEventType: 2, subEventType: 1024 }), 'UTC', SN)).toEqual({ kind: 'ignored', reason: 'not_pass_event' }); // exception
    expect(mapEvent(faceEvent({ employeeNoString: '' }), 'UTC', SN)).toEqual({ kind: 'ignored', reason: 'no_employee' });
    expect(mapEvent({ eventType: 'doorStatus' }, 'UTC', SN)).toEqual({ kind: 'ignored', reason: 'not_access_event' });
    const r = proto.parseInbound(req('POST', JSON.stringify(faceEvent({ subEventType: 21 })), JSON_HEADERS), ctx); // door unlocked
    expect(r.kind).toBe('unknown');
    expect(r.transactions).toEqual([]);
    expect(r.response.status).toBe(200);
    expect(r.meta).toMatchObject({ ignored: { not_pass_event: 1 } });
  });

  it('treats heartbeats and GET probes as liveness', () => {
    expect(proto.parseInbound(req('POST', JSON.stringify({ eventType: 'heartBeat', dateTime: '2026-03-10T08:00:00+04:00' }), JSON_HEADERS), ctx).kind).toBe('heartbeat');
    const probe = proto.parseInbound(req('GET'), ctx);
    expect(probe.kind).toBe('heartbeat');
    expect(probe.response.status).toBe(200);
  });

  it('parses EventNotificationAlert XML (older firmware) without expanding entities', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<EventNotificationAlert version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<ipAddress>10.0.0.5</ipAddress><dateTime>2026-03-10T17:31:00+04:00</dateTime><activePostCount>1</activePostCount>
<eventType>AccessControllerEvent</eventType><eventState>active</eventState>
<AccessControllerEvent><deviceName>Gate &amp; Lobby</deviceName><majorEventType>5</majorEventType><subEventType>75</subEventType>
<employeeNoString>A-17</employeeNoString><serialNo>99</serialNo><attendanceStatus>checkOut</attendanceStatus></AccessControllerEvent>
</EventNotificationAlert>`;
    expect(parseEventXml(xml)).toMatchObject({ eventType: 'AccessControllerEvent', AccessControllerEvent: { deviceName: 'Gate & Lobby', majorEventType: 5, subEventType: 75, serialNo: 99 } });
    const r = proto.parseInbound(req('POST', xml, { 'content-type': 'application/xml' }), ctx);
    expect(r.transactions[0]).toMatchObject({ deviceEmployeeId: 'A-17', punchedAt: '2026-03-10T13:31:00Z', direction: 'out', providerTransactionId: '99' });
    expect(() => parseEventXml('<!DOCTYPE x [<!ENTITY a "b">]><EventNotificationAlert/>')).toThrow(ProtocolError);
  });

  it('rejects malformed input as a protocol error', () => {
    expect(() => proto.parseInbound(req('POST', '{not json', JSON_HEADERS), ctx)).toThrow(ProtocolError);
    expect(() => proto.parseInbound(req('POST', 'plain text', { 'content-type': 'text/plain' }), ctx)).toThrow(ProtocolError);
    expect(() => proto.parseInbound(req('POST', JSON.stringify(faceEvent({ employeeNoString: 'bad id!' })), JSON_HEADERS), ctx)).toThrow(ProtocolError);
    expect(() => proto.parseInbound(req('POST', JSON.stringify(faceEvent({}, { dateTime: undefined })), JSON_HEADERS), ctx)).toThrow(ProtocolError);
    expect(() => proto.parseInbound(req('POST', JSON.stringify(faceEvent()), JSON_HEADERS, '/hikvision/OTHER'), ctx)).toThrow(/mismatch/);
    expect(() => proto.parseInbound(req('DELETE'), ctx)).toThrow(ProtocolError);
    expect(() => proto.parseInbound(req('POST', 'x'.repeat(2 * 1024 * 1024 + 1), JSON_HEADERS), ctx)).toThrow(/too large/);
  });

  it('is one-way: no commands can be built or rendered', () => {
    expect(proto.renderCommands([], { serialNumber: SN }).status).toBe(200);
    expect(() => proto.renderCommands([{ id: '1', commandType: 'RESTART', payload: {} }], { serialNumber: SN })).toThrow(ProviderError);
    expect(() => proto.buildCommands({ type: 'QUERY_USERS' })).toThrow(ProviderError);
  });
});

describe('HikvisionPushProvider', () => {
  const now = new Date('2026-03-10T12:00:00Z');
  const provider = new HikvisionPushProvider({ clock: () => now });
  it('is verified by a recent post and reports liveness from config.lastSeenAt', async () => {
    const never = await provider.testConnection(createTestProviderContext({ serialNumber: SN }));
    expect(never).toMatchObject({ ok: false, message: HIKVISION_PUSH_NOT_VERIFIED_MESSAGE });
    const seen = createTestProviderContext({ serialNumber: SN, config: { lastSeenAt: '2026-03-10T11:59:00Z' } });
    expect(await provider.testConnection(seen)).toMatchObject({ ok: true });
    expect(await provider.getDeviceStatus(seen)).toMatchObject({ online: true, lastSeenAt: '2026-03-10T11:59:00Z' });
    const stale = createTestProviderContext({ serialNumber: SN, config: { lastSeenAt: '2026-03-08T11:59:00Z' } });
    expect((await provider.getDeviceStatus(stale)).online).toBe(false);
  });
});

describeProviderConformance('hikvision_push', () => ({
  provider: new HikvisionPushProvider(),
  ctx: createTestProviderContext({ serialNumber: SN }),
}), { describe, it });
