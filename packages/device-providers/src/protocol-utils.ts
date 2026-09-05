import { DateTime, IANAZone } from 'luxon';
import { ProtocolError } from './errors.js';
import { ProviderError } from './types.js';

/** Case-insensitive header lookup (HTTP headers are case-insensitive; frameworks differ in what they hand us). */
export function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === wanted) return v;
  return undefined;
}

/** Case-insensitive query lookup (`SN` vs `sn`). */
export function queryValue(query: Record<string, string>, name: string): string | undefined {
  const direct = query[name];
  if (direct !== undefined) return direct;
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(query)) if (k.toLowerCase() === wanted) return v;
  return undefined;
}

/** Splits a text body into non-empty lines (CRLF or LF). */
export function splitLines(body: string): string[] {
  return body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

/**
 * Upper bound for any inbound device/vendor body handled by this package (1 MiB). Terminals post a few KB per
 * upload; anything larger is either a misbehaving device or an attack on memory/CPU, and is refused before parsing.
 */
export const MAX_INBOUND_BODY_BYTES = 1_048_576;

/** Throws ProtocolError (HTTP 413) when `rawBody` exceeds `maxBytes` (UTF-8). Call before any parsing. */
export function assertBodySize(rawBody: string, maxBytes: number = MAX_INBOUND_BODY_BYTES): void {
  const bytes = Buffer.byteLength(rawBody, 'utf8');
  if (bytes > maxBytes) throw new ProtocolError(`Request body too large (${bytes} bytes > ${maxBytes})`, { httpStatus: 413, details: { bytes, maxBytes } });
}

/** True when `zone` is an IANA zone Luxon can resolve (e.g. `Asia/Muscat`); `UTC` is accepted. */
export const isValidTimezone = (zone: string): boolean => IANAZone.isValidZone(zone);

/** A wrong device timezone is a configuration problem (ours), never a protocol violation (the device's). */
export function assertTimezone(zone: string): void {
  if (!isValidTimezone(zone)) throw new ProviderError('INVALID_CONFIG', `Invalid device timezone "${zone}"`, { retryable: false, details: { timezone: zone } });
}

/** Truncates a free-text vendor field so raw payloads stay within the 16 KB allowlist budget. */
export function boundedText(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  return value.length <= max ? value : value.slice(0, max);
}

const OFFSET_PATTERN = /(Z|[+-]\d{2}:?\d{2})$/i;
const SPACE_SEPARATED = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;

/**
 * Parses a device-reported time. Values carrying an explicit offset/`Z` are taken as-is; values without one
 * (the common case for terminals) are interpreted as wall-clock time in `timezone` (IANA) and converted to UTC.
 * Accepts ISO-8601 (`2026-01-05T08:00:00`) and the space-separated form (`2026-01-05 08:00:00`), each with or
 * without an offset. Throws INVALID_CONFIG for an unknown timezone and ProtocolError for an unparseable value.
 */
export function parseDeviceTime(value: string, timezone: string): DateTime {
  assertTimezone(timezone);
  const trimmed = value.trim();
  let dt: DateTime;
  if (OFFSET_PATTERN.test(trimmed)) {
    // Luxon's ISO parser insists on the `T` separator; some firmware sends `YYYY-MM-DD HH:mm:ss+04:00`.
    const iso = SPACE_SEPARATED.test(trimmed) ? `${trimmed.slice(0, 10)}T${trimmed.slice(11)}` : trimmed;
    dt = DateTime.fromISO(iso, { setZone: true });
  } else {
    dt = DateTime.fromFormat(trimmed, 'yyyy-MM-dd HH:mm:ss', { zone: timezone });
    if (!dt.isValid) dt = DateTime.fromFormat(trimmed, 'yyyy-MM-dd HH:mm', { zone: timezone });
    if (!dt.isValid) dt = DateTime.fromISO(trimmed, { zone: timezone });
  }
  if (!dt.isValid) throw new ProtocolError(`Invalid device time "${trimmed}"`, { details: { reason: dt.invalidReason } });
  return dt.toUTC();
}

export function toIsoUtc(dt: DateTime): string {
  const iso = dt.toUTC().toISO({ suppressMilliseconds: true });
  if (iso === null) throw new ProtocolError('Invalid datetime');
  return iso;
}
