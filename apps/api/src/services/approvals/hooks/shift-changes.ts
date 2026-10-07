import type { Trx } from '@flowza/database';
import type { ApiDeps } from '../../../deps.js';
import { applyShiftChangeApproval, applyShiftChangeClosed, shiftChangeApprovalBlocker, shiftChangeContexts } from '../../portal/shift-change-effects.js';
import type { EntityHook, HookContext } from './index.js';

/**
 * Shift change requests (Enterprise, module `shift_requests` — docs/enterprise/plan.md §6): approval re-validates the range and
 * writes the employee's shift assignments (CHANGE) or the additional shift assignment (ADDITIONAL, a double shift); rejection
 * and withdrawal record the outcome. Decided like a swap — by the rota owner's key (shift.assign) or the seat the engine gave
 * the line manager — and the engine's generic decision notice tells the employee. An approval is refused (the request rejected
 * by the system) when the employee is no longer employed on the first day of the range.
 */
export const shiftChangeHook: EntityHook = {
  entityType: 'SHIFT_CHANGE',
  approvePermission: 'shift.assign',
  // the request carries the employee's own reason: organisation-wide reading is HR's (attendance.view), like the table's RLS
  viewPermission: 'attendance.view',
  // the rota owner withdraws a change on the employee's behalf
  managePermission: 'shift.manage',
  async approvalBlocker(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    return shiftChangeApprovalBlocker(trx, ctx);
  },
  async onApproved(deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await applyShiftChangeApproval(deps, trx, ctx);
  },
  async onRejected(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await applyShiftChangeClosed(trx, ctx, 'rejected');
  },
  async onCancelled(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await applyShiftChangeClosed(trx, ctx, 'cancelled');
  },
  loadContexts: shiftChangeContexts,
  summary(context) {
    return context.kind === 'SHIFT_CHANGE' ? context.summary : null;
  },
};
