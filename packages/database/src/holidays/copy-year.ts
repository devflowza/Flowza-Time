import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { planHolidayYearCopy, type HolidayCopySkip } from '@flowza/domain';
import type { Trx } from '../context.js';

/*
 * Copy a holiday calendar's year to another year (packages/domain planHolidayYearCopy) — "Copy to next year" (API, the
 * caller's RLS: holiday.manage) and the yearly rollover (worker, system context of one organisation). One implementation, so
 * both create the same rows and keep the same ledger (`holidays.rolled_over_at`).
 */

/** Worker job: create next year's occurrence of the recurring holidays of every auto-rollover calendar (payload `{ organizationId, toYear }`). */
export const HOLIDAY_ROLLOVER_JOB_TYPE = 'HOLIDAY_ROLLOVER';
/** One pending rollover per organisation and local date (the queue dedupes pending jobs only; the sweep runs daily in December). */
export const holidayRolloverDedupeKey = (organizationId: string, asOf: string): string => `holiday-rollover:${organizationId}:${asOf}`;

const asDate = (date: string) => sql<Date>`${date}::date`;
function isoDate(v: Date | string): string {
  if (typeof v === 'string') return v.slice(0, 10);
  return DateTime.fromJSDate(v).toISODate() ?? v.toISOString().slice(0, 10);
}

export type HolidayRow = Awaited<ReturnType<typeof yearRows>>[number];
function yearRows(trx: Trx, organizationId: string, calendarId: string, year: number) {
  return trx.selectFrom('holidays').selectAll().where('organizationId', '=', organizationId).where('calendarId', '=', calendarId)
    .where('date', '>=', asDate(`${year}-01-01`)).where('date', '<=', asDate(`${year}-12-31`)).orderBy('date').orderBy('id').execute();
}

export interface CalendarYearCopy {
  /** The holidays created in the target year. */
  created: HolidayRow[];
  skipped: HolidayCopySkip[];
  /** Recurring source holidays whose next occurrence now exists (stamped `rolled_over_at` when copying to the next year). */
  rolledOver: string[];
}

/**
 * Copy the holidays of `fromYear` in one calendar to `toYear`: recurring ones on the same day and month, the others (only with
 * `includeNonRecurring`) as tentative placeholders; a date the target year already has for overlapping branches is skipped.
 * `onlyNotRolledOver` (the rollover) leaves out recurring holidays already stamped, so an occurrence HR deleted from next year
 * is not brought back. Copying to the NEXT year stamps the recurring sources `rolled_over_at`.
 */
export async function copyCalendarYear(trx: Trx, args: { organizationId: string; calendarId: string; fromYear: number; toYear: number; includeNonRecurring: boolean; onlyNotRolledOver?: boolean; now?: Date }): Promise<CalendarYearCopy> {
  const { organizationId, calendarId, fromYear, toYear } = args;
  const [sourceRows, targetRows] = await Promise.all([yearRows(trx, organizationId, calendarId, fromYear), yearRows(trx, organizationId, calendarId, toYear)]);
  const source = sourceRows
    .filter((h) => !(args.onlyNotRolledOver && h.recursYearly && h.rolledOverAt !== null))
    .map((h) => ({ row: h, id: h.id, name: h.name, date: isoDate(h.date), endDate: h.endDate === null ? null : isoDate(h.endDate), branchIds: h.branchIds, recursYearly: h.recursYearly, isTentative: h.isTentative }));
  const existing = targetRows.map((h) => ({ id: h.id, name: h.name, date: isoDate(h.date), endDate: h.endDate === null ? null : isoDate(h.endDate), branchIds: h.branchIds, recursYearly: h.recursYearly, isTentative: h.isTentative }));
  const plan = planHolidayYearCopy(source, existing, fromYear, toYear, { includeNonRecurring: args.includeNonRecurring });
  const created = plan.create.length
    ? await trx.insertInto('holidays').values(plan.create.map((c) => ({
      organizationId, calendarId, name: c.source.row.name, nameAr: c.source.row.nameAr, date: c.date, endDate: c.endDate, isHalfDay: c.source.row.isHalfDay, type: c.source.row.type,
      branchIds: c.source.row.branchIds, isTentative: c.isTentative, recursYearly: c.source.row.recursYearly,
    }))).returningAll().execute()
    : [];
  if (toYear === fromYear + 1 && plan.rolledOver.length) {
    await trx.updateTable('holidays').set({ rolledOverAt: args.now ?? new Date() }).where('organizationId', '=', organizationId).where('id', 'in', plan.rolledOver).where('rolledOverAt', 'is', null).execute();
  }
  return { created: created.sort((a, b) => isoDate(a.date).localeCompare(isoDate(b.date)) || a.name.localeCompare(b.name)), skipped: plan.skipped, rolledOver: plan.rolledOver };
}
