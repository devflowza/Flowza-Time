import type { Trx } from '@flowza/database';
import type { ApiDeps } from '../../../deps.js';
import { applyRegularisationApproval, applyRegularisationCancelled, applyRegularisationRejection, regularisationContexts } from '../../portal/regularisation-effects.js';
import type { EntityHook, HookContext } from './index.js';

/**
 * Regularisations (the employee's "fix my day" request — HR portal Prompt 4): approval applies them through attendance
 * corrections (ADD / EDIT punch, SET_STATUS PRESENT) queued for the worker; rejection and withdrawal record the outcome.
 * The employee is told through attendance.regularisation_decided.
 */
export const regularisationHook: EntityHook = {
  entityType: 'REGULARISATION',
  approvePermission: 'attendance.approve',
  viewPermission: 'attendance.view',
  notifiesSubject: true,
  async onApproved(deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await applyRegularisationApproval(deps, trx, ctx);
  },
  async onRejected(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await applyRegularisationRejection(trx, ctx);
  },
  async onCancelled(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await applyRegularisationCancelled(trx, ctx);
  },
  loadContexts: regularisationContexts,
  summary(context) {
    return context.kind === 'REGULARISATION' ? context.summary : null;
  },
};
