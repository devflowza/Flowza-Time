import { DateTime } from 'luxon';
import { ProtocolError } from './errors.js';

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

const OFFSET_PATTERN = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parses a device-reported time. Values carrying an explicit offset/`Z` are taken as-is; values without one
 * (the common case for terminals) are interpreted as wall-clock time in `timezone` (IANA) and converted to UTC.
 * Accepts ISO-8601 (`2026-01-05T08:00:00`) and the space-separated form (`2026-01-05 08:00:00`).
 */
export function parseDeviceTime(value: string, timezone: string): DateTime {
  const trimmed = value.trim();
  let dt: DateTime;
  if (OFFSET_PATTERN.test(trimmed)) dt = DateTime.fromISO(trimmed, { setZone: true });
  else {
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
