import { sql } from 'kysely';
import { REPORT_DELIVERY_QUEUE } from '@flowza/contracts';
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
 *
 * `enqueued` counts NEW jobs only (review minor 15b): an occurrence whose job is still pending or running from an earlier tick
 * is counted as `alreadyQueued` and not enqueued again (the queue's dedupe covers pending jobs only; a running one would have
 * produced a second job that the handler then skipped as stale).
 */
export async function scheduleDueReports(deps: Pick<WorkerDeps, 'db' | 'queue' | 'now' | 'log'>, opts: { cap?: number } = {}): Promise<{ due: number; enqueued: number; alreadyQueued: number }> {
  const now = deps.now();
  const keyOf = (s: DueSchedule) => `report-schedule:${s.id}:${(s.nextRunAt instanceof Date ? s.nextRunAt : new Date(s.nextRunAt)).toISOString()}`;
  const { due, inFlight } = await withContext(deps.db, { kind: 'platform' }, async (trx) => {
    const rows = (await sql<DueSchedule>`
      select s.id, s.organization_id as "organizationId", s.next_run_at as "nextRunAt"
      from public.report_schedules s join public.organizations o on o.id = s.organization_id
      where s.is_active and s.next_run_at is not null and s.next_run_at <= ${now} and o.status in ('active', 'trial')
      order by s.next_run_at, s.id
      limit ${opts.cap ?? REPORT_SCHEDULE_ADMISSION_CAP}`.execute(trx)).rows;
    const keys = rows.map(keyOf);
    // occurrences already waiting in (or being run by) the queue — jobs.queue carries no tenant data (flowza_system reads it)
    const busy = keys.length ? (await sql<{ dedupeKey: string }>`
      select dedupe_key as "dedupeKey" from jobs.queue where dedupe_key = any(${keys}::text[]) and status in ('pending', 'running')`.execute(trx)).rows.map((r) => r.dedupeKey) : [];
    return { due: rows, inFlight: new Set(busy) };
  });
  let enqueued = 0;
  let alreadyQueued = 0;
  for (const s of due) {
    const scheduledFor = (s.nextRunAt instanceof Date ? s.nextRunAt : new Date(s.nextRunAt)).toISOString();
    const dedupeKey = keyOf(s);
    if (inFlight.has(dedupeKey)) { alreadyQueued += 1; continue; }
    try {
      await deps.queue.enqueue({
        queue: REPORT_DELIVERY_QUEUE, jobType: REPORT_DELIVERY_JOB_TYPE, organizationId: s.organizationId,
        payload: { organizationId: s.organizationId, mode: 'schedule', scheduleId: s.id, scheduledFor },
        priority: 4, dedupeKey, maxAttempts: 3,
      });
      enqueued += 1;
    } catch (err) {
      deps.log.error(event('schedule_report_run_failed', { organizationId: s.organizationId, scheduleId: s.id, err: (err as Error).message }));
    }
  }
  return { due: due.length, enqueued, alreadyQueued };
}

export const reportTasks: ScheduledTask[] = [
  { name: 'reports.schedules', everyMs: REPORT_SCHEDULE_TICK_MS, run: (d) => scheduleDueReports(d) },
];
