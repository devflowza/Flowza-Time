import { DateTime } from 'luxon';

/** Local (branch-timezone) date + HH:mm → UTC ISO string; null when incomplete/invalid. Never hand-compute offsets. */
export function localToUtcIso(date: string, time: string, zone: string): string | null {
  if (!date || !time) return null;
  const dt = DateTime.fromISO(`${date}T${time}`, { zone });
  return dt.isValid ? dt.toUTC().toISO() : null;
}
