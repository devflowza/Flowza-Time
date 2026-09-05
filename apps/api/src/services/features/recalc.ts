import type { Trx } from '@flowza/database';
import type { ApiDeps } from '../../deps.js';
import type { Actor } from '../../lib/service.js';
import { enqueueJob } from '../../lib/jobs.js';
import { systemStep } from './context.js';

export interface RecalcScope { fromDate: string; toDate: string; branchId?: string | null; departmentId?: string | null; employeeIds?: string[] | null; reason: string }

/**
 * Create an `attendance_recalculation_requests` row and enqueue RECALCULATE_RANGE ({ organizationId, requestId } on the
 * `processing` queue) in the caller's transaction. Runs as a system step because the requester (shift.assign, leave.manage,
 * holiday.manage…) does not necessarily hold `attendance.recalculate`; the explicit permission for the *triggering* change
 * was checked by the caller. Returns null when the range is empty (toDate < fromDate).
 */
export async function enqueueRecalculation(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, scope: RecalcScope): Promise<{ requestId: string; jobId: string } | null> {
  if (scope.toDate < scope.fromDate) return null;
  return systemStep(trx, orgId, async (t) => {
    const row = await t.insertInto('attendanceRecalculationRequests').values({
      organizationId: orgId, fromDate: scope.fromDate, toDate: scope.toDate, branchId: scope.branchId ?? null, departmentId: scope.departmentId ?? null,
      employeeIds: scope.employeeIds && scope.employeeIds.length ? scope.employeeIds : null, reason: scope.reason.slice(0, 500), requestedBy: actor.userId, status: 'QUEUED',
    }).returning('id').executeTakeFirstOrThrow();
    const jobId = await enqueueJob(deps.queue, t, { queue: 'processing', jobType: 'RECALCULATE_RANGE', organizationId: orgId, payload: { organizationId: orgId, requestId: row.id }, correlationId: actor.requestId, priority: 4 });
    await t.updateTable('attendanceRecalculationRequests').set({ queueJobId: jobId }).where('id', '=', row.id).execute();
    return { requestId: row.id, jobId };
  });
}

/** Today's date in the organisation's timezone (used to decide whether a change touches the past). */
export async function orgToday(trx: Trx, orgId: string): Promise<string> {
  const org = await trx.selectFrom('organizations').select('timezone').where('id', '=', orgId).executeTakeFirst();
  const tz = org?.timezone ?? 'UTC';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
