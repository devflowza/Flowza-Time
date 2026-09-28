import { sql } from 'kysely';
import { withContext } from '@flowza/database';
import { event } from '@flowza/shared';
import type { WorkerDeps } from '../deps.js';
import type { ScheduledTask } from '../scheduler.js';
import { REPORT_DELIVERY_JOB_TYPE } from '../handlers/reports/deliveries.js';

/** Due schedules admitted per tick (the next tick takes the rest; one job per schedule occurrence). */
export const REPORT_SCHEDULE_ADMISSION_CAP = 200;
export const REPORT_SCHEDULE_TICK_MS = 5 * 60_000;

interface DueSchedule { id: string; organizationId: string; nextRunAt: Date }

/**
 * reports.schedules (HR portal Prompt 6a): every active report schedule whose `next_run_at` has passed, in an active / trial
 * organisation, becomes ONE `RUN_REPORT_SCHEDULE` job carrying the occurrence it saw (a platform-context scan of the
 * whitelisted `report_schedules` — ids and times only). The dedupe key is the occurrence, so a slow queue never admits the same
 * occurrence twice; the handler re-checks the occurrence under a row lock, computes the period in the organisation's zone,
 * generates per recipient and advances `next_run_at` in its own transaction. Enqueue-only, like every scheduler task.
 */
export async function scheduleDueReports(deps: Pick<WorkerDeps, 'db' | 'queue' | 'now' | 'log'>, opts: { cap?: number } = {}): Promise<{ due: number; enqueued: number }> {
  const now = deps.now();
  const due = await withContext(deps.db, { kind: 'platform' }, async (trx) => (await sql<DueSchedule>`
    select s.id, s.organization_id as "organizationId", s.next_run_at as "nextRunAt"
    from public.report_schedules s join public.organizations o on o.id = s.organization_id
    where s.is_active and s.next_run_at is not null and s.next_run_at <= ${now} and o.status in ('active', 'trial')
    order by s.next_run_at, s.id
    limit ${opts.cap ?? REPORT_SCHEDULE_ADMISSION_CAP}`.execute(trx)).rows);
  let enqueued = 0;
  for (const s of due) {
    const scheduledFor = (s.nextRunAt instanceof Date ? s.nextRunAt : new Date(s.nextRunAt)).toISOString();
    try {
      await deps.queue.enqueue({
        queue: 'reports', jobType: REPORT_DELIVERY_JOB_TYPE, organizationId: s.organizationId,
        payload: { organizationId: s.organizationId, mode: 'schedule', scheduleId: s.id, scheduledFor },
        priority: 4, dedupeKey: `report-schedule:${s.id}:${scheduledFor}`, maxAttempts: 3,
      });
      enqueued += 1;
    } catch (err) {
      deps.log.error(event('schedule_report_run_failed', { organizationId: s.organizationId, scheduleId: s.id, err: (err as Error).message }));
    }
  }
  return { due: due.length, enqueued };
}

export const reportTasks: ScheduledTask[] = [
  { name: 'reports.schedules', everyMs: REPORT_SCHEDULE_TICK_MS, run: (d) => scheduleDueReports(d) },
];
