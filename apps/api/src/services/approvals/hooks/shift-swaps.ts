import type { Trx } from '@flowza/database';
import type { ApiDeps } from '../../../deps.js';
import { applySwapApproval, applySwapClosed, swapContexts } from '../../portal/swap-effects.js';
import type { EntityHook, HookContext } from './index.js';

/**
 * Shift swaps (HR portal Prompt 4): approval re-validates the day and writes two one-day employee assignments (each works
 * the other's shift); rejection and withdrawal record the outcome. Both employees hear about the decision through
 * shift.swap_decided.
 */
export const shiftSwapHook: EntityHook = {
  entityType: 'SHIFT_SWAP',
  approvePermission: 'shift.assign',
  // the swap carries the employee's own reason: organisation-wide reading is HR's (attendance.view), like the table's RLS
  viewPermission: 'attendance.view',
  notifiesSubject: true,
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
