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
  /** Holders may decide any step of the entity's requests (Finance B-91), within their org-wide or team scope. */
  approvePermission: Permission;
  /** Org-wide read key: with it, a permission holder decides across the organisation; without it, only for direct reports. */
  viewPermission: Permission;
  onApproved(deps: ApiDeps, trx: Trx, ctx: HookContext): Promise<void>;
  onRejected(deps: ApiDeps, trx: Trx, ctx: HookContext): Promise<void>;
  onCancelled?(deps: ApiDeps, trx: Trx, ctx: HookContext): Promise<void>;
  /** Inbox / detail context for a page of requests (system scope; ids the caller could already see). */
  loadContexts(trx: Trx, orgId: string, entityIds: string[]): Promise<Map<string, ApprovalContextDto>>;
  /** A one-line description for notifications. */
  summary?(context: ApprovalContextDto): string | null;
}

export const entityHooks: Partial<Record<ApprovalEntity, EntityHook>> = {
  ATTENDANCE_CORRECTION: correctionHook,
  LEAVE: leaveHook,
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
