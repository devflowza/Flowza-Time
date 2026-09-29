import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type { DeviceCapabilities, DeviceEmployee, PunchDirection, RawTransaction, VerificationMethod } from '@flowza/contracts';
import { unsupported } from '../../errors.js';
import { boundedText, parseDeviceTime, toIsoUtc } from '../../protocol-utils.js';
import { ProviderError, type AttendancePullResult, type ConnectionResult, type DeviceEmployeePage, type DeviceInfo, type DeviceOperationResult, type DeviceProvider, type DeviceStatus, type PageCursor, type ProviderContext, type ProviderDefinition, type SyncCursor } from '../../types.js';
import { basicAuthorization, connectionProbe, joinUrl, parseDigestChallenge, requiredString, VendorHttpClient, type VendorHttpOptions, type VendorHttpRequest, type VendorHttpResponse } from '../../vendor-http.js';
import { MATRIX_COSEC_DEFINITION } from './definition.js';

/*
 * Matrix COSEC Device API (DAPI) — `GET https://<controller>/device.cgi/<resource>?action=<get|set|delete|…>&…&format=xml`.
 * Research basis (docs/device-integrations.md §2.7, REPORTED_SECONDARY — no official DAPI document was opened):
 *  - Horilla `biometric/cosec.py` + pycosec `biometric.py` (same code): Basic auth, `&format=xml`, `text/xml` answers whose root holds
 *    either flat fields (`<Response-Code>0</Response-Code>`, user fields…) or repeated `<Events>` records with `roll-over-count`, `seq-No`,
 *    `date` (dd/mm/yyyy), `time` (HH:mm:ss), `event-id`, `detail-1…`; event 101 = "user allowed" is the attendance event; the next page
 *    is requested at (last roll-over-count, last seq-No + 1), at most 100 events; users: `users?action=get|set|delete`, set carries
 *    `user-id`, `ref-user-id`, `name` (≤ 15 chars), `user-active`, `user-pin`, `card1`; the Response-Code table below; the event's
 *    `detail-1` is matched against the device REFERENCE user id; `detail-2` odd = IN / even = OUT.
 *  - saidmtanzania/biometric (PUSH API server, same vocabulary): user-id 1–15 alphanumerics, ref-user-id numeric, PIN 1–6 digits, cards
 *    unsigned 64-bit decimals; event field-2 = special function (1…12 official/short-leave/regular in-out, break, overtime), field-3 =
 *    credential mask (PIN 1, card 2, finger 4, palm 8, group 16, API 32, face 64, BLE 128); cmd 16 = current event sequence number.
 *  - UNVERIFIED (no client uses it): `events?action=getcurrentseqnumber` and its field names; the `date-time?action=get` field names
 *    (taken from the PUSH API date/time config: year/month/date/hour/minute/second); `device-basic-config` field names beyond `app`.
 *    Those reads are tolerant and optional: the adapter never depends on them for correctness, only for the first cursor / clock skew.
 */

const VENDOR = 'Matrix COSEC';
const MAX_EVENTS_PER_PAGE = 100;
/** A first pull starts this many events before the controller's current sequence number (no time filter exists in DAPI). */
export const COSEC_INITIAL_BACKFILL_EVENTS = 1000;
/** …and drops punches older than `since` (default: 30 days before today's local midnight). */
const DEFAULT_LOOKBACK_DAYS = 30;
const ATTENDANCE_EVENT_IDS = new Set(['101']); // "User Allowed" (REPORTED: Horilla/pycosec filter, PUSH API event catalogue)
const MAX_SEQUENCE = 1_000_000_000;
export const COSEC_INVALID_CURSOR_REASON = 'invalid_cursor';

/** COSEC `Response-Code` table (Horilla/pycosec). Our constant text — safe to show; the device's own body is never echoed. */
export const COSEC_RESPONSE_CODES: Readonly<Record<string, string>> = Object.freeze({
  '0': 'Successful', '1': 'Invalid login credentials', '2': 'Date and time manual set failed', '3': 'Invalid date/time', '4': 'Maximum users are already configured',
  '5': 'Image size is too big', '6': 'Image format not supported', '7': 'Card 1 and card 2 are identical', '8': 'Card ID exists', '9': 'Template or face image already exists',
  '10': 'No record found', '11': 'Template size/format mismatch', '12': 'Fingerprint memory full', '13': 'User id not found', '14': 'Credential limit reached',
  '15': 'Reader mismatch / reader not configured', '16': 'Device busy', '17': 'Internal process error', '18': 'PIN already exists', '19': 'Credential not found',
  '20': 'Memory card not found', '21': 'Reference user id exists', '22': 'Wrong selection', '23': 'Palm template mode mismatch', '24': 'Feature not enabled in the configuration',
  '25': 'Message already exists', '26': 'Invalid smart card format', '27': 'Time out', '28': 'Read/write failed', '29': 'Wrong card type', '30': 'Key mismatch', '31': 'Invalid card',
  '32': 'Scan failed', '33': 'Invalid value', '34': 'Credential does not match', '35': 'Failure', '36': 'Face not detected', '37': 'User conflict', '38': 'Enroll conflict',
  '39': 'Face mask detected', '40': 'Full face not visible', '41': 'Face not straight',
});

/** Device-type codes of the PUSH API (device-basic-config may report the same numbering — used only as a model hint). */
const DEVICE_TYPES: Readonly<Record<string, string>> = { '0': 'COSEC DOOR V3', '1': 'COSEC PVR DOOR', '2': 'COSEC VEGA', '3': 'COSEC DOOR FMX', '5': 'COSEC ARC DC200', '7': 'COSEC ARGO' };

// ----- body parsing (XML subset / key=value text; no dependency) -------------------------------------------------------------

export interface CosecDocument {
  /** Flat child elements of the root (or `key=value` pairs of a text answer). Keys verbatim. */
  fields: Record<string, string>;
  /** One record per `<Events>` element, in document order. */
  events: Record<string, string>[];
  /** Root text outside any element (COSEC reports some failures this way). */
  text: string;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent: string) => {
    if (ent[0] === '#') {
      const cp = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return XML_ENTITIES[ent.toLowerCase()] ?? m;
  });
}
const ELEMENT = /<([A-Za-z_][\w.-]*)(?:\s[^<>]*?)?(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
function childElements(inner: string): { tag: string; body: string }[] {
  const out: { tag: string; body: string }[] = [];
  for (const m of inner.matchAll(ELEMENT)) out.push({ tag: m[1] ?? '', body: m[2] ?? '' });
  return out;
}

/**
 * Parses a DAPI answer. XML: `<ROOT><Response-Code>0</Response-Code>…</ROOT>` or `<ROOT><Events><seq-No>…</seq-No>…</Events>…</ROOT>`
 * (root name not relied upon). Text: `key=value` pairs separated by spaces/newlines (the PUSH API's text format; values may contain
 * spaces). Anything else is a PROTOCOL_ERROR — never guessed at.
 */
export function parseCosecBody(body: string): CosecDocument {
  const trimmed = (body.charCodeAt(0) === 0xfeff ? body.slice(1) : body).trim();
  const doc: CosecDocument = { fields: {}, events: [], text: '' };
  if (trimmed.length === 0) return doc;
  if (trimmed.startsWith('<')) {
    const xml = trimmed.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').trim();
    if (/^<[A-Za-z_][\w.-]*(?:\s[^<>]*)?\/>$/.test(xml)) return doc;
    const root = /^<([A-Za-z_][\w.-]*)(?:\s[^<>]*)?>([\s\S]*)<\/\1\s*>$/.exec(xml);
    if (!root) throw new ProviderError('PROTOCOL_ERROR', `${VENDOR}: the device answered with malformed XML`, { retryable: false });
    const inner = root[2] ?? '';
    for (const child of childElements(inner)) {
      if (child.tag.toLowerCase() === 'events') {
        const record: Record<string, string> = {};
        for (const f of childElements(child.body)) record[f.tag] = decodeXml(f.body).trim();
        doc.events.push(record);
      } else if (!child.body.includes('<')) {
        doc.fields[child.tag] = decodeXml(child.body).trim();
      }
    }
    doc.text = decodeXml(inner.replace(ELEMENT, '')).trim();
    return doc;
  }
  let matched = false;
  for (const line of trimmed.split(/\r?\n/)) {
    for (const pair of line.trim().split(/\s+(?=[A-Za-z][\w-]*=)/)) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const key = pair.slice(0, eq).trim();
      if (!/^[A-Za-z][\w-]*$/.test(key)) continue;
      doc.fields[key] = pair.slice(eq + 1).trim();
      matched = true;
    }
  }
  if (!matched) doc.text = trimmed;
  return doc;
}

const norm = (k: string): string => k.toLowerCase().replace(/[^a-z0-9]/g, '');
/** Case/punctuation-insensitive field lookup (`seq-No` = `seq-no` = `SeqNo`). */
export function cosecField(record: Record<string, string>, ...names: string[]): string | undefined {
  const wanted = new Set(names.map(norm));
  for (const [k, v] of Object.entries(record)) if (wanted.has(norm(k))) return v;
  return undefined;
}
const intIn = (v: string | undefined, min: number, max: number): number | null => {
  if (v === undefined || !/^\d{1,10}$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n >= min && n <= max ? n : null;
};

// ----- vocabulary ------------------------------------------------------------------------------------------------------------

/** Event `detail-2` = special function (PUSH API field-2). 0 / 98 / 99 / unknown carry no direction: never invented. */
const SPECIAL_FUNCTIONS: Readonly<Record<string, { name: string; direction: PunchDirection }>> = {
  '1': { name: 'official-work-in', direction: 'in' }, '2': { name: 'official-work-out', direction: 'out' },
  '3': { name: 'short-leave-in', direction: 'in' }, '4': { name: 'short-leave-out', direction: 'out' },
  '5': { name: 'regular-in', direction: 'in' }, '6': { name: 'regular-out', direction: 'out' },
  '7': { name: 'break-end', direction: 'break_in' }, '8': { name: 'break-start', direction: 'break_out' },
  '9': { name: 'overtime-in', direction: 'overtime_in' }, '10': { name: 'overtime-out', direction: 'overtime_out' },
  '11': { name: 'late-in-allowed', direction: 'in' }, '12': { name: 'early-out-allowed', direction: 'out' },
};
export function mapCosecDirection(detail2: string | undefined): PunchDirection {
  return (detail2 !== undefined ? SPECIAL_FUNCTIONS[detail2.trim()]?.direction : undefined) ?? 'unknown';
}

/** Event `detail-3` = credential mask (PUSH API field-3). A biometric factor wins over card/PIN in a multi-factor punch. */
export function mapCosecVerification(detail3: string | undefined): VerificationMethod {
  const mask = intIn(detail3, 0, 65535);
  if (mask === null || mask === 0) return 'unknown';
  if (mask & 64) return 'face';
  if (mask & 4) return 'fingerprint';
  if (mask & 8) return 'palm';
  if (mask & 2) return 'card';
  if (mask & 1) return 'pin';
  if (mask & 128) return 'mobile';
  return 'unknown';
}

// ----- cursor ----------------------------------------------------------------------------------------------------------------

/**
 * `{ rollOverCount, seqNumber }` = the NEXT event position to request (the controller numbers events per roll-over generation);
 * `notBefore` (ISO) is carried only until the first punch at/after it has been delivered — it bounds the initial backfill window.
 * Idempotency key of a punch: (device, roll-over-count, seq-No) → providerTransactionId `${roll}:${seq}`.
 */
export interface CosecCursor { rollOverCount: number; seqNumber: number; notBefore?: string }

function invalidCursor(cursor: unknown): ProviderError {
  let shown: string | null = null;
  try { shown = boundedText(JSON.stringify(cursor), 200); } catch { shown = null; }
  return new ProviderError('INVALID_CONFIG', 'Unparseable Matrix COSEC cursor', { retryable: false, details: { reason: COSEC_INVALID_CURSOR_REASON, cursor: shown } });
}
export function parseCosecCursor(cursor: SyncCursor | null | undefined): CosecCursor | null {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor !== 'object' || Array.isArray(cursor)) throw invalidCursor(cursor);
  const keys = Object.keys(cursor);
  if (keys.length === 0) return null;
  if (keys.some((k) => k !== 'rollOverCount' && k !== 'seqNumber' && k !== 'notBefore')) throw invalidCursor(cursor);
  const { rollOverCount, seqNumber, notBefore } = cursor as Record<string, unknown>;
  if (typeof rollOverCount !== 'number' || !Number.isInteger(rollOverCount) || rollOverCount < 0 || rollOverCount > MAX_SEQUENCE) throw invalidCursor(cursor);
  if (typeof seqNumber !== 'number' || !Number.isInteger(seqNumber) || seqNumber < 1 || seqNumber > MAX_SEQUENCE) throw invalidCursor(cursor);
  if (notBefore !== undefined && (typeof notBefore !== 'string' || !DateTime.fromISO(notBefore).isValid)) throw invalidCursor(cursor);
  return { rollOverCount, seqNumber, ...(typeof notBefore === 'string' ? { notBefore } : {}) };
}
export function isCosecCursorError(err: unknown): boolean {
  return ProviderError.is(err) && err.details?.['reason'] === COSEC_INVALID_CURSOR_REASON;
}
const before = (a: { roll: number; seq: number }, b: { roll: number; seq: number }): boolean => a.roll < b.roll || (a.roll === b.roll && a.seq < b.seq);

// ----- employee field validation ---------------------------------------------------------------------------------------------

/** C0/C1 control characters (CR/LF/TAB/NUL…): never allowed in values that end up on the device or in a header. */
export function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}
function invalidInput(message: string, field: string): ProviderError {
  return new ProviderError('INVALID_CONFIG', `${VENDOR}: ${message}`, { retryable: false, details: { field } });
}
/**
 * FlowZa's device user id becomes BOTH the COSEC `user-id` (1–15 alphanumerics) and the numeric `ref-user-id` (≤ 8 digits): events
 * report the user in `detail-1`, which Horilla resolves as the reference id while the research reads it as the user id — keeping the
 * two equal makes a punch attributable either way. Hence: 1–99999999 without leading zeros.
 */
export function cosecUserIdFor(deviceUserId: string): string {
  const id = deviceUserId.trim();
  if (!/^[1-9]\d{0,7}$/.test(id)) throw invalidInput(`device user id "${boundedText(id, 20)}" must be a number from 1 to 99999999 without leading zeros (it is used as both the COSEC user id and reference user id)`, 'deviceUserId');
  return id;
}
/** COSEC names hold 15 characters (longer ones are cut, as the device would); control characters are refused outright. */
export function cosecName(name: string): { name: string; truncated: boolean } {
  if (hasControlChars(name)) throw invalidInput('employee name contains control characters', 'name');
  const chars = Array.from(name.trim().replace(/\s+/g, ' '));
  if (chars.length === 0) throw invalidInput('employee name is empty', 'name');
  return { name: chars.slice(0, 15).join(''), truncated: chars.length > 15 };
}
function cosecPin(pin: string | null | undefined): string | undefined {
  if (pin === null || pin === undefined || pin.trim() === '') return undefined;
  if (!/^\d{1,6}$/.test(pin.trim())) throw invalidInput('PIN must be 1 to 6 digits', 'pin');
  return pin.trim();
}
function cosecCard(card: string | null | undefined): string | undefined {
  if (card === null || card === undefined || card.trim() === '') return undefined;
  const c = card.trim();
  if (!/^\d{1,20}$/.test(c) || BigInt(c) > 18446744073709551615n || BigInt(c) === 0n) throw invalidInput('card number must be a decimal number (1 to 18446744073709551615)', 'cardNumber');
  return c.replace(/^0+/, '');
}

// ----- provider --------------------------------------------------------------------------------------------------------------

interface CosecConfig { baseUrl: string; username: string; password: string; authKey: string }
type AuthMode = 'basic' | 'digest';
type CallOptions = { allowCodes?: string[] };

const SENSITIVE_KEY = /pass|pwd|secret|key|token|pin|card|user/i;

export class MatrixCosecProvider implements DeviceProvider {
  readonly definition: ProviderDefinition;
  private readonly client: VendorHttpClient;
  private readonly clock: () => Date;
  /**
   * Firmware that insists on Digest answers the Basic attempt with a Digest challenge; remembered per (device, URL, user, password
   * hash) so later calls go straight to Digest. Nothing secret is stored: the key is a sha256, the value an enum. Bounded.
   */
  private readonly authModes = new Map<string, AuthMode>();

  constructor(options: VendorHttpOptions & { clock?: () => Date; definition?: ProviderDefinition } = {}) {
    const { clock, definition, ...http } = options;
    this.definition = definition ?? MATRIX_COSEC_DEFINITION;
    this.clock = clock ?? (() => new Date());
    this.client = new VendorHttpClient(VENDOR, http);
  }

  private resolveConfig(ctx: ProviderContext): CosecConfig {
    const baseUrl = this.client.baseUrl(ctx.config['baseUrl'] ?? ctx.endpointUrl ?? undefined);
    const username = requiredString(ctx.config, 'username', VENDOR);
    if (username.includes(':') || hasControlChars(username)) throw new ProviderError('INVALID_CONFIG', `${VENDOR}: username contains a character HTTP authentication cannot carry`, { retryable: false, details: { field: 'username' } });
    const password = requiredString(ctx.credentials, 'password', VENDOR);
    const authKey = createHash('sha256').update(`${ctx.deviceId}\u0000${baseUrl}\u0000${username}\u0000${password}`).digest('hex');
    return { baseUrl, username, password, authKey };
  }

  /**
   * One DAPI exchange: every parameter percent-encoded (`encodeURIComponent`, so a space is %20, never `+`), `format=xml` appended,
   * Basic auth unless the device is known to want Digest. A non-zero `Response-Code` becomes a ProviderError unless the caller
   * listed it (e.g. 13 "user not found" on a lookup). The log label names the resource and action only — never user data.
   */
  private async call(ctx: ProviderContext, cfg: CosecConfig, resource: string, params: Record<string, string>, opts: CallOptions = {}): Promise<CosecDocument & { code: string | null; latencyMs: number }> {
    const query = Object.entries({ ...params, format: 'xml' }).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const label = `GET /device.cgi/${resource}?action=${params['action'] ?? ''}`;
    const req: VendorHttpRequest = { method: 'GET', url: `${joinUrl(cfg.baseUrl, `device.cgi/${resource}`)}?${query}`, label, headers: { accept: 'text/xml, application/xml;q=0.9, text/plain;q=0.8' } };
    const creds = { username: cfg.username, password: cfg.password };
    let res: VendorHttpResponse;
    if (this.authModes.get(cfg.authKey) === 'digest') {
      res = await this.client.digestRequest(ctx, req, creds);
    } else {
      res = await this.client.request(ctx, { ...req, headers: { ...req.headers, authorization: basicAuthorization(cfg.username, cfg.password) }, passStatuses: [401] });
      if (res.status === 401) {
        if (!parseDigestChallenge(res.headers['www-authenticate'] ?? '')) throw this.client.statusError(401, label);
        if (this.authModes.size >= 1000) this.authModes.clear();
        this.authModes.set(cfg.authKey, 'digest');
        ctx.logger.info({ event: 'cosec_auth_digest', deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'Matrix COSEC device requires HTTP Digest; switching');
        res = await this.client.digestRequest(ctx, req, creds);
      }
    }
    let doc: CosecDocument;
    try {
      doc = parseCosecBody(res.text);
    } catch (err) {
      ctx.logger.warn({ event: 'cosec_unreadable_response', request: label, contentType: res.headers['content-type'] ?? null, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'Matrix COSEC answered with an unreadable body');
      throw err;
    }
    const code = cosecField(doc.fields, 'Response-Code') ?? null;
    if (code !== null && code !== '0' && !opts.allowCodes?.includes(code)) {
      ctx.logger.warn({ event: 'cosec_response_code', request: label, responseCode: code, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'Matrix COSEC refused the request');
      throw cosecCodeError(code, label);
    }
    if (code === null && doc.events.length === 0 && Object.keys(doc.fields).length === 0 && doc.text.length > 0) {
      // COSEC reports some failures as bare root text; logged bounded for operators, never returned.
      ctx.logger.warn({ event: 'cosec_error_text', request: label, vendorError: boundedText(doc.text, 200), deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'Matrix COSEC answered with an error text');
      throw new ProviderError('VENDOR_ERROR', `${VENDOR} rejected ${label}`, { retryable: false, details: { request: label } });
    }
    return { ...doc, code, latencyMs: res.latencyMs };
  }

  /** Current (roll-over-count, seq-No) — UNVERIFIED call; null when the firmware does not answer it in a readable way. */
  private async currentSequence(ctx: ProviderContext, cfg: CosecConfig): Promise<{ roll: number; seq: number } | null> {
    try {
      const doc = await this.call(ctx, cfg, 'events', { action: 'getcurrentseqnumber' });
      const seq = intIn(cosecField(doc.fields, 'seq-number', 'seq-no', 'current-seq-number', 'cur-seq-number', 'seqnumber'), 0, MAX_SEQUENCE);
      const roll = intIn(cosecField(doc.fields, 'roll-over-count', 'rollover-count', 'roll-over-cnt'), 0, MAX_SEQUENCE) ?? 0;
      if (seq === null) {
        ctx.logger.warn({ event: 'cosec_current_seq_unreadable', fields: Object.keys(doc.fields).slice(0, 20), deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'Matrix COSEC current sequence number not understood');
        return null;
      }
      return { roll, seq };
    } catch (err) {
      // Only "this firmware does not have that call" is absorbed; auth, transport, throttling and 5xx propagate.
      if (ProviderError.is(err) && (err.code === 'NOT_FOUND' || err.code === 'UNSUPPORTED' || err.code === 'PROTOCOL_ERROR' || (err.code === 'VENDOR_ERROR' && !err.retryable) || (err.code === 'INVALID_CONFIG' && err.details?.['responseCode'] !== undefined))) {
        ctx.logger.warn({ event: 'cosec_current_seq_unavailable', code: err.code, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'Matrix COSEC current sequence number unavailable');
        return null;
      }
      throw err;
    }
  }

  /** Device clock via `date-time?action=get` (field names from the PUSH API date/time config — tolerant, optional). */
  private async deviceClock(ctx: ProviderContext, cfg: CosecConfig): Promise<{ local: string; utc: string } | null> {
    const doc = await this.call(ctx, cfg, 'date-time', { action: 'get' });
    const f = doc.fields;
    const y = intIn(cosecField(f, 'year'), 2000, 2099), mo = intIn(cosecField(f, 'month'), 1, 12), d = intIn(cosecField(f, 'date', 'day'), 1, 31);
    const h = intIn(cosecField(f, 'hour'), 0, 23), mi = intIn(cosecField(f, 'minute'), 0, 59), s = intIn(cosecField(f, 'second'), 0, 59);
    if (y === null || mo === null || d === null || h === null || mi === null || s === null) return null;
    const p = (n: number): string => String(n).padStart(2, '0');
    const local = `${y}-${p(mo)}-${p(d)} ${p(h)}:${p(mi)}:${p(s)}`;
    try { return { local, utc: toIsoUtc(parseDeviceTime(local, ctx.timezone)) }; } catch (err) {
      if (ProviderError.is(err) && err.code === 'PROTOCOL_ERROR') return null;
      throw err;
    }
  }

  // ----- DeviceProvider -------------------------------------------------------------------------------------------------------

  async testConnection(ctx: ProviderContext): Promise<ConnectionResult> {
    const started = Date.now();
    const probe = await connectionProbe(started, async () => this.getDeviceInfo(ctx));
    if (!probe.ok) return probe;
    const info = probe.value;
    return { ok: true, message: `Connected to ${info.model ?? 'the Matrix COSEC device'}`, latencyMs: Date.now() - started, deviceInfo: info, details: { authScheme: this.authModes.get(this.resolveConfig(ctx).authKey) ?? 'basic' } };
  }

  async getDeviceInfo(ctx: ProviderContext): Promise<DeviceInfo> {
    const cfg = this.resolveConfig(ctx);
    const basic = await this.call(ctx, cfg, 'device-basic-config', { action: 'get' });
    const clock = await this.deviceClock(ctx, cfg);
    let userCount: number | undefined;
    try {
      const count = await this.call(ctx, cfg, 'command', { action: 'getusercount' });
      userCount = intIn(cosecField(count.fields, 'user-count', 'usercount', 'no-of-users', 'total-users'), 0, MAX_SEQUENCE) ?? undefined;
    } catch (err) {
      if (!ProviderError.is(err) || err.code === 'AUTH_FAILED' || err.retryable) throw err; // a missing optional read is not a failure
    }
    const f = basic.fields;
    const deviceType = cosecField(f, 'device-type', 'devicetype');
    const model = cosecField(f, 'model', 'device-model') ?? (deviceType !== undefined ? DEVICE_TYPES[deviceType] : undefined);
    const serial = cosecField(f, 'serial-no', 'serial-number', 'mac-address', 'mac-addr', 'mac') ?? ctx.serialNumber ?? undefined;
    const firmware = cosecField(f, 'firmware-version', 'fw-version', 'software-version', 'firmware', 'version');
    // Allowlisted echo of the basic config for diagnostics: short values, nothing that looks like a credential or a user field.
    const config: Record<string, string> = {};
    for (const [k, v] of Object.entries(f)) {
      if (Object.keys(config).length >= 30) break;
      if (SENSITIVE_KEY.test(k) || v.length > 64) continue;
      config[k] = v;
    }
    return {
      ...(serial ? { serialNumber: boundedText(serial, 64) ?? undefined } : {}),
      ...(model ? { model: boundedText(model, 64) ?? undefined } : {}),
      ...(firmware ? { firmwareVersion: boundedText(firmware, 64) ?? undefined } : {}),
      ...(clock ? { deviceTime: clock.utc } : {}),
      ...(userCount !== undefined ? { userCount } : {}),
      extra: { deviceName: boundedText(cosecField(f, 'name', 'device-name'), 64), deviceLocalTime: clock?.local ?? null, basicConfig: config },
    };
  }

  async getCapabilities(_ctx: ProviderContext): Promise<DeviceCapabilities> {
    return { ...this.definition.capabilities };
  }

  /** The clock read is the liveness probe: an authenticated answer means the controller is up; skew = device − FlowZa clock. */
  async getDeviceStatus(ctx: ProviderContext): Promise<DeviceStatus> {
    const cfg = this.resolveConfig(ctx);
    const started = Date.now();
    const clock = await this.deviceClock(ctx, cfg);
    const now = this.clock();
    const skew = clock ? Math.round((Date.parse(clock.utc) - now.getTime()) / 1000) : undefined;
    return { online: true, lastSeenAt: now.toISOString(), ...(clock ? { deviceTime: clock.utc } : {}), ...(skew !== undefined ? { clockSkewSeconds: skew } : {}), details: { latencyMs: Date.now() - started, deviceLocalTime: clock?.local ?? null } };
  }

  /**
   * One `events?action=getevent` page (≤ 100 events). The cursor advances over EVERY event returned (door/alarm events included —
   * otherwise a page of door events would stall it forever) while only event 101 becomes a punch. Without a cursor the page starts
   * COSEC_INITIAL_BACKFILL_EVENTS before the controller's current sequence number (or at (0, 1) when the firmware cannot tell) and
   * punches before `since` (default: 30 days before local midnight) are dropped — DAPI has no time filter. An empty page asks for the
   * current sequence once more: a higher roll-over count means the controller wrapped, so the cursor moves to (roll + 1, 1).
   */
  async pullAttendance(ctx: ProviderContext, cursor: SyncCursor | null, opts: { pageSize?: number; since?: string } = {}): Promise<AttendancePullResult> {
    const stored = parseCosecCursor(cursor); // validate before touching the device
    const cfg = this.resolveConfig(ctx);
    const limit = Math.min(MAX_EVENTS_PER_PAGE, Math.max(1, Math.floor(opts.pageSize ?? MAX_EVENTS_PER_PAGE)));
    let position: CosecCursor;
    let started: 'cursor' | 'current_sequence' | 'beginning' = 'cursor';
    if (stored) {
      position = stored;
    } else {
      const since = opts.since !== undefined && DateTime.fromISO(opts.since).isValid ? DateTime.fromISO(opts.since).toUTC() : DateTime.fromJSDate(this.clock()).setZone(ctx.timezone).minus({ days: DEFAULT_LOOKBACK_DAYS }).startOf('day').toUTC();
      const current = await this.currentSequence(ctx, cfg);
      started = current ? 'current_sequence' : 'beginning';
      position = { rollOverCount: current?.roll ?? 0, seqNumber: current ? Math.max(1, current.seq - COSEC_INITIAL_BACKFILL_EVENTS + 1) : 1, notBefore: toIsoUtc(since) };
    }
    const from = { roll: position.rollOverCount, seq: position.seqNumber };
    const page = await this.call(ctx, cfg, 'events', { action: 'getevent', 'roll-over-count': String(from.roll), 'seq-number': String(from.seq), 'no-of-events': String(limit) }, { allowCodes: ['10'] });

    const skipped = { malformed: 0, behindCursor: 0, badTime: 0, noUser: 0, beforeSince: 0 };
    const events: { roll: number; seq: number; record: Record<string, string> }[] = [];
    for (const record of page.events) {
      const roll = intIn(cosecField(record, 'roll-over-count'), 0, MAX_SEQUENCE);
      const seq = intIn(cosecField(record, 'seq-No', 'seq-number'), 0, MAX_SEQUENCE);
      if (roll === null || seq === null) { skipped.malformed += 1; continue; }
      if (before({ roll, seq }, from)) { skipped.behindCursor += 1; continue; } // never let the device move us backwards
      events.push({ roll, seq, record });
    }
    events.sort((a, b) => a.roll - b.roll || a.seq - b.seq);

    let notBefore = position.notBefore;
    const notBeforeMs = notBefore ? Date.parse(notBefore) : null;
    let deliveredAfterNotBefore = false;
    const transactions: RawTransaction[] = [];
    let nonAttendance = 0;
    for (const { roll, seq, record } of events) {
      const eventId = cosecField(record, 'event-id') ?? '';
      if (!ATTENDANCE_EVENT_IDS.has(eventId)) { nonAttendance += 1; continue; }
      const mapped = this.mapEvent(ctx, roll, seq, eventId, record);
      if (!mapped.ok) { skipped[mapped.reason] += 1; continue; }
      if (notBeforeMs !== null && Date.parse(mapped.tx.punchedAt) < notBeforeMs) { skipped.beforeSince += 1; continue; }
      deliveredAfterNotBefore = true;
      transactions.push(mapped.tx);
    }
    if (deliveredAfterNotBefore) notBefore = undefined; // the backfill bound has been crossed; later punches are never filtered by time

    const last = events[events.length - 1];
    let next: { roll: number; seq: number } = last ? { roll: last.roll, seq: last.seq + 1 } : from;
    let hasMore = events.length > 0 && page.events.length >= limit;
    const meta: Record<string, unknown> = { received: page.events.length, limit, latencyMs: page.latencyMs, started, nonAttendance };
    if (events.length === 0) {
      const current = await this.currentSequence(ctx, cfg);
      if (current && current.roll > from.roll) {
        next = { roll: from.roll + 1, seq: 1 };
        hasMore = true;
        meta['rolledOver'] = true;
        ctx.logger.info({ event: 'cosec_event_rollover', fromRoll: from.roll, deviceRoll: current.roll, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'Matrix COSEC event log rolled over; continuing in the next generation');
      } else if (current && (current.roll < from.roll || (current.roll === from.roll && current.seq + 1 < from.seq))) {
        // Factory reset / re-registration: the cursor is ahead of the device. Not auto-reset (the operator decides: rewind + generation bump).
        meta['cursorAhead'] = true;
        meta['deviceSequence'] = { rollOverCount: current.roll, seqNumber: current.seq };
        ctx.logger.warn({ event: 'cosec_cursor_ahead_of_device', cursorRoll: from.roll, cursorSeq: from.seq, deviceRoll: current.roll, deviceSeq: current.seq, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'Matrix COSEC sequence is behind the stored cursor (device reset?)');
      }
    }
    if (page.events.length > 0 && events.length === 0) ctx.logger.warn({ event: 'cosec_cursor_stalled', ...skipped, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'Matrix COSEC returned events but none past the cursor');
    const dropped = skipped.malformed + skipped.badTime + skipped.noUser;
    if (dropped > 0) ctx.logger.warn({ event: 'cosec_events_skipped', ...skipped, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'Matrix COSEC events skipped (malformed or unattributable)');
    if (skipped.malformed + skipped.behindCursor + skipped.badTime + skipped.noUser + skipped.beforeSince > 0) meta['skipped'] = skipped;
    const nextCursor: CosecCursor = { rollOverCount: next.roll, seqNumber: next.seq, ...(notBefore ? { notBefore } : {}) };
    return { transactions, nextCursor: { ...nextCursor }, hasMore, meta };
  }

  private mapEvent(ctx: ProviderContext, roll: number, seq: number, eventId: string, record: Record<string, string>): { ok: true; tx: RawTransaction } | { ok: false; reason: 'badTime' | 'noUser' } {
    const userId = (cosecField(record, 'detail-1') ?? '').trim();
    if (!userId || userId.length > 64 || hasControlChars(userId)) return { ok: false, reason: 'noUser' };
    const date = (cosecField(record, 'date') ?? '').trim();
    const time = (cosecField(record, 'time') ?? '').trim();
    const d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date);
    const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time);
    if (!d || !t) return { ok: false, reason: 'badTime' };
    const p = (s: string | undefined): string => (s ?? '0').padStart(2, '0');
    let punchedAt: string;
    try { punchedAt = toIsoUtc(parseDeviceTime(`${d[3]}-${p(d[2])}-${p(d[1])} ${p(t[1])}:${p(t[2])}:${p(t[3])}`, ctx.timezone)); } catch (err) {
      if (ProviderError.is(err) && err.code === 'PROTOCOL_ERROR') return { ok: false, reason: 'badTime' };
      throw err; // INVALID_CONFIG (bad device timezone) is ours to fix, not a skippable row
    }
    const detail = (n: number): string | null => boundedText(cosecField(record, `detail-${n}`), 64);
    const special = cosecField(record, 'detail-2')?.trim();
    return {
      ok: true,
      tx: {
        providerTransactionId: `${roll}:${seq}`,
        deviceEmployeeId: userId,
        punchedAt,
        deviceLocalTime: `${date} ${time}`,
        verificationMethod: mapCosecVerification(cosecField(record, 'detail-3')),
        direction: mapCosecDirection(special),
        rawPayload: {
          rollOverCount: roll, seqNo: seq, eventId, date, time,
          detail1: detail(1), detail2: detail(2), detail3: detail(3), detail4: detail(4), detail5: detail(5),
          specialFunction: special !== undefined ? (SPECIAL_FUNCTIONS[special]?.name ?? null) : null,
        },
      },
    };
  }

  async listEmployees(_ctx: ProviderContext, _page: PageCursor): Promise<DeviceEmployeePage> {
    throw unsupported('listEmployees', 'the Matrix COSEC device API reads one user by id and reports a user count; it has no call that lists users');
  }

  /**
   * `users?action=set` with user-id = ref-user-id = the numeric device user id. The user is read first: an existing COSEC user with the
   * same user-id but another reference id would receive punches under a different id — that is a CONFLICT for an operator, not
   * something to overwrite. Card and PIN are sent when present (absent ones are left as the device has them).
   */
  async upsertEmployee(ctx: ProviderContext, employee: DeviceEmployee): Promise<DeviceOperationResult> {
    const cfg = this.resolveConfig(ctx);
    const userId = cosecUserIdFor(employee.deviceUserId);
    const { name, truncated } = cosecName(employee.name);
    const pin = cosecPin(employee.pin);
    const card = cosecCard(employee.cardNumber);
    const existing = await this.call(ctx, cfg, 'users', { action: 'get', 'user-id': userId }, { allowCodes: ['10', '13'] });
    const found = existing.code !== '10' && existing.code !== '13' && (cosecField(existing.fields, 'user-id') ?? '') !== '';
    const existingRef = found ? cosecField(existing.fields, 'ref-user-id')?.trim() : undefined;
    if (existingRef !== undefined && existingRef !== '' && existingRef !== userId) {
      throw new ProviderError('CONFLICT', `${VENDOR}: user ${userId} already exists on the device with reference id ${boundedText(existingRef, 10)}; remove or renumber it on the device first`, { retryable: false, details: { deviceUserId: userId } });
    }
    const params: Record<string, string> = { action: 'set', 'user-id': userId, 'ref-user-id': userId, name, 'user-active': employee.enabled === false ? '0' : '1' };
    if (card !== undefined) params['card1'] = card;
    if (pin !== undefined) params['user-pin'] = pin;
    await this.call(ctx, cfg, 'users', params);
    ctx.logger.info({ event: 'cosec_user_upserted', created: !found, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'Matrix COSEC user written');
    return { ok: true, deviceUserId: userId, message: found ? 'User updated on the device' : 'User created on the device', details: { created: !found, nameTruncated: truncated } };
  }

  /** `users?action=delete`; "user id not found" (13) is success — deleting is idempotent (termination jobs retry). */
  async deleteEmployee(ctx: ProviderContext, deviceUserId: string): Promise<DeviceOperationResult> {
    const cfg = this.resolveConfig(ctx);
    const userId = deviceUserId.trim();
    if (!/^[A-Za-z0-9]{1,15}$/.test(userId)) throw invalidInput('device user id must be 1 to 15 letters or digits', 'deviceUserId');
    const res = await this.call(ctx, cfg, 'users', { action: 'delete', 'user-id': userId }, { allowCodes: ['13'] });
    const absent = res.code === '13';
    return { ok: true, deviceUserId: userId, message: absent ? 'User was not on the device' : 'User deleted from the device', details: { alreadyAbsent: absent } };
  }

  async restart(_ctx: ProviderContext): Promise<DeviceOperationResult> {
    throw unsupported('restart', 'reboot is a COSEC PUSH API command (cmd 18); the device API used here documents no reboot call');
  }
}

/** DAPI `Response-Code` → ProviderError (message from our table; retryable only for transient device states). */
export function cosecCodeError(code: string, label: string): ProviderError {
  const text = COSEC_RESPONSE_CODES[code] ?? 'Unknown response code';
  const details = { request: label, responseCode: code };
  const msg = `${VENDOR}: ${text} (Response-Code ${code})`;
  switch (code) {
    case '1': return new ProviderError('AUTH_FAILED', `${VENDOR} rejected the credentials (Response-Code 1)`, { retryable: false, details });
    case '10': case '13': case '19': return new ProviderError('NOT_FOUND', msg, { retryable: false, details });
    case '7': case '8': case '18': case '21': case '37': return new ProviderError('CONFLICT', msg, { retryable: false, details });
    case '3': case '22': case '26': case '29': case '33': return new ProviderError('INVALID_CONFIG', msg, { retryable: false, details });
    case '24': return new ProviderError('UNSUPPORTED', msg, { retryable: false, details });
    case '27': return new ProviderError('TIMEOUT', msg, { retryable: true, details });
    case '16': case '17': case '28': case '35': return new ProviderError('VENDOR_ERROR', msg, { retryable: true, details });
    default: return new ProviderError('VENDOR_ERROR', msg, { retryable: false, details });
  }
}
