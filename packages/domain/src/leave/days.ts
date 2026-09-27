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

/** Expand holiday rows (date + optional end date) into the set of dates they cover. */
export function holidayDates(rows: ReadonlyArray<{ date: string; endDate: string | null }>): Set<string> {
  const out = new Set<string>();
  for (const h of rows) for (const d of eachDate(h.date, h.endDate ?? h.date)) out.add(d);
  return out;
}

export interface LeaveBalanceInput { leaveTypeId: string; allowanceDays: number | null }
export interface LeaveBalanceRecord extends LeaveRangeLike { leaveTypeId: string; status: string }
export interface LeaveBalance { leaveTypeId: string; allowanceDays: number | null; usedDays: number; pendingDays: number; remainingDays: number | null }

/**
 * Per-type usage for one calendar year: APPROVED ranges count as used (whether taken or still upcoming), PENDING as
 * pending; rejected and cancelled requests are ignored. Remaining = allowance − used − pending (never below zero is
 * *not* enforced: an overdrawn balance shows as negative so HR sees it).
 */
export function leaveBalances(types: readonly LeaveBalanceInput[], records: readonly LeaveBalanceRecord[], cal: WorkingCalendar, year: number): LeaveBalance[] {
  const clip = { from: `${year}-01-01`, to: `${year}-12-31` };
  return types.map((t) => {
    let used = 0; let pending = 0;
    for (const r of records) {
      if (r.leaveTypeId !== t.leaveTypeId) continue;
      if (r.status === 'APPROVED') used += countLeaveDays(r, cal, clip);
      else if (r.status === 'PENDING') pending += countLeaveDays(r, cal, clip);
    }
    return { leaveTypeId: t.leaveTypeId, allowanceDays: t.allowanceDays, usedDays: used, pendingDays: pending, remainingDays: t.allowanceDays === null ? null : t.allowanceDays - used - pending };
  });
}
