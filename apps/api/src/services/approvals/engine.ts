import { sql } from 'kysely';
import type { ApprovalBulkDecideItemDto, ApprovalBulkDecideResultDto, ApprovalDecideVia, ApprovalDecision, ApprovalEntity, ApprovalEscalationTarget, ApprovalRequestStatus, ApprovalStepMode, ApproverType, DomainEventType, Permission } from '@flowza/contracts';
import { approvalContextFacts } from '@flowza/contracts';
import { emitDomainEvent, type Trx } from '@flowza/database';
import { collapseSeats, escalationDueAt, evaluateLevel, pendingSeats, requiredAfterReassign, resolveStepActors, seatOfRow, selectWorkflow, type ApprovalStepSpec, type MembershipGrant, type ResolvedActor } from '@flowza/domain';
import { AppError, errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { hasPermission, requireMembership } from '../../lib/authorize.js';
import { type Actor, audit, runUser } from '../../lib/service.js';
import { jsonArray, jsonObject, numberOrNull } from '../../lib/mappers.js';
import { systemStep } from '../features/context.js';
import { buildResolutionContext, loadDelegationMap } from './context.js';
import { approvePermissionFor, holdsApprovePermission, hookFor, managePermissionFor, viewPermissionFor, type HookContext } from './hooks/index.js';

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
  /**
   * Without a workflow: approve at once (the request row still exists — Finance parity), route to holders of a permission,
   * or (HR portal Prompt 4 — attendance notes, regularisations, swaps) route to the subject's line manager: one MANAGER level
   * (primary → secondary → HR admins → owner, the domain resolver's fallback chain).
   */
  noWorkflow: { kind: 'AUTO_APPROVE' } | { kind: 'PERMISSION'; permission: Permission } | { kind: 'MANAGER' };
  /**
   * The document needs no approval at all (leave v2: a leave type with `requires_approval = false`): record an APPROVED
   * request at once whatever the workflows say; the hook sees `notRequired` (nobody decided).
   */
  notRequired?: boolean;
}
export interface SubmitResult { requestId: string; status: 'PENDING' | 'APPROVED'; autoApproved: boolean; stepCount: number; firstStepActorIds: string[] }

export interface DecideInput {
  /**
   * The level the caller saw. The HTTP routes require it; internal callers may omit it for backward compatibility, and then
   * the caller can decide only a seat they hold on the current level — never an organisation-wide override (review P1-2).
   */
  stepNo?: number | undefined;
  decision: ApprovalDecision;
  comment?: string | undefined;
  viaEmailToken?: boolean;
  /** An override / escalated decision fills this pending seat of the level (default: the first pending seat, in seat order). */
  onBehalfOfUserId?: string | undefined;
  /** Internal: decide only through a seat the caller holds (one-click e-mail links are minted for a seat, never an override). */
  requireSeat?: boolean;
  /** Attendance-note rejections: the pay effect in days (HR portal Prompt 4); recorded on the timeline and handed to the hook. */
  payEffectDays?: 0 | 0.5 | 1 | undefined;
  /** Extra decision detail for the entity hook (e.g. `{ outcome: 'excuse' }`); recorded on the timeline. */
  detail?: Record<string, unknown> | undefined;
}
export interface DecideOutcome {
  requestId: string; status: string; noop: boolean; terminal: boolean; stepNo: number; entityType: ApprovalEntity; entityId: string; branchId: string | null;
  /** How the decision was taken (absent on a no-op). */
  via?: ApprovalDecideVia;
  /** The seat an override / escalated decision filled. */
  onBehalfOfUserId?: string | null;
}

type ActorRowLite = { userId: string; viaDelegationOf: string | null; decision: string; resolutionPath?: string | null; onBehalfOfUserId?: string | null };

/** Everything the decide rules need to know about a caller and a request; shared with the DTO abilities so the UI never shows a button the API refuses. */
export interface DeciderAssessment {
  ok: boolean;
  /**
   * `actor` — the caller's own seat; `delegate` — the seat of somebody who delegates to them today; `escalated` — an approver
   * the worker added to an overdue level; `permission` / `owner` — an organisation-wide approve holder or the owner deciding
   * a level they are not seated on (an override). `escalated`, `permission` and `owner` fill ONE pending seat.
   */
  via: 'actor' | 'delegate' | 'escalated' | 'permission' | 'owner' | null;
  delegateOf: string | null;
  sodBlocked: 'subject' | 'requester' | null;
  ownerBypass: boolean;
  /** The request's branch is outside the caller's branch scope (matters for an override only; a seat is its own authority). */
  branchBlocked: boolean;
  /** The caller's authority is an override (`permission` / `owner`): the call must name the level and it fills one seat. */
  override: boolean;
  /** The caller's seat on this level is already decided (by them, their delegate or an override): a repeat is a no-op. */
  alreadyDecided: boolean;
}

/** The person a request is about: the CURRENT link between the caller's membership and the subject employee, or the login snapshot taken at submit (review P0-4). */
export function isRequestSubject(grant: MembershipGrant, userId: string, request: { employeeId: string | null; subjectUserId: string | null }): boolean {
  return (!!grant.employeeId && !!request.employeeId && grant.employeeId === request.employeeId) || (!!request.subjectUserId && request.subjectUserId === userId);
}

const isDecided = (decision: string) => decision === 'APPROVED' || decision === 'REJECTED';
/** An escalated approver who has not decided yet is an extra hand, not a seat of the level. */
const isExtraHand = (r: ActorRowLite) => r.resolutionPath === 'escalated' && !r.onBehalfOfUserId;

/**
 * Who may decide the current level (review P0-1 / P2-13, Finance B-91 — one seat per call):
 *  (a) a seated actor, or their active delegate (a delegation in force today, organisation date), decides their own seat;
 *      an approver added by escalation fills one pending seat;
 *  (b) an ORGANISATION-WIDE holder of the entity's approve key (with its organisation-wide view key, branch scope applies)
 *      or the owner may decide as an override: one pending seat, and only when the call names the level;
 *  (c) a line manager whose key reaches the subject only through the reporting line never overrides.
 * Segregation of duties: the subject (current membership link or submit-time snapshot) never decides, the requester only
 * through a seat of their own; the owner is the one exception, logged as `sod_owner_bypass`.
 */
export function assessDecider(params: {
  grant: MembershipGrant; userId: string;
  /** `allowSelfApproval` is accepted and ignored: self-approval is not configurable (review P0-3). */
  request: { entityType: ApprovalEntity; requestedBy: string | null; subjectUserId: string | null; employeeId: string | null; branchId: string | null; allowSelfApproval?: boolean };
  stepActors: readonly ActorRowLite[];
  /** Approvers who delegate to the caller today (entity type already applied). */
  delegators: ReadonlySet<string>;
}): DeciderAssessment {
  const { grant, userId, request } = params;
  const rows = params.stepActors;
  const isOwner = grant.roleKey === 'owner';
  const branchBlocked = !grant.allBranches && !!request.branchId && !grant.branchIds.includes(request.branchId);
  const seatDecided = (seat: string) => rows.some((r) => !isExtraHand(r) && seatOfRow(r) === seat && isDecided(r.decision));
  let via: DeciderAssessment['via'] = null;
  let delegateOf: string | null = null;
  let alreadyDecided = false;
  const own = rows.find((r) => r.userId === userId);
  if (own) {
    // `secondary`: the reporting line's secondary manager seated beside the primary on the primary's seat (HR portal Prompt 4,
    // Finance B-22 — either manager reviews for the line). That seat comes from the org structure, not from a delegation, so it
    // does not lapse with one: the stand-in decides the shared seat as its actor (one seat — a rejection by either is final).
    const ownVia: DeciderAssessment['via'] = own.resolutionPath === 'escalated' ? 'escalated' : own.resolutionPath === 'override' ? 'permission' : own.resolutionPath === 'owner_override' ? 'owner' : own.resolutionPath === 'secondary' ? 'actor' : own.viaDelegationOf ? 'delegate' : 'actor';
    if (isDecided(own.decision)) { alreadyDecided = true; via = ownVia; }
    else if (own.decision === 'PENDING') {
      if (ownVia === 'delegate') {
        // a delegate stamped at submit keeps the seat only while the delegation is still in force
        if (own.viaDelegationOf && params.delegators.has(own.viaDelegationOf) && !seatDecided(own.viaDelegationOf)) { via = 'delegate'; delegateOf = own.viaDelegationOf; }
      } else if (ownVia === 'escalated' || ownVia === 'actor') via = ownVia;
    } else if (seatDecided(seatOfRow(own))) { alreadyDecided = true; via = ownVia; } // my seat was decided for me (my delegate, an override)
  }
  if (!via && !alreadyDecided) {
    const delegateRow = rows.find((r) => r.decision === 'PENDING' && r.userId !== userId && r.viaDelegationOf === null && !r.onBehalfOfUserId && !isExtraHand(r) && params.delegators.has(r.userId) && !seatDecided(r.userId));
    if (delegateRow) { via = 'delegate'; delegateOf = delegateRow.userId; }
    else if (holdsApprovePermission(grant, request.entityType) && hasPermission(grant, viewPermissionFor(request.entityType))) via = 'permission';
    else if (isOwner) via = 'owner';
  }
  let sodBlocked: DeciderAssessment['sodBlocked'] = null;
  let ownerBypass = false;
  if (isRequestSubject(grant, userId, request)) { if (isOwner) ownerBypass = true; else sodBlocked = 'subject'; }
  else if (request.requestedBy === userId && via !== 'actor' && via !== 'escalated') { if (isOwner) ownerBypass = true; else sodBlocked = 'requester'; }
  const override = via === 'permission' || via === 'owner';
  return { ok: via !== null && sodBlocked === null && !(override && branchBlocked), via, delegateOf, sodBlocked, ownerBypass, branchBlocked, override, alreadyDecided };
}

/** How the UI names the caller's route to a decision. */
export function decideViaOf(check: DeciderAssessment): ApprovalDecideVia | null {
  return check.via === 'permission' || check.via === 'owner' ? 'override' : check.via;
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

/**
 * Today in the ORGANISATION's timezone, computed by the database (`app.org_today`) — the one definition of "today" for
 * delegation windows that RLS, the inbox and the counts use too (review P2-1).
 */
export async function approvalToday(t: Trx, orgId: string): Promise<string> {
  const { rows } = await sql<{ d: string }>`select app.org_today(${orgId}::uuid)::text as d`.execute(t);
  const d = rows[0]?.d;
  if (!d) throw errors.internal('cannot read the organisation date');
  return d;
}

/** Approvers who delegate to `userId` today for this entity type (organisation date). */
export async function delegatorsOf(t: Trx, orgId: string, entityType: ApprovalEntity, userId: string, today?: string): Promise<Set<string>> {
  const map = await loadDelegationMap(t, orgId, entityType, today ?? await approvalToday(t, orgId));
  return new Set([...map.entries()].filter(([, delegate]) => delegate === userId).map(([delegator]) => delegator));
}

export async function recordEvent(t: Trx, orgId: string, requestId: string, kind: string, actorUserId: string | null, detail: Record<string, unknown> = {}): Promise<void> {
  await t.insertInto('approvalRequestEvents').values({ organizationId: orgId, requestId, kind, actorUserId, detail: JSON.stringify(detail) }).execute();
}

async function requestPayload(t: Trx, orgId: string, req: { id: string; entityType: ApprovalEntity; entityId: string; employeeId: string | null; requestedBy: string | null }): Promise<Record<string, unknown>> {
  const emp = req.employeeId ? await t.selectFrom('employees').select(['displayName', 'employeeNumber']).where('organizationId', '=', orgId).where('id', '=', req.employeeId).executeTakeFirst() : undefined;
  const hook = hookFor(req.entityType);
  let summary: string | null = null;
  let facts = approvalContextFacts(null);
  if (hook) {
    const ctx = (await hook.loadContexts(t, orgId, [req.entityId])).get(req.entityId);
    if (ctx) { if (hook.summary) summary = hook.summary(ctx); facts = approvalContextFacts(ctx); }
  }
  // `date` / `endDate` / `leaveTypeName`: the structured facts the notification templates render in the recipient's language
  return { requestId: req.id, entityType: req.entityType, entityId: req.entityId, employeeId: req.employeeId, employeeName: emp?.displayName ?? null, employeeNumber: emp?.employeeNumber ?? null, requestedBy: req.requestedBy, summary, ...facts };
}

/** Targeted notification: the relay creates one in-app notification (and e-mail per preference) per user in `userIds`. */
export async function emitTargeted(t: Trx, orgId: string, eventType: DomainEventType, requestId: string, userIds: readonly string[], payload: Record<string, unknown>, actor: { userId: string | null; requestId: string | null }): Promise<void> {
  const ids = [...new Set(userIds.filter((u): u is string => !!u))];
  if (!ids.length) return;
  await emitDomainEvent(t, { organizationId: orgId, eventType, aggregateType: 'approval_request', aggregateId: requestId, payload: { ...payload, userIds: ids }, actorUserId: actor.userId, requestId: actor.requestId });
}

async function loadSteps(t: Trx, requestId: string) {
  const steps = await t.selectFrom('approvalSteps').selectAll().where('requestId', '=', requestId).orderBy('stepNo').execute();
  const actors = steps.length ? await t.selectFrom('approvalStepActors').selectAll().where('stepId', 'in', steps.map((s) => s.id)).orderBy('createdAt').orderBy('id').execute() : [];
  return steps.map((s) => ({ ...s, actors: actors.filter((a) => a.stepId === s.id) }));
}
type LoadedStep = Awaited<ReturnType<typeof loadSteps>>[number];

async function lockRequest(t: Trx, orgId: string, requestId: string) {
  const r = await t.selectFrom('approvalRequests').selectAll().where('organizationId', '=', orgId).where('id', '=', requestId).forUpdate().executeTakeFirst();
  if (!r) throw errors.notFound('Approval request', requestId);
  return r;
}
type RequestRow = Awaited<ReturnType<typeof lockRequest>>;

function hookCtx(orgId: string, req: RequestRow, actor: Actor, comment: string | null, auto = false, detail?: Record<string, unknown>): HookContext {
  return { orgId, requestId: req.id, entityId: req.entityId, employeeId: req.employeeId, branchId: req.branchId, actor, comment, auto, ...(detail ? { detail } : {}) };
}

async function skipPending(t: Trx, stepIds: string[], comment: string | null): Promise<void> {
  if (!stepIds.length) return;
  await t.updateTable('approvalStepActors').set({ decision: 'SKIPPED', ...(comment ? { comment } : {}) }).where('stepId', 'in', stepIds).where('decision', '=', 'PENDING').execute();
  await t.updateTable('approvalSteps').set({ status: 'SKIPPED' }).where('id', 'in', stepIds).where('status', '=', 'PENDING').execute();
}

/** The owner acted on a request about themselves (or on their own filing without a seat): the one SoD exception, on the timeline and in the audit trail. */
async function recordOwnerBypass(t: Trx, actor: Actor, orgId: string, req: { id: string; branchId: string | null; entityType: ApprovalEntity; entityId: string }, detail: Record<string, unknown>): Promise<void> {
  await recordEvent(t, orgId, req.id, 'sod_owner_bypass', actor.userId, detail);
  await audit(t, actor, orgId, 'approval.sod_owner_bypass', 'approval_request', { entityId: req.id, branchId: req.branchId, newValue: { ...detail, entityType: req.entityType, entityId: req.entityId } });
}

/** Who hears about a final decision: the requester and the subject, never the decider, and not the subject when the entity's hook tells them itself. */
function decisionRecipients(req: { entityType: ApprovalEntity; requestedBy: string | null; subjectUserId: string | null }, actorUserId: string): string[] {
  const informedByHook = hookFor(req.entityType)?.notifiesSubject ? req.subjectUserId : null;
  return [req.requestedBy, req.subjectUserId].filter((u): u is string => !!u && u !== actorUserId && u !== informedByHook);
}

async function completeApproved(deps: ApiDeps, t: Trx, actor: Actor, orgId: string, req: RequestRow, comment: string | null, detail: Record<string, unknown>): Promise<void> {
  const now = new Date();
  await t.updateTable('approvalRequests').set({ status: 'APPROVED', completedAt: now, decidedBy: actor.userId, infoRequestedAt: null }).where('id', '=', req.id).execute();
  await recordEvent(t, orgId, req.id, 'approved', actor.userId, { ...detail, comment });
  await hookFor(req.entityType)?.onApproved(deps, t, hookCtx(orgId, req, actor, comment, false, detail));
  const payload = await requestPayload(t, orgId, req);
  await emitTargeted(t, orgId, 'approval.decided', req.id, decisionRecipients(req, actor.userId), { ...payload, decision: 'APPROVED', comment, decidedBy: actor.userId }, actor);
}

async function completeRejected(deps: ApiDeps, t: Trx, actor: Actor, orgId: string, req: RequestRow, steps: LoadedStep[], comment: string | null, detail: Record<string, unknown>): Promise<void> {
  const now = new Date();
  await skipPending(t, steps.filter((s) => s.stepNo > req.currentStep && s.status === 'PENDING').map((s) => s.id), null);
  await t.updateTable('approvalRequests').set({ status: 'REJECTED', completedAt: now, decidedBy: actor.userId, infoRequestedAt: null }).where('id', '=', req.id).execute();
  await recordEvent(t, orgId, req.id, 'rejected', actor.userId, { ...detail, comment });
  await hookFor(req.entityType)?.onRejected(deps, t, hookCtx(orgId, req, actor, comment, false, detail));
  const payload = await requestPayload(t, orgId, req);
  await emitTargeted(t, orgId, 'approval.decided', req.id, decisionRecipients(req, actor.userId), { ...payload, decision: 'REJECTED', comment, decidedBy: actor.userId }, actor);
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
    const today = await approvalToday(t, orgId);
    const workflows = await t.selectFrom('approvalWorkflows').selectAll().where('organizationId', '=', orgId).where('entityType', '=', input.entityType).where('status', '=', 'active').where('isDefault', '=', true).execute();
    const workflow = selectWorkflow(workflows.map((w) => ({ id: w.id, name: w.name, branchId: w.branchId, appliesTo: jsonObject(w.appliesTo) as { branchIds?: string[]; departmentIds?: string[] }, minUnits: numberOrNull(w.minUnits), isDefault: w.isDefault, status: w.status })), { branchId: input.branchId, departmentId: input.departmentId ?? null, units: input.units ?? null });
    const row = workflow ? workflows.find((w) => w.id === workflow.id)! : null;
    const base = { organizationId: orgId, workflowId: row?.id ?? null, entityType: input.entityType, entityId: input.entityId, branchId: input.branchId, employeeId: input.employeeId, departmentId: input.departmentId ?? null, units: input.units ?? null, requestedBy: input.requestedBy };
    const subjectUserId = input.employeeId ? (await t.selectFrom('orgMemberships').select('userId').where('organizationId', '=', orgId).where('employeeId', '=', input.employeeId).where('status', '=', 'active').orderBy('createdAt').executeTakeFirst())?.userId ?? null : null;

    if (input.notRequired || (!row && input.noWorkflow.kind === 'AUTO_APPROVE')) {
      const now = new Date();
      const req = await t.insertInto('approvalRequests').values({ ...base, workflowId: input.notRequired ? null : base.workflowId, subjectUserId, currentStep: 1, status: 'APPROVED', completedAt: now, decidedBy: input.notRequired ? null : actor.userId }).returningAll().executeTakeFirstOrThrow();
      await recordEvent(t, orgId, req.id, 'auto_approved', actor.userId, { reason: input.notRequired ? 'no approval required for this item' : 'no workflow configured for this entity type' });
      await hookFor(input.entityType)?.onApproved(deps, t, { ...hookCtx(orgId, req, actor, null, true), notRequired: input.notRequired ?? false });
      return { requestId: req.id, status: 'APPROVED', autoApproved: true, stepCount: 0, firstStepActorIds: [] };
    }
    const steps: ApprovalStepSpec[] = row ? parseWorkflowSteps(row.steps)
      : input.noWorkflow.kind === 'MANAGER' ? [{ order: 1, approverType: 'MANAGER', mode: 'ANY' }]
      : [{ order: 1, approverType: 'ROLE', permission: input.noWorkflow.kind === 'PERMISSION' ? input.noWorkflow.permission : 'attendance.approve', mode: 'ANY' }];
    const ctx = await buildResolutionContext(t, orgId, { employeeId: input.employeeId, branchId: input.branchId, requestedBy: input.requestedBy, entityType: input.entityType, viewPermission: viewPermissionFor(input.entityType), today });
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
      // one row per person per level (the resolver guarantees it; the conflict clause is the database's word on it)
      if (res.actors.length) await t.insertInto('approvalStepActors').values(res.actors.map((a) => ({ organizationId: orgId, stepId: step.id, userId: a.userId, viaDelegationOf: a.viaDelegationOf, resolutionPath: a.viaDelegationOf ? 'delegate' : res.path }))).onConflict((oc) => oc.columns(['stepId', 'userId']).doNothing()).execute();
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
 * One decision inside the caller's transaction, on ONE seat of the current level (Finance B-91 "one row per call"). Under
 * FOR UPDATE on the request so concurrent approvers serialise; the second one re-reads the committed state. See
 * `assessDecider` for who may decide: a seat holder or their active delegate on their own seat; an escalated approver or
 * an organisation-wide approve holder / the owner on one pending seat (an override must name the level); never a line
 * manager outside their seat. After the seat is decided the level is evaluated by its mode (ANY / ALL / QUORUM). A closed
 * request or a non-current level is a conflict (409), a repeated decision on a seat already decided is a harmless no-op.
 */
export async function decideWithin(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, requestId: string, input: DecideInput): Promise<DecideOutcome> {
  const grant = requireMembership(actor.principal, orgId);
  if (input.decision === 'REJECT' && !input.comment) throw errors.validation('A comment is required when rejecting.', { issues: [{ path: 'comment', message: 'Required' }] });
  const comment = input.comment ?? null;
  const explicitStep = input.stepNo !== undefined;
  let bypassed = false;
  const outcome = await systemStep(trx, orgId, async (t): Promise<DecideOutcome> => {
    const req = await lockRequest(t, orgId, requestId);
    if (req.status !== 'PENDING') throw errors.invalidState(`The request is already ${req.status}.`);
    const stepNo = input.stepNo ?? req.currentStep;
    if (stepNo !== req.currentStep) throw errors.invalidState(`Step ${stepNo} is not the current step (${req.currentStep}).`);
    const steps = await loadSteps(t, req.id);
    const step = steps.find((s) => s.stepNo === req.currentStep && s.status === 'PENDING');
    if (!step) throw errors.invalidState('The request has no pending step.');
    const delegators = await delegatorsOf(t, orgId, req.entityType, actor.userId);
    const check = assessDecider({ grant, userId: actor.userId, request: { entityType: req.entityType, requestedBy: req.requestedBy, subjectUserId: req.subjectUserId, employeeId: req.employeeId, branchId: req.branchId }, stepActors: step.actors, delegators });
    const base = { requestId: req.id, stepNo: step.stepNo, entityType: req.entityType, entityId: req.entityId, branchId: req.branchId };
    if (check.sodBlocked === 'subject') throw errors.forbidden('Self-approval is not permitted: this request is about you.');
    if (check.sodBlocked === 'requester') throw errors.forbidden('You cannot approve or reject your own request; cancel it instead.');
    if (check.alreadyDecided) return { ...base, status: req.status, noop: true, terminal: false };
    if (!check.via) throw errors.forbidden('You are not an approver of the current step.');
    if (check.override) {
      if (input.requireSeat) throw errors.forbidden('This link was for an approver seat you no longer hold; open the request in the app.');
      if (!explicitStep) throw errors.validation('Name the level you are deciding (stepNo): you are not one of its approvers, so your decision would count as an organisation-wide override of one of them.', { issues: [{ path: 'stepNo', message: 'Required for an override' }] });
      if (check.branchBlocked) throw errors.forbidden('This request is outside your branch scope.');
    }
    const now = new Date();
    const decision = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    if (check.ownerBypass) { await recordOwnerBypass(t, actor, orgId, req, { stepNo: step.stepNo, decision }); bypassed = true; }
    const own = step.actors.find((a) => a.userId === actor.userId);
    let seat: string;
    let decidedRowId: string | null = null;
    let onBehalfOfUserId: string | null = null;
    if (check.via === 'actor' || (check.via === 'delegate' && own && own.decision === 'PENDING' && own.viaDelegationOf === check.delegateOf)) {
      // the caller's own seat, or the delegate row stamped for them at submit
      await t.updateTable('approvalStepActors').set({ decision, decidedAt: now, comment }).where('id', '=', own!.id).execute();
      seat = seatOfRow(own!); decidedRowId = own!.id;
    } else if (check.via === 'delegate') {
      // a delegation created after the request was routed: the delegate decides in the delegator's seat
      seat = check.delegateOf!;
      const row = await t.insertInto('approvalStepActors').values({ organizationId: orgId, stepId: step.id, userId: actor.userId, viaDelegationOf: seat, resolutionPath: 'delegate', decision, decidedAt: now, comment })
        .onConflict((oc) => oc.columns(['stepId', 'userId']).doUpdateSet({ viaDelegationOf: seat, resolutionPath: 'delegate', onBehalfOfUserId: null, decision, decidedAt: now, comment })).returning('id').executeTakeFirstOrThrow();
      decidedRowId = row.id;
    } else {
      // escalated approver or organisation-wide override: ONE pending seat of the level (named, else the first in seat order)
      const open = pendingSeats(step.actors.filter((a) => !isExtraHand(a)));
      const target = input.onBehalfOfUserId ?? open[0];
      if (!target || !open.includes(target)) throw input.onBehalfOfUserId ? errors.validation('onBehalfOfUserId is not an approver still waiting at this level.', { issues: [{ path: 'onBehalfOfUserId', message: 'Not a pending seat of the level' }] }) : errors.invalidState('Every approver of this level has already decided.');
      seat = target; onBehalfOfUserId = target;
      if (check.via === 'escalated') {
        await t.updateTable('approvalStepActors').set({ decision, decidedAt: now, comment, onBehalfOfUserId: target }).where('id', '=', own!.id).execute();
        decidedRowId = own!.id;
      } else {
        const resolutionPath = check.via === 'owner' ? 'owner_override' : 'override';
        const row = await t.insertInto('approvalStepActors').values({ organizationId: orgId, stepId: step.id, userId: actor.userId, viaDelegationOf: null, onBehalfOfUserId: target, resolutionPath, decision, decidedAt: now, comment })
          .onConflict((oc) => oc.columns(['stepId', 'userId']).doUpdateSet({ viaDelegationOf: null, onBehalfOfUserId: target, resolutionPath, decision, decidedAt: now, comment })).returning('id').executeTakeFirstOrThrow();
        decidedRowId = row.id;
      }
      await recordEvent(t, orgId, req.id, 'override', actor.userId, { stepNo: step.stepNo, decision, via: check.via === 'escalated' ? 'escalated' : 'override', onBehalfOf: target });
    }
    // the seat is decided: its other pending rows (the approver, their delegate) close, so nobody decides it twice
    const openRows = step.actors.filter((a) => a.id !== decidedRowId && a.decision === 'PENDING' && !isExtraHand(a) && seatOfRow(a) === seat).map((a) => a.id);
    if (openRows.length) await t.updateTable('approvalStepActors').set({ decision: 'SKIPPED' }).where('id', 'in', openRows).execute();
    const rows = (await t.selectFrom('approvalStepActors').select(['userId', 'viaDelegationOf', 'onBehalfOfUserId', 'decision', 'resolutionPath']).where('stepId', '=', step.id).execute()).filter((r) => !isExtraHand(r));
    const level = evaluateLevel(step.mode as ApprovalStepMode, step.requiredCount, collapseSeats(rows));
    const via = decideViaOf(check) ?? 'actor';
    const eventDetail = { ...(input.detail ?? {}), ...(input.payEffectDays !== undefined ? { payEffectDays: input.payEffectDays } : {}), stepNo: step.stepNo, decision, comment, via: check.via, delegateOf: check.delegateOf, onBehalfOf: onBehalfOfUserId, mode: step.mode, requiredCount: step.requiredCount };
    if (level === 'open') {
      await recordEvent(t, orgId, req.id, decision === 'APPROVED' ? 'approval_recorded' : 'rejection_recorded', actor.userId, { ...eventDetail, levelOpen: true });
      return { ...base, status: req.status, noop: false, terminal: false, via, onBehalfOfUserId };
    }
    await t.updateTable('approvalSteps').set({ status: level === 'satisfied' ? 'APPROVED' : 'REJECTED', actedBy: actor.userId, actedAt: now, comment }).where('id', '=', step.id).execute();
    await t.updateTable('approvalStepActors').set({ decision: 'SKIPPED' }).where('stepId', '=', step.id).where('decision', '=', 'PENDING').execute();
    if (level === 'rejected') {
      await recordEvent(t, orgId, req.id, 'step_rejected', actor.userId, eventDetail);
      await completeRejected(deps, t, actor, orgId, req, steps, comment, eventDetail);
      return { ...base, status: 'REJECTED', noop: false, terminal: true, via, onBehalfOfUserId };
    }
    await recordEvent(t, orgId, req.id, 'step_approved', actor.userId, eventDetail);
    const next = steps.find((s) => s.stepNo > req.currentStep && s.status === 'PENDING');
    if (next) {
      await activateStep(t, orgId, req, next, actor, now);
      return { ...base, status: 'PENDING', noop: false, terminal: false, via, onBehalfOfUserId };
    }
    await completeApproved(deps, t, actor, orgId, req, comment, eventDetail);
    return { ...base, status: 'APPROVED', noop: false, terminal: true, via, onBehalfOfUserId };
  });
  if (!outcome.noop) {
    const action = input.decision === 'APPROVE' ? (outcome.status === 'APPROVED' ? 'approval.approved' : 'approval.step_approved') : (outcome.terminal ? 'approval.rejected' : 'approval.step_rejected');
    const detail = { stepNo: outcome.stepNo, comment, entityType: outcome.entityType, entityId: outcome.entityId, viaEmailToken: input.viaEmailToken ?? false, via: outcome.via ?? null, onBehalfOfUserId: outcome.onBehalfOfUserId ?? null, ownerBypass: bypassed };
    await audit(trx, actor, orgId, action, 'approval_request', { entityId: requestId, branchId: outcome.branchId, newValue: detail });
    if (outcome.via === 'override' || outcome.via === 'escalated') await audit(trx, actor, orgId, 'approval.override', 'approval_request', { entityId: requestId, branchId: outcome.branchId, newValue: { ...detail, decision: input.decision } });
  }
  return outcome;
}

/**
 * The same decision on several requests (Finance ATT-95 — bulk approval goes through the engine). Each request is decided in
 * its own transaction with every rule of a single decision (seat / delegate / override, segregation of duties, modes, hooks,
 * notifications, audit), so one refusal never undoes the others; the caller gets one line per request. `items` carry the
 * level the caller saw for each request (review P1-2); a legacy `requestIds` list decides seats the caller holds only.
 */
export async function bulkDecide(deps: ApiDeps, actor: Actor, orgId: string, input: { requestIds?: readonly string[]; items?: ReadonlyArray<{ requestId: string; stepNo?: number | undefined }>; decision: ApprovalDecision; comment?: string | undefined }): Promise<ApprovalBulkDecideResultDto> {
  requireMembership(actor.principal, orgId);
  const results: ApprovalBulkDecideItemDto[] = [];
  const items = input.items ?? (input.requestIds ?? []).map((requestId) => ({ requestId, stepNo: undefined }));
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.requestId)) continue;
    seen.add(item.requestId);
    try {
      const out = await runUser(deps.db, actor, (trx) => decideWithin(deps, trx, actor, orgId, item.requestId, { stepNo: item.stepNo, decision: input.decision, comment: input.comment }));
      results.push({ requestId: item.requestId, ok: true, status: out.status as ApprovalRequestStatus, noop: out.noop, code: null, message: null });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      results.push({ requestId: item.requestId, ok: false, status: null, noop: false, code: err.code, message: err.message });
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  return { results, succeeded, failed: results.length - succeeded };
}

// ----- cancel / invalidate / reassign / info ------------------------------------------------------------------------------------

export interface CloseOutcome { requestId: string; entityType: ApprovalEntity; entityId: string; branchId: string | null; status: string }

/** The reason stored when an internal caller withdraws without one (the HTTP route always requires one — Finance B-98). */
export const DEFAULT_WITHDRAW_REASON = 'Withdrawn by the requester';

/** Cancel a pending request from inside a system step (the API's cancel, leave withdrawal, correction cancellation). */
export async function cancelWithin(deps: ApiDeps, t: Trx, actor: Actor, orgId: string, requestId: string, reason: string | null, opts: { runHook?: boolean; source?: string } = {}): Promise<CloseOutcome | null> {
  const req = await lockRequest(t, orgId, requestId);
  if (req.status !== 'PENDING') return null;
  // a withdrawal always says why: an internal caller that passed nothing records who withdrew
  const stored = reason?.trim() ? reason.trim() : actor.userId === req.requestedBy ? DEFAULT_WITHDRAW_REASON : 'Withdrawn';
  const steps = await loadSteps(t, req.id);
  const current = steps.find((s) => s.stepNo === req.currentStep);
  await skipPending(t, steps.filter((s) => s.status === 'PENDING').map((s) => s.id), null);
  await t.updateTable('approvalRequests').set({ status: 'CANCELLED', completedAt: new Date(), cancelledBy: actor.userId, cancelReason: stored, infoRequestedAt: null }).where('id', '=', req.id).execute();
  await recordEvent(t, orgId, req.id, 'cancelled', actor.userId, { reason: stored, source: opts.source ?? 'api' });
  if (opts.runHook !== false) await hookFor(req.entityType)?.onCancelled?.(deps, t, hookCtx(orgId, req, actor, stored));
  const payload = await requestPayload(t, orgId, req);
  await emitTargeted(t, orgId, 'approval.decided', req.id, (current?.actors ?? []).filter((a) => a.decision === 'PENDING' || a.decision === 'SKIPPED').map((a) => a.userId).filter((u) => u !== actor.userId), { ...payload, decision: 'CANCELLED', comment: stored, decidedBy: actor.userId }, actor);
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
 * Who may withdraw a pending request (Finance B-97/98, review P2-4 + P0-4): the requester (a subject withdrawing their own
 * filing included); approval.manage or the owner; or a holder of the entity's manage key WITH its organisation-wide view key
 * (branch scope applies). An approver who is only seated on it cannot withdraw it, and the person a request is about but
 * did not file (HR recorded it for them) cannot withdraw it either — the owner excepted (logged).
 */
export function canCancel(grant: MembershipGrant, userId: string, req: { entityType: ApprovalEntity; requestedBy: string | null; subjectUserId: string | null; employeeId: string | null; branchId: string | null }): boolean {
  if (req.requestedBy === userId) return true;
  const isOwner = grant.roleKey === 'owner';
  if (isRequestSubject(grant, userId, req) && !isOwner) return false;
  if (!grant.allBranches && req.branchId && !grant.branchIds.includes(req.branchId)) return false;
  if (isOwner || hasPermission(grant, 'approval.manage')) return true;
  return hasPermission(grant, managePermissionFor(req.entityType)) && hasPermission(grant, viewPermissionFor(req.entityType));
}

export async function cancelRequest(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, requestId: string, reason: string | null): Promise<CloseOutcome> {
  const grant = requireMembership(actor.principal, orgId);
  const out = await systemStep(trx, orgId, async (t) => {
    const req = await lockRequest(t, orgId, requestId);
    if (!canCancel(grant, actor.userId, req)) throw errors.forbidden('Only the requester, approval.manage or the request type\'s manager (organisation-wide) can withdraw this request.');
    if (req.status !== 'PENDING') throw errors.invalidState(`The request is already ${req.status}.`);
    if (grant.roleKey === 'owner' && req.requestedBy !== actor.userId && isRequestSubject(grant, actor.userId, req)) await recordOwnerBypass(t, actor, orgId, req, { stepNo: req.currentStep, action: 'cancel' });
    return (await cancelWithin(deps, t, actor, orgId, requestId, reason, { source: 'api' }))!;
  });
  await audit(trx, actor, orgId, 'approval.cancelled', 'approval_request', { entityId: requestId, branchId: out.branchId, reason, newValue: { entityType: out.entityType, entityId: out.entityId } });
  return out;
}

/**
 * approval.manage (or the owner) moves the current level to somebody else (Finance B-104): the level's pending seats are
 * replaced by the new person, the seats that already approved keep counting, and the requirement becomes
 * min(required, approvals given + 1) so the reassignee's approval completes the level (review P1-1). Never onto the
 * requester or the person the request is about, never onto somebody who already decided at the level (review P2-2), and
 * never by a caller the request is about or who filed it (the owner excepted, logged).
 */
export async function reassignRequest(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, requestId: string, input: { stepNo?: number | undefined; userId: string; reason: string }): Promise<CloseOutcome> {
  const grant = requireMembership(actor.principal, orgId);
  const isOwner = grant.roleKey === 'owner';
  if (!hasPermission(grant, 'approval.manage') && !isOwner) throw errors.forbidden('Missing permission: approval.manage.');
  const out = await systemStep(trx, orgId, async (t) => {
    const req = await lockRequest(t, orgId, requestId);
    if (!grant.allBranches && req.branchId && !grant.branchIds.includes(req.branchId)) throw errors.forbidden('This request is outside your branch scope.');
    if (req.status !== 'PENDING') throw errors.invalidState(`The request is already ${req.status}.`);
    const stepNo = input.stepNo ?? req.currentStep;
    if (stepNo !== req.currentStep) throw errors.invalidState(`Step ${stepNo} is not the current step (${req.currentStep}).`);
    const steps = await loadSteps(t, req.id);
    const step = steps.find((s) => s.stepNo === stepNo && s.status === 'PENDING');
    if (!step) throw errors.invalidState('The request has no pending step.');
    if (isRequestSubject(grant, actor.userId, req) || req.requestedBy === actor.userId) {
      if (!isOwner) throw errors.forbidden('You cannot reassign a request you filed or that is about you; ask another approval manager.');
      await recordOwnerBypass(t, actor, orgId, req, { stepNo, action: 'reassign', to: input.userId });
    }
    const member = await t.selectFrom('orgMemberships').select(['userId', 'employeeId']).where('organizationId', '=', orgId).where('userId', '=', input.userId).where('status', '=', 'active').executeTakeFirst();
    if (!member) throw errors.validation('The new approver is not an active member of this organisation.', { userId: input.userId });
    if (input.userId === req.requestedBy) throw errors.validation('The person who filed the request cannot be its approver.', { issues: [{ path: 'userId', message: 'The requester' }] });
    if (input.userId === req.subjectUserId || (!!member.employeeId && member.employeeId === req.employeeId)) throw errors.validation('The person a request is about cannot be its approver.', { issues: [{ path: 'userId', message: 'The subject' }] });
    const seatRows = step.actors.filter((a) => !isExtraHand(a));
    // their own decision at this level, or their seat already decided for them (a delegate, an override): it stands
    const decidedHere = step.actors.some((a) => a.userId === input.userId && isDecided(a.decision)) || seatRows.some((a) => seatOfRow(a) === input.userId && isDecided(a.decision));
    if (decidedHere) throw errors.conflict('This person already decided at this level; their decision stands. Reassign the level to somebody else.', { userId: input.userId });
    const approvedSeats = collapseSeats(seatRows).filter((d) => d === 'APPROVED').length;
    const requiredCount = requiredAfterReassign(step.mode as ApprovalStepMode, step.requiredCount, approvedSeats);
    const previous = step.actors.filter((a) => a.decision === 'PENDING').map((a) => a.userId);
    await t.updateTable('approvalStepActors').set({ decision: 'SKIPPED', comment: `reassigned: ${input.reason}` }).where('stepId', '=', step.id).where('decision', '=', 'PENDING').execute();
    await t.insertInto('approvalStepActors').values({ organizationId: orgId, stepId: step.id, userId: input.userId, viaDelegationOf: null, resolutionPath: 'reassigned' })
      .onConflict((oc) => oc.columns(['stepId', 'userId']).doUpdateSet({ decision: 'PENDING', decidedAt: null, comment: null, resolutionPath: 'reassigned', viaDelegationOf: null, onBehalfOfUserId: null })).execute();
    await t.updateTable('approvalSteps').set({ approverUserId: input.userId, resolutionPath: 'reassigned', resolutionReason: input.reason, delegatedFromUserId: null, ...(step.mode === 'ALL' ? {} : { requiredCount }) }).where('id', '=', step.id).execute();
    await recordEvent(t, orgId, req.id, 'reassigned', actor.userId, { stepNo, from: previous, to: input.userId, reason: input.reason, ...(step.mode === 'ALL' ? {} : { requiredCount: { from: step.requiredCount, to: requiredCount } }) });
    const payload = await requestPayload(t, orgId, req);
    await emitTargeted(t, orgId, 'approval.reassigned', req.id, previous.filter((u) => u !== input.userId), { ...payload, stepNo, to: input.userId, reason: input.reason }, actor);
    await emitTargeted(t, orgId, 'approval.pending', req.id, [input.userId], { ...payload, stepId: step.id, stepNo, reassigned: true }, actor);
    return { requestId: req.id, entityType: req.entityType, entityId: req.entityId, branchId: req.branchId, status: req.status };
  });
  await audit(trx, actor, orgId, 'approval.reassigned', 'approval_request', { entityId: requestId, branchId: out.branchId, reason: input.reason, newValue: { userId: input.userId, stepNo: input.stepNo ?? null } });
  return out;
}

/**
 * Who may approve a pending request as an exception: approval.manage (or the owner) within their branch scope, never on a
 * request they filed or that is about them (current membership link or submit-time snapshot) — except the owner, which is
 * logged.
 */
export function canBypass(grant: MembershipGrant, userId: string, req: { requestedBy: string | null; subjectUserId: string | null; branchId: string | null; employeeId?: string | null }): boolean {
  const isOwner = grant.roleKey === 'owner';
  if (!isOwner && !hasPermission(grant, 'approval.manage')) return false;
  if (!grant.allBranches && req.branchId && !grant.branchIds.includes(req.branchId)) return false;
  return isOwner || (!isRequestSubject(grant, userId, { employeeId: req.employeeId ?? null, subjectUserId: req.subjectUserId }) && req.requestedBy !== userId);
}

/**
 * Finance B-99: approve a pending request as an exception, with a mandatory reason. Every open level is skipped, the
 * entity's hook runs (the correction is applied, the leave approved), the approvers who were waiting at the current level
 * are told it no longer needs them, the requester and the subject get the decision, and the timeline and the audit keep
 * the reason.
 */
export async function bypassRequest(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, requestId: string, reason: string): Promise<CloseOutcome> {
  const grant = requireMembership(actor.principal, orgId);
  if (!hasPermission(grant, 'approval.manage') && grant.roleKey !== 'owner') throw errors.forbidden('Missing permission: approval.manage.');
  const out = await systemStep(trx, orgId, async (t) => {
    const req = await lockRequest(t, orgId, requestId);
    if (!grant.allBranches && req.branchId && !grant.branchIds.includes(req.branchId)) throw errors.forbidden('This request is outside your branch scope.');
    if (req.status !== 'PENDING') throw errors.invalidState(`The request is already ${req.status}.`);
    if (isRequestSubject(grant, actor.userId, req) || req.requestedBy === actor.userId) {
      if (grant.roleKey !== 'owner') throw errors.forbidden('You cannot approve your own request as an exception; ask another approver.');
      await recordOwnerBypass(t, actor, orgId, req, { stepNo: req.currentStep, decision: 'APPROVED', exception: true });
    }
    const steps = await loadSteps(t, req.id);
    const open = steps.filter((s) => s.status === 'PENDING');
    const waiting = [...new Set(open.filter((s) => s.stepNo === req.currentStep).flatMap((s) => s.actors.filter((a) => a.decision === 'PENDING').map((a) => a.userId)))];
    await skipPending(t, open.map((s) => s.id), `approved as an exception: ${reason}`);
    await t.updateTable('approvalRequests').set({ status: 'APPROVED', completedAt: new Date(), decidedBy: actor.userId, infoRequestedAt: null }).where('id', '=', req.id).execute();
    await recordEvent(t, orgId, req.id, 'bypassed', actor.userId, { stepNo: req.currentStep, reason, skippedSteps: open.map((s) => s.stepNo) });
    await hookFor(req.entityType)?.onApproved(deps, t, hookCtx(orgId, req, actor, reason));
    const payload = await requestPayload(t, orgId, req);
    await emitTargeted(t, orgId, 'approval.bypassed', req.id, waiting.filter((u) => u !== actor.userId), { ...payload, reason, bypassedBy: actor.userId }, actor);
    await emitTargeted(t, orgId, 'approval.decided', req.id, decisionRecipients(req, actor.userId), { ...payload, decision: 'APPROVED', comment: reason, decidedBy: actor.userId, exception: true }, actor);
    return { requestId: req.id, entityType: req.entityType, entityId: req.entityId, branchId: req.branchId, status: 'APPROVED' };
  });
  await audit(trx, actor, orgId, 'approval.bypassed', 'approval_request', { entityId: requestId, branchId: out.branchId, reason, newValue: { entityType: out.entityType, entityId: out.entityId } });
  return out;
}

/**
 * An approver asks the requester for more information: the request stays pending, both sides are told, the timeline keeps
 * the question. The person the request is about never asks about it (review P2-3), the owner excepted (logged).
 */
export async function requestInfo(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, requestId: string, comment: string): Promise<CloseOutcome> {
  const grant = requireMembership(actor.principal, orgId);
  const out = await systemStep(trx, orgId, async (t) => {
    const req = await lockRequest(t, orgId, requestId);
    if (req.status !== 'PENDING') throw errors.invalidState(`The request is already ${req.status}.`);
    const steps = await loadSteps(t, req.id);
    const step = steps.find((s) => s.stepNo === req.currentStep && s.status === 'PENDING');
    const delegators = await delegatorsOf(t, orgId, req.entityType, actor.userId);
    const check = assessDecider({ grant, userId: actor.userId, request: { entityType: req.entityType, requestedBy: req.requestedBy, subjectUserId: req.subjectUserId, employeeId: req.employeeId, branchId: req.branchId }, stepActors: step?.actors ?? [], delegators });
    if (check.sodBlocked === 'subject') throw errors.forbidden('You cannot ask for information on a request about you.');
    if (check.sodBlocked === 'requester') throw errors.forbidden('You filed this request; answer questions on it instead of asking them.');
    if (!check.via || (check.override && check.branchBlocked)) throw errors.forbidden('You are not an approver of the current step.');
    if (check.ownerBypass) await recordOwnerBypass(t, actor, orgId, req, { stepNo: req.currentStep, action: 'request_info' });
    await t.updateTable('approvalRequests').set({ infoRequestedAt: new Date() }).where('id', '=', req.id).execute();
    await recordEvent(t, orgId, req.id, 'info_requested', actor.userId, { stepNo: req.currentStep, comment });
    const hook = hookFor(req.entityType);
    await hook?.onInfoRequested?.(deps, t, hookCtx(orgId, req, actor, comment));
    // a hook that tells the subject itself (attendance notes: attendance.note_info_requested) keeps them out of the generic notice
    const informedByHook = hook?.onInfoRequested && hook.notifiesSubject ? req.subjectUserId : null;
    const payload = await requestPayload(t, orgId, req);
    await emitTargeted(t, orgId, 'approval.info_requested', req.id, [req.requestedBy, req.subjectUserId].filter((u): u is string => !!u && u !== actor.userId && u !== informedByHook), { ...payload, comment, askedBy: actor.userId }, actor);
    return { requestId: req.id, entityType: req.entityType, entityId: req.entityId, branchId: req.branchId, status: req.status };
  });
  await audit(trx, actor, orgId, 'approval.info_requested', 'approval_request', { entityId: requestId, branchId: out.branchId, newValue: { comment } });
  return out;
}

/** The requester (or the subject) answers an outstanding question; the current approvers are told and the "waiting for an answer" marker clears. */
export async function answerInfo(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, requestId: string, comment: string): Promise<CloseOutcome> {
  const grant = requireMembership(actor.principal, orgId);
  const out = await systemStep(trx, orgId, async (t) => {
    const req = await lockRequest(t, orgId, requestId);
    if (req.status !== 'PENDING') throw errors.invalidState(`The request is already ${req.status}.`);
    if (req.requestedBy !== actor.userId && !isRequestSubject(grant, actor.userId, req)) throw errors.forbidden('Only the requester or the person concerned can answer.');
    if (!req.infoRequestedAt) throw errors.invalidState('No question is waiting for an answer on this request.');
    const steps = await loadSteps(t, req.id);
    const step = steps.find((s) => s.stepNo === req.currentStep && s.status === 'PENDING');
    await t.updateTable('approvalRequests').set({ infoRequestedAt: null }).where('id', '=', req.id).execute();
    await recordEvent(t, orgId, req.id, 'info_answered', actor.userId, { stepNo: req.currentStep, comment });
    await hookFor(req.entityType)?.onInfoAnswered?.(deps, t, hookCtx(orgId, req, actor, comment));
    const payload = await requestPayload(t, orgId, req);
    await emitTargeted(t, orgId, 'approval.info_answered', req.id, (step?.actors ?? []).filter((a) => a.decision === 'PENDING').map((a) => a.userId), { ...payload, comment, answeredBy: actor.userId }, actor);
    return { requestId: req.id, entityType: req.entityType, entityId: req.entityId, branchId: req.branchId, status: req.status };
  });
  await audit(trx, actor, orgId, 'approval.info_answered', 'approval_request', { entityId: requestId, branchId: out.branchId, newValue: { comment } });
  return out;
}

export { hookFor, approvePermissionFor, viewPermissionFor, managePermissionFor };
export const _internal = { loadSteps, lockRequest, recordEvent };
