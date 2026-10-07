import type { z } from 'zod';
import { FLOWZA_FINANCE_PROVIDER_KEY, SELF_SERVICE_PROVIDER_KEY, type BranchDeploymentDto, type BranchDeploymentInput, type BranchDeploymentStatus, type branchDeploymentListQuerySchema } from '@flowza/contracts';
import { cleanupBranchDeployment, effectiveBranchIdOn, type DeploymentCleanupResult, type Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { requireBranchAccess, requirePermission } from '../../lib/authorize.js';
import { type Actor, audit, runUser, withSystemScope } from '../../lib/service.js';
import { isoDate, isoDateOrNull, isoDateTime, isoDateTimeOrNull, jsonObject } from '../../lib/mappers.js';
import { pageOf, toCount } from '../../lib/pagination.js';
import { systemStep } from '../features/context.js';
import { orgToday } from '../features/recalc.js';
import { createSyncJob } from '../features/sync-jobs.js';
import { dv } from '../features/sql-helpers.js';
import { daysBetween } from './common.js';

/*
 * Temporary deployment of an employee to another branch (Enterprise, `employee_branch_deployments`, docs/enterprise/plan.md
 * §4.7). A deployment is NOT a transfer: the attendance calendar, timezone, payroll and data scope stay with the home branch.
 * It does three things:
 *   - web / mobile check-in accepts the host branch's geofences while it covers the day (portal/punch.service.ts);
 *   - on request, the employee is enrolled on the host branch's terminals (ONE sync job of PUSH_EMPLOYEE items, a sync_jobs
 *     id the UI opens at /sync/:id);
 *   - after the end date the daily worker sweep takes them off those terminals again (packages/database
 *     cleanupBranchDeployment); a cancelled deployment that had enrolled them is cleaned up at once.
 *
 * Who: `employee.view` reads (RLS: readers of the host OR the home branch, and the employee); creating and cancelling need
 * `employee.update` with access to BOTH the employee's home branch (on the first day) and the host branch. The table is
 * written by the system step only (no INSERT / UPDATE for `authenticated`), after these checks. Every write is audited
 * (`employee.deployment_*`). Status is derived from the dates in the organisation's timezone and the cancellation.
 */

type ListQuery = z.infer<typeof branchDeploymentListQuerySchema>;
type DeploymentRow = {
  id: string; employeeId: string; homeBranchId: string | null; branchId: string; fromDate: Date | string; toDate: Date | string; reason: string; enrolOnDevices: boolean;
  enrolJobId: string | null; cleanupJobId: string | null; cleanedUpAt: Date | null; cancelledAt: Date | null; cancelReason: string | null; createdAt: Date;
};
const COLUMNS = ['id', 'employeeId', 'homeBranchId', 'branchId', 'fromDate', 'toDate', 'reason', 'enrolOnDevices', 'enrolJobId', 'cleanupJobId', 'cleanedUpAt', 'cancelledAt', 'cancelReason', 'createdAt'] as const;
/** Terminal-less device rows: the portal's virtual device and the Flowza Finance connector are never enrolment targets. */
const NOT_TERMINALS = [SELF_SERVICE_PROVIDER_KEY, FLOWZA_FINANCE_PROVIDER_KEY];

export function deploymentStatus(row: { fromDate: string; toDate: string; cancelled: boolean }, today: string): BranchDeploymentStatus {
  if (row.cancelled) return 'cancelled';
  if (today < row.fromDate) return 'scheduled';
  if (today > row.toDate) return 'ended';
  return 'active';
}

/** Names of the employees and branches of visible rows (read in system scope: the rows themselves passed RLS). */
async function namesFor(trx: Trx, orgId: string, rows: readonly DeploymentRow[]) {
  if (rows.length === 0) return { employees: new Map<string, { displayName: string; employeeNumber: string }>(), branches: new Map<string, string>() };
  return withSystemScope(trx, orgId, async (t) => {
    const employeeIds = [...new Set(rows.map((r) => r.employeeId))];
    const branchIds = [...new Set(rows.flatMap((r) => [r.branchId, r.homeBranchId]).filter((b): b is string => !!b))];
    const [emps, branches] = await Promise.all([
      t.selectFrom('employees').select(['id', 'displayName', 'employeeNumber']).where('organizationId', '=', orgId).where('id', 'in', employeeIds).execute(),
      branchIds.length ? t.selectFrom('branches').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', branchIds).execute() : Promise.resolve([]),
    ]);
    return { employees: new Map(emps.map((e) => [e.id, { displayName: e.displayName, employeeNumber: String(e.employeeNumber) }])), branches: new Map(branches.map((b) => [b.id, b.name])) };
  });
}

async function toDtos(trx: Trx, orgId: string, rows: readonly DeploymentRow[], today: string): Promise<BranchDeploymentDto[]> {
  const names = await namesFor(trx, orgId, rows);
  return rows.map((r) => {
    const fromDate = isoDate(r.fromDate); const toDate = isoDate(r.toDate);
    const emp = names.employees.get(r.employeeId);
    return {
      id: r.id, employeeId: r.employeeId, employeeName: emp?.displayName ?? null, employeeNumber: emp?.employeeNumber ?? null,
      homeBranchId: r.homeBranchId, homeBranchName: r.homeBranchId ? names.branches.get(r.homeBranchId) ?? null : null, branchId: r.branchId, branchName: names.branches.get(r.branchId) ?? null,
      fromDate, toDate, reason: r.reason, status: deploymentStatus({ fromDate, toDate, cancelled: r.cancelledAt !== null }, today), enrolOnDevices: r.enrolOnDevices,
      enrolJobId: r.enrolJobId, cleanupJobId: r.cleanupJobId, cleanedUpAt: isoDateTimeOrNull(r.cleanedUpAt), cancelledAt: isoDateTimeOrNull(r.cancelledAt), cancelReason: r.cancelReason, createdAt: isoDateTime(r.createdAt),
    };
  });
}

export async function listDeployments(deps: ApiDeps, actor: Actor, orgId: string, q: ListQuery): Promise<{ data: BranchDeploymentDto[]; total: number }> {
  const grant = requirePermission(actor.principal, orgId, 'employee.view');
  if (q.branchId) requireBranchAccess(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    const today = await orgToday(trx, orgId);
    // RLS: host-branch readers, home-branch readers and the employee; the filters narrow that set
    let base = trx.selectFrom('employeeBranchDeployments').where('organizationId', '=', orgId);
    if (q.branchId) base = base.where((eb) => eb.or([eb('branchId', '=', q.branchId!), eb('homeBranchId', '=', q.branchId!)]));
    if (q.employeeId) base = base.where('employeeId', '=', q.employeeId);
    if (q.activeOn) base = base.where('cancelledAt', 'is', null).where('fromDate', '<=', dv(q.activeOn)).where('toDate', '>=', dv(q.activeOn));
    switch (q.status) {
      case 'cancelled': base = base.where('cancelledAt', 'is not', null); break;
      case 'scheduled': base = base.where('cancelledAt', 'is', null).where('fromDate', '>', dv(today)); break;
      case 'active': base = base.where('cancelledAt', 'is', null).where('fromDate', '<=', dv(today)).where('toDate', '>=', dv(today)); break;
      case 'ended': base = base.where('cancelledAt', 'is', null).where('toDate', '<', dv(today)); break;
      default: break;
    }
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = (await base.select(COLUMNS).orderBy('fromDate', 'desc').orderBy('createdAt', 'desc').orderBy('id').limit(page.pageSize).offset(page.offset).execute()) as DeploymentRow[];
    return { data: await toDtos(trx, orgId, rows, today), total };
  });
}

/**
 * The employee as the deployment rules see them, read in the organisation's system scope (the caller's RLS may hide the
 * employment history row of another branch, and the home branch decides the authorisation): the home branch is the one in
 * force on `onDate` (employment history), else the employee record's.
 */
async function loadEmployeeFor(trx: Trx, orgId: string, employeeId: string, onDate: string) {
  return withSystemScope(trx, orgId, async (t) => {
    const e = await t.selectFrom('employees').select(['id', 'branchId', 'employmentStatus', 'joiningDate', 'exitDate', 'deletedAt']).where('organizationId', '=', orgId).where('id', '=', employeeId).executeTakeFirst();
    if (!e || e.deletedAt) return null;
    const home = (await effectiveBranchIdOn(t, orgId, employeeId, onDate)) ?? e.branchId;
    return { ...e, homeBranchId: home, joiningDate: isoDate(e.joiningDate), exitDate: isoDateOrNull(e.exitDate) };
  });
}

/** Both ends of a deployment must be inside the caller's scope (rule of the slice: employee.update on home AND host). */
function requireBothBranches(grant: MembershipGrant, homeBranchId: string | null, hostBranchId: string): void {
  requireBranchAccess(grant, hostBranchId);
  if (homeBranchId) requireBranchAccess(grant, homeBranchId);
  else if (!grant.allBranches) throw errors.forbidden('The employee\'s home branch is unknown; only members with access to every branch can change this deployment.');
}

/** The row in the organisation's system scope (the table is system-written); `lock` = FOR UPDATE, for a change. */
async function loadDeploymentSystem(trx: Trx, orgId: string, id: string, opts: { lock?: boolean } = {}): Promise<DeploymentRow | undefined> {
  return systemStep(trx, orgId, async (t) => {
    let q = t.selectFrom('employeeBranchDeployments').select(COLUMNS).where('organizationId', '=', orgId).where('id', '=', id);
    if (opts.lock) q = q.forUpdate();
    return (await q.executeTakeFirst()) as DeploymentRow | undefined;
  });
}

export async function createDeployment(deps: ApiDeps, actor: Actor, orgId: string, input: BranchDeploymentInput): Promise<BranchDeploymentDto> {
  const grant = requirePermission(actor.principal, orgId, 'employee.update');
  return runUser(deps.db, actor, async (trx) => {
    const today = await orgToday(trx, orgId);
    if (input.toDate < input.fromDate) throw errors.validation('The last day cannot be before the first day.', { issues: [{ path: 'toDate', message: 'Before the first day' }] });
    if (daysBetween(input.fromDate, input.toDate) > 366) throw errors.validation('A deployment lasts at most a year; a longer move is a transfer.', { issues: [{ path: 'toDate', message: 'More than 367 days' }] });
    if (input.toDate < today) throw errors.validation('This deployment would already have ended.', { issues: [{ path: 'toDate', message: 'In the past' }] });
    const emp = await loadEmployeeFor(trx, orgId, input.employeeId, input.fromDate);
    if (!emp) throw errors.notFound('Employee', input.employeeId);
    requireBothBranches(grant, emp.homeBranchId, input.branchId);
    const host = await withSystemScope(trx, orgId, (t) => t.selectFrom('branches').select(['id', 'name']).where('organizationId', '=', orgId).where('id', '=', input.branchId).executeTakeFirst());
    if (!host) throw errors.validation('Branch not found.', { issues: [{ path: 'branchId', message: 'Unknown branch' }] });
    if (host.id === emp.homeBranchId) throw errors.validation('The employee already works at this branch.', { issues: [{ path: 'branchId', message: 'The employee\'s own branch' }] });
    // active over the whole range: employed (not left or suspended), joined by the first day, not gone before the last
    if (!['active', 'on_leave'].includes(String(emp.employmentStatus)) || emp.joiningDate > input.fromDate || (emp.exitDate !== null && emp.exitDate < input.toDate)) {
      throw errors.validation('The employee is not employed over the whole deployment.', { issues: [{ path: 'fromDate', message: 'Outside the employment' }], employmentStatus: emp.employmentStatus, joiningDate: emp.joiningDate, exitDate: emp.exitDate });
    }
    // overlap with another (not cancelled) deployment of the employee — found in system scope: it may be in a branch the caller
    // cannot read (only its id is returned); the exclusion constraint is the backstop
    const clash = await withSystemScope(trx, orgId, (t) => t.selectFrom('employeeBranchDeployments').select('id').where('organizationId', '=', orgId).where('employeeId', '=', emp.id)
      .where('cancelledAt', 'is', null).where('fromDate', '<=', dv(input.toDate)).where('toDate', '>=', dv(input.fromDate)).executeTakeFirst());
    if (clash) throw errors.conflict('The employee is already deployed on some of these days.', { conflictingId: clash.id });

    const id = await systemStep(trx, orgId, async (t) => (await t.insertInto('employeeBranchDeployments').values({
      organizationId: orgId, employeeId: emp.id, homeBranchId: emp.homeBranchId, branchId: host.id, fromDate: input.fromDate, toDate: input.toDate, reason: input.reason,
      enrolOnDevices: input.enrolOnDevices, createdBy: actor.userId,
    }).returning('id').executeTakeFirstOrThrow()).id);

    let enrol: { jobId: string; devices: number } | null = null;
    if (input.enrolOnDevices) {
      // the host branch's active terminals that can receive employees (the caller was authorised for that branch above;
      // device rows are read in system scope as the caller need not hold device.view)
      const devices = await withSystemScope(trx, orgId, (t) => t.selectFrom('devices').select(['id', 'capabilities']).where('organizationId', '=', orgId).where('branchId', '=', host.id)
        .where('status', '=', 'active').where('providerKey', 'not in', NOT_TERMINALS).orderBy('name').execute());
      const targets = devices.filter((d) => jsonObject(d.capabilities)['employeePush'] === true);
      if (targets.length > 0) {
        const job = await createSyncJob(deps, trx, {
          organizationId: orgId, jobType: 'PUSH_EMPLOYEES', trigger: 'MANUAL', scope: { deploymentId: id, employeeIds: [emp.id], branchId: host.id, cause: 'deployment' }, branchId: host.id,
          requestedBy: actor.userId, correlationId: actor.requestId, priority: 6,
          items: targets.map((d) => ({ deviceId: d.id, employeeId: emp.id, branchId: host.id, operation: 'PUSH_EMPLOYEE' as const })),
        });
        await systemStep(trx, orgId, (t) => t.updateTable('employeeBranchDeployments').set({ enrolJobId: job.id }).where('organizationId', '=', orgId).where('id', '=', id).execute());
        enrol = { jobId: job.id, devices: targets.length };
      }
    }
    await audit(trx, actor, orgId, 'employee.deployment_created', 'employee', {
      entityId: emp.id, branchId: host.id,
      newValue: { deploymentId: id, homeBranchId: emp.homeBranchId, branchId: host.id, fromDate: input.fromDate, toDate: input.toDate, reason: input.reason, enrolOnDevices: input.enrolOnDevices, enrolJobId: enrol?.jobId ?? null, devices: enrol?.devices ?? 0 },
    });
    const row = (await loadDeploymentSystem(trx, orgId, id))!;
    return (await toDtos(trx, orgId, [row], today))[0]!;
  });
}

export async function cancelDeployment(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: { reason: string }): Promise<BranchDeploymentDto> {
  const grant = requirePermission(actor.principal, orgId, 'employee.update');
  return runUser(deps.db, actor, async (trx) => {
    const today = await orgToday(trx, orgId);
    // visible to the caller (RLS: host or home branch reader), then authorised on both branches
    const visible = await trx.selectFrom('employeeBranchDeployments').select('id').where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!visible) throw errors.notFound('Deployment', id);
    const row = (await loadDeploymentSystem(trx, orgId, id, { lock: true }))!;
    requireBothBranches(grant, row.homeBranchId, row.branchId);
    const status = deploymentStatus({ fromDate: isoDate(row.fromDate), toDate: isoDate(row.toDate), cancelled: row.cancelledAt !== null }, today);
    if (status === 'cancelled') throw errors.invalidState('The deployment is already cancelled.');
    if (status === 'ended') throw errors.invalidState('The deployment has ended; the daily clean-up takes the employee off the branch\'s terminals.');
    await systemStep(trx, orgId, (t) => t.updateTable('employeeBranchDeployments').set({ cancelledAt: new Date(), cancelledBy: actor.userId, cancelReason: input.reason }).where('organizationId', '=', orgId).where('id', '=', id).execute());
    // access removal at once for a deployment that had enrolled the employee (started or not: the enrolment ran at creation)
    let cleanup: DeploymentCleanupResult | null = null;
    if (row.enrolJobId) {
      cleanup = await systemStep(trx, orgId, (t) => cleanupBranchDeployment(t, deps.queue, { organizationId: orgId, deploymentId: id, today, trigger: 'MANUAL', requestedBy: actor.userId, correlationId: actor.requestId, cause: 'cancelled' }));
    }
    await audit(trx, actor, orgId, 'employee.deployment_cancelled', 'employee', {
      entityId: row.employeeId, branchId: row.branchId, reason: input.reason,
      oldValue: { status }, newValue: { deploymentId: id, status: 'cancelled', cleanup: cleanup ? { syncJobId: cleanup.syncJobId, removals: cleanup.removals, skipped: cleanup.skipped, cancelledEnrolItems: cleanup.cancelledEnrolItems, inFlightEnrolItems: cleanup.inFlightEnrolItems, kept: cleanup.kept } : null },
    });
    const after = (await loadDeploymentSystem(trx, orgId, id))!;
    return (await toDtos(trx, orgId, [after], today))[0]!;
  });
}
