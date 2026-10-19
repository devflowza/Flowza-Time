/**
 * Copying a holiday calendar's year to another year — "Copy to next year" on the Holidays page and the yearly rollover of the
 * worker (`holidays.rollover`). Pure: the callers load the holidays of both years and insert what the plan creates.
 *
 *   - A RECURRING holiday (`recursYearly`, a fixed Gregorian date: National Day, New Year…) is copied to the same day and month;
 *     29 February becomes 28 February outside a leap year. It stays recurring and keeps its tentative flag.
 *   - Any other holiday (moon-sighted: Eid, the Hijri New Year…) moves every year: it is copied only with `includeNonRecurring`,
 *     on the same day and month but TENTATIVE — a placeholder for HR to move to the announced date.
 *   - A holiday is skipped when the target year already has one on that start date for overlapping branches (an
 *     organisation-wide holiday overlaps every branch scope) — the existing one, or one copied earlier in the same plan.
 * The end of a multi-day holiday moves by the same number of years (31 Dec – 1 Jan stays a two-day holiday).
 */
export interface CopyableHoliday {
  id: string;
  name: string;
  date: string;
  endDate: string | null;
  branchIds: readonly string[] | null;
  recursYearly: boolean;
  isTentative: boolean;
}
export interface PlannedHolidayCopy<T extends CopyableHoliday> { source: T; date: string; endDate: string | null; isTentative: boolean }
export type HolidayCopySkipReason = 'NOT_RECURRING' | 'ALREADY_THERE';
export interface HolidayCopySkip { sourceId: string; name: string; date: string; reason: HolidayCopySkipReason }
export interface HolidayCopyPlan<T extends CopyableHoliday> {
  create: Array<PlannedHolidayCopy<T>>;
  skipped: HolidayCopySkip[];
  /** Recurring holidays whose occurrence in the target year now exists (copied, or found there): the rollover's ledger. */
  rolledOver: string[];
}

const isLeap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** `date` (YYYY-MM-DD) on the same day and month of `year`; 29 February → 28 February outside a leap year. */
export function sameDayInYear(date: string, year: number): string {
  const monthDay = date.slice(5, 10);
  return `${String(year).padStart(4, '0')}-${monthDay === '02-29' && !isLeap(year) ? '02-28' : monthDay}`;
}

/** Two branch scopes share a branch (null / empty = every branch the calendar serves). */
export function branchScopesOverlap(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (!a || a.length === 0 || !b || b.length === 0) return true;
  return a.some((x) => b.includes(x));
}

export function planHolidayYearCopy<T extends CopyableHoliday>(source: readonly T[], existing: readonly CopyableHoliday[], fromYear: number, toYear: number, opts: { includeNonRecurring: boolean }): HolidayCopyPlan<T> {
  const years = toYear - fromYear;
  const taken: Array<{ date: string; branchIds: readonly string[] | null }> = existing.filter((h) => h.date.startsWith(`${toYear}-`)).map((h) => ({ date: h.date, branchIds: h.branchIds }));
  const ordered = source.filter((h) => h.date.startsWith(`${fromYear}-`)).slice().sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const plan: HolidayCopyPlan<T> = { create: [], skipped: [], rolledOver: [] };
  for (const h of ordered) {
    if (!h.recursYearly && !opts.includeNonRecurring) { plan.skipped.push({ sourceId: h.id, name: h.name, date: h.date, reason: 'NOT_RECURRING' }); continue; }
    const date = sameDayInYear(h.date, toYear);
    const end = h.endDate && h.endDate !== h.date ? sameDayInYear(h.endDate, Number(h.endDate.slice(0, 4)) + years) : null;
    if (taken.some((t) => t.date === date && branchScopesOverlap(t.branchIds, h.branchIds))) {
      plan.skipped.push({ sourceId: h.id, name: h.name, date, reason: 'ALREADY_THERE' });
      if (h.recursYearly) plan.rolledOver.push(h.id);
      continue;
    }
    plan.create.push({ source: h, date, endDate: end !== null && end >= date ? end : null, isTentative: h.recursYearly ? h.isTentative : true });
    taken.push({ date, branchIds: h.branchIds });
    if (h.recursYearly) plan.rolledOver.push(h.id);
  }
  return plan;
}
