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
  /**
   * Leave v2 review P1-1 / P1-2 — the PER-DATE working calendar: true when the date is not a working day for the employee
   * as the attendance engine sees it (the weekly offs and the holiday calendar of the branch the employee was placed in ON
   * THAT DATE, and a rotation pattern's off days). When present it decides; `weeklyOffDays` / `holidays` then only describe
   * the current placement (display, older clients).
   */
  isOff?: (date: string) => boolean;
}

export interface LeaveRangeLike { startDate: string; endDate: string; isHalfDay: boolean }

function* eachDate(from: string, to: string): Generator<string> {
  let d = DateTime.fromISO(from, { zone: 'utc' });
  const end = DateTime.fromISO(to, { zone: 'utc' });
  if (!d.isValid || !end.isValid) return;
  for (; d <= end; d = d.plus({ days: 1 })) yield d.toISODate()!;
}

export function isWorkingDay(date: string, cal: WorkingCalendar): boolean {
  if (cal.isOff) return !cal.isOff(date);
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

/** A leave as stored: its range and, when known, `days` — the value computed when it was submitted (the document). */
export interface StoredLeaveRange extends LeaveRangeLike { days?: number | null }

/**
 * Days a leave charges inside a window (a year, a month, the part of a year up to a carry-forward expiry) — THE rule for
 * every figure built from stored leave (leave v2 review P1-2 / P2-8: balances, the calendar and team views, totals):
 *   - a leave lying entirely inside the window charges its stored `days`: the value at submission, i.e. the document the
 *     approver decided on — a later transfer, a holiday added afterwards or a new rotation never moves history;
 *   - a leave without stored days (recorded before leave v2) or crossing the window's edge is counted date by date with
 *     the (per-date) working calendar under the type's count mode — only the dates inside the window.
 */
export function leaveDaysInWindow(range: StoredLeaveRange, cal: WorkingCalendar, mode: LeaveCountMode, window?: { from: string; to: string }): number {
  const inside = !window || (range.startDate >= window.from && range.endDate <= window.to);
  if (inside && range.days !== null && range.days !== undefined && Number.isFinite(range.days)) return range.days;
  return countLeaveDaysByMode(range, cal, mode, window);
}

/**
 * The dates a range charges and how much each (1, or 0.5 for a half day): working dates by the (per-date) calendar, or every
 * date in `calendar` count mode. Comp-off matches each of these dates against a credit's expiry (review P2-4).
 */
export function chargedLeaveDates(range: LeaveRangeLike, cal: WorkingCalendar, mode: LeaveCountMode): Array<{ date: string; days: number }> {
  const out: Array<{ date: string; days: number }> = [];
  for (const d of eachDate(range.startDate, range.endDate)) {
    if (mode === 'calendar' || isWorkingDay(d, cal)) out.push({ date: d, days: range.isHalfDay ? 0.5 : 1 });
  }
  return out;
}

/** Expand holiday rows (date + optional end date) into the set of dates they cover. */
export function holidayDates(rows: ReadonlyArray<{ date: string; endDate: string | null }>): Set<string> {
  const out = new Set<string>();
  for (const h of rows) for (const d of eachDate(h.date, h.endDate ?? h.date)) out.add(d);
  return out;
}
