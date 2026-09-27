import { DateTime } from 'luxon';
import { isValidTimezone } from '@flowza/shared';
import { LEAVE_COMP_OFF_EXPIRY_JOB_TYPE, LEAVE_YEAR_CLOSE_JOB_TYPE, leaveCompOffExpiryDedupeKey, leaveYearCloseDedupeKey, withContext } from '@flowza/database';
import type { ScheduledTask } from '../../scheduler.js';
import type { HandlerRegistry } from '../types.js';
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
 * Leave scheduler ticks (enqueue-only, hourly; an organisation is enqueued only while its local clock is in the task's hour —
 * the queue dedupes PENDING jobs, so the dedupe key carries the local date / year):
 *  - leave.year-close: on 1 January, LEAVE_YEAR_CLOSE for the year that just ended (HR can also queue it on demand);
 *  - leave.comp-off-expiry: every day, LEAVE_COMP_OFF_EXPIRY for the local date.
 */
export const leaveTasks: ScheduledTask[] = [
  {
    name: 'leave.year-close',
    everyMs: 3_600_000,
    run: async (d) => {
      const now = d.now();
      const orgs = await withContext(d.db, { kind: 'platform' }, (trx) => trx.selectFrom('organizations').select(['id', 'timezone']).where('status', 'in', ['trial', 'active']).execute());
      let enqueued = 0;
      for (const o of orgs) {
        const local = DateTime.fromJSDate(now).setZone(isValidTimezone(o.timezone) ? o.timezone : 'UTC');
        if (local.month !== 1 || local.day !== 1 || local.hour !== LEAVE_YEAR_CLOSE_LOCAL_HOUR) continue;
        const fromYear = local.year - 1;
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
