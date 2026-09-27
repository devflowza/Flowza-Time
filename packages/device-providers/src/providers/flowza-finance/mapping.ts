import { DateTime } from 'luxon';
import { z } from 'zod';
import type { AttendanceEventType, PunchDirection, RawTransaction, VerificationMethod } from '@flowza/contracts';
import { FINANCE_DEFAULT_BASE_URL } from '@flowza/contracts';
import { boundedText, isValidTimezone } from '../../protocol-utils.js';
import { ProviderError, type SyncCursor } from '../../types.js';

/** Paths under the Finance functions base URL. */
export const FINANCE_EXPORT_PATH = 'attendance-export';
export const FINANCE_INGEST_PATH = 'attendance-ingest';
/** Finance caps an export page at 1000 rows and an ingest batch at 500 punches. */
export const FINANCE_EXPORT_MAX_LIMIT = 1000;
export const FINANCE_EXPORT_DEFAULT_LIMIT = 500;
export const FINANCE_INGEST_MAX_BATCH = 500;
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

/**
 * Our stored cursor is `{ since: <next_cursor> }` — Finance's token stored verbatim (it is opaque: base64url("<created_at>|<id>")
 * of the last exported row). `null` / `{}` = start from the beginning. Anything else was not issued by this provider → INVALID_CONFIG,
 * which the sync engine answers with a time-based rewind (AGENTS.md cursor rule).
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
  return new ProviderError('INVALID_CONFIG', 'Unparseable Flowza Finance cursor', { retryable: false, details: { cursor: boundedText(JSON.stringify(cursor), 200) } });
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
 * Finance export row → RawTransaction. Identity = `employee_number` (Finance's employee, when the PIN is mapped) else the producing
 * device's `pin`; rows with neither cannot be attributed and are skipped (counted, never invented). `punchedAt` is Finance's
 * `time_utc`; `deviceLocalTime` is that instant in the producing device's zone. The raw payload keeps an allowlist of Finance
 * fields — bounded strings, never anything biometric.
 */
export function mapFinancePunch(punch: FinanceExportPunch, connectorSerial: string): MappedFinancePunch {
  const identity = (punch.employee_number ?? punch.pin ?? '').trim();
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

// ----- base URL (the ONE egress rule for the connector, shared by the API service and the worker) --------------------------

/**
 * Loopback, link-local, RFC-1918/ULA, CGNAT, multicast and bare intranet names: a tenant must not be able to point the worker at
 * them (SSRF). Pattern-based like the API's cloud-provider guard — the resolved address is not re-checked (known limit, documented).
 */
export function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a = 0, b = 0] = h.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (h.includes(':')) return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:');
  return !h.includes('.');
}

export interface FinanceBaseUrlOptions {
  /** Local development / tests only: accept `http://` and private or loopback hosts. Production keeps https + public hosts. */
  allowPrivateHosts?: boolean;
}

/**
 * Validates and normalises the Finance functions base URL: https only, a public host, no credentials in the URL, no trailing slash.
 * Throws ProviderError('INVALID_CONFIG'); the API translates that into a 400 with the same message.
 */
export function resolveFinanceBaseUrl(raw: unknown, opts: FinanceBaseUrlOptions = {}): string {
  const text = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : FINANCE_DEFAULT_BASE_URL;
  let url: URL;
  try { url = new URL(text); } catch { throw invalidBaseUrl('Finance base URL is not a valid URL'); }
  if (url.username || url.password) throw invalidBaseUrl('Finance base URL must not carry credentials');
  if (url.search || url.hash) throw invalidBaseUrl('Finance base URL must not carry a query string or fragment');
  if (url.protocol !== 'https:' && !(opts.allowPrivateHosts && url.protocol === 'http:')) throw invalidBaseUrl('Finance base URL must use https');
  if (!opts.allowPrivateHosts && isPrivateHostname(url.hostname)) throw invalidBaseUrl('Finance base URL must point at a public host');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
function invalidBaseUrl(message: string): ProviderError {
  return new ProviderError('INVALID_CONFIG', message, { retryable: false, details: { field: 'baseUrl' } });
}
