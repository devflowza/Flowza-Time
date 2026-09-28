import type { ApprovalEntity } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import type { Actor } from '../../lib/service.js';
import { emitTargeted, recordEvent } from '../approvals/engine.js';
import { orgToday } from '../features/recalc.js';
import { dv } from '../features/sql-helpers.js';

/**
 * The line-manager routing of the portal's requests (attendance notes, regularisations, shift swaps — HR portal Prompt 4).
 *
 * Without a workflow the engine seats ONE MANAGER level: the primary manager, or — when they cannot act (no login, on leave
 * today) — the secondary, then HR admins, then the owner. Right after that submit the secondary manager is added to the
 * primary's seat as a stand-in (`via_delegation_of` = the primary, resolution path `secondary`): either of the two decides for
 * the reporting line, and because they share ONE seat a rejection by either is final, exactly as with a single manager.
 * Only for a request the engine routed to the primary manager (no workflow, level 1, path `primary`); never the subject nor
 * another party to the request (a swap's colleague — review P0-2).
 * Runs in a system step (the approval tables are written by the platform only).
 */
export async function seatSecondaryManager(t: Trx, actor: Actor, orgId: string, input: { requestId: string; entityType: ApprovalEntity; entityId: string; employeeId: string; secondaryManagerEmployeeId: string | null; employeeName: string | null; /** False: the caller tells the level itself (review 8-P2-8). */ notify?: boolean }): Promise<string | null> {
  if (!input.secondaryManagerEmployeeId || input.secondaryManagerEmployeeId === input.employeeId) return null;
  const req = await t.selectFrom('approvalRequests').select(['id', 'status', 'workflowId', 'currentStep', 'subjectUserId', 'requestedBy', 'coSubjectEmployeeIds', 'coSubjectUserIds']).where('organizationId', '=', orgId).where('id', '=', input.requestId).executeTakeFirst();
  if (!req || req.status !== 'PENDING' || req.workflowId !== null || req.currentStep !== 1) return null;
  // a party to the request (a swap's colleague — review P0-2) never stands in, whichever manager they are
  if (req.coSubjectEmployeeIds?.includes(input.secondaryManagerEmployeeId)) return null;
  const step = await t.selectFrom('approvalSteps').select(['id', 'approverType', 'approverUserId', 'resolutionPath']).where('requestId', '=', req.id).where('stepNo', '=', 1).executeTakeFirst();
  if (!step || step.approverType !== 'MANAGER' || step.resolutionPath !== 'primary' || !step.approverUserId) return null;
  const secondary = await t.selectFrom('orgMemberships').select('userId').where('organizationId', '=', orgId).where('employeeId', '=', input.secondaryManagerEmployeeId).where('status', '=', 'active').orderBy('createdAt').executeTakeFirst();
  if (!secondary || secondary.userId === step.approverUserId || secondary.userId === req.subjectUserId || secondary.userId === req.requestedBy || req.coSubjectUserIds?.includes(secondary.userId)) return null;
  // somebody on approved leave today cannot stand in (the resolver applies the same rule to the primary)
  const today = await orgToday(t, orgId);
  const onLeave = await t.selectFrom('leaveRecords').select('id').where('organizationId', '=', orgId).where('employeeId', '=', input.secondaryManagerEmployeeId).where('status', '=', 'APPROVED')
    .where('startDate', '<=', dv(today)).where('endDate', '>=', dv(today)).executeTakeFirst();
  if (onLeave) return null;
  const existing = await t.selectFrom('approvalStepActors').select('id').where('stepId', '=', step.id).where('userId', '=', secondary.userId).executeTakeFirst();
  if (existing) return null;
  await t.insertInto('approvalStepActors').values({ organizationId: orgId, stepId: step.id, userId: secondary.userId, viaDelegationOf: step.approverUserId, resolutionPath: 'secondary' }).execute();
  await recordEvent(t, orgId, req.id, 'secondary_seated', actor.userId, { stepNo: 1, userId: secondary.userId, standsInFor: step.approverUserId });
  if (input.notify !== false) await emitTargeted(t, orgId, 'approval.pending', req.id, [secondary.userId], { requestId: req.id, entityType: input.entityType, entityId: input.entityId, employeeId: input.employeeId, employeeName: input.employeeName, requestedBy: req.requestedBy, stepId: step.id, stepNo: 1, secondaryManager: true }, { userId: actor.userId, requestId: actor.requestId });
  return secondary.userId;
}

/** The pending request of a document with its current level (read inside the caller's transaction, system scope). */
export async function pendingRequestOf(t: Trx, orgId: string, entityType: ApprovalEntity, entityId: string): Promise<{ id: string; currentStep: number } | null> {
  const r = await t.selectFrom('approvalRequests').select(['id', 'currentStep']).where('organizationId', '=', orgId).where('entityType', '=', entityType).where('entityId', '=', entityId).where('status', '=', 'PENDING').executeTakeFirst();
  return r ?? null;
}

/** Request ids (among `requestIds`) whose CURRENT level has a pending seat of `userId` — themselves or an approver who delegates to them today. */
export async function routedToUser(t: Trx, orgId: string, entityType: ApprovalEntity, userId: string, delegators: readonly string[], requestIds?: readonly string[]): Promise<Set<string>> {
  if (requestIds && requestIds.length === 0) return new Set();
  let q = t.selectFrom('approvalRequests as r')
    .innerJoin('approvalSteps as s', (j) => j.onRef('s.requestId', '=', 'r.id').onRef('s.stepNo', '=', 'r.currentStep'))
    .innerJoin('approvalStepActors as a', 'a.stepId', 's.id')
    .select('r.id').distinct()
    .where('r.organizationId', '=', orgId).where('r.entityType', '=', entityType).where('r.status', '=', 'PENDING').where('a.decision', '=', 'PENDING')
    .where((eb) => eb.or([eb('a.userId', '=', userId), ...(delegators.length ? [eb('a.userId', 'in', [...delegators])] : [])]));
  if (requestIds) q = q.where('r.id', 'in', [...requestIds]);
  return new Set((await q.execute()).map((r) => r.id));
}
