import type { ApprovalRequestStatus, SelfShiftAssignmentDto, SelfShiftDayDto, SelfShiftDto, SelfShiftSwapInput, ShiftSwapDto, ShiftSwapStatus, SwapCandidateDto } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { addDays, errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { likeContains } from '../../lib/pagination.js';
import { type Actor, audit, runUser, withSystemScope } from '../../lib/service.js';
import { isoDate, isoDateOrNull, isoDateTime, isoDateTimeOrNull } from '../../lib/mappers.js';
import { cancelForEntity, submit } from '../approvals/engine.js';
import { systemStep } from '../features/context.js';
import { dv } from '../features/sql-helpers.js';
import { emitToUsers, isPeriodLocked, isWorking, loadEmployeeCtx, localInstant, lockEmployee, portalSelf, userIdsOfEmployees, type EmployeeCtx } from './common.js';
import { seatSecondaryManager } from './line-manager.js';
import { resolveDays, worksShift, type ResolvedDay } from './shift-resolve.js';
import { loadSwap, SWAP_COLUMNS, type SwapRow } from './swap-effects.js';

/**
 * The portal's shift tab and shift swaps (HR portal Prompt 4). The tab shows the shift the engine resolves for today and
 * the next 14 days (assignment, rotation pattern or the organisation's default shift; weekly offs, holidays, leave) and the
 * assignments that have applied to the employee. A swap exchanges ONE day's shift with a colleague of the same branch who
 * works a different shift that day; it is routed like a note (SHIFT_SWAP workflow, else the requester's line manager with
 * the secondary standing in) and applied on approval by two one-day assignments (swap-effects.ts). The colleague is told
 * when it is filed and decided; they do not need to consent through the system (the manager's decision covers it).
 */

const UPCOMING_DAYS = 14;
const SWAP_AHEAD_DAYS = 90;
const SHIFT_KEYS = ['attendance.view_own', 'attendance.view', 'shift.request_swap'] as const;

function toDay(d: ResolvedDay, swaps: SwapRow[], names: Map<string, string>, employeeId: string): SelfShiftDayDto {
  const swap = swaps.find((s) => isoDate(s.swapDate) === d.date && (s.status === 'pending' || s.status === 'approved'));
  const other = swap ? (swap.requesterEmployeeId === employeeId ? swap.targetEmployeeId : swap.requesterEmployeeId) : null;
  return {
    date: d.date, shift: d.shift, source: d.source, isOff: d.isOff, holidayName: d.holidayName, onLeave: d.onLeave,
    swap: swap ? { id: swap.id, status: swap.status, withEmployeeName: other ? names.get(other) ?? null : null } : null,
  };
}

async function swapsOf(t: Trx, orgId: string, employeeId: string, from?: string, to?: string): Promise<SwapRow[]> {
  let q = t.selectFrom('shiftSwapRequests').select(SWAP_COLUMNS).where('organizationId', '=', orgId).where((eb) => eb.or([eb('requesterEmployeeId', '=', employeeId), eb('targetEmployeeId', '=', employeeId)]));
  if (from) q = q.where('swapDate', '>=', dv(from));
  if (to) q = q.where('swapDate', '<=', dv(to));
  return (await q.orderBy('swapDate', 'desc').orderBy('createdAt', 'desc').limit(200).execute()) as SwapRow[];
}

async function employeeNames(t: Trx, orgId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  return new Map((await t.selectFrom('employees').select(['id', 'displayName']).where('organizationId', '=', orgId).where('id', 'in', unique).execute()).map((e) => [e.id, e.displayName]));
}

export async function getMyShift(deps: ApiDeps, actor: Actor, orgId: string): Promise<SelfShiftDto> {
  const self = portalSelf(actor, orgId, ...SHIFT_KEYS);
  return runUser(deps.db, actor, async (trx) => {
    const emp = await loadEmployeeCtx(trx, orgId, self.employeeId);
    const today = localInstant(new Date(), emp.timezone).date;
    const days = await resolveDays(trx, orgId, emp, today, addDays(today, UPCOMING_DAYS));
    return withSystemScope(trx, orgId, async (t) => {
      const swaps = await swapsOf(t, orgId, emp.id, today, addDays(today, UPCOMING_DAYS));
      const names = await employeeNames(t, orgId, swaps.flatMap((s) => [s.requesterEmployeeId, s.targetEmployeeId]));
      // what applied to the employee: their own assignments and those of their branch / department / teams / the organisation
      const targets = [emp.id, emp.branchId, orgId, ...(emp.departmentId ? [emp.departmentId] : []), ...emp.teamIds];
      const assignments = await t.selectFrom('shiftAssignments as a').leftJoin('shifts as s', 's.id', 'a.shiftId').leftJoin('shiftPatterns as p', 'p.id', 'a.shiftPatternId')
        .select(['a.id', 'a.targetType', 'a.targetId', 'a.effectiveFrom', 'a.effectiveTo', 's.name as shiftName', 'p.name as patternName'])
        .where('a.organizationId', '=', orgId).where('a.targetId', 'in', targets).orderBy('a.effectiveFrom', 'desc').orderBy('a.id').limit(40).execute();
      const swapAssignmentIds = new Set((await t.selectFrom('shiftSwapRequests').select(['requesterAssignmentId', 'targetAssignmentId']).where('organizationId', '=', orgId).where('status', '=', 'approved')
        .where((eb) => eb.or([eb('requesterEmployeeId', '=', emp.id), eb('targetEmployeeId', '=', emp.id)])).execute()).flatMap((r) => [r.requesterAssignmentId, r.targetAssignmentId]).filter((x): x is string => !!x));
      const history: SelfShiftAssignmentDto[] = assignments
        .filter((a) => (a.targetType === 'EMPLOYEE' ? a.targetId === emp.id : a.targetType === 'BRANCH' ? a.targetId === emp.branchId : a.targetType === 'ORGANIZATION' ? a.targetId === orgId : a.targetType === 'DEPARTMENT' ? a.targetId === emp.departmentId : emp.teamIds.includes(a.targetId)))
        .map((a) => ({ id: a.id, targetType: a.targetType, shiftName: a.shiftName, patternName: a.patternName, effectiveFrom: isoDate(a.effectiveFrom), effectiveTo: isoDateOrNull(a.effectiveTo), isSwap: swapAssignmentIds.has(a.id) }));
      const dtos = days.map((d) => toDay(d, swaps, names, emp.id));
      return { date: today, timezone: emp.timezone, today: dtos[0]!, upcoming: dtos.slice(1), history };
    });
  });
}

/** Colleagues of the requester's branch and their shift on the date (eligible = works a different shift that day). */
export async function listSwapCandidates(deps: ApiDeps, actor: Actor, orgId: string, q: { date: string; search?: string | undefined }): Promise<SwapCandidateDto[]> {
  const self = portalSelf(actor, orgId, 'shift.request_swap');
  return runUser(deps.db, actor, async (trx) => {
    const me = await loadEmployeeCtx(trx, orgId, self.employeeId);
    const [mine] = await resolveDays(trx, orgId, me, q.date, q.date);
    const colleagues = await withSystemScope(trx, orgId, async (t) => {
      let base = t.selectFrom('employees').select(['id', 'displayName', 'employeeNumber']).where('organizationId', '=', orgId).where('branchId', '=', me.branchId).where('id', '!=', me.id)
        .where('deletedAt', 'is', null).where('employmentStatus', 'not in', ['terminated', 'resigned']);
      if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb('displayName', 'ilike', like), eb('employeeNumber', 'ilike', like)])); }
      return base.orderBy('displayName').limit(50).execute();
    });
    const out: SwapCandidateDto[] = [];
    for (const c of colleagues) {
      const ctx = await loadEmployeeCtx(trx, orgId, c.id);
      const [day] = await resolveDays(trx, orgId, ctx, q.date, q.date);
      out.push({ employeeId: c.id, displayName: c.displayName, employeeNumber: c.employeeNumber, shift: day?.shift ?? null, isOff: !!day && (day.isOff || day.onLeave || !!day.holidayName), eligible: !!day && !!mine && worksShift(day) && worksShift(mine) && day.shiftId !== mine.shiftId });
    }
    return out;
  });
}

async function swapDtos(trx: Trx, orgId: string, employeeId: string, rows: SwapRow[]): Promise<ShiftSwapDto[]> {
  if (rows.length === 0) return [];
  return withSystemScope(trx, orgId, async (t) => {
    const names = await employeeNames(t, orgId, rows.flatMap((r) => [r.requesterEmployeeId, r.targetEmployeeId]));
    const shiftIds = [...new Set(rows.flatMap((r) => [r.requesterShiftId, r.targetShiftId]))];
    const shifts = new Map((await t.selectFrom('shifts').select(['id', 'name', 'code']).where('organizationId', '=', orgId).where('id', 'in', shiftIds).execute()).map((s) => [s.id, s]));
    const requestIds = [...new Set(rows.map((r) => r.approvalRequestId).filter((x): x is string => !!x))];
    const reqs = new Map(requestIds.length ? (await t.selectFrom('approvalRequests').select(['id', 'status']).where('id', 'in', requestIds).execute()).map((r) => [r.id, r.status as ApprovalRequestStatus]) : []);
    return rows.map((r) => {
      const rs = shifts.get(r.requesterShiftId); const ts = shifts.get(r.targetShiftId);
      return {
        id: r.id, swapDate: isoDate(r.swapDate), status: r.status, reason: r.reason, requesterEmployeeId: r.requesterEmployeeId, requesterName: names.get(r.requesterEmployeeId) ?? null,
        targetEmployeeId: r.targetEmployeeId, targetName: names.get(r.targetEmployeeId) ?? null, requesterShift: rs ? { id: rs.id, name: rs.name, code: rs.code } : null, targetShift: ts ? { id: ts.id, name: ts.name, code: ts.code } : null,
        mine: r.requesterEmployeeId === employeeId, approvalRequestId: r.approvalRequestId, approvalStatus: r.approvalRequestId ? reqs.get(r.approvalRequestId) ?? null : null,
        decidedAt: isoDateTimeOrNull(r.decidedAt), decisionNote: r.decisionNote, createdAt: isoDateTime(r.createdAt),
      };
    });
  });
}

export async function listMySwaps(deps: ApiDeps, actor: Actor, orgId: string, q: { status?: ShiftSwapStatus | undefined }): Promise<ShiftSwapDto[]> {
  const self = portalSelf(actor, orgId, ...SHIFT_KEYS);
  return runUser(deps.db, actor, async (trx) => {
    const rows = (await withSystemScope(trx, orgId, (t) => swapsOf(t, orgId, self.employeeId))).filter((r) => !q.status || r.status === q.status);
    return swapDtos(trx, orgId, self.employeeId, rows);
  });
}

async function assertSwapPossible(trx: Trx, orgId: string, me: EmployeeCtx, other: EmployeeCtx, date: string): Promise<{ mine: ResolvedDay; theirs: ResolvedDay }> {
  const [mine] = await resolveDays(trx, orgId, me, date, date);
  const [theirs] = await resolveDays(trx, orgId, other, date, date);
  if (!mine || !worksShift(mine)) throw errors.validation('You have no shift to swap on this day (day off, holiday or leave).', { issues: [{ path: 'date', message: 'No shift that day' }] });
  if (!theirs || !worksShift(theirs)) throw errors.validation('Your colleague has no shift on this day.', { issues: [{ path: 'withEmployeeId', message: 'No shift that day' }] });
  if (mine.shiftId === theirs.shiftId) throw errors.validation('You both work the same shift on this day; there is nothing to swap.', { issues: [{ path: 'withEmployeeId', message: 'Same shift' }] });
  return { mine, theirs };
}

export async function requestSwap(deps: ApiDeps, actor: Actor, orgId: string, input: SelfShiftSwapInput): Promise<ShiftSwapDto> {
  const self = portalSelf(actor, orgId, 'shift.request_swap');
  if (input.withEmployeeId === self.employeeId) throw errors.validation('Choose a colleague to swap with.', { issues: [{ path: 'withEmployeeId', message: 'Yourself' }] });
  return runUser(deps.db, actor, async (trx) => {
    await lockEmployee(trx, 'shift-swap', self.employeeId);
    const me = await loadEmployeeCtx(trx, orgId, self.employeeId);
    const today = localInstant(new Date(), me.timezone).date;
    if (!isWorking(me, today)) throw errors.forbidden('Your employment is not active.');
    if (input.date < today) throw errors.validation('A past day cannot be swapped.', { issues: [{ path: 'date', message: 'In the past' }] });
    if (input.date > addDays(today, SWAP_AHEAD_DAYS)) throw errors.validation(`A swap can be requested at most ${SWAP_AHEAD_DAYS} days ahead.`, { issues: [{ path: 'date', message: 'Too far ahead' }] });
    const other = await loadEmployeeCtx(trx, orgId, input.withEmployeeId).catch(() => null);
    if (!other || !isWorking(other, input.date)) throw errors.validation('Colleague not found.', { issues: [{ path: 'withEmployeeId', message: 'Unknown colleague' }] });
    if (other.branchId !== me.branchId) throw errors.validation('Shifts can only be swapped within your branch.', { issues: [{ path: 'withEmployeeId', message: 'Other branch' }] });
    if (await isPeriodLocked(trx, orgId, me.branchId, input.date)) throw errors.periodLocked('The attendance period of this date is locked.');
    const { mine, theirs } = await assertSwapPossible(trx, orgId, me, other, input.date);
    const clash = await withSystemScope(trx, orgId, (t) => t.selectFrom('shiftSwapRequests').select('id').where('organizationId', '=', orgId).where('swapDate', '=', dv(input.date)).where('status', '=', 'pending')
      .where((eb) => eb.or([eb('requesterEmployeeId', 'in', [me.id, other.id]), eb('targetEmployeeId', 'in', [me.id, other.id])])).executeTakeFirst());
    if (clash) throw errors.conflict('A swap for one of you on this day is already waiting for a decision.', { swapId: clash.id });
    const row = await systemStep(trx, orgId, (t) => t.insertInto('shiftSwapRequests').values({
      organizationId: orgId, requesterEmployeeId: me.id, targetEmployeeId: other.id, branchId: me.branchId, swapDate: input.date, requesterShiftId: mine.shiftId!, targetShiftId: theirs.shiftId!, reason: input.reason, status: 'pending', createdBy: actor.userId,
    }).returning('id').executeTakeFirstOrThrow());
    const submitted = await submit(deps, trx, actor, orgId, { entityType: 'SHIFT_SWAP', entityId: row.id, employeeId: me.id, branchId: me.branchId, departmentId: me.departmentId, units: null, requestedBy: actor.userId, noWorkflow: { kind: 'MANAGER' } });
    await systemStep(trx, orgId, async (t) => {
      await seatSecondaryManager(t, actor, orgId, { requestId: submitted.requestId, entityType: 'SHIFT_SWAP', entityId: row.id, employeeId: me.id, secondaryManagerEmployeeId: me.secondaryManagerEmployeeId, employeeName: me.displayName });
      await t.updateTable('shiftSwapRequests').set({ approvalRequestId: submitted.requestId }).where('id', '=', row.id).execute();
    });
    await emitToUsers(trx, actor, orgId, 'shift.swap_requested', { type: 'shift_swap', id: row.id }, await userIdsOfEmployees(trx, orgId, [other.id]),
      { swapId: row.id, swapDate: input.date, requesterEmployeeId: me.id, requesterName: me.displayName, requesterShiftName: mine.shift?.name ?? null, targetShiftName: theirs.shift?.name ?? null, approvalRequestId: submitted.requestId });
    await audit(trx, actor, orgId, 'shift.swap_requested', 'shift_swap', { entityId: row.id, branchId: me.branchId, newValue: { ...input, requesterShiftId: mine.shiftId, targetShiftId: theirs.shiftId } });
    const saved = (await withSystemScope(trx, orgId, (t) => loadSwap(t, orgId, row.id)))!;
    return (await swapDtos(trx, orgId, me.id, [saved]))[0]!;
  });
}

export async function cancelMySwap(deps: ApiDeps, actor: Actor, orgId: string, id: string, reason?: string): Promise<ShiftSwapDto> {
  const self = portalSelf(actor, orgId, 'shift.request_swap');
  const why = reason && reason.trim().length >= 3 ? reason.trim() : 'Withdrawn by the employee';
  return runUser(deps.db, actor, async (trx) => {
    const before = await withSystemScope(trx, orgId, (t) => loadSwap(t, orgId, id));
    if (!before || (before.requesterEmployeeId !== self.employeeId && before.targetEmployeeId !== self.employeeId)) throw errors.notFound('Shift swap', id);
    if (before.requesterEmployeeId !== self.employeeId) throw errors.forbidden('Only the colleague who asked for the swap can withdraw it.');
    if (before.status !== 'pending') throw errors.invalidState(`Only a pending swap can be withdrawn (current: ${before.status}).`);
    await systemStep(trx, orgId, async (t) => {
      const res = await t.updateTable('shiftSwapRequests').set({ status: 'cancelled', decidedBy: actor.userId, decidedAt: new Date(), decisionNote: why }).where('id', '=', id).where('status', '=', 'pending').executeTakeFirst();
      if (Number(res.numUpdatedRows) !== 1) throw errors.conflict('The swap changed meanwhile. Please refresh.');
      await cancelForEntity(deps, t, actor, orgId, 'SHIFT_SWAP', id, why, { source: 'self_service' });
    });
    await audit(trx, actor, orgId, 'shift.swap_withdrawn', 'shift_swap', { entityId: id, branchId: before.branchId, reason: why });
    return (await swapDtos(trx, orgId, self.employeeId, [(await withSystemScope(trx, orgId, (t) => loadSwap(t, orgId, id)))!]))[0]!;
  });
}
