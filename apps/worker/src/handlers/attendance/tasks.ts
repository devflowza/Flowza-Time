import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { isValidTimezone } from '@flowza/shared';
import { withContext } from '@flowza/database';
import type { ScheduledTask } from '../../scheduler.js';
import { enqueueNormalizeRaw } from './common.js';
import { DAY_CLOSE_JOB_TYPE, dayCloseDedupeKey } from './day-close.js';

/**
 * Attendance scheduler ticks (enqueue-only).
 *  - normalize-sweep: the normaliser is normally triggered by ingestion; this sweep catches raw rows that arrived without a
 *    trigger (push endpoints, imports, crashed jobs) — a platform scan on the whitelisted `attendance_raw_transactions`
 *    (select only) followed by one deduped NORMALIZE_RAW per organisation.
 *  - attendance.day-close: once per organisation per LOCAL day (dedupe key carries the organisation's local date), one
 *    ATTENDANCE_DAY_CLOSE job that marks unexplained days older than the grace period UNEXCUSED and, where enabled, charges
 *    the pay effect (HR portal Prompt 3). The tick is hourly so every timezone gets its job shortly after local midnight; the
 *    job itself reads the settings in the organisation's system context.
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
        const zone = isValidTimezone(o.timezone) ? o.timezone : 'UTC';
        const localDate = DateTime.fromJSDate(now).setZone(zone).toISODate() ?? now.toISOString().slice(0, 10);
        await d.queue.enqueue({ queue: 'processing', jobType: DAY_CLOSE_JOB_TYPE, organizationId: o.id, payload: { organizationId: o.id, asOf: localDate }, priority: 2, dedupeKey: dayCloseDedupeKey(o.id, localDate), lockTimeoutSeconds: 1_800, maxAttempts: 2 });
        enqueued += 1;
      }
      return { organizations: orgs.length, enqueued };
    },
  },
];
