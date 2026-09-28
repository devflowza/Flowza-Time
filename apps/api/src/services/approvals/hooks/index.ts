import type { ApprovalContextDto, ApprovalEntity, Permission } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import type { ApiDeps } from '../../../deps.js';
import type { Actor } from '../../../lib/service.js';
import { correctionHook } from './corrections.js';
import { leaveHook } from './leave.js';

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
  /**
   * Who may withdraw somebody else's request of this entity (with the org-wide view key, Finance B-98), besides the requester
   * and approval.manage. Optional: without it the entity family's key applies (leave.manage for leave / comp-off,
   * attendance.correct for the attendance family).
   */
  managePermission?: Permission;
  onApproved(deps: ApiDeps, trx: Trx, ctx: HookContext): Promise<void>;
  onRejected(deps: ApiDeps, trx: Trx, ctx: HookContext): Promise<void>;
  onCancelled?(deps: ApiDeps, trx: Trx, ctx: HookContext): Promise<void>;
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
