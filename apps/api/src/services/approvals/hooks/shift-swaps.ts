import type { Trx } from '@flowza/database';
import type { ApiDeps } from '../../../deps.js';
import { applySwapApproval, applySwapClosed, swapApprovalBlocker, swapContexts } from '../../portal/swap-effects.js';
import type { EntityHook, HookContext } from './index.js';

/**
 * Shift swaps (HR portal Prompt 4): approval re-validates the day and writes two one-day employee assignments (each works
 * the other's shift); rejection and withdrawal record the outcome. Both employees hear about the decision through
 * shift.swap_decided. The colleague is a CO-SUBJECT of the request (review P0-2: they never decide it); an approval is refused
 * — the request rejected by the system — when either person is no longer employed on the swap day (review P2-11).
 */
export const shiftSwapHook: EntityHook = {
  entityType: 'SHIFT_SWAP',
  approvePermission: 'shift.assign',
  // the swap carries the employee's own reason: organisation-wide reading is HR's (attendance.view), like the table's RLS
  viewPermission: 'attendance.view',
  // the rota owner withdraws a swap on the employee's behalf
  managePermission: 'shift.manage',
  notifiesSubject: true,
  async approvalBlocker(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    return swapApprovalBlocker(trx, ctx);
  },
  async onApproved(deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await applySwapApproval(deps, trx, ctx);
  },
  async onRejected(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await applySwapClosed(trx, ctx, 'rejected');
  },
  async onCancelled(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await applySwapClosed(trx, ctx, 'cancelled');
  },
  loadContexts: swapContexts,
  summary(context) {
    return context.kind === 'SHIFT_SWAP' ? context.summary : null;
  },
};
