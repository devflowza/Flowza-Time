import type { z } from 'zod';
import type { LeaveRecordInput, LeaveStatus, LeaveWarningDto, UpdateLeaveRecordInput, leaveTypeInputSchema } from '@flowza/contracts';
import { COMP_OFF_SYSTEM_KEY, LEAVE_TYPE_COLUMNS, emitDomainEvent, loadWorkingCalendars, releaseCompOffCredits, toLeaveTypePolicy, type LeaveTypePolicy, type Trx } from '@flowza/database';
import { countLeaveDaysByMode, type MembershipGrant } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, requireBranchAccess, requirePermission } from '../../lib/authorize.js';
import { type Actor, audit, diffObjects, runUser, withSystemScope } from '../../lib/service.js';
import { pageOf, toCount } from '../../lib/pagination.js';
import { isoDate, isoDateTime, isoDateTimeOrNull } from '../../lib/mappers.js';
import { orgToday } from '../features/recalc.js';
import { dv } from '../features/sql-helpers.js';
import { systemStep } from '../features/context.js';
import { ensureCompOffTypeRow, seedDefaultLeaveTypes } from '../features/leave-defaults.js';
import { cancelForEntity, decideWithin, submit } from '../approvals/engine.js';
import { bookCompOffForLeave } from '../approvals/hooks/leave.js';
import { assertNoOverlap, checkLeaveRangeLock, evaluateLeaveRequest, isCompOffType, loadLeaveEmployee } from './common.js';
import { ACTIVE_LEAVE, UNDECIDED_LEAVE, recalcLeaveRange, resubmitLeave, seatedStep, waitingForByRequest } from './lifecycle.js';

/**
 * HR leave (the /leave page): leave types with their v2 policy, and leave records — record, change, decide, cancel.
 * Leave v2 (HR portal Prompt 7) adds, on top of the approval-engine routing of Prompt 2: the validation matrix (warnings
 * for notice / consecutive cap / balance), server-computed `days`, INFO_REQUESTED as an undecided state, types that need
 * no approval, the comp-off type (protected; its leave books credits), post-decision corrections by `leave.manage` only
 * (audited as `leave.corrected`, B-53) and locked periods open only to `attendance.lock_period` holders (B-54).
 *
 * Review fixes (Prompt 2 review): a decision names the level it was taken on (P1-2); content and status never change in
 * one call (P1-3); an engine decision is never overturned by a status PATCH — the leave always agrees with its request
 * (P1-4).
 */

type LeaveTypeInput = z.infer<typeof leaveTypeInputSchema>;
const minDate = (a: string, b: string) => (a < b ? a : b);
const maxDate = (a: string, b: string) => (a > b ? a : b);

// ----- leave types ------------------------------------------------------------------------------------------------------------

export interface LeaveTypeDto {
  id: string; code: string; name: string; nameAr: string | null; isPaid: boolean; treatAsPresent: boolean; color: string | null; annualAllowanceDays: number | null; status: string; createdAt: string;
  // leave v2 policy
  requiresApproval: boolean; countMode: string; maxConsecutiveDays: number | null; advanceNoticeDays: number; applicableGender: string; accrual: string;
  carryForwardMaxDays: number; carryForwardExpiryMonths: number | null; isSpecial: boolean; allowHalfDay: boolean; portalVisible: boolean; systemKey: string | null;
  /** The organisation's comp-off type (managed by the system: always active, no allowance, redeemed from credits). */
  compOff: boolean;
}
export function toLeaveTypeDto(t: LeaveTypePolicy): LeaveTypeDto {
  return {
    id: t.id, code: t.code, name: t.name, nameAr: t.nameAr, isPaid: t.isPaid, treatAsPresent: t.treatAsPresent, color: t.color, annualAllowanceDays: t.annualAllowanceDays, status: t.status, createdAt: isoDateTime(t.createdAt),
    requiresApproval: t.requiresApproval, countMode: t.countMode, maxConsecutiveDays: t.maxConsecutiveDays, advanceNoticeDays: t.advanceNoticeDays, applicableGender: t.applicableGender, accrual: t.accrual,
    carryForwardMaxDays: t.carryForwardMaxDays, carryForwardExpiryMonths: t.carryForwardExpiryMonths, isSpecial: t.isSpecial, allowHalfDay: t.allowHalfDay, portalVisible: t.portalVisible, systemKey: t.systemKey, compOff: isCompOffType(t),
  };
}
async function allTypes(trx: Trx, orgId: string): Promise<LeaveTypeDto[]> {
  return (await trx.selectFrom('leaveTypes').select(LEAVE_TYPE_COLUMNS).where('organizationId', '=', orgId).orderBy('name').execute()).map((r) => toLeaveTypeDto(toLeaveTypePolicy(r as never)));
}
async function oneType(trx: Trx, orgId: string, id: string): Promise<LeaveTypePolicy | null> {
  const r = await trx.selectFrom('leaveTypes').select(LEAVE_TYPE_COLUMNS).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
  return r ? toLeaveTypePolicy(r as never) : null;
}

/** The comp-off leave type of an organisation (system key COMP_OFF), created when missing (system scope; idempotent). */
export async function ensureCompOffLeaveType(trx: Trx, orgId: string): Promise<string | null> {
  return withSystemScope(trx, orgId, async (t) => {
    await ensureCompOffTypeRow(t, orgId);
    return (await t.selectFrom('leaveTypes').select('id').where('organizationId', '=', orgId).where('systemKey', '=', COMP_OFF_SYSTEM_KEY).executeTakeFirst())?.id ?? null;
  });
}

export async function listLeaveTypes(deps: ApiDeps, actor: Actor, orgId: string): Promise<LeaveTypeDto[]> {
  requirePermission(actor.principal, orgId, 'leave.view');
  return runUser(deps.db, actor, (trx) => allTypes(trx, orgId));
}
/** POST /leave-types/seed-defaults — adds the default set's missing codes (and the comp-off type); never touches existing types. */
export async function seedLeaveTypes(deps: ApiDeps, actor: Actor, orgId: string): Promise<{ created: string[]; leaveTypes: LeaveTypeDto[] }> {
  requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const created = await seedDefaultLeaveTypes(trx, orgId);
    if (created.length) await audit(trx, actor, orgId, 'leave_type.seeded', 'leave_type', { newValue: { created } });
    return { created, leaveTypes: await allTypes(trx, orgId) };
  });
}
function typeValues(input: Partial<LeaveTypeInput>): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(input)) if (val !== undefined) v[k] = val;
  return v;
}
export async function createLeaveType(deps: ApiDeps, actor: Actor, orgId: string, input: LeaveTypeInput): Promise<LeaveTypeDto> {
  requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const row = await trx.insertInto('leaveTypes').values({ organizationId: orgId, ...typeValues(input), nameAr: input.nameAr ?? null, color: input.color ?? null, annualAllowanceDays: input.annualAllowanceDays ?? null } as never).returning('id').executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'leave_type.created', 'leave_type', { entityId: row.id, newValue: input });
    return toLeaveTypeDto((await oneType(trx, orgId, row.id))!);
  });
}

/** What the comp-off type must keep: it is balanced from credits, always active and never offered in the ordinary form. */
function assertCompOffTypeInvariant(patch: Partial<LeaveTypeInput> & { status?: string }): void {
  const bad: string[] = [];
  if (patch.status !== undefined && patch.status !== 'active') bad.push('status');
  if (patch.annualAllowanceDays !== undefined && patch.annualAllowanceDays !== null) bad.push('annualAllowanceDays');
  if (patch.accrual !== undefined && patch.accrual !== 'none') bad.push('accrual');
  if (patch.carryForwardMaxDays !== undefined && patch.carryForwardMaxDays !== 0) bad.push('carryForwardMaxDays');
  if (patch.portalVisible === true) bad.push('portalVisible');
  if (patch.isSpecial === false) bad.push('isSpecial');
  if (bad.length) throw errors.validation('The comp-off type is managed by the system: it stays active, has no yearly allowance, accrual or carry-forward, and is booked through "Use comp-off".', { issues: bad.map((path) => ({ path, message: 'Not allowed for the comp-off type' })) });
}

export async function updateLeaveType(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: Partial<LeaveTypeInput> & { status?: string }): Promise<LeaveTypeDto> {
  requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await oneType(trx, orgId, id);
    if (!before) throw errors.notFound('Leave type', id);
    if (isCompOffType(before)) assertCompOffTypeInvariant(input);
    const patch = typeValues(input);
    if (Object.keys(patch).length) await trx.updateTable('leaveTypes').set(patch as never).where('id', '=', id).execute();
    const after = (await oneType(trx, orgId, id))!;
    await audit(trx, actor, orgId, 'leave_type.updated', 'leave_type', { entityId: id, ...diffObjects(toLeaveTypeDto(before) as unknown as Record<string, unknown>, toLeaveTypeDto(after) as unknown as Record<string, unknown>) });
    if (before.isPaid !== after.isPaid || before.treatAsPresent !== after.treatAsPresent) {
      const earliest = await trx.selectFrom('leaveRecords').select((eb) => eb.fn.min('startDate').as('from')).where('leaveTypeId', '=', id).where('status', '=', 'APPROVED').executeTakeFirst();
      if (earliest?.from) await recalcLeaveRange(deps, trx, actor, orgId, isoDate(earliest.from as Date), null, { reason: `leave type ${after.code} changed` });
    }
    return toLeaveTypeDto(after);
  });
}
export async function deleteLeaveType(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<void> {
  requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const t = await oneType(trx, orgId, id);
    if (!t) throw errors.notFound('Leave type', id);
    if (isCompOffType(t)) throw errors.conflict('The comp-off type is managed by the system and cannot be removed.');
    const used = toCount((await trx.selectFrom('leaveRecords').select((eb) => eb.fn.countAll().as('n')).where('leaveTypeId', '=', id).executeTakeFirst())?.n);
    const allocated = toCount((await trx.selectFrom('leaveAllocations').select((eb) => eb.fn.countAll().as('n')).where('leaveTypeId', '=', id).executeTakeFirst())?.n);
    if (used > 0 || allocated > 0) { await trx.updateTable('leaveTypes').set({ status: 'archived' }).where('id', '=', id).execute(); await audit(trx, actor, orgId, 'leave_type.archived', 'leave_type', { entityId: id, oldValue: { code: t.code }, reason: `${used} leave records / ${allocated} allocations reference it` }); return; }
    await trx.deleteFrom('leaveTypes').where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'leave_type.deleted', 'leave_type', { entityId: id, oldValue: { code: t.code } });
  });
}

// ----- leave records ----------------------------------------------------------------------------------------------------------

export interface LeaveRecordDto {
  id: string; employeeId: string; employeeNumber?: string; employeeName?: string; leaveTypeId: string; leaveTypeName?: string; branchId: string | null; startDate: string; endDate: string; isHalfDay: boolean; halfDayPart: string | null;
  reason: string | null; status: string; source: string; decisionNote: string | null; approvedBy: string | null; approvedAt: string | null; createdBy: string | null; createdAt: string; updatedAt: string;
  // leave v2 (added fields only: the pre-v2 web keeps parsing this shape)
  leaveTypeCode?: string; color?: string | null; compOff?: boolean;
  days: number | null; withdrawnAt: string | null; editedAt: string | null;
  approvalRequestId: string | null; approvalStatus: string | null; approvalCurrentStep: number | null; approvalStepCount: number | null;
  /** Who the current level is waiting for (names), while the request is pending. */
  approvalWaitingFor: string[];
  commentCount: number;
}
type LeaveRow = {
  id: string; employeeId: string; employeeNumber?: string; employeeName?: string; leaveTypeId: string; leaveTypeName?: string; leaveTypeCode?: string; color?: string | null; systemKey?: string | null; countMode?: string; branchId: string | null;
  startDate: Date | string; endDate: Date | string; isHalfDay: boolean; halfDayPart: string | null; reason: string | null; status: string; source: string; decisionNote: string | null;
  approvedBy: string | null; approvedAt: Date | null; createdBy: string | null; createdAt: Date; updatedAt: Date; days: unknown; withdrawnAt: Date | null; editedAt: Date | null; approvalRequestId: string | null;
};
function leaveQuery(trx: Trx, orgId: string) {
  return trx.selectFrom('leaveRecords as l').innerJoin('employees as e', 'e.id', 'l.employeeId').innerJoin('leaveTypes as t', 't.id', 'l.leaveTypeId').where('l.organizationId', '=', orgId);
}
const LEAVE_COLUMNS = ['l.id', 'l.employeeId', 'e.employeeNumber', 'e.displayName as employeeName', 'l.leaveTypeId', 't.name as leaveTypeName', 't.code as leaveTypeCode', 't.color', 't.systemKey', 't.countMode', 'l.branchId', 'l.startDate', 'l.endDate', 'l.isHalfDay', 'l.halfDayPart', 'l.reason', 'l.status', 'l.source', 'l.decisionNote', 'l.approvedBy', 'l.approvedAt', 'l.createdBy', 'l.createdAt', 'l.updatedAt', 'l.days', 'l.withdrawnAt', 'l.editedAt', 'l.approvalRequestId'] as const;
const minDateOf = (rows: LeaveRow[]) => rows.map((r) => isoDate(r.startDate)).sort()[0]!;
const maxDateOf = (rows: LeaveRow[]) => rows.map((r) => isoDate(r.endDate)).sort().pop()!;

/** DTOs for a page of rows: the engine request (status, level, who it waits for), comment counts, and `days` for rows written before v2. */
export async function toLeaveDtos(trx: Trx, orgId: string, rows: LeaveRow[]): Promise<LeaveRecordDto[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const requestIds = [...new Set(rows.map((r) => r.approvalRequestId).filter((x): x is string => !!x))];
  const missingDays = rows.filter((r) => r.days === null || r.days === undefined);
  const extra = await withSystemScope(trx, orgId, async (t) => {
    const requests = requestIds.length ? await t.selectFrom('approvalRequests').select(['id', 'status', 'currentStep']).where('organizationId', '=', orgId).where('id', 'in', requestIds).execute() : [];
    const steps = requestIds.length ? await t.selectFrom('approvalSteps').select(['requestId', (eb) => eb.fn.countAll<string>().as('n')]).where('requestId', 'in', requestIds).groupBy('requestId').execute() : [];
    const comments = await t.selectFrom('leaveRequestComments').select(['leaveRecordId', (eb) => eb.fn.countAll<string>().as('n')]).where('organizationId', '=', orgId).where('leaveRecordId', 'in', ids).groupBy('leaveRecordId').execute();
    const cals = missingDays.length ? await loadWorkingCalendars(t, orgId, missingDays.map((r) => r.employeeId), minDateOf(missingDays), maxDateOf(missingDays)) : new Map();
    return { requests, steps, comments, cals };
  });
  const waiting = await waitingForByRequest(trx, orgId, extra.requests.filter((r) => r.status === 'PENDING').map((r) => r.id));
  const reqById = new Map(extra.requests.map((r) => [r.id, r]));
  return rows.map((r) => {
    const req = r.approvalRequestId ? reqById.get(r.approvalRequestId) : undefined;
    const range = { startDate: isoDate(r.startDate), endDate: isoDate(r.endDate), isHalfDay: r.isHalfDay };
    const cal = extra.cals.get(r.employeeId);
    const days = r.days !== null && r.days !== undefined ? Number(r.days) : cal ? countLeaveDaysByMode(range, cal, r.countMode === 'calendar' ? 'calendar' : 'working') : null;
    return {
      id: r.id, employeeId: r.employeeId, ...(r.employeeNumber ? { employeeNumber: r.employeeNumber } : {}), ...(r.employeeName ? { employeeName: r.employeeName } : {}), leaveTypeId: r.leaveTypeId, ...(r.leaveTypeName ? { leaveTypeName: r.leaveTypeName } : {}),
      branchId: r.branchId, ...range, halfDayPart: r.halfDayPart, reason: r.reason, status: r.status, source: r.source, decisionNote: r.decisionNote, approvedBy: r.approvedBy, approvedAt: isoDateTimeOrNull(r.approvedAt), createdBy: r.createdBy,
      createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt),
      ...(r.leaveTypeCode ? { leaveTypeCode: String(r.leaveTypeCode) } : {}), color: r.color ?? null, compOff: r.systemKey === COMP_OFF_SYSTEM_KEY,
      days, withdrawnAt: isoDateTimeOrNull(r.withdrawnAt), editedAt: isoDateTimeOrNull(r.editedAt),
      approvalRequestId: r.approvalRequestId, approvalStatus: req?.status ?? null, approvalCurrentStep: req?.currentStep ?? null, approvalStepCount: req ? Number(extra.steps.find((s) => s.requestId === req.id)?.n ?? 0) : null,
      approvalWaitingFor: req && req.status === 'PENDING' ? waiting.get(req.id) ?? [] : [],
      commentCount: Number(extra.comments.find((c) => c.leaveRecordId === r.id)?.n ?? 0),
    };
  });
}

export async function listLeaveRecords(deps: ApiDeps, actor: Actor, orgId: string, q: { page: number; pageSize: number; employeeId?: string; branchId?: string; leaveTypeId?: string; status?: string; from?: string; to?: string }) {
  const grant = requirePermission(actor.principal, orgId, 'leave.view');
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    let base = leaveQuery(trx, orgId);
    if (scope) base = base.where('l.branchId', 'in', scope);
    if (q.employeeId) base = base.where('l.employeeId', '=', q.employeeId);
    if (q.leaveTypeId) base = base.where('l.leaveTypeId', '=', q.leaveTypeId);
    if (q.status) base = base.where('l.status', '=', q.status as LeaveStatus);
    if (q.from) base = base.where('l.endDate', '>=', dv(q.from));
    if (q.to) base = base.where('l.startDate', '<=', dv(q.to));
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = (await base.select(LEAVE_COLUMNS).orderBy('l.startDate', 'desc').orderBy('l.id').limit(page.pageSize).offset(page.offset).execute()) as LeaveRow[];
    return { data: await toLeaveDtos(trx, orgId, rows), total };
  });
}
async function loadRow(trx: Trx, orgId: string, id: string): Promise<(LeaveRow & { departmentId: string | null }) | undefined> {
  return (await leaveQuery(trx, orgId).select([...LEAVE_COLUMNS, 'e.departmentId']).where('l.id', '=', id).executeTakeFirst()) as (LeaveRow & { departmentId: string | null }) | undefined;
}

/** Any day of [start, end] inside an active lock for the employee's branch (or an organisation-wide lock) → PERIOD_LOCKED (holders of attendance.lock_period may pass, B-54). */
export async function assertLeaveRangeUnlocked(trx: Trx, orgId: string, branchId: string | null, start: string, end: string, grant?: MembershipGrant): Promise<{ lockedOverride: boolean }> {
  return checkLeaveRangeLock(trx, orgId, branchId, start, end, grant);
}
/** Full-day overlap with the employee's PENDING / INFO_REQUESTED / APPROVED leave → CONFLICT. */
export async function assertNoLeaveOverlap(trx: Trx, orgId: string, employeeId: string, start: string, end: string, excludeId?: string): Promise<void> {
  return assertNoOverlap(trx, orgId, employeeId, { startDate: start, endDate: end, isHalfDay: false, halfDayPart: null }, excludeId);
}

export type LeaveWriteResult = LeaveRecordDto & { recalculationJobId: string | null; warnings: LeaveWarningDto[] };

/**
 * HR records leave. Validated like a self-service request, except that advance notice and the consecutive-day cap only
 * warn (HR records after the fact); a type without approval is approved at once; otherwise it goes through the approval
 * engine (entity LEAVE, units = the days it charges): with a workflow for the employee it is a PENDING request routed like
 * any other; without one it is approved at once (the request row still exists — Finance parity). HR recording their OWN
 * leave is never self-approved: it is routed to the leave.approve holders in reach, like a self-service request.
 */
export async function createLeaveRecord(deps: ApiDeps, actor: Actor, orgId: string, input: LeaveRecordInput): Promise<LeaveWriteResult> {
  const grant = requirePermission(actor.principal, orgId, 'leave.manage');
  if (input.isHalfDay && input.startDate !== input.endDate) throw errors.validation('Half-day leave must be a single day.', { issues: [{ path: 'endDate', message: 'Must equal startDate' }] });
  return runUser(deps.db, actor, async (trx) => {
    const emp = await loadLeaveEmployee(trx, orgId, input.employeeId);
    if (!emp) throw errors.validation('Employee not found.', { issues: [{ path: 'employeeId', message: 'Unknown employee' }] });
    requireBranchAccess(grant, emp.branchId);
    const halfDayPart = input.isHalfDay ? input.halfDayPart ?? 'FIRST_HALF' : null;
    const ev = await evaluateLeaveRequest(trx, orgId, { employee: emp, leaveTypeId: input.leaveTypeId, startDate: input.startDate, endDate: input.endDate, isHalfDay: input.isHalfDay, asHr: true });
    const lock = await checkLeaveRangeLock(trx, orgId, emp.branchId, input.startDate, input.endDate, grant);
    await assertNoOverlap(trx, orgId, input.employeeId, { startDate: input.startDate, endDate: input.endDate, isHalfDay: input.isHalfDay, halfDayPart });
    const row = await trx.insertInto('leaveRecords').values({ organizationId: orgId, employeeId: input.employeeId, leaveTypeId: input.leaveTypeId, branchId: emp.branchId, startDate: input.startDate, endDate: input.endDate, isHalfDay: input.isHalfDay, halfDayPart, days: ev.days, reason: input.reason ?? null, status: 'PENDING', createdBy: actor.userId }).returning('id').executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'leave.recorded', 'leave_record', { entityId: row.id, branchId: emp.branchId, newValue: { ...input, days: ev.days, ...(ev.warnings.length ? { warnings: ev.warnings.map((w) => w.code) } : {}) }, ...(lock.lockedOverride ? { reason: 'locked period (attendance.lock_period)' } : {}) });
    const own = !!grant.employeeId && grant.employeeId === input.employeeId;
    const submitted = await submit(deps, trx, actor, orgId, {
      entityType: 'LEAVE', entityId: row.id, employeeId: input.employeeId, branchId: emp.branchId, departmentId: emp.departmentId, units: ev.days, requestedBy: actor.userId,
      noWorkflow: own ? { kind: 'PERMISSION', permission: 'leave.approve' } : { kind: 'AUTO_APPROVE' },
      notRequired: !ev.type.requiresApproval,
    });
    await systemStep(trx, orgId, (t) => t.updateTable('leaveRecords').set({ approvalRequestId: submitted.requestId }).where('id', '=', row.id).execute());
    const recalc = submitted.autoApproved ? await recalcLeaveRange(deps, trx, actor, orgId, input.startDate, input.endDate, { branchId: emp.branchId, employeeIds: [input.employeeId], reason: 'leave recorded' }) : null;
    const [dto] = await toLeaveDtos(trx, orgId, [(await loadRow(trx, orgId, row.id))!]);
    return { ...dto!, recalculationJobId: recalc?.jobId ?? null, warnings: ev.warnings };
  });
}

const LEAVE_CONTENT_KEYS = ['leaveTypeId', 'startDate', 'endDate', 'isHalfDay', 'halfDayPart', 'reason'] as const;
const DATE_KEYS = ['leaveTypeId', 'startDate', 'endDate', 'isHalfDay', 'halfDayPart'] as const;

function overturnMessage(status: string): string {
  if (status === 'REJECTED') return 'This leave was rejected through its approval workflow, and that decision stands. Record a new leave request instead.';
  if (status === 'APPROVED') return 'This leave was approved through its approval workflow, and that decision stands. Cancel it instead.';
  return 'A cancelled leave cannot be reopened. Record a new leave request instead.';
}

/**
 * HR changes a leave record — one kind of change per call:
 *  - a DECISION on an undecided leave (PENDING / INFO_REQUESTED → APPROVED / REJECTED) is a decision on its approval
 *    request, through the engine, by the caller: the note is the comment (required to reject); segregation of duties,
 *    levels and modes apply, so approving level 1 of a two-level workflow leaves the leave undecided at level 2. The call
 *    names the level it was taken on (`stepNo`, review P1-2); without it (the pre-v2 web) the caller may only settle a
 *    seat they hold, and anyone else gets the engine's 403;
 *  - CANCELLING (→ CANCELLED) closes a pending request; cancelling approved leave releases its comp-off credits;
 *  - an EDIT of the dates / type / half day / reason. On an undecided leave it voids the request and resubmits it
 *    (Finance B-96); on a decided one it is a correction (leave.manage, audited `leave.corrected`, B-53).
 * Changing the content and the status in one call is refused (review P1-3: approvers decide on what the leave says). A
 * leave decided through the engine keeps agreeing with its request (review P1-4): HR may cancel it, never flip it. Leave
 * recorded before the engine (no request) keeps the direct decision path. INFO_REQUESTED is set by the engine only.
 */
export async function updateLeaveRecord(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: UpdateLeaveRecordInput): Promise<LeaveWriteResult> {
  const grant = requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadRow(trx, orgId, id);
    if (!before) throw errors.notFound('Leave record', id);
    requireBranchAccess(grant, before.branchId);
    const beforeStart = isoDate(before.startDate); const beforeEnd = isoDate(before.endDate);
    const start = input.startDate ?? beforeStart; const end = input.endDate ?? beforeEnd;
    if (end < start) throw errors.validation('endDate must be on/after startDate.', { issues: [{ path: 'endDate', message: 'Before startDate' }] });
    const status = input.status ?? before.status;
    const statusChange = input.status !== undefined && input.status !== before.status;
    const undecided = UNDECIDED_LEAVE.includes(before.status);
    const deciding = statusChange && undecided && (status === 'APPROVED' || status === 'REJECTED');
    if (statusChange && UNDECIDED_LEAVE.includes(status)) {
      throw errors.validation(status === 'INFO_REQUESTED' ? 'Ask the employee for information through the approval request (Approvals → Ask for info).' : 'A leave cannot be put back to pending; record a new request instead.', { issues: [{ path: 'status', message: 'Not allowed' }] });
    }
    const isHalfDay = input.isHalfDay ?? before.isHalfDay;
    const halfDayPart = isHalfDay ? (input.halfDayPart ?? before.halfDayPart ?? 'FIRST_HALF') : null;
    const isChange = (k: (typeof LEAVE_CONTENT_KEYS)[number]) => input[k] !== undefined && JSON.stringify(input[k]) !== JSON.stringify(k === 'startDate' ? beforeStart : k === 'endDate' ? beforeEnd : before[k]);
    const contentChanged = LEAVE_CONTENT_KEYS.some(isChange);
    const datesChanged = DATE_KEYS.some(isChange);
    // review P1-3: the approvers decide on what the leave says — an edit is saved (and resubmitted) before anyone decides
    if (statusChange && contentChanged) throw errors.validation('Save the change to the leave first, then approve, reject or cancel it: approvers decide on what the leave says.', { issues: [{ path: 'status', message: 'Change the leave and its status in separate steps', code: 'DECIDE_SEPARATELY' }] });
    // review P1-4: a decision taken through the approval workflow is not overturned here
    const engineBacked = before.approvalRequestId !== null;
    if (statusChange && !undecided && engineBacked && status !== 'CANCELLED') throw errors.conflict(overturnMessage(before.status), { leaveRecordId: id, approvalRequestId: before.approvalRequestId });
    if (deciding && status === 'REJECTED' && !input.decisionNote) throw errors.validation('A note is required when rejecting leave.', { issues: [{ path: 'decisionNote', message: 'Required' }] });
    // both the range being left and the range being entered must be open (HR unlocks first, then edits — or holds attendance.lock_period)
    const lockA = await checkLeaveRangeLock(trx, orgId, before.branchId, beforeStart, beforeEnd, grant);
    const lockB = datesChanged ? await checkLeaveRangeLock(trx, orgId, before.branchId, start, end, grant) : { lockedOverride: false };
    const pending = await withSystemScope(trx, orgId, (t) => t.selectFrom('approvalRequests').select(['id', 'requestedBy']).where('organizationId', '=', orgId).where('entityType', '=', 'LEAVE').where('entityId', '=', id).where('status', '=', 'PENDING').executeTakeFirst());
    if (deciding && !pending && engineBacked) throw errors.conflict('This leave\'s approval request is no longer open. Refresh the page; if the leave is still undecided, cancel it and record it again.', { leaveRecordId: id, approvalRequestId: before.approvalRequestId });
    if (deciding && !pending && grant.employeeId === before.employeeId) throw errors.forbidden('You cannot approve or reject your own leave request.');
    if (statusChange && status === 'APPROVED' && !deciding && grant.employeeId === before.employeeId) throw errors.forbidden('You cannot approve your own leave.');
    const becomesActive = ACTIVE_LEAVE.includes(status) && (!ACTIVE_LEAVE.includes(before.status) || datesChanged);
    if (becomesActive) await assertNoOverlap(trx, orgId, before.employeeId, { startDate: start, endDate: end, isHalfDay, halfDayPart }, id);

    let warnings: LeaveWarningDto[] = [];
    let recalcFromEngine = false;
    let autoApproved = false;
    if (deciding && pending) {
      // review P1-2: the level the decider saw; a caller who does not name it may only settle a seat they hold
      const stepNo = input.stepNo ?? await seatedStep(trx, orgId, pending.id, actor.userId);
      if (stepNo === null) throw errors.forbidden('You are not an approver of the current step.');
      await decideWithin(deps, trx, actor, orgId, pending.id, { stepNo, decision: status === 'APPROVED' ? 'APPROVE' : 'REJECT', comment: input.decisionNote ?? undefined });
      recalcFromEngine = true; // the leave hook recomputes past days on approval
    } else if (deciding) {
      // leave recorded before the engine (no request): HR decides directly, as before
      const patch: Record<string, unknown> = { status, ...(input.decisionNote !== undefined ? { decisionNote: input.decisionNote } : {}), ...(status === 'APPROVED' ? { approvedBy: actor.userId, approvedAt: new Date() } : {}) };
      await trx.updateTable('leaveRecords').set(patch as never).where('id', '=', id).execute();
      if (status === 'APPROVED') await systemStep(trx, orgId, (t) => bookCompOffForLeave(t, orgId, id));
      const requester = await withSystemScope(trx, orgId, (t) => t.selectFrom('orgMemberships').select('userId').where('organizationId', '=', orgId).where('employeeId', '=', before.employeeId).where('status', '=', 'active').executeTakeFirst());
      if (requester) await emitDomainEvent(trx, { organizationId: orgId, eventType: status === 'APPROVED' ? 'leave.approved' : 'leave.rejected', aggregateType: 'leave_record', aggregateId: id, payload: { userId: requester.userId, employeeId: before.employeeId, leaveTypeName: before.leaveTypeName ?? null, startDate: start, endDate: end, decisionNote: input.decisionNote ?? before.decisionNote }, actorUserId: actor.userId, requestId: actor.requestId });
    } else if (statusChange) {
      // cancelling (any leave), or a direct status change of a leave decided before the engine
      await trx.updateTable('leaveRecords').set({ status: status as LeaveStatus, ...(status === 'APPROVED' ? { approvedBy: actor.userId, approvedAt: new Date() } : {}), ...(input.decisionNote !== undefined ? { decisionNote: input.decisionNote } : {}) }).where('id', '=', id).execute();
      if (undecided && pending) await systemStep(trx, orgId, (t) => cancelForEntity(deps, t, actor, orgId, 'LEAVE', id, input.decisionNote ?? 'Leave cancelled by HR', { source: 'leave_update' }));
      if (before.status === 'APPROVED') await systemStep(trx, orgId, async (t) => releaseCompOffCredits(t, { organizationId: orgId, leaveRecordId: id, asOf: await orgToday(t, orgId) }));
      if (status === 'APPROVED') await systemStep(trx, orgId, (t) => bookCompOffForLeave(t, orgId, id));
    } else {
      // an edit (content and / or the note)
      const content: Record<string, unknown> = {};
      for (const k of LEAVE_CONTENT_KEYS) if (input[k] !== undefined) content[k] = input[k];
      if (input.isHalfDay !== undefined || input.halfDayPart !== undefined) content['halfDayPart'] = halfDayPart;
      if (input.decisionNote !== undefined) content['decisionNote'] = input.decisionNote;
      let days: number | null = before.days === null || before.days === undefined ? null : Number(before.days);
      let requiresApproval: boolean | null = null;
      if (datesChanged) {
        const emp = await loadLeaveEmployee(trx, orgId, before.employeeId);
        if (!emp) throw errors.notFound('Employee record');
        const ev = await evaluateLeaveRequest(trx, orgId, { employee: emp, leaveTypeId: input.leaveTypeId ?? before.leaveTypeId, startDate: start, endDate: end, isHalfDay, asHr: true, excludeRecordId: id });
        warnings = ev.warnings; days = ev.days; requiresApproval = ev.type.requiresApproval;
        content['days'] = days; content['editedAt'] = new Date();
      } else if (contentChanged) content['editedAt'] = new Date();
      if (Object.keys(content).length) await trx.updateTable('leaveRecords').set(content as never).where('id', '=', id).execute();
      if (undecided && contentChanged && pending) {
        // a material edit: the approvers decide on what the leave now says (Finance B-96)
        const needsApproval = requiresApproval ?? (await oneType(trx, orgId, before.leaveTypeId))?.requiresApproval ?? true;
        const resubmitted = await resubmitLeave(deps, trx, actor, orgId, { id, employeeId: before.employeeId, branchId: before.branchId, departmentId: before.departmentId, days, requiresApproval: needsApproval }, { requestedBy: pending.requestedBy ?? actor.userId, reason: 'Leave edited while pending' });
        autoApproved = resubmitted.autoApproved;
      } else if (before.status === 'APPROVED' && datesChanged) {
        // a corrected approved comp-off leave re-books its credits for what it now says
        await systemStep(trx, orgId, async (t) => { await releaseCompOffCredits(t, { organizationId: orgId, leaveRecordId: id, asOf: await orgToday(t, orgId) }); await bookCompOffForLeave(t, orgId, id); });
      }
    }

    const after = (await loadRow(trx, orgId, id))!;
    const [beforeDto] = await toLeaveDtos(trx, orgId, [before]);
    const [afterDto] = await toLeaveDtos(trx, orgId, [after]);
    const diff = diffObjects(beforeDto as unknown as Record<string, unknown>, afterDto as unknown as Record<string, unknown>);
    const correction = !undecided && (contentChanged || statusChange); // B-53: a decided leave changed by HR
    const lockedOverride = lockA.lockedOverride || lockB.lockedOverride;
    const why = [correction ? `post-decision correction of ${before.status.toLowerCase()} leave` : null, lockedOverride ? 'locked period (attendance.lock_period)' : null].filter(Boolean).join('; ');
    await audit(trx, actor, orgId, correction ? 'leave.corrected' : 'leave.updated', 'leave_record', { entityId: id, branchId: before.branchId, ...diff, ...(why ? { reason: why } : {}) });
    // approved leave shapes the daily records: recompute when it appears, changes or disappears (the engine's hook does it for a person's approval)
    const touchesAttendance = !recalcFromEngine && (before.status === 'APPROVED' || after.status === 'APPROVED' || autoApproved);
    const recalc = touchesAttendance ? await recalcLeaveRange(deps, trx, actor, orgId, minDate(beforeStart, start), maxDate(beforeEnd, end), { branchId: before.branchId, employeeIds: [before.employeeId], reason: 'leave changed' }) : null;
    return { ...afterDto!, recalculationJobId: recalc?.jobId ?? null, warnings };
  });
}

export async function deleteLeaveRecord(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<{ recalculationJobId: string | null }> {
  const grant = requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadRow(trx, orgId, id);
    if (!before) throw errors.notFound('Leave record', id);
    requireBranchAccess(grant, before.branchId);
    if (before.status === 'CANCELLED') throw errors.invalidState('The leave record is already cancelled.');
    const lock = await checkLeaveRangeLock(trx, orgId, before.branchId, isoDate(before.startDate), isoDate(before.endDate), grant);
    await trx.updateTable('leaveRecords').set({ status: 'CANCELLED' }).where('id', '=', id).execute();
    if (UNDECIDED_LEAVE.includes(before.status)) await systemStep(trx, orgId, (t) => cancelForEntity(deps, t, actor, orgId, 'LEAVE', id, 'Leave cancelled by HR', { source: 'leave_delete' }));
    if (before.status === 'APPROVED') await systemStep(trx, orgId, async (t) => releaseCompOffCredits(t, { organizationId: orgId, leaveRecordId: id, asOf: await orgToday(t, orgId) }));
    const [dto] = await toLeaveDtos(trx, orgId, [before]);
    await audit(trx, actor, orgId, 'leave.cancelled', 'leave_record', { entityId: id, branchId: before.branchId, oldValue: dto, ...(lock.lockedOverride ? { reason: 'locked period (attendance.lock_period)' } : {}) });
    const recalc = before.status === 'APPROVED' ? await recalcLeaveRange(deps, trx, actor, orgId, isoDate(before.startDate), isoDate(before.endDate), { branchId: before.branchId, employeeIds: [before.employeeId], reason: 'leave cancelled' }) : null;
    return { recalculationJobId: recalc?.jobId ?? null };
  });
}
