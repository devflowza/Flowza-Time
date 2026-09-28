import type { ApprovalContextDto, ShiftSwapStatus } from '@flowza/contracts';
import { enqueueRecompute, writeAudit, type Trx } from '@flowza/database';
import { addDays, errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { isoDate, isoDateOrNull } from '../../lib/mappers.js';
import type { HookContext } from '../approvals/hooks/index.js';
import { orgToday } from '../features/recalc.js';
import { dv } from '../features/sql-helpers.js';
import { emitToUsers, isPeriodLocked, loadEmployeeCtx, userIdsOfEmployees } from './common.js';
import { resolveDays, worksShift } from './shift-resolve.js';

/**
 * What an approved shift swap DOES (HR portal Prompt 4): two one-day EMPLOYEE shift assignments — the requester works the
 * colleague's shift on the day and the colleague the requester's. An employee-level assignment already covering the day is
 * split around it (the schedule's no-overlap exclusion allows one employee assignment per date), so the rest of that
 * assignment is untouched. Before anything is written the swap is re-validated: both still work, on the shifts captured
 * when it was requested, outside a locked period — otherwise the decision is refused (409) and the request stays open.
 * Days up to today are recomputed at once (SHIFT_CHANGE). System scope; never imports the engine.
 */

export type SwapRow = {
  id: string; organizationId: string; requesterEmployeeId: string; targetEmployeeId: string; branchId: string | null; swapDate: Date | string; requesterShiftId: string; targetShiftId: string; reason: string;
  status: ShiftSwapStatus; approvalRequestId: string | null; requesterAssignmentId: string | null; targetAssignmentId: string | null; decidedBy: string | null; decidedAt: Date | null; decisionNote: string | null; createdBy: string | null; createdAt: Date; updatedAt: Date;
};
export const SWAP_COLUMNS = ['id', 'organizationId', 'requesterEmployeeId', 'targetEmployeeId', 'branchId', 'swapDate', 'requesterShiftId', 'targetShiftId', 'reason', 'status', 'approvalRequestId', 'requesterAssignmentId', 'targetAssignmentId', 'decidedBy', 'decidedAt', 'decisionNote', 'createdBy', 'createdAt', 'updatedAt'] as const;

export async function loadSwap(t: Trx, orgId: string, id: string): Promise<SwapRow | undefined> {
  return (await t.selectFrom('shiftSwapRequests').select(SWAP_COLUMNS).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst()) as SwapRow | undefined;
}

/** Put the employee on `shiftId` for exactly `date`, splitting an employee-level assignment that covers the day. Returns the new assignment's id and what was touched. */
async function placeOneDayShift(t: Trx, orgId: string, employeeId: string, branchId: string, date: string, shiftId: string, actorUserId: string): Promise<{ id: string; touched: Array<{ id: string; from: string; to: string | null; action: string }> }> {
  const next = addDays(date, 1);
  const touched: Array<{ id: string; from: string; to: string | null; action: string }> = [];
  const covering = await t.selectFrom('shiftAssignments').select(['id', 'branchId', 'shiftId', 'shiftPatternId', 'effectiveFrom', 'effectiveTo'])
    .where('organizationId', '=', orgId).where('targetType', '=', 'EMPLOYEE').where('targetId', '=', employeeId)
    .where('effectiveFrom', '<=', dv(date)).where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', dv(date))])).execute();
  for (const a of covering) {
    const from = isoDate(a.effectiveFrom); const to = isoDateOrNull(a.effectiveTo);
    if (from === date) {
      if (to !== null && to <= next) { await t.deleteFrom('shiftAssignments').where('id', '=', a.id).execute(); touched.push({ id: a.id, from, to, action: 'replaced' }); }
      else { await t.updateTable('shiftAssignments').set({ effectiveFrom: next }).where('id', '=', a.id).execute(); touched.push({ id: a.id, from, to, action: 'starts_after_swap' }); }
    } else {
      await t.updateTable('shiftAssignments').set({ effectiveTo: date }).where('id', '=', a.id).execute();
      touched.push({ id: a.id, from, to, action: 'ends_before_swap' });
      if (to === null || to > next) {
        const rest = await t.insertInto('shiftAssignments').values({ organizationId: orgId, targetType: 'EMPLOYEE', targetId: employeeId, branchId: a.branchId, shiftId: a.shiftId, shiftPatternId: a.shiftPatternId, effectiveFrom: next, effectiveTo: to, createdBy: actorUserId }).returning('id').executeTakeFirstOrThrow();
        touched.push({ id: rest.id, from: next, to, action: 'continues_after_swap' });
      }
    }
  }
  const row = await t.insertInto('shiftAssignments').values({ organizationId: orgId, targetType: 'EMPLOYEE', targetId: employeeId, branchId, shiftId, shiftPatternId: null, effectiveFrom: date, effectiveTo: next, createdBy: actorUserId }).returning('id').executeTakeFirstOrThrow();
  return { id: row.id, touched };
}

export async function applySwapApproval(deps: ApiDeps, t: Trx, ctx: Pick<HookContext, 'orgId' | 'entityId' | 'actor' | 'comment'>): Promise<void> {
  const swap = await loadSwap(t, ctx.orgId, ctx.entityId);
  if (!swap || swap.status !== 'pending') return;
  const date = isoDate(swap.swapDate);
  const [requester, target] = await Promise.all([loadEmployeeCtx(t, ctx.orgId, swap.requesterEmployeeId), loadEmployeeCtx(t, ctx.orgId, swap.targetEmployeeId)]);
  const [rd] = await resolveDays(t, ctx.orgId, requester, date, date);
  const [td] = await resolveDays(t, ctx.orgId, target, date, date);
  if (!rd || !td || !worksShift(rd) || !worksShift(td) || rd.shiftId !== swap.requesterShiftId || td.shiftId !== swap.targetShiftId) {
    throw errors.invalidState('The shifts of this day changed since the swap was requested; reject it and ask for a new one.');
  }
  if (await isPeriodLocked(t, ctx.orgId, requester.branchId, date) || await isPeriodLocked(t, ctx.orgId, target.branchId, date)) throw errors.periodLocked('The attendance period of the swap day is locked.');
  const mine = await placeOneDayShift(t, ctx.orgId, requester.id, requester.branchId, date, swap.targetShiftId, ctx.actor.userId);
  const theirs = await placeOneDayShift(t, ctx.orgId, target.id, target.branchId, date, swap.requesterShiftId, ctx.actor.userId);
  const now = new Date();
  await t.updateTable('shiftSwapRequests').set({ status: 'approved', decidedBy: ctx.actor.userId, decidedAt: now, decisionNote: ctx.comment, requesterAssignmentId: mine.id, targetAssignmentId: theirs.id }).where('id', '=', swap.id).where('status', '=', 'pending').execute();
  await writeAudit(t, { organizationId: ctx.orgId, actorUserId: ctx.actor.userId, action: 'shift.swap_applied', entityType: 'shift_swap', entityId: swap.id, branchId: swap.branchId, newValue: { date, requesterAssignmentId: mine.id, targetAssignmentId: theirs.id, requesterTouched: mine.touched, targetTouched: theirs.touched }, requestId: ctx.actor.requestId });
  if (date <= await orgToday(t, ctx.orgId)) {
    for (const employeeId of [requester.id, target.id]) await enqueueRecompute(deps.queue, { organizationId: ctx.orgId, employeeId, date, reason: 'SHIFT_CHANGE', triggeredBy: ctx.actor.userId, correlationId: ctx.actor.requestId }, t);
  }
  await emitToUsers(t, ctx.actor, ctx.orgId, 'shift.swap_decided', { type: 'shift_swap', id: swap.id }, await userIdsOfEmployees(t, ctx.orgId, [requester.id, target.id]),
    { swapId: swap.id, swapDate: date, decision: 'approved', comment: ctx.comment, requesterEmployeeId: requester.id, requesterName: requester.displayName, targetEmployeeId: target.id, targetName: target.displayName });
}

export async function applySwapClosed(t: Trx, ctx: Pick<HookContext, 'orgId' | 'entityId' | 'actor' | 'comment'>, status: 'rejected' | 'cancelled'): Promise<void> {
  const swap = await loadSwap(t, ctx.orgId, ctx.entityId);
  if (!swap || swap.status !== 'pending') return;
  await t.updateTable('shiftSwapRequests').set({ status, decidedBy: ctx.actor.userId, decidedAt: new Date(), decisionNote: ctx.comment }).where('id', '=', swap.id).where('status', '=', 'pending').execute();
  if (status === 'rejected') {
    await emitToUsers(t, ctx.actor, ctx.orgId, 'shift.swap_decided', { type: 'shift_swap', id: swap.id }, await userIdsOfEmployees(t, ctx.orgId, [swap.requesterEmployeeId, swap.targetEmployeeId]),
      { swapId: swap.id, swapDate: isoDate(swap.swapDate), decision: 'rejected', comment: ctx.comment, requesterEmployeeId: swap.requesterEmployeeId, targetEmployeeId: swap.targetEmployeeId });
  }
}

export async function swapContexts(t: Trx, orgId: string, ids: string[]): Promise<Map<string, ApprovalContextDto>> {
  const out = new Map<string, ApprovalContextDto>();
  if (ids.length === 0) return out;
  const rows = (await t.selectFrom('shiftSwapRequests').select(SWAP_COLUMNS).where('organizationId', '=', orgId).where('id', 'in', ids).execute()) as SwapRow[];
  if (rows.length === 0) return out;
  const employees = new Map((await t.selectFrom('employees').select(['id', 'displayName']).where('organizationId', '=', orgId).where('id', 'in', [...new Set(rows.flatMap((r) => [r.requesterEmployeeId, r.targetEmployeeId]))]).execute()).map((e) => [e.id, e.displayName]));
  const shifts = new Map((await t.selectFrom('shifts').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', [...new Set(rows.flatMap((r) => [r.requesterShiftId, r.targetShiftId]))]).execute()).map((s) => [s.id, s.name]));
  for (const r of rows) {
    const date = isoDate(r.swapDate);
    const requesterName = employees.get(r.requesterEmployeeId) ?? null; const targetName = employees.get(r.targetEmployeeId) ?? null;
    out.set(r.id, { kind: 'SHIFT_SWAP', summary: `${date} · ${requesterName ?? ''} ⇄ ${targetName ?? ''}`, swap: { id: r.id, swapDate: date, requesterName, targetName, requesterShiftName: shifts.get(r.requesterShiftId) ?? null, targetShiftName: shifts.get(r.targetShiftId) ?? null, reason: r.reason, status: r.status } });
  }
  return out;
}
