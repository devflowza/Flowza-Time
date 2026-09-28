import type { ApprovalContextDto, ApprovalEntity, Permission } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import type { ApiDeps } from '../../../deps.js';
import type { Actor } from '../../../lib/service.js';
import { correctionHook } from './corrections.js';
import { leaveHook } from './leave.js';
import { attendanceNoteHook } from './attendance-notes.js';
import { regularisationHook } from './regularisations.js';
import { shiftSwapHook } from './shift-swaps.js';
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
   * What the decision carried besides approve / reject (HR portal Prompt 4): the engine's own decision detail (`via`,
   * `stepNo`, …) plus the caller's extras — a note rejection's `payEffectDays`, a note review's `outcome: 'excuse'`.
   * Absent for auto-approvals, bypasses and cancellations.
   */
  detail?: Record<string, unknown>;
  /**
   * The document needed no approval at all (leave v2: a leave type with `requires_approval = false`): nobody decided, so
   * a hook records no approver.
   */
  notRequired?: boolean;
  /**
   * The request was closed by the SYSTEM (HR portal Prompt 4 review, P2-11: the entity's `approvalBlocker` refused an
   * approval): nobody decided — `actor` is the person whose approval attempt triggered it, `comment` the system's reason.
   */
  system?: boolean;
}

/**
 * Per-entity behaviour the generic engine cannot know: which permission decides it, what the inbox shows, and what
 * happens to the document on approval / rejection / cancellation. Later prompts register notes, swaps, comp-off,
 * regularisation and overtime here; an entity type without a hook still gets a request row, decisions and a GENERIC
 * context — only the document side stays untouched (Finance parity: the engine never blocks on a missing hook).
 */
export interface EntityHook {
  entityType: ApprovalEntity;
  /**
   * Holders who also hold `viewPermission` (organisation-wide, branch scope applies) may decide a level they are not seated
   * on — as an override that fills ONE pending seat and must name the level (Finance B-91). A holder who reaches the subject
   * only through the reporting line (a line manager) never overrides: they decide where they are seated or delegated.
   */
  approvePermission: Permission;
  /** Org-wide read key: an approve-key holder who also holds it (branch scope applies) may decide as an organisation-wide override. */
  viewPermission: Permission;
  /** Further keys that decide like `approvePermission` (attendance notes: `attendance.review_notes` OR `attendance.approve`). */
  alsoApprovePermissions?: Permission[];
  /**
   * Who may withdraw somebody else's request of this entity (with the org-wide view key, Finance B-98), besides the requester,
   * the subject and approval.manage / owner. Optional: without it the entity family's key applies (leave.manage for leave /
   * comp-off, attendance.correct for the attendance family). Declared by the portal hooks (HR portal Prompt 4).
   */
  managePermission?: Permission;
  /**
   * Why the document can no longer be approved, checked by the engine before an APPROVE decision or an exception approval
   * is recorded (HR portal Prompt 4 review, P2-11 — a swap whose colleague is no longer employed on the swap day). A reason
   * makes the engine reject the request BY THE SYSTEM with it (onRejected runs with `system: true`); null = go ahead.
   */
  approvalBlocker?(deps: ApiDeps, trx: Trx, ctx: HookContext): Promise<string | null>;
  onApproved(deps: ApiDeps, trx: Trx, ctx: HookContext): Promise<void>;
  onRejected(deps: ApiDeps, trx: Trx, ctx: HookContext): Promise<void>;
  onCancelled?(deps: ApiDeps, trx: Trx, ctx: HookContext): Promise<void>;
  /** An approver asked for more information (the request stays pending; leave v2: leave → INFO_REQUESTED); `ctx.comment` is the question. */
  onInfoRequested?(deps: ApiDeps, trx: Trx, ctx: HookContext): Promise<void>;
  /** The requester / subject answered (leave v2: leave → PENDING); `ctx.comment` is the answer. */
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
  COMP_OFF: compOffHook,
};

/** Fallback for entity types without a registered hook: decisions still need a permission — the attendance one, like every other request. */
export const GENERIC_APPROVE_PERMISSION: Permission = 'attendance.approve';
export const GENERIC_VIEW_PERMISSION: Permission = 'attendance.view';

/**
 * Keys of an entity type without a registered hook, by family: leave and comp-off are decided with the leave keys, every
 * other type (corrections, notes, regularisation, swaps, overtime) with the attendance keys. A hook overrides them.
 */
const LEAVE_FAMILY: readonly ApprovalEntity[] = ['LEAVE', 'COMP_OFF'];
const familyKeys = (entityType: ApprovalEntity): { approve: Permission; view: Permission; manage: Permission } =>
  LEAVE_FAMILY.includes(entityType) ? { approve: 'leave.approve', view: 'leave.view', manage: 'leave.manage' } : { approve: GENERIC_APPROVE_PERMISSION, view: GENERIC_VIEW_PERMISSION, manage: 'attendance.correct' };

export function hookFor(entityType: ApprovalEntity): EntityHook | null {
  return entityHooks[entityType] ?? null;
}
export function approvePermissionFor(entityType: ApprovalEntity): Permission {
  return hookFor(entityType)?.approvePermission ?? familyKeys(entityType).approve;
}
export function viewPermissionFor(entityType: ApprovalEntity): Permission {
  return hookFor(entityType)?.viewPermission ?? familyKeys(entityType).view;
}
/** The key that lets somebody other than the requester withdraw a request of this entity (with the org-wide view key). */
export function managePermissionFor(entityType: ApprovalEntity): Permission {
  return hookFor(entityType)?.managePermission ?? familyKeys(entityType).manage;
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
