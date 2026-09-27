import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { withContext } from '@flowza/database';
import { event } from '@flowza/shared';
import type { ScheduledTask } from '../../scheduler.js';
import type { WorkerDeps } from '../../deps.js';

interface OrgRow { id: string; timezone: string | null; reports: unknown }

/**
 * statements-monthly-sweep (enqueue-only, hourly): for every organisation that enabled monthly statements, once its
 * local calendar reaches the configured send day, enqueue ISSUE_MONTHLY_STATEMENTS for the previous month. `>=` rather
 * than `===` so a worker outage on the send day is recovered on the next tick; the dedupe key holds one job per
 * organisation per month while it is queued, and the handler itself skips employees whose statement already exists, so
 * a re-enqueue after queue pruning cannot duplicate. Reads organizations + organization_settings only (platform
 * whitelist), and never an employee's data.
 */
export async function sweepMonthlyStatements(deps: WorkerDeps): Promise<{ organizations: number; enqueued: number }> {
  const now = deps.now();
  const orgs = await withContext(deps.db, { kind: 'platform' }, async (trx) => {
    const res = await sql<OrgRow>`
      select o.id, o.timezone, s.reports
      from public.organizations o
      join public.organization_settings s on s.organization_id = o.id
      where coalesce(s.reports #>> '{monthlyStatements,enabled}', 'false') = 'true'
        and o.status not in ('suspended', 'closed')`.execute(trx);
    return res.rows;
  });

  let enqueued = 0;
  for (const org of orgs) {
    const reports = (org.reports ?? {}) as { monthlyStatements?: { sendDay?: number } };
    const sendDay = clampDay(reports.monthlyStatements?.sendDay);
    const local = DateTime.fromJSDate(now, { zone: org.timezone || 'UTC' });
    if (!local.isValid || local.day < sendDay) continue;
    const month = local.minus({ months: 1 }).toFormat('yyyy-MM');
    await deps.queue.enqueue({
      queue: 'processing',
      jobType: 'ISSUE_MONTHLY_STATEMENTS',
      organizationId: org.id,
      payload: { organizationId: org.id, month },
      priority: 5,
      dedupeKey: `statements:${org.id}:${month}`,
    });
    enqueued++;
  }
  if (orgs.length) deps.log.debug(event('statements_sweep', { organizations: orgs.length, enqueued }));
  return { organizations: orgs.length, enqueued };
}

function clampDay(day: unknown): number {
  const n = typeof day === 'number' && Number.isFinite(day) ? Math.trunc(day) : 3;
  return Math.min(28, Math.max(1, n));
}

export const statementTasks: ScheduledTask[] = [
  { name: 'statements-monthly-sweep', everyMs: 3_600_000, run: (deps) => sweepMonthlyStatements(deps) },
];
