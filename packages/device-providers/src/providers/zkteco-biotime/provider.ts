import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { DeviceCapabilities, DeviceEmployee, PunchDirection, RawTransaction, VerificationMethod } from '@flowza/contracts';
import { unsupported } from '../../errors.js';
import { assertTimezone, boundedText, parseDeviceTime, toIsoUtc } from '../../protocol-utils.js';
import { ProviderError, type AttendancePullResult, type ConnectionResult, type DeviceEmployeePage, type DeviceInfo, type DeviceOperationResult, type DeviceProvider, type DeviceStatus, type PageCursor, type ProviderContext, type ProviderDefinition, type SyncCursor } from '../../types.js';
import { connectionProbe, joinUrl, optionalString, requiredString, VendorHttpClient, type VendorHttpMethod, type VendorHttpOptions, type VendorHttpResponse } from '../../vendor-http.js';
import { ZKTECO_BIOTIME_DEFINITION } from './definition.js';

/**
 * ZKBio Time / BioTime REST adapter. Every endpoint below is in the BioTime 8.0 API User Manual (VERIFIED_OFFICIAL_DOC, see
 * definition.docsUrl); what the manual does not say (ordering of list endpoints, punch_state / verify_type / dev_privilege codes,
 * terminal `state` values, 9.x behaviour) is marked REPORTED and handled defensively:
 *  - login: `POST /jwt-api-token-auth/` → `Authorization: JWT <token>`; a server without the JWT route (404/405) falls back to
 *    `POST /api-token-auth/` → `Authorization: Token <token>` (manual §2.1/§2.2/§4). Tokens live in memory only (never persisted),
 *    keyed by sha256(device | base URL | user | sha256(password)) so a changed password never reuses an old token; a 401/403 on a
 *    cached token triggers ONE re-login.
 *  - lists answer `{ count, next, previous, msg, code, data: [...] }` (manual §4.1); pages are requested with `page` + `limit`
 *    (documented) and `page_size` (the DRF spelling some builds use — unknown query params are ignored by the server).
 *  - all traffic goes through VendorHttpClient (egress guard, ctx.acquire per request, status → ProviderError mapping).
 */

const VENDOR = 'ZKBio Time';
const LOCAL_FORMAT = 'yyyy-MM-dd HH:mm:ss';
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 1000;
const DEFAULT_EMPLOYEE_PAGE_SIZE = 100;
const DEFAULT_LATE_ARRIVAL_HOURS = 24;
const MAX_LATE_ARRIVAL_HOURS = 168;
const DEFAULT_HISTORY_DAYS = 30;
/** A scan whose result set changes under it restarts from page 1 at most this often; afterwards it continues (and says so). */
export const BIOTIME_MAX_SCAN_RESTARTS = 3;
const TERMINAL_ONLINE_MINUTES = 10;
const TOKEN_DEFAULT_TTL_MS = 30 * 60_000;
const TOKEN_MAX_TTL_MS = 12 * 60 * 60_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const TOKEN_CACHE_MAX = 500;
const RAW_FIELD_MAX = 64;

/** `details.reason` of the error raised for a cursor this provider did not issue (the sync engine rewinds on INVALID_CONFIG). */
export const BIOTIME_INVALID_CURSOR_REASON = 'invalid_cursor';

// ----- vocabularies (REPORTED: the 8.0 manual shows the fields but not their code tables) ------------------------------------

/** REPORTED: `punch_state` → direction (0 check-in, 1 check-out, 2 break-out, 3 break-in, 4 OT-in, 5 OT-out, 255 "none"). */
export const BIOTIME_PUNCH_STATES: Readonly<Record<string, PunchDirection>> = { '0': 'in', '1': 'out', '2': 'break_out', '3': 'break_in', '4': 'overtime_in', '5': 'overtime_out' };

/**
 * REPORTED: `verify_type` follows ZKTeco's VerifyType table (1 fingerprint, 2 user id/PIN, 3 password, 4 card, 15 face, 25 palm).
 * 0 means "any/unspecified" in that table (older firmware also logged passwords as 0) and 5–14, 16–20 are combinations
 * (e.g. FP&Card): all of them map to `unknown` rather than a guessed method; the raw code stays in the payload.
 */
export const BIOTIME_VERIFY_TYPES: Readonly<Record<string, VerificationMethod>> = { '1': 'fingerprint', '2': 'pin', '3': 'password', '4': 'card', '15': 'face', '25': 'palm' };

export const mapBioTimePunchState = (v: unknown): PunchDirection => BIOTIME_PUNCH_STATES[String(v ?? '').trim()] ?? 'unknown';
export const mapBioTimeVerifyType = (v: unknown): VerificationMethod => BIOTIME_VERIFY_TYPES[String(v ?? '').trim()] ?? 'unknown';

/** REPORTED: `dev_privilege` 0 = normal user, 14 = device administrator (ZKTeco privilege codes). */
const ADMIN_PRIVILEGE = 14;

// ----- HTTP contract (lenient: unknown keys ignored; one bad row never fails a page) ------------------------------------------

const scalar = z.union([z.string(), z.number()]);
const text = scalar.transform((v) => String(v)).nullish();
const numberish = z.union([z.number(), z.string()]).nullish();

const envelopeSchema = z.object({
  count: z.number().int().nonnegative().nullish(),
  next: z.string().nullish(),
  msg: z.string().nullish(),
  code: scalar.nullish(),
  data: z.array(z.unknown()).nullish(),
  results: z.array(z.unknown()).nullish(),
});

export const bioTimeTransactionSchema = z.object({
  id: z.union([z.number().int().nonnegative(), z.string().min(1).max(64)]),
  emp_code: text,
  punch_time: z.string().min(1).max(64),
  punch_state: text,
  verify_type: text,
  work_code: text,
  terminal_sn: text,
  terminal_alias: text,
  area_alias: text,
  upload_time: text,
  source: text,
  purpose: text,
  is_attendance: text,
  longitude: numberish,
  latitude: numberish,
  gps_location: text,
});
export type BioTimeTransaction = z.infer<typeof bioTimeTransactionSchema>;

const areaRef = z.union([z.number(), z.object({ id: z.number().nullish(), area_code: text, area_name: text })]).nullish();
export const bioTimeTerminalSchema = z.object({
  id: z.number().nullish(),
  sn: z.string().min(1).max(64),
  alias: text,
  ip_address: text,
  state: numberish,
  terminal_tz: numberish,
  last_activity: text,
  fw_ver: text,
  push_ver: text,
  user_count: z.number().nullish(),
  fp_count: z.number().nullish(),
  face_count: z.number().nullish(),
  palm_count: z.number().nullish(),
  transaction_count: z.number().nullish(),
  area: areaRef,
});
export type BioTimeTerminal = z.infer<typeof bioTimeTerminalSchema>;

// `device_password` and `self_password` are deliberately NOT part of the schema: they are never read back or stored.
export const bioTimeEmployeeSchema = z.object({
  id: z.number().int(),
  emp_code: scalar.transform((v) => String(v).trim()),
  first_name: text,
  last_name: text,
  card_no: text,
  dev_privilege: numberish,
  department: z.union([z.number(), z.object({ id: z.number().nullish() })]).nullish(),
  area: z.array(z.union([z.number(), z.object({ id: z.number().nullish() })])).nullish(),
});
export type BioTimeEmployee = z.infer<typeof bioTimeEmployeeSchema>;

const tokenSchema = z.object({ token: z.string().min(8).max(4096) });

// ----- cursor -------------------------------------------------------------------------------------------------------------

/**
 * Attendance cursor — a punch-time sliding window with overlap, because the documented API filters transactions only by
 * `start_time`/`end_time` (punch time) and documents neither an `upload_time` filter nor an ordering:
 *
 *  - idle:  `{ v: 1, next }` — the next scan covers punch times [next, now].
 *  - scan:  `{ v: 1, scan: { from, to, page, size, count, restarts } }` — a scan pages through a FROZEN window [from, to] with a
 *           frozen page size, so the same cursor always asks for the same page (idempotent), and real-time punches (after `to`)
 *           cannot shift its pages.
 *  - when a scan's last page is read, `next = max(from, to - lateArrivalHours)`: every pull re-reads the last N hours (default 24)
 *    so rows a terminal uploads late (offline terminal, ADMS upload interval) are still caught; the re-delivered rows carry the
 *    same BioTime `id` (providerTransactionId) and the same dedupe hash, so ingestion drops them. The window never moves back
 *    before the configured start.
 *  - `count` (from page 1) guards against the result set changing under a scan (late rows landing in the window, deletions): a
 *    different count — or a 404 "Invalid page" past the new end — restarts the scan at page 1 (≤ 3 times), so a shifted page can
 *    never skip a row.
 *
 * Limitation (documented, REPORTED): a punch uploaded more than `lateArrivalHours` after its punch time falls outside every
 * later window; such lags are detected from `upload_time` and logged (`biotime_late_upload_detected`), and a full re-sync
 * (`since`) recovers them. All instants are stored as ISO UTC and converted to server-local wall time with Luxon per request.
 */
export interface BioTimeScan { from: string; to: string; page: number; size: number; count: number | null; restarts: number }
export type BioTimeCursor = { v: 1; next: string; scan?: undefined } | { v: 1; scan: BioTimeScan; next?: undefined };

const isoInstant = z.string().max(40).refine((s) => DateTime.fromISO(s, { setZone: true }).isValid);
const cursorSchema = z.union([
  z.object({ v: z.literal(1), next: isoInstant }).strict(),
  z.object({
    v: z.literal(1),
    scan: z.object({
      from: isoInstant, to: isoInstant,
      page: z.number().int().min(1).max(1_000_000),
      size: z.number().int().min(1).max(MAX_PAGE_SIZE),
      count: z.number().int().nonnegative().nullable(),
      restarts: z.number().int().min(0).max(BIOTIME_MAX_SCAN_RESTARTS),
    }).strict(),
  }).strict(),
]);

/** `null` / `{}` = start fresh; anything else must be a cursor this provider issued, or INVALID_CONFIG (reason invalid_cursor). */
export function parseBioTimeCursor(cursor: SyncCursor | null): BioTimeCursor | null {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor === 'object' && !Array.isArray(cursor) && Object.keys(cursor).length === 0) return null;
  const parsed = cursorSchema.safeParse(cursor);
  if (!parsed.success) {
    throw new ProviderError('INVALID_CONFIG', 'Unparseable ZKBio Time attendance cursor', { retryable: false, details: { reason: BIOTIME_INVALID_CURSOR_REASON, cursor: boundedText(JSON.stringify(cursor) ?? '', 200) } });
  }
  const c = parsed.data;
  if ('scan' in c && c.scan && Date.parse(c.scan.to) < Date.parse(c.scan.from)) {
    throw new ProviderError('INVALID_CONFIG', 'Unparseable ZKBio Time attendance cursor (window ends before it starts)', { retryable: false, details: { reason: BIOTIME_INVALID_CURSOR_REASON } });
  }
  return c as BioTimeCursor;
}

// ----- mapping ------------------------------------------------------------------------------------------------------------

const toNumber = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const bounded = (v: string | null | undefined, max = RAW_FIELD_MAX): string | null => boundedText(v ?? undefined, max);

export interface MappedBioTimeTransaction { transaction: RawTransaction | null; reason?: 'no_identity' | 'bad_time'; uploadLagMs?: number | null }

/**
 * BioTime transaction row → RawTransaction. Identity = `emp_code` (the BioTime personnel number, which is what FlowZa pushes as
 * deviceUserId); `punch_time` is wall-clock time of the BioTime server/terminal without an offset, read in `timezone` and kept
 * verbatim in `deviceLocalTime`. The payload is an allowlist of short fields — never `temperature`/`is_mask` (health data), the
 * nested `emp`/`terminal` objects, `crc` or `reserved`.
 */
export function mapBioTimeTransaction(row: BioTimeTransaction, timezone: string): MappedBioTimeTransaction {
  const empCode = (row.emp_code ?? '').trim();
  if (empCode.length === 0 || empCode.length > 64) return { transaction: null, reason: 'no_identity' };
  let at: DateTime;
  try { at = parseDeviceTime(row.punch_time, timezone); } catch (err) {
    if (ProviderError.is(err) && err.code === 'PROTOCOL_ERROR') return { transaction: null, reason: 'bad_time' };
    throw err;
  }
  let uploadLagMs: number | null = null;
  if (row.upload_time) {
    try { uploadLagMs = parseDeviceTime(row.upload_time, timezone).toMillis() - at.toMillis(); } catch { uploadLagMs = null; }
  }
  const id = String(row.id);
  return {
    uploadLagMs,
    transaction: {
      providerTransactionId: id,
      deviceEmployeeId: empCode,
      punchedAt: toIsoUtc(at),
      deviceLocalTime: row.punch_time.trim().slice(0, 64),
      verificationMethod: mapBioTimeVerifyType(row.verify_type),
      direction: mapBioTimePunchState(row.punch_state),
      rawPayload: {
        biotimeId: bounded(id),
        empCode: bounded(empCode),
        punchTime: bounded(row.punch_time),
        punchState: bounded(row.punch_state),
        verifyType: bounded(row.verify_type),
        workCode: bounded(row.work_code),
        terminalSn: bounded(row.terminal_sn),
        terminalAlias: bounded(row.terminal_alias),
        areaAlias: bounded(row.area_alias),
        uploadTime: bounded(row.upload_time),
        source: bounded(row.source),
        purpose: bounded(row.purpose),
        isAttendance: bounded(row.is_attendance),
        longitude: toNumber(row.longitude),
        latitude: toNumber(row.latitude),
        gpsLocation: bounded(row.gps_location, 128),
      },
    },
  };
}

const refId = (v: number | { id?: number | null | undefined } | null | undefined): number | null => (typeof v === 'number' ? v : v && typeof v.id === 'number' ? v.id : null);

/** BioTime employee → DeviceEmployee. The device password is never read back (pin: null); BioTime 8.0 has no enabled flag. */
export function mapBioTimeEmployee(row: BioTimeEmployee): DeviceEmployee | null {
  if (row.emp_code.length === 0 || row.emp_code.length > 64) return null;
  const name = [row.first_name ?? '', row.last_name ?? ''].map((s) => s.trim()).filter(Boolean).join(' ').slice(0, 64) || row.emp_code;
  const card = (row.card_no ?? '').trim();
  return {
    deviceUserId: row.emp_code,
    name,
    cardNumber: card.length > 0 && card.length <= 64 ? card : null,
    pin: null,
    privilege: toNumber(row.dev_privilege) === ADMIN_PRIVILEGE ? 'admin' : 'user',
    enabled: true,
    photoUrl: null,
    extra: { biotimeId: row.id, departmentId: refId(row.department), areaIds: (row.area ?? []).map(refId).filter((n): n is number => n !== null) },
  };
}

// ----- provider -----------------------------------------------------------------------------------------------------------

export type ZKBioTimeProviderOptions = VendorHttpOptions & { clock?: () => Date; definition?: ProviderDefinition };

export interface BioTimeConfig {
  baseUrl: string;
  username: string;
  password: string;
  terminalSn: string | undefined;
  departmentId: number | undefined;
  areaId: number | undefined;
  pageSize: number;
  lateArrivalMs: number;
}

interface Session { token: string; scheme: 'JWT' | 'Token'; expiresAt: number }
interface ApiRequest { method: VendorHttpMethod; path: string; query?: Record<string, string | number | undefined>; body?: unknown; passStatuses?: number[] }
interface ListPage<T> { rows: T[]; invalid: number; count: number | null; more: boolean }

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const clampInt = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = toNumber(v);
  return n === null ? fallback : Math.min(max, Math.max(min, Math.floor(n)));
};
function optionalId(source: Record<string, unknown>, key: string): number | undefined {
  const v = source[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = toNumber(v);
  if (n === null || !Number.isInteger(n) || n < 1) throw new ProviderError('INVALID_CONFIG', `${VENDOR}: ${key} must be a positive integer id`, { retryable: false, details: { field: key } });
  return n;
}

/** Expiry of a JWT from its `exp` claim (no signature check: we only use it to refresh early); null when absent/unreadable. */
function jwtExpiry(token: string): number | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const exp = (JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch { return null; }
}

export class ZKBioTimeProvider implements DeviceProvider {
  readonly definition: ProviderDefinition;
  private readonly http: VendorHttpClient;
  private readonly clock: () => Date;
  /** In-memory token cache (never persisted). */
  private readonly sessions = new Map<string, Session>();
  private readonly logins = new Map<string, Promise<Session>>();

  constructor(options: ZKBioTimeProviderOptions = {}) {
    const { clock, definition, ...http } = options;
    this.definition = definition ?? ZKTECO_BIOTIME_DEFINITION;
    this.clock = clock ?? (() => new Date());
    this.http = new VendorHttpClient(VENDOR, http);
  }

  /** Config + credentials for one call. INVALID_CONFIG is terminal: the sync engine flags the device instead of retrying. */
  resolveConfig(ctx: ProviderContext): BioTimeConfig {
    const baseUrl = this.http.baseUrl(ctx.config['baseUrl'] ?? ctx.endpointUrl);
    const username = requiredString(ctx.config, 'username', VENDOR);
    const password = requiredString(ctx.credentials, 'password', VENDOR);
    return {
      baseUrl, username, password,
      terminalSn: optionalString(ctx.config, 'terminalSn'),
      departmentId: optionalId(ctx.config, 'departmentId'),
      areaId: optionalId(ctx.config, 'areaId'),
      pageSize: clampInt(ctx.config['pageSize'], DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
      lateArrivalMs: clampInt(ctx.config['lateArrivalHours'], DEFAULT_LATE_ARRIVAL_HOURS, 1, MAX_LATE_ARRIVAL_HOURS) * 3_600_000,
    };
  }

  // ----- auth ---------------------------------------------------------------------------------------------------------------

  private sessionKey(ctx: ProviderContext, cfg: BioTimeConfig): string {
    return sha256(`${ctx.deviceId}|${cfg.baseUrl}|${cfg.username}|${sha256(cfg.password)}`);
  }

  /** Cached token, or a login (concurrent callers share one login). `fresh` = obtained by this call. */
  private async session(ctx: ProviderContext, cfg: BioTimeConfig, forceLogin = false): Promise<{ session: Session; fresh: boolean }> {
    const key = this.sessionKey(ctx, cfg);
    const cached = this.sessions.get(key);
    if (!forceLogin && cached && cached.expiresAt > this.clock().getTime()) return { session: cached, fresh: false };
    this.sessions.delete(key);
    let pending = this.logins.get(key);
    if (!pending) {
      pending = this.login(ctx, cfg).finally(() => this.logins.delete(key));
      this.logins.set(key, pending);
    }
    const session = await pending;
    if (this.sessions.size >= TOKEN_CACHE_MAX) { const oldest = this.sessions.keys().next().value; if (oldest !== undefined) this.sessions.delete(oldest); }
    this.sessions.set(key, session);
    return { session, fresh: true };
  }

  /**
   * Manual §2.1: `POST /jwt-api-token-auth/` → `{ token }` used as `JWT <token>`. A server without that route (404/405) gets
   * §2.2's `POST /api-token-auth/` → `Token <token>`. Bad credentials come back as DRF's 400 ("Unable to log in…") or 401.
   */
  private async login(ctx: ProviderContext, cfg: BioTimeConfig): Promise<Session> {
    const body = { username: cfg.username, password: cfg.password };
    const jwt = await this.http.request(ctx, { method: 'POST', url: joinUrl(cfg.baseUrl, '/jwt-api-token-auth/'), body, label: 'POST /jwt-api-token-auth/', passStatuses: [400, 404, 405] });
    let scheme: Session['scheme'] = 'JWT';
    let res: VendorHttpResponse = jwt;
    if (jwt.status === 404 || jwt.status === 405) {
      scheme = 'Token';
      res = await this.http.request(ctx, { method: 'POST', url: joinUrl(cfg.baseUrl, '/api-token-auth/'), body, label: 'POST /api-token-auth/', passStatuses: [400] });
    }
    if (res.status === 400) {
      ctx.logger.warn({ event: 'biotime_login_rejected', scheme, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'ZKBio Time rejected the login');
      throw new ProviderError('AUTH_FAILED', `${VENDOR} rejected the username or password`, { retryable: false, details: { request: scheme === 'JWT' ? 'POST /jwt-api-token-auth/' : 'POST /api-token-auth/', status: 400 } });
    }
    const parsed = tokenSchema.safeParse(res.json);
    if (!parsed.success) throw new ProviderError('VENDOR_ERROR', `${VENDOR} login answered without a token`, { retryable: true, details: { scheme } });
    const now = this.clock().getTime();
    const exp = scheme === 'JWT' ? jwtExpiry(parsed.data.token) : null;
    const expiresAt = Math.min(now + TOKEN_MAX_TTL_MS, (exp ?? now + TOKEN_DEFAULT_TTL_MS) - TOKEN_REFRESH_MARGIN_MS);
    ctx.logger.info({ event: 'biotime_login', scheme, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'Logged in to ZKBio Time');
    return { token: parsed.data.token, scheme, expiresAt };
  }

  /** One authenticated call. A 401/403 on a cached token (expired JWT, server restart) re-logs in once; on a fresh one it is final. */
  private async api(ctx: ProviderContext, cfg: BioTimeConfig, req: ApiRequest): Promise<VendorHttpResponse> {
    const url = new URL(joinUrl(cfg.baseUrl, req.path));
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    const label = `${req.method} ${new URL(joinUrl('http://x', req.path)).pathname.replace(/\/\d+\/$/, '/<id>/')}`;
    let { session, fresh } = await this.session(ctx, cfg);
    for (;;) {
      const res = await this.http.request(ctx, {
        method: req.method, url: url.toString(), label,
        headers: { authorization: `${session.scheme} ${session.token}` },
        ...(req.body !== undefined ? { body: req.body } : {}),
        passStatuses: [...(req.passStatuses ?? []), 401, 403],
      });
      if (res.status !== 401 && res.status !== 403) return res;
      if (!fresh) {
        ctx.logger.info({ event: 'biotime_relogin', request: label, status: res.status, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'ZKBio Time token refused; logging in again');
        ({ session, fresh } = await this.session(ctx, cfg, true));
        continue;
      }
      this.sessions.delete(this.sessionKey(ctx, cfg));
      ctx.logger.warn({ event: 'vendor_http_error', vendor: VENDOR, request: label, status: res.status, vendorError: res.text.slice(0, 200), deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'ZKBio Time refused a freshly issued token');
      throw new ProviderError('AUTH_FAILED', `${VENDOR} refused the API call (HTTP ${res.status}) — check that the user may use the API (BioTime 9.x also needs the API licence)`, { retryable: false, details: { request: label, status: res.status } });
    }
  }

  /** Reads a list envelope; `code` ≠ 0 is a vendor-level error, an unexpected shape is VENDOR_ERROR (never a cursor reset). */
  private listPage<T>(ctx: ProviderContext, res: VendorHttpResponse, label: string, schema: z.ZodType<T>, page: number, size: number): ListPage<T> {
    const env = envelopeSchema.safeParse(res.json);
    const data = env.success ? (env.data.data ?? env.data.results) : null;
    if (!env.success || !data) {
      ctx.logger.warn({ event: 'biotime_unexpected_response', request: label, status: res.status, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'ZKBio Time returned an unexpected response shape');
      throw new ProviderError('VENDOR_ERROR', `${VENDOR} returned an unexpected response to ${label}`, { retryable: true, details: { request: label } });
    }
    const code = env.data.code;
    if (code !== undefined && code !== null && String(code) !== '0') {
      ctx.logger.warn({ event: 'biotime_api_error', request: label, code: String(code).slice(0, 20), vendorError: (env.data.msg ?? '').slice(0, 200), deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'ZKBio Time answered with an API error code');
      throw new ProviderError('VENDOR_ERROR', `${VENDOR} reported an error for ${label}`, { retryable: true, details: { request: label, code: String(code).slice(0, 20) } });
    }
    const rows: T[] = [];
    let invalid = 0;
    for (const raw of data) { const p = schema.safeParse(raw); if (p.success) rows.push(p.data); else invalid += 1; }
    const count = env.data.count ?? null;
    // `next` is authoritative (it also covers a server that ignores our page size); without it, fall back on `count`.
    const next = (res.json as { next?: unknown }).next;
    const more = typeof next === 'string' ? next.length > 0 : next === null ? false : count !== null && count > (page - 1) * size + data.length;
    return { rows, invalid, count, more: more && data.length > 0 };
  }

  private async terminals(ctx: ProviderContext, cfg: BioTimeConfig): Promise<{ terminals: BioTimeTerminal[]; count: number | null; latencyMs: number }> {
    const size = 100;
    const label = 'GET /iclock/api/terminals/';
    const res = await this.api(ctx, cfg, { method: 'GET', path: '/iclock/api/terminals/', query: { sn: cfg.terminalSn, page: 1, limit: size, page_size: size } });
    const page = this.listPage(ctx, res, label, bioTimeTerminalSchema, 1, size);
    // `sn` may be a contains-filter on some builds: keep exact matches only.
    const terminals = cfg.terminalSn ? page.rows.filter((t) => t.sn === cfg.terminalSn) : page.rows;
    return { terminals, count: page.count, latencyMs: res.latencyMs };
  }

  /** REPORTED: terminal `state` 1 = online; a `last_activity` within 10 minutes also counts (the state column lags on some builds). */
  private terminalOnline(t: BioTimeTerminal, timezone: string): { online: boolean; lastSeenAt: string | null } {
    let lastSeenAt: string | null = null;
    if (t.last_activity) { try { lastSeenAt = toIsoUtc(parseDeviceTime(t.last_activity, timezone)); } catch { lastSeenAt = null; } }
    const fresh = lastSeenAt !== null && this.clock().getTime() - Date.parse(lastSeenAt) <= TERMINAL_ONLINE_MINUTES * 60_000;
    return { online: toNumber(t.state) === 1 || fresh, lastSeenAt };
  }

  private terminalInfo(t: BioTimeTerminal): DeviceInfo {
    const n = (v: number | null | undefined): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const info: DeviceInfo = { serialNumber: t.sn, model: 'ZKTeco terminal (via ZKBio Time)' };
    if (t.fw_ver) info.firmwareVersion = t.fw_ver.slice(0, 64);
    const users = n(t.user_count); if (users !== undefined) info.userCount = users;
    const fps = n(t.fp_count); if (fps !== undefined) info.fingerprintCount = fps;
    const faces = n(t.face_count); if (faces !== undefined) info.faceCount = faces;
    const txs = n(t.transaction_count); if (txs !== undefined) info.transactionCount = txs;
    const area = t.area && typeof t.area === 'object' ? { id: t.area.id ?? null, code: bounded(t.area.area_code), name: bounded(t.area.area_name) } : typeof t.area === 'number' ? { id: t.area } : null;
    info.extra = { alias: bounded(t.alias), ipAddress: bounded(t.ip_address), state: toNumber(t.state), lastActivity: bounded(t.last_activity), pushVersion: bounded(t.push_ver), terminalTz: toNumber(t.terminal_tz), area };
    return info;
  }

  private terminalNotFound(sn: string): ProviderError {
    return new ProviderError('NOT_FOUND', `${VENDOR}: terminal ${sn} is not registered on the server — check the terminal serial number`, { retryable: false, details: { field: 'terminalSn' } });
  }

  // ----- DeviceProvider -----------------------------------------------------------------------------------------------------

  /** ok:true only after a real authenticated call (the terminal list) succeeded. */
  async testConnection(ctx: ProviderContext): Promise<ConnectionResult> {
    const started = Date.now();
    const probe = await connectionProbe(started, async () => {
      const cfg = this.resolveConfig(ctx);
      const { terminals, count, latencyMs } = await this.terminals(ctx, cfg);
      if (cfg.terminalSn && terminals.length === 0) throw this.terminalNotFound(cfg.terminalSn);
      return { cfg, terminals, count, latencyMs };
    });
    if (!probe.ok) return probe;
    const { cfg, terminals, count, latencyMs } = probe.value;
    const scheme = this.sessions.get(this.sessionKey(ctx, cfg))?.scheme ?? null;
    const first = terminals[0];
    return {
      ok: true,
      message: cfg.terminalSn ? `Connected to ZKBio Time; terminal ${cfg.terminalSn} found` : `Connected to ZKBio Time (${count ?? terminals.length} terminal(s))`,
      latencyMs,
      ...(cfg.terminalSn && first ? { deviceInfo: this.terminalInfo(first) } : {}),
      details: { authScheme: scheme, terminalCount: count ?? terminals.length },
    };
  }

  async getDeviceInfo(ctx: ProviderContext): Promise<DeviceInfo> {
    const cfg = this.resolveConfig(ctx);
    const { terminals, count } = await this.terminals(ctx, cfg);
    if (cfg.terminalSn) {
      const t = terminals[0];
      if (!t) throw this.terminalNotFound(cfg.terminalSn);
      return this.terminalInfo(t);
    }
    return {
      model: 'ZKBio Time server',
      extra: { terminalCount: count ?? terminals.length, terminals: terminals.slice(0, 50).map((t) => ({ sn: t.sn, alias: bounded(t.alias), state: toNumber(t.state), lastActivity: bounded(t.last_activity) })) },
    };
  }

  async getCapabilities(_ctx: ProviderContext): Promise<DeviceCapabilities> {
    return { ...this.definition.capabilities };
  }

  /**
   * Server reachable + authenticated + terminal list read. With `terminalSn`, online follows that terminal (REPORTED state codes);
   * without it, the server itself is the device and the terminal summary goes into details. A failure to reach or authenticate
   * against the server throws (circuit breaker / vendor_degraded decide), it is never reported as a healthy device.
   */
  async getDeviceStatus(ctx: ProviderContext): Promise<DeviceStatus> {
    const cfg = this.resolveConfig(ctx);
    const { terminals, count, latencyMs } = await this.terminals(ctx, cfg);
    if (cfg.terminalSn) {
      const t = terminals[0];
      if (!t) throw this.terminalNotFound(cfg.terminalSn);
      const { online, lastSeenAt } = this.terminalOnline(t, ctx.timezone);
      return { online, ...(lastSeenAt ? { lastSeenAt } : {}), details: { serverReachable: true, latencyMs, terminalState: toNumber(t.state), lastActivity: bounded(t.last_activity) } };
    }
    const onlineTerminals = terminals.filter((t) => this.terminalOnline(t, ctx.timezone).online).length;
    return { online: true, lastSeenAt: this.clock().toISOString(), details: { serverReachable: true, latencyMs, terminalCount: count ?? terminals.length, onlineTerminals, sampled: terminals.length } };
  }

  /** One page of `GET /iclock/api/transactions/` inside the cursor's frozen punch-time window (see {@link BioTimeCursor}). */
  async pullAttendance(ctx: ProviderContext, cursor: SyncCursor | null, opts: { pageSize?: number; since?: string } = {}): Promise<AttendancePullResult> {
    const cfg = this.resolveConfig(ctx);
    assertTimezone(ctx.timezone);
    const stored = parseBioTimeCursor(cursor);
    const now = DateTime.fromJSDate(this.clock()).toUTC();
    let scan: BioTimeScan;
    if (stored?.scan) scan = stored.scan;
    else {
      let from: DateTime;
      if (stored) from = DateTime.fromISO(stored.next, { setZone: true }).toUTC();
      else if (opts.since !== undefined) {
        from = DateTime.fromISO(opts.since, { setZone: true }).toUTC();
        if (!from.isValid) throw new ProviderError('INVALID_CONFIG', 'Invalid `since` timestamp', { retryable: false, details: { since: boundedText(opts.since, 64) } });
      } else from = now.minus({ days: DEFAULT_HISTORY_DAYS });
      const to = from > now ? from : now;
      scan = { from: toIsoUtc(from), to: toIsoUtc(to), page: 1, size: clampInt(opts.pageSize, cfg.pageSize, 1, MAX_PAGE_SIZE), count: null, restarts: 0 };
    }
    const local = (iso: string): string => DateTime.fromISO(iso, { setZone: true }).setZone(ctx.timezone).toFormat(LOCAL_FORMAT);
    const label = 'GET /iclock/api/transactions/';
    const res = await this.api(ctx, cfg, {
      method: 'GET', path: '/iclock/api/transactions/',
      query: { start_time: local(scan.from), end_time: local(scan.to), terminal_sn: cfg.terminalSn, page: scan.page, limit: scan.size, page_size: scan.size },
      passStatuses: [404],
    });
    const window = { from: scan.from, to: scan.to, page: scan.page };
    const restart = (count: number | null, why: string): BioTimeScan | null => {
      if (scan.restarts >= BIOTIME_MAX_SCAN_RESTARTS) {
        ctx.logger.warn({ event: 'biotime_scan_unstable', why, ...window, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'ZKBio Time result set keeps changing during a scan; continuing without restart');
        return null;
      }
      ctx.logger.info({ event: 'biotime_scan_restarted', why, ...window, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'ZKBio Time result set changed during a scan; restarting it at page 1');
      return { ...scan, page: 1, count, restarts: scan.restarts + 1 };
    };
    const completed = (): SyncCursor => {
      const floor = DateTime.fromISO(scan.from, { setZone: true });
      const back = DateTime.fromISO(scan.to, { setZone: true }).minus({ milliseconds: cfg.lateArrivalMs });
      return { v: 1, next: toIsoUtc(back > floor ? back : floor) };
    };

    if (res.status === 404) {
      // DRF answers 404 "Invalid page." past the last page: on page > 1 the result set shrank under the scan.
      if (scan.page === 1) throw this.http.statusError(404, label);
      const again = restart(null, 'page_vanished');
      return again
        ? { transactions: [], nextCursor: { v: 1, scan: again }, hasMore: true, meta: { window, restarted: true } }
        : { transactions: [], nextCursor: completed(), hasMore: false, meta: { window, unstable: true } };
    }

    const page = this.listPage(ctx, res, label, bioTimeTransactionSchema, scan.page, scan.size);
    const transactions: RawTransaction[] = [];
    const skipped = { invalid: page.invalid, noIdentity: 0, badTime: 0, otherTerminal: 0 };
    let lateUploads = 0;
    let maxLagMs = 0;
    for (const row of page.rows) {
      // `terminal_sn` is a documented filter; the exact check also covers builds that treat it as "contains" or ignore it.
      if (cfg.terminalSn && (row.terminal_sn ?? '').trim() !== cfg.terminalSn) { skipped.otherTerminal += 1; continue; }
      const mapped = mapBioTimeTransaction(row, ctx.timezone);
      if (!mapped.transaction) { if (mapped.reason === 'no_identity') skipped.noIdentity += 1; else skipped.badTime += 1; continue; }
      if (typeof mapped.uploadLagMs === 'number' && mapped.uploadLagMs > cfg.lateArrivalMs / 2) { lateUploads += 1; maxLagMs = Math.max(maxLagMs, mapped.uploadLagMs); }
      transactions.push(mapped.transaction);
    }
    if (skipped.invalid + skipped.noIdentity + skipped.badTime > 0) ctx.logger.warn({ event: 'biotime_rows_skipped', ...skipped, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'ZKBio Time transaction rows skipped (unattributable or malformed)');
    if (lateUploads > 0) {
      ctx.logger.warn({ event: 'biotime_late_upload_detected', lateUploads, maxLagHours: Math.round(maxLagMs / 360_000) / 10, lateArrivalHours: cfg.lateArrivalMs / 3_600_000, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'ZKBio Time terminals upload punches late; rows older than the late-upload window can be missed — raise lateArrivalHours or run a full re-sync');
    }
    const meta = { window, count: page.count, received: page.rows.length, size: scan.size, latencyMs: res.latencyMs, lateUploads, ...(skipped.invalid + skipped.noIdentity + skipped.badTime + skipped.otherTerminal > 0 ? { skipped } : {}) };

    if (scan.page > 1 && scan.count !== null && page.count !== null && page.count !== scan.count) {
      const again = restart(page.count, 'count_changed');
      if (again) return { transactions, nextCursor: { v: 1, scan: again }, hasMore: true, meta: { ...meta, restarted: true } };
    }
    if (page.more) {
      return { transactions, nextCursor: { v: 1, scan: { ...scan, page: scan.page + 1, count: page.count ?? scan.count } }, hasMore: true, meta };
    }
    return { transactions, nextCursor: completed(), hasMore: false, meta };
  }

  async listEmployees(ctx: ProviderContext, page: PageCursor): Promise<DeviceEmployeePage> {
    const n = parseEmployeePage(page);
    const cfg = this.resolveConfig(ctx);
    const size = clampInt(ctx.config['pageSize'], DEFAULT_EMPLOYEE_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const label = 'GET /personnel/api/employees/';
    const res = await this.api(ctx, cfg, { method: 'GET', path: '/personnel/api/employees/', query: { page: n, limit: size, page_size: size }, passStatuses: [404] });
    if (res.status === 404) {
      if (n === 1) throw this.http.statusError(404, label);
      return { employees: [], nextCursor: null }; // past the last page (the roster shrank between pages)
    }
    const list = this.listPage(ctx, res, label, bioTimeEmployeeSchema, n, size);
    const employees = list.rows.map(mapBioTimeEmployee).filter((e): e is DeviceEmployee => e !== null);
    return { employees, nextCursor: list.more ? `page:${n + 1}` : null };
  }

  /** Exact emp_code lookup (the documented `emp_code` filter, re-checked exactly in case a build treats it as "contains"). */
  private async findEmployee(ctx: ProviderContext, cfg: BioTimeConfig, empCode: string): Promise<BioTimeEmployee | null> {
    const label = 'GET /personnel/api/employees/';
    const res = await this.api(ctx, cfg, { method: 'GET', path: '/personnel/api/employees/', query: { emp_code: empCode, page: 1, limit: 50, page_size: 50 } });
    const list = this.listPage(ctx, res, label, bioTimeEmployeeSchema, 1, 50);
    return list.rows.find((e) => e.emp_code === empCode) ?? null;
  }

  /**
   * Update (`PATCH /personnel/api/employees/<id>/`) when the emp_code exists, else create (`POST /personnel/api/employees/`, which
   * needs a department and an area — `departmentId`/`areaId` config). Updates never touch department/area (they may have been
   * assigned in BioTime). The full name goes into `first_name` (splitting names is lossy, notably for Arabic names).
   */
  async upsertEmployee(ctx: ProviderContext, employee: DeviceEmployee): Promise<DeviceOperationResult> {
    const code = typeof employee.deviceUserId === 'string' ? employee.deviceUserId.trim() : '';
    if (code.length === 0 || code.length > 64) throw new ProviderError('INVALID_CONFIG', 'deviceUserId is required (1–64 characters)', { retryable: false, details: { field: 'deviceUserId' } });
    if (employee.enabled === false) throw unsupported('upsertEmployee(enabled=false)', 'the BioTime 8.0 API documents no way to disable an employee; delete the employee instead');
    if (employee.privilege === 'admin') throw unsupported('upsertEmployee(privilege=admin)', 'device administrator rights are not granted through the BioTime API by FlowZa');
    const cfg = this.resolveConfig(ctx);
    const fields: Record<string, unknown> = { first_name: employee.name.slice(0, 64), last_name: '', card_no: employee.cardNumber ?? '' };
    if (employee.pin) fields['device_password'] = employee.pin;
    const existing = await this.findEmployee(ctx, cfg, code);
    if (existing) {
      await this.api(ctx, cfg, { method: 'PATCH', path: `/personnel/api/employees/${existing.id}/`, body: fields });
      return { ok: true, deviceUserId: code, message: 'Employee updated in ZKBio Time', details: { created: false, biotimeId: existing.id } };
    }
    if (cfg.departmentId === undefined || cfg.areaId === undefined) {
      throw new ProviderError('INVALID_CONFIG', `${VENDOR}: departmentId and areaId must be configured to create employees`, { retryable: false, details: { field: cfg.departmentId === undefined ? 'departmentId' : 'areaId' } });
    }
    const res = await this.api(ctx, cfg, { method: 'POST', path: '/personnel/api/employees/', body: { emp_code: code, ...fields, department: cfg.departmentId, area: [cfg.areaId] } });
    const created = z.object({ id: z.number().int() }).safeParse(res.json);
    return { ok: true, deviceUserId: code, message: 'Employee created in ZKBio Time', details: { created: true, biotimeId: created.success ? created.data.id : null } };
  }

  /** `DELETE /personnel/api/employees/<id>/` after an exact emp_code lookup; an unknown emp_code is NOT_FOUND. */
  async deleteEmployee(ctx: ProviderContext, deviceUserId: string): Promise<DeviceOperationResult> {
    const code = typeof deviceUserId === 'string' ? deviceUserId.trim() : '';
    if (code.length === 0) throw new ProviderError('INVALID_CONFIG', 'deviceUserId is required', { retryable: false, details: { field: 'deviceUserId' } });
    const cfg = this.resolveConfig(ctx);
    const existing = await this.findEmployee(ctx, cfg, code);
    if (!existing) throw new ProviderError('NOT_FOUND', `Employee ${code} does not exist in ZKBio Time`, { retryable: false, details: { deviceUserId: code } });
    await this.api(ctx, cfg, { method: 'DELETE', path: `/personnel/api/employees/${existing.id}/` });
    return { ok: true, deviceUserId: code, message: 'Employee deleted from ZKBio Time', details: { biotimeId: existing.id } };
  }

  async restart(_ctx: ProviderContext): Promise<DeviceOperationResult> {
    throw unsupported('restart', 'the BioTime 8.0 API documents no terminal restart command');
  }
}

function parseEmployeePage(page: PageCursor): number {
  if (page === null || page === undefined) return 1;
  const m = typeof page === 'string' ? /^page:(\d{1,7})$/.exec(page) : null;
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isInteger(n) || n < 1) throw new ProviderError('INVALID_CONFIG', 'Invalid employee page cursor', { retryable: false, details: { page: boundedText(String(page), 64) } });
  return n;
}
