import type { ApprovalContextDto } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { addDays, errors } from '@flowza/shared';
import type { ApiDeps } from '../../../deps.js';
import { hasPermission } from '../../../lib/authorize.js';
import { isoDate } from '../../../lib/mappers.js';
import { enqueueRecalculation, orgToday } from '../../features/recalc.js';
import { REQUEST_COLUMNS, clock, monthUsage, requestQuery, type RequestRow } from '../../short-leave/common.js';
import type { EntityHook, HookContext } from './index.js';

/**
 * Short leave (entity SHORT_LEAVE, migration 20261019000310): decided with the leave keys (leave.approve; leave.view reads
 * organisation-wide; leave.manage withdraws on the employee's behalf). Approval stamps APPROVED + who / when / the note and
 * recomputes the day (and the evening before, for a night shift) when it is not in the future; rejection records the note; a
 * cancelled request withdraws a still-pending one. The engine's generic decision notice tells the employee. Runs inside the
 * engine's system step.
 */

/** B-54, like leave: a window in a locked attendance period is approved only by a holder of attendance.lock_period. */
async function assertApprovalUnlocked(trx: Trx, ctx: HookContext): Promise<void> {
  const r = await trx.selectFrom('timeOffRequests').select(['branchId', 'requestDate']).where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).where('status', '=', 'PENDING').executeTakeFirst();
  if (!r) return;
  const lock = await trx.selectFrom('attendancePeriodLocks').select('id').where('organizationId', '=', ctx.orgId).where('unlockedAt', 'is', null)
    .where('periodStart', '<=', r.requestDate).where('periodEnd', '>=', r.requestDate)
    .where((eb) => (r.branchId ? eb.or([eb('branchId', 'is', null), eb('branchId', '=', r.branchId)]) : eb('branchId', 'is', null))).executeTakeFirst();
  if (!lock) return;
  const grant = ctx.actor.principal?.memberships.find((m) => m.organizationId === ctx.orgId) ?? null;
  if (grant && hasPermission(grant, 'attendance.lock_period')) return;
  throw errors.periodLocked('This short leave falls in a locked attendance period; unlock the period before approving it.');
}

export const shortLeaveHook: EntityHook = {
  entityType: 'SHORT_LEAVE',
  approvePermission: 'leave.approve',
  viewPermission: 'leave.view',
  managePermission: 'leave.manage',
  async onApproved(deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await assertApprovalUnlocked(trx, ctx);
    const r = await trx.updateTable('timeOffRequests').set({ status: 'APPROVED', decidedBy: ctx.notRequired ? null : ctx.actor.userId, decidedAt: new Date(), ...(ctx.comment ? { decisionNote: ctx.comment.slice(0, 1000) } : {}) })
      .where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).where('status', '=', 'PENDING')
      .returning(['id', 'employeeId', 'requestDate']).executeTakeFirst();
    // recorded without a decision (HR on the employee's behalf, a type that needs no approval): the caller owns the recompute
    if (!r || ctx.auto) return;
    const today = await orgToday(trx, ctx.orgId);
    const date = isoDate(r.requestDate);
    if (date <= today) await enqueueRecalculation(deps, trx, ctx.actor, ctx.orgId, { fromDate: addDays(date, -1), toDate: date, employeeIds: [r.employeeId], reason: 'short leave approved' });
  },
  async onRejected(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await trx.updateTable('timeOffRequests').set({ status: 'REJECTED', decidedBy: ctx.system ? null : ctx.actor.userId, decidedAt: new Date(), ...(ctx.comment ? { decisionNote: ctx.comment.slice(0, 1000) } : {}) })
      .where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).where('status', '=', 'PENDING').execute();
  },
  async onCancelled(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await trx.updateTable('timeOffRequests').set({ status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: ctx.actor.userId, cancelReason: (ctx.comment ?? 'Withdrawn').slice(0, 1000) })
      .where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).where('status', '=', 'PENDING').execute();
  },
  async loadContexts(trx: Trx, orgId: string, entityIds: string[]) {
    const out = new Map<string, ApprovalContextDto>();
    if (!entityIds.length) return out;
    const rows = (await requestQuery(trx, orgId).select(REQUEST_COLUMNS).where('r.id', 'in', entityIds).execute()) as RequestRow[];
    for (const r of rows) {
      const date = isoDate(r.requestDate);
      // the month's use of the type WITHOUT this request: what the approver weighs it against
      const usage = await monthUsage(trx, orgId, r.employeeId, r.timeOffTypeId, date, r.id);
      const quota = await trx.selectFrom('timeOffTypes').select(['monthlyQuotaMinutes', 'monthlyQuotaCount']).where('id', '=', r.timeOffTypeId).executeTakeFirst();
      const startTime = clock(r.startTime); const endTime = clock(r.endTime);
      out.set(r.id, {
        kind: 'SHORT_LEAVE', summary: `${r.typeName} · ${date} ${startTime}–${endTime}`,
        shortLeave: {
          id: r.id, typeName: r.typeName, typeNameAr: r.typeNameAr, category: r.category as 'PERSONAL', countsAsWork: r.countsAsWork, date, startTime, endTime, minutes: r.minutes, reason: r.reason,
          status: r.status as 'PENDING', monthUsedMinutes: usage.usedMinutes, monthUsedCount: usage.usedCount, monthQuotaMinutes: quota?.monthlyQuotaMinutes ?? null, monthQuotaCount: quota?.monthlyQuotaCount ?? null,
        },
      });
    }
    return out;
  },
  summary(context) {
    return context.kind === 'SHORT_LEAVE' ? context.summary : null;
  },
};
