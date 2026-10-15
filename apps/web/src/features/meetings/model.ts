import { DateTime } from 'luxon';
import type { AttendeeStatus, MeetingDto } from '@flowza/contracts';

/*
 * Pure helpers of the meetings page: the period on screen (a day or a week starting on the organisation's first day of the
 * week), the local day a meeting belongs to (in its branch's timezone), and a wall-clock time in a room's zone → an instant.
 */

export type MeetingsView = 'day' | 'week';
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The first day of the week holding `date`; `firstDayOfWeek` 0 = Sunday … 6 = Saturday. */
export function weekStart(date: string, firstDayOfWeek = 0): string {
  const d = DateTime.fromISO(date, { zone: 'utc' });
  const jsDay = d.weekday % 7; // Luxon: 1 = Monday … 7 = Sunday
  const first = ((firstDayOfWeek % 7) + 7) % 7;
  return d.minus({ days: (jsDay - first + 7) % 7 }).toISODate()!;
}

/** The days on screen, inclusive. */
export function periodDays(view: MeetingsView, date: string, firstDayOfWeek = 0): string[] {
  if (view === 'day') return [date];
  const start = DateTime.fromISO(weekStart(date, firstDayOfWeek), { zone: 'utc' });
  return Array.from({ length: 7 }, (_, i) => start.plus({ days: i }).toISODate()!);
}

/** The same view one step back (-1) or forward (+1). */
export function shiftPeriod(view: MeetingsView, date: string, delta: number): string {
  return DateTime.fromISO(date, { zone: 'utc' }).plus(view === 'day' ? { days: delta } : { weeks: delta }).toISODate()!;
}

/** The local date a meeting starts on, in its branch's timezone. */
export function meetingDay(m: Pick<MeetingDto, 'startsAt'>, zone: string): string {
  return DateTime.fromISO(m.startsAt, { zone: 'utc' }).setZone(zone).toISODate() ?? m.startsAt.slice(0, 10);
}

/** A wall-clock date + time ("2026-10-20", "09:30") in an IANA zone → the UTC instant (ISO), or null when either is incomplete. */
export function zonedInstant(date: string, time: string, zone: string): string | null {
  if (!ISO_DATE.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const dt = DateTime.fromISO(`${date}T${time}`, { zone });
  return dt.isValid ? dt.toUTC().toISO({ suppressMilliseconds: true }) : null;
}

/** The next whole hour in a zone, as the default start of a new booking: { date, start, end } (one hour long, same day). */
export function defaultSlot(zone: string, day: string | null, now: DateTime = DateTime.now()): { date: string; start: string; end: string } {
  const local = now.setZone(zone);
  const today = local.toISODate()!;
  if (day && day > today) return { date: day, start: '09:00', end: '10:00' };
  const next = local.plus({ hours: 1 }).startOf('hour');
  // late in the evening there is no hour left today: offer tomorrow morning
  if (next.toISODate() !== today || next.hour >= 23) return { date: local.plus({ days: 1 }).toISODate()!, start: '09:00', end: '10:00' };
  return { date: today, start: next.toFormat('HH:mm'), end: next.plus({ hours: 1 }).toFormat('HH:mm') };
}

export const ATTENDEE_TONE: Record<AttendeeStatus, 'success' | 'warning' | 'danger' | 'neutral'> = { ON_TIME: 'success', LATE: 'warning', ABSENT: 'danger', UPCOMING: 'neutral' };
export const PHASE_TONE: Record<MeetingDto['phase'], 'info' | 'success' | 'neutral'> = { upcoming: 'info', in_progress: 'success', over: 'neutral' };
/** A reader's connection status → the colour of its dot. */
export function readerDotClass(status: string): string {
  if (status === 'online') return 'bg-emerald-500';
  if (status === 'offline' || status === 'error') return 'bg-red-500';
  if (status === 'degraded' || status === 'vendor_degraded') return 'bg-amber-500';
  return 'bg-slate-400';
}
