import type { Trx } from '@flowza/database';
import type { ApiDeps } from '../../deps.js';
import type { Actor } from '../../lib/service.js';
import { enqueueJob } from '../../lib/jobs.js';
import { systemStep } from './context.js';

export interface RecalcScope { fromDate: string; toDate: string; branchId?: string | null; departmentId?: string | null; employeeIds?: string[] | null; reason: string }

/** `attendance_recalculation_requests_range` allows at most 366 days per request; longer ranges are split into consecutive chunks. */
export const MAX_RECALC_DAYS = 366;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
/** Consecutive [from, to] chunks of at most MAX_RECALC_DAYS days each (inclusive bounds). */
export function recalcChunks(fromDate: string, toDate: string): Array<{ fromDate: string; toDate: string }> {
  const out: Array<{ fromDate: string; toDate: string }> = [];
  let from = fromDate;
  while (daysBetween(from, toDate) > MAX_RECALC_DAYS) { const to = addDays(from, MAX_RECALC_DAYS); out.push({ fromDate: from, toDate: to }); from = addDays(to, 1); }
  out.push({ fromDate: from, toDate });
  return out;
}

/**
 * Create `attendance_recalculation_requests` row(s) and enqueue ONE RECALCULATE_RANGE ({ organizationId, requestId } on the
 * `processing` queue) per row in the caller's transaction — one row for the whole range, several only when the range exceeds the
 * 366-day limit of a request (a shift edited years after its first assignment). Runs as a system step because the requester
 * (shift.assign, leave.manage, holiday.manage…) does not necessarily hold `attendance.recalculate`; the explicit permission for
 * the *triggering* change was checked by the caller. Returns null when the range is empty (toDate < fromDate); `requestId`/`jobId`
 * are those of the first chunk, `requestIds`/`jobIds` list them all.
 */
export async function enqueueRecalculation(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, scope: RecalcScope): Promise<{ requestId: string; jobId: string; requestIds: string[]; jobIds: string[] } | null> {
  if (scope.toDate < scope.fromDate) return null;
  return systemStep(trx, orgId, async (t) => {
    const requestIds: string[] = []; const jobIds: string[] = [];
    for (const chunk of recalcChunks(scope.fromDate, scope.toDate)) {
      const row = await t.insertInto('attendanceRecalculationRequests').values({
        organizationId: orgId, fromDate: chunk.fromDate, toDate: chunk.toDate, branchId: scope.branchId ?? null, departmentId: scope.departmentId ?? null,
        employeeIds: scope.employeeIds && scope.employeeIds.length ? scope.employeeIds : null, reason: scope.reason.slice(0, 500), requestedBy: actor.userId, status: 'QUEUED',
      }).returning('id').executeTakeFirstOrThrow();
      const jobId = await enqueueJob(deps.queue, t, { queue: 'processing', jobType: 'RECALCULATE_RANGE', organizationId: orgId, payload: { organizationId: orgId, requestId: row.id }, correlationId: actor.requestId, priority: 4 });
      await t.updateTable('attendanceRecalculationRequests').set({ queueJobId: jobId }).where('id', '=', row.id).execute();
      requestIds.push(row.id); jobIds.push(jobId);
    }
    return { requestId: requestIds[0]!, jobId: jobIds[0]!, requestIds, jobIds };
  });
}

/**
 * A location change that can change which attendance policy applies to people (docs/locations.md §3) — a work location changed,
 * a branch, region or place moved in the tree — recomputes TODAY for them, when the organisation has a policy scoped to a
 * location (otherwise nothing can change). Past days keep the values they were computed with: the work location is not
 * effective-dated. Future days compute when they arrive.
 */
export async function recalcTodayForLocationChange(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, who: { employeeIds?: readonly string[]; branchIds?: readonly string[] }, reason: string): Promise<void> {
  const employeeIds = [...new Set(who.employeeIds ?? [])];
  const branchIds = [...new Set(who.branchIds ?? [])];
  if (employeeIds.length === 0 && branchIds.length === 0) return;
  const scoped = await systemStep(trx, orgId, (t) => t.selectFrom('attendanceRuleSets').select('id').where('organizationId', '=', orgId).where('locationId', 'is not', null).limit(1).executeTakeFirst());
  if (!scoped) return;
  const today = await orgToday(trx, orgId);
  for (let i = 0; i < employeeIds.length; i += 1000) await enqueueRecalculation(deps, trx, actor, orgId, { fromDate: today, toDate: today, employeeIds: employeeIds.slice(i, i + 1000), reason });
  for (const branchId of branchIds) await enqueueRecalculation(deps, trx, actor, orgId, { fromDate: today, toDate: today, branchId, reason });
}

/** Today's date in the organisation's timezone (used to decide whether a change touches the past). */
export async function orgToday(trx: Trx, orgId: string): Promise<string> {
  const org = await trx.selectFrom('organizations').select('timezone').where('id', '=', orgId).executeTakeFirst();
  const tz = org?.timezone ?? 'UTC';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
