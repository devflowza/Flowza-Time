import type { ApiDeps } from '../../../deps.js';
import type { Trx } from '@flowza/database';
import { applyNoteDecision, applyNoteInfoAnswered, applyNoteInfoRequest, noteContexts } from '../../portal/note-effects.js';
import type { EntityHook, HookContext } from './index.js';

/**
 * Attendance notes (the employee's reason for a day — HR portal Prompt 4). Decided by the line manager seated on the
 * request, or through organisation-wide oversight by `attendance.review_notes` / `attendance.approve` holders. An approval
 * whose detail says `outcome: 'excuse'` (the notes review page) excuses the day; a rejection charges the pay effect the
 * decider chose (`detail.payEffectDays`, 0 when the inbox did not say). The employee hears about every outcome through
 * attendance.note_decided / attendance.note_info_requested, so the generic notices leave them out.
 */
export const attendanceNoteHook: EntityHook = {
  entityType: 'ATTENDANCE_NOTE',
  approvePermission: 'attendance.review_notes',
  alsoApprovePermissions: ['attendance.approve'],
  viewPermission: 'attendance.view',
  notifiesSubject: true,
  async onApproved(deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await applyNoteDecision(deps, trx, ctx, ctx.detail?.['outcome'] === 'excuse' ? 'excuse' : 'approve');
  },
  async onRejected(deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await applyNoteDecision(deps, trx, ctx, 'reject');
  },
  // a withdrawn / invalidated request leaves the note as it is: the employee edits it (a new request) or a reviewer decides it directly
  async onInfoRequested(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await applyNoteInfoRequest(trx, ctx);
  },
  async onInfoAnswered(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await applyNoteInfoAnswered(trx, ctx.orgId, ctx.entityId);
  },
  loadContexts: noteContexts,
  summary(context) {
    return context.kind === 'ATTENDANCE_NOTE' ? context.summary : null;
  },
};
