import { DateTime } from 'luxon';
import { z } from 'zod';
import type { AttendanceEventType, PunchDirection, RawTransaction, VerificationMethod } from '@flowza/contracts';
import { FINANCE_DEFAULT_BASE_URL, FLOWZA_FINANCE_PROVIDER_KEY } from '@flowza/contracts';
import { sha256Hex } from '@flowza/shared';
import { assertEgressUrl, EgressError } from '../../egress.js';
import { boundedText, isValidTimezone } from '../../protocol-utils.js';
import { ProviderError, type SyncCursor } from '../../types.js';

/** Paths under the Finance functions base URL. */
export const FINANCE_EXPORT_PATH = 'attendance-export';
export const FINANCE_INGEST_PATH = 'attendance-ingest';
/** Finance caps an export page at 1000 rows and an ingest batch at 500 punches. */
export const FINANCE_EXPORT_MAX_LIMIT = 1000;
export const FINANCE_EXPORT_DEFAULT_LIMIT = 500;
export const FINANCE_INGEST_MAX_BATCH = 500;
/** Largest response body the connector reads (an export page of 1000 rows is ~1 MB); larger bodies abort the request. */
export const FINANCE_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const RAW_FIELD_MAX = 64;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// ----- HTTP contract (validated leniently: unknown keys ignored, one bad punch never fails a page) ---------------------------

const nullishText = z.string().max(400).nullish();
const nullishNumber = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/).transform(Number)]).nullish();
export const financeExportPunchSchema = z.object({
  id: z.string().min(1).max(200),
  employee_id: nullishText,
  employee_number: nullishText,
  pin: nullishText,
  device_serial: nullishText,
  time_utc: z.string().min(1).max(64),
  device_timezone: nullishText,
  verify: nullishText,
  state: nullishText,
  workcode: nullishText,
  source: nullishText,
  lat: nullishNumber,
  lng: nullishNumber,
  accuracy: nullishNumber,
  geofence_verdict: nullishText,
  geo_flagged: z.boolean().nullish(),
  created_at: nullishText,
});
export type FinanceExportPunch = z.infer<typeof financeExportPunchSchema>;

export const financeExportPageSchema = z.object({
  organization_id: nullishText,
  device_id: nullishText,
  punches: z.array(z.unknown()).max(FINANCE_EXPORT_MAX_LIMIT + 1),
  has_more: z.boolean().default(false),
  next_cursor: z.string().max(256).nullable().default(null),
  server_time: nullishText,
});
export type FinanceExportPage = z.infer<typeof financeExportPageSchema>;

export const financeIngestResultSchema = z.object({
  ok: z.boolean().default(true),
  serial: nullishText,
  source: nullishText,
  received: z.number().int().default(0),
  ingested: z.number().int().default(0),
  duplicates: z.number().int().default(0),
  unmapped: z.number().int().default(0),
  errors: z.number().int().default(0),
  skipped: z.number().int().default(0),
  auto_mapped: z.number().int().nullish(),
});
export type FinancePushResult = z.infer<typeof financeIngestResultSchema>;

/** One punch as `attendance-ingest` expects it (`pin` = the employee field chosen by `pinKey`; `time` = ISO-8601 UTC with `Z`). */
export interface FinancePunchInput {
  pin: string;
  time: string;
  verify: string | null;
  state: string | null;
  workcode: string | null;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
}

// ----- vocabularies ---------------------------------------------------------------------------------------------------------

/** Finance `verify_mode` (free text as the channel recorded it, incl. ADMS codes) → our verification method. */
export function mapFinanceVerify(value: string | null | undefined): VerificationMethod {
  const v = (value ?? '').trim().toLowerCase();
  switch (v) {
    case 'fingerprint': case 'finger': case 'fp': case '1': return 'fingerprint';
    case 'face': case 'face_recognition': case '15': return 'face';
    case 'card': case 'rfid': case '2': return 'card';
    case 'pin': return 'pin';
    case 'password': case 'pwd': case '0': return 'password';
    case 'palm': return 'palm';
    case 'iris': return 'iris';
    case 'mobile': case 'gps': case 'selfie': case 'app': case 'portal': case 'web': return 'mobile';
    case 'manual': return 'manual';
    default: return 'unknown';
  }
}

/** Finance `punch_state` (`check_in`/`check_out` from agents, `in`/`out` from the portal, numeric ADMS status codes) → direction. */
export function mapFinanceState(value: string | null | undefined): PunchDirection {
  const v = (value ?? '').trim().toLowerCase();
  switch (v) {
    case 'check_in': case 'checkin': case 'in': case 'i': case '0': return 'in';
    case 'check_out': case 'checkout': case 'out': case 'o': case '1': return 'out';
    case 'break_out': case 'break_start': case '2': return 'break_out';
    case 'break_in': case 'break_end': case '3': return 'break_in';
    case 'overtime_in': case '4': return 'overtime_in';
    case 'overtime_out': case '5': return 'overtime_out';
    default: return 'unknown';
  }
}

/** Our event type → the `state` Finance stores (a plain PUNCH has no direction; Finance accepts a null state). */
export const FINANCE_STATE_BY_EVENT_TYPE: Readonly<Record<AttendanceEventType, string | null>> = {
  PUNCH_IN: 'check_in', PUNCH_OUT: 'check_out', BREAK_START: 'break_out', BREAK_END: 'break_in', PUNCH: null,
};

/** Our verification method → Finance `verify` (Finance keeps free text; `unknown` becomes null rather than a made-up method). */
export function toFinanceVerify(method: VerificationMethod | string | null | undefined): string | null {
  if (!method || method === 'unknown') return null;
  return method;
}

// ----- cursor -------------------------------------------------------------------------------------------------------------

const CURSOR_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

/** `details.reason` of the ONE error that means "the stored cursor is unusable" — the only failure after which the engine rewinds. */
export const FINANCE_INVALID_CURSOR_REASON = 'invalid_cursor';

/**
 * Our stored cursor is `{ since: <next_cursor> }` — Finance's token stored verbatim (it is opaque: base64url("<created_at>|<id>")
 * of the last exported row). `null` / `{}` = start from the beginning (bounded by the connector's start date). Anything else was
 * not issued by this provider → INVALID_CONFIG with `details.reason = 'invalid_cursor'`, which the sync engine answers with a
 * time-based rewind (AGENTS.md cursor rule). HTTP-level failures never carry that reason, so they never move the cursor.
 */
export function parseFinanceCursor(cursor: SyncCursor | null): string | undefined {
  if (cursor === null || cursor === undefined) return undefined;
  if (typeof cursor !== 'object' || Array.isArray(cursor)) throw invalidCursor(cursor);
  const keys = Object.keys(cursor);
  if (keys.length === 0) return undefined;
  const since = cursor['since'];
  if (keys.some((k) => k !== 'since') || typeof since !== 'string' || !CURSOR_TOKEN.test(since)) throw invalidCursor(cursor);
  return since;
}
function invalidCursor(cursor: unknown): ProviderError {
  return new ProviderError('INVALID_CONFIG', 'Unparseable Flowza Finance cursor', { retryable: false, details: { reason: FINANCE_INVALID_CURSOR_REASON, cursor: boundedText(JSON.stringify(cursor), 200) } });
}
/** True only for the error {@link parseFinanceCursor} raises: a transport or HTTP failure must never reset the cursor. */
export function isFinanceCursorError(err: unknown): boolean {
  return ProviderError.is(err) && err.details?.['reason'] === FINANCE_INVALID_CURSOR_REASON;
}

/**
 * A cursor positioned just before `isoTime` (used for full re-syncs / rewinds): Finance's documented cursor format with the nil
 * uuid, so the keyset `created_at > t OR (created_at = t AND id > nil)` starts at that instant. Finance treats anything it cannot
 * read as "start from the beginning", which is the safe fallback if the format ever changes.
 */
export function financeCursorFromTime(isoTime: string): string {
  const dt = DateTime.fromISO(isoTime, { zone: 'utc', setZone: true });
  if (!dt.isValid) throw new ProviderError('INVALID_CONFIG', `Invalid rewind time "${isoTime}"`, { retryable: false });
  const stamp = dt.toUTC().toISO({ suppressMilliseconds: false }) ?? dt.toUTC().toISO()!;
  return Buffer.from(`${stamp}|${NIL_UUID}`, 'utf8').toString('base64url');
}

// ----- punches --------------------------------------------------------------------------------------------------------------

/**
 * Finance's `time_utc` is PostgREST's rendering of a timestamptz — ISO-8601 with `+00:00` and 0–6 fractional digits
 * (`2026-09-27T06:02:49.9175+00:00`). Postgres' own text form (`2026-09-27 06:02:49+00`) is accepted too, and a value without
 * an offset is read as UTC (the field is UTC by contract — never the process's local zone). Sub-millisecond digits are
 * truncated deterministically, so a re-pulled row always maps to the same instant (idempotent dedupe).
 */
export function parseFinanceTime(value: string): DateTime | null {
  const text = value.trim();
  let at = DateTime.fromISO(text, { zone: 'utc', setZone: true });
  if (!at.isValid) at = DateTime.fromSQL(text, { zone: 'utc', setZone: true });
  return at.isValid ? at : null;
}

export interface MappedFinancePunch { transaction: RawTransaction | null; reason?: 'no_identity' | 'bad_time' }

/**
 * Raw rows whose Finance punch carries no `employee_number` are stored under a namespaced identity `pin:<finance device serial>:<pin>`.
 * The PIN of a Finance terminal is NOT one of our identities (it may coincide with a local device user id or card number of somebody
 * else), so it is kept visible and unmatched for reconciliation — never compared with our employees. Employee numbers cannot contain
 * ':' (codeSchema), so the prefix cannot collide with one.
 */
export const FINANCE_PIN_IDENTITY_PREFIX = 'pin:';
export function financePinIdentity(deviceSerial: string | null | undefined, pin: string): string {
  const id = `${FINANCE_PIN_IDENTITY_PREFIX}${(deviceSerial ?? '').trim() || '?'}:${pin}`;
  return id.length <= 64 ? id : `${FINANCE_PIN_IDENTITY_PREFIX}#${sha256Hex(`${deviceSerial ?? ''}|${pin}`).slice(0, 58)}`;
}
export const isFinancePinIdentity = (deviceEmployeeId: string): boolean => deviceEmployeeId.startsWith(FINANCE_PIN_IDENTITY_PREFIX);

/**
 * Finance export row → RawTransaction. Identity = Finance's `employee_number` (trimmed) — the ONLY value the normaliser matches,
 * against our `employees.employee_number`. A row Finance has not attributed (no employee number) keeps the producing device's PIN
 * under the namespaced identity of {@link financePinIdentity} and stays unmatched; rows with neither are skipped (counted, never
 * invented). `punchedAt` is Finance's `time_utc`; `deviceLocalTime` is that instant in the producing device's zone. The raw payload
 * keeps an allowlist of Finance fields — bounded strings, never anything biometric.
 */
export function mapFinancePunch(punch: FinanceExportPunch, connectorSerial: string): MappedFinancePunch {
  const employeeNumber = (punch.employee_number ?? '').trim();
  const pin = (punch.pin ?? '').trim();
  const identity = employeeNumber.length > 0 ? employeeNumber : pin.length > 0 ? financePinIdentity(punch.device_serial, pin) : '';
  if (identity.length === 0 || identity.length > 64) return { transaction: null, reason: 'no_identity' };
  const at = parseFinanceTime(punch.time_utc);
  if (!at) return { transaction: null, reason: 'bad_time' };
  const punchedAt = at.toUTC().toISO({ suppressMilliseconds: at.millisecond === 0 })!;
  const zone = punch.device_timezone && isValidTimezone(punch.device_timezone) ? punch.device_timezone : null;
  const deviceLocalTime = zone ? at.setZone(zone).toFormat('yyyy-MM-dd HH:mm:ss') : null;
  const num = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    transaction: {
      providerTransactionId: punch.id,
      deviceEmployeeId: identity,
      punchedAt,
      deviceLocalTime,
      verificationMethod: mapFinanceVerify(punch.verify),
      direction: mapFinanceState(punch.state),
      rawPayload: {
        financeId: punch.id,
        employeeNumber: boundedText(punch.employee_number ?? undefined, RAW_FIELD_MAX),
        pin: boundedText(punch.pin ?? undefined, RAW_FIELD_MAX),
        source: boundedText(punch.source ?? undefined, RAW_FIELD_MAX),
        deviceSerial: boundedText(punch.device_serial ?? undefined, RAW_FIELD_MAX),
        deviceTimezone: zone,
        state: boundedText(punch.state ?? undefined, RAW_FIELD_MAX),
        verify: boundedText(punch.verify ?? undefined, RAW_FIELD_MAX),
        workcode: boundedText(punch.workcode ?? undefined, RAW_FIELD_MAX),
        lat: num(punch.lat), lng: num(punch.lng), accuracy: num(punch.accuracy),
        geofenceVerdict: boundedText(punch.geofence_verdict ?? undefined, RAW_FIELD_MAX),
        geoFlagged: typeof punch.geo_flagged === 'boolean' ? punch.geo_flagged : null,
        createdAt: boundedText(punch.created_at ?? undefined, RAW_FIELD_MAX),
        connectorSerial,
      },
    },
  };
}

// ----- base URL (syntax half of the connector's egress rule; the provider adds the DNS check and the pinned connection) -------

export interface FinanceBaseUrlOptions {
  /** Local development / tests only: accept `http://` and private or loopback hosts. Production keeps https + public hosts. */
  allowPrivateHosts?: boolean;
}

/**
 * Validates and normalises the Finance functions base URL with the shared egress guard (`assertEgressUrl`: https only, no
 * credentials, trailing dot stripped, IP literals in any spelling and private names refused) plus the connector's own shape rules
 * (no query string or fragment, no trailing slash). Syntax only: `FlowzaFinanceProvider.vetBaseUrl` also resolves the host and
 * refuses non-public addresses, and every call connects to the address it checked.
 * Throws ProviderError('INVALID_CONFIG'); the API translates that into a 400 with the same message.
 */
export function resolveFinanceBaseUrl(raw: unknown, opts: FinanceBaseUrlOptions = {}): string {
  const text = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : FINANCE_DEFAULT_BASE_URL;
  let url: URL;
  try { url = new URL(text); } catch { throw invalidBaseUrl('Finance base URL is not a valid URL'); }
  if (url.username || url.password) throw invalidBaseUrl('Finance base URL must not carry credentials');
  if (url.search || url.hash) throw invalidBaseUrl('Finance base URL must not carry a query string or fragment');
  if (url.protocol !== 'https:' && !(opts.allowPrivateHosts && url.protocol === 'http:')) throw invalidBaseUrl('Finance base URL must use https');
  try { url = assertEgressUrl(url, { allowPrivate: opts.allowPrivateHosts === true }); } catch (err) {
    if (EgressError.is(err)) throw invalidBaseUrl('Finance base URL must point at a public host');
    throw err;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
export function invalidBaseUrl(message: string): ProviderError {
  return new ProviderError('INVALID_CONFIG', message, { retryable: false, details: { field: 'baseUrl', reason: 'refused_by_policy' } });
}

// ----- connector identity helpers (shared by the worker and the API) ----------------------------------------------------------

/**
 * Throttle / circuit-breaker account of one connector: the organisation AND the connector device. Every tenant talks to the same
 * default Finance base URL, so a key derived from the URL would put all of them in one throttle queue and one circuit (one tenant's
 * failures opening another tenant's circuit). Hashed so it can be logged and stored.
 */
export function financeAccountKey(organizationId: string, deviceId: string): string {
  return sha256Hex(`${FLOWZA_FINANCE_PROVIDER_KEY}|${organizationId}|${deviceId}`).slice(0, 16);
}

/**
 * The connector's start date (`devices.config.syncFrom`, `YYYY-MM-DD`, a calendar day in the connector's timezone) as the UTC
 * instant of that day's midnight; null when absent or unreadable (no lower bound). Punches before it are never synchronised in
 * either direction, and the first pull and the first push start there instead of at the beginning of history.
 */
export function financeSyncFromStart(syncFrom: unknown, timezone: string | null | undefined): string | null {
  if (typeof syncFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(syncFrom)) return null;
  const zone = timezone && isValidTimezone(timezone) ? timezone : 'UTC';
  const day = DateTime.fromISO(syncFrom, { zone });
  return day.isValid ? day.startOf('day').toUTC().toISO() : null;
}

/**
 * Serials this connector used before a re-pointing (`devices.config.previousSerials`). Finance's loop guard only excludes the
 * CURRENT connector device, so punches FlowZa Time pushed under an older serial would otherwise come back as Finance punches.
 */
export function financePreviousSerials(config: Record<string, unknown>): string[] {
  const v = config['previousSerials'];
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0).slice(0, 20) : [];
}
