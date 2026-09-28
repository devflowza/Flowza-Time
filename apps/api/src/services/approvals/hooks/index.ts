import type { ApprovalContextDto, ApprovalEntity, Permission } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import type { ApiDeps } from '../../../deps.js';
import type { Actor } from '../../../lib/service.js';
import { correctionHook } from './corrections.js';
import { leaveHook } from './leave.js';
import { compOffHook } from './comp-off.js';

/** What the engine hands an entity hook when a request reaches a terminal state. Runs inside the engine's system step. */
export interface HookContext {
  orgId: string;
  requestId: string;
  entityId: string;
  employeeId: string | null;
  branchId: string | null;
  /** The person whose decision completed the request (the requester for auto-approvals). */
  actor: Actor;
  comment: string | null;
  /**
   * True when no workflow applied and the caller's policy approved at submit (HR recording leave, HR correcting a day): the
   * caller already owns the side effects it always had (response fields, recalculation), so a hook only applies the outcome.
   */
  auto?: boolean;
  /**
   * The document needed no approval at all (leave v2: a leave type with `requires_approval = false`): nobody decided, so
   * a hook records no approver.
   */
  notRequired?: boolean;
}

/**
 * Per-entity behaviour the generic engine cannot know: which permission decides it, what the inbox shows, and what
 * happens to the document on approval / rejection / cancellation. Later prompts register notes, swaps, comp-off,
 * regularisation and overtime here; an entity type without a hook still gets a request row, decisions and a GENERIC
 * context — only the document side stays untouched (Finance parity: the engine never blocks on a missing hook).
 */
export interface EntityHook {
  entityType: ApprovalEntity;
  /** Holders may decide any step of the entity's requests (Finance B-91), within their org-wide or team scope. */
  approvePermission: Permission;
  /** Org-wide read key: with it, a permission holder decides across the organisation; without it, only for direct reports. */
  viewPermission: Permission;
  /**
   * Who may withdraw somebody else's request of this entity (with the org-wide view key, Finance B-98), besides the
   * requester and approval.manage — the key the integrated engine's `canCancel` reads (`managePermissionFor`). Leave and
   * comp-off set `leave.manage`; in this branch their `mayCancel` applies exactly that rule.
   */
  managePermission?: Permission;
  onApproved(deps: ApiDeps, trx: Trx, ctx: HookContext): Promise<void>;
  onRejected(deps: ApiDeps, trx: Trx, ctx: HookContext): Promise<void>;
  onCancelled?(deps: ApiDeps, trx: Trx, ctx: HookContext): Promise<void>;
  /** An approver asked for more information (`ctx.comment` = the question); the request stays pending (leave v2: leave → INFO_REQUESTED). */
  onInfoRequested?(deps: ApiDeps, trx: Trx, ctx: HookContext): Promise<void>;
  /** The requester / subject answered (`ctx.comment` = the answer; leave v2: leave → PENDING). */
  onInfoAnswered?(deps: ApiDeps, trx: Trx, ctx: HookContext): Promise<void>;
  /** Inbox / detail context for a page of requests (system scope; ids the caller could already see). */
  loadContexts(trx: Trx, orgId: string, entityIds: string[]): Promise<Map<string, ApprovalContextDto>>;
  /** A one-line description for notifications. */
  summary?(context: ApprovalContextDto): string | null;
  /**
   * The hook announces the decision to the person the request is about itself (leave.approved / leave.rejected), so the
   * engine leaves the subject out of `approval.decided` — one notice per decision, the entity-specific one.
   */
  notifiesSubject?: boolean;
  /**
   * Who may withdraw the entity's pending request, when the entity has its own rule. Leave and comp-off (leave v2, Finance
   * B-97/B-98, review P2-4): the requester; the owner or approval.manage; or a `leave.manage` holder WITH the
   * organisation-wide `leave.view` (branch scope applies) — never an approver who is merely seated on it, and never the
   * person a request is about when HR filed it for them (the owner excepted). This is the integrated engine's
   * `canCancel` with `managePermission: 'leave.manage'`; on merge, keep the engine's rule and drop this hook field.
   * Without it the engine's generic rule applies.
   */
  mayCancel?(grant: MembershipGrant, userId: string, req: { requestedBy: string | null; subjectUserId: string | null; employeeId: string | null; branchId: string | null }): boolean;
}

export const entityHooks: Partial<Record<ApprovalEntity, EntityHook>> = {
  ATTENDANCE_CORRECTION: correctionHook,
  LEAVE: leaveHook,
  COMP_OFF: compOffHook,
};

/** Fallback for entity types without a registered hook: decisions still need a permission — the attendance one, like every other request. */
export const GENERIC_APPROVE_PERMISSION: Permission = 'attendance.approve';
export const GENERIC_VIEW_PERMISSION: Permission = 'attendance.view';

export function hookFor(entityType: ApprovalEntity): EntityHook | null {
  return entityHooks[entityType] ?? null;
}
export function approvePermissionFor(entityType: ApprovalEntity): Permission {
  return hookFor(entityType)?.approvePermission ?? GENERIC_APPROVE_PERMISSION;
}
export function viewPermissionFor(entityType: ApprovalEntity): Permission {
  return hookFor(entityType)?.viewPermission ?? GENERIC_VIEW_PERMISSION;
}
