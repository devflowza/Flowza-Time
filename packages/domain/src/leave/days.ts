import { DateTime } from 'luxon';

/**
 * Leave day arithmetic for the self-service portal (pure; dates are ISO `yyyy-MM-dd` calendar dates, no zone).
 *
 * A leave day is a date the employee was expected to work: weekly off days and holidays inside a range are not
 * charged. A half-day request is charged 0.5 when its single date is a working day.
 */
export interface WorkingCalendar {
  /** 0=Sun..6=Sat — the employee's effective weekly off days (employee → branch → organisation). */
  weeklyOffDays: readonly number[];
  /** Holiday dates that apply to the employee (a multi-day holiday contributes every date). */
  holidays: ReadonlySet<string>;
}

export interface LeaveRangeLike { startDate: string; endDate: string; isHalfDay: boolean }

function* eachDate(from: string, to: string): Generator<string> {
  let d = DateTime.fromISO(from, { zone: 'utc' });
  const end = DateTime.fromISO(to, { zone: 'utc' });
  if (!d.isValid || !end.isValid) return;
  for (; d <= end; d = d.plus({ days: 1 })) yield d.toISODate()!;
}

export function isWorkingDay(date: string, cal: WorkingCalendar): boolean {
  const weekday = DateTime.fromISO(date, { zone: 'utc' }).weekday % 7; // Luxon: 1=Mon..7=Sun → 0=Sun..6=Sat
  return !cal.weeklyOffDays.includes(weekday) && !cal.holidays.has(date);
}

/** Days charged for a leave range, optionally clipped to [clipFrom, clipTo] (e.g. one calendar year). */
export function countLeaveDays(range: LeaveRangeLike, cal: WorkingCalendar, clip?: { from: string; to: string }): number {
  const from = clip && clip.from > range.startDate ? clip.from : range.startDate;
  const to = clip && clip.to < range.endDate ? clip.to : range.endDate;
  if (to < from) return 0;
  let days = 0;
  for (const d of eachDate(from, to)) if (isWorkingDay(d, cal)) days += 1;
  return range.isHalfDay ? days * 0.5 : days;
}

/** How a leave type counts the days of a range: working days only (weekly offs / holidays free) or every calendar date. */
export type LeaveCountMode = 'working' | 'calendar';

/**
 * Days charged for a range under a type's count mode (leave v2). `working` = countLeaveDays; `calendar` = every date of
 * the (clipped) range, a half-day request 0.5.
 */
export function countLeaveDaysByMode(range: LeaveRangeLike, cal: WorkingCalendar, mode: LeaveCountMode, clip?: { from: string; to: string }): number {
  if (mode === 'working') return countLeaveDays(range, cal, clip);
  const from = clip && clip.from > range.startDate ? clip.from : range.startDate;
  const to = clip && clip.to < range.endDate ? clip.to : range.endDate;
  if (to < from) return 0;
  let days = 0;
  for (const _ of eachDate(from, to)) days += 1;
  return range.isHalfDay ? days * 0.5 : days;
}

/** Expand holiday rows (date + optional end date) into the set of dates they cover. */
export function holidayDates(rows: ReadonlyArray<{ date: string; endDate: string | null }>): Set<string> {
  const out = new Set<string>();
  for (const h of rows) for (const d of eachDate(h.date, h.endDate ?? h.date)) out.add(d);
  return out;
}
