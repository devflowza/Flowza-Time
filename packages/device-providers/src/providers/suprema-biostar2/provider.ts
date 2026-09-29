import { DateTime } from 'luxon';
import { z } from 'zod';
import type { DeviceCapabilities, DeviceEmployee, PunchDirection, RawTransaction, VerificationMethod } from '@flowza/contracts';
import { sha256Hex } from '@flowza/shared';
import { unsupported } from '../../errors.js';
import { boundedText, isValidTimezone, parseDeviceTime, toIsoUtc } from '../../protocol-utils.js';
import { ProviderError, type AttendancePullResult, type ConnectionResult, type DeviceEmployeePage, type DeviceInfo, type DeviceOperationResult, type DeviceProvider, type DeviceStatus, type PageCursor, type ProviderContext, type ProviderDefinition, type SyncCursor } from '../../types.js';
import { connectionProbe, joinUrl, optionalString, requiredString, VendorHttpClient, type VendorHttpMethod, type VendorHttpOptions, type VendorHttpResponse } from '../../vendor-http.js';
import { SUPREMA_BIOSTAR2_DEFINITION } from './definition.js';

/**
 * Suprema BioStar 2 / BioStar X REST adapter (docs/device-integrations.md §2.3; request shapes from the official BioStar X Postman
 * collection, event/sub-codes from the G-SDK event API). Everything goes through {@link VendorHttpClient}: egress-guarded (https,
 * public hosts, no redirects), throttled once per request, statuses mapped to ProviderError.
 *
 * Authentication: `POST /api/login {"User":{"login_id","password"}}` answers with a `bs-session-id` header that every later call
 * carries. Sessions live in memory only, keyed by a hash of (org, device, URL, login, sha256(password)) so a changed password never
 * reuses an old session, and are refreshed once transparently when BioStar answers 401 / `Response.code = "10"` (login required).
 */

const VENDOR = 'Suprema BioStar 2';

/** `Query.conditions[].operator` values (official collection, Events → Search Events): note there is no GREATER_OR_EQUAL. */
export const BIOSTAR_OPERATOR = { EQUAL: 0, NOT_EQUAL: 1, CONTAINS: 2, BETWEEN: 3, LIKE: 4, GREATER: 5, LESS: 6 } as const;

/** Research: keep event pages ≤ 1000 rows. */
export const BIOSTAR_EVENTS_MAX_LIMIT = 1000;
export const BIOSTAR_EVENTS_DEFAULT_LIMIT = 200;
export const BIOSTAR_USERS_PAGE_SIZE = 200;
/** Without cursor and `since`, the first pull starts 30 days back (floored to the UTC day so repeated first pulls are identical). */
export const BIOSTAR_DEFAULT_LOOKBACK_DAYS = 30;
/**
 * Upper bound of the `datetime BETWEEN` condition. A fixed far bound rather than "now": a punch whose device clock runs ahead would
 * otherwise be excluded now and never seen later (the id cursor has moved past it). 2037-12-31 is BioStar's own date ceiling.
 */
const SEARCH_UPPER_BOUND = '2037-12-31T23:59:59.000Z';
/** Session TTL we trust (BioStar reports ~1 h; we renew earlier, and a 401 renews anyway). */
const SESSION_TTL_MS = 50 * 60_000;
const MAX_CACHED_SESSIONS = 500;
/** Defaults for a newly created user (BioStar requires both; limits: ≥ 2001-01-01, ≤ 2037-12-31 23:59). */
const USER_START = '2001-01-01T00:00:00.00Z';
const USER_EXPIRY = '2037-12-31T23:59:00.00Z';
/** BioStar user name limit (48 chars) and the documented "single quote in name" rejection. */
const NAME_MAX = 48;
/** user_id rule we can prove safe: BioStar ids are numeric or alphanumeric, no spaces, ≤ 32 bytes; `+` separates ids in DELETE. */
const USER_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const DEVICE_ID_RE = /^\d{1,10}$/;
const EVENT_ID_RE = /^\d{1,19}$/;
const RAW_TEXT_MAX = 64;

// ----- event vocabulary (G-SDK docs/_apis/event.md: 16-bit code = main code | 8-bit sub-code) -----------------------------------

/** Main event codes that mean "this user authenticated successfully". Everything else (fail, denied, door, alarm…) is dropped. */
const AUTH_SUCCESS_EVENTS: ReadonlyMap<number, { mode: 'verify' | 'identify' | 'dual'; duress: boolean }> = new Map([
  [0x1000, { mode: 'verify', duress: false }],   // BS2_EVENT_VERIFY_SUCCESS   (4096–4351) 1:1
  [0x1200, { mode: 'verify', duress: true }],    // BS2_EVENT_VERIFY_DURESS    (4608–…) 1:1 under duress — the person was there
  [0x1300, { mode: 'identify', duress: false }], // BS2_EVENT_IDENTIFY_SUCCESS (4864–5119) 1:N
  [0x1500, { mode: 'identify', duress: true }],  // BS2_EVENT_IDENTIFY_DURESS
  [0x1600, { mode: 'dual', duress: false }],     // BS2_EVENT_DUAL_AUTH_SUCCESS (no sub-code table)
]);

/**
 * 1:1 sub-codes → the factor that proves presence (biometric beats token beats PIN: "card + face" is a face punch). Codes absent here
 * (unknown firmware additions) map to `unknown`, never to a guess.
 */
const VERIFY_SUB_METHOD: Readonly<Record<number, VerificationMethod>> = {
  0x01: 'pin', 0x02: 'fingerprint', 0x03: 'fingerprint', 0x04: 'face', 0x05: 'face',
  0x06: 'card', 0x07: 'card', 0x08: 'fingerprint', 0x09: 'fingerprint', 0x0a: 'face', 0x0b: 'face',
  0x0c: 'card', 0x0d: 'card', 0x0e: 'fingerprint', 0x0f: 'fingerprint', // AOC (access-on-card) variants
  0x10: 'face', 0x11: 'face', 0x12: 'face', 0x13: 'face',
  0x16: 'mobile', 0x17: 'mobile', 0x18: 'fingerprint', 0x19: 'fingerprint', 0x1a: 'face', 0x1b: 'face', 0x20: 'face', 0x21: 'face',
  0x25: 'card', 0x26: 'card', 0x27: 'fingerprint', 0x28: 'fingerprint', 0x29: 'face', 0x2a: 'face', 0x2b: 'face', 0x2c: 'face', // QR is a token credential
  0x31: 'card', // lock-override card
};
/** 1:N sub-codes: 1–2 fingerprint (+PIN); 3–8 involve the face. */
const IDENTIFY_SUB_METHOD: Readonly<Record<number, VerificationMethod>> = {
  0x01: 'fingerprint', 0x02: 'fingerprint', 0x03: 'face', 0x04: 'face', 0x05: 'face', 0x06: 'face', 0x07: 'face', 0x08: 'face',
};

export interface BioStarEventClass { mainCode: number; subCode: number; mode: 'verify' | 'identify' | 'dual'; duress: boolean; method: VerificationMethod }

/** Classifies a BioStar event code; null for anything that is not a successful authentication. */
export function classifyBioStarEvent(code: number): BioStarEventClass | null {
  if (!Number.isInteger(code) || code < 0 || code > 0xffff) return null;
  const mainCode = code & 0xff00;
  const subCode = code & 0xff;
  const kind = AUTH_SUCCESS_EVENTS.get(mainCode);
  if (!kind) return null;
  const table: Readonly<Record<number, VerificationMethod>> = kind.mode === 'verify' ? VERIFY_SUB_METHOD : kind.mode === 'identify' ? IDENTIFY_SUB_METHOD : {};
  return { mainCode, subCode, ...kind, method: table[subCode] ?? 'unknown' };
}

/**
 * `tna_key` → direction. BioStar T&A keys are 1–16 with customer-editable labels (G-SDK tna.Key); only the conventional
 * KEY_1 = in / KEY_2 = out is mapped (REPORTED — verify on the customer's T&A config). 0 / other keys stay `unknown` and the engine
 * attributes the punch from the shift window.
 */
export function mapBioStarTnaKey(value: string | number | null | undefined): PunchDirection {
  const v = String(value ?? '').trim();
  if (v === '1') return 'in';
  if (v === '2') return 'out';
  return 'unknown';
}

// ----- vendor JSON (validated leniently: unknown keys ignored, one bad row never fails a page) ---------------------------------

const scalar = z.union([z.string().max(200), z.number()]).transform((v) => String(v));
const responseSchema = z.object({ code: scalar.nullish(), message: z.string().max(2000).nullish() }).nullish();
const envelopeSchema = z.object({ Response: responseSchema }).loose();

const eventRowSchema = z.object({
  id: scalar,
  datetime: z.string().min(1).max(64),
  server_datetime: z.string().max(64).nullish(),
  user_id: z.object({ user_id: scalar.nullish() }).loose().nullish(),
  device_id: z.object({ id: scalar.nullish(), name: z.string().max(400).nullish() }).loose().nullish(),
  event_type_id: z.object({ code: scalar.nullish() }).loose().nullish(),
  tna_key: scalar.nullish(),
});
type BioStarEventRow = z.infer<typeof eventRowSchema>;
const eventPageSchema = z.object({ EventCollection: z.object({ rows: z.array(z.unknown()).max(BIOSTAR_EVENTS_MAX_LIMIT + 1).nullish(), total: scalar.nullish() }).loose().nullish(), Response: responseSchema }).loose();

const userRowSchema = z.object({
  user_id: scalar,
  name: z.string().max(400).nullish(),
  disabled: scalar.nullish(),
  user_group_id: z.object({ id: scalar.nullish(), name: z.string().max(400).nullish() }).loose().nullish(),
  start_datetime: z.string().max(64).nullish(),
  expiry_datetime: z.string().max(64).nullish(),
  pin_exists: scalar.nullish(),
  card_count: scalar.nullish(),
  fingerprint_template_count: scalar.nullish(),
  face_count: scalar.nullish(),
});
type BioStarUserRow = z.infer<typeof userRowSchema>;
const userPageSchema = z.object({ UserCollection: z.object({ rows: z.array(z.unknown()).nullish(), total: scalar.nullish() }).loose().nullish(), Response: responseSchema }).loose();
const userDetailSchema = z.object({ User: z.unknown().optional(), Response: responseSchema }).loose();

const deviceRowSchema = z.object({
  id: scalar,
  name: z.string().max(400).nullish(),
  status: scalar.nullish(),
  device_type_id: z.object({ id: scalar.nullish(), name: z.string().max(400).nullish() }).loose().nullish(),
  version: z.object({ firmware: z.string().max(200).nullish(), product_name: z.string().max(200).nullish() }).loose().nullish(),
});
type BioStarDeviceRow = z.infer<typeof deviceRowSchema>;
const devicePageSchema = z.object({ DeviceCollection: z.object({ rows: z.array(z.unknown()).nullish(), total: scalar.nullish() }).loose().nullish(), Response: responseSchema }).loose();

// ----- cursor ---------------------------------------------------------------------------------------------------------------

/** `details.reason` of the error raised for a cursor this provider did not issue (the worker answers with a time-based rewind). */
export const BIOSTAR_INVALID_CURSOR_REASON = 'invalid_cursor';

/**
 * Stored cursor `{ since, lastId }`: `since` (UTC ISO) is the lower `datetime` bound fixed at the first pull, `lastId` the highest
 * BioStar event id delivered (null before the first row). Event ids are assigned by the server's DB in insertion order, so
 * `id > lastId` also catches punches a terminal uploads late (older `datetime`, newer id). `{}` = no cursor.
 */
export interface BioStarCursor { since: string; lastId: string | null }

export function parseBioStarCursor(cursor: SyncCursor | null): BioStarCursor | null {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor !== 'object' || Array.isArray(cursor)) throw invalidCursor(cursor);
  const keys = Object.keys(cursor);
  if (keys.length === 0) return null;
  const { since, lastId } = cursor as Record<string, unknown>;
  if (keys.some((k) => k !== 'since' && k !== 'lastId')) throw invalidCursor(cursor);
  if (typeof since !== 'string' || !DateTime.fromISO(since, { zone: 'utc' }).isValid) throw invalidCursor(cursor);
  if (!(lastId === null || lastId === undefined || (typeof lastId === 'string' && EVENT_ID_RE.test(lastId)))) throw invalidCursor(cursor);
  return { since, lastId: typeof lastId === 'string' ? lastId : null };
}
function invalidCursor(cursor: unknown): ProviderError {
  return new ProviderError('INVALID_CONFIG', 'Unparseable BioStar 2 attendance cursor', { retryable: false, details: { reason: BIOSTAR_INVALID_CURSOR_REASON, cursor: boundedText(JSON.stringify(cursor) ?? String(cursor), 200) } });
}

/** ISO instant → the form the collection uses in conditions (`2022-03-01T15:00:00.000Z`). */
function toSearchTime(iso: string): string {
  const dt = DateTime.fromISO(iso, { setZone: true });
  if (!dt.isValid) throw new ProviderError('INVALID_CONFIG', `Invalid sync start time "${boundedText(iso, 64)}"`, { retryable: false, details: { field: 'since' } });
  return dt.toUTC().toISO({ suppressMilliseconds: false }) ?? iso;
}

const maxId = (a: string | null, b: string): string => (a === null || BigInt(b) > BigInt(a) ? b : a);

// ----- mapping --------------------------------------------------------------------------------------------------------------

export type BioStarSkipReason = 'not_auth_success' | 'no_user' | 'bad_time';

/**
 * Event row → RawTransaction, or the reason it is skipped. BioStar reports `datetime` in UTC (collection: "the datetime shown on the
 * response is based on UTC-0"); a value without an offset is therefore read as UTC, never in the device zone. `deviceLocalTime` is
 * that instant on the terminal's wall clock (ctx.timezone), the verbatim vendor string stays in `rawPayload.datetime`.
 */
export function mapBioStarEvent(row: BioStarEventRow, timezone: string): { transaction: RawTransaction } | { skip: BioStarSkipReason } {
  const code = Number(row.event_type_id?.code ?? NaN);
  const cls = classifyBioStarEvent(code);
  if (!cls) return { skip: 'not_auth_success' };
  const userId = (row.user_id?.user_id ?? '').trim();
  if (userId.length === 0 || userId.length > 64) return { skip: 'no_user' };
  let punched: DateTime;
  try { punched = parseDeviceTime(row.datetime, 'UTC'); } catch { return { skip: 'bad_time' }; }
  const zone = isValidTimezone(timezone) ? timezone : null;
  return {
    transaction: {
      providerTransactionId: row.id,
      deviceEmployeeId: userId,
      punchedAt: toIsoUtc(punched),
      deviceLocalTime: zone ? punched.setZone(zone).toFormat('yyyy-MM-dd HH:mm:ss') : null,
      verificationMethod: cls.method,
      direction: mapBioStarTnaKey(row.tna_key),
      rawPayload: {
        biostarEventId: row.id,
        eventCode: code,
        mainCode: cls.mainCode,
        subCode: cls.subCode,
        authMode: cls.mode,
        duress: cls.duress,
        tnaKey: boundedText(row.tna_key ?? undefined, 8),
        biostarUserId: userId,
        biostarDeviceId: boundedText(row.device_id?.id ?? undefined, RAW_TEXT_MAX),
        biostarDeviceName: boundedText(row.device_id?.name ?? undefined, RAW_TEXT_MAX),
        datetime: boundedText(row.datetime, RAW_TEXT_MAX),
        serverDatetime: boundedText(row.server_datetime ?? undefined, RAW_TEXT_MAX),
      },
    },
  };
}

const truthy = (v: string | null | undefined): boolean => (v ?? '').trim().toLowerCase() === 'true' || v === '1';
const count = (v: string | null | undefined): number | null => { const n = Number(v); return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : null; };

/** Server user → DeviceEmployee. PINs come back encrypted and cards are separate objects, so neither is returned; never templates. */
export function mapBioStarUser(row: BioStarUserRow): DeviceEmployee | null {
  const id = row.user_id.trim();
  if (id.length === 0 || id.length > 64) return null;
  const name = (row.name ?? '').trim() || id;
  return {
    deviceUserId: id,
    name: name.slice(0, 64),
    cardNumber: null,
    pin: null,
    privilege: 'user',
    enabled: !truthy(row.disabled),
    photoUrl: null,
    extra: {
      userGroupId: row.user_group_id?.id ?? null,
      pinExists: row.pin_exists != null ? truthy(row.pin_exists) : null,
      cardCount: count(row.card_count),
      fingerprintCount: count(row.fingerprint_template_count),
      faceCount: count(row.face_count),
      expiryDatetime: boundedText(row.expiry_datetime ?? undefined, RAW_TEXT_MAX),
    },
  };
}

/** BioStar rejects names over 48 characters and names containing an ASCII single quote (documented known errors). */
export function bioStarName(name: string): { value: string; adjusted: boolean } {
  const value = name.trim().replace(/'/g, '’').slice(0, NAME_MAX);
  return { value, adjusted: value !== name };
}

// ----- provider -------------------------------------------------------------------------------------------------------------

export interface BioStarConfig { baseUrl: string; loginId: string; password: string; deviceId: string | undefined; sessionKey: string }
interface CachedSession { id: string; expiresAt: number }

function vendorCode(json: unknown): string | null {
  const parsed = envelopeSchema.safeParse(json);
  return parsed.success ? (parsed.data.Response?.code ?? null) : null;
}

export type SupremaBioStar2ProviderOptions = VendorHttpOptions & { clock?: () => Date; definition?: ProviderDefinition };

export class SupremaBioStar2Provider implements DeviceProvider {
  readonly definition: ProviderDefinition;
  private readonly http: VendorHttpClient;
  private readonly clock: () => Date;
  private readonly sessions = new Map<string, CachedSession>();
  private readonly logins = new Map<string, Promise<string>>();

  constructor(options: SupremaBioStar2ProviderOptions = {}) {
    const { clock, definition, ...http } = options;
    this.definition = definition ?? SUPREMA_BIOSTAR2_DEFINITION;
    this.clock = clock ?? (() => new Date());
    this.http = new VendorHttpClient(VENDOR, http);
  }

  /** Config + credentials for one call. INVALID_CONFIG is terminal: the device is flagged instead of retried. */
  resolveConfig(ctx: ProviderContext): BioStarConfig {
    const baseUrl = this.http.baseUrl(ctx.config['baseUrl'] ?? ctx.endpointUrl);
    const loginId = requiredString(ctx.config, 'loginId', VENDOR);
    // the password is used byte-for-byte (not trimmed): a secret is never "normalised"
    const password = ctx.credentials['password'];
    if (typeof password !== 'string' || password.length === 0) throw new ProviderError('INVALID_CONFIG', `${VENDOR}: password is not configured`, { retryable: false, details: { field: 'password' } });
    const deviceId = optionalString(ctx.config, 'deviceId');
    if (deviceId !== undefined && !DEVICE_ID_RE.test(deviceId)) throw new ProviderError('INVALID_CONFIG', `${VENDOR}: deviceId must be the numeric BioStar device ID`, { retryable: false, details: { field: 'deviceId' } });
    const sessionKey = sha256Hex(`${ctx.organizationId}|${ctx.deviceId}|${baseUrl}|${loginId}|${sha256Hex(password)}`);
    return { baseUrl, loginId, password, deviceId, sessionKey };
  }

  // ----- session ------------------------------------------------------------------------------------------------------------

  private async login(ctx: ProviderContext, cfg: BioStarConfig): Promise<string> {
    const res = await this.http.request(ctx, { method: 'POST', url: joinUrl(cfg.baseUrl, '/api/login'), body: { User: { login_id: cfg.loginId, password: cfg.password } }, label: 'POST /api/login' });
    const code = vendorCode(res.json);
    const sessionId = res.headers['bs-session-id']?.trim();
    if ((code !== null && code !== '0') || !sessionId || !/^[A-Za-z0-9-]{8,200}$/.test(sessionId)) {
      ctx.logger.warn({ event: 'biostar_login_rejected', vendorCode: code, hasSession: !!sessionId, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'BioStar 2 login did not issue a session');
      throw new ProviderError('AUTH_FAILED', `${VENDOR} did not accept the login`, { retryable: false, details: { request: 'POST /api/login', vendorCode: code } });
    }
    if (this.sessions.size >= MAX_CACHED_SESSIONS) {
      const oldest = this.sessions.keys().next();
      if (!oldest.done) this.sessions.delete(oldest.value);
    }
    this.sessions.set(cfg.sessionKey, { id: sessionId, expiresAt: this.clock().getTime() + SESSION_TTL_MS });
    ctx.logger.info({ event: 'biostar_login', deviceId: ctx.deviceId, organizationId: ctx.organizationId, latencyMs: res.latencyMs }, 'BioStar 2 session opened');
    return sessionId;
  }

  /** Cached session, or one login shared by concurrent callers (a second login of the same operator may sign the first out). */
  private async session(ctx: ProviderContext, cfg: BioStarConfig): Promise<string> {
    const cached = this.sessions.get(cfg.sessionKey);
    if (cached && cached.expiresAt > this.clock().getTime()) return cached.id;
    const pending = this.logins.get(cfg.sessionKey);
    if (pending) return pending;
    const p = this.login(ctx, cfg).finally(() => this.logins.delete(cfg.sessionKey));
    this.logins.set(cfg.sessionKey, p);
    return p;
  }

  /**
   * One authenticated exchange. An expired session (HTTP 401 or `Response.code "10"` = login required) is renewed once; a second
   * rejection is AUTH_FAILED. Any other non-zero `Response.code` on a 2xx is a vendor error (code 4 = the terminal did not answer in
   * time → retryable). `passStatuses` hands selected error statuses back to the caller (e.g. "user not found").
   */
  private async call(ctx: ProviderContext, cfg: BioStarConfig, method: VendorHttpMethod, path: string, opts: { body?: unknown; label?: string; passStatuses?: number[]; passVendorErrors?: boolean } = {}): Promise<VendorHttpResponse> {
    const label = opts.label ?? `${method} ${path.split('?')[0]}`;
    for (let attempt = 0; ; attempt++) {
      const sessionId = await this.session(ctx, cfg);
      const res = await this.http.request(ctx, { method, url: joinUrl(cfg.baseUrl, path), headers: { 'bs-session-id': sessionId }, ...(opts.body !== undefined ? { body: opts.body } : {}), label, passStatuses: [...(opts.passStatuses ?? []), 401] });
      const code = vendorCode(res.json);
      if (res.status === 401 || code === '10') {
        if (this.sessions.get(cfg.sessionKey)?.id === sessionId) this.sessions.delete(cfg.sessionKey);
        if (attempt >= 1) throw new ProviderError('AUTH_FAILED', `${VENDOR} rejected the session (login required)`, { retryable: false, details: { request: label, status: res.status } });
        ctx.logger.info({ event: 'biostar_session_expired', request: label, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'BioStar 2 session expired; logging in again');
        continue;
      }
      if (res.status >= 200 && res.status < 300 && code !== null && code !== '0' && !opts.passVendorErrors) {
        ctx.logger.warn({ event: 'biostar_vendor_error', request: label, vendorCode: code, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'BioStar 2 answered with a non-zero response code');
        throw new ProviderError('VENDOR_ERROR', `${VENDOR} rejected ${label} (code ${boundedText(code, 16)})`, { retryable: code === '4', details: { request: label, vendorCode: code } });
      }
      return res;
    }
  }

  private parse<S extends z.ZodType>(ctx: ProviderContext, res: VendorHttpResponse, schema: S, label: string): z.infer<S> {
    const parsed = schema.safeParse(res.json);
    if (!parsed.success) {
      ctx.logger.warn({ event: 'biostar_unexpected_response', request: label, status: res.status, issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`), deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'BioStar 2 returned an unexpected response shape');
      // VENDOR_ERROR, never INVALID_CONFIG/PROTOCOL_ERROR: an odd answer must not make the sync engine rewind the cursor
      throw new ProviderError('VENDOR_ERROR', `${VENDOR} returned an unexpected response to ${label}`, { retryable: true, details: { request: label, status: res.status } });
    }
    return parsed.data;
  }

  // ----- devices ------------------------------------------------------------------------------------------------------------

  private async listDevices(ctx: ProviderContext, cfg: BioStarConfig): Promise<{ rows: BioStarDeviceRow[]; latencyMs: number }> {
    const res = await this.call(ctx, cfg, 'GET', '/api/devices');
    const page = this.parse(ctx, res, devicePageSchema, 'GET /api/devices');
    const rows: BioStarDeviceRow[] = [];
    for (const raw of page.DeviceCollection?.rows ?? []) { const r = deviceRowSchema.safeParse(raw); if (r.success) rows.push(r.data); }
    return { rows, latencyMs: res.latencyMs };
  }

  /** The configured terminal's row; NOT_FOUND when the server does not know that device ID. */
  private pickDevice(cfg: BioStarConfig, rows: BioStarDeviceRow[]): BioStarDeviceRow | null {
    if (cfg.deviceId === undefined) return null;
    const row = rows.find((r) => r.id === cfg.deviceId);
    if (!row) throw new ProviderError('NOT_FOUND', `${VENDOR}: device ${cfg.deviceId} is not registered on the BioStar server`, { retryable: false, details: { field: 'deviceId' } });
    return row;
  }

  private summarize(rows: BioStarDeviceRow[]): Record<string, number> {
    const by = (s: string): number => rows.filter((r) => r.status === s).length;
    return { deviceCount: rows.length, connected: by('1'), disconnected: by('0'), syncError: by('2') };
  }

  private info(cfg: BioStarConfig, rows: BioStarDeviceRow[]): DeviceInfo {
    const row = this.pickDevice(cfg, rows);
    if (!row) return { model: 'BioStar 2 server', extra: { ...this.summarize(rows) } };
    return {
      // the BioStar device ID is the terminal's factory ID printed on its label (REPORTED)
      serialNumber: row.id,
      ...(row.device_type_id?.name ? { model: row.device_type_id.name } : {}),
      ...(row.version?.firmware ? { firmwareVersion: row.version.firmware } : {}),
      extra: { biostarDeviceId: row.id, name: boundedText(row.name ?? undefined, RAW_TEXT_MAX), status: row.status ?? null, ...this.summarize(rows) },
    };
  }

  // ----- DeviceProvider -----------------------------------------------------------------------------------------------------

  /** Login + one authenticated read (`GET /api/devices`); ok only after BioStar answered it. */
  async testConnection(ctx: ProviderContext): Promise<ConnectionResult> {
    const started = Date.now();
    const probe = await connectionProbe(started, async () => {
      const cfg = this.resolveConfig(ctx);
      const { rows, latencyMs } = await this.listDevices(ctx, cfg);
      return { cfg, rows, latencyMs, info: this.info(cfg, rows) };
    });
    if (!probe.ok) return probe;
    const { cfg, rows, latencyMs, info } = probe.value;
    return {
      ok: true,
      message: cfg.deviceId ? `Connected to BioStar 2; device ${cfg.deviceId} found` : `Connected to BioStar 2 (${rows.length} device(s))`,
      latencyMs,
      deviceInfo: info,
      details: { ...this.summarize(rows), deviceId: cfg.deviceId ?? null },
    };
  }

  async getDeviceInfo(ctx: ProviderContext): Promise<DeviceInfo> {
    const cfg = this.resolveConfig(ctx);
    const { rows } = await this.listDevices(ctx, cfg);
    return this.info(cfg, rows);
  }

  async getCapabilities(_ctx: ProviderContext): Promise<DeviceCapabilities> {
    return { ...this.definition.capabilities };
  }

  /**
   * Server answering = online, unless a terminal is configured: then its BioStar `status` decides (0 disconnected, 1 connected,
   * 2 sync error — still online, flagged). `GET /api/devices` reads the server's view and never wakes a terminal.
   */
  async getDeviceStatus(ctx: ProviderContext): Promise<DeviceStatus> {
    const cfg = this.resolveConfig(ctx);
    const { rows, latencyMs } = await this.listDevices(ctx, cfg);
    const row = this.pickDevice(cfg, rows);
    const now = this.clock().toISOString();
    if (!row) return { online: true, lastSeenAt: now, details: { latencyMs, ...this.summarize(rows) } };
    const online = row.status === '1' || row.status === '2';
    return { online, ...(online ? { lastSeenAt: now } : {}), details: { latencyMs, biostarStatus: row.status ?? null, syncError: row.status === '2' } };
  }

  /**
   * One `POST /api/events/search` page: `datetime BETWEEN [since, 2037-12-31]` AND `id GREATER lastId` (AND `device_id EQUAL`),
   * ordered by id ascending. The cursor advances to the highest id of the page (skipped rows included), so a page of door events
   * never stalls the stream; `hasMore` only when the page was full AND the cursor moved.
   */
  async pullAttendance(ctx: ProviderContext, cursor: SyncCursor | null, opts: { pageSize?: number; since?: string } = {}): Promise<AttendancePullResult> {
    const stored = parseBioStarCursor(cursor);
    const cfg = this.resolveConfig(ctx);
    const since = stored?.since ?? (opts.since !== undefined
      ? toSearchTime(opts.since)
      : DateTime.fromJSDate(this.clock(), { zone: 'utc' }).minus({ days: BIOSTAR_DEFAULT_LOOKBACK_DAYS }).startOf('day').toISO({ suppressMilliseconds: false })!);
    const lastId = stored?.lastId ?? null;
    const limit = Math.min(BIOSTAR_EVENTS_MAX_LIMIT, Math.max(1, Math.floor(opts.pageSize ?? BIOSTAR_EVENTS_DEFAULT_LIMIT)));
    const conditions: Array<{ column: string; operator: number; values: string[] }> = [{ column: 'datetime', operator: BIOSTAR_OPERATOR.BETWEEN, values: [since, SEARCH_UPPER_BOUND] }];
    if (lastId !== null) conditions.push({ column: 'id', operator: BIOSTAR_OPERATOR.GREATER, values: [lastId] });
    if (cfg.deviceId !== undefined) conditions.push({ column: 'device_id', operator: BIOSTAR_OPERATOR.EQUAL, values: [cfg.deviceId] });
    const label = 'POST /api/events/search';
    const res = await this.call(ctx, cfg, 'POST', '/api/events/search', { body: { Query: { limit, conditions, orders: [{ column: 'id', descending: false }] } }, label });
    const page = this.parse(ctx, res, eventPageSchema, label);
    const rows = page.EventCollection?.rows ?? [];

    const transactions: RawTransaction[] = [];
    const skipped = { invalid: 0, notAuthSuccess: 0, noUser: 0, badTime: 0, notAfterCursor: 0 };
    let highest: string | null = lastId;
    for (const raw of rows) {
      const parsed = eventRowSchema.safeParse(raw);
      if (!parsed.success || !EVENT_ID_RE.test(parsed.data.id)) { skipped.invalid += 1; continue; }
      // defensive: a server that ignored the id condition must not re-deliver or move the cursor backwards
      if (lastId !== null && BigInt(parsed.data.id) <= BigInt(lastId)) { skipped.notAfterCursor += 1; continue; }
      highest = maxId(highest, parsed.data.id);
      const mapped = mapBioStarEvent(parsed.data, ctx.timezone);
      if ('skip' in mapped) {
        if (mapped.skip === 'not_auth_success') skipped.notAuthSuccess += 1; else if (mapped.skip === 'no_user') skipped.noUser += 1; else skipped.badTime += 1;
        continue;
      }
      transactions.push(mapped.transaction);
    }
    if (skipped.invalid + skipped.badTime + skipped.notAfterCursor > 0) ctx.logger.warn({ event: 'biostar_event_rows_skipped', ...skipped, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'BioStar 2 event rows skipped (malformed or not after the cursor)');
    const advanced = highest !== lastId;
    if (rows.length >= limit && !advanced) ctx.logger.warn({ event: 'biostar_event_cursor_stalled', received: rows.length, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'BioStar 2 returned a full page without a usable event id');
    return {
      transactions,
      nextCursor: { since, lastId: highest },
      hasMore: rows.length >= limit && advanced,
      meta: { received: rows.length, limit, latencyMs: res.latencyMs, lastId: highest, skipped },
    };
  }

  /** `GET /api/users?group_id=1&limit&offset&order_by=user_id:false` (group 1 = All Users). Page cursor `offset:<n>`. */
  async listEmployees(ctx: ProviderContext, pageCursor: PageCursor): Promise<DeviceEmployeePage> {
    let offset = 0;
    if (pageCursor !== null) {
      const m = /^offset:(\d{1,9})$/.exec(pageCursor);
      if (!m) throw new ProviderError('INVALID_CONFIG', `${VENDOR}: invalid employee page cursor`, { retryable: false, details: { reason: BIOSTAR_INVALID_CURSOR_REASON } });
      offset = Number(m[1]);
    }
    const cfg = this.resolveConfig(ctx);
    const res = await this.call(ctx, cfg, 'GET', `/api/users?group_id=1&limit=${BIOSTAR_USERS_PAGE_SIZE}&offset=${offset}&order_by=user_id:false`, { label: 'GET /api/users' });
    const page = this.parse(ctx, res, userPageSchema, 'GET /api/users');
    const rows = page.UserCollection?.rows ?? [];
    const employees: DeviceEmployee[] = [];
    for (const raw of rows) {
      const r = userRowSchema.safeParse(raw);
      const e = r.success ? mapBioStarUser(r.data) : null;
      if (e) employees.push(e);
    }
    const total = Number(page.UserCollection?.total ?? NaN);
    const end = offset + rows.length;
    const more = rows.length > 0 && (Number.isFinite(total) ? end < total : rows.length >= BIOSTAR_USERS_PAGE_SIZE);
    return { employees, nextCursor: more ? `offset:${end}` : null };
  }

  /** `GET /api/users/:id` → the user, or null when BioStar says it does not exist (4xx / non-zero code / no User). */
  private async findUser(ctx: ProviderContext, cfg: BioStarConfig, userId: string): Promise<BioStarUserRow | null> {
    const res = await this.call(ctx, cfg, 'GET', `/api/users/${encodeURIComponent(userId)}`, { label: 'GET /api/users/:id', passStatuses: [400, 404], passVendorErrors: true });
    if (res.status !== 200) return null;
    const body = this.parse(ctx, res, userDetailSchema, 'GET /api/users/:id');
    const code = body.Response?.code ?? '0';
    if (code !== '0') return null;
    const user = userRowSchema.safeParse(body.User);
    return user.success && user.data.user_id === userId ? user.data : null;
  }

  private assertUserId(deviceUserId: string): void {
    if (!USER_ID_RE.test(deviceUserId)) throw new ProviderError('INVALID_CONFIG', `${VENDOR}: device user id must be 1–32 letters, digits, "-" or "_"`, { retryable: false, details: { field: 'deviceUserId' } });
  }

  /**
   * Create (`POST /api/users`) or update (`PUT /api/users/:id`) a server user; BioStar distributes it to its terminals (server
   * auto-sync setting, REPORTED). An update keeps the user's group and validity period. Card number and admin privilege are NOT
   * applied (card objects / operator levels are out of scope) and are listed in `details.notApplied` — never silently claimed.
   */
  async upsertEmployee(ctx: ProviderContext, employee: DeviceEmployee): Promise<DeviceOperationResult> {
    this.assertUserId(employee.deviceUserId);
    const pin = employee.pin ?? null;
    if (pin !== null && !/^\d{4,16}$/.test(pin)) throw new ProviderError('INVALID_CONFIG', `${VENDOR}: PIN must be 4–16 digits`, { retryable: false, details: { field: 'pin' } });
    const cfg = this.resolveConfig(ctx);
    const name = bioStarName(employee.name);
    const notApplied: string[] = [];
    if (employee.cardNumber) notApplied.push('cardNumber');
    if (employee.privilege === 'admin') notApplied.push('privilege');
    const existing = await this.findUser(ctx, cfg, employee.deviceUserId);
    const user: Record<string, unknown> = {
      name: name.value,
      disabled: employee.enabled ? 'false' : 'true',
      user_group_id: { id: existing?.user_group_id?.id ?? '1' },
      start_datetime: existing?.start_datetime ?? USER_START,
      expiry_datetime: existing?.expiry_datetime ?? USER_EXPIRY,
      ...(pin !== null ? { pin } : {}),
    };
    if (existing) await this.call(ctx, cfg, 'PUT', `/api/users/${encodeURIComponent(employee.deviceUserId)}`, { body: { User: user }, label: 'PUT /api/users/:id' });
    else await this.call(ctx, cfg, 'POST', '/api/users', { body: { User: { user_id: employee.deviceUserId, ...user } } });
    if (notApplied.length > 0) ctx.logger.info({ event: 'biostar_fields_not_applied', fields: notApplied, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'BioStar 2 user pushed without card/privilege');
    return {
      ok: true,
      deviceUserId: employee.deviceUserId,
      message: existing ? 'User updated on the BioStar server' : 'User created on the BioStar server',
      details: { created: !existing, nameAdjusted: name.adjusted, ...(notApplied.length > 0 ? { notApplied } : {}) },
    };
  }

  /** `DELETE /api/users?id=<id>` (one id; `+` would be a list). Idempotent: a user that is already gone is a success. */
  async deleteEmployee(ctx: ProviderContext, deviceUserId: string): Promise<DeviceOperationResult> {
    this.assertUserId(deviceUserId);
    const cfg = this.resolveConfig(ctx);
    const res = await this.call(ctx, cfg, 'DELETE', `/api/users?id=${encodeURIComponent(deviceUserId)}`, { label: 'DELETE /api/users', passStatuses: [400, 404], passVendorErrors: true });
    const code = vendorCode(res.json);
    if (res.status >= 200 && res.status < 300 && (code === null || code === '0')) return { ok: true, deviceUserId, message: 'User deleted from the BioStar server' };
    // BioStar answers "id which doesn't exist" with an error: confirm absence before calling it a success
    if (!(await this.findUser(ctx, cfg, deviceUserId))) return { ok: true, deviceUserId, message: 'User was not on the BioStar server', details: { alreadyAbsent: true } };
    throw new ProviderError('VENDOR_ERROR', `${VENDOR} did not delete user ${deviceUserId}`, { retryable: res.status >= 500, details: { request: 'DELETE /api/users', status: res.status, vendorCode: code } });
  }

  async restart(_ctx: ProviderContext): Promise<DeviceOperationResult> {
    throw unsupported('restart', 'the BioStar 2 REST API documents no terminal reboot endpoint');
  }
}
