import type { Trx } from '@flowza/database';
import type { ApiDeps } from '../../../deps.js';
import { applyTimeAwayApproval, applyTimeAwayClosed, timeAwayApprovalBlocker, timeAwayContexts } from '../../portal/time-away-effects.js';
import type { EntityHook, HookContext } from './index.js';

/**
 * Time away inside the working day (docs/time-away.md): approval makes the window count for the engine (official duty /
 * personal permission) and recomputes its day; rejection records the outcome; withdrawing an approved window recomputes the day
 * again. Decided like the rest of the attendance family (the line manager, or a workflow); the subject hears through the
 * engine's `approval.decided`.
 */
export const timeAwayHook: EntityHook = {
  entityType: 'TIME_AWAY',
  approvePermission: 'attendance.approve',
  viewPermission: 'attendance.view',
  managePermission: 'attendance.correct',
  async approvalBlocker(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    return timeAwayApprovalBlocker(trx, ctx);
  },
  async onApproved(deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await applyTimeAwayApproval(deps, trx, ctx);
  },
  async onRejected(deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await applyTimeAwayClosed(deps, trx, ctx, 'rejected');
  },
  async onCancelled(deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await applyTimeAwayClosed(deps, trx, ctx, 'cancelled');
  },
  loadContexts: timeAwayContexts,
  summary(context) {
    return context.kind === 'TIME_AWAY' ? context.summary : null;
  },
};
