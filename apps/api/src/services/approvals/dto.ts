import type { ApprovalAbilitiesDto, ApprovalActorDto, ApprovalContextDto, ApprovalEntity, ApprovalEscalationTarget, ApprovalRequestDto, ApprovalRequestStatus, ApprovalStepDto, ApprovalStepMode, ApprovalTimelineEventDto, ApproverType } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { pendingSeats, seatMustBeNamed, type MembershipGrant } from '@flowza/domain';
import { hasPermission } from '../../lib/authorize.js';
import { isoDateTime, isoDateTimeOrNull, jsonObject, numberOrNull } from '../../lib/mappers.js';
import type { Actor } from '../../lib/service.js';
import { withSystemScope } from '../../lib/service.js';
import { loadDelegationMap } from './context.js';
import { approvalToday, approvePermissionFor, assessDecider, canBypass, canCancel, decideViaOf, hookFor, isPrimarySubject, isRequestSubject, viewPermissionFor } from './engine.js';

type RequestRow = {
  id: string; organizationId: string; workflowId: string | null; entityType: ApprovalEntity; entityId: string; branchId: string | null; departmentId: string | null; employeeId: string | null; units: string | number | null;
  currentStep: number; status: string; requestedBy: string | null; subjectUserId: string | null; infoRequestedAt: Date | null; completedAt: Date | null; decidedBy: string | null; cancelReason: string | null; invalidationReason: string | null; createdAt: Date; updatedAt: Date;
  /** Other people the request is about (HR portal Prompt 4 review, P0-2); absent on rows of an older schema. */
  coSubjectEmployeeIds?: string[] | null; coSubjectUserIds?: string[] | null;
};
type StepRow = {
  id: string; requestId: string; stepNo: number; approverType: ApproverType; approverRoleId: string | null; approverUserId: string | null; permissionKey: string | null; mode: string; requiredCount: number | null; status: string;
  resolutionPath: string | null; resolutionReason: string | null; activatedAt: Date | null; dueAt: Date | null; escalateTo: string | null; escalatedAt: Date | null; remindedAt: Date | null; actedBy: string | null; actedAt: Date | null; comment: string | null;
};
type ActorRow = { id: string; stepId: string; userId: string; viaDelegationOf: string | null; onBehalfOfUserId: string | null; resolutionPath: string | null; decision: string; decidedAt: Date | null; comment: string | null; createdAt: Date };
type EventRow = { id: string | number; requestId: string; at: Date; actorUserId: string | null; kind: string; detail: unknown };

export interface HydrateOptions { withEvents?: boolean }

/**
 * Rows → DTOs for one page of requests. The rows were selected under the CALLER's RLS (visibility decided there); the
 * enrichment — names, contexts, actors — runs in the organisation's system scope because a line manager's role cannot
 * read the HR admin's profile or the employee's leave type, and hiding them would render an inbox of ids.
 */
export async function hydrateRequests(trx: Trx, actor: Actor, grant: MembershipGrant, orgId: string, rows: RequestRow[], opts: HydrateOptions = {}): Promise<ApprovalRequestDto[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  return withSystemScope(trx, orgId, async (t) => {
    const steps = (await t.selectFrom('approvalSteps').selectAll().where('requestId', 'in', ids).orderBy('stepNo').execute()) as StepRow[];
    // a deterministic read order (written-at, then user id — never a random row id); seats are ordered by the domain's `seatOrder`
    const actors = steps.length ? ((await t.selectFrom('approvalStepActors').selectAll().where('stepId', 'in', steps.map((s) => s.id)).orderBy('createdAt').orderBy('userId').execute()) as ActorRow[]) : [];
    const events = opts.withEvents ? ((await t.selectFrom('approvalRequestEvents').selectAll().where('requestId', 'in', ids).orderBy('at').orderBy('id').execute()) as EventRow[]) : [];
    const workflowIds = [...new Set(rows.map((r) => r.workflowId).filter((x): x is string => !!x))];
    const workflows = workflowIds.length ? await t.selectFrom('approvalWorkflows').select(['id', 'name']).where('id', 'in', workflowIds).execute() : [];
    const employeeIds = [...new Set(rows.map((r) => r.employeeId).filter((x): x is string => !!x))];
    const employees = employeeIds.length ? await t.selectFrom('employees').select(['id', 'displayName', 'employeeNumber']).where('organizationId', '=', orgId).where('id', 'in', employeeIds).execute() : [];
    const userIds = [...new Set([...rows.flatMap((r) => [r.requestedBy, r.decidedBy, r.subjectUserId]), ...steps.map((s) => s.actedBy), ...actors.flatMap((a) => [a.userId, a.viaDelegationOf, a.onBehalfOfUserId]), ...events.map((e) => e.actorUserId)].filter((x): x is string => !!x))];
    const users = userIds.length ? await t.selectFrom('userProfiles').select(['id', 'fullName', 'email']).where('id', 'in', userIds).execute() : [];
    const nameOf = new Map(users.map((u) => [u.id, u.fullName || u.email]));
    const name = (id: string | null): string | null => (id ? nameOf.get(id) ?? null : null);
    const employeeById = new Map(employees.map((e) => [e.id, e]));
    const workflowById = new Map(workflows.map((w) => [w.id, w]));
    // contexts per entity type through the hooks
    const contexts = new Map<string, ApprovalContextDto>();
    const byType = new Map<ApprovalEntity, string[]>();
    for (const r of rows) { const arr = byType.get(r.entityType) ?? []; arr.push(r.entityId); byType.set(r.entityType, arr); }
    for (const [type, entityIds] of byType) {
      const hook = hookFor(type);
      if (!hook) continue;
      for (const [id, c] of await hook.loadContexts(t, orgId, [...new Set(entityIds)])) contexts.set(`${type}:${id}`, c);
    }
    // the organisation's date, the one definition of "today" for delegations (review P2-1)
    const today = await approvalToday(t, orgId);
    const delegatorsByType = new Map<ApprovalEntity, Set<string>>();
    for (const type of byType.keys()) {
      const map = await loadDelegationMap(t, orgId, type, today);
      delegatorsByType.set(type, new Set([...map.entries()].filter(([, d]) => d === actor.userId).map(([k]) => k)));
    }
    const toActor = (a: ActorRow): ApprovalActorDto => ({ userId: a.userId, userName: name(a.userId), viaDelegationOf: a.viaDelegationOf, viaDelegationOfName: name(a.viaDelegationOf), onBehalfOfUserId: a.onBehalfOfUserId, onBehalfOfName: name(a.onBehalfOfUserId), resolutionPath: a.resolutionPath, decision: a.decision as ApprovalActorDto['decision'], decidedAt: isoDateTimeOrNull(a.decidedAt), comment: a.comment });
    const toStep = (s: StepRow): ApprovalStepDto => {
      const rowsOfStep = actors.filter((a) => a.stepId === s.id);
      return {
        id: s.id, requestId: s.requestId, stepNo: s.stepNo, approverType: s.approverType, approverRoleId: s.approverRoleId, approverUserId: s.approverUserId, permissionKey: s.permissionKey,
        mode: s.mode as ApprovalStepMode, requiredCount: s.requiredCount, status: s.status as ApprovalStepDto['status'], resolutionPath: s.resolutionPath, resolutionReason: s.resolutionReason,
        activatedAt: isoDateTimeOrNull(s.activatedAt), dueAt: isoDateTimeOrNull(s.dueAt), escalateTo: (s.escalateTo as ApprovalEscalationTarget | null) ?? null, escalatedAt: isoDateTimeOrNull(s.escalatedAt), remindedAt: isoDateTimeOrNull(s.remindedAt),
        actedBy: s.actedBy, actedByName: name(s.actedBy), actedAt: isoDateTimeOrNull(s.actedAt), comment: s.comment,
        actors: rowsOfStep.map(toActor),
        // the seats still waiting in SEAT ORDER — the same list, in the same order, the engine picks an override's seat from
        pendingSeats: pendingSeats(rowsOfStep).map((userId) => ({ userId, userName: name(userId) })),
      };
    };
    return rows.map((r): ApprovalRequestDto => {
      const mySteps = steps.filter((s) => s.requestId === r.id).map(toStep);
      const current = mySteps.find((s) => s.stepNo === r.currentStep) ?? null;
      const wf = r.workflowId ? workflowById.get(r.workflowId) : undefined;
      const emp = r.employeeId ? employeeById.get(r.employeeId) : undefined;
      const context: ApprovalContextDto = contexts.get(`${r.entityType}:${r.entityId}`) ?? { kind: 'GENERIC', entityType: r.entityType, summary: null };
      const pending = r.status === 'PENDING';
      // the same rule the engine applies to a decision (review P0-1): the UI never offers a button the API refuses
      const check = assessDecider({ grant, userId: actor.userId, request: { entityType: r.entityType, requestedBy: r.requestedBy, subjectUserId: r.subjectUserId, employeeId: r.employeeId, branchId: r.branchId, coSubjectEmployeeIds: r.coSubjectEmployeeIds ?? null, coSubjectUserIds: r.coSubjectUserIds ?? null }, stepActors: current?.actors.map((a) => ({ userId: a.userId, viaDelegationOf: a.viaDelegationOf, onBehalfOfUserId: a.onBehalfOfUserId, resolutionPath: a.resolutionPath, decision: a.decision })) ?? [], delegators: delegatorsByType.get(r.entityType) ?? new Set() });
      const levelOpen = pending && current?.status === 'PENDING';
      const canDecide = levelOpen && check.ok && !check.alreadyDecided;
      const isOwner = grant.roleKey === 'owner';
      const involved = isRequestSubject(grant, actor.userId, r) || r.requestedBy === actor.userId;
      const abilities: ApprovalAbilitiesDto = {
        canDecide,
        canCancel: pending && canCancel(grant, actor.userId, r),
        canReassign: pending && (hasPermission(grant, 'approval.manage') || isOwner) && !check.branchBlocked && (isOwner || !involved),
        canBypass: pending && canBypass(grant, actor.userId, r),
        canRequestInfo: levelOpen && !!check.via && check.sodBlocked === null && !(check.override && check.branchBlocked),
        canAnswerInfo: pending && !!r.infoRequestedAt && (r.requestedBy === actor.userId || isPrimarySubject(grant, actor.userId, r)),
        actingAsDelegateOf: check.via === 'delegate' ? check.delegateOf : null,
        decideVia: canDecide ? decideViaOf(check) : null,
        // the engine's rule: an override / escalated decision on an ALL / QUORUM level with several seats waiting names its seat
        mustChooseSeat: canDecide && (check.override || check.via === 'escalated') && !!current && seatMustBeNamed(current.mode, current.pendingSeats?.length ?? 0),
      };
      return {
        id: r.id, organizationId: r.organizationId, workflowId: r.workflowId, workflowName: wf?.name ?? null, entityType: r.entityType, entityId: r.entityId,
        branchId: r.branchId, departmentId: r.departmentId, employeeId: r.employeeId, employeeName: emp?.displayName ?? null, employeeNumber: emp?.employeeNumber ?? null, units: numberOrNull(r.units),
        currentStep: r.currentStep, stepCount: mySteps.length, status: r.status as ApprovalRequestStatus, requestedBy: r.requestedBy, requestedByName: name(r.requestedBy), subjectUserId: r.subjectUserId,
        infoRequestedAt: isoDateTimeOrNull(r.infoRequestedAt), completedAt: isoDateTimeOrNull(r.completedAt), decidedBy: r.decidedBy, decidedByName: name(r.decidedBy), cancelReason: r.cancelReason, invalidationReason: r.invalidationReason,
        createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt),
        steps: mySteps, context, abilities,
        ...(opts.withEvents ? { events: events.filter((e) => e.requestId === r.id).map((e): ApprovalTimelineEventDto => ({ id: String(e.id), at: isoDateTime(e.at), actorUserId: e.actorUserId, actorName: name(e.actorUserId), kind: e.kind, detail: jsonObject(e.detail) })) } : {}),
      };
    });
  });
}

/** The approve permission a caller needs for an entity (exported for route-level hints). */
export { approvePermissionFor, viewPermissionFor };
