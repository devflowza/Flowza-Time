import { ACTIVE_TIME_OFF_STATUSES, type HourAllowanceDto, type SelfTimeOffDto, type SelfTimeOffRequestInput, type TimeOffRequestDto, type TimeOffRequestInput, type TimeOffRequestListQuery, type TimeOffStatus, type TimeOffUsageDto, type WithTimeOffRecalc } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, hasPermission, requireBranchAccess, requireMembership, requirePermission } from '../../lib/authorize.js';
import { type Actor, audit, runUser, withSystemScope } from '../../lib/service.js';
import { isoDate } from '../../lib/mappers.js';
import { pageOf, toCount } from '../../lib/pagination.js';
import { dv } from '../features/sql-helpers.js';
import { systemStep } from '../features/context.js';
import { cancelForEntity, submit } from '../approvals/engine.js';
import { loadLeaveEmployee, lockEmployeeLeave, type LeaveEmployee } from '../leave/common.js';
import { REQUEST_COLUMNS, checkDayLock, evaluateTimeOff, loadTimeOffTypes, recalcTimeOffDay, requestQuery, toRequestDtos, todayOf, typeAppliesTo, type RequestRow, type TimeOffWarning } from './common.js';
import { ownAllowances } from './allowances.service.js';

/**
 * Short leave requests (migration 20261019000310). The employee asks for a window in the portal (/me/time-off: leave.request),
 * HR records one on the employee's behalf (/time-off-requests: leave.manage) — approved at once unless a SHORT_LEAVE workflow
 * applies, and never for HR's own short leave (routed to the leave.approve holders like a portal request). Rows are written in
 * the organisation's system step after these checks (the table is system-write-only); the approval engine decides the rest
 * through the SHORT_LEAVE hook (hooks/short-leave.ts). An approved window changes the attendance of its day: approving it,
 * recording it approved or cancelling it after approval recomputes that day when it is not in the future.
 */

// ----- the employee (portal) --------------------------------------------------------------------------------------------------

interface SelfScope { grant: MembershipGrant; employeeId: string }
function selfScope(actor: Actor, orgId: string): SelfScope {
  const grant = requireMembership(actor.principal, orgId);
  if (!grant.employeeId) throw errors.forbidden('Your account is not linked to an employee record in this organisation.');
  return { grant, employeeId: grant.employeeId };
}
const mayRequest = (s: SelfScope) => hasPermission(s.grant, 'leave.request');
function requireRequest(s: SelfScope): void {
  if (!mayRequest(s)) throw errors.forbidden('Missing permission: leave.request.');
}
async function ownEmployee(trx: Trx, orgId: string, scope: SelfScope): Promise<LeaveEmployee> {
  const emp = await loadLeaveEmployee(trx, orgId, scope.employeeId);
  if (!emp) throw errors.notFound('Employee record');
  return emp;
}
async function ownRows(trx: Trx, orgId: string, employeeId: string, filter: { id?: string; from?: string; to?: string }): Promise<RequestRow[]> {
  let q = requestQuery(trx, orgId).select(REQUEST_COLUMNS).where('r.employeeId', '=', employeeId);
  if (filter.id) q = q.where('r.id', '=', filter.id);
  if (filter.from) q = q.where('r.requestDate', '>=', dv(filter.from));
  if (filter.to) q = q.where('r.requestDate', '<=', dv(filter.to));
  return (await q.orderBy('r.requestDate', 'desc').orderBy('r.startTime', 'desc').execute()) as RequestRow[];
}
async function ownRow(trx: Trx, orgId: string, employeeId: string, id: string): Promise<RequestRow> {
  const [row] = await ownRows(trx, orgId, employeeId, { id });
  if (!row) throw errors.notFound('Short leave request', id);
  return row;
}
const monthBounds = (month: string): { from: string; to: string } => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
};

/** GET /me/time-off?month — the types the employee may ask for, the month's use of each, the month's requests and the reduced hours. */
export async function getSelfTimeOff(deps: ApiDeps, actor: Actor, orgId: string, q: { month?: string }): Promise<SelfTimeOffDto> {
  const scope = selfScope(actor, orgId);
  if (!mayRequest(scope) && !hasPermission(scope.grant, 'leave.view')) throw errors.forbidden('Missing permission: leave.request.');
  return runUser(deps.db, actor, async (trx) => {
    const emp = await ownEmployee(trx, orgId, scope);
    const today = await todayOf(trx, orgId);
    const month = q.month ?? today.slice(0, 7);
    const types = await withSystemScope(trx, orgId, (t) => loadTimeOffTypes(t, orgId));
    const offered = types.filter((t) => t.status === 'active' && t.portalVisible && typeAppliesTo(t, emp.gender));
    const range = monthBounds(month);
    const rows = await ownRows(trx, orgId, emp.id, range);
    const active = rows.filter((r) => (ACTIVE_TIME_OFF_STATUSES as readonly string[]).includes(r.status));
    const usage: TimeOffUsageDto[] = offered.map((t) => {
      const mine = active.filter((r) => r.timeOffTypeId === t.id);
      return { typeId: t.id, month, usedMinutes: mine.reduce((n, r) => n + r.minutes, 0), usedCount: mine.length, quotaMinutes: t.monthlyQuotaMinutes, quotaCount: t.monthlyQuotaCount };
    });
    const allowances: HourAllowanceDto[] = (await ownAllowances(trx, orgId, emp.id, today)).filter((a) => a.validTo === null || a.validTo >= today);
    return { month, types: offered, usage, requests: await toRequestDtos(trx, orgId, rows, { userId: actor.userId, employeeId: emp.id, mayRequest: mayRequest(scope) }), allowances };
  });
}

/**
 * POST /me/time-off — ask for a short leave: validated (type offered to the employee, length, monthly quota, overlaps, locked
 * period), stored PENDING and routed by the approval engine (SHORT_LEAVE, units = minutes): the org's workflow, else the
 * leave.approve holders in reach of the employee — never the employee. A type that needs no approval is approved at once.
 */
export async function requestTimeOff(deps: ApiDeps, actor: Actor, orgId: string, input: SelfTimeOffRequestInput): Promise<WithTimeOffRecalc<TimeOffRequestDto>> {
  const scope = selfScope(actor, orgId);
  requireRequest(scope);
  return runUser(deps.db, actor, async (trx) => {
    const emp = await ownEmployee(trx, orgId, scope);
    const lock = await checkDayLock(trx, orgId, emp.branchId, input.date, scope.grant);
    // one writer of an employee's leave / short leave at a time: a double click meets the overlap 409 below
    await lockEmployeeLeave(trx, emp.id);
    const ev = await evaluateTimeOff(trx, orgId, { employee: emp, typeId: input.typeId, date: input.date, startTime: input.startTime, endTime: input.endTime, asHr: false });
    const row = await systemStep(trx, orgId, (t) => t.insertInto('timeOffRequests').values({
      organizationId: orgId, employeeId: emp.id, branchId: emp.branchId, timeOffTypeId: ev.type.id, requestDate: input.date, startTime: input.startTime, endTime: input.endTime,
      minutes: ev.minutes, reason: input.reason, status: 'PENDING', createdBy: actor.userId,
    }).returning('id').executeTakeFirstOrThrow());
    await audit(trx, actor, orgId, 'time_off.requested', 'time_off_request', { entityId: row.id, branchId: emp.branchId, newValue: { ...input, minutes: ev.minutes, typeCode: ev.type.code }, ...(lock.lockedOverride ? { reason: 'locked period (attendance.lock_period)' } : {}) });
    const submitted = await submit(deps, trx, actor, orgId, {
      entityType: 'SHORT_LEAVE', entityId: row.id, employeeId: emp.id, branchId: emp.branchId, departmentId: emp.departmentId, units: ev.minutes, requestedBy: actor.userId,
      noWorkflow: { kind: 'PERMISSION', permission: 'leave.approve' }, notRequired: !ev.type.requiresApproval,
    });
    await systemStep(trx, orgId, (t) => t.updateTable('timeOffRequests').set({ approvalRequestId: submitted.requestId }).where('organizationId', '=', orgId).where('id', '=', row.id).execute());
    const recalc = submitted.autoApproved ? await recalcTimeOffDay(deps, trx, actor, orgId, { date: input.date, employeeId: emp.id, branchId: emp.branchId }, 'short leave approved (no approval required)') : null;
    const [dto] = await toRequestDtos(trx, orgId, [await ownRow(trx, orgId, emp.id, row.id)], { userId: actor.userId, employeeId: emp.id, mayRequest: true });
    return { ...dto!, recalculationJobId: recalc?.jobId ?? null };
  });
}

/**
 * POST /me/time-off/:id/withdraw — the employee withdraws their own PENDING request (the reason reaches the approvers); an
 * approved one is cancelled by HR, and one HR filed is HR's to cancel. Withdrawing twice is not an error.
 */
export async function withdrawTimeOff(deps: ApiDeps, actor: Actor, orgId: string, id: string, reason: string): Promise<TimeOffRequestDto & { alreadyWithdrawn?: boolean }> {
  const scope = selfScope(actor, orgId);
  requireRequest(scope);
  return runUser(deps.db, actor, async (trx) => {
    const emp = await ownEmployee(trx, orgId, scope);
    const before = await ownRow(trx, orgId, emp.id, id);
    const view = { userId: actor.userId, employeeId: emp.id, mayRequest: true };
    if (before.status === 'APPROVED') throw errors.invalidState('Approved short leave can only be cancelled by HR. Contact HR to cancel it.');
    if (before.createdBy !== actor.userId) throw errors.forbidden('HR filed this short leave for you; ask HR to cancel it.');
    if (before.status === 'CANCELLED') return { ...(await toRequestDtos(trx, orgId, [before], view))[0]!, alreadyWithdrawn: true };
    if (before.status !== 'PENDING') throw errors.invalidState(`Only a pending request can be withdrawn (current: ${before.status}).`);
    const lock = await checkDayLock(trx, orgId, emp.branchId, isoDate(before.requestDate), scope.grant);
    const why = reason.trim();
    const res = await systemStep(trx, orgId, (t) => t.updateTable('timeOffRequests').set({ status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: actor.userId, cancelReason: why })
      .where('organizationId', '=', orgId).where('id', '=', id).where('employeeId', '=', emp.id).where('status', '=', 'PENDING').executeTakeFirst());
    if (Number(res.numUpdatedRows) !== 1) throw errors.conflict('The request changed meanwhile. Please refresh.');
    // the withdrawal and the engine's cancellation commit together (the approvers are told; the timeline keeps the reason)
    await systemStep(trx, orgId, (t) => cancelForEntity(deps, t, actor, orgId, 'SHORT_LEAVE', id, why, { source: 'self_service' }));
    await audit(trx, actor, orgId, 'time_off.withdrawn', 'time_off_request', { entityId: id, branchId: emp.branchId, oldValue: { status: before.status }, newValue: { status: 'CANCELLED' }, reason: lock.lockedOverride ? `${why}; locked period (attendance.lock_period)` : why });
    return (await toRequestDtos(trx, orgId, [await ownRow(trx, orgId, emp.id, id)], view))[0]!;
  });
}

// ----- HR -----------------------------------------------------------------------------------------------------------------------

/** GET /time-off-requests — HR's list (leave.view; branch scope through RLS and the filter). */
export async function listTimeOffRequests(deps: ApiDeps, actor: Actor, orgId: string, q: TimeOffRequestListQuery): Promise<{ data: TimeOffRequestDto[]; total: number }> {
  const grant = requirePermission(actor.principal, orgId, 'leave.view');
  const branches = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    let base = requestQuery(trx, orgId);
    if (branches) base = base.where('r.branchId', 'in', branches);
    if (q.employeeId) base = base.where('r.employeeId', '=', q.employeeId);
    if (q.typeId) base = base.where('r.timeOffTypeId', '=', q.typeId);
    if (q.status) base = base.where('r.status', '=', q.status);
    if (q.from) base = base.where('r.requestDate', '>=', dv(q.from));
    if (q.to) base = base.where('r.requestDate', '<=', dv(q.to));
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = (await base.select(REQUEST_COLUMNS).orderBy('r.requestDate', 'desc').orderBy('r.startTime', 'desc').orderBy('r.id').limit(page.pageSize).offset(page.offset).execute()) as RequestRow[];
    return { data: await toRequestDtos(trx, orgId, rows), total };
  });
}

async function hrRow(trx: Trx, orgId: string, id: string): Promise<RequestRow> {
  const row = (await requestQuery(trx, orgId).select(REQUEST_COLUMNS).where('r.id', '=', id).executeTakeFirst()) as RequestRow | undefined;
  if (!row) throw errors.notFound('Short leave request', id);
  return row;
}

/**
 * POST /time-off-requests — HR records a short leave for an employee (leave.manage, the employee's branch in scope). Validated
 * like a portal request, except that the length and the monthly quota only warn (HR records after the fact) and HR-only types
 * are allowed. Approved at once unless a SHORT_LEAVE workflow applies to the employee; HR's own short leave is routed to the
 * leave.approve holders in reach, like a portal request (segregation of duties).
 */
export async function recordTimeOff(deps: ApiDeps, actor: Actor, orgId: string, input: TimeOffRequestInput): Promise<WithTimeOffRecalc<TimeOffRequestDto> & { warnings: TimeOffWarning[] }> {
  const grant = requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const emp = await loadLeaveEmployee(trx, orgId, input.employeeId);
    if (!emp) throw errors.validation('Employee not found.', { issues: [{ path: 'employeeId', message: 'Unknown employee' }] });
    requireBranchAccess(grant, emp.branchId);
    const lock = await checkDayLock(trx, orgId, emp.branchId, input.date, grant);
    await lockEmployeeLeave(trx, emp.id);
    const ev = await evaluateTimeOff(trx, orgId, { employee: emp, typeId: input.typeId, date: input.date, startTime: input.startTime, endTime: input.endTime, asHr: true });
    const own = !!grant.employeeId && grant.employeeId === emp.id;
    const row = await systemStep(trx, orgId, (t) => t.insertInto('timeOffRequests').values({
      organizationId: orgId, employeeId: emp.id, branchId: emp.branchId, timeOffTypeId: ev.type.id, requestDate: input.date, startTime: input.startTime, endTime: input.endTime,
      minutes: ev.minutes, reason: input.reason, status: 'PENDING', createdBy: actor.userId,
    }).returning('id').executeTakeFirstOrThrow());
    await audit(trx, actor, orgId, 'time_off.recorded', 'time_off_request', { entityId: row.id, branchId: emp.branchId, newValue: { ...input, minutes: ev.minutes, typeCode: ev.type.code, ...(ev.warnings.length ? { warnings: ev.warnings.map((w) => w.code) } : {}) }, ...(lock.lockedOverride ? { reason: 'locked period (attendance.lock_period)' } : {}) });
    const submitted = await submit(deps, trx, actor, orgId, {
      entityType: 'SHORT_LEAVE', entityId: row.id, employeeId: emp.id, branchId: emp.branchId, departmentId: emp.departmentId, units: ev.minutes, requestedBy: actor.userId,
      noWorkflow: own ? { kind: 'PERMISSION', permission: 'leave.approve' } : { kind: 'AUTO_APPROVE' }, notRequired: !ev.type.requiresApproval,
    });
    await systemStep(trx, orgId, (t) => t.updateTable('timeOffRequests').set({ approvalRequestId: submitted.requestId }).where('organizationId', '=', orgId).where('id', '=', row.id).execute());
    const recalc = submitted.autoApproved ? await recalcTimeOffDay(deps, trx, actor, orgId, { date: input.date, employeeId: emp.id, branchId: emp.branchId }, 'short leave recorded') : null;
    const [dto] = await toRequestDtos(trx, orgId, [await hrRow(trx, orgId, row.id)]);
    return { ...dto!, recalculationJobId: recalc?.jobId ?? null, warnings: ev.warnings };
  });
}

/**
 * POST /time-off-requests/:id/cancel — HR cancels a pending request (its approval request is withdrawn) or an approved one (the
 * day is recomputed). Whoever the request is about never cancels their own approved short leave here (another HR user does).
 */
export async function cancelTimeOff(deps: ApiDeps, actor: Actor, orgId: string, id: string, reason: string): Promise<WithTimeOffRecalc<TimeOffRequestDto>> {
  const grant = requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await hrRow(trx, orgId, id);
    requireBranchAccess(grant, before.branchId);
    const status = before.status as TimeOffStatus;
    if (status === 'CANCELLED') return { ...(await toRequestDtos(trx, orgId, [before]))[0]!, recalculationJobId: null };
    if (status === 'REJECTED') throw errors.invalidState('This request was rejected, so there is nothing to cancel.');
    if (status === 'APPROVED' && grant.employeeId === before.employeeId && grant.roleKey !== 'owner') throw errors.forbidden('Your own approved short leave is cancelled by another HR user.');
    const date = isoDate(before.requestDate);
    const lock = await checkDayLock(trx, orgId, before.branchId, date, grant);
    const why = reason.trim();
    const res = await systemStep(trx, orgId, (t) => t.updateTable('timeOffRequests').set({ status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: actor.userId, cancelReason: why })
      .where('organizationId', '=', orgId).where('id', '=', id).where('status', '=', status).executeTakeFirst());
    if (Number(res.numUpdatedRows) !== 1) throw errors.conflict('The request changed meanwhile. Please refresh.');
    if (status === 'PENDING') await systemStep(trx, orgId, (t) => cancelForEntity(deps, t, actor, orgId, 'SHORT_LEAVE', id, why, { source: 'hr' }));
    const recalc = status === 'APPROVED' ? await recalcTimeOffDay(deps, trx, actor, orgId, { date, employeeId: before.employeeId, branchId: before.branchId }, 'short leave cancelled') : null;
    await audit(trx, actor, orgId, 'time_off.cancelled', 'time_off_request', { entityId: id, branchId: before.branchId, oldValue: { status }, newValue: { status: 'CANCELLED' }, reason: lock.lockedOverride ? `${why}; locked period (attendance.lock_period)` : why });
    return { ...(await toRequestDtos(trx, orgId, [await hrRow(trx, orgId, id)]))[0]!, recalculationJobId: recalc?.jobId ?? null };
  });
}
