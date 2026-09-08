import { DateTime } from 'luxon';

export type HoursNotation = 'h.mm' | 'hh:mm';
export type TimeFormat = '12h' | '24h';
export type DateFormat = 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD';

/** What an hours column shows when there is nothing to show. The samples print a hyphen, never "0.00". */
export const DASH = '-';

/**
 * 585 → "9.45": whole hours, a dot, then minutes zero-padded to two digits. This is the notation GCC payroll
 * departments read (the samples' Tot Hrs / OT / UT columns), and it is NOT a decimal — 9.45 means nine hours and
 * forty-five minutes. Summing these as decimals is the classic mistake; callers sum minutes and format once.
 */
export function hoursDotMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '';
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minutes));
  return `${sign}${Math.floor(abs / 60)}.${String(abs % 60).padStart(2, '0')}`;
}

/** 602 → "10:02". Hours are not capped at 24 (a period total can exceed a day). */
export function hoursColonMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '';
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minutes));
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`;
}

export function formatHours(minutes: number | null | undefined, notation: HoursNotation): string {
  return notation === 'h.mm' ? hoursDotMinutes(minutes) : hoursColonMinutes(minutes);
}

/** Hours for a table cell: null → dash; zero → dash unless `zeroAsValue`. */
export function formatHoursCell(minutes: number | null | undefined, notation: HoursNotation, opts: { zeroAsValue?: boolean } = {}): string {
  if (minutes === null || minutes === undefined) return DASH;
  if (minutes === 0 && !opts.zeroAsValue) return DASH;
  return formatHours(minutes, notation);
}

/** Tenant date-format setting → Luxon token pattern. */
export function luxonDatePattern(format: DateFormat): string {
  switch (format) {
    case 'MM/DD/YYYY': return 'MM/dd/yyyy';
    case 'YYYY-MM-DD': return 'yyyy-MM-dd';
    default: return 'dd/MM/yyyy';
  }
}

/** `YYYY-MM-DD` → text in a Luxon pattern. Calendar dates carry no zone, so they are formatted as-is. */
export function formatIsoDate(isoDate: string, pattern: string, locale = 'en'): string {
  const dt = DateTime.fromISO(isoDate, { zone: 'utc', locale });
  return dt.isValid ? dt.toFormat(pattern) : isoDate;
}

/**
 * An instant → wall-clock text in the record's zone. 12-hour output is lower-case `8:39 am`, as the samples print it;
 * 24-hour is `08:39`. Missing instants render as an empty string so the caller can choose its own marker.
 */
export function formatClock(instant: string | Date | null | undefined, zone: string, timeFormat: TimeFormat, locale = 'en'): string {
  if (instant === null || instant === undefined) return '';
  const dt = (instant instanceof Date ? DateTime.fromJSDate(instant) : DateTime.fromISO(instant)).setZone(zone).setLocale(locale);
  if (!dt.isValid) return '';
  return timeFormat === '12h' ? dt.toFormat('h:mm a').toLowerCase() : dt.toFormat('HH:mm');
}

/** Instant → generation-stamp text (`14/Jan/2018 11:28:23 am`), in the organisation zone. */
export function formatGeneratedAt(instant: Date, zone: string, timeFormat: TimeFormat, locale = 'en'): string {
  const dt = DateTime.fromJSDate(instant).setZone(zone).setLocale(locale);
  return timeFormat === '12h' ? dt.toFormat('dd/MMM/yyyy h:mm:ss a').toLowerCase().replace(/(\d{2}\/)([a-z])/, (_m, p, c: string) => p + c.toUpperCase()) : dt.toFormat('dd/MMM/yyyy HH:mm:ss');
}

/** Minutes between two instants, rounded to the nearest minute; null when either is missing. */
export function minutesBetweenInstants(a: string | Date | null | undefined, b: string | Date | null | undefined): number | null {
  if (!a || !b) return null;
  const ta = a instanceof Date ? a.getTime() : Date.parse(a);
  const tb = b instanceof Date ? b.getTime() : Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((tb - ta) / 60_000);
}

const CHUNK = /(\d+|\D+)/g;

/**
 * Natural ordering for employee numbers: `2001 < 2010 < 2076` and `334 < 1171 < OM190`. Digit runs compare
 * numerically, everything else case-insensitively, so a lexical `"2001" < "334"` never surfaces in a report.
 */
export function naturalCompare(a: string, b: string): number {
  const xa = a.match(CHUNK) ?? [];
  const xb = b.match(CHUNK) ?? [];
  const n = Math.min(xa.length, xb.length);
  for (let i = 0; i < n; i += 1) {
    const pa = xa[i]!;
    const pb = xb[i]!;
    const da = /^\d/.test(pa);
    const db = /^\d/.test(pb);
    if (da && db) {
      const diff = Number(pa) - Number(pb);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      if (pa.length !== pb.length) return pa.length - pb.length; // "007" after "7"
    } else if (da !== db) {
      return da ? -1 : 1; // digits sort before letters, so "334" precedes "OM190"
    } else {
      const c = pa.localeCompare(pb, 'en', { sensitivity: 'base' });
      if (c !== 0) return c;
    }
  }
  return xa.length - xb.length;
}

/** Day numbers of a month as the samples list them: `06 13` — two digits, space separated, ascending. */
export function dayList(isoDates: readonly string[]): string {
  return [...isoDates].sort().map((d) => d.slice(8, 10)).join(' ');
}
