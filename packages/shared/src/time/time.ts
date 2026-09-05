import { DateTime, IANAZone } from 'luxon';

export type IsoDate = string; // YYYY-MM-DD
export type IsoDateTime = string; // RFC3339 UTC

export function isValidTimezone(tz: string): boolean {
  return IANAZone.isValidZone(tz);
}

export function nowUtc(): DateTime {
  return DateTime.utc();
}

export function toIsoDate(dt: DateTime): IsoDate {
  return dt.toISODate() as IsoDate;
}

/** Local calendar date for an instant in a zone. */
export function localDateOf(instant: Date | string, zone: string): IsoDate {
  const dt = typeof instant === 'string' ? DateTime.fromISO(instant, { zone: 'utc' }) : DateTime.fromJSDate(instant, { zone: 'utc' });
  return toIsoDate(dt.setZone(zone));
}

/** Combine a local date and HH:mm[:ss] time in a zone into a UTC DateTime. Handles DST gaps by luxon rules. */
export function localDateTime(date: IsoDate, time: string, zone: string): DateTime {
  const [h, m, s] = time.split(':').map((p) => Number(p));
  return DateTime.fromISO(date, { zone }).set({ hour: h ?? 0, minute: m ?? 0, second: s ?? 0, millisecond: 0 });
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return toIsoDate(DateTime.fromISO(date, { zone: 'utc' }).plus({ days }));
}

export function eachDate(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  let cur = DateTime.fromISO(from, { zone: 'utc' });
  const end = DateTime.fromISO(to, { zone: 'utc' });
  while (cur <= end) {
    out.push(toIsoDate(cur));
    cur = cur.plus({ days: 1 });
  }
  return out;
}

/** ISO weekday → 0 (Sunday) … 6 (Saturday), matching organisations.weekly_off_days convention. */
export function dayOfWeek(date: IsoDate): number {
  const iso = DateTime.fromISO(date, { zone: 'utc' }).weekday; // 1 = Monday … 7 = Sunday
  return iso % 7;
}

export function minutesBetween(a: DateTime, b: DateTime): number {
  return Math.round(b.diff(a, 'minutes').minutes);
}

export function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
