import type { ApprovalContextDto, ApprovalEntity, Permission } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import type { ApiDeps } from '../../../deps.js';
import type { Actor } from '../../../lib/service.js';
import { correctionHook } from './corrections.js';
import { leaveHook } from './leave.js';
import { attendanceNoteHook } from './attendance-notes.js';
import { regularisationHook } from './regularisations.js';
import { shiftSwapHook } from './shift-swaps.js';

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
   * What the decision carried besides approve / reject (HR portal Prompt 4): the engine's own decision detail (`via`,
   * `stepNo`, …) plus the caller's extras — a note rejection's `payEffectDays`, a note review's `outcome: 'excuse'`.
   * Absent for auto-approvals, bypasses and cancellations.
   */
  detail?: Record<string, unknown>;
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
  /** Further keys that decide like `approvePermission` (attendance notes: `attendance.review_notes` OR `attendance.approve`). */
  alsoApprovePermissions?: Permission[];
  onApproved(deps: ApiDeps, trx: Trx, ctx: HookContext): Promise<void>;
  onRejected(deps: ApiDeps, trx: Trx, ctx: HookContext): Promise<void>;
  onCancelled?(deps: ApiDeps, trx: Trx, ctx: HookContext): Promise<void>;
  /** An approver asked for more information (the request stays pending); `ctx.comment` is the question. */
  onInfoRequested?(deps: ApiDeps, trx: Trx, ctx: HookContext): Promise<void>;
  /** The requester / subject answered; `ctx.comment` is the answer. */
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
}

export const entityHooks: Partial<Record<ApprovalEntity, EntityHook>> = {
  ATTENDANCE_CORRECTION: correctionHook,
  LEAVE: leaveHook,
  ATTENDANCE_NOTE: attendanceNoteHook,
  REGULARISATION: regularisationHook,
  SHIFT_SWAP: shiftSwapHook,
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
/** Every key that decides the entity's requests: `approvePermission` plus the hook's `alsoApprovePermissions`. */
export function approvePermissionsFor(entityType: ApprovalEntity): Permission[] {
  const hook = hookFor(entityType);
  return hook ? [hook.approvePermission, ...(hook.alsoApprovePermissions ?? [])] : [GENERIC_APPROVE_PERMISSION];
}
/** True when the membership holds one of the entity's approve keys. */
export function holdsApprovePermission(grant: { permissions: readonly string[] }, entityType: ApprovalEntity): boolean {
  return approvePermissionsFor(entityType).some((p) => grant.permissions.includes(p));
}
