import { DateTime } from 'luxon';
import { isValidTimezone } from '@flowza/shared';
import { LEAVE_COMP_OFF_EXPIRY_JOB_TYPE, LEAVE_YEAR_CLOSE_JOB_TYPE, leaveCompOffExpiryDedupeKey, leaveYearCloseDedupeKey, withContext } from '@flowza/database';
import type { ScheduledTask } from '../../scheduler.js';
import type { HandlerRegistry } from '../types.js';
import { isoDate } from '../attendance/common.js';
import { leaveYearCloseHandler } from './year-close.js';
import { compOffExpiryHandler } from './comp-off-expiry.js';

export { runLeaveYearClose, leaveYearCloseHandler, leaveYearClosePayloadSchema, type LeaveYearCloseSummary } from './year-close.js';
export { runCompOffExpiry, compOffExpiryHandler, compOffExpiryPayloadSchema, type CompOffExpirySummary } from './comp-off-expiry.js';

/** Local hour (organisation timezone) of the 1 January year close, after the day close (01:00). */
export const LEAVE_YEAR_CLOSE_LOCAL_HOUR = 2;
/** Local hour of the daily comp-off expiry sweep. */
export const COMP_OFF_EXPIRY_LOCAL_HOUR = 3;

export function registerLeaveHandlers(registry: HandlerRegistry): void {
  registry.register({ jobType: LEAVE_YEAR_CLOSE_JOB_TYPE, handler: leaveYearCloseHandler, timeoutMs: 1_800_000 });
  registry.register({ jobType: LEAVE_COMP_OFF_EXPIRY_JOB_TYPE, handler: compOffExpiryHandler, timeoutMs: 600_000 });
}

/**
 * Whether the scheduler should (still) enqueue the close of the organisation's previous year at this local time (review
 * P2-2 catch-up): from 1 January `LEAVE_YEAR_CLOSE_LOCAL_HOUR`:00 local onward, until the ledger (`leave_year_closes`)
 * says the close ran AFTER that year ended — a missed hour (restart, deploy, outage) or a close queued before the year
 * ended is caught up on the next tick. An organisation created after that year ended has nothing to close.
 */
export function yearCloseDue(local: DateTime, orgCreatedOn: string, lastRanOn: string | null): { due: boolean; fromYear: number } {
  const fromYear = local.year - 1;
  const beforeStart = local.month === 1 && local.day === 1 && local.hour < LEAVE_YEAR_CLOSE_LOCAL_HOUR;
  const yearEnd = `${fromYear}-12-31`;
  return { fromYear, due: !beforeStart && orgCreatedOn <= yearEnd && !(lastRanOn !== null && lastRanOn > yearEnd) };
}

/**
 * Leave scheduler ticks (enqueue-only, hourly; the queue dedupes PENDING jobs, so the dedupe key carries the local date / year):
 *  - leave.year-close: from 1 January (local) LEAVE_YEAR_CLOSE for the year that just ended, until its ledger row says it
 *    ran after the year ended (review P2-2 catch-up; HR can also queue it on demand);
 *  - leave.comp-off-expiry: every day at the local hour, LEAVE_COMP_OFF_EXPIRY for the local date.
 */
export const leaveTasks: ScheduledTask[] = [
  {
    name: 'leave.year-close',
    everyMs: 3_600_000,
    run: async (d) => {
      const now = d.now();
      const { orgs, closes } = await withContext(d.db, { kind: 'platform' }, async (trx) => {
        const list = await trx.selectFrom('organizations').select(['id', 'timezone', 'createdAt']).where('status', 'in', ['trial', 'active']).execute();
        const ledger = list.length ? await trx.selectFrom('leaveYearCloses').select(['organizationId', 'fromYear', 'ranOn']).where('organizationId', 'in', list.map((o) => o.id)).where('fromYear', '>=', DateTime.fromJSDate(now).year - 2).execute() : [];
        return { orgs: list, closes: ledger };
      });
      const lastRan = new Map(closes.map((c) => [`${c.organizationId}|${c.fromYear}`, isoDate(c.ranOn)]));
      let enqueued = 0;
      for (const o of orgs) {
        const zone = isValidTimezone(o.timezone) ? o.timezone : 'UTC';
        const local = DateTime.fromJSDate(now).setZone(zone);
        const createdOn = DateTime.fromJSDate(o.createdAt instanceof Date ? o.createdAt : new Date(o.createdAt)).setZone(zone).toISODate()!;
        const { due, fromYear } = yearCloseDue(local, createdOn, lastRan.get(`${o.id}|${local.year - 1}`) ?? null);
        if (!due) continue;
        await d.queue.enqueue({ queue: 'processing', jobType: LEAVE_YEAR_CLOSE_JOB_TYPE, organizationId: o.id, payload: { organizationId: o.id, fromYear }, priority: 2, dedupeKey: leaveYearCloseDedupeKey(o.id, fromYear), lockTimeoutSeconds: 1_800, maxAttempts: 3 });
        enqueued += 1;
      }
      return { organizations: orgs.length, enqueued };
    },
  },
  {
    name: 'leave.comp-off-expiry',
    everyMs: 3_600_000,
    run: async (d) => {
      const now = d.now();
      const orgs = await withContext(d.db, { kind: 'platform' }, (trx) => trx.selectFrom('organizations').select(['id', 'timezone']).where('status', 'in', ['trial', 'active']).execute());
      let enqueued = 0;
      for (const o of orgs) {
        const local = DateTime.fromJSDate(now).setZone(isValidTimezone(o.timezone) ? o.timezone : 'UTC');
        if (local.hour !== COMP_OFF_EXPIRY_LOCAL_HOUR) continue;
        const localDate = local.toISODate() ?? now.toISOString().slice(0, 10);
        await d.queue.enqueue({ queue: 'processing', jobType: LEAVE_COMP_OFF_EXPIRY_JOB_TYPE, organizationId: o.id, payload: { organizationId: o.id, asOf: localDate }, priority: 2, dedupeKey: leaveCompOffExpiryDedupeKey(o.id, localDate), lockTimeoutSeconds: 600, maxAttempts: 2 });
        enqueued += 1;
      }
      return { organizations: orgs.length, enqueued };
    },
  },
];
