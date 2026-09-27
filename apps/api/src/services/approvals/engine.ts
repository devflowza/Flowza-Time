import type { ApprovalDecision, ApprovalEntity, ApprovalEscalationTarget, ApprovalStepMode, ApproverType, DomainEventType, Permission } from '@flowza/contracts';
import { emitDomainEvent, type Trx } from '@flowza/database';
import { collapseSeats, escalationDueAt, evaluateLevel, resolveStepActors, selectWorkflow, type ApprovalStepSpec, type MembershipGrant, type ResolvedActor } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { hasPermission, isTeamMember, requireMembership } from '../../lib/authorize.js';
import { type Actor, audit } from '../../lib/service.js';
import { jsonArray, jsonObject, numberOrNull } from '../../lib/mappers.js';
import { systemStep } from '../features/context.js';
import { orgToday } from '../features/recalc.js';
import { buildResolutionContext, loadDelegationMap } from './context.js';
import { approvePermissionFor, hookFor, viewPermissionFor, type HookContext } from './hooks/index.js';

// ----- shapes ------------------------------------------------------------------------------------------------------------------

export interface SubmitInput {
  entityType: ApprovalEntity;
  entityId: string;
  employeeId: string | null;
  branchId: string | null;
  departmentId?: string | null;
  /** Leave days, overtime minutes… — what workflow tiers (`min_units`) compare against; null when the entity has no size. */
  units?: number | null;
  requestedBy: string;
  /** Without a workflow: approve at once (the request row still exists — Finance parity) or route to holders of a permission. */
  noWorkflow: { kind: 'AUTO_APPROVE' } | { kind: 'PERMISSION'; permission: Permission };
}
export interface SubmitResult { requestId: string; status: 'PENDING' | 'APPROVED'; autoApproved: boolean; stepCount: number; firstStepActorIds: string[] }

export interface DecideInput { stepNo?: number | undefined; decision: ApprovalDecision; comment?: string | undefined; viaEmailToken?: boolean }
export interface DecideOutcome { requestId: string; status: string; noop: boolean; terminal: boolean; stepNo: number; entityType: ApprovalEntity; entityId: string; branchId: string | null }

type ActorRowLite = { userId: string; viaDelegationOf: string | null; decision: string };

/** Everything the decide rules need to know about a caller and a request; shared with the DTO abilities so the UI never shows a button the API refuses. */
export interface DeciderAssessment { ok: boolean; via: 'actor' | 'delegate' | 'permission' | 'owner' | null; delegateOf: string | null; sodBlocked: 'subject' | 'requester' | null; ownerBypass: boolean; branchBlocked: boolean }

export function assessDecider(params: {
  grant: MembershipGrant; userId: string;
  request: { entityType: ApprovalEntity; requestedBy: string | null; subjectUserId: string | null; employeeId: string | null; branchId: string | null; allowSelfApproval: boolean };
  stepActors: readonly ActorRowLite[];
  /** Approvers who delegate to the caller today (entity type already applied). */
  delegators: ReadonlySet<string>;
}): DeciderAssessment {
  const { grant, userId, request } = params;
  const branchBlocked = !grant.allBranches && !!request.branchId && !grant.branchIds.includes(request.branchId);
  const isOwner = grant.roleKey === 'owner';
  const actorRow = params.stepActors.find((a) => a.userId === userId);
  const delegateRow = params.stepActors.find((a) => a.decision === 'PENDING' && a.userId !== userId && params.delegators.has(a.userId));
  const permHolder = hasPermission(grant, approvePermissionFor(request.entityType)) && (hasPermission(grant, viewPermissionFor(request.entityType)) || (!!request.employeeId && isTeamMember(grant, request.employeeId)));
  const via: DeciderAssessment['via'] = actorRow ? 'actor' : delegateRow ? 'delegate' : permHolder ? 'permission' : isOwner ? 'owner' : null;
  let sodBlocked: DeciderAssessment['sodBlocked'] = null;
  let ownerBypass = false;
  if (!request.allowSelfApproval) {
    if (request.subjectUserId && request.subjectUserId === userId) { if (isOwner) ownerBypass = true; else sodBlocked = 'subject'; }
    else if (request.requestedBy === userId && !actorRow) { if (isOwner) ownerBypass = true; else sodBlocked = 'requester'; }
  }
  return { ok: via !== null && sodBlocked === null && !branchBlocked, via, delegateOf: delegateRow?.userId ?? null, sodBlocked, ownerBypass, branchBlocked };
}

// ----- helpers ---------------------------------------------------------------------------------------------------------------

const APPROVER_TYPES: readonly ApproverType[] = ['MANAGER', 'SECONDARY_MANAGER', 'MANAGER_CHAIN', 'HR_ADMIN', 'DEPARTMENT_HEAD', 'BRANCH_MANAGER', 'ROLE', 'USER'];
const MODES: readonly ApprovalStepMode[] = ['ANY', 'ALL', 'QUORUM'];
const ESCALATIONS: readonly ApprovalEscalationTarget[] = ['NEXT_STEP', 'HR_ADMIN', 'OWNER'];

/** Steps as stored (normalised by the migration; tolerant of the v1 seeds' snake_case keys all the same). */
export function parseWorkflowSteps(raw: unknown): ApprovalStepSpec[] {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return jsonArray<Record<string, unknown>>(raw).map((s, i) => {
    const approverType = String(s['approverType'] ?? s['approver_type'] ?? 'ROLE') as ApproverType;
    const mode = String(s['mode'] ?? 'ANY') as ApprovalStepMode;
    const escalateTo = str(s['escalateTo']) as ApprovalEscalationTarget | undefined;
    return {
      order: num(s['order']) ?? i + 1,
      approverType: APPROVER_TYPES.includes(approverType) ? approverType : 'ROLE',
      roleId: str(s['roleId'] ?? s['role_id']),
      userId: str(s['userId'] ?? s['user_id']),
      permission: str(s['permission']),
      chainLevel: num(s['chainLevel']),
      mode: MODES.includes(mode) ? mode : 'ANY',
      requiredCount: num(s['requiredCount']),
      escalateAfterHours: num(s['escalateAfterHours']),
      escalateTo: escalateTo && ESCALATIONS.includes(escalateTo) ? escalateTo : undefined,
    };
  }).sort((a, b) => a.order - b.order);
}

export async function recordEvent(t: Trx, orgId: string, requestId: string, kind: string, actorUserId: string | null, detail: Record<string, unknown> = {}): Promise<void> {
  await t.insertInto('approvalRequestEvents').values({ organizationId: orgId, requestId, kind, actorUserId, detail: JSON.stringify(detail) }).execute();
}

async function requestPayload(t: Trx, orgId: string, req: { id: string; entityType: ApprovalEntity; entityId: string; employeeId: string | null; requestedBy: string | null }): Promise<Record<string, unknown>> {
  const emp = req.employeeId ? await t.selectFrom('employees').select(['displayName', 'employeeNumber']).where('organizationId', '=', orgId).where('id', '=', req.employeeId).executeTakeFirst() : undefined;
  const hook = hookFor(req.entityType);
  let summary: string | null = null;
  if (hook) { const ctx = (await hook.loadContexts(t, orgId, [req.entityId])).get(req.entityId); if (ctx && hook.summary) summary = hook.summary(ctx); }
  return { requestId: req.id, entityType: req.entityType, entityId: req.entityId, employeeId: req.employeeId, employeeName: emp?.displayName ?? null, employeeNumber: emp?.employeeNumber ?? null, requestedBy: req.requestedBy, summary };
}

/** Targeted notification: the relay creates one in-app notification (and e-mail per preference) per user in `userIds`. */
export async function emitTargeted(t: Trx, orgId: string, eventType: DomainEventType, requestId: string, userIds: readonly string[], payload: Record<string, unknown>, actor: { userId: string | null; requestId: string | null }): Promise<void> {
  const ids = [...new Set(userIds.filter((u): u is string => !!u))];
  if (!ids.length) return;
  await emitDomainEvent(t, { organizationId: orgId, eventType, aggregateType: 'approval_request', aggregateId: requestId, payload: { ...payload, userIds: ids }, actorUserId: actor.userId, requestId: actor.requestId });
}

async function loadSteps(t: Trx, requestId: string) {
  const steps = await t.selectFrom('approvalSteps').selectAll().where('requestId', '=', requestId).orderBy('stepNo').execute();
  const actors = steps.length ? await t.selectFrom('approvalStepActors').selectAll().where('stepId', 'in', steps.map((s) => s.id)).orderBy('createdAt').execute() : [];
  return steps.map((s) => ({ ...s, actors: actors.filter((a) => a.stepId === s.id) }));
}
type LoadedStep = Awaited<ReturnType<typeof loadSteps>>[number];

async function lockRequest(t: Trx, orgId: string, requestId: string) {
  const r = await t.selectFrom('approvalRequests').selectAll().where('organizationId', '=', orgId).where('id', '=', requestId).forUpdate().executeTakeFirst();
  if (!r) throw errors.notFound('Approval request', requestId);
  return r;
}
type RequestRow = Awaited<ReturnType<typeof lockRequest>>;

async function workflowAllowsSelf(t: Trx, workflowId: string | null): Promise<boolean> {
  if (!workflowId) return false;
  return (await t.selectFrom('approvalWorkflows').select('allowSelfApproval').where('id', '=', workflowId).executeTakeFirst())?.allowSelfApproval ?? false;
}

function hookCtx(orgId: string, req: RequestRow, actor: Actor, comment: string | null, auto = false): HookContext {
  return { orgId, requestId: req.id, entityId: req.entityId, employeeId: req.employeeId, branchId: req.branchId, actor, comment, auto };
}

async function skipPending(t: Trx, stepIds: string[], comment: string | null): Promise<void> {
  if (!stepIds.length) return;
  await t.updateTable('approvalStepActors').set({ decision: 'SKIPPED', ...(comment ? { comment } : {}) }).where('stepId', 'in', stepIds).where('decision', '=', 'PENDING').execute();
  await t.updateTable('approvalSteps').set({ status: 'SKIPPED' }).where('id', 'in', stepIds).where('status', '=', 'PENDING').execute();
}

async function completeApproved(deps: ApiDeps, t: Trx, actor: Actor, orgId: string, req: RequestRow, comment: string | null, detail: Record<string, unknown>): Promise<void> {
  const now = new Date();
  await t.updateTable('approvalRequests').set({ status: 'APPROVED', completedAt: now, decidedBy: actor.userId, infoRequestedAt: null }).where('id', '=', req.id).execute();
  await recordEvent(t, orgId, req.id, 'approved', actor.userId, { ...detail, comment });
  await hookFor(req.entityType)?.onApproved(deps, t, hookCtx(orgId, req, actor, comment));
  const payload = await requestPayload(t, orgId, req);
  await emitTargeted(t, orgId, 'approval.decided', req.id, [req.requestedBy, req.subjectUserId].filter((u): u is string => !!u && u !== actor.userId), { ...payload, decision: 'APPROVED', comment, decidedBy: actor.userId }, actor);
}

async function completeRejected(deps: ApiDeps, t: Trx, actor: Actor, orgId: string, req: RequestRow, steps: LoadedStep[], comment: string | null, detail: Record<string, unknown>): Promise<void> {
  const now = new Date();
  await skipPending(t, steps.filter((s) => s.stepNo > req.currentStep && s.status === 'PENDING').map((s) => s.id), null);
  await t.updateTable('approvalRequests').set({ status: 'REJECTED', completedAt: now, decidedBy: actor.userId, infoRequestedAt: null }).where('id', '=', req.id).execute();
  await recordEvent(t, orgId, req.id, 'rejected', actor.userId, { ...detail, comment });
  await hookFor(req.entityType)?.onRejected(deps, t, hookCtx(orgId, req, actor, comment));
  const payload = await requestPayload(t, orgId, req);
  await emitTargeted(t, orgId, 'approval.decided', req.id, [req.requestedBy, req.subjectUserId].filter((u): u is string => !!u && u !== actor.userId), { ...payload, decision: 'REJECTED', comment, decidedBy: actor.userId }, actor);
}

/** Make `next` the current step: activation time, escalation deadline, notification of its approvers. */
export async function activateStep(t: Trx, orgId: string, req: { id: string; entityType: ApprovalEntity; entityId: string; employeeId: string | null; requestedBy: string | null }, next: LoadedStep, actor: { userId: string | null; requestId: string | null }, now = new Date()): Promise<void> {
  const dueAt = escalationDueAt({ escalateAfterHours: next.escalateAfterHours, escalateTo: next.escalateTo }, now);
  await t.updateTable('approvalRequests').set({ currentStep: next.stepNo }).where('id', '=', req.id).execute();
  await t.updateTable('approvalSteps').set({ activatedAt: now, dueAt }).where('id', '=', next.id).execute();
  await recordEvent(t, orgId, req.id, 'advanced', actor.userId, { stepNo: next.stepNo, dueAt: dueAt?.toISOString() ?? null });
  const payload = await requestPayload(t, orgId, req);
  await emitTargeted(t, orgId, 'approval.pending', req.id, next.actors.filter((a) => a.decision === 'PENDING').map((a) => a.userId), { ...payload, stepId: next.id, stepNo: next.stepNo }, actor);
}

// ----- submit --------------------------------------------------------------------------------------------------------------------

/**
 * Create the request for a document inside the caller's transaction (system step): pick the workflow (branch-specific over
 * organisation-wide, applies-to, tiers), resolve EVERY level now, snapshot the actors (delegates stamped), arm the first
 * level's escalation, notify its approvers. Without a workflow the caller's policy decides: an APPROVED request whose hook
 * runs at once, or a single synthetic level routed to a permission (self-service leave / corrections are never applied
 * without a person deciding).
 */
export async function submit(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, input: SubmitInput): Promise<SubmitResult> {
  return systemStep(trx, orgId, async (t) => {
    const existing = await t.selectFrom('approvalRequests').select('id').where('organizationId', '=', orgId).where('entityType', '=', input.entityType).where('entityId', '=', input.entityId).where('status', '=', 'PENDING').executeTakeFirst();
    if (existing) throw errors.conflict('This item already has a pending approval request.', { requestId: existing.id });
    const today = await orgToday(t, orgId);
    const workflows = await t.selectFrom('approvalWorkflows').selectAll().where('organizationId', '=', orgId).where('entityType', '=', input.entityType).where('status', '=', 'active').where('isDefault', '=', true).execute();
    const workflow = selectWorkflow(workflows.map((w) => ({ id: w.id, name: w.name, branchId: w.branchId, appliesTo: jsonObject(w.appliesTo) as { branchIds?: string[]; departmentIds?: string[] }, minUnits: numberOrNull(w.minUnits), isDefault: w.isDefault, status: w.status })), { branchId: input.branchId, departmentId: input.departmentId ?? null, units: input.units ?? null });
    const row = workflow ? workflows.find((w) => w.id === workflow.id)! : null;
    const base = { organizationId: orgId, workflowId: row?.id ?? null, entityType: input.entityType, entityId: input.entityId, branchId: input.branchId, employeeId: input.employeeId, departmentId: input.departmentId ?? null, units: input.units ?? null, requestedBy: input.requestedBy };
    const subjectUserId = input.employeeId ? (await t.selectFrom('orgMemberships').select('userId').where('organizationId', '=', orgId).where('employeeId', '=', input.employeeId).where('status', '=', 'active').orderBy('createdAt').executeTakeFirst())?.userId ?? null : null;

    if (!row && input.noWorkflow.kind === 'AUTO_APPROVE') {
      const now = new Date();
      const req = await t.insertInto('approvalRequests').values({ ...base, subjectUserId, currentStep: 1, status: 'APPROVED', completedAt: now, decidedBy: actor.userId }).returningAll().executeTakeFirstOrThrow();
      await recordEvent(t, orgId, req.id, 'auto_approved', actor.userId, { reason: 'no workflow configured for this entity type' });
      await hookFor(input.entityType)?.onApproved(deps, t, hookCtx(orgId, req, actor, null, true));
      return { requestId: req.id, status: 'APPROVED', autoApproved: true, stepCount: 0, firstStepActorIds: [] };
    }
    const steps: ApprovalStepSpec[] = row ? parseWorkflowSteps(row.steps) : [{ order: 1, approverType: 'ROLE', permission: input.noWorkflow.kind === 'PERMISSION' ? input.noWorkflow.permission : 'attendance.approve', mode: 'ANY' }];
    const ctx = await buildResolutionContext(t, orgId, { employeeId: input.employeeId, branchId: input.branchId, requestedBy: input.requestedBy, entityType: input.entityType, viewPermission: viewPermissionFor(input.entityType), today, allowSelfApproval: row?.allowSelfApproval ?? false });
    const resolved = steps.map((spec) => ({ spec, res: resolveStepActors(spec, ctx) }));
    resolved.forEach(({ spec, res }, i) => {
      if (res.unresolved) throw errors.validation(`Approval workflow level ${i + 1} has no eligible approver (${res.reason ?? 'nobody resolved'}). Ask HR to check the reporting line or the workflow.`);
      if (spec.mode === 'QUORUM' && (res.requiredCount ?? 1) > res.seatCount) throw errors.validation(`Approval workflow level ${i + 1} requires ${res.requiredCount} approvals but only ${res.seatCount} approver(s) resolved.`);
    });
    const now = new Date();
    const req = await t.insertInto('approvalRequests').values({ ...base, subjectUserId, currentStep: 1, status: 'PENDING' }).returningAll().executeTakeFirstOrThrow();
    let firstActors: ResolvedActor[] = [];
    let firstStepId: string | null = null;
    for (const [i, { spec, res }] of resolved.entries()) {
      const seats = new Set(res.actors.map((a) => a.viaDelegationOf ?? a.userId));
      const single = seats.size === 1 ? [...seats][0]! : null;
      const step = await t.insertInto('approvalSteps').values({
        organizationId: orgId, requestId: req.id, stepNo: i + 1, approverType: spec.approverType, approverRoleId: spec.roleId ?? null, approverUserId: spec.approverType === 'USER' ? spec.userId ?? null : single,
        permissionKey: spec.permission ?? null, mode: spec.mode, requiredCount: res.requiredCount, resolutionPath: res.path, resolutionReason: res.reason, status: 'PENDING',
        escalateTo: spec.escalateTo ?? null, escalateAfterHours: spec.escalateAfterHours ?? null, activatedAt: i === 0 ? now : null, dueAt: i === 0 ? escalationDueAt(spec, now) : null,
      }).returning('id').executeTakeFirstOrThrow();
      if (res.actors.length) await t.insertInto('approvalStepActors').values(res.actors.map((a) => ({ organizationId: orgId, stepId: step.id, userId: a.userId, viaDelegationOf: a.viaDelegationOf, resolutionPath: a.viaDelegationOf ? 'delegate' : res.path }))).execute();
      if (i === 0) { firstActors = res.actors; firstStepId = step.id; }
    }
    await recordEvent(t, orgId, req.id, 'submitted', actor.userId, { workflowId: row?.id ?? null, workflowName: row?.name ?? null, steps: resolved.map(({ spec, res }, i) => ({ stepNo: i + 1, approverType: spec.approverType, mode: spec.mode, path: res.path, actors: res.actors.length })) });
    const payload = await requestPayload(t, orgId, req);
    await emitTargeted(t, orgId, 'approval.pending', req.id, firstActors.map((a) => a.userId), { ...payload, stepId: firstStepId, stepNo: 1 }, actor);
    return { requestId: req.id, status: 'PENDING', autoApproved: false, stepCount: resolved.length, firstStepActorIds: firstActors.map((a) => a.userId) };
  });
}

// ----- decide --------------------------------------------------------------------------------------------------------------------

/**
 * One decision inside the caller's transaction. Under FOR UPDATE on the request so concurrent approvers serialise; the
 * second one re-reads the committed state. Authorisation: an actor of the current step, an active delegate of one, a
 * holder of the entity's approve permission (organisation-wide, or for a direct report), or the owner. Segregation of
 * duties by the SUBJECT: the person the request is about never decides it (the owner may, and it is logged); the
 * requester never decides unless resolution kept them as the only approver. A closed request or a non-current step is a
 * conflict (409), a repeated decision by the same actor is a harmless no-op.
 */
export async function decideWithin(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, requestId: string, input: DecideInput): Promise<DecideOutcome> {
  const grant = requireMembership(actor.principal, orgId);
  if (input.decision === 'REJECT' && !input.comment) throw errors.validation('A comment is required when rejecting.', { issues: [{ path: 'comment', message: 'Required' }] });
  const comment = input.comment ?? null;
  const outcome = await systemStep(trx, orgId, async (t): Promise<DecideOutcome> => {
    const req = await lockRequest(t, orgId, requestId);
    if (req.status !== 'PENDING') throw errors.invalidState(`The request is already ${req.status}.`);
    const stepNo = input.stepNo ?? req.currentStep;
    if (stepNo !== req.currentStep) throw errors.invalidState(`Step ${stepNo} is not the current step (${req.currentStep}).`);
    const steps = await loadSteps(t, req.id);
    const step = steps.find((s) => s.stepNo === req.currentStep && s.status === 'PENDING');
    if (!step) throw errors.invalidState('The request has no pending step.');
    const today = await orgToday(t, orgId);
    const delegations = await loadDelegationMap(t, orgId, req.entityType, today);
    const delegators = new Set([...delegations.entries()].filter(([, delegate]) => delegate === actor.userId).map(([delegator]) => delegator));
    const allowSelfApproval = await workflowAllowsSelf(t, req.workflowId);
    const check = assessDecider({ grant, userId: actor.userId, request: { entityType: req.entityType, requestedBy: req.requestedBy, subjectUserId: req.subjectUserId, employeeId: req.employeeId, branchId: req.branchId, allowSelfApproval }, stepActors: step.actors, delegators });
    if (check.branchBlocked) throw errors.forbidden('This request is outside your branch scope.');
    if (check.sodBlocked === 'subject') throw errors.forbidden('Self-approval is not permitted: this request is about you.');
    if (check.sodBlocked === 'requester') throw errors.forbidden('You cannot approve or reject your own request; cancel it instead.');
    if (!check.via) throw errors.forbidden('You are not an approver of the current step.');
    if (check.ownerBypass) await recordEvent(t, orgId, req.id, 'sod_owner_bypass', actor.userId, { stepNo: step.stepNo, decision: input.decision });
    const now = new Date();
    const decision = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const mine = step.actors.find((a) => a.userId === actor.userId);
    let override = false;
    if (mine) {
      if (mine.decision !== 'PENDING') return { requestId: req.id, status: req.status, noop: true, terminal: false, stepNo: step.stepNo, entityType: req.entityType, entityId: req.entityId, branchId: req.branchId };
      await t.updateTable('approvalStepActors').set({ decision, decidedAt: now, comment }).where('id', '=', mine.id).execute();
    } else {
      const viaDelegationOf = check.via === 'delegate' ? check.delegateOf : null;
      override = check.via === 'permission' || check.via === 'owner';
      await t.insertInto('approvalStepActors').values({ organizationId: orgId, stepId: step.id, userId: actor.userId, viaDelegationOf, resolutionPath: override ? (check.via === 'owner' ? 'owner_override' : 'override') : 'delegate', decision, decidedAt: now, comment }).execute();
      if (override) await recordEvent(t, orgId, req.id, 'override', actor.userId, { stepNo: step.stepNo, decision, via: check.via });
    }
    const rows = await t.selectFrom('approvalStepActors').select(['userId', 'viaDelegationOf', 'decision']).where('stepId', '=', step.id).execute();
    const level = override ? (decision === 'APPROVED' ? 'satisfied' : 'rejected') : evaluateLevel(step.mode as ApprovalStepMode, step.requiredCount, collapseSeats(rows));
    const eventDetail = { stepNo: step.stepNo, decision, comment, via: check.via, delegateOf: check.delegateOf, mode: step.mode, requiredCount: step.requiredCount };
    if (level === 'open') {
      await recordEvent(t, orgId, req.id, decision === 'APPROVED' ? 'approval_recorded' : 'rejection_recorded', actor.userId, { ...eventDetail, levelOpen: true });
      return { requestId: req.id, status: req.status, noop: false, terminal: false, stepNo: step.stepNo, entityType: req.entityType, entityId: req.entityId, branchId: req.branchId };
    }
    await t.updateTable('approvalSteps').set({ status: level === 'satisfied' ? 'APPROVED' : 'REJECTED', actedBy: actor.userId, actedAt: now, comment }).where('id', '=', step.id).execute();
    await t.updateTable('approvalStepActors').set({ decision: 'SKIPPED' }).where('stepId', '=', step.id).where('decision', '=', 'PENDING').execute();
    if (level === 'rejected') {
      await recordEvent(t, orgId, req.id, 'step_rejected', actor.userId, eventDetail);
      await completeRejected(deps, t, actor, orgId, req, steps, comment, eventDetail);
      return { requestId: req.id, status: 'REJECTED', noop: false, terminal: true, stepNo: step.stepNo, entityType: req.entityType, entityId: req.entityId, branchId: req.branchId };
    }
    await recordEvent(t, orgId, req.id, 'step_approved', actor.userId, eventDetail);
    const next = steps.find((s) => s.stepNo > req.currentStep && s.status === 'PENDING');
    if (next) {
      await activateStep(t, orgId, req, next, actor, now);
      return { requestId: req.id, status: 'PENDING', noop: false, terminal: false, stepNo: step.stepNo, entityType: req.entityType, entityId: req.entityId, branchId: req.branchId };
    }
    await completeApproved(deps, t, actor, orgId, req, comment, eventDetail);
    return { requestId: req.id, status: 'APPROVED', noop: false, terminal: true, stepNo: step.stepNo, entityType: req.entityType, entityId: req.entityId, branchId: req.branchId };
  });
  if (!outcome.noop) {
    const action = input.decision === 'APPROVE' ? (outcome.status === 'APPROVED' ? 'approval.approved' : 'approval.step_approved') : (outcome.terminal ? 'approval.rejected' : 'approval.step_rejected');
    await audit(trx, actor, orgId, action, 'approval_request', { entityId: requestId, branchId: outcome.branchId, newValue: { stepNo: outcome.stepNo, comment, entityType: outcome.entityType, entityId: outcome.entityId, viaEmailToken: input.viaEmailToken ?? false } });
  }
  return outcome;
}

// ----- cancel / invalidate / reassign / info ------------------------------------------------------------------------------------

export interface CloseOutcome { requestId: string; entityType: ApprovalEntity; entityId: string; branchId: string | null; status: string }

/** Cancel a pending request from inside a system step (the API's cancel, leave withdrawal, correction cancellation). */
export async function cancelWithin(deps: ApiDeps, t: Trx, actor: Actor, orgId: string, requestId: string, reason: string | null, opts: { runHook?: boolean; source?: string } = {}): Promise<CloseOutcome | null> {
  const req = await lockRequest(t, orgId, requestId);
  if (req.status !== 'PENDING') return null;
  const steps = await loadSteps(t, req.id);
  const current = steps.find((s) => s.stepNo === req.currentStep);
  await skipPending(t, steps.filter((s) => s.status === 'PENDING').map((s) => s.id), null);
  await t.updateTable('approvalRequests').set({ status: 'CANCELLED', completedAt: new Date(), cancelledBy: actor.userId, cancelReason: reason, infoRequestedAt: null }).where('id', '=', req.id).execute();
  await recordEvent(t, orgId, req.id, 'cancelled', actor.userId, { reason, source: opts.source ?? 'api' });
  if (opts.runHook !== false) await hookFor(req.entityType)?.onCancelled?.(deps, t, hookCtx(orgId, req, actor, reason));
  const payload = await requestPayload(t, orgId, req);
  await emitTargeted(t, orgId, 'approval.decided', req.id, (current?.actors ?? []).filter((a) => a.decision === 'PENDING' || a.decision === 'SKIPPED').map((a) => a.userId).filter((u) => u !== actor.userId), { ...payload, decision: 'CANCELLED', comment: reason, decidedBy: actor.userId }, actor);
  return { requestId: req.id, entityType: req.entityType, entityId: req.entityId, branchId: req.branchId, status: 'CANCELLED' };
}

/** Cancel the pending request of a document that was withdrawn (system step; no-op when there is none). */
export async function cancelForEntity(deps: ApiDeps, t: Trx, actor: Actor, orgId: string, entityType: ApprovalEntity, entityId: string, reason: string | null, opts: { runHook?: boolean; source?: string } = {}): Promise<CloseOutcome | null> {
  const pending = await t.selectFrom('approvalRequests').select('id').where('organizationId', '=', orgId).where('entityType', '=', entityType).where('entityId', '=', entityId).where('status', '=', 'PENDING').executeTakeFirst();
  return pending ? cancelWithin(deps, t, actor, orgId, pending.id, reason, { runHook: false, ...opts }) : null;
}

/**
 * A material edit voids the pending request (Finance B-96): actors and later steps are skipped, the request reads
 * INVALIDATED, the approvers of the current step are told, and the caller resubmits. System step.
 */
export async function invalidateForEntity(t: Trx, actor: Actor, orgId: string, entityType: ApprovalEntity, entityId: string, reason: string): Promise<CloseOutcome | null> {
  const pending = await t.selectFrom('approvalRequests').select('id').where('organizationId', '=', orgId).where('entityType', '=', entityType).where('entityId', '=', entityId).where('status', '=', 'PENDING').executeTakeFirst();
  if (!pending) return null;
  const req = await lockRequest(t, orgId, pending.id);
  if (req.status !== 'PENDING') return null;
  const steps = await loadSteps(t, req.id);
  const current = steps.find((s) => s.stepNo === req.currentStep);
  await skipPending(t, steps.filter((s) => s.status === 'PENDING').map((s) => s.id), null);
  await t.updateTable('approvalRequests').set({ status: 'INVALIDATED', completedAt: new Date(), invalidationReason: reason, infoRequestedAt: null }).where('id', '=', req.id).execute();
  await recordEvent(t, orgId, req.id, 'invalidated', actor.userId, { reason });
  const payload = await requestPayload(t, orgId, req);
  await emitTargeted(t, orgId, 'approval.decided', req.id, (current?.actors ?? []).map((a) => a.userId).filter((u) => u !== actor.userId), { ...payload, decision: 'INVALIDATED', comment: reason, decidedBy: actor.userId }, actor);
  return { requestId: req.id, entityType: req.entityType, entityId: req.entityId, branchId: req.branchId, status: 'INVALIDATED' };
}

/**
 * Who may withdraw (Finance B-97/98): the requester, a scoped approve-permission holder, approval.manage, the owner. The
 * person a request is about but did not file (HR recorded it for them) cannot withdraw it — they can answer questions on it.
 */
export function canCancel(grant: MembershipGrant, userId: string, req: { entityType: ApprovalEntity; requestedBy: string | null; subjectUserId: string | null; employeeId: string | null; branchId: string | null }): boolean {
  if (req.requestedBy === userId) return true;
  if (!grant.allBranches && req.branchId && !grant.branchIds.includes(req.branchId)) return false;
  if (grant.roleKey === 'owner' || hasPermission(grant, 'approval.manage')) return true;
  return hasPermission(grant, approvePermissionFor(req.entityType)) && (hasPermission(grant, viewPermissionFor(req.entityType)) || (!!req.employeeId && isTeamMember(grant, req.employeeId)));
}

export async function cancelRequest(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, requestId: string, reason: string | null): Promise<CloseOutcome> {
  const grant = requireMembership(actor.principal, orgId);
  const out = await systemStep(trx, orgId, async (t) => {
    const req = await lockRequest(t, orgId, requestId);
    if (!canCancel(grant, actor.userId, req)) throw errors.forbidden('Only the requester, the person concerned or an approver can withdraw this request.');
    if (req.status !== 'PENDING') throw errors.invalidState(`The request is already ${req.status}.`);
    return (await cancelWithin(deps, t, actor, orgId, requestId, reason, { source: 'api' }))!;
  });
  await audit(trx, actor, orgId, 'approval.cancelled', 'approval_request', { entityId: requestId, branchId: out.branchId, reason, newValue: { entityType: out.entityType, entityId: out.entityId } });
  return out;
}

/** approval.manage (or the owner) moves the current level to somebody else: the pending seats are skipped, the new person is the seat. */
export async function reassignRequest(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, requestId: string, input: { stepNo?: number | undefined; userId: string; reason: string }): Promise<CloseOutcome> {
  const grant = requireMembership(actor.principal, orgId);
  if (!hasPermission(grant, 'approval.manage') && grant.roleKey !== 'owner') throw errors.forbidden('Missing permission: approval.manage.');
  const out = await systemStep(trx, orgId, async (t) => {
    const req = await lockRequest(t, orgId, requestId);
    if (!grant.allBranches && req.branchId && !grant.branchIds.includes(req.branchId)) throw errors.forbidden('This request is outside your branch scope.');
    if (req.status !== 'PENDING') throw errors.invalidState(`The request is already ${req.status}.`);
    const stepNo = input.stepNo ?? req.currentStep;
    if (stepNo !== req.currentStep) throw errors.invalidState(`Step ${stepNo} is not the current step (${req.currentStep}).`);
    const steps = await loadSteps(t, req.id);
    const step = steps.find((s) => s.stepNo === stepNo && s.status === 'PENDING');
    if (!step) throw errors.invalidState('The request has no pending step.');
    const member = await t.selectFrom('orgMemberships').select('userId').where('organizationId', '=', orgId).where('userId', '=', input.userId).where('status', '=', 'active').executeTakeFirst();
    if (!member) throw errors.validation('The new approver is not an active member of this organisation.', { userId: input.userId });
    const allowSelf = await workflowAllowsSelf(t, req.workflowId);
    if (!allowSelf && req.subjectUserId && req.subjectUserId === input.userId) throw errors.validation('The person a request is about cannot be its approver.');
    const previous = step.actors.filter((a) => a.decision === 'PENDING').map((a) => a.userId);
    await t.updateTable('approvalStepActors').set({ decision: 'SKIPPED', comment: `reassigned: ${input.reason}` }).where('stepId', '=', step.id).where('decision', '=', 'PENDING').execute();
    await t.insertInto('approvalStepActors').values({ organizationId: orgId, stepId: step.id, userId: input.userId, viaDelegationOf: null, resolutionPath: 'reassigned' })
      .onConflict((oc) => oc.columns(['stepId', 'userId']).doUpdateSet({ decision: 'PENDING', decidedAt: null, comment: null, resolutionPath: 'reassigned' })).execute();
    await t.updateTable('approvalSteps').set({ approverUserId: input.userId, resolutionPath: 'reassigned', resolutionReason: input.reason, delegatedFromUserId: null }).where('id', '=', step.id).execute();
    await recordEvent(t, orgId, req.id, 'reassigned', actor.userId, { stepNo, from: previous, to: input.userId, reason: input.reason });
    const payload = await requestPayload(t, orgId, req);
    await emitTargeted(t, orgId, 'approval.reassigned', req.id, previous.filter((u) => u !== input.userId), { ...payload, stepNo, to: input.userId, reason: input.reason }, actor);
    await emitTargeted(t, orgId, 'approval.pending', req.id, [input.userId], { ...payload, stepId: step.id, stepNo, reassigned: true }, actor);
    return { requestId: req.id, entityType: req.entityType, entityId: req.entityId, branchId: req.branchId, status: req.status };
  });
  await audit(trx, actor, orgId, 'approval.reassigned', 'approval_request', { entityId: requestId, branchId: out.branchId, reason: input.reason, newValue: { userId: input.userId, stepNo: input.stepNo ?? null } });
  return out;
}

/** An approver asks the requester for more information: the request stays pending, both sides are told, the timeline keeps the question. */
export async function requestInfo(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, requestId: string, comment: string): Promise<CloseOutcome> {
  const grant = requireMembership(actor.principal, orgId);
  const out = await systemStep(trx, orgId, async (t) => {
    const req = await lockRequest(t, orgId, requestId);
    if (req.status !== 'PENDING') throw errors.invalidState(`The request is already ${req.status}.`);
    const steps = await loadSteps(t, req.id);
    const step = steps.find((s) => s.stepNo === req.currentStep && s.status === 'PENDING');
    const today = await orgToday(t, orgId);
    const delegations = await loadDelegationMap(t, orgId, req.entityType, today);
    const delegators = new Set([...delegations.entries()].filter(([, d]) => d === actor.userId).map(([k]) => k));
    const check = assessDecider({ grant, userId: actor.userId, request: { entityType: req.entityType, requestedBy: req.requestedBy, subjectUserId: req.subjectUserId, employeeId: req.employeeId, branchId: req.branchId, allowSelfApproval: await workflowAllowsSelf(t, req.workflowId) }, stepActors: step?.actors ?? [], delegators });
    if (!check.via || check.branchBlocked) throw errors.forbidden('You are not an approver of the current step.');
    await t.updateTable('approvalRequests').set({ infoRequestedAt: new Date() }).where('id', '=', req.id).execute();
    await recordEvent(t, orgId, req.id, 'info_requested', actor.userId, { stepNo: req.currentStep, comment });
    const payload = await requestPayload(t, orgId, req);
    await emitTargeted(t, orgId, 'approval.info_requested', req.id, [req.requestedBy, req.subjectUserId].filter((u): u is string => !!u && u !== actor.userId), { ...payload, comment, askedBy: actor.userId }, actor);
    return { requestId: req.id, entityType: req.entityType, entityId: req.entityId, branchId: req.branchId, status: req.status };
  });
  await audit(trx, actor, orgId, 'approval.info_requested', 'approval_request', { entityId: requestId, branchId: out.branchId, newValue: { comment } });
  return out;
}

/** The requester (or the subject) answers; the current approvers are told and the "waiting for an answer" marker clears. */
export async function answerInfo(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, requestId: string, comment: string): Promise<CloseOutcome> {
  requireMembership(actor.principal, orgId);
  const out = await systemStep(trx, orgId, async (t) => {
    const req = await lockRequest(t, orgId, requestId);
    if (req.status !== 'PENDING') throw errors.invalidState(`The request is already ${req.status}.`);
    if (req.requestedBy !== actor.userId && req.subjectUserId !== actor.userId) throw errors.forbidden('Only the requester or the person concerned can answer.');
    const steps = await loadSteps(t, req.id);
    const step = steps.find((s) => s.stepNo === req.currentStep && s.status === 'PENDING');
    await t.updateTable('approvalRequests').set({ infoRequestedAt: null }).where('id', '=', req.id).execute();
    await recordEvent(t, orgId, req.id, 'info_answered', actor.userId, { stepNo: req.currentStep, comment });
    const payload = await requestPayload(t, orgId, req);
    await emitTargeted(t, orgId, 'approval.info_answered', req.id, (step?.actors ?? []).filter((a) => a.decision === 'PENDING').map((a) => a.userId), { ...payload, comment, answeredBy: actor.userId }, actor);
    return { requestId: req.id, entityType: req.entityType, entityId: req.entityId, branchId: req.branchId, status: req.status };
  });
  await audit(trx, actor, orgId, 'approval.info_answered', 'approval_request', { entityId: requestId, branchId: out.branchId, newValue: { comment } });
  return out;
}

export { hookFor, approvePermissionFor, viewPermissionFor };
export const _internal = { loadSteps, lockRequest, recordEvent };
