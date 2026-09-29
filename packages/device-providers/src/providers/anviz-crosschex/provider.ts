import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { DeviceCapabilities, DeviceEmployee, PunchDirection, RawTransaction } from '@flowza/contracts';
import { sha256Hex } from '@flowza/shared';
import { unsupported } from '../../errors.js';
import { assertTimezone, boundedText, parseDeviceTime, toIsoUtc } from '../../protocol-utils.js';
import { ProviderError, type AttendancePullResult, type ConnectionResult, type DeviceEmployeePage, type DeviceInfo, type DeviceOperationResult, type DeviceProvider, type DeviceStatus, type PageCursor, type ProviderContext, type ProviderDefinition, type SyncCursor } from '../../types.js';
import { connectionProbe, optionalString, requiredString, VendorHttpClient, type VendorHttpOptions } from '../../vendor-http.js';
import { ANVIZ_CROSSCHEX_CLOUD_DEFINITION, ANVIZ_CROSSCHEX_REGIONS, type AnvizCrossChexRegion } from './definition.js';

/*
 * Wire contract (docs/device-integrations.md §2.4, REPORTED_SECONDARY; field names cross-checked against the open-source clients
 * ApicalNomad/CrosschexAPI and YourFellow1/crossChexCloudApp):
 *  - every call is `POST /` on `https://api.{us|eu|ap}.crosschexcloud.com` with the envelope
 *    `{ header: { nameSpace, nameAction, version: '1.0', requestId, timestamp }, authorize?: { type: 'token', token }, payload }`;
 *  - `authorize.token/token` with `{ api_key, api_secret }` → `payload.token` (+ `payload.expires`, ISO with offset);
 *  - `attendance.record/getrecord` with `{ begin_time, end_time, order, page, per_page ≤ 100 }` →
 *    `payload { count, page, pageCount, list: [{ uuid, checktime, checktype, device { serial_number, name }, employee { workno, … } }] }`;
 *  - vendor errors come back as `header { nameSpace: 'System', nameAction: 'Exception' }` + `payload { type, message }`.
 * The open-source clients post the same fields form-encoded (`header[nameSpace]=…`); this adapter sends the JSON envelope the
 * research describes — to be confirmed on a live account (§2.4 "needs verification").
 */

export const ANVIZ_VENDOR_NAME = 'Anviz CrossChex Cloud';
const MODEL = 'CrossChex Cloud';
const API_VERSION = '1.0';
/** getrecord caps a page at 100 records (observed; §2.4). */
export const CROSSCHEX_MAX_PER_PAGE = 100;
/** Without a cursor or `since`, the first sweep starts 30 days back. */
export const CROSSCHEX_DEFAULT_LOOKBACK_MS = 30 * 24 * 3600_000;
/** One sweep covers at most 7 days of `checktime` (the community clients query ≤ 2-week windows; unknown server-side cap). */
export const CROSSCHEX_MAX_WINDOW_MS = 7 * 24 * 3600_000;
/**
 * Each new sweep re-reads the last 2 hours of the previous one. Terminals upload to the cloud with a delay and getrecord filters on
 * the PUNCH time, so a punch uploaded late lands "behind" a cursor that already moved on; the overlap absorbs ordinary upload lag
 * (duplicates are removed downstream by uuid / dedupe hash). Longer outages need an operator rewind / reconciliation pull (`since`).
 */
export const CROSSCHEX_OVERLAP_MS = 2 * 3600_000;
/** Safety net against a server that keeps reporting more pages than it serves. */
const MAX_PAGE = 10_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
/** Lifetime assumed when the token answer carries no readable `expires` (the observed tokens live a few hours). */
const TOKEN_DEFAULT_TTL_MS = 10 * 60_000;
const TOKEN_MAX_TTL_MS = 24 * 3600_000;
const TOKEN_CACHE_MAX = 1000;
const RAW_FIELD_MAX = 64;

const NS_TOKEN = { nameSpace: 'authorize.token', nameAction: 'token' } as const;
const NS_RECORDS = { nameSpace: 'attendance.record', nameAction: 'getrecord' } as const;
const label = (ns: { nameSpace: string; nameAction: string }): string => `${ns.nameSpace}/${ns.nameAction}`;

export interface AnvizCrossChexProviderOptions extends VendorHttpOptions {
  clock?: () => Date;
  definition?: ProviderDefinition;
  /**
   * Tests / local tooling only: replaces `https://api.{region}.crosschexcloud.com`. Production has no way to point the adapter at an
   * arbitrary host (the config only offers a region), and the override still goes through the egress guard.
   */
  baseUrlOverride?: string;
}

/** Resolved per call from the device row + decrypted credentials (never logged). */
export interface CrossChexConfig { baseUrl: string; region: AnvizCrossChexRegion; apiKey: string; apiSecret: string; deviceSerial: string | undefined }

export const crossChexRegionUrl = (region: AnvizCrossChexRegion): string => `https://api.${region}.crosschexcloud.com/`;

// ----- vendor JSON (validated leniently: unknown keys stripped, one bad record never fails a page) ----------------------------

const scalarText = z.union([z.string().max(400), z.number()]).transform((v) => String(v).trim());
const envelopeSchema = z.object({
  header: z.object({ nameSpace: z.string().max(100), nameAction: z.string().max(100) }),
  payload: z.unknown().optional(),
});
const errorPayloadSchema = z.object({ type: scalarText.nullish(), message: scalarText.nullish() });
const tokenPayloadSchema = z.object({ token: z.string().min(1).max(8192), expires: z.string().max(64).nullish() });
const intLike = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().min(0));
const recordPageSchema = z.object({
  count: intLike.nullish(),
  page: intLike.nullish(),
  pageCount: intLike.nullish(),
  list: z.array(z.unknown()).max(1000).nullish(),
});
export const crossChexRecordSchema = z.object({
  uuid: scalarText.nullish(),
  checktime: z.string().min(1).max(64),
  checktype: scalarText.nullish(),
  device: z.object({ serial_number: scalarText.nullish(), name: scalarText.nullish() }).nullish(),
  employee: z.object({ workno: scalarText.nullish() }).nullish(),
});
export type CrossChexRecord = z.infer<typeof crossChexRecordSchema>;

// ----- errors --------------------------------------------------------------------------------------------------------------

export type CrossChexErrorClass = { kind: 'token' } | { kind: 'error'; error: ProviderError };

/**
 * `System/Exception` payload → our vocabulary. The exact `type` strings are UNKNOWN (§2.4), so classification is by keyword:
 * anything about the token means "log in again" (the caller retries once), credential/permission words are AUTH_FAILED, frequency
 * words RATE_LIMITED, parameter words a non-retryable VENDOR_ERROR, and the rest a retryable VENDOR_ERROR. The vendor's free text
 * never reaches the caller-visible message — only a sanitised `type`.
 */
export function classifyCrossChexError(type: string | null | undefined, message: string | null | undefined, request: string): CrossChexErrorClass {
  const safeType = (type ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'UNKNOWN';
  const text = `${type ?? ''} ${message ?? ''}`.toUpperCase();
  const details = { request, vendorErrorType: safeType };
  if (/TOKEN/.test(text)) return { kind: 'token' };
  if (/API[_ ]?KEY|SECRET|AUTH|UNAUTHORI[SZ]|PERMISSION|FORBIDDEN|DENIED|SIGNATURE|DEVELOPER|CREDENTIAL/.test(text)) {
    return { kind: 'error', error: new ProviderError('AUTH_FAILED', `${ANVIZ_VENDOR_NAME} rejected the API key / secret (${safeType})`, { retryable: false, details }) };
  }
  if (/TOO[_ ]MANY|FREQUEN|RATE|THROTTL|QUOTA|LIMIT/.test(text)) {
    return { kind: 'error', error: new ProviderError('RATE_LIMITED', `${ANVIZ_VENDOR_NAME} is rate limiting requests (${safeType})`, { retryable: true, retryAfterMs: 60_000, details }) };
  }
  if (/PARAM|FORMAT|ARGUMENT|REQUIRED|MISSING/.test(text)) {
    return { kind: 'error', error: new ProviderError('VENDOR_ERROR', `${ANVIZ_VENDOR_NAME} rejected ${request} (${safeType})`, { retryable: false, details }) };
  }
  return { kind: 'error', error: new ProviderError('VENDOR_ERROR', `${ANVIZ_VENDOR_NAME} failed on ${request} (${safeType})`, { retryable: true, details }) };
}

// ----- cursor --------------------------------------------------------------------------------------------------------------

export const CROSSCHEX_INVALID_CURSOR_REASON = 'invalid_cursor';

/**
 * Stored cursor `{ v: 1, begin, end?, page, perPage? }`. getrecord has no record-level cursor and no documented stable order, so a
 * sync is a series of SWEEPS over a `checktime` window: `end` absent = the next pull opens a new sweep `[begin, min(now, begin+7d)]`
 * and pins `end`; `end` present = page `page` of that pinned window (with the `perPage` it was opened with, so offsets stay put).
 * Anything else was not issued by this provider → INVALID_CONFIG with `details.reason = 'invalid_cursor'` (the engine rewinds to a
 * time-based cursor, as for Flowza Finance). `null` / `{}` = start from `since` or 30 days back.
 */
const isoInstant = z.string().max(40).refine((s) => DateTime.fromISO(s, { setZone: true }).isValid);
const cursorSchema = z.strictObject({
  v: z.literal(1),
  begin: isoInstant,
  end: isoInstant.optional(),
  page: z.number().int().min(1).max(MAX_PAGE),
  perPage: z.number().int().min(1).max(CROSSCHEX_MAX_PER_PAGE).optional(),
});
export interface CrossChexCursor { begin: number; end?: number; page: number; perPage?: number }

export function parseCrossChexCursor(cursor: SyncCursor | null): CrossChexCursor | null {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor !== 'object' || Array.isArray(cursor)) throw invalidCursor(cursor);
  if (Object.keys(cursor).length === 0) return null;
  const parsed = cursorSchema.safeParse(cursor);
  if (!parsed.success) throw invalidCursor(cursor);
  const begin = Date.parse(parsed.data.begin);
  const end = parsed.data.end !== undefined ? Date.parse(parsed.data.end) : undefined;
  if (end === undefined ? parsed.data.page !== 1 : end < begin || end - begin > CROSSCHEX_MAX_WINDOW_MS) throw invalidCursor(cursor);
  return { begin, ...(end !== undefined ? { end } : {}), page: parsed.data.page, ...(parsed.data.perPage !== undefined ? { perPage: parsed.data.perPage } : {}) };
}
function invalidCursor(cursor: unknown): ProviderError {
  return new ProviderError('INVALID_CONFIG', `Unparseable ${ANVIZ_VENDOR_NAME} cursor`, { retryable: false, details: { reason: CROSSCHEX_INVALID_CURSOR_REASON, cursor: boundedText(JSON.stringify(cursor) ?? String(cursor), 200) } });
}
const iso = (ms: number): string => new Date(ms).toISOString();
function serialiseCursor(c: CrossChexCursor): SyncCursor {
  return { v: 1, begin: iso(c.begin), ...(c.end !== undefined ? { end: iso(c.end) } : {}), page: c.page, ...(c.perPage !== undefined ? { perPage: c.perPage } : {}) };
}
/** Window bounds as the vendor renders instants (`2024-02-19T20:37:16+00:00`, cf. `payload.expires`): explicit UTC offset. */
const vendorTime = (ms: number): string => DateTime.fromMillis(ms, { zone: 'utc' }).toFormat("yyyy-MM-dd'T'HH:mm:ssZZ");

// ----- records -------------------------------------------------------------------------------------------------------------

/**
 * `checktype` semantics are UNKNOWN (§2.4: "whether records include … verify mode, direction"). Only unambiguous words are mapped;
 * numeric codes stay `unknown` (kept verbatim in the raw payload) until a live account shows what they mean.
 */
export function mapCrossChexCheckType(value: string | null | undefined): PunchDirection {
  const v = (value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  switch (v) {
    case 'in': case 'checkin': case 'clockin': return 'in';
    case 'out': case 'checkout': case 'clockout': return 'out';
    case 'breakout': case 'breakstart': return 'break_out';
    case 'breakin': case 'breakend': return 'break_in';
    case 'overtimein': case 'otin': return 'overtime_in';
    case 'overtimeout': case 'otout': return 'overtime_out';
    default: return 'unknown';
  }
}

export interface MappedCrossChexRecord { transaction: RawTransaction | null; reason?: 'no_identity' | 'bad_time' }

/**
 * getrecord item → RawTransaction. Identity = `employee.workno` (the CrossChex employee number the terminals are enrolled with);
 * `punchedAt` = `checktime` taken as-is when it carries an offset, otherwise read as wall-clock time in the device zone; the verbatim
 * string is kept as `deviceLocalTime`. `uuid` (when present) is the provider transaction id; without it the downstream dedupe hash
 * applies. The raw payload is an allowlist of short fields — no names, nothing biometric.
 */
export function mapCrossChexRecord(rec: CrossChexRecord, timezone: string): MappedCrossChexRecord {
  const workno = String(rec.employee?.workno ?? '').trim();
  if (workno.length === 0 || workno.length > 64) return { transaction: null, reason: 'no_identity' };
  let punchedAt: string;
  try { punchedAt = toIsoUtc(parseDeviceTime(rec.checktime, timezone)); } catch (err) {
    if (ProviderError.is(err) && err.code === 'PROTOCOL_ERROR') return { transaction: null, reason: 'bad_time' };
    throw err;
  }
  const uuid = rec.uuid && rec.uuid.length <= 200 ? rec.uuid : null;
  return {
    transaction: {
      providerTransactionId: uuid,
      deviceEmployeeId: workno,
      punchedAt,
      deviceLocalTime: rec.checktime.trim().slice(0, 64),
      verificationMethod: 'unknown',
      direction: mapCrossChexCheckType(rec.checktype),
      rawPayload: {
        uuid,
        checktime: boundedText(rec.checktime, RAW_FIELD_MAX),
        checktype: boundedText(rec.checktype ?? undefined, RAW_FIELD_MAX),
        workno,
        deviceSerial: boundedText(rec.device?.serial_number ?? undefined, RAW_FIELD_MAX),
        deviceName: boundedText(rec.device?.name ?? undefined, RAW_FIELD_MAX),
      },
    },
  };
}

// ----- provider ------------------------------------------------------------------------------------------------------------

interface CachedToken { token: string; expiresAt: number }
type Exchange = { ok: true; payload: unknown; latencyMs: number } | { ok: false; tokenRejected: true };

/**
 * Anviz CrossChex Cloud Open API adapter (VENDOR_CLOUD_PULL). Pull-only: token login + `getrecord` sweeps over time windows.
 * Every HTTP exchange goes through `VendorHttpClient` (egress guard, `ctx.acquire` per request, status → ProviderError). Tokens are
 * cached in memory only, per (org, device, base URL, api key, sha256(api secret)), until shortly before `payload.expires`; a token
 * rejection (vendor `System/Exception` about the token, or HTTP 401) drops the cached token and logs in again ONCE per call.
 */
export class AnvizCrossChexCloudProvider implements DeviceProvider {
  readonly definition: ProviderDefinition;
  private readonly http: VendorHttpClient;
  private readonly clock: () => Date;
  private readonly baseUrlOverride: string | undefined;
  private readonly tokens = new Map<string, CachedToken>();
  private readonly logins = new Map<string, Promise<CachedToken>>();

  constructor(options: AnvizCrossChexProviderOptions = {}) {
    const { clock, definition, baseUrlOverride, ...http } = options;
    this.definition = definition ?? ANVIZ_CROSSCHEX_CLOUD_DEFINITION;
    this.http = new VendorHttpClient(ANVIZ_VENDOR_NAME, http);
    this.clock = clock ?? (() => new Date());
    this.baseUrlOverride = baseUrlOverride;
  }

  /** INVALID_CONFIG is terminal: the sync engine flags the device instead of retrying. */
  resolveConfig(ctx: ProviderContext, opts: { credentials?: boolean } = {}): CrossChexConfig {
    const regionRaw = (optionalString(ctx.config, 'region') ?? 'us').toLowerCase();
    if (!(ANVIZ_CROSSCHEX_REGIONS as readonly string[]).includes(regionRaw)) {
      throw new ProviderError('INVALID_CONFIG', `${ANVIZ_VENDOR_NAME}: region must be one of ${ANVIZ_CROSSCHEX_REGIONS.join(', ')}`, { retryable: false, details: { field: 'region' } });
    }
    const region = regionRaw as AnvizCrossChexRegion;
    const baseUrl = this.http.baseUrl(this.baseUrlOverride ?? crossChexRegionUrl(region), this.baseUrlOverride ? 'baseUrlOverride' : 'region');
    const deviceSerial = optionalString(ctx.config, 'deviceSerial');
    if (opts.credentials === false) return { baseUrl, region, apiKey: '', apiSecret: '', deviceSerial };
    const apiKey = optionalString(ctx.config, 'apiKey') ?? requiredString(ctx.credentials, 'apiKey', ANVIZ_VENDOR_NAME);
    const apiSecret = requiredString(ctx.credentials, 'apiSecret', ANVIZ_VENDOR_NAME);
    return { baseUrl, region, apiKey, apiSecret, deviceSerial };
  }

  // ----- transport ----------------------------------------------------------------------------------------------------------

  /** One envelope exchange. Returns `tokenRejected` (authed calls only) so the caller can log in again; everything else throws. */
  private async exchange(ctx: ProviderContext, cfg: CrossChexConfig, ns: { nameSpace: string; nameAction: string }, payload: Record<string, unknown>, token: string | null): Promise<Exchange> {
    const request = label(ns);
    const body = {
      header: { ...ns, version: API_VERSION, requestId: randomUUID(), timestamp: this.clock().toISOString() },
      ...(token !== null ? { authorize: { type: 'token', token } } : {}),
      payload,
    };
    const res = await this.http.request(ctx, { method: 'POST', url: `${cfg.baseUrl}/`, body, label: request, ...(token !== null ? { passStatuses: [401] } : {}) });
    if (res.status === 401) return { ok: false, tokenRejected: true };
    const env = envelopeSchema.safeParse(res.json);
    if (!env.success) {
      ctx.logger.warn({ event: 'crosschex_unexpected_response', request, status: res.status, organizationId: ctx.organizationId, deviceId: ctx.deviceId }, 'CrossChex Cloud returned an unexpected response shape');
      throw new ProviderError('VENDOR_ERROR', `${ANVIZ_VENDOR_NAME} returned an unexpected response to ${request}`, { retryable: true, details: { request, status: res.status } });
    }
    const { header } = env.data;
    if (header.nameSpace.toLowerCase() === 'system' && header.nameAction.toLowerCase() === 'exception') {
      const e = errorPayloadSchema.safeParse(env.data.payload ?? {});
      const type = e.success ? e.data.type : null;
      const message = e.success ? e.data.message : null;
      ctx.logger.warn({ event: 'crosschex_vendor_exception', request, vendorErrorType: boundedText(type ?? undefined, 64), vendorError: boundedText(message ?? undefined, 200), organizationId: ctx.organizationId, deviceId: ctx.deviceId }, 'CrossChex Cloud answered with an exception');
      const cls = classifyCrossChexError(type, message, request);
      if (cls.kind === 'token') {
        if (token !== null) return { ok: false, tokenRejected: true };
        // The login itself failing "about a token" is still a credential verdict.
        throw new ProviderError('AUTH_FAILED', `${ANVIZ_VENDOR_NAME} refused to issue a token for the API key / secret`, { retryable: false, details: { request } });
      }
      throw cls.error;
    }
    return { ok: true, payload: env.data.payload, latencyMs: res.latencyMs };
  }

  private tokenKey(ctx: ProviderContext, cfg: CrossChexConfig): string {
    return sha256Hex(`${ctx.organizationId}|${ctx.deviceId}|${cfg.baseUrl}|${cfg.apiKey}|${sha256Hex(cfg.apiSecret)}`);
  }

  private async login(ctx: ProviderContext, cfg: CrossChexConfig): Promise<CachedToken> {
    const res = await this.exchange(ctx, cfg, NS_TOKEN, { api_key: cfg.apiKey, api_secret: cfg.apiSecret }, null);
    if (!res.ok) throw new ProviderError('AUTH_FAILED', `${ANVIZ_VENDOR_NAME} rejected the API key / secret`, { retryable: false, details: { request: label(NS_TOKEN) } });
    const parsed = tokenPayloadSchema.safeParse(res.payload);
    if (!parsed.success) throw new ProviderError('VENDOR_ERROR', `${ANVIZ_VENDOR_NAME} returned no token`, { retryable: true, details: { request: label(NS_TOKEN) } });
    const now = this.clock().getTime();
    const expires = parsed.data.expires ? DateTime.fromISO(parsed.data.expires, { setZone: true }) : null;
    const expiresAt = Math.min(now + TOKEN_MAX_TTL_MS, expires?.isValid ? expires.toMillis() : now + TOKEN_DEFAULT_TTL_MS);
    ctx.logger.info({ event: 'crosschex_token_issued', organizationId: ctx.organizationId, deviceId: ctx.deviceId, expiresAt: iso(expiresAt), expiresReported: expires?.isValid === true }, 'CrossChex Cloud token issued');
    return { token: parsed.data.token, expiresAt };
  }

  /** Cached token, or a fresh login (concurrent callers for the same key share one login). `force` bypasses the cache. */
  private async token(ctx: ProviderContext, cfg: CrossChexConfig, force = false): Promise<CachedToken> {
    const key = this.tokenKey(ctx, cfg);
    const cached = this.tokens.get(key);
    if (!force && cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.clock().getTime()) return cached;
    const pending = force ? undefined : this.logins.get(key);
    if (pending) return pending;
    const p = this.login(ctx, cfg).then((t) => {
      if (this.tokens.size >= TOKEN_CACHE_MAX && !this.tokens.has(key)) { const oldest = this.tokens.keys().next(); if (!oldest.done) this.tokens.delete(oldest.value); }
      this.tokens.set(key, t);
      return t;
    }).finally(() => { if (this.logins.get(key) === p) this.logins.delete(key); });
    this.logins.set(key, p);
    return p;
  }

  /** Authenticated call: cached token; on a token rejection drop it, log in again once, retry once; a second rejection is AUTH_FAILED. */
  private async call(ctx: ProviderContext, cfg: CrossChexConfig, ns: { nameSpace: string; nameAction: string }, payload: Record<string, unknown>): Promise<{ payload: unknown; latencyMs: number }> {
    const key = this.tokenKey(ctx, cfg);
    const first = await this.token(ctx, cfg);
    const res = await this.exchange(ctx, cfg, ns, payload, first.token);
    if (res.ok) return res;
    if (this.tokens.get(key)?.token === first.token) this.tokens.delete(key);
    ctx.logger.info({ event: 'crosschex_token_rejected', request: label(ns), organizationId: ctx.organizationId, deviceId: ctx.deviceId }, 'CrossChex Cloud rejected the cached token; logging in again');
    const fresh = await this.token(ctx, cfg, true);
    const retry = await this.exchange(ctx, cfg, ns, payload, fresh.token);
    if (retry.ok) return retry;
    this.tokens.delete(key);
    throw new ProviderError('AUTH_FAILED', `${ANVIZ_VENDOR_NAME} rejected a freshly issued token`, { retryable: false, details: { request: label(ns) } });
  }

  private async getRecords(ctx: ProviderContext, cfg: CrossChexConfig, q: { begin: number; end: number; page: number; perPage: number }): Promise<{ page: z.infer<typeof recordPageSchema>; latencyMs: number }> {
    const { payload, latencyMs } = await this.call(ctx, cfg, NS_RECORDS, { begin_time: vendorTime(q.begin), end_time: vendorTime(q.end), order: 'asc', page: q.page, per_page: q.perPage });
    const parsed = recordPageSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      ctx.logger.warn({ event: 'crosschex_unexpected_response', request: label(NS_RECORDS), issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`), organizationId: ctx.organizationId, deviceId: ctx.deviceId }, 'CrossChex Cloud returned an unexpected record page');
      throw new ProviderError('VENDOR_ERROR', `${ANVIZ_VENDOR_NAME} returned an unexpected record page`, { retryable: true, details: { request: label(NS_RECORDS) } });
    }
    return { page: parsed.data, latencyMs };
  }

  // ----- DeviceProvider -----------------------------------------------------------------------------------------------------

  /** ok:true only after a FRESH login and an authenticated getrecord call (last 24 h, one record) both succeeded. */
  async testConnection(ctx: ProviderContext): Promise<ConnectionResult> {
    const started = Date.now();
    const probe = await connectionProbe(started, async () => {
      const cfg = this.resolveConfig(ctx);
      const token = await this.token(ctx, cfg, true);
      const now = this.clock().getTime();
      const { page } = await this.getRecords(ctx, cfg, { begin: now - 24 * 3600_000, end: now, page: 1, perPage: 1 });
      return { cfg, token, page };
    });
    if (!probe.ok) return probe;
    const { cfg, token, page } = probe.value;
    return {
      ok: true,
      message: `Connected to CrossChex Cloud (${cfg.region})`,
      latencyMs: Date.now() - started,
      deviceInfo: { model: MODEL, ...(cfg.deviceSerial ? { serialNumber: cfg.deviceSerial } : {}) },
      details: { region: cfg.region, tokenExpiresAt: iso(token.expiresAt), recordsLast24h: page.count ?? null, deviceSerialFilter: cfg.deviceSerial ?? null },
    };
  }

  /** No documented device endpoint: reports what the configuration says, without calling the vendor. */
  async getDeviceInfo(ctx: ProviderContext): Promise<DeviceInfo> {
    const cfg = this.resolveConfig(ctx, { credentials: false });
    return { model: MODEL, ...(cfg.deviceSerial ? { serialNumber: cfg.deviceSerial } : {}), extra: { region: cfg.region } };
  }

  async getCapabilities(_ctx: ProviderContext): Promise<DeviceCapabilities> {
    return { ...this.definition.capabilities };
  }

  async getDeviceStatus(_ctx: ProviderContext): Promise<DeviceStatus> {
    throw unsupported('getDeviceStatus', 'the CrossChex Cloud Open API documents no device endpoint, so terminal liveness cannot be observed (a working token says nothing about the terminals)');
  }

  /**
   * One getrecord page of the current sweep (see {@link parseCrossChexCursor}). Mid-sweep → next page, `hasMore` true. Last page →
   * the next sweep starts `CROSSCHEX_OVERLAP_MS` before this one's end; `hasMore` stays true only while catching up on history
   * (the window was capped below "now"), so the engine keeps paging through a backlog and stops at the present.
   */
  async pullAttendance(ctx: ProviderContext, cursor: SyncCursor | null, opts: { pageSize?: number; since?: string } = {}): Promise<AttendancePullResult> {
    const cfg = this.resolveConfig(ctx);
    const pos = parseCrossChexCursor(cursor);
    assertTimezone(ctx.timezone);
    const now = Math.floor(this.clock().getTime() / 1000) * 1000;
    const requested = Math.min(CROSSCHEX_MAX_PER_PAGE, Math.max(1, Math.floor(opts.pageSize ?? CROSSCHEX_MAX_PER_PAGE)));
    let begin: number; let end: number; let page: number; let perPage: number;
    if (pos && pos.end !== undefined) {
      begin = pos.begin; end = pos.end; page = pos.page;
      perPage = pos.perPage ?? requested;
    } else {
      const sinceMs = opts.since !== undefined ? Date.parse(opts.since) : NaN;
      if (opts.since !== undefined && !Number.isFinite(sinceMs)) ctx.logger.warn({ event: 'crosschex_since_ignored', organizationId: ctx.organizationId, deviceId: ctx.deviceId }, 'Unreadable `since` ignored');
      begin = pos?.begin ?? (Number.isFinite(sinceMs) ? sinceMs : now - CROSSCHEX_DEFAULT_LOOKBACK_MS);
      end = Math.max(begin, Math.min(now, begin + CROSSCHEX_MAX_WINDOW_MS));
      page = 1;
      perPage = requested;
    }

    const { page: data, latencyMs } = await this.getRecords(ctx, cfg, { begin, end, page, perPage });
    const list = data.list ?? [];
    const serialFilter = cfg.deviceSerial?.toLowerCase();
    const transactions: RawTransaction[] = [];
    const skipped = { invalid: 0, noIdentity: 0, badTime: 0, otherDevice: 0 };
    for (const raw of list) {
      const rec = crossChexRecordSchema.safeParse(raw);
      if (!rec.success) { skipped.invalid += 1; continue; }
      if (serialFilter !== undefined && (rec.data.device?.serial_number ?? '').toLowerCase() !== serialFilter) { skipped.otherDevice += 1; continue; }
      const mapped = mapCrossChexRecord(rec.data, ctx.timezone);
      if (!mapped.transaction) { if (mapped.reason === 'no_identity') skipped.noIdentity += 1; else skipped.badTime += 1; continue; }
      transactions.push(mapped.transaction);
    }
    if (skipped.invalid + skipped.noIdentity + skipped.badTime > 0) ctx.logger.warn({ event: 'crosschex_records_skipped', ...skipped, organizationId: ctx.organizationId, deviceId: ctx.deviceId }, 'CrossChex Cloud records skipped (unattributable or malformed)');

    // pageCount missing → derive it from count; both missing → a short page is the last one.
    const pageCount = data.pageCount ?? (data.count !== null && data.count !== undefined ? Math.ceil(data.count / perPage) : list.length < perPage ? page : page + 1);
    const morePages = page < pageCount && list.length > 0 && page < MAX_PAGE;
    if (page < pageCount && !morePages) ctx.logger.warn({ event: 'crosschex_sweep_stalled', page, pageCount, received: list.length, organizationId: ctx.organizationId, deviceId: ctx.deviceId }, 'CrossChex Cloud reported more pages but the sweep cannot advance; closing it');
    let next: CrossChexCursor;
    let hasMore: boolean;
    if (morePages) {
      next = { begin, end, page: page + 1, perPage };
      hasMore = true;
    } else {
      const nextBegin = Math.max(begin, end - CROSSCHEX_OVERLAP_MS);
      next = { begin: nextBegin, page: 1 };
      hasMore = end < now && nextBegin > begin;
    }
    ctx.logger.debug({ event: 'crosschex_pull_page', organizationId: ctx.organizationId, deviceId: ctx.deviceId, page, pageCount, received: list.length, mapped: transactions.length, hasMore }, 'CrossChex Cloud records page');
    return {
      transactions,
      nextCursor: serialiseCursor(next),
      hasMore,
      meta: { window: { begin: iso(begin), end: iso(end) }, page, pageCount, perPage, count: data.count ?? null, received: list.length, latencyMs, region: cfg.region, ...(skipped.invalid + skipped.noIdentity + skipped.badTime + skipped.otherDevice > 0 ? { skipped } : {}) },
    };
  }

  async listEmployees(_ctx: ProviderContext, _page: PageCursor): Promise<DeviceEmployeePage> {
    throw unsupported('listEmployees', 'CrossChex Cloud employee endpoints are not documented (research: UNKNOWN)');
  }
  async upsertEmployee(_ctx: ProviderContext, _employee: DeviceEmployee): Promise<DeviceOperationResult> {
    throw unsupported('upsertEmployee', 'CrossChex Cloud employee endpoints are not documented (research: UNKNOWN); enrol employees in CrossChex Cloud');
  }
  async deleteEmployee(_ctx: ProviderContext, _deviceUserId: string): Promise<DeviceOperationResult> {
    throw unsupported('deleteEmployee', 'CrossChex Cloud employee endpoints are not documented (research: UNKNOWN); remove employees in CrossChex Cloud');
  }
}
