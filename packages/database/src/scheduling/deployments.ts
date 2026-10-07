import { sql } from 'kysely';
import { DateTime } from 'luxon';
import type { Trx } from '../context.js';
import type { JobQueue } from '../queue.js';
import { createSyncJob } from '../sync-jobs.js';

/*
 * Temporary branch deployments (Enterprise, `employee_branch_deployments`, docs/enterprise/plan.md §4.7): the ACCESS-REMOVAL
 * half, shared by the worker's daily sweep (a deployment that ended) and the API's cancel (a cancelled deployment that had
 * enrolled the employee). Security first: a person sent to another branch for a while must not keep opening that branch's
 * doors / punching on its terminals once the deployment is over — whatever the module state (switching
 * `advanced_scheduling` off never leaves access behind).
 *
 * `cleanupBranchDeployment` runs in the organisation's SYSTEM context (worker job, or the API's system step inside the
 * caller's transaction — everything commits or rolls back together):
 *   1. the deployment's own enrolment job is stopped where it has not run yet (queued / retrying items cancelled), so an
 *      enrolment can never land AFTER the removal; an item that is running right now cannot be stopped — the deployment is
 *      then left "not cleaned up" and the next daily sweep repeats the removal once it has finished;
 *   2. the host branch's terminals on which the employee has a device row with `desired = true` (anything not already
 *      REMOVED / REMOVING) — EXCEPT when the host branch is the employee's current branch (a transfer in the meantime) or the
 *      host of another deployment of the employee that has not ended (active or scheduled: its enrolment already ran) —
 *      become `desired = false` (no reconciliation puts them back), and each gets a DELETE_EMPLOYEE item for the row's own
 *      PIN in ONE sync job; a switched-off terminal or one whose provider cannot delete users is reported as skipped;
 *   3. `cleanup_job_id` / `cleaned_up_at` are stamped.
 * The caller audits (the API as the acting user, the worker as SYSTEM).
 */

export const BRANCH_DEPLOYMENT_CLEANUP_JOB_TYPE = 'BRANCH_DEPLOYMENT_CLEANUP';
/** One sweep per organisation and LOCAL date (the queue dedupes pending jobs only, so the key carries the date). */
export const branchDeploymentCleanupDedupeKey = (organizationId: string, localDate: string): string => `branch-deployment-cleanup:${organizationId}:${localDate}`;

/** Device rows that are not terminal users (the portal's virtual device, the Flowza Finance connector). */
const NOT_TERMINALS = ['self_service', 'flowza_finance'];
const OPEN_ITEM_STATUSES = ['PENDING', 'QUEUED', 'RETRYING'] as const;

export type DeploymentRemovalSkip = 'device_inactive' | 'delete_unsupported';
export interface DeploymentCleanupResult {
  deploymentId: string;
  /** The DELETE_EMPLOYEE sync job (a sync_jobs id), null when nothing had to be removed. */
  syncJobId: string | null;
  removals: Array<{ deviceId: string; deviceUserId: string }>;
  skipped: Array<{ deviceId: string; deviceUserId: string; reason: DeploymentRemovalSkip }>;
  /** Enrolment items stopped before they ran. */
  cancelledEnrolItems: number;
  /** Enrolment items running right now: the deployment stays "not cleaned up" for the next sweep. */
  inFlightEnrolItems: number;
  /** True when `cleaned_up_at` was stamped (false: already done, or an enrolment item is still running). */
  cleanedUp: boolean;
  /** Why nothing was removed from the host's terminals, when that was decided up front. */
  kept: 'current_branch' | 'other_deployment' | null;
}

function isoDate(v: Date | string): string {
  if (typeof v === 'string') return v.slice(0, 10);
  return DateTime.fromJSDate(v).toISODate() ?? v.toISOString().slice(0, 10);
}
function jsonObject(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') { try { return jsonObject(JSON.parse(v)); } catch { return {}; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Stop the enrolment items that have not run yet. Returns how many were stopped and how many are running right now. */
async function stopEnrolment(trx: Trx, enrolJobId: string): Promise<{ cancelled: number; inFlight: number }> {
  const open = await trx.selectFrom('syncJobItems').select(['id', 'queueJobId', 'status']).where('syncJobId', '=', enrolJobId).where('status', 'in', [...OPEN_ITEM_STATUSES, 'RUNNING']).execute();
  const cancelledIds: string[] = [];
  let inFlight = 0;
  for (const it of open) {
    if (it.status === 'RUNNING') { inFlight += 1; continue; }
    if (it.queueJobId === null) { cancelledIds.push(it.id); continue; }
    // jobs.cancel only removes a PENDING queue job; a job a worker has just picked up keeps running
    const res = await sql<{ ok: boolean }>`select jobs.cancel(${String(it.queueJobId)}::bigint) as ok`.execute(trx);
    if (res.rows[0]?.ok) cancelledIds.push(it.id); else inFlight += 1;
  }
  if (cancelledIds.length > 0) {
    await trx.updateTable('syncJobItems').set({ status: 'CANCELLED', finishedAt: new Date() }).where('id', 'in', cancelledIds).execute();
    const remaining = await trx.selectFrom('syncJobItems').select((eb) => eb.fn.countAll<string>().as('n')).where('syncJobId', '=', enrolJobId).where('status', 'in', [...OPEN_ITEM_STATUSES, 'RUNNING']).executeTakeFirst();
    const left = Number(remaining?.n ?? 0);
    const job = await trx.selectFrom('syncJobs').select(['status', 'summary']).where('id', '=', enrolJobId).executeTakeFirst();
    const finished = job && ['SUCCESS', 'FAILED', 'CANCELLED', 'PARTIAL_SUCCESS'].includes(job.status);
    await trx.updateTable('syncJobs').set({
      itemsPending: left,
      ...(left === 0 && !finished ? { status: 'CANCELLED' as const, finishedAt: new Date() } : {}),
      summary: JSON.stringify({ ...jsonObject(job?.summary), cancelledItems: cancelledIds.length, cancelledBecause: 'deployment_ended' }),
    }).where('id', '=', enrolJobId).execute();
  }
  return { cancelled: cancelledIds.length, inFlight };
}

export interface CleanupBranchDeploymentInput {
  organizationId: string;
  deploymentId: string;
  /** Today in the organisation's timezone (decides which other deployments have not ended). */
  today: string;
  trigger: 'SYSTEM' | 'SCHEDULED' | 'MANUAL';
  requestedBy?: string | null;
  correlationId: string;
  cause: 'ended' | 'cancelled';
}

/** Take the employee off the host branch's terminals for one deployment (see the module comment). System context. */
export async function cleanupBranchDeployment(trx: Trx, queue: JobQueue, input: CleanupBranchDeploymentInput): Promise<DeploymentCleanupResult> {
  const { organizationId: orgId } = input;
  const dep = await trx.selectFrom('employeeBranchDeployments').select(['id', 'employeeId', 'branchId', 'enrolJobId', 'cleanedUpAt', 'cleanupJobId'])
    .where('organizationId', '=', orgId).where('id', '=', input.deploymentId).forUpdate().executeTakeFirst();
  const none: DeploymentCleanupResult = { deploymentId: input.deploymentId, syncJobId: null, removals: [], skipped: [], cancelledEnrolItems: 0, inFlightEnrolItems: 0, cleanedUp: false, kept: null };
  if (!dep || dep.cleanedUpAt !== null) return none;

  const enrol = dep.enrolJobId ? await stopEnrolment(trx, dep.enrolJobId) : { cancelled: 0, inFlight: 0 };

  const [employee, others] = await Promise.all([
    trx.selectFrom('employees').select(['branchId']).where('organizationId', '=', orgId).where('id', '=', dep.employeeId).executeTakeFirst(),
    trx.selectFrom('employeeBranchDeployments').select(['branchId']).where('organizationId', '=', orgId).where('employeeId', '=', dep.employeeId)
      .where('id', '!=', dep.id).where('cancelledAt', 'is', null).where('toDate', '>=', sql<Date>`${input.today}::date`).execute(),
  ]);
  let kept: DeploymentCleanupResult['kept'] = null;
  if (employee?.branchId === dep.branchId) kept = 'current_branch';
  else if (others.some((o) => o.branchId === dep.branchId)) kept = 'other_deployment';

  const removals: DeploymentCleanupResult['removals'] = [];
  const skipped: DeploymentCleanupResult['skipped'] = [];
  const items: Array<{ deviceId: string; employeeId: string; branchId: string; operation: 'DELETE_EMPLOYEE'; options: { deviceUserId: string } }> = [];
  if (kept === null) {
    const rows = await trx.selectFrom('deviceEmployeeStates as s')
      .innerJoin('devices as d', (j) => j.onRef('d.id', '=', 's.deviceId').onRef('d.organizationId', '=', 's.organizationId'))
      .select(['s.id', 's.deviceId', 's.deviceUserId', 'd.branchId', 'd.status', 'd.capabilities'])
      .where('s.organizationId', '=', orgId).where('s.employeeId', '=', dep.employeeId).where('s.desired', '=', true)
      .where('s.syncStatus', 'not in', ['REMOVED', 'REMOVING']).where('d.branchId', '=', dep.branchId).where('d.providerKey', 'not in', NOT_TERMINALS)
      .orderBy('s.deviceId').orderBy('s.deviceUserId').execute();
    if (rows.length > 0) await trx.updateTable('deviceEmployeeStates').set({ desired: false }).where('id', 'in', rows.map((r) => r.id)).execute();
    for (const r of rows) {
      if (r.status !== 'active') skipped.push({ deviceId: r.deviceId, deviceUserId: r.deviceUserId, reason: 'device_inactive' });
      else if (jsonObject(r.capabilities)['employeeDelete'] !== true) skipped.push({ deviceId: r.deviceId, deviceUserId: r.deviceUserId, reason: 'delete_unsupported' });
      else {
        removals.push({ deviceId: r.deviceId, deviceUserId: r.deviceUserId });
        items.push({ deviceId: r.deviceId, employeeId: dep.employeeId, branchId: r.branchId, operation: 'DELETE_EMPLOYEE', options: { deviceUserId: r.deviceUserId } });
      }
    }
  }
  const job = items.length > 0
    ? await createSyncJob(trx, queue, {
      organizationId: orgId, jobType: 'DELETE_EMPLOYEE', trigger: input.trigger, branchId: dep.branchId, requestedBy: input.requestedBy ?? null, correlationId: input.correlationId, priority: 6,
      scope: { deploymentId: dep.id, employeeIds: [dep.employeeId], cause: `deployment_${input.cause}` }, items,
    })
    : null;
  const cleanedUp = enrol.inFlight === 0;
  await trx.updateTable('employeeBranchDeployments').set({
    ...(job ? { cleanupJobId: job.syncJobId } : {}),
    ...(cleanedUp ? { cleanedUpAt: new Date() } : {}),
  }).where('id', '=', dep.id).execute();
  return { deploymentId: dep.id, syncJobId: job?.syncJobId ?? null, removals, skipped, cancelledEnrolItems: enrol.cancelled, inFlightEnrolItems: enrol.inFlight, cleanedUp, kept };
}

/**
 * Deployments of the organisation whose access has to go: ended before `today` (not cancelled), or cancelled after enrolling,
 * and not cleaned up yet. Oldest first, at most `limit`. System context.
 */
export async function deploymentsDueForCleanup(trx: Trx, organizationId: string, today: string, limit = 500): Promise<Array<{ id: string; employeeId: string; branchId: string; toDate: string; cancelled: boolean }>> {
  const rows = await trx.selectFrom('employeeBranchDeployments').select(['id', 'employeeId', 'branchId', 'toDate', 'cancelledAt'])
    .where('organizationId', '=', organizationId).where('cleanedUpAt', 'is', null)
    .where((eb) => eb.or([
      eb.and([eb('cancelledAt', 'is', null), eb('toDate', '<', sql<Date>`${today}::date`)]),
      eb.and([eb('cancelledAt', 'is not', null), eb('enrolJobId', 'is not', null)]),
    ]))
    .orderBy('toDate', 'asc').orderBy('id', 'asc').limit(limit).execute();
  return rows.map((r) => ({ id: r.id, employeeId: r.employeeId, branchId: r.branchId, toDate: isoDate(r.toDate), cancelled: r.cancelledAt !== null }));
}
