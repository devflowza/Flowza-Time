import type { PunchDirection, RawTransaction, VerificationMethod } from '@flowza/contracts';
import { ProtocolError } from '../../errors.js';
import { assertBodySize, boundedText, headerValue, parseDeviceTime, queryValue, toIsoUtc } from '../../protocol-utils.js';
import { ProviderError, type DevicePushInbound, type DevicePushParseContext, type DevicePushProtocolHandler, type DevicePushRequest, type DevicePushResponse } from '../../types.js';

/**
 * Hikvision ISAPI event push ("HTTP Listening" / HTTP host notification) handler.
 *
 * VERIFICATION STATUS: REPORTED. The payload layout (EventNotificationAlert, AccessControllerEvent, major/minor event codes,
 * attendanceStatus values) is taken from the public ISAPI access-control documentation and open-source integrations, NOT from
 * hardware tests. Confirm on real terminals (MinMoe DS-K1T341/342/343/671/680 …, per firmware) before promoting the provider from
 * `beta`; record findings in docs/device-integrations.md.
 *
 * Device configuration (web UI: Network → Network Service → HTTP(S) Listening, or Configuration → Event → Alarm Server):
 *   host/port of FlowZa's public API, URL = `/device-push/hikvision/~<push token>/<serial number>`, protocol HTTP(S), JSON format.
 * The device then POSTs one request per event:
 *   - `multipart/form-data` with a JSON part (`event_log` / `AccessControllerEvent`) and, when picture upload is on, a JPEG part
 *     (the picture is discarded, never stored), or
 *   - a bare `application/json` body, or
 *   - on older firmware an `EventNotificationAlert` XML document.
 * Only successful authentications (major type 5 "Event", minor codes in {@link HIK_PASS_EVENTS}) carrying an Employee ID become
 * punches; door/alarm/operation events and failed verifications are acknowledged and dropped (counted in `meta`).
 *
 * Identity: the serial number travels in the URL path (the event body carries only IP/MAC), and the route authenticates the
 * request with the per-device push token embedded in the same URL (`/~<token>`), exactly like the iclock protocol.
 */
export const HIKVISION_PROTOCOL_KEY = 'hikvision';

/** One access-control event per request, plus up to a few hundred KB of face picture that we discard (2 MiB = the route cap). */
export const HIKVISION_MAX_BODY_BYTES = 2 * 1024 * 1024;
/**
 * A single punch produces several posts (authentication pass, door unlocked, door opened, door closed), so a terminal at a busy
 * entrance legitimately exceeds the generic 60 requests/minute per serial. A refused post may be dropped by the firmware.
 */
export const HIKVISION_MAX_REQUESTS_PER_MINUTE = 600;

/** ISAPI major event type "Event" (access-control authentication results live here). */
export const HIK_MAJOR_EVENT = 5;

/**
 * REPORTED: minor event codes (major 5) that mean "authentication passed", with the credential that passed. Taken from the
 * HCNetSDK `MINOR_*` access-control constants (…_PASS / …_VERIFY_PASS). Failures, time-outs, "no permission" and door events are
 * deliberately absent: they are not attendance.
 */
export const HIK_PASS_EVENTS: Readonly<Record<number, VerificationMethod>> = {
  0x01: 'card',        // MINOR_LEGAL_CARD_PASS
  0x02: 'card',        // MINOR_CARD_AND_PSW_PASS
  0x10: 'unknown',     // MINOR_MULTI_VERIFY_SUCCESS
  0x26: 'fingerprint', // MINOR_FINGERPRINT_COMPARE_PASS
  0x28: 'fingerprint', // MINOR_CARD_FINGERPRINT_VERIFY_PASS
  0x2b: 'fingerprint', // MINOR_CARD_FINGERPRINT_PASSWD_VERIFY_PASS
  0x2e: 'fingerprint', // MINOR_FINGERPRINT_PASSWD_VERIFY_PASS
  0x36: 'face',        // MINOR_FACE_AND_FP_VERIFY_PASS
  0x39: 'face',        // MINOR_FACE_AND_PW_VERIFY_PASS
  0x3c: 'face',        // MINOR_FACE_AND_CARD_VERIFY_PASS
  0x3f: 'face',        // MINOR_FACE_AND_PW_AND_FP_VERIFY_PASS
  0x42: 'face',        // MINOR_FACE_CARD_AND_FP_VERIFY_PASS
  0x45: 'fingerprint', // MINOR_EMPLOYEENO_AND_FP_VERIFY_PASS
  0x48: 'fingerprint', // MINOR_EMPLOYEENO_AND_FP_AND_PW_VERIFY_PASS
  0x4b: 'face',        // MINOR_FACE_VERIFY_PASS
  0x4d: 'face',        // MINOR_EMPLOYEENO_AND_FACE_VERIFY_PASS
  0x68: 'password',    // MINOR_EMPLOYEENO_AND_PW_PASS
};

/** REPORTED: `attendanceStatus` (set when the terminal runs in attendance mode / the user picks a status key). */
export const HIK_ATTENDANCE_STATUS: Readonly<Record<string, PunchDirection>> = {
  checkIn: 'in', checkOut: 'out', breakOut: 'break_out', breakIn: 'break_in', overtimeIn: 'overtime_in', overtimeOut: 'overtime_out',
};

const SERIAL_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const EMPLOYEE_NO_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_RAW_FIELD = 64;
const MAX_EVENTS_PER_REQUEST = 500;
const HEARTBEAT_EVENT_TYPES: ReadonlySet<string> = new Set(['heartbeat', 'videoloss']);

/** The ISAPI `ResponseStatus` a listening server answers with; any 2xx is taken as "delivered" by the firmware. */
const OK_BODY = JSON.stringify({ requestURL: '', statusCode: 1, statusString: 'OK', subStatusCode: 'ok' });
const ok = (): DevicePushResponse => ({ status: 200, body: OK_BODY, headers: { 'content-type': 'application/json; charset=utf-8' } });

/** `/hikvision/<serial>[/…]` → serial (the route has already stripped the `~token` segment). `?SN=` is accepted as a fallback. */
export function serialFromRequest(req: Pick<DevicePushRequest, 'path' | 'query'>): string | null {
  const segments = (req.path.split('?')[0] ?? '').split('/').filter((s) => s.length > 0);
  const at = segments.indexOf(HIKVISION_PROTOCOL_KEY);
  const candidate = (at >= 0 ? segments[at + 1] : undefined) ?? queryValue(req.query, 'SN') ?? queryValue(req.query, 'serial');
  if (candidate === undefined) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(candidate); } catch { return null; }
  return SERIAL_PATTERN.test(decoded) ? decoded : null;
}

// ----- body decoding --------------------------------------------------------------------------------------------------------

export interface DecodedBody { format: 'json' | 'xml' | 'multipart' | 'empty'; documents: unknown[]; pictures: number; ignoredParts: number }

function boundaryOf(contentType: string | undefined): string | null {
  if (!contentType || !/^multipart\//i.test(contentType.trim())) return null;
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const b = m?.[1] ?? m?.[2];
  return b && b.length <= 200 ? b : null;
}

/** Some firmware omits the boundary header parameter; the body then starts with `--<boundary>`. */
function sniffBoundary(body: string): string | null {
  const m = /^\s*--([^\r\n]{1,200})\r?\n/.exec(body);
  return m?.[1] ?? null;
}

function parsePart(raw: string): { headers: Record<string, string>; content: string } {
  const sep = /\r?\n\r?\n/.exec(raw);
  const head = sep ? raw.slice(0, sep.index) : '';
  const content = sep ? raw.slice(sep.index + sep[0].length) : raw;
  const headers: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const c = line.indexOf(':');
    if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
  }
  return { headers, content: content.replace(/\r?\n$/, '') };
}

function decodeDocument(text: string): { kind: 'json' | 'xml'; doc: unknown } | null {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return { kind: 'json', doc: JSON.parse(t) as unknown }; } catch { throw new ProtocolError('Event body is not valid JSON'); }
  }
  if (t.startsWith('<')) return { kind: 'xml', doc: parseEventXml(t) };
  return null;
}

/** Splits the request into event documents; picture/binary parts are counted and dropped (they may contain faces). */
export function decodeBody(rawBody: string, contentType: string | undefined): DecodedBody {
  if (rawBody.trim().length === 0) return { format: 'empty', documents: [], pictures: 0, ignoredParts: 0 };
  const boundary = boundaryOf(contentType) ?? (/^\s*--/.test(rawBody) ? sniffBoundary(rawBody) : null);
  if (boundary === null) {
    const d = decodeDocument(rawBody);
    if (d === null) throw new ProtocolError('Unsupported event body (expected JSON, XML or multipart/form-data)', { details: { contentType: contentType ?? null } });
    return { format: d.kind, documents: [d.doc], pictures: 0, ignoredParts: 0 };
  }
  const documents: unknown[] = [];
  let pictures = 0;
  let ignoredParts = 0;
  for (const chunk of rawBody.split(`--${boundary}`)) {
    if (chunk.trim() === '' || chunk.trim() === '--') continue;
    const part = parsePart(chunk.replace(/^\r?\n/, ''));
    const type = (part.headers['content-type'] ?? '').toLowerCase();
    if (type.startsWith('image/') || /filename=/i.test(part.headers['content-disposition'] ?? '')) { pictures += 1; continue; }
    const d = type === '' || type.includes('json') || type.includes('xml') || type.startsWith('text/') ? decodeDocument(part.content) : null;
    if (d === null) { ignoredParts += 1; continue; }
    documents.push(d.doc);
  }
  if (documents.length === 0 && pictures === 0 && ignoredParts === 0) throw new ProtocolError('Empty multipart body');
  return { format: 'multipart', documents, pictures, ignoredParts };
}

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXmlText = (s: string): string => s.replace(/&(amp|lt|gt|quot|apos);/g, (_m, e: string) => XML_ENTITIES[e] ?? '');
const LEAF = /<([A-Za-z][A-Za-z0-9_]{0,63})(?:\s[^>]*)?>([^<]*)<\/\1>/g;

function leaves(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of xml.matchAll(LEAF)) { const k = m[1] ?? ''; if (!(k in out)) out[k] = decodeXmlText((m[2] ?? '').trim()); }
  return out;
}

/**
 * Flattens an `EventNotificationAlert` XML document into the JSON shape (top-level leaves + an `AccessControllerEvent` object).
 * Only leaf text elements are read — no DTDs, no entity expansion beyond the five predefined ones, no attributes.
 */
export function parseEventXml(xml: string): Record<string, unknown> {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new ProtocolError('XML documents with DTDs are not accepted');
  const inner = /<AccessControllerEvent(?:\s[^>]*)?>([\s\S]*?)<\/AccessControllerEvent>/.exec(xml);
  const outer = inner ? xml.replace(inner[0], '') : xml;
  const top: Record<string, unknown> = leaves(outer);
  if (inner) {
    const ace: Record<string, unknown> = leaves(inner[1] ?? '');
    for (const k of ['majorEventType', 'subEventType', 'serialNo', 'employeeNo']) if (typeof ace[k] === 'string' && /^\d{1,12}$/.test(ace[k] as string)) ace[k] = Number(ace[k]);
    top.AccessControllerEvent = ace;
  }
  return top;
}

// ----- event mapping --------------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);
const int = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d{1,12}$/.test(v.trim())) return Number(v.trim());
  return undefined;
};

export type HikEventOutcome =
  | { kind: 'punch'; transaction: RawTransaction }
  | { kind: 'heartbeat' }
  | { kind: 'ignored'; reason: 'not_access_event' | 'not_pass_event' | 'no_employee' };

function employeeNoOf(ace: Json): string | undefined {
  const s = str(ace.employeeNoString)?.trim() || str(ace.employeeNo)?.trim();
  if (!s || s === '0') return undefined;
  return s;
}

/** Maps one event document to a punch (successful authentication with an Employee ID), a heartbeat, or an ignored event. */
export function mapEvent(doc: unknown, timezone: string, serialNumber: string): HikEventOutcome {
  if (!isObject(doc)) throw new ProtocolError('Event document must be a JSON object');
  const eventType = str(doc.eventType) ?? '';
  if (HEARTBEAT_EVENT_TYPES.has(eventType.toLowerCase())) return { kind: 'heartbeat' };
  const ace = doc.AccessControllerEvent;
  if (eventType !== 'AccessControllerEvent' || !isObject(ace)) return { kind: 'ignored', reason: 'not_access_event' };
  const major = int(ace.majorEventType);
  const minor = int(ace.subEventType);
  const method = major === HIK_MAJOR_EVENT && minor !== undefined ? HIK_PASS_EVENTS[minor] : undefined;
  if (method === undefined) return { kind: 'ignored', reason: 'not_pass_event' };
  const employeeNo = employeeNoOf(ace);
  if (employeeNo === undefined) return { kind: 'ignored', reason: 'no_employee' };
  if (!EMPLOYEE_NO_PATTERN.test(employeeNo)) throw new ProtocolError('Invalid employeeNo in access-control event', { details: { subEventType: minor } });
  const time = str(doc.dateTime) ?? str(ace.dateTime);
  if (time === undefined) throw new ProtocolError('Access-control event without dateTime');
  const at = parseDeviceTime(time, timezone);
  const status = str(ace.attendanceStatus);
  const serialNo = int(ace.serialNo);
  return {
    kind: 'punch',
    transaction: {
      // the device's own event sequence number: unique per (device, punched_at) in the raw table's provider-id index
      providerTransactionId: serialNo !== undefined ? String(serialNo) : null,
      deviceEmployeeId: employeeNo,
      punchedAt: toIsoUtc(at),
      deviceLocalTime: time.slice(0, 64),
      verificationMethod: method,
      direction: status !== undefined ? HIK_ATTENDANCE_STATUS[status] ?? 'unknown' : 'unknown',
      // allowlist only: no name, no picture URL, no face rectangle, no card number
      rawPayload: {
        protocol: HIKVISION_PROTOCOL_KEY, serialNumber, eventType, majorEventType: major ?? null, subEventType: minor ?? null, serialNo: serialNo ?? null,
        employeeNo, attendanceStatus: boundedText(status, MAX_RAW_FIELD), currentVerifyMode: boundedText(str(ace.currentVerifyMode), MAX_RAW_FIELD),
        userType: boundedText(str(ace.userType), MAX_RAW_FIELD), cardReaderNo: int(ace.cardReaderNo) ?? null, doorNo: int(ace.doorNo) ?? null,
        mask: boundedText(str(ace.mask), MAX_RAW_FIELD), dateTime: time.slice(0, 64), activePostCount: int(doc.activePostCount) ?? null,
      },
    },
  };
}

// ----- handler --------------------------------------------------------------------------------------------------------------

export function createHikvisionPushProtocol(): DevicePushProtocolHandler {
  return {
    protocolKey: HIKVISION_PROTOCOL_KEY,
    maxRequestsPerMinute: HIKVISION_MAX_REQUESTS_PER_MINUTE,
    pushPath: (serialNumber) => `/${encodeURIComponent(serialNumber)}`,

    identifyDevice(req) {
      const sn = serialFromRequest(req);
      return sn === null ? null : { serialNumber: sn, extra: { format: headerValue(req.headers, 'content-type')?.split(';')[0]?.trim() ?? null } };
    },

    parseInbound(req: DevicePushRequest, ctx: DevicePushParseContext): DevicePushInbound {
      const sn = serialFromRequest(req);
      if (sn === null) throw new ProtocolError('Missing or invalid serial number in the push URL');
      if (sn !== ctx.serialNumber) throw new ProtocolError('Serial number mismatch between request and context', { details: { expected: ctx.serialNumber } });
      assertBodySize(req.rawBody, HIKVISION_MAX_BODY_BYTES);
      const method = req.method.toUpperCase();
      // the "Test" button of some firmware probes the URL with GET/HEAD: answer so the admin sees a success, and count it as liveness
      if (method === 'GET' || method === 'HEAD') return { kind: 'heartbeat', transactions: [], response: ok(), meta: { probe: true } };
      if (method !== 'POST' && method !== 'PUT') throw new ProtocolError(`${method} is not valid for the Hikvision listener`, { httpStatus: 405 });

      const body = decodeBody(req.rawBody, headerValue(req.headers, 'content-type'));
      const docs = body.documents.flatMap((d) => (Array.isArray(d) ? d : [d]));
      if (docs.length > MAX_EVENTS_PER_REQUEST) throw new ProtocolError(`Too many events in one request (${docs.length} > ${MAX_EVENTS_PER_REQUEST})`, { httpStatus: 413 });
      const transactions: RawTransaction[] = [];
      const ignored: Record<string, number> = {};
      let heartbeats = 0;
      for (const doc of docs) {
        const outcome = mapEvent(doc, ctx.timezone, sn);
        if (outcome.kind === 'punch') transactions.push(outcome.transaction);
        else if (outcome.kind === 'heartbeat') heartbeats += 1;
        else ignored[outcome.reason] = (ignored[outcome.reason] ?? 0) + 1;
      }
      const meta = { format: body.format, events: docs.length, punches: transactions.length, heartbeats, ignored, pictures: body.pictures, ignoredParts: body.ignoredParts };
      if (transactions.length > 0) return { kind: 'attendance', transactions, response: ok(), meta };
      // Event-only traffic: liveness, never a command poll — the firmware cannot receive commands on this channel.
      return { kind: heartbeats > 0 ? 'heartbeat' : 'unknown', transactions: [], response: ok(), meta };
    },

    renderCommands(commands) {
      if (commands.length === 0) return ok();
      throw new ProviderError('UNSUPPORTED', 'Hikvision HTTP Listening is one-way: the device cannot receive commands on this channel', { retryable: false, details: { commandTypes: commands.map((c) => c.commandType) } });
    },

    buildCommands(op) {
      throw new ProviderError('UNSUPPORTED', `${op.type} is not supported over Hikvision HTTP Listening (enrol users on the device or via Hik-Central)`, { retryable: false, details: { operation: op.type } });
    },
  };
}
