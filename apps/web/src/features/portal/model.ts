import { DateTime } from 'luxon';

/**
 * Pure helpers for the self-service portal. Day counting mirrors `countLeaveDays` in @flowza/domain (the server's
 * figure is authoritative; this only previews what a request will charge while the form is being filled in).
 */
export interface PreviewCalendar { weeklyOffDays: readonly number[]; holidays: ReadonlySet<string> }

export function previewLeaveDays(startDate: string, endDate: string, isHalfDay: boolean, cal: PreviewCalendar): number {
  const start = DateTime.fromISO(startDate, { zone: 'utc' });
  const end = DateTime.fromISO(endDate, { zone: 'utc' });
  if (!start.isValid || !end.isValid || end < start) return 0;
  let days = 0;
  for (let d = start; d <= end; d = d.plus({ days: 1 })) {
    if (!cal.weeklyOffDays.includes(d.weekday % 7) && !cal.holidays.has(d.toISODate()!)) days += 1;
  }
  return isHalfDay ? days * 0.5 : days;
}

/** Weeks of a month as rows of 7 cells (ISO date or null padding), starting on `firstDayOfWeek` (0=Sun..6=Sat). */
export function monthWeeks(month: string, firstDayOfWeek = 0): Array<Array<string | null>> {
  const start = DateTime.fromISO(`${month}-01`, { zone: 'utc' });
  if (!start.isValid) return [];
  const lead = ((start.weekday % 7) - firstDayOfWeek + 7) % 7;
  const cells: Array<string | null> = Array.from({ length: lead }, () => null);
  for (let d = start; d.month === start.month; d = d.plus({ days: 1 })) cells.push(d.toISODate()!);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Weekday indexes (0=Sun..6=Sat) in display order for a week starting on `firstDayOfWeek`. */
export const weekdayOrder = (firstDayOfWeek = 0): number[] => Array.from({ length: 7 }, (_, i) => (firstDayOfWeek + i) % 7);

export const shiftMonth = (month: string, by: number): string => DateTime.fromISO(`${month}-01`, { zone: 'utc' }).plus({ months: by }).toFormat('yyyy-MM');

/** "yyyy-MM" when valid, else the fallback (URL params are user input). */
export const validMonth = (value: string | null | undefined, fallback: string): string => (value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : fallback);

/** Share of the allowance already used / requested, clamped to [0, 1] for the progress bar. */
export function balanceShares(b: { allowanceDays: number | null; usedDays: number; pendingDays: number }): { used: number; pending: number } | null {
  if (b.allowanceDays === null || b.allowanceDays <= 0) return null;
  const used = Math.min(1, b.usedDays / b.allowanceDays);
  const pending = Math.min(1 - used, b.pendingDays / b.allowanceDays);
  return { used, pending };
}

/** Whole years and months of service since the joining date (as of `today`). */
export function tenure(joiningDate: string, today: string): { years: number; months: number } {
  const diff = DateTime.fromISO(today, { zone: 'utc' }).diff(DateTime.fromISO(joiningDate, { zone: 'utc' }), ['years', 'months']);
  return { years: Math.max(0, Math.floor(diff.years)), months: Math.max(0, Math.floor(diff.months)) };
}

/** Days formatted without a trailing ".0" (half days keep their ".5"). */
export const fmtDays = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));
