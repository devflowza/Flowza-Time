import type { CompOffBalanceDto, LeaveWarningDto, SelfLeaveBalanceDto, SelfLeaveDto, SelfLeaveEditInput, SelfLeaveRecordDto, SelfLeaveRequestInput, SelfLeaveTotalsDto, SelfLeaveTypeDto, TeamLeaveDto } from '@flowza/contracts';
import { COMP_OFF_SYSTEM_KEY, emitDomainEvent, loadLeaveBalances, loadLeaveTypePolicies, loadWorkingCalendars, type LeaveTypePolicy, type Trx } from '@flowza/database';
import { clampToYear, countLeaveDaysByMode, leaveTypeApplies, type LeaveBalance, type MembershipGrant, type WorkingCalendar } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { hasPermission, requireAnyPermission, requireMembership } from '../../lib/authorize.js';
import { type Actor, audit, runUser, withSystemScope } from '../../lib/service.js';
import { isoDate, isoDateTime, isoDateTimeOrNull } from '../../lib/mappers.js';
import { orgToday } from '../features/recalc.js';
import { dv } from '../features/sql-helpers.js';
import { systemStep } from '../features/context.js';
import { answerInfo, cancelForEntity, submit } from '../approvals/engine.js';
import { assertNoOverlap, checkLeaveRangeLock, evaluateLeaveRequest, isCompOffType, loadLeaveEmployee, toBalanceDto, type LeaveEmployee } from './common.js';
import { UNDECIDED_LEAVE, recalcLeaveRange, resubmitLeave } from './lifecycle.js';

/**
 * Leave in the employee portal (/orgs/:orgId/me/leave…) — leave v2 (HR portal Prompt 7). Always the caller's own employee
 * record (the membership's link, never a client-supplied id). Own rows are read and written under the caller's RLS
 * (self policies: apply → PENDING, edit / withdraw while PENDING or INFO_REQUESTED); balances, calendars and the approval
 * request behind each leave are read in the organisation's system scope for the caller's own employee only.
 *
 * The pre-v2 contract of the current web (GET /me/leave, POST /me/leave, POST /me/leave/:id/cancel) keeps its shapes:
 * fields are only added.
 */

interface SelfScope { grant: MembershipGrant; employeeId: string }

function selfScope(actor: Actor, orgId: string): SelfScope {
  const grant = requireMembership(actor.principal, orgId);
  if (!grant.employeeId) throw errors.forbidden('Your account is not linked to an employee record in this organisation.');
  return { grant, employeeId: grant.employeeId };
}
const canRequest = (s: SelfScope) => hasPermission(s.grant, 'leave.request');
function requireOwnLeave(s: SelfScope): void {
  if (!canRequest(s) && !hasPermission(s.grant, 'leave.view')) throw errors.forbidden('Missing permission: leave.request.');
}
function requireRequest(s: SelfScope): void {
  if (!canRequest(s)) throw errors.forbidden('Missing permission: leave.request.');
}
async function ownEmployee(trx: Trx, orgId: string, scope: SelfScope): Promise<LeaveEmployee> {
  const emp = await loadLeaveEmployee(trx, orgId, scope.employeeId);
  if (!emp) throw errors.notFound('Employee record');
  return emp;
}

// ----- own rows ------------------------------------------------------------------------------------------------------------

type OwnLeaveRow = {
  id: string; leaveTypeId: string; code: string; name: string; color: string | null; isPaid: boolean; systemKey: string | null; countMode: string; startDate: Date | string; endDate: Date | string; isHalfDay: boolean; halfDayPart: string | null;
  reason: string | null; status: SelfLeaveRecordDto['status']; decisionNote: string | null; approvedBy: string | null; approvedAt: Date | null; approvalRequestId: string | null; days: unknown; withdrawnAt: Date | null; editedAt: Date | null; createdAt: Date; updatedAt: Date;
};
const OWN_COLUMNS = ['l.id', 'l.leaveTypeId', 't.code', 't.name', 't.color', 't.isPaid', 't.systemKey', 't.countMode', 'l.startDate', 'l.endDate', 'l.isHalfDay', 'l.halfDayPart', 'l.reason', 'l.status', 'l.decisionNote', 'l.approvedBy', 'l.approvedAt', 'l.approvalRequestId', 'l.days', 'l.withdrawnAt', 'l.editedAt', 'l.createdAt', 'l.updatedAt'] as const;

async function ownLeaveRows(trx: Trx, orgId: string, employeeId: string, filter: { from?: string; to?: string; id?: string } = {}): Promise<OwnLeaveRow[]> {
  let q = trx.selectFrom('leaveRecords as l').innerJoin('leaveTypes as t', 't.id', 'l.leaveTypeId').select(OWN_COLUMNS).where('l.organizationId', '=', orgId).where('l.employeeId', '=', employeeId);
  if (filter.id) q = q.where('l.id', '=', filter.id);
  if (filter.from) q = q.where('l.endDate', '>=', dv(filter.from));
  if (filter.to) q = q.where('l.startDate', '<=', dv(filter.to));
  return (await q.orderBy('l.startDate', 'desc').orderBy('l.createdAt', 'desc').execute()) as OwnLeaveRow[];
}
async function ownRow(trx: Trx, orgId: string, employeeId: string, id: string): Promise<OwnLeaveRow> {
  const [row] = await ownLeaveRows(trx, orgId, employeeId, { id });
  if (!row) throw errors.notFound('Leave request', id);
  return row;
}

/** The DTOs of the caller's own rows: the engine request (status, level), the thread (count, the open question) and what they may do. */
async function toSelfLeaveDtos(trx: Trx, orgId: string, employeeId: string, rows: OwnLeaveRow[], grant: MembershipGrant): Promise<SelfLeaveRecordDto[]> {
  if (!rows.length) return [];
  const mayRequest = hasPermission(grant, 'leave.request');
  const ids = rows.map((r) => r.id);
  // the thread is read under the caller's RLS (own leave); names and the engine request in the system scope, for these rows only
  const comments = await trx.selectFrom('leaveRequestComments').select(['leaveRecordId', 'kind', 'body', 'authorUserId', 'createdAt']).where('organizationId', '=', orgId).where('leaveRecordId', 'in', ids).orderBy('createdAt', 'asc').execute();
  const needsDays = rows.filter((r) => r.days === null || r.days === undefined);
  const ref = await withSystemScope(trx, orgId, async (t) => {
    const requestIds = [...new Set(rows.map((r) => r.approvalRequestId).filter((x): x is string => !!x))];
    const requests = requestIds.length ? await t.selectFrom('approvalRequests').select(['id', 'status', 'currentStep']).where('organizationId', '=', orgId).where('id', 'in', requestIds).execute() : [];
    const counts = requestIds.length ? await t.selectFrom('approvalSteps').select(['requestId', (eb) => eb.fn.countAll<string>().as('n')]).where('requestId', 'in', requestIds).groupBy('requestId').execute() : [];
    const userIds = [...new Set([...rows.map((r) => r.approvedBy), ...comments.map((c) => c.authorUserId)].filter((x): x is string => !!x))];
    const users = userIds.length ? await t.selectFrom('userProfiles').select(['id', 'fullName', 'email']).where('id', 'in', userIds).execute() : [];
    const cal = needsDays.length ? (await loadWorkingCalendars(t, orgId, [employeeId], needsDays.map((r) => isoDate(r.startDate)).sort()[0]!, needsDays.map((r) => isoDate(r.endDate)).sort().pop()!)).get(employeeId) : undefined;
    return { requests, counts, users, cal };
  });
  const nameOf = new Map(ref.users.map((u) => [u.id, u.fullName || u.email || null]));
  const reqById = new Map(ref.requests.map((r) => [r.id, r]));
  return rows.map((r) => {
    const req = r.approvalRequestId ? reqById.get(r.approvalRequestId) : undefined;
    const range = { startDate: isoDate(r.startDate), endDate: isoDate(r.endDate), isHalfDay: r.isHalfDay };
    const own = comments.filter((c) => c.leaveRecordId === r.id);
    const question = r.status === 'INFO_REQUESTED' ? [...own].reverse().find((c) => c.kind === 'info_request') : undefined;
    const undecided = UNDECIDED_LEAVE.includes(r.status);
    const days = r.days !== null && r.days !== undefined ? Number(r.days) : ref.cal ? countLeaveDaysByMode(range, ref.cal, r.countMode === 'calendar' ? 'calendar' : 'working') : 0;
    return {
      id: r.id, leaveTypeId: r.leaveTypeId, leaveTypeCode: String(r.code), leaveTypeName: r.name, color: r.color, isPaid: r.isPaid, ...range, halfDayPart: r.halfDayPart, days,
      reason: r.reason, status: r.status, decisionNote: r.decisionNote, approvedByName: r.approvedBy ? nameOf.get(r.approvedBy) ?? null : null, approvedAt: isoDateTimeOrNull(r.approvedAt), createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt),
      approvalRequestId: r.approvalRequestId, approvalStatus: req ? (req.status as SelfLeaveRecordDto['approvalStatus']) : null, approvalCurrentStep: req ? req.currentStep : null, approvalStepCount: req ? Number(ref.counts.find((c) => c.requestId === req.id)?.n ?? 0) : null,
      withdrawnAt: isoDateTimeOrNull(r.withdrawnAt), editedAt: isoDateTimeOrNull(r.editedAt),
      canEdit: mayRequest && undecided, canWithdraw: mayRequest && undecided, canReply: mayRequest && r.status === 'INFO_REQUESTED',
      infoRequest: question ? { message: question.body, askedAt: isoDateTime(question.createdAt), askedByName: question.authorUserId ? nameOf.get(question.authorUserId) ?? null : null } : null,
      commentCount: own.length, compOff: r.systemKey === COMP_OFF_SYSTEM_KEY,
    };
  });
}

// ----- balances ------------------------------------------------------------------------------------------------------------

export interface LeaveView {
  year: number;
  asOf: string;
  /** Types the employee may apply for in the portal (active, portal-visible, applicable to them, not comp-off). */
  offered: LeaveTypePolicy[];
  compOffType: LeaveTypePolicy | null;
  balances: Map<string, LeaveBalance>;
  calendar: WorkingCalendar;
}

/** Types, balances (the one balance function) and the working calendar of one employee for a year (system scope). */
export async function loadLeaveView(trx: Trx, orgId: string, emp: Pick<LeaveEmployee, 'id' | 'gender'>, year?: number): Promise<LeaveView> {
  return withSystemScope(trx, orgId, async (t) => {
    const today = await orgToday(t, orgId);
    const y = year ?? Number(today.slice(0, 4));
    const types = await loadLeaveTypePolicies(t, orgId);
    const compOffType = types.find(isCompOffType) ?? null;
    const offered = types.filter((x) => !isCompOffType(x) && x.portalVisible && leaveTypeApplies(x.applicableGender, emp.gender));
    const balanceTypes = compOffType ? [...offered, compOffType] : offered;
    const computed = (await loadLeaveBalances(t, orgId, [emp.id], { year: y, asOf: today, types: balanceTypes })).get(emp.id) ?? [];
    // next year's calendar too: a request made in December often ends in January
    const calendar = (await loadWorkingCalendars(t, orgId, [emp.id], `${y}-01-01`, `${y + 1}-12-31`)).get(emp.id) ?? { weeklyOffDays: [], holidays: new Set<string>() };
    return { year: y, asOf: clampToYear(today, y), offered, compOffType, balances: new Map(computed.map((b) => [b.leaveTypeId, b])), calendar };
  });
}

export function toSelfTypeDto(t: LeaveTypePolicy): SelfLeaveTypeDto {
  return {
    id: t.id, code: t.code, name: t.name, nameAr: t.nameAr, isPaid: t.isPaid, color: t.color, annualAllowanceDays: t.annualAllowanceDays,
    requiresApproval: t.requiresApproval, countMode: t.countMode, allowHalfDay: t.allowHalfDay, advanceNoticeDays: t.advanceNoticeDays, maxConsecutiveDays: t.maxConsecutiveDays, accrual: t.accrual, compOff: isCompOffType(t),
  };
}
/** The pre-v2 fields (allowance = entitlement, used = taken, remaining = available after pending) plus the full v2 balance. */
export function toSelfBalanceDto(t: LeaveTypePolicy, b: LeaveBalance): SelfLeaveBalanceDto {
  return { ...toBalanceDto(t, b), leaveTypeId: t.id, allowanceDays: b.entitlementDays, usedDays: b.takenDays, pendingDays: b.pendingDays, remainingDays: b.availableAfterPendingDays };
}
export function selfTotals(view: LeaveView): SelfLeaveTotalsDto {
  const tracked = view.offered.map((t) => view.balances.get(t.id)).filter((b): b is LeaveBalance => !!b && b.tracked);
  const sum = (f: (b: LeaveBalance) => number) => Math.round(tracked.reduce((a, b) => a + f(b), 0) * 2) / 2;
  return { entitlementDays: sum((b) => b.entitlementDays ?? 0), takenDays: sum((b) => b.takenDays), pendingDays: sum((b) => b.pendingDays), availableDays: sum((b) => b.availableDays ?? 0), accruedToDateDays: sum((b) => b.accruedToDateDays ?? b.entitlementDays ?? 0) };
}
export function selfCompOffBalance(view: LeaveView): CompOffBalanceDto | null {
  if (!view.compOffType) return null;
  const b = view.balances.get(view.compOffType.id);
  return { leaveTypeId: view.compOffType.id, earnedDays: b?.entitlementDays ?? 0, usedDays: b?.takenDays ?? 0, availableDays: b?.availableDays ?? 0, pendingDays: b?.pendingDays ?? 0, availableAfterPendingDays: b?.availableAfterPendingDays ?? 0 };
}

// ----- endpoints ------------------------------------------------------------------------------------------------------------

/** GET /me/leave?year — the portal's leave page: types, balances, the five totals, comp-off, own requests of the year. */
export async function getLeave(deps: ApiDeps, actor: Actor, orgId: string, q: { year?: number }): Promise<SelfLeaveDto> {
  const scope = selfScope(actor, orgId);
  requireOwnLeave(scope);
  return runUser(deps.db, actor, async (trx) => {
    const emp = await ownEmployee(trx, orgId, scope);
    const view = await loadLeaveView(trx, orgId, emp, q.year);
    const rows = await ownLeaveRows(trx, orgId, emp.id, { from: `${view.year}-01-01`, to: `${view.year}-12-31` });
    return {
      year: view.year,
      types: view.offered.map(toSelfTypeDto),
      balances: view.offered.map((t) => toSelfBalanceDto(t, view.balances.get(t.id)!)).filter((b) => !!b),
      records: await toSelfLeaveDtos(trx, orgId, emp.id, rows, scope.grant),
      calendar: { weeklyOffDays: [...view.calendar.weeklyOffDays], holidays: [...view.calendar.holidays].sort() },
      asOf: view.asOf, totals: selfTotals(view), compOff: selfCompOffBalance(view),
    };
  });
}

/** Refuse types HR keeps for itself (not portal-visible) — the comp-off type is redeemed through this same call. */
function assertPortalType(type: LeaveTypePolicy): void {
  if (!type.portalVisible && !isCompOffType(type)) throw errors.validation(`${type.name} is recorded by HR; ask HR to record it for you.`, { issues: [{ path: 'leaveTypeId', message: 'Not requestable in the portal', code: 'NOT_REQUESTABLE' }] });
}

/**
 * POST /me/leave — apply (the redemption of comp-off credits too: a leave of the comp-off type). Validated by the leave v2
 * matrix (applicability, half day, notice, consecutive cap, comp-off balance; over-balance only warns), days computed and
 * stored, then routed by the approval engine (LEAVE, units = days). A type that needs no approval is approved at once.
 */
export async function applyLeave(deps: ApiDeps, actor: Actor, orgId: string, input: SelfLeaveRequestInput): Promise<SelfLeaveRecordDto> {
  const scope = selfScope(actor, orgId);
  requireRequest(scope);
  const isHalfDay = input.isHalfDay ?? false;
  const halfDayPart = isHalfDay ? input.halfDayPart ?? 'FIRST_HALF' : null;
  return runUser(deps.db, actor, async (trx) => {
    const emp = await ownEmployee(trx, orgId, scope);
    const ev = await evaluateLeaveRequest(trx, orgId, { employee: emp, leaveTypeId: input.leaveTypeId, startDate: input.startDate, endDate: input.endDate, isHalfDay, asHr: false });
    assertPortalType(ev.type);
    const lock = await checkLeaveRangeLock(trx, orgId, emp.branchId, input.startDate, input.endDate, scope.grant);
    await assertNoOverlap(trx, orgId, emp.id, { startDate: input.startDate, endDate: input.endDate, isHalfDay, halfDayPart });
    const row = await trx.insertInto('leaveRecords').values({
      organizationId: orgId, employeeId: emp.id, branchId: emp.branchId, leaveTypeId: input.leaveTypeId, startDate: input.startDate, endDate: input.endDate,
      isHalfDay, halfDayPart, days: ev.days, reason: input.reason, status: 'PENDING', source: 'INTERNAL', createdBy: actor.userId,
    }).returning('id').executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'leave.requested', 'leave_record', { entityId: row.id, branchId: emp.branchId, newValue: { ...input, isHalfDay, days: ev.days, ...(ev.warnings.length ? { warnings: ev.warnings.map((w) => w.code) } : {}) }, ...(lock.lockedOverride ? { reason: 'locked period (attendance.lock_period)' } : {}) });
    // the approval engine routes it (the workflow for LEAVE, else the leave.approve holders in reach of the employee —
    // never approved by the employee); units = the days it charges, for workflow tiers
    const submitted = await submit(deps, trx, actor, orgId, {
      entityType: 'LEAVE', entityId: row.id, employeeId: emp.id, branchId: emp.branchId, departmentId: emp.departmentId, units: ev.days, requestedBy: actor.userId,
      noWorkflow: { kind: 'PERMISSION', permission: 'leave.approve' }, notRequired: !ev.type.requiresApproval,
    });
    await systemStep(trx, orgId, (t) => t.updateTable('leaveRecords').set({ approvalRequestId: submitted.requestId }).where('id', '=', row.id).execute());
    await emitDomainEvent(trx, { organizationId: orgId, eventType: 'leave.requested', aggregateType: 'leave_record', aggregateId: row.id, payload: { employeeId: emp.id, employeeName: emp.displayName, leaveTypeName: ev.type.name, startDate: input.startDate, endDate: input.endDate, approvalRequestId: submitted.requestId }, actorUserId: actor.userId, requestId: actor.requestId });
    if (submitted.autoApproved) await recalcLeaveRange(deps, trx, actor, orgId, input.startDate, input.endDate, { branchId: emp.branchId, employeeIds: [emp.id], reason: 'leave approved (no approval required)' });
    const [dto] = await toSelfLeaveDtos(trx, orgId, emp.id, [await ownRow(trx, orgId, emp.id, row.id)], scope.grant);
    return { ...dto!, warnings: ev.warnings };
  });
}

/**
 * PATCH /me/leave/:id — change a request that is still PENDING or INFO_REQUESTED (an open question is answered by the
 * edit). Re-validated like a new request; the pending approval request is voided and the leave resubmitted from level 1
 * (Finance B-96), so the approvers decide on what it now says.
 */
export async function editLeave(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: SelfLeaveEditInput): Promise<SelfLeaveRecordDto> {
  const scope = selfScope(actor, orgId);
  requireRequest(scope);
  return runUser(deps.db, actor, async (trx) => {
    const emp = await ownEmployee(trx, orgId, scope);
    const before = await ownRow(trx, orgId, emp.id, id);
    if (!UNDECIDED_LEAVE.includes(before.status)) throw errors.invalidState(`Only a pending request can be changed (current: ${before.status}). Ask HR to change decided leave.`);
    const beforeStart = isoDate(before.startDate); const beforeEnd = isoDate(before.endDate);
    const next = {
      leaveTypeId: input.leaveTypeId ?? before.leaveTypeId,
      startDate: input.startDate ?? beforeStart,
      endDate: input.endDate ?? (input.startDate && input.startDate > beforeEnd ? input.startDate : beforeEnd),
      isHalfDay: input.isHalfDay ?? before.isHalfDay,
      reason: input.reason ?? before.reason,
    };
    const halfDayPart = next.isHalfDay ? (input.halfDayPart ?? before.halfDayPart ?? 'FIRST_HALF') as 'FIRST_HALF' | 'SECOND_HALF' : null;
    if (next.isHalfDay && next.startDate !== next.endDate) throw errors.validation('A half day is a single date.', { issues: [{ path: 'endDate', message: 'Must equal startDate' }] });
    const changed = next.leaveTypeId !== before.leaveTypeId || next.startDate !== beforeStart || next.endDate !== beforeEnd || next.isHalfDay !== before.isHalfDay || halfDayPart !== before.halfDayPart || next.reason !== before.reason;
    if (!changed) return (await toSelfLeaveDtos(trx, orgId, emp.id, [before], scope.grant))[0]!;
    const ev = await evaluateLeaveRequest(trx, orgId, { employee: emp, leaveTypeId: next.leaveTypeId, startDate: next.startDate, endDate: next.endDate, isHalfDay: next.isHalfDay, asHr: false, excludeRecordId: id });
    assertPortalType(ev.type);
    const lockA = await checkLeaveRangeLock(trx, orgId, emp.branchId, beforeStart, beforeEnd, scope.grant);
    const lockB = await checkLeaveRangeLock(trx, orgId, emp.branchId, next.startDate, next.endDate, scope.grant);
    await assertNoOverlap(trx, orgId, emp.id, { startDate: next.startDate, endDate: next.endDate, isHalfDay: next.isHalfDay, halfDayPart }, id);
    const res = await trx.updateTable('leaveRecords').set({ leaveTypeId: next.leaveTypeId, startDate: next.startDate, endDate: next.endDate, isHalfDay: next.isHalfDay, halfDayPart, reason: next.reason, days: ev.days, editedAt: new Date(), status: 'PENDING' })
      .where('organizationId', '=', orgId).where('id', '=', id).where('employeeId', '=', emp.id).where('status', 'in', ['PENDING', 'INFO_REQUESTED']).executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) throw errors.conflict('The request changed meanwhile. Please refresh.');
    const pending = await withSystemScope(trx, orgId, (t) => t.selectFrom('approvalRequests').select(['id', 'requestedBy']).where('organizationId', '=', orgId).where('entityType', '=', 'LEAVE').where('entityId', '=', id).where('status', '=', 'PENDING').executeTakeFirst());
    if (before.status === 'INFO_REQUESTED') await withSystemScope(trx, orgId, (t) => t.insertInto('leaveRequestComments').values({ organizationId: orgId, leaveRecordId: id, authorUserId: actor.userId, body: 'The request was changed and submitted again.', kind: 'system' }).execute());
    const resubmitted = await resubmitLeave(deps, trx, actor, orgId, { id, employeeId: emp.id, branchId: emp.branchId, departmentId: emp.departmentId, days: ev.days, requiresApproval: ev.type.requiresApproval }, { requestedBy: pending?.requestedBy ?? actor.userId, reason: 'Leave edited by the employee' });
    const after = await ownRow(trx, orgId, emp.id, id);
    await audit(trx, actor, orgId, 'leave.edited', 'leave_record', {
      entityId: id, branchId: emp.branchId,
      oldValue: { leaveTypeId: before.leaveTypeId, startDate: beforeStart, endDate: beforeEnd, isHalfDay: before.isHalfDay, halfDayPart: before.halfDayPart, reason: before.reason, days: before.days === null ? null : Number(before.days), status: before.status },
      newValue: { ...next, halfDayPart, days: ev.days, status: after.status, approvalRequestId: resubmitted.requestId, ...(ev.warnings.length ? { warnings: ev.warnings.map((w) => w.code) } : {}) },
      ...(lockA.lockedOverride || lockB.lockedOverride ? { reason: 'locked period (attendance.lock_period)' } : {}),
    });
    if (resubmitted.autoApproved) await recalcLeaveRange(deps, trx, actor, orgId, next.startDate, next.endDate, { branchId: emp.branchId, employeeIds: [emp.id], reason: 'leave approved (no approval required)' });
    const [dto] = await toSelfLeaveDtos(trx, orgId, emp.id, [after], scope.grant);
    return { ...dto!, warnings: ev.warnings as LeaveWarningDto[] };
  });
}

export const DEFAULT_WITHDRAW_REASON = 'Withdrawn by the requester';

/**
 * Withdraw one's own request while it is still PENDING or INFO_REQUESTED (Finance B-98: the requester withdraws, with a
 * reason the approvers see). Approved leave is cancelled by HR — the employee is told to contact HR. `reason` is required
 * on POST /me/leave/:id/withdraw; the pre-v2 POST /me/leave/:id/cancel may omit it (stored as "Withdrawn by the requester").
 */
export async function withdrawLeave(deps: ApiDeps, actor: Actor, orgId: string, id: string, reason: string | null): Promise<SelfLeaveRecordDto> {
  const scope = selfScope(actor, orgId);
  requireRequest(scope);
  return runUser(deps.db, actor, async (trx) => {
    const emp = await ownEmployee(trx, orgId, scope);
    const before = await ownRow(trx, orgId, emp.id, id);
    if (before.status === 'APPROVED') throw errors.invalidState('Approved leave can only be cancelled by HR. Contact HR to cancel it.');
    if (!UNDECIDED_LEAVE.includes(before.status)) throw errors.invalidState(`Only a pending request can be withdrawn (current: ${before.status}). Ask HR to change approved leave.`);
    const lock = await checkLeaveRangeLock(trx, orgId, emp.branchId, isoDate(before.startDate), isoDate(before.endDate), scope.grant);
    const why = reason?.trim() || DEFAULT_WITHDRAW_REASON;
    const res = await trx.updateTable('leaveRecords').set({ status: 'CANCELLED', withdrawnAt: new Date() })
      .where('organizationId', '=', orgId).where('id', '=', id).where('employeeId', '=', emp.id).where('status', 'in', ['PENDING', 'INFO_REQUESTED']).executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) throw errors.conflict('The request changed meanwhile. Please refresh.');
    // withdrawing the leave withdraws its approval request (the approvers are told; the timeline records the reason)
    await systemStep(trx, orgId, (t) => cancelForEntity(deps, t, actor, orgId, 'LEAVE', id, why, { source: 'self_service' }));
    await audit(trx, actor, orgId, 'leave.withdrawn', 'leave_record', { entityId: id, branchId: emp.branchId, oldValue: { status: before.status }, newValue: { status: 'CANCELLED' }, reason: lock.lockedOverride ? `${why}; locked period (attendance.lock_period)` : why });
    const [dto] = await toSelfLeaveDtos(trx, orgId, emp.id, [await ownRow(trx, orgId, emp.id, id)], scope.grant);
    return dto!;
  });
}
/** The pre-v2 withdraw call (POST /me/leave/:id/cancel, no body): same rules, the default reason. */
export async function cancelLeave(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<SelfLeaveRecordDto> {
  return withdrawLeave(deps, actor, orgId, id, null);
}

/**
 * POST /me/leave/:id/reply — answer the approver's question: the reply joins the thread, the leave goes back to PENDING and
 * the engine's info request is answered (the approvers of the current level are told).
 */
export async function replyLeave(deps: ApiDeps, actor: Actor, orgId: string, id: string, body: string): Promise<SelfLeaveRecordDto> {
  const scope = selfScope(actor, orgId);
  requireRequest(scope);
  return runUser(deps.db, actor, async (trx) => {
    const emp = await ownEmployee(trx, orgId, scope);
    const before = await ownRow(trx, orgId, emp.id, id);
    if (before.status !== 'INFO_REQUESTED') throw errors.invalidState('There is no open question on this request.');
    const pending = await withSystemScope(trx, orgId, (t) => t.selectFrom('approvalRequests').select('id').where('organizationId', '=', orgId).where('entityType', '=', 'LEAVE').where('entityId', '=', id).where('status', '=', 'PENDING').executeTakeFirst());
    if (!pending) throw errors.invalidState('The approval request of this leave is no longer open. Please refresh.');
    await answerInfo(deps, trx, actor, orgId, pending.id, body.trim());
    const [dto] = await toSelfLeaveDtos(trx, orgId, emp.id, [await ownRow(trx, orgId, emp.id, id)], scope.grant);
    return dto!;
  });
}

/**
 * The balances / upcoming leave block of the portal home (GET /me/overview): tracked types and anything used or requested
 * this year, through the one balance function; upcoming = approved or undecided leave ending today or later.
 */
export async function overviewLeave(trx: Trx, orgId: string, employeeId: string, grant: MembershipGrant): Promise<{ balances: Array<SelfLeaveBalanceDto & { name: string; code: string; color: string | null }>; upcomingLeave: SelfLeaveRecordDto[]; pendingLeave: number }> {
  const emp = await loadLeaveEmployee(trx, orgId, employeeId);
  if (!emp) return { balances: [], upcomingLeave: [], pendingLeave: 0 };
  const view = await loadLeaveView(trx, orgId, emp);
  const today = await withSystemScope(trx, orgId, (t) => orgToday(t, orgId));
  const balances = view.offered.map((t) => ({ ...toSelfBalanceDto(t, view.balances.get(t.id)!), name: t.name, code: t.code, color: t.color }))
    .filter((b) => b.allowanceDays !== null || b.usedDays > 0 || b.pendingDays > 0);
  const rows = await ownLeaveRows(trx, orgId, employeeId, { from: today });
  const active = rows.filter((r) => r.status === 'APPROVED' || UNDECIDED_LEAVE.includes(r.status)).sort((a, b) => isoDate(a.startDate).localeCompare(isoDate(b.startDate)));
  const upcomingLeave = await toSelfLeaveDtos(trx, orgId, employeeId, active.slice(0, 5), grant);
  const pendingLeave = (await ownLeaveRows(trx, orgId, employeeId, { from: `${view.year}-01-01` })).filter((r) => UNDECIDED_LEAVE.includes(r.status)).length;
  return { balances, upcomingLeave, pendingLeave };
}

/**
 * GET /me/team/leave — the manager's view on /my: their direct reports' leave that is approved or still undecided and ends
 * today or later, soonest first, at most 20 (leave.view_team or leave.view; rows under the caller's RLS).
 */
export async function getTeamLeave(deps: ApiDeps, actor: Actor, orgId: string): Promise<TeamLeaveDto[]> {
  const grant = requireAnyPermission(actor.principal, orgId, 'leave.view_team', 'leave.view');
  if (!grant.teamEmployeeIds.length) return [];
  return runUser(deps.db, actor, async (trx) => {
    const today = await withSystemScope(trx, orgId, (t) => orgToday(t, orgId));
    const rows = await trx.selectFrom('leaveRecords as l').innerJoin('leaveTypes as t', 't.id', 'l.leaveTypeId')
      .select(['l.id', 'l.employeeId', 'l.leaveTypeId', 't.name as leaveTypeName', 't.code as leaveTypeCode', 't.color', 't.countMode', 'l.startDate', 'l.endDate', 'l.isHalfDay', 'l.halfDayPart', 'l.days', 'l.status'])
      .where('l.organizationId', '=', orgId).where('l.employeeId', 'in', grant.teamEmployeeIds).where('l.status', 'in', ['APPROVED', 'PENDING', 'INFO_REQUESTED']).where('l.endDate', '>=', dv(today))
      .orderBy('l.startDate', 'asc').orderBy('l.id').limit(20).execute();
    if (!rows.length) return [];
    const employees = await withSystemScope(trx, orgId, (t) => t.selectFrom('employees').select(['id', 'displayName', 'employeeNumber']).where('organizationId', '=', orgId).where('id', 'in', [...new Set(rows.map((r) => r.employeeId))]).execute());
    const byId = new Map(employees.map((e) => [e.id, e]));
    return rows.map((r) => ({
      id: r.id, employeeId: r.employeeId, employeeName: byId.get(r.employeeId)?.displayName ?? '', employeeNumber: byId.get(r.employeeId)?.employeeNumber ?? '', leaveTypeId: r.leaveTypeId, leaveTypeName: r.leaveTypeName, leaveTypeCode: String(r.leaveTypeCode), color: r.color,
      startDate: isoDate(r.startDate), endDate: isoDate(r.endDate), isHalfDay: r.isHalfDay, halfDayPart: r.halfDayPart, days: r.days === null ? null : Number(r.days), status: r.status,
    }));
  });
}
