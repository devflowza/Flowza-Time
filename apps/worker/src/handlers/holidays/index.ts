import { DateTime } from 'luxon';
import { z } from 'zod';
import { HOLIDAY_ROLLOVER_JOB_TYPE, copyCalendarYear, holidayRolloverDedupeKey, withContext, writeAudit } from '@flowza/database';
import { AppError, event, isValidTimezone } from '@flowza/shared';
import type { WorkerDeps } from '../../deps.js';
import type { ScheduledTask } from '../../scheduler.js';
import type { HandlerRegistry, JobContext } from '../types.js';

/*
 * The yearly holiday rollover ("Official holidays"): from 1 December, organisation time, next year's occurrence of every
 * RECURRING holiday (`holidays.recurs_yearly`, a fixed Gregorian date) is created in each calendar with `auto_rollover`.
 *
 *   holidays.rollover   hourly tick, platform scan of `organizations` only; an organisation is enqueued while its local clock is
 *                       in December at HOLIDAY_ROLLOVER_LOCAL_HOUR — ONE job per organisation and local date (the queue dedupes
 *                       pending jobs only, so the key carries the date). It runs daily through December: a missed hour, or a
 *                       recurring holiday added later in December, is caught up the next day.
 *   HOLIDAY_ROLLOVER    in the organisation's system context, per calendar with auto_rollover: packages/database copyCalendarYear
 *                       (this year → next year, recurring holidays not rolled over yet — the same copy as "Copy to next year").
 *                       The ledger `holidays.rolled_over_at` keeps an occurrence HR deleted from next year deleted, and a date
 *                       next year already has (for overlapping branches) is skipped. Audited as SYSTEM `holiday_calendar.rolled_over`
 *                       when something was created. Next year is in the future: nothing to recompute.
 */

/** Local hour (organisation timezone) of the daily December rollover, after the leave year close (2) and comp-off expiry (3). */
export const HOLIDAY_ROLLOVER_LOCAL_HOUR = 4;

export const holidayRolloverPayloadSchema = z.object({ organizationId: z.guid(), toYear: z.number().int().min(2000).max(2200), asOf: z.string().optional() });

/** Whether the scheduler enqueues the rollover at this local time: every December day at the local hour, for the next year. */
export function holidayRolloverDue(local: DateTime): { due: boolean; toYear: number } {
  return { due: local.month === 12 && local.hour === HOLIDAY_ROLLOVER_LOCAL_HOUR, toYear: local.year + 1 };
}

export interface HolidayRolloverSummary { organizationId: string; toYear: number; calendars: number; created: number; alreadyThere: number }

export async function runHolidayRollover(deps: Pick<WorkerDeps, 'db' | 'log' | 'now'>, organizationId: string, toYear: number, jobId: string | null = null): Promise<HolidayRolloverSummary> {
  const ctx = { kind: 'system' as const, organizationId, ...(jobId ? { jobId } : {}) };
  const summary = await withContext(deps.db, ctx, async (trx) => {
    const calendars = await trx.selectFrom('holidayCalendars').select(['id', 'name']).where('organizationId', '=', organizationId).where('autoRollover', '=', true).orderBy('name').orderBy('id').execute();
    const out: HolidayRolloverSummary = { organizationId, toYear, calendars: calendars.length, created: 0, alreadyThere: 0 };
    for (const c of calendars) {
      const res = await copyCalendarYear(trx, { organizationId, calendarId: c.id, fromYear: toYear - 1, toYear, includeNonRecurring: false, onlyNotRolledOver: true, now: deps.now() });
      const alreadyThere = res.skipped.filter((s) => s.reason === 'ALREADY_THERE');
      out.created += res.created.length;
      out.alreadyThere += alreadyThere.length;
      if (res.created.length === 0) continue;
      await writeAudit(trx, {
        organizationId, actorUserId: null, actorType: 'SYSTEM', action: 'holiday_calendar.rolled_over', entityType: 'holiday_calendar', entityId: c.id, jobId,
        newValue: { fromYear: toYear - 1, toYear, created: res.created.map((h) => ({ id: h.id, name: h.name, date: h.date })), alreadyThere: alreadyThere.map((s) => ({ name: s.name, date: s.date })) },
        reason: `Recurring holidays of ${toYear - 1} created for ${toYear} (automatic rollover)`,
      });
    }
    return out;
  });
  deps.log.info(event('holiday_rollover_done', { ...summary, jobId }));
  return summary;
}

export async function holidayRolloverHandler(ctx: JobContext): Promise<HolidayRolloverSummary> {
  const parsed = holidayRolloverPayloadSchema.safeParse(ctx.job.payload);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'HOLIDAY_ROLLOVER needs an organizationId and a toYear', { retryable: false });
  return runHolidayRollover(ctx.deps, parsed.data.organizationId, parsed.data.toYear, String(ctx.job.id));
}

export function registerHolidayHandlers(registry: HandlerRegistry): void {
  registry.register({ jobType: HOLIDAY_ROLLOVER_JOB_TYPE, handler: holidayRolloverHandler, timeoutMs: 300_000 });
}

/** Enqueue the rollover for every active / trial organisation whose local clock is due (enqueue-only, platform scan). */
export async function scheduleHolidayRollover(deps: Pick<WorkerDeps, 'db' | 'queue' | 'now'>): Promise<{ organizations: number; enqueued: number }> {
  const now = deps.now();
  const orgs = await withContext(deps.db, { kind: 'platform' }, (trx) => trx.selectFrom('organizations').select(['id', 'timezone']).where('status', 'in', ['trial', 'active']).execute());
  let enqueued = 0;
  for (const o of orgs) {
    const local = DateTime.fromJSDate(now).setZone(isValidTimezone(o.timezone) ? o.timezone : 'UTC');
    const { due, toYear } = holidayRolloverDue(local);
    if (!due) continue;
    const asOf = local.toISODate() ?? now.toISOString().slice(0, 10);
    await deps.queue.enqueue({ queue: 'processing', jobType: HOLIDAY_ROLLOVER_JOB_TYPE, organizationId: o.id, payload: { organizationId: o.id, toYear, asOf }, priority: 2, dedupeKey: holidayRolloverDedupeKey(o.id, asOf), lockTimeoutSeconds: 300, maxAttempts: 3 });
    enqueued += 1;
  }
  return { organizations: orgs.length, enqueued };
}

export const holidayTasks: ScheduledTask[] = [
  { name: 'holidays.rollover', everyMs: 3_600_000, run: (d) => scheduleHolidayRollover(d) },
];
