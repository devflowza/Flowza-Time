import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { DeviceCapabilities, DeviceEmployee, RawTransaction } from '@flowza/contracts';
import { ProtocolError } from '../../errors.js';
import { assertTimezone, boundedText, parseDeviceTime, toIsoUtc } from '../../protocol-utils.js';
import { ProviderError, type AttendancePullResult, type ConnectionResult, type DeviceEmployeePage, type DeviceInfo, type DeviceOperationResult, type DeviceProvider, type DeviceStatus, type PageCursor, type ProviderContext, type ProviderDefinition, type SyncCursor } from '../../types.js';
import { connectionProbe, joinUrl, requiredString, VendorHttpClient, type VendorHttpMethod, type VendorHttpOptions, type VendorHttpResponse } from '../../vendor-http.js';
import { HIK_MAJOR_EVENT, mapEvent } from '../hikvision/push-protocol.js';
import { HIKVISION_ISAPI_DEFINITION, HIKVISION_ISAPI_KEY } from './definition.js';

/**
 * Hikvision ISAPI device API (docs/device-integrations.md §2.2, REPORTED_SECONDARY). Every exchange is HTTP Digest through the
 * shared `VendorHttpClient.digestRequest` (egress-guarded, throttled once per HTTP request, challenge answered ONCE: a rejected
 * password is never retried inside a call — terminals lock the account after ~5 failures).
 *
 * Event classification is shared with the push path (`hikvision_push`): an AcsEvent record is reshaped into the
 * `AccessControllerEvent` form and run through the same `mapEvent`, so both paths accept the same minor codes
 * (`HIK_PASS_EVENTS`), attendance statuses and employee-number rules, and produce the same `providerTransactionId` (`serialNo`).
 */

const VENDOR = 'Hikvision ISAPI';
/** Reported page cap of `AcsEvent` / `UserInfo/Search` on DS-K1T terminals; larger `maxResults` values are clamped by the device. */
export const HIK_ISAPI_MAX_RESULTS = 30;
/** Without a cursor and without `since`, the first pull starts this many days back (the terminal's buffer is finite anyway). */
export const HIK_ISAPI_DEFAULT_LOOKBACK_DAYS = 30;
/**
 * The search window ends slightly after "now": a terminal clock that runs a little fast still delivers its punches (ingest
 * quarantines excessive skew). The margin is small on purpose — the cursor never moves past the newest delivered event, so a
 * clock that was far ahead and then corrected could otherwise hide the corrected punches behind the cursor.
 */
export const HIK_ISAPI_FUTURE_MARGIN_MINUTES = 15;
/** `details.reason` of the one error that means "the stored cursor is unusable" (the worker rewinds on INVALID_CONFIG). */
export const HIK_ISAPI_INVALID_CURSOR_REASON = 'invalid_cursor';

const EMPLOYEE_NO = /^[A-Za-z0-9_-]{1,32}$/; // same rule as the push path (ISAPI employeeNo ≤ 32 chars)
const CARD_NO = /^[A-Za-z0-9]{1,32}$/;
const VENDOR_CODE = /^[A-Za-z0-9_]{1,64}$/;
/** Validity window written for enrolled users: "always valid" as the device UI does it (ISAPI requires both bounds). */
const VALID_BEGIN = '2000-01-01T00:00:00';
const VALID_END = '2037-12-31T23:59:59';
/** ISAPI answers functional errors with 400/403/404 + a ResponseStatus body; the body decides the ProviderError code. */
const ISAPI_ERROR_STATUSES = [400, 403, 404];
const UNEXPECTED = 'unexpected_response';
const JSON_HEADERS = { accept: 'application/json' };
const XML_HEADERS = { accept: 'application/xml, text/xml;q=0.9, */*;q=0.1' };

// ----- vendor shapes (REPORTED) ---------------------------------------------------------------------------------------------

/** Some firmware renders counters as strings. */
const intLike = z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,12}$/).transform(Number)]);

const acsEventInfoSchema = z.object({
  major: intLike.optional(),
  minor: intLike.optional(),
  time: z.string().max(64).optional(),
  employeeNoString: z.string().max(64).optional(),
  employeeNo: z.union([z.number().int().nonnegative(), z.string().max(64)]).optional(),
  serialNo: intLike.optional(),
  currentVerifyMode: z.string().max(200).optional(),
  attendanceStatus: z.string().max(200).optional(),
  userType: z.string().max(200).optional(),
  cardReaderNo: intLike.optional(),
  doorNo: intLike.optional(),
  mask: z.string().max(200).optional(),
});
type AcsEventInfo = z.infer<typeof acsEventInfoSchema>;

const acsEventResponseSchema = z.object({
  AcsEvent: z.object({
    searchID: z.string().optional(),
    responseStatusStrg: z.string(),
    numOfMatches: intLike,
    totalMatches: intLike.optional(),
    InfoList: z.array(z.unknown()).max(1000).optional(),
  }),
});

const userInfoSchema = z.object({
  employeeNo: z.union([z.string().min(1).max(64), z.number().int().nonnegative().transform(String)]),
  name: z.string().optional(),
  userType: z.string().max(32).optional(),
  localUIRight: z.boolean().optional(),
  Valid: z.object({ enable: z.boolean().optional(), beginTime: z.string().max(32).optional(), endTime: z.string().max(32).optional() }).optional(),
  numOfCard: intLike.optional(),
  numOfFace: intLike.optional(),
  numOfFP: intLike.optional(),
});

const userSearchResponseSchema = z.object({
  UserInfoSearch: z.object({
    searchID: z.string().optional(),
    responseStatusStrg: z.string(),
    numOfMatches: intLike,
    totalMatches: intLike.optional(),
    UserInfo: z.array(z.unknown()).max(1000).optional(),
  }),
});

const userCountSchema = z.object({ UserInfoCount: z.object({ userNumber: intLike }) });

/** ISAPI `ResponseStatus` (JSON or XML): `statusCode` 1 = OK; errors carry a stable `subStatusCode`. */
export interface IsapiStatus { statusCode: number | null; statusString: string | null; subStatusCode: string | null; errorMsg: string | null }

function xmlLeaf(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(xml);
  if (!m) return undefined;
  return (m[1] ?? '').trim().replace(/&(amp|lt|gt|quot|apos);/g, (_x, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e] ?? '');
}

/** Reads a ResponseStatus from a JSON or XML body; null when the body carries none (search results, deviceInfo…). */
export function readIsapiStatus(res: Pick<VendorHttpResponse, 'json' | 'text'>): IsapiStatus | null {
  const j = res.json;
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    const o = j as Record<string, unknown>;
    const inner = (o['ResponseStatus'] && typeof o['ResponseStatus'] === 'object' ? o['ResponseStatus'] : o) as Record<string, unknown>;
    if (!('statusCode' in inner) && !('subStatusCode' in inner)) return null;
    const code = Number(inner['statusCode']);
    const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    return { statusCode: Number.isFinite(code) ? code : null, statusString: s(inner['statusString']), subStatusCode: s(inner['subStatusCode']), errorMsg: s(inner['errorMsg']) };
  }
  if (/<ResponseStatus[\s>]/.test(res.text)) {
    const code = Number(xmlLeaf(res.text, 'statusCode'));
    return { statusCode: Number.isFinite(code) ? code : null, statusString: xmlLeaf(res.text, 'statusString') ?? null, subStatusCode: xmlLeaf(res.text, 'subStatusCode') ?? null, errorMsg: xmlLeaf(res.text, 'errorMsg') ?? null };
  }
  return null;
}

// ----- cursor ---------------------------------------------------------------------------------------------------------------

/**
 * Attendance cursor. `since` (UTC, whole seconds) is the time of the newest event delivered so far and the start of the next
 * AcsEvent search window; `position` is how many records of THAT window were already consumed (the device returns a window in
 * ascending time order, and every record before `position` is at or before `since`, so the count is exact); `lastSerialNo` is the
 * highest device `serialNo` delivered at exactly `since` — a belt-and-braces guard against replays should the firmware order
 * same-second records differently between searches (ingest dedupe absorbs the rest).
 * Rebasing `since` on every page keeps the window — and the device's search — short, instead of paging deeper forever.
 */
export interface HikIsapiCursor { since: string; position: number; lastSerialNo: number | null }

function invalidCursor(cursor: unknown): ProviderError {
  let shown: string;
  try { shown = JSON.stringify(cursor) ?? String(cursor); } catch { shown = '[unserialisable]'; }
  return new ProviderError('INVALID_CONFIG', 'Unparseable Hikvision ISAPI attendance cursor', { retryable: false, details: { reason: HIK_ISAPI_INVALID_CURSOR_REASON, cursor: boundedText(shown, 200) } });
}

/** `null` / `{}` → no cursor. Anything this provider did not issue → INVALID_CONFIG (`reason: invalid_cursor`) → worker rewinds. */
export function parseHikIsapiCursor(cursor: SyncCursor | null | undefined): HikIsapiCursor | null {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor !== 'object' || Array.isArray(cursor)) throw invalidCursor(cursor);
  const keys = Object.keys(cursor);
  if (keys.length === 0) return null;
  if (keys.some((k) => k !== 'since' && k !== 'position' && k !== 'lastSerialNo')) throw invalidCursor(cursor);
  const { since, position, lastSerialNo } = cursor as Record<string, unknown>;
  if (typeof since !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(since) || !DateTime.fromISO(since, { zone: 'utc' }).isValid) throw invalidCursor(cursor);
  if (typeof position !== 'number' || !Number.isInteger(position) || position < 0 || position > 10_000_000) throw invalidCursor(cursor);
  if (lastSerialNo !== undefined && lastSerialNo !== null && (typeof lastSerialNo !== 'number' || !Number.isInteger(lastSerialNo) || lastSerialNo < 0)) throw invalidCursor(cursor);
  return { since, position, lastSerialNo: typeof lastSerialNo === 'number' ? lastSerialNo : null };
}

const cursorOut = (c: HikIsapiCursor): SyncCursor => ({ since: c.since, position: c.position, lastSerialNo: c.lastSerialNo });
const utcSecond = (dt: DateTime): string => toIsoUtc(dt.toUTC().startOf('second'));

/** ISAPI search times carry the device's own offset (`2026-09-01T08:00:00+04:00`), formatted by Luxon in the device zone. */
export function hikIsapiSearchTime(isoUtc: string, timezone: string): string {
  return DateTime.fromISO(isoUtc, { zone: 'utc' }).setZone(timezone).toFormat("yyyy-MM-dd'T'HH:mm:ssZZ");
}

function normaliseSearchStatus(s: string): 'MORE' | 'OK' | 'NO MATCH' | 'UNKNOWN' {
  const v = s.trim().toUpperCase().replace(/_/g, ' ');
  if (v === 'MORE') return 'MORE';
  if (v === 'OK') return 'OK';
  if (v === 'NO MATCH' || v === 'NO MATCHES') return 'NO MATCH';
  return 'UNKNOWN';
}

// ----- provider -------------------------------------------------------------------------------------------------------------

interface IsapiConfig { baseUrl: string; username: string; password: string }
interface IsapiCall { method: VendorHttpMethod; path: string; body?: unknown; xml?: boolean }

export type HikvisionIsapiProviderOptions = VendorHttpOptions & { clock?: () => Date; definition?: ProviderDefinition };

export class HikvisionIsapiProvider implements DeviceProvider {
  readonly definition: ProviderDefinition;
  private readonly client: VendorHttpClient;
  private readonly clock: () => Date;

  constructor(options: HikvisionIsapiProviderOptions = {}) {
    const { clock, definition, ...http } = options;
    this.definition = definition ?? HIKVISION_ISAPI_DEFINITION;
    this.clock = clock ?? (() => new Date());
    this.client = new VendorHttpClient(VENDOR, http);
  }

  /** Validates config + credentials for one call (INVALID_CONFIG is terminal). The password is used verbatim (spaces are legal). */
  private resolve(ctx: ProviderContext): IsapiConfig {
    // an operator pasting `https://host/ISAPI` must not end up calling `/ISAPI/ISAPI/...`
    const baseUrl = this.client.baseUrl(ctx.config['baseUrl'] ?? ctx.endpointUrl ?? undefined).replace(/\/ISAPI$/i, '');
    const username = requiredString(ctx.config, 'username', VENDOR);
    const password = ctx.credentials['password'];
    if (typeof password !== 'string' || password.length === 0) throw new ProviderError('INVALID_CONFIG', `${VENDOR}: password is not configured`, { retryable: false, details: { field: 'password' } });
    return { baseUrl, username, password };
  }

  /**
   * One ISAPI exchange (Digest challenge + one answer). Functional errors (400/403/404 with a ResponseStatus, or a 2xx whose
   * statusCode is not 1) are mapped from the vendor's `subStatusCode`; transport and other HTTP statuses by the shared client.
   */
  private async isapi(ctx: ProviderContext, cfg: IsapiConfig, call: IsapiCall): Promise<VendorHttpResponse> {
    const label = `${call.method} ${call.path.split('?')[0]}`;
    let res: VendorHttpResponse;
    try {
      res = await this.client.digestRequest(ctx, {
        method: call.method, url: joinUrl(cfg.baseUrl, call.path), label, headers: call.xml ? XML_HEADERS : JSON_HEADERS,
        ...(call.body !== undefined ? { body: call.body } : {}), passStatuses: ISAPI_ERROR_STATUSES,
      }, { username: cfg.username, password: cfg.password });
    } catch (err) {
      if (ProviderError.is(err) && err.code === 'AUTH_FAILED') {
        ctx.logger.warn({ event: 'hik_isapi_auth_failed', request: label, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'Hikvision terminal rejected the credentials');
        throw new ProviderError('AUTH_FAILED', `${VENDOR}: the terminal rejected the username or password. Terminals lock the account after repeated failures (about 30 minutes) — correct the credentials before testing again`, { retryable: false, details: { ...(err.details ?? {}), request: label } });
      }
      throw err;
    }
    const status = readIsapiStatus(res);
    if (ISAPI_ERROR_STATUSES.includes(res.status) || (status !== null && status.statusCode !== null && status.statusCode !== 1)) throw this.isapiError(ctx, res.status, status, label);
    return res;
  }

  /** `subStatusCode` → ProviderError. The vendor code (a bounded identifier) is shown; free-text `errorMsg` is logged only. */
  private isapiError(ctx: ProviderContext, httpStatus: number, st: IsapiStatus | null, label: string): ProviderError {
    const sub = st?.subStatusCode && VENDOR_CODE.test(st.subStatusCode) ? st.subStatusCode : null;
    const details = { request: label, status: httpStatus, statusCode: st?.statusCode ?? null, subStatusCode: sub };
    ctx.logger.warn({ event: 'hik_isapi_error', ...details, vendorError: boundedText(st?.errorMsg ?? st?.statusString ?? undefined, 200), deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'Hikvision terminal answered with an ISAPI error');
    const tag = sub ? ` (${sub})` : '';
    if (sub && /authori[sz]|lock|passw/i.test(sub)) return new ProviderError('AUTH_FAILED', `${VENDOR}: the terminal refused the account${tag}; it may be locked after repeated failures`, { retryable: false, details });
    if (sub && /^notSupport/i.test(sub)) return new ProviderError('UNSUPPORTED', `${label} is not supported by this terminal's firmware${tag}`, { retryable: false, details: { ...details, operation: label } });
    if (sub && /alreadyExist/i.test(sub)) return new ProviderError('CONFLICT', `${VENDOR}: ${label} conflicts with an existing record${tag}`, { retryable: false, details });
    if (sub && /busy/i.test(sub)) return new ProviderError('VENDOR_ERROR', `${VENDOR}: the terminal is busy${tag}`, { retryable: true, details });
    if (httpStatus === 403) return new ProviderError('AUTH_FAILED', `${VENDOR}: the device user is not allowed to call ${label}${tag}`, { retryable: false, details });
    if (httpStatus === 404) return new ProviderError('NOT_FOUND', `${VENDOR}: ${label} was not found (HTTP 404) — the device is not an ISAPI access-control terminal or the URL is wrong`, { retryable: false, details });
    return new ProviderError('VENDOR_ERROR', `${VENDOR} rejected ${label}${tag}`, { retryable: httpStatus >= 500, details });
  }

  private parse<S extends z.ZodType>(ctx: ProviderContext, res: VendorHttpResponse, schema: S, label: string): z.infer<S> {
    const parsed = schema.safeParse(res.json);
    if (parsed.success) return parsed.data;
    ctx.logger.warn({ event: 'hik_isapi_unexpected_response', request: label, issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`), deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'Hikvision terminal returned an unexpected response shape');
    // VENDOR_ERROR, not PROTOCOL_ERROR: the worker rewinds a cursor on PROTOCOL_ERROR, and a glitchy answer must never move it
    throw new ProviderError('VENDOR_ERROR', `${VENDOR}: ${label} returned an unexpected response`, { retryable: true, details: { request: label, reason: UNEXPECTED } });
  }

  // ----- System ---------------------------------------------------------------------------------------------------------------

  private async fetchDeviceInfo(ctx: ProviderContext, cfg: IsapiConfig): Promise<{ info: Record<string, string>; latencyMs: number }> {
    const res = await this.isapi(ctx, cfg, { method: 'GET', path: '/ISAPI/System/deviceInfo', xml: true });
    if (!/<DeviceInfo[\s>]/.test(res.text)) throw new ProviderError('VENDOR_ERROR', `${VENDOR}: GET /ISAPI/System/deviceInfo did not return an ISAPI DeviceInfo document — check the device URL`, { retryable: false, details: { request: 'GET /ISAPI/System/deviceInfo', reason: UNEXPECTED } });
    const info: Record<string, string> = {};
    for (const tag of ['deviceName', 'deviceID', 'model', 'serialNumber', 'firmwareVersion', 'firmwareReleasedDate', 'deviceType']) {
      const v = xmlLeaf(res.text, tag);
      if (v) info[tag] = v.slice(0, 128);
    }
    return { info, latencyMs: res.latencyMs };
  }

  /** `GET /ISAPI/System/time` → device local time (with its offset) → skew against our clock and the configured zone. */
  private async fetchTime(ctx: ProviderContext, cfg: IsapiConfig): Promise<{ localTime: string; utc: DateTime; timeMode: string | null; offsetMismatch: boolean | null; latencyMs: number }> {
    const res = await this.isapi(ctx, cfg, { method: 'GET', path: '/ISAPI/System/time', xml: true });
    const localTime = xmlLeaf(res.text, 'localTime');
    if (!localTime) throw new ProviderError('VENDOR_ERROR', `${VENDOR}: GET /ISAPI/System/time carried no localTime`, { retryable: false, details: { request: 'GET /ISAPI/System/time', reason: UNEXPECTED } });
    let utc: DateTime;
    try { utc = parseDeviceTime(localTime, ctx.timezone); } catch (err) {
      if (err instanceof ProtocolError) throw new ProviderError('VENDOR_ERROR', `${VENDOR}: unreadable device time`, { retryable: false, details: { request: 'GET /ISAPI/System/time', reason: UNEXPECTED } });
      throw err;
    }
    // a device whose own offset differs from the configured zone stamps events in a different wall clock than we assume
    const withOffset = DateTime.fromISO(localTime.replace(' ', 'T'), { setZone: true });
    const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(localTime.trim());
    const offsetMismatch = hasOffset && withOffset.isValid ? withOffset.offset !== utc.setZone(ctx.timezone).offset : null;
    return { localTime: localTime.slice(0, 64), utc, timeMode: xmlLeaf(res.text, 'timeMode')?.slice(0, 32) ?? null, offsetMismatch, latencyMs: res.latencyMs };
  }

  async testConnection(ctx: ProviderContext): Promise<ConnectionResult> {
    const started = Date.now();
    const probe = await connectionProbe(started, async () => {
      const cfg = this.resolve(ctx);
      const { info } = await this.fetchDeviceInfo(ctx, cfg);
      // deviceInfo answers on cameras and NVRs too: a one-record event search proves this is an access-control terminal
      const now = DateTime.fromJSDate(this.clock());
      const search = await this.searchEvents(ctx, cfg, { since: utcSecond(now.minus({ days: 1 })), until: utcSecond(now.plus({ minutes: HIK_ISAPI_FUTURE_MARGIN_MINUTES })), position: 0, maxResults: 1 });
      return { info, search };
    });
    if (!probe.ok) return probe;
    const { info, search } = probe.value;
    // Hikvision's serialNumber is the long form (model + date + short serial): the short label serial must be contained in it.
    // Reported only — a mismatch means another terminal may answer at this URL, which the operator must look at.
    const expected = ctx.serialNumber?.trim().toLowerCase();
    const serialMatches = expected && info['serialNumber'] ? info['serialNumber'].toLowerCase().includes(expected) : null;
    return {
      ok: true,
      message: `Connected to Hikvision ${info['model'] ?? 'terminal'}${info['serialNumber'] ? ` (${info['serialNumber']})` : ''}`,
      latencyMs: Date.now() - started,
      deviceInfo: { ...(info['serialNumber'] ? { serialNumber: info['serialNumber'] } : {}), ...(info['model'] ? { model: info['model'] } : {}), ...(info['firmwareVersion'] ? { firmwareVersion: info['firmwareVersion'] } : {}) },
      details: { deviceName: info['deviceName'] ?? null, eventSearch: 'ok', eventsLast24h: search.totalMatches ?? search.numOfMatches, serialMatches },
    };
  }

  async getDeviceInfo(ctx: ProviderContext): Promise<DeviceInfo> {
    const cfg = this.resolve(ctx);
    const { info } = await this.fetchDeviceInfo(ctx, cfg);
    const time = await this.fetchTime(ctx, cfg);
    let userCount: number | undefined;
    try {
      const res = await this.isapi(ctx, cfg, { method: 'GET', path: '/ISAPI/AccessControl/UserInfo/Count?format=json' });
      userCount = this.parse(ctx, res, userCountSchema, 'GET /ISAPI/AccessControl/UserInfo/Count').UserInfoCount.userNumber;
    } catch (err) {
      // optional on some firmware: absent / unsupported counts are simply not reported; anything else is a real failure
      if (!(ProviderError.is(err) && (err.code === 'UNSUPPORTED' || err.code === 'NOT_FOUND' || err.details?.['reason'] === UNEXPECTED))) throw err;
    }
    return {
      ...(info['serialNumber'] ? { serialNumber: info['serialNumber'] } : {}),
      ...(info['model'] ? { model: info['model'] } : {}),
      ...(info['firmwareVersion'] ? { firmwareVersion: info['firmwareVersion'] } : {}),
      deviceTime: time.localTime,
      ...(userCount !== undefined ? { userCount } : {}),
      extra: { deviceName: info['deviceName'] ?? null, deviceType: info['deviceType'] ?? null, firmwareReleasedDate: info['firmwareReleasedDate'] ?? null, timeMode: time.timeMode, deviceTimeUtc: toIsoUtc(time.utc), timezoneMismatch: time.offsetMismatch },
    };
  }

  async getCapabilities(_ctx: ProviderContext): Promise<DeviceCapabilities> {
    return { ...this.definition.capabilities };
  }

  /** An authenticated clock read is the liveness probe; it also yields the clock skew the ingest quarantine rule needs. */
  async getDeviceStatus(ctx: ProviderContext): Promise<DeviceStatus> {
    const cfg = this.resolve(ctx);
    const time = await this.fetchTime(ctx, cfg);
    const now = this.clock();
    return {
      online: true,
      lastSeenAt: now.toISOString(),
      deviceTime: time.localTime,
      clockSkewSeconds: Math.round((time.utc.toMillis() - now.getTime()) / 1000),
      details: { latencyMs: time.latencyMs, timeMode: time.timeMode, timezoneMismatch: time.offsetMismatch },
    };
  }

  async restart(ctx: ProviderContext): Promise<DeviceOperationResult> {
    const cfg = this.resolve(ctx);
    await this.isapi(ctx, cfg, { method: 'PUT', path: '/ISAPI/System/reboot', xml: true });
    ctx.logger.info({ event: 'hik_isapi_reboot_requested', deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'Hikvision terminal reboot requested');
    return { ok: true, message: 'The terminal accepted the reboot request; it is unreachable for about a minute' };
  }

  // ----- attendance -----------------------------------------------------------------------------------------------------------

  private async searchEvents(ctx: ProviderContext, cfg: IsapiConfig, q: { since: string; until: string; position: number; maxResults: number }): Promise<{ status: ReturnType<typeof normaliseSearchStatus>; numOfMatches: number; totalMatches: number | undefined; records: unknown[]; latencyMs: number }> {
    const label = 'POST /ISAPI/AccessControl/AcsEvent';
    const res = await this.isapi(ctx, cfg, {
      method: 'POST', path: '/ISAPI/AccessControl/AcsEvent?format=json',
      body: {
        AcsEventCond: {
          // a fresh searchID per call: firmware caches results per searchID, and a cached empty answer must never hide new events
          searchID: randomUUID(), searchResultPosition: q.position, maxResults: q.maxResults, major: HIK_MAJOR_EVENT, minor: 0,
          startTime: hikIsapiSearchTime(q.since, ctx.timezone), endTime: hikIsapiSearchTime(q.until, ctx.timezone),
        },
      },
    });
    const data = this.parse(ctx, res, acsEventResponseSchema, label).AcsEvent;
    const status = normaliseSearchStatus(data.responseStatusStrg);
    if (status === 'UNKNOWN') ctx.logger.warn({ event: 'hik_isapi_unknown_search_status', responseStatus: boundedText(data.responseStatusStrg, 32), deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'Unknown AcsEvent responseStatusStrg');
    return { status, numOfMatches: data.numOfMatches, totalMatches: data.totalMatches, records: data.InfoList ?? [], latencyMs: res.latencyMs };
  }

  /**
   * One AcsEvent page (major 5 = access-control events, every minor). The window is `[cursor.since, now + margin]` read from
   * `cursor.position`; every returned record — punch or not — counts toward the position and the rebase, while only successful
   * authentications with an employee number become transactions (same rules as `hikvision_push`).
   */
  async pullAttendance(ctx: ProviderContext, cursor: SyncCursor | null, opts: { pageSize?: number; since?: string } = {}): Promise<AttendancePullResult> {
    const stored = parseHikIsapiCursor(cursor); // validate before touching the device
    const cfg = this.resolve(ctx);
    assertTimezone(ctx.timezone);
    const now = DateTime.fromJSDate(this.clock()).toUTC();
    const sinceOpt = opts.since !== undefined ? DateTime.fromISO(opts.since, { setZone: true }) : null;
    const start: HikIsapiCursor = stored ?? {
      since: utcSecond(sinceOpt?.isValid ? sinceOpt : now.minus({ days: HIK_ISAPI_DEFAULT_LOOKBACK_DAYS })),
      position: 0, lastSerialNo: null,
    };
    const sinceMs = DateTime.fromISO(start.since, { zone: 'utc' }).toMillis();
    const untilDt = now.plus({ minutes: HIK_ISAPI_FUTURE_MARGIN_MINUTES });
    const until = utcSecond(untilDt.toMillis() > sinceMs ? untilDt : DateTime.fromMillis(sinceMs, { zone: 'utc' }).plus({ seconds: 1 }));
    const maxResults = Math.min(HIK_ISAPI_MAX_RESULTS, Math.max(1, Math.floor(opts.pageSize ?? HIK_ISAPI_MAX_RESULTS)));
    const page = await this.searchEvents(ctx, cfg, { since: start.since, until, position: start.position, maxResults });

    const serial = ctx.serialNumber?.trim() || ctx.deviceCode;
    const transactions: RawTransaction[] = [];
    const skipped = { invalid: 0, badTime: 0, replayed: 0, notPass: 0, noEmployee: 0, badEmployee: 0 };
    const timed: Array<{ atMs: number; serialNo: number | undefined }> = [];
    for (const raw of page.records) {
      const parsed = acsEventInfoSchema.safeParse(raw);
      if (!parsed.success) { skipped.invalid += 1; continue; }
      const info: AcsEventInfo = parsed.data;
      if (!info.time) { skipped.badTime += 1; continue; }
      let atMs: number;
      try { atMs = parseDeviceTime(info.time, ctx.timezone).startOf('second').toMillis(); } catch (err) {
        if (err instanceof ProtocolError) { skipped.badTime += 1; continue; }
        throw err;
      }
      timed.push({ atMs, serialNo: info.serialNo });
      if (atMs === sinceMs && start.lastSerialNo !== null && info.serialNo !== undefined && info.serialNo <= start.lastSerialNo) { skipped.replayed += 1; continue; }
      const outcome = classify(info, ctx.timezone, serial);
      if (outcome === 'bad_employee') { skipped.badEmployee += 1; continue; }
      if (outcome === 'not_pass_event' || outcome === 'not_access_event') { skipped.notPass += 1; continue; }
      if (outcome === 'no_employee') { skipped.noEmployee += 1; continue; }
      transactions.push(outcome);
    }

    // Rebase: the next window starts at the newest event seen; `position` counts the records of that window already consumed.
    const n = page.records.length;
    let next: HikIsapiCursor = start;
    if (n > 0) {
      const maxAt = timed.reduce((m, t) => Math.max(m, t.atMs), sinceMs);
      const atMax = timed.filter((t) => t.atMs === maxAt);
      const serialsAtMax = atMax.map((t) => t.serialNo).filter((s): s is number => s !== undefined);
      if (maxAt === sinceMs) {
        const top = Math.max(start.lastSerialNo ?? -1, ...serialsAtMax);
        next = { since: start.since, position: start.position + n, lastSerialNo: top >= 0 ? top : null };
      } else {
        const top = Math.max(-1, ...serialsAtMax);
        next = { since: toIsoUtc(DateTime.fromMillis(maxAt, { zone: 'utc' })), position: atMax.length, lastSerialNo: top >= 0 ? top : null };
      }
    }
    const advanced = next.since !== start.since || next.position !== start.position;
    const more = page.status === 'MORE' || (page.totalMatches !== undefined && start.position + n < page.totalMatches);
    if (more && n > 0 && !advanced) ctx.logger.warn({ event: 'hik_isapi_cursor_stalled', deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'AcsEvent reported more records but the cursor did not advance');
    const dropped = skipped.invalid + skipped.badTime + skipped.badEmployee;
    if (dropped > 0) ctx.logger.warn({ event: 'hik_isapi_events_skipped', ...skipped, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'AcsEvent records skipped (malformed)');
    ctx.logger.debug({ event: 'hik_isapi_pull_page', received: n, delivered: transactions.length, status: page.status, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'AcsEvent page pulled');
    return {
      transactions,
      nextCursor: cursorOut(next),
      hasMore: more && n > 0 && advanced,
      meta: { received: n, numOfMatches: page.numOfMatches, totalMatches: page.totalMatches ?? null, responseStatus: page.status, maxResults, window: { since: start.since, until, position: start.position }, latencyMs: page.latencyMs, skipped },
    };
  }

  // ----- users ----------------------------------------------------------------------------------------------------------------

  async listEmployees(ctx: ProviderContext, page: PageCursor): Promise<DeviceEmployeePage> {
    const position = parseUserPage(page);
    const cfg = this.resolve(ctx);
    const label = 'POST /ISAPI/AccessControl/UserInfo/Search';
    const res = await this.isapi(ctx, cfg, { method: 'POST', path: '/ISAPI/AccessControl/UserInfo/Search?format=json', body: { UserInfoSearchCond: { searchID: randomUUID(), searchResultPosition: position, maxResults: HIK_ISAPI_MAX_RESULTS } } });
    const data = this.parse(ctx, res, userSearchResponseSchema, label).UserInfoSearch;
    const records = data.UserInfo ?? [];
    const employees: DeviceEmployee[] = [];
    let invalid = 0;
    for (const raw of records) {
      const u = userInfoSchema.safeParse(raw);
      if (!u.success) { invalid += 1; continue; }
      employees.push(toDeviceEmployee(u.data));
    }
    if (invalid > 0) ctx.logger.warn({ event: 'hik_isapi_users_skipped', invalid, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'UserInfo records skipped (malformed)');
    const more = normaliseSearchStatus(data.responseStatusStrg) === 'MORE' || (data.totalMatches !== undefined && position + records.length < data.totalMatches);
    return { employees, nextCursor: more && records.length > 0 ? `pos:${position + records.length}` : null };
  }

  /**
   * `UserInfo/Record`, falling back to `UserInfo/Modify` when the terminal says `employeeNoAlreadyExist`. A card number is then
   * enrolled best-effort through `CardInfo/Record` (the user record stands either way; the outcome is in `details.card`).
   * Face pictures, fingerprint templates and PINs are never sent.
   */
  async upsertEmployee(ctx: ProviderContext, employee: DeviceEmployee): Promise<DeviceOperationResult> {
    const employeeNo = checkEmployeeNo(employee.deviceUserId);
    const cfg = this.resolve(ctx);
    const name = employee.name.trim().slice(0, 64) || employeeNo;
    const userInfo = {
      employeeNo, name, userType: 'normal',
      Valid: { enable: employee.enabled !== false, beginTime: VALID_BEGIN, endTime: VALID_END },
      doorRight: '1', RightPlan: [{ doorNo: 1, planTemplateNo: '1' }],
      localUIRight: employee.privilege === 'admin',
    };
    let action: 'created' | 'updated' = 'created';
    try {
      await this.isapi(ctx, cfg, { method: 'POST', path: '/ISAPI/AccessControl/UserInfo/Record?format=json', body: { UserInfo: userInfo } });
    } catch (err) {
      if (!(ProviderError.is(err) && err.code === 'CONFLICT')) throw err;
      await this.isapi(ctx, cfg, { method: 'PUT', path: '/ISAPI/AccessControl/UserInfo/Modify?format=json', body: { UserInfo: userInfo } });
      action = 'updated';
    }
    const details: Record<string, unknown> = { action };
    if (employee.pin) details['pin'] = 'not_managed';
    const cardNo = employee.cardNumber?.trim();
    if (cardNo) details['card'] = await this.enrolCard(ctx, cfg, employeeNo, cardNo);
    const cardFailed = (details['card'] as { status?: string } | undefined)?.status === 'failed';
    return { ok: true, deviceUserId: employeeNo, message: `User ${action} on the terminal${cardFailed ? '; the card number could not be enrolled' : ''}`, details };
  }

  private async enrolCard(ctx: ProviderContext, cfg: IsapiConfig, employeeNo: string, cardNo: string): Promise<Record<string, unknown>> {
    if (!CARD_NO.test(cardNo)) return { status: 'failed', code: 'INVALID_CONFIG', reason: 'card number must be 1-32 letters or digits' };
    try {
      await this.isapi(ctx, cfg, { method: 'POST', path: '/ISAPI/AccessControl/CardInfo/Record?format=json', body: { CardInfo: { employeeNo, cardNo, cardType: 'normalCard' } } });
      return { status: 'created' };
    } catch (err) {
      if (!ProviderError.is(err)) throw err;
      // the card may already belong to this user (re-sync) — or to someone else: the device does not say which
      if (err.code === 'CONFLICT') return { status: 'already_exists', subStatusCode: err.details?.['subStatusCode'] ?? null };
      ctx.logger.warn({ event: 'hik_isapi_card_enrol_failed', code: err.code, deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'Card enrolment failed');
      return { status: 'failed', code: err.code, subStatusCode: err.details?.['subStatusCode'] ?? null };
    }
  }

  async deleteEmployee(ctx: ProviderContext, deviceUserId: string): Promise<DeviceOperationResult> {
    const employeeNo = checkEmployeeNo(deviceUserId);
    const cfg = this.resolve(ctx);
    await this.isapi(ctx, cfg, { method: 'PUT', path: '/ISAPI/AccessControl/UserInfo/Delete?format=json', body: { UserInfoDelCond: { EmployeeNoList: [{ employeeNo }] } } });
    return { ok: true, deviceUserId: employeeNo, message: 'User deleted from the terminal (with its cards, faces and fingerprints)' };
  }
}

// ----- helpers --------------------------------------------------------------------------------------------------------------

/** AcsEvent record → the push path's `AccessControllerEvent` document → the shared classifier. */
function classify(info: AcsEventInfo, timezone: string, serial: string): RawTransaction | 'not_access_event' | 'not_pass_event' | 'no_employee' | 'bad_employee' {
  const doc = {
    eventType: 'AccessControllerEvent', dateTime: info.time,
    AccessControllerEvent: {
      majorEventType: info.major, subEventType: info.minor, employeeNoString: info.employeeNoString, employeeNo: info.employeeNo, serialNo: info.serialNo,
      attendanceStatus: info.attendanceStatus, currentVerifyMode: info.currentVerifyMode, userType: info.userType, cardReaderNo: info.cardReaderNo, doorNo: info.doorNo, mask: info.mask,
    },
  };
  let outcome: ReturnType<typeof mapEvent>;
  try { outcome = mapEvent(doc, timezone, serial); } catch (err) {
    if (err instanceof ProtocolError) return 'bad_employee';
    throw err;
  }
  if (outcome.kind === 'ignored') return outcome.reason;
  if (outcome.kind !== 'punch') return 'not_access_event';
  const t = outcome.transaction;
  // same allowlist as the push path, re-labelled with where it came from
  return { ...t, rawPayload: { ...t.rawPayload, protocol: HIKVISION_ISAPI_KEY, eventType: 'AcsEvent' } };
}

function checkEmployeeNo(value: string): string {
  const v = value.trim();
  if (!EMPLOYEE_NO.test(v)) throw new ProviderError('INVALID_CONFIG', `${VENDOR}: the device user id must be 1-32 letters, digits, "-" or "_"`, { retryable: false, details: { field: 'deviceUserId' } });
  return v;
}

function parseUserPage(page: PageCursor): number {
  if (page === null) return 0;
  const m = /^pos:(\d{1,9})$/.exec(page);
  if (!m) throw new ProviderError('INVALID_CONFIG', 'Invalid Hikvision ISAPI user page cursor', { retryable: false, details: { page: boundedText(page, 64) } });
  return Number(m[1]);
}

function toDeviceEmployee(u: z.infer<typeof userInfoSchema>): DeviceEmployee {
  const deviceUserId = u.employeeNo.trim().slice(0, 64);
  const name = (u.name ?? '').trim().slice(0, 64) || deviceUserId;
  return {
    deviceUserId, name, cardNumber: null, pin: null,
    // localUIRight = may open the terminal's local menu, the closest ISAPI notion of a device administrator
    privilege: u.localUIRight === true ? 'admin' : 'user',
    enabled: u.Valid?.enable !== false,
    photoUrl: null,
    extra: {
      userType: u.userType ?? null, validFrom: u.Valid?.beginTime ?? null, validTo: u.Valid?.endTime ?? null,
      numOfCard: u.numOfCard ?? null, numOfFace: u.numOfFace ?? null, numOfFP: u.numOfFP ?? null,
    },
  };
}
