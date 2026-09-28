import type { Trx } from '@flowza/database';
import type { ApiDeps } from '../../deps.js';
import { type Actor, withSystemScope } from '../../lib/service.js';
import { enqueueRecalculation, orgToday } from '../features/recalc.js';
import { systemStep } from '../features/context.js';
import { invalidateForEntity, submit, type SubmitResult } from '../approvals/engine.js';
import { loadDelegationMap } from '../approvals/context.js';

/**
 * The leave lifecycle steps HR's Leave page and the portal share (leave v2): recompute after a change that alters what
 * the day engine reads, resubmit an edited request (Finance B-96), and find the level a caller is seated on (review P1-2:
 * a decision that does not name its level may only settle a seat the caller holds).
 */

export const UNDECIDED_LEAVE: readonly string[] = ['PENDING', 'INFO_REQUESTED'];
export const ACTIVE_LEAVE: readonly string[] = ['PENDING', 'INFO_REQUESTED', 'APPROVED'];

const minDate = (a: string, b: string) => (a < b ? a : b);

/**
 * Recompute the days of a leave change that touches dates up to today (future dates are computed when they arrive). Only
 * APPROVED leave shapes a daily record, so callers invoke this when approved leave appears, changes or disappears.
 */
export async function recalcLeaveRange(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, from: string, to: string | null, extra: { branchId?: string | null; employeeIds?: string[] | null; reason: string }): Promise<{ requestId: string; jobId: string } | null> {
  const today = await orgToday(trx, orgId);
  if (from > today) return null;
  return enqueueRecalculation(deps, trx, actor, orgId, { fromDate: from, toDate: minDate(to ?? today, today), branchId: extra.branchId ?? null, employeeIds: extra.employeeIds ?? null, reason: extra.reason });
}

export interface LeaveSubmitSubject { id: string; employeeId: string; branchId: string | null; departmentId: string | null; days: number | null; requiresApproval: boolean }

/**
 * Void the pending request of an edited leave and submit the leave afresh (Finance B-96): the approvers decide on what it
 * now says, from level 1. An open question (INFO_REQUESTED) is answered by the edit, so the leave is PENDING again. A type
 * that needs no approval is approved at once (the caller owns the recompute: `autoApproved`).
 */
export async function resubmitLeave(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, leave: LeaveSubmitSubject, opts: { requestedBy: string; reason: string }): Promise<SubmitResult> {
  await systemStep(trx, orgId, async (t) => {
    await invalidateForEntity(t, actor, orgId, 'LEAVE', leave.id, opts.reason);
    await t.updateTable('leaveRecords').set({ status: 'PENDING' }).where('organizationId', '=', orgId).where('id', '=', leave.id).where('status', '=', 'INFO_REQUESTED').execute();
  });
  const submitted = await submit(deps, trx, actor, orgId, {
    entityType: 'LEAVE', entityId: leave.id, employeeId: leave.employeeId, branchId: leave.branchId, departmentId: leave.departmentId, units: leave.days, requestedBy: opts.requestedBy,
    noWorkflow: { kind: 'PERMISSION', permission: 'leave.approve' }, notRequired: !leave.requiresApproval,
  });
  await systemStep(trx, orgId, (t) => t.updateTable('leaveRecords').set({ approvalRequestId: submitted.requestId }).where('organizationId', '=', orgId).where('id', '=', leave.id).execute());
  return submitted;
}

/**
 * The current level of a pending request when the caller holds a seat on it: their own actor row, or a pending seat that
 * is delegated to them today. Null otherwise (a permission holder who is not seated must name the level — review P1-2).
 */
export async function seatedStep(trx: Trx, orgId: string, requestId: string, userId: string): Promise<number | null> {
  return withSystemScope(trx, orgId, async (t) => {
    const req = await t.selectFrom('approvalRequests').select(['currentStep', 'status', 'entityType']).where('organizationId', '=', orgId).where('id', '=', requestId).executeTakeFirst();
    if (!req || req.status !== 'PENDING') return null;
    const step = await t.selectFrom('approvalSteps').select(['id', 'stepNo']).where('requestId', '=', requestId).where('stepNo', '=', req.currentStep).where('status', '=', 'PENDING').executeTakeFirst();
    if (!step) return null;
    const actors = await t.selectFrom('approvalStepActors').select(['userId', 'decision']).where('stepId', '=', step.id).execute();
    if (actors.some((a) => a.userId === userId)) return step.stepNo;
    const delegations = await loadDelegationMap(t, orgId, req.entityType, await orgToday(t, orgId));
    return actors.some((a) => a.decision === 'PENDING' && delegations.get(a.userId) === userId) ? step.stepNo : null;
  });
}

/** Names of the people the current level of each pending request is waiting for (the Leave page's "waiting for …"). */
export async function waitingForByRequest(trx: Trx, orgId: string, requestIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!requestIds.length) return out;
  return withSystemScope(trx, orgId, async (t) => {
    const rows = await t.selectFrom('approvalRequests as r')
      .innerJoin('approvalSteps as s', (j) => j.onRef('s.requestId', '=', 'r.id').onRef('s.stepNo', '=', 'r.currentStep'))
      .innerJoin('approvalStepActors as a', 'a.stepId', 's.id')
      .leftJoin('userProfiles as u', 'u.id', 'a.userId')
      .select(['r.id as requestId', 'u.fullName', 'u.email'])
      .where('r.organizationId', '=', orgId).where('r.id', 'in', [...requestIds]).where('r.status', '=', 'PENDING').where('a.decision', '=', 'PENDING')
      .orderBy('u.fullName').execute();
    for (const r of rows) {
      const name = r.fullName || r.email || null;
      if (!name) continue;
      const list = out.get(r.requestId) ?? [];
      if (!list.includes(name)) list.push(name);
      out.set(r.requestId, list);
    }
    return out;
  });
}
