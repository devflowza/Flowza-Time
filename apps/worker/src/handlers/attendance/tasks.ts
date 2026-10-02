import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { isValidTimezone } from '@flowza/shared';
import { withContext } from '@flowza/database';
import type { ScheduledTask } from '../../scheduler.js';
import { enqueueNormalizeRaw } from './common.js';
import { DAY_CLOSE_JOB_TYPE, dayCloseDedupeKey } from './day-close.js';
import { MATERIALIZE_JOB_TYPE, materializeDedupeKey } from './materialize.js';

/** Local hour (organisation timezone) in which the daily day-close job is enqueued — shortly after local midnight. */
export const DAY_CLOSE_LOCAL_HOUR = 1;

/**
 * Attendance scheduler ticks (enqueue-only).
 *  - normalize-sweep: the normaliser is normally triggered by ingestion; this sweep catches raw rows that arrived without a
 *    trigger (push endpoints, imports, crashed jobs) — a platform scan on the whitelisted `attendance_raw_transactions`
 *    (select only) followed by one deduped NORMALIZE_RAW per organisation.
 *  - attendance.day-close: once per organisation per LOCAL day, one ATTENDANCE_DAY_CLOSE job that marks unexplained days
 *    older than the grace period UNEXCUSED and, where enabled, charges the pay effect (HR portal Prompt 3). The tick is
 *    hourly and an organisation is enqueued only while its local clock is in DAY_CLOSE_LOCAL_HOUR (the queue dedupes
 *    PENDING jobs only, so a completed job would otherwise be enqueued again every hour of the day); the dedupe key
 *    carries the local date. A missed window is caught up by the next day's run (the sweep looks back 31 days). The job
 *    itself reads the settings in the organisation's system context.
 *  - attendance.materialize: every hour, one ATTENDANCE_MATERIALIZE_DAYS per organisation (deduped while one is pending): the
 *    days of the last MATERIALIZE_LOOKBACK_DAYS that an employee has no record for are calculated (an absence nobody punched
 *    for, a weekly off, a holiday) and PENDING days whose window has closed are judged — so every day reaches the register,
 *    the monthly summary and the reports. Hourly rather than once a day so a branch in any timezone, a night shift that ends
 *    after midnight and a missed run are caught up within the hour.
 */
export const attendanceTasks: ScheduledTask[] = [
  {
    name: 'normalize-sweep',
    everyMs: 60_000,
    run: async (d) => {
      const orgs = await withContext(d.db, { kind: 'platform' }, (trx) =>
        sql<{ organizationId: string }>`select distinct organization_id as "organizationId" from public.attendance_raw_transactions where processing_status = 'pending'`.execute(trx));
      for (const o of orgs.rows) await enqueueNormalizeRaw(d.queue, o.organizationId);
      return { organizations: orgs.rows.length };
    },
  },
  {
    name: 'attendance.day-close',
    everyMs: 3_600_000,
    run: async (d) => {
      const now = d.now();
      const orgs = await withContext(d.db, { kind: 'platform' }, (trx) => trx.selectFrom('organizations').select(['id', 'timezone']).where('status', 'in', ['trial', 'active']).execute());
      let enqueued = 0;
      for (const o of orgs) {
        const local = DateTime.fromJSDate(now).setZone(isValidTimezone(o.timezone) ? o.timezone : 'UTC');
        if (local.hour !== DAY_CLOSE_LOCAL_HOUR) continue;
        const localDate = local.toISODate() ?? now.toISOString().slice(0, 10);
        await d.queue.enqueue({ queue: 'processing', jobType: DAY_CLOSE_JOB_TYPE, organizationId: o.id, payload: { organizationId: o.id, asOf: localDate }, priority: 2, dedupeKey: dayCloseDedupeKey(o.id, localDate), lockTimeoutSeconds: 1_800, maxAttempts: 2 });
        enqueued += 1;
      }
      return { organizations: orgs.length, enqueued };
    },
  },
  {
    name: 'attendance.materialize',
    everyMs: 3_600_000,
    run: async (d) => {
      const orgs = await withContext(d.db, { kind: 'platform' }, (trx) => trx.selectFrom('organizations').select(['id']).where('status', 'in', ['trial', 'active']).execute());
      for (const o of orgs) {
        await d.queue.enqueue({ queue: 'processing', jobType: MATERIALIZE_JOB_TYPE, organizationId: o.id, payload: { organizationId: o.id }, priority: 2, dedupeKey: materializeDedupeKey(o.id), lockTimeoutSeconds: 1_800, maxAttempts: 2 });
      }
      return { organizations: orgs.length };
    },
  },
];
