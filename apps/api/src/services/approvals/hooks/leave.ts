import type { ApprovalContextDto } from '@flowza/contracts';
import { emitDomainEvent, type Trx } from '@flowza/database';
import { countLeaveDays, holidayDates, leaveBalances, type WorkingCalendar } from '@flowza/domain';
import type { ApiDeps } from '../../../deps.js';
import { isoDate, isoDateOrNull, numberOrNull } from '../../../lib/mappers.js';
import { enqueueRecalculation, orgToday } from '../../features/recalc.js';
import { dv } from '../../features/sql-helpers.js';
import type { EntityHook, HookContext } from './index.js';

/**
 * The working calendar of one employee (same precedence as the engine and the portal: employee → branch → organisation
 * weekly offs; the branch's holiday calendar, else the default one; branch-limited holidays honoured). System scope.
 */
export async function leaveWorkingCalendar(trx: Trx, orgId: string, employeeId: string, from: string, to: string): Promise<WorkingCalendar> {
  const emp = await trx.selectFrom('employees').select(['branchId', 'weeklyOffDays']).where('organizationId', '=', orgId).where('id', '=', employeeId).executeTakeFirst();
  const [org, branch, defaultCalendar] = await Promise.all([
    trx.selectFrom('organizations').select('weeklyOffDays').where('id', '=', orgId).executeTakeFirst(),
    emp ? trx.selectFrom('branches').select(['weeklyOffDays', 'holidayCalendarId']).where('organizationId', '=', orgId).where('id', '=', emp.branchId).executeTakeFirst() : Promise.resolve(undefined),
    trx.selectFrom('holidayCalendars').select('id').where('organizationId', '=', orgId).where('isDefault', '=', true).executeTakeFirst(),
  ]);
  const nums = (v: unknown): number[] | null => (Array.isArray(v) ? v.map(Number) : null);
  const weeklyOffDays = nums(emp?.weeklyOffDays) ?? nums(branch?.weeklyOffDays) ?? nums(org?.weeklyOffDays) ?? [];
  const calendarId = branch?.holidayCalendarId ?? defaultCalendar?.id ?? null;
  const holidays = calendarId ? await trx.selectFrom('holidays').select(['date', 'endDate', 'branchIds']).where('organizationId', '=', orgId).where('calendarId', '=', calendarId)
    .where('date', '<=', dv(to)).where((eb) => eb.or([eb('endDate', '>=', dv(from)), eb.and([eb('endDate', 'is', null), eb('date', '>=', dv(from))])])).execute() : [];
  const applicable = holidays.filter((h) => !h.branchIds || !emp || h.branchIds.includes(emp.branchId)).map((h) => ({ date: isoDate(h.date), endDate: isoDateOrNull(h.endDate) }));
  return { weeklyOffDays, holidays: holidayDates(applicable) };
}

/** Units of a leave request for tiers and balances: working days charged (half day = 0.5). */
export async function leaveUnits(trx: Trx, orgId: string, employeeId: string, range: { startDate: string; endDate: string; isHalfDay: boolean }): Promise<number> {
  const cal = await leaveWorkingCalendar(trx, orgId, employeeId, range.startDate, range.endDate);
  return countLeaveDays(range, cal);
}

async function subjectUser(trx: Trx, orgId: string, employeeId: string): Promise<string | null> {
  const m = await trx.selectFrom('orgMemberships').select('userId').where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('status', '=', 'active').orderBy('createdAt').executeTakeFirst();
  return m?.userId ?? null;
}

/**
 * Leave: approval stamps APPROVED + approved_by/approved_at + the decision note and recomputes past days; rejection
 * records the note; a cancelled request withdraws a still-pending leave. The employee is told through leave.approved /
 * leave.rejected (payload.userId), exactly as HR's direct decision did before the engine.
 */
export const leaveHook: EntityHook = {
  entityType: 'LEAVE',
  approvePermission: 'leave.approve',
  viewPermission: 'leave.view',
  async onApproved(deps: ApiDeps, trx: Trx, ctx: HookContext) {
    const l = await trx.updateTable('leaveRecords').set({ status: 'APPROVED', approvedBy: ctx.actor.userId, approvedAt: new Date(), ...(ctx.comment ? { decisionNote: ctx.comment } : {}) })
      .where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).where('status', '=', 'PENDING')
      .returning(['id', 'employeeId', 'branchId', 'leaveTypeId', 'startDate', 'endDate', 'decisionNote']).executeTakeFirst();
    if (!l || ctx.auto) return; // HR recorded it (no workflow): no decision to announce, and createLeaveRecord recomputes as before
    const type = await trx.selectFrom('leaveTypes').select('name').where('id', '=', l.leaveTypeId).executeTakeFirst();
    const userId = await subjectUser(trx, ctx.orgId, l.employeeId);
    await emitDomainEvent(trx, { organizationId: ctx.orgId, eventType: 'leave.approved', aggregateType: 'leave_record', aggregateId: l.id, payload: { ...(userId ? { userId } : {}), employeeId: l.employeeId, leaveTypeName: type?.name ?? null, startDate: isoDate(l.startDate), endDate: isoDate(l.endDate), decisionNote: l.decisionNote }, actorUserId: ctx.actor.userId, requestId: ctx.actor.requestId });
    // approved leave in the past changes already-computed days (LEAVE_CHANGE) — same rule as HR's direct decision
    const today = await orgToday(trx, ctx.orgId);
    const from = isoDate(l.startDate); const to = isoDate(l.endDate);
    if (from <= today) await enqueueRecalculation(deps, trx, ctx.actor, ctx.orgId, { fromDate: from, toDate: to < today ? to : today, branchId: l.branchId, employeeIds: [l.employeeId], reason: 'leave approved' });
  },
  async onRejected(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    const l = await trx.updateTable('leaveRecords').set({ status: 'REJECTED', ...(ctx.comment ? { decisionNote: ctx.comment } : {}) })
      .where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).where('status', '=', 'PENDING')
      .returning(['id', 'employeeId', 'leaveTypeId', 'startDate', 'endDate', 'decisionNote']).executeTakeFirst();
    if (!l) return;
    const type = await trx.selectFrom('leaveTypes').select('name').where('id', '=', l.leaveTypeId).executeTakeFirst();
    const userId = await subjectUser(trx, ctx.orgId, l.employeeId);
    await emitDomainEvent(trx, { organizationId: ctx.orgId, eventType: 'leave.rejected', aggregateType: 'leave_record', aggregateId: l.id, payload: { ...(userId ? { userId } : {}), employeeId: l.employeeId, leaveTypeName: type?.name ?? null, startDate: isoDate(l.startDate), endDate: isoDate(l.endDate), decisionNote: l.decisionNote }, actorUserId: ctx.actor.userId, requestId: ctx.actor.requestId });
  },
  async onCancelled(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await trx.updateTable('leaveRecords').set({ status: 'CANCELLED', ...(ctx.comment ? { decisionNote: ctx.comment } : {}) }).where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).where('status', '=', 'PENDING').execute();
  },
  async loadContexts(trx: Trx, orgId: string, entityIds: string[]) {
    const out = new Map<string, ApprovalContextDto>();
    if (!entityIds.length) return out;
    const rows = await trx.selectFrom('leaveRecords as l').innerJoin('leaveTypes as t', 't.id', 'l.leaveTypeId')
      .select(['l.id', 'l.employeeId', 'l.leaveTypeId', 't.name as leaveTypeName', 't.annualAllowanceDays', 'l.startDate', 'l.endDate', 'l.isHalfDay', 'l.halfDayPart', 'l.reason', 'l.status'])
      .where('l.organizationId', '=', orgId).where('l.id', 'in', entityIds).execute();
    const calendars = new Map<string, WorkingCalendar>();
    for (const r of rows) {
      const start = isoDate(r.startDate); const end = isoDate(r.endDate);
      const year = Number(start.slice(0, 4));
      let cal = calendars.get(r.employeeId);
      if (!cal) { cal = await leaveWorkingCalendar(trx, orgId, r.employeeId, `${year}-01-01`, `${year + 1}-12-31`); calendars.set(r.employeeId, cal); }
      const days = countLeaveDays({ startDate: start, endDate: end, isHalfDay: r.isHalfDay }, cal);
      const allowance = numberOrNull(r.annualAllowanceDays);
      let remaining: number | null = null;
      if (allowance !== null) {
        const others = await trx.selectFrom('leaveRecords').select(['leaveTypeId', 'status', 'startDate', 'endDate', 'isHalfDay']).where('organizationId', '=', orgId).where('employeeId', '=', r.employeeId).where('leaveTypeId', '=', r.leaveTypeId)
          .where('id', '!=', r.id).where('status', 'in', ['APPROVED', 'PENDING']).where('startDate', '<=', dv(`${year}-12-31`)).where('endDate', '>=', dv(`${year}-01-01`)).execute();
        const [b] = leaveBalances([{ leaveTypeId: r.leaveTypeId, allowanceDays: allowance }], others.map((o) => ({ leaveTypeId: o.leaveTypeId, status: o.status, startDate: isoDate(o.startDate), endDate: isoDate(o.endDate), isHalfDay: o.isHalfDay })), cal, year);
        remaining = b?.remainingDays ?? null;
      }
      out.set(r.id, { kind: 'LEAVE', leave: { id: r.id, leaveTypeId: r.leaveTypeId, leaveTypeName: r.leaveTypeName, startDate: start, endDate: end, isHalfDay: r.isHalfDay, halfDayPart: r.halfDayPart, days, reason: r.reason, status: r.status, balanceRemainingDays: remaining, allowanceDays: allowance } });
    }
    return out;
  },
  summary(context) {
    return context.kind === 'LEAVE' ? `${context.leave.leaveTypeName} · ${context.leave.startDate} → ${context.leave.endDate}` : null;
  },
};
