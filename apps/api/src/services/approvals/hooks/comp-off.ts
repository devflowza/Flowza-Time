import { DateTime } from 'luxon';
import { resolveLeaveSettings, type ApprovalContextDto } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import type { ApiDeps } from '../../../deps.js';
import { isoDate } from '../../../lib/mappers.js';
import type { EntityHook, HookContext } from './index.js';
import { mayWithdrawLeave } from './leave.js';

/**
 * Comp-off credits (leave v2, Finance parity A13): approval makes the credit usable until `worked_on +
 * leave.compOffExpiryDays` (default 90); rejection records the reason; a withdrawn request is `cancelled`. The credit is
 * redeemed later by a comp-off leave (hooks/leave.ts consumes it on that leave's approval). The engine tells the
 * requester about the decision (approval.decided).
 */
export const compOffHook: EntityHook = {
  entityType: 'COMP_OFF',
  approvePermission: 'leave.approve',
  viewPermission: 'leave.view',
  mayCancel: mayWithdrawLeave,
  async onApproved(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    const credit = await trx.selectFrom('compOffCredits').select(['id', 'workedOn']).where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).where('status', '=', 'pending_approval').executeTakeFirst();
    if (!credit) return;
    const settings = resolveLeaveSettings((await trx.selectFrom('organizationSettings').select('leave').where('organizationId', '=', ctx.orgId).executeTakeFirst())?.leave);
    const expiresOn = DateTime.fromISO(isoDate(credit.workedOn), { zone: 'utc' }).plus({ days: settings.compOffExpiryDays }).toISODate()!;
    await trx.updateTable('compOffCredits').set({ status: 'approved', expiresOn, ...(ctx.comment ? { decisionNote: ctx.comment } : {}) }).where('id', '=', credit.id).where('status', '=', 'pending_approval').execute();
  },
  async onRejected(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await trx.updateTable('compOffCredits').set({ status: 'rejected', ...(ctx.comment ? { decisionNote: ctx.comment } : {}) }).where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).where('status', '=', 'pending_approval').execute();
  },
  async onCancelled(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await trx.updateTable('compOffCredits').set({ status: 'cancelled', ...(ctx.comment ? { decisionNote: ctx.comment } : {}) }).where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).where('status', '=', 'pending_approval').execute();
  },
  async loadContexts(trx: Trx, orgId: string, entityIds: string[]) {
    const out = new Map<string, ApprovalContextDto>();
    if (!entityIds.length) return out;
    const rows = await trx.selectFrom('compOffCredits').select(['id', 'employeeId', 'workedOn', 'workedOnType', 'workedMinutes', 'daysEarned', 'location', 'summary', 'status']).where('organizationId', '=', orgId).where('id', 'in', entityIds).execute();
    // what the daily record says about the worked day (evidence for the approver)
    const evidence = rows.length ? await trx.selectFrom('attendanceDailyRecords').select(['employeeId', 'attendanceDate', 'workedMinutes'])
      .where('organizationId', '=', orgId).where((eb) => eb.or(rows.map((r) => eb.and([eb('employeeId', '=', r.employeeId), eb('attendanceDate', '=', r.workedOn)])))).execute() : [];
    for (const r of rows) {
      const day = isoDate(r.workedOn);
      const rec = evidence.find((e) => e.employeeId === r.employeeId && isoDate(e.attendanceDate) === day);
      out.set(r.id, { kind: 'COMP_OFF', compOff: { id: r.id, workedOn: day, workedOnType: r.workedOnType, workedMinutes: r.workedMinutes, recordedMinutes: rec ? rec.workedMinutes : null, daysEarned: Number(r.daysEarned), location: r.location, summary: r.summary, status: r.status } });
    }
    return out;
  },
  summary(context) {
    return context.kind === 'COMP_OFF' ? `Comp-off · worked ${context.compOff.workedOn} (${context.compOff.workedOnType.replace('_', ' ')}) · ${context.compOff.daysEarned} day` : null;
  },
};
