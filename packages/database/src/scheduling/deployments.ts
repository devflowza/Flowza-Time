import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { deploymentStarted, hostLocalTime } from '@flowza/domain';
import { addDays, isValidTimezone } from '@flowza/shared';
import type { Trx } from '../context.js';
import type { JobQueue } from '../queue.js';
import { createSyncJob } from '../sync-jobs.js';

/*
 * Temporary branch deployments (Enterprise, `employee_branch_deployments`, docs/enterprise/plan.md §4.7): the TERMINAL half,
 * shared by the worker's daily sweep and the API (create, cancel). Security first: a person sent to another branch for a
 * while is on that branch's terminals only while the deployment runs, and only on the terminals the deployment gave them.
 * Every date is the HOST branch's local date (packages/domain deployment-window).
 *
 * `enrolBranchDeployment` — the deployment's first day has arrived at the host (fromDate ≤ host today ≤ toDate), it asks for
 * the terminals (`enrol_on_devices`), is not cancelled, has no enrolment job yet, and the employee is still employed (active
 * or on leave, not archived, not past their exit date — a leaver is never pushed):
 *   - the host branch's active terminals that can receive employees, MINUS those on which the employee already has a device
 *     row with `desired = true` (enrolled by another path — an explicit device sync, a PIN mapping, an earlier deployment
 *     whose terminals were handed over): those are neither pushed again nor recorded, so the clean-up never takes them away;
 *   - ONE sync job of PUSH_EMPLOYEE items for the rest; `enrol_job_id` is stamped and the terminals are ADDED to
 *     `enrolled_device_ids`. Nothing to push → nothing is stamped and the next daily sweep looks again (a terminal added to
 *     the host meanwhile, an enrolment by another path removed meanwhile).
 *   Called by the API at creation when the deployment starts today (or has started), else by the sweep on the first day.
 *
 * `cleanupBranchDeployment` — the deployment ended (host today ≥ toDate + 2: the morning after the last day still belongs to
 * it) or was cancelled:
 *   1. its own enrolment job is stopped where it has not run yet (queued / retrying items cancelled), so an enrolment can never
 *      land AFTER the removal; an item that is running right now cannot be stopped — the deployment is then left "not cleaned
 *      up" and the next daily sweep repeats the removal once it has finished;
 *   2. only the terminals of `enrolled_device_ids` are considered (a deployment that enrolled nothing removes nothing, an
 *      enrolment by another path is never touched; a row enrolled before the column existed falls back to its enrolment
 *      job's PUSH_EMPLOYEE items), and they are KEPT when
 *        - the host branch is now the employee's own branch (a transfer in the meantime), or
 *        - another deployment of the employee to the same host that asks for the terminals covers the host's today
 *          (started, not cancelled, `enrol_on_devices`, its own terminals not yet due): the terminal ids are HANDED OVER to
 *          that deployment's `enrolled_device_ids`, so its own end or cancellation removes them (a scheduled deployment
 *          that has not started does not keep them — it enrols again on its first day — nor does one without terminals);
 *      otherwise the employee's rows on those terminals with `desired = true` (except a terminal that now belongs to the
 *      employee's own branch) become `desired = false` (no reconciliation puts them back), and each gets a DELETE_EMPLOYEE
 *      item for the row's own PIN in ONE sync job; a switched-off terminal or one whose provider cannot delete users is
 *      reported as skipped;
 *   3. `cleanup_job_id` / `cleaned_up_at` are stamped.
 * Both run in the organisation's SYSTEM context (worker job, or the API's system step inside the caller's transaction —
 * everything commits or rolls back together). The caller audits (the API as the acting user, the worker as SYSTEM).
 */

export const BRANCH_DEPLOYMENT_CLEANUP_JOB_TYPE = 'BRANCH_DEPLOYMENT_CLEANUP';
/** One sweep per organisation and LOCAL date (the queue dedupes pending jobs only, so the key carries the date). */
export const branchDeploymentCleanupDedupeKey = (organizationId: string, localDate: string): string => `branch-deployment-cleanup:${organizationId}:${localDate}`;

/** Device rows that are not terminal users (the portal's virtual device, the Flowza Finance connector). */
const NOT_TERMINALS = ['self_service', 'flowza_finance'];
/** Employment statuses whose holders are put on terminals (the worker's PUSH_EMPLOYEE rule). */
const ENROLLABLE_EMPLOYMENT = ['active', 'on_leave'];
const OPEN_ITEM_STATUSES = ['PENDING', 'QUEUED', 'RETRYING'] as const;

function jsonObject(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') { try { return jsonObject(JSON.parse(v)); } catch { return {}; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function isoDate(v: Date | string): string {
  if (typeof v === 'string') return v.slice(0, 10);
  return DateTime.fromJSDate(v).toISODate() ?? v.toISOString().slice(0, 10);
}
const validZone = (zone: string | null | undefined): zone is string => !!zone && isValidTimezone(zone);

// ----- host-local dates ------------------------------------------------------------------------------------------------------

export interface BranchLocalDates {
  /** Today in the organisation's timezone (the fallback for a branch without a usable zone). */
  orgToday: string;
  /** Today in each branch's timezone. */
  byBranch: Map<string, string>;
}

/** Today at `at` in the organisation's and in every branch's timezone (Luxon). System context. */
export async function branchLocalDates(trx: Trx, organizationId: string, at: Date): Promise<BranchLocalDates> {
  const org = await trx.selectFrom('organizations').select('timezone').where('id', '=', organizationId).executeTakeFirst();
  const branches = await trx.selectFrom('branches').select(['id', 'timezone']).where('organizationId', '=', organizationId).execute();
  const orgZone = validZone(org?.timezone) ? org.timezone : 'UTC';
  return { orgToday: hostLocalTime(at, orgZone).date, byBranch: new Map(branches.map((b) => [b.id, hostLocalTime(at, validZone(b.timezone) ? b.timezone : orgZone).date])) };
}

/** Today at `at` in one branch's timezone (the organisation's when the branch has none). System context. */
export async function branchToday(trx: Trx, organizationId: string, branchId: string, at: Date): Promise<string> {
  const row = await trx.selectFrom('branches as b').innerJoin('organizations as o', 'o.id', 'b.organizationId').select(['b.timezone as branchZone', 'o.timezone as orgZone'])
    .where('b.organizationId', '=', organizationId).where('b.id', '=', branchId).executeTakeFirst();
  const zone = validZone(row?.branchZone) ? row.branchZone : validZone(row?.orgZone) ? row.orgZone : 'UTC';
  return hostLocalTime(at, zone).date;
}

// ----- enrolment -------------------------------------------------------------------------------------------------------------

export type DeploymentEnrolSkip = 'not_found' | 'closed' | 'not_requested' | 'already_enrolled' | 'not_started' | 'ended' | 'employee_inactive';
export interface DeploymentEnrolResult {
  deploymentId: string;
  /** The PUSH_EMPLOYEES sync job (a sync_jobs id: /sync/:id renders it), null when nothing was pushed. */
  syncJobId: string | null;
  /** Host terminals the employee is pushed to — added to `enrolled_device_ids`. */
  enrolled: string[];
  /** Host terminals on which the employee was already wanted (another path): neither pushed nor recorded. */
  alreadyEnrolled: string[];
  /** Why nothing was looked at (null: the terminals were considered, even if none needed a push). */
  skipped: DeploymentEnrolSkip | null;
}

export interface EnrolBranchDeploymentInput {
  organizationId: string;
  deploymentId: string;
  /** Today in the HOST branch's timezone. */
  hostToday: string;
  trigger: 'SYSTEM' | 'SCHEDULED' | 'MANUAL';
  requestedBy?: string | null;
  correlationId: string;
}

/** Put the employee on the host branch's terminals for one deployment that has started (see the module comment). System context. */
export async function enrolBranchDeployment(trx: Trx, queue: JobQueue, input: EnrolBranchDeploymentInput): Promise<DeploymentEnrolResult> {
  const { organizationId: orgId } = input;
  const out = (skipped: DeploymentEnrolSkip | null, extra: Partial<DeploymentEnrolResult> = {}): DeploymentEnrolResult => ({ deploymentId: input.deploymentId, syncJobId: null, enrolled: [], alreadyEnrolled: [], skipped, ...extra });
  const dep = await trx.selectFrom('employeeBranchDeployments').select(['id', 'employeeId', 'branchId', 'fromDate', 'toDate', 'enrolOnDevices', 'enrolJobId', 'cancelledAt', 'cleanedUpAt'])
    .where('organizationId', '=', orgId).where('id', '=', input.deploymentId).forUpdate().executeTakeFirst();
  if (!dep) return out('not_found');
  if (dep.cancelledAt !== null || dep.cleanedUpAt !== null) return out('closed');
  if (!dep.enrolOnDevices) return out('not_requested');
  if (dep.enrolJobId !== null) return out('already_enrolled');
  const range = { fromDate: isoDate(dep.fromDate), toDate: isoDate(dep.toDate) };
  if (!deploymentStarted(range, input.hostToday)) return out(input.hostToday < range.fromDate ? 'not_started' : 'ended');
  // still employed on the day (the enrolment may run weeks after the deployment was created: a leaver is never pushed)
  const employee = await trx.selectFrom('employees').select(['employmentStatus', 'exitDate', 'deletedAt']).where('organizationId', '=', orgId).where('id', '=', dep.employeeId).executeTakeFirst();
  if (!employee || employee.deletedAt !== null || !ENROLLABLE_EMPLOYMENT.includes(String(employee.employmentStatus)) || (employee.exitDate !== null && isoDate(employee.exitDate) < input.hostToday)) return out('employee_inactive');

  const devices = await trx.selectFrom('devices').select(['id', 'capabilities']).where('organizationId', '=', orgId).where('branchId', '=', dep.branchId)
    .where('status', '=', 'active').where('providerKey', 'not in', NOT_TERMINALS).orderBy('name').orderBy('id').execute();
  const capable = devices.filter((d) => jsonObject(d.capabilities)['employeePush'] === true);
  if (capable.length === 0) return out(null);
  const wanted = new Set((await trx.selectFrom('deviceEmployeeStates').select('deviceId').where('organizationId', '=', orgId).where('employeeId', '=', dep.employeeId)
    .where('desired', '=', true).where('deviceId', 'in', capable.map((d) => d.id)).execute()).map((r) => r.deviceId));
  const alreadyEnrolled = capable.filter((d) => wanted.has(d.id)).map((d) => d.id);
  const targets = capable.filter((d) => !wanted.has(d.id)).map((d) => d.id);
  if (targets.length === 0) return out(null, { alreadyEnrolled });
  const job = await createSyncJob(trx, queue, {
    organizationId: orgId, jobType: 'PUSH_EMPLOYEES', trigger: input.trigger, branchId: dep.branchId, requestedBy: input.requestedBy ?? null, correlationId: input.correlationId, priority: 6, maxAttempts: 6,
    scope: { deploymentId: dep.id, employeeIds: [dep.employeeId], branchId: dep.branchId, cause: 'deployment', options: {} },
    items: targets.map((deviceId) => ({ deviceId, employeeId: dep.employeeId, branchId: dep.branchId, operation: 'PUSH_EMPLOYEE' as const })),
  });
  await trx.updateTable('employeeBranchDeployments').set({
    enrolJobId: job.syncJobId,
    enrolledDeviceIds: sql<string[]>`(select coalesce(array_agg(distinct x order by x), '{}'::uuid[]) from unnest(enrolled_device_ids || ${targets}::uuid[]) as x)`,
  }).where('organizationId', '=', orgId).where('id', '=', dep.id).execute();
  return out(null, { syncJobId: job.syncJobId, enrolled: targets, alreadyEnrolled });
}

// ----- clean-up --------------------------------------------------------------------------------------------------------------

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
  /** The terminals this deployment had enrolled the employee on (`enrolled_device_ids`): the only ones it may take away. */
  enrolledDevices: number;
  /** Why nothing was removed from those terminals, when that was decided up front. */
  kept: 'current_branch' | 'other_deployment' | null;
  /** kept = other_deployment: the deployment that took the terminals over. */
  handedOverTo: string | null;
}

/** Stop the enrolment items that have not run yet. Returns how many were stopped and how many are running right now. */
async function stopEnrolment(trx: Trx, enrolJobId: string, cause: 'ended' | 'cancelled'): Promise<{ cancelled: number; inFlight: number }> {
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
      summary: JSON.stringify({ ...jsonObject(job?.summary), cancelledItems: cancelledIds.length, cancelledBecause: `deployment_${cause}` }),
    }).where('id', '=', enrolJobId).execute();
  }
  return { cancelled: cancelledIds.length, inFlight };
}

export interface CleanupBranchDeploymentInput {
  organizationId: string;
  deploymentId: string;
  /** Today in the HOST branch's timezone (decides which other deployment to the same host still covers it). */
  hostToday: string;
  trigger: 'SYSTEM' | 'SCHEDULED' | 'MANUAL';
  requestedBy?: string | null;
  correlationId: string;
  cause: 'ended' | 'cancelled';
}

/** Take the employee off the terminals one deployment gave them (see the module comment). System context. */
export async function cleanupBranchDeployment(trx: Trx, queue: JobQueue, input: CleanupBranchDeploymentInput): Promise<DeploymentCleanupResult> {
  const { organizationId: orgId } = input;
  const dep = await trx.selectFrom('employeeBranchDeployments').select(['id', 'employeeId', 'branchId', 'enrolJobId', 'enrolledDeviceIds', 'cleanedUpAt', 'cleanupJobId'])
    .where('organizationId', '=', orgId).where('id', '=', input.deploymentId).forUpdate().executeTakeFirst();
  const none: DeploymentCleanupResult = { deploymentId: input.deploymentId, syncJobId: null, removals: [], skipped: [], cancelledEnrolItems: 0, inFlightEnrolItems: 0, cleanedUp: false, enrolledDevices: 0, kept: null, handedOverTo: null };
  if (!dep || dep.cleanedUpAt !== null) return none;

  const enrol = dep.enrolJobId ? await stopEnrolment(trx, dep.enrolJobId, input.cause) : { cancelled: 0, inFlight: 0 };
  let enrolled = [...new Set(dep.enrolledDeviceIds ?? [])];
  // a deployment enrolled before `enrolled_device_ids` existed (migration 20261007000200) has an enrolment job but no ids
  // (the current code stamps both together): its job's PUSH_EMPLOYEE items name the terminals it put the employee on
  if (enrolled.length === 0 && dep.enrolJobId) {
    const pushed = await trx.selectFrom('syncJobItems').select('deviceId').where('organizationId', '=', orgId).where('syncJobId', '=', dep.enrolJobId).where('operation', '=', 'PUSH_EMPLOYEE').execute();
    enrolled = [...new Set(pushed.map((r) => r.deviceId).filter((d): d is string => d !== null))];
  }

  let kept: DeploymentCleanupResult['kept'] = null;
  let handedOverTo: string | null = null;
  const removals: DeploymentCleanupResult['removals'] = [];
  const skipped: DeploymentCleanupResult['skipped'] = [];
  const items: Array<{ deviceId: string; employeeId: string; branchId: string | null; operation: 'DELETE_EMPLOYEE'; options: { deviceUserId: string } }> = [];
  if (enrolled.length > 0) {
    const employee = await trx.selectFrom('employees').select(['branchId']).where('organizationId', '=', orgId).where('id', '=', dep.employeeId).executeTakeFirst();
    if (employee?.branchId === dep.branchId) kept = 'current_branch';
    else {
      // another deployment of the employee to the same host that wants the terminals and whose terminals are not due yet
      // (started — the morning after its last day included); the latest one, which runs longest
      const keeper = await trx.selectFrom('employeeBranchDeployments').select('id')
        .where('organizationId', '=', orgId).where('employeeId', '=', dep.employeeId).where('branchId', '=', dep.branchId).where('id', '!=', dep.id)
        .where('cancelledAt', 'is', null).where('cleanedUpAt', 'is', null).where('enrolOnDevices', '=', true)
        .where('fromDate', '<=', sql<Date>`${input.hostToday}::date`).where('toDate', '>=', sql<Date>`${addDays(input.hostToday, -1)}::date`)
        .orderBy('fromDate', 'desc').limit(1).forUpdate().executeTakeFirst();
      if (keeper) {
        kept = 'other_deployment';
        handedOverTo = keeper.id;
        await trx.updateTable('employeeBranchDeployments')
          .set({ enrolledDeviceIds: sql<string[]>`(select coalesce(array_agg(distinct x order by x), '{}'::uuid[]) from unnest(enrolled_device_ids || ${enrolled}::uuid[]) as x)` })
          .where('organizationId', '=', orgId).where('id', '=', keeper.id).execute();
      }
    }
    if (kept === null) {
      let q = trx.selectFrom('deviceEmployeeStates as s')
        .innerJoin('devices as d', (j) => j.onRef('d.id', '=', 's.deviceId').onRef('d.organizationId', '=', 's.organizationId'))
        .select(['s.id', 's.deviceId', 's.deviceUserId', 'd.branchId', 'd.status', 'd.capabilities'])
        .where('s.organizationId', '=', orgId).where('s.employeeId', '=', dep.employeeId).where('s.desired', '=', true)
        .where('s.syncStatus', 'not in', ['REMOVED', 'REMOVING']).where('s.deviceId', 'in', enrolled).where('d.providerKey', 'not in', NOT_TERMINALS);
      // a terminal moved to the employee's own branch since is theirs now
      if (employee?.branchId) q = q.where(sql<boolean>`d.branch_id is distinct from ${employee.branchId}::uuid`);
      const rows = await q.orderBy('s.deviceId').orderBy('s.deviceUserId').execute();
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
  }
  const job = items.length > 0
    ? await createSyncJob(trx, queue, {
      organizationId: orgId, jobType: 'DELETE_EMPLOYEE', trigger: input.trigger, branchId: dep.branchId, requestedBy: input.requestedBy ?? null, correlationId: input.correlationId, priority: 6,
      scope: { deploymentId: dep.id, employeeIds: [dep.employeeId], cause: `deployment_${input.cause}`, options: {} }, items,
    })
    : null;
  const cleanedUp = enrol.inFlight === 0;
  await trx.updateTable('employeeBranchDeployments').set({
    ...(job ? { cleanupJobId: job.syncJobId } : {}),
    ...(cleanedUp ? { cleanedUpAt: new Date() } : {}),
  }).where('organizationId', '=', orgId).where('id', '=', dep.id).execute();
  return { deploymentId: dep.id, syncJobId: job?.syncJobId ?? null, removals, skipped, cancelledEnrolItems: enrol.cancelled, inFlightEnrolItems: enrol.inFlight, cleanedUp, enrolledDevices: enrolled.length, kept, handedOverTo };
}

// ----- what the daily sweep has to do ------------------------------------------------------------------------------------------

export interface DueDeployment {
  id: string; employeeId: string; branchId: string; fromDate: string; toDate: string; cancelled: boolean;
  /** Today in the host branch's timezone. */
  hostToday: string;
}
export interface DueQueryOptions {
  limit?: number;
  /** Keyset: continue after this row (the sort date — toDate for the clean-up, fromDate for the enrolment — and the id). */
  after?: { date: string; id: string } | null;
}

function zoneArrays(dates: BranchLocalDates): { ids: string[]; days: string[] } {
  const ids = [...dates.byBranch.keys()];
  return { ids, days: ids.map((id) => dates.byBranch.get(id)!) };
}

/**
 * Deployments of the organisation whose terminal access has to go and that are not cleaned up yet: cancelled ones (whatever
 * they enrolled — the clean-up decides), and ended ones whose host branch's local date is at least toDate + 2. Ordered by
 * (toDate, id), at most `limit`, after the keyset. System context.
 */
export async function deploymentsDueForCleanup(trx: Trx, organizationId: string, dates: BranchLocalDates, opts: DueQueryOptions = {}): Promise<DueDeployment[]> {
  const { ids, days } = zoneArrays(dates);
  const after = opts.after ?? null;
  const res = await sql<DueDeployment>`
    with t as (select * from unnest(${ids}::uuid[], ${days}::date[]) as z(branch_id, today))
    select d.id, d.employee_id as "employeeId", d.branch_id as "branchId", to_char(d.from_date, 'YYYY-MM-DD') as "fromDate", to_char(d.to_date, 'YYYY-MM-DD') as "toDate",
           d.cancelled_at is not null as cancelled, to_char(coalesce(t.today, ${dates.orgToday}::date), 'YYYY-MM-DD') as "hostToday"
    from public.employee_branch_deployments d
    left join t on t.branch_id = d.branch_id
    where d.organization_id = ${organizationId}::uuid and d.cleaned_up_at is null
      and (d.cancelled_at is not null or d.to_date + 1 < coalesce(t.today, ${dates.orgToday}::date))
      and (${after?.date ?? null}::date is null or (d.to_date, d.id) > (${after?.date ?? null}::date, ${after?.id ?? null}::uuid))
    order by d.to_date, d.id
    limit ${opts.limit ?? 500}`.execute(trx);
  return res.rows;
}

/**
 * Deployments whose first day has arrived at the host branch and that still have to enrol the employee on its terminals:
 * not cancelled, `enrol_on_devices`, no enrolment job, fromDate ≤ host today ≤ toDate. Ordered by (fromDate, id). System context.
 */
export async function deploymentsDueForEnrolment(trx: Trx, organizationId: string, dates: BranchLocalDates, opts: DueQueryOptions = {}): Promise<DueDeployment[]> {
  const { ids, days } = zoneArrays(dates);
  const after = opts.after ?? null;
  const res = await sql<DueDeployment>`
    with t as (select * from unnest(${ids}::uuid[], ${days}::date[]) as z(branch_id, today))
    select d.id, d.employee_id as "employeeId", d.branch_id as "branchId", to_char(d.from_date, 'YYYY-MM-DD') as "fromDate", to_char(d.to_date, 'YYYY-MM-DD') as "toDate",
           false as cancelled, to_char(coalesce(t.today, ${dates.orgToday}::date), 'YYYY-MM-DD') as "hostToday"
    from public.employee_branch_deployments d
    left join t on t.branch_id = d.branch_id
    where d.organization_id = ${organizationId}::uuid and d.cancelled_at is null and d.cleaned_up_at is null and d.enrol_on_devices and d.enrol_job_id is null
      and d.from_date <= coalesce(t.today, ${dates.orgToday}::date) and d.to_date >= coalesce(t.today, ${dates.orgToday}::date)
      and (${after?.date ?? null}::date is null or (d.from_date, d.id) > (${after?.date ?? null}::date, ${after?.id ?? null}::uuid))
    order by d.from_date, d.id
    limit ${opts.limit ?? 500}`.execute(trx);
  return res.rows;
}
