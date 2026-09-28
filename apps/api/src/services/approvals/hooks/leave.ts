import type { ApprovalContextDto } from '@flowza/contracts';
import { COMP_OFF_SYSTEM_KEY, consumeCompOffCredits, emitDomainEvent, loadLeaveBalances, loadLeaveTypePolicies, loadWorkingCalendars, releaseCompOffCredits, type Trx } from '@flowza/database';
import { countLeaveDays, countLeaveDaysByMode, type MembershipGrant, type WorkingCalendar } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../../deps.js';
import { hasPermission } from '../../../lib/authorize.js';
import { isoDate } from '../../../lib/mappers.js';
import { enqueueRecalculation, orgToday } from '../../features/recalc.js';
import type { EntityHook, HookContext } from './index.js';

/**
 * The working calendar of one employee (same precedence as the engine and the portal: employee → branch → organisation
 * weekly offs; the branch's holiday calendar, else the default one; branch-limited holidays honoured). System scope.
 */
export async function leaveWorkingCalendar(trx: Trx, orgId: string, employeeId: string, from: string, to: string): Promise<WorkingCalendar> {
  return (await loadWorkingCalendars(trx, orgId, [employeeId], from, to)).get(employeeId) ?? { weeklyOffDays: [], holidays: new Set() };
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

const UNDECIDED = ['PENDING', 'INFO_REQUESTED'] as const;

/**
 * Consume the comp-off credits of an approved comp-off leave (earliest expiry first). A shortfall — credits expired or
 * were used since the request was filed — refuses the approval: a comp-off leave never overdraws (Finance B-60).
 */
async function consumeForLeave(trx: Trx, orgId: string, l: { id: string; employeeId: string; leaveTypeId: string; startDate: Date | string; endDate: Date | string; isHalfDay: boolean; days: unknown }): Promise<void> {
  const type = await trx.selectFrom('leaveTypes').select(['systemKey', 'countMode']).where('id', '=', l.leaveTypeId).executeTakeFirst();
  if (type?.systemKey !== COMP_OFF_SYSTEM_KEY) return;
  const today = await orgToday(trx, orgId);
  let days = l.days === null || l.days === undefined ? null : Number(l.days);
  if (days === null) {
    const range = { startDate: isoDate(l.startDate), endDate: isoDate(l.endDate), isHalfDay: l.isHalfDay };
    days = countLeaveDaysByMode(range, await leaveWorkingCalendar(trx, orgId, l.employeeId, range.startDate, range.endDate), type.countMode === 'calendar' ? 'calendar' : 'working');
  }
  const res = await consumeCompOffCredits(trx, { organizationId: orgId, employeeId: l.employeeId, leaveRecordId: l.id, days, asOf: today });
  if (res.shortfallDays > 0) throw errors.conflict(`Not enough comp-off credit to approve this leave: ${res.shortfallDays} day(s) are missing (credits expired or were used since it was requested).`, { shortfallDays: res.shortfallDays });
}

/**
 * Book an APPROVED comp-off leave against its credits (HR approving a pre-engine leave directly, or correcting the dates of
 * an approved one after its credits were released). No-op for other types and for a leave that already holds its usages.
 */
export async function bookCompOffForLeave(trx: Trx, orgId: string, leaveId: string): Promise<void> {
  const l = await trx.selectFrom('leaveRecords').select(['id', 'employeeId', 'leaveTypeId', 'startDate', 'endDate', 'isHalfDay', 'days', 'status'])
    .where('organizationId', '=', orgId).where('id', '=', leaveId).executeTakeFirst();
  if (!l || l.status !== 'APPROVED') return;
  await consumeForLeave(trx, orgId, l);
}

/**
 * B-54: approving leave changes the days it covers, so a leave touching a locked period is approved only by a holder of
 * `attendance.lock_period` (HR unlocks first otherwise). The caller-side checks cover recording and editing; this covers
 * the decision itself, whichever door it came through (inbox, e-mail link, HR's Leave page, an exception approval).
 */
async function assertApprovalUnlocked(trx: Trx, ctx: HookContext): Promise<void> {
  const l = await trx.selectFrom('leaveRecords').select(['branchId', 'startDate', 'endDate']).where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).where('status', 'in', [...UNDECIDED]).executeTakeFirst();
  if (!l) return;
  const lock = await trx.selectFrom('attendancePeriodLocks').select('id').where('organizationId', '=', ctx.orgId).where('unlockedAt', 'is', null)
    .where('periodStart', '<=', l.endDate).where('periodEnd', '>=', l.startDate)
    .where((eb) => (l.branchId ? eb.or([eb('branchId', 'is', null), eb('branchId', '=', l.branchId)]) : eb('branchId', 'is', null))).executeTakeFirst();
  if (!lock) return;
  const grant = ctx.actor.principal?.memberships.find((m) => m.organizationId === ctx.orgId) ?? null;
  if (grant && hasPermission(grant, 'attendance.lock_period')) return;
  throw errors.periodLocked('This leave falls in a locked attendance period; unlock the period before approving it.');
}

/**
 * Who may withdraw a leave or comp-off request (Finance B-97/B-98, review P2-4) — the approval engine's withdrawal rule for
 * the leave family: the requester (the employee who filed it); the owner or an approval.manage holder; or a holder of
 * leave.manage WITH the organisation-wide leave.view (branch scope applies). An approver who is merely seated on it (a line
 * manager, an HR approver without leave.manage) decides it but cannot withdraw it, and the person a request is about but
 * did not file (HR filed it for them) cannot withdraw it either — the owner excepted.
 */
export function mayWithdrawLeave(grant: MembershipGrant, userId: string, req: { requestedBy: string | null; subjectUserId: string | null; employeeId: string | null; branchId: string | null }): boolean {
  if (req.requestedBy === userId) return true;
  const isOwner = grant.roleKey === 'owner';
  const isSubject = (!!grant.employeeId && !!req.employeeId && grant.employeeId === req.employeeId) || (!!req.subjectUserId && req.subjectUserId === userId);
  if (isSubject && !isOwner) return false;
  if (!grant.allBranches && req.branchId && !grant.branchIds.includes(req.branchId)) return false;
  if (isOwner || hasPermission(grant, 'approval.manage')) return true;
  return hasPermission(grant, 'leave.manage') && hasPermission(grant, 'leave.view');
}

/**
 * Leave: approval stamps APPROVED + approved_by/approved_at + the decision note, books a comp-off leave against its
 * credits and recomputes past days; rejection records the note; a cancelled request withdraws a still-undecided leave.
 * An approver's question moves the leave to INFO_REQUESTED and opens the thread; the employee's answer moves it back to
 * PENDING (leave v2). The employee is told through leave.approved / leave.rejected (payload.userId).
 */
export const leaveHook: EntityHook = {
  entityType: 'LEAVE',
  approvePermission: 'leave.approve',
  viewPermission: 'leave.view',
  managePermission: 'leave.manage',
  notifiesSubject: true,
  mayCancel: mayWithdrawLeave,
  async onApproved(deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await assertApprovalUnlocked(trx, ctx);
    const l = await trx.updateTable('leaveRecords').set({ status: 'APPROVED', approvedBy: ctx.notRequired ? null : ctx.actor.userId, approvedAt: new Date(), ...(ctx.comment ? { decisionNote: ctx.comment } : {}) })
      .where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).where('status', 'in', [...UNDECIDED])
      .returning(['id', 'employeeId', 'branchId', 'leaveTypeId', 'startDate', 'endDate', 'isHalfDay', 'days', 'decisionNote']).executeTakeFirst();
    if (!l) return;
    await consumeForLeave(trx, ctx.orgId, l);
    if (ctx.auto) return; // recorded without a decision (HR, or a type that needs no approval): the caller owns the side effects
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
      .where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).where('status', 'in', [...UNDECIDED])
      .returning(['id', 'employeeId', 'leaveTypeId', 'startDate', 'endDate', 'decisionNote']).executeTakeFirst();
    if (!l) return;
    const type = await trx.selectFrom('leaveTypes').select('name').where('id', '=', l.leaveTypeId).executeTakeFirst();
    const userId = await subjectUser(trx, ctx.orgId, l.employeeId);
    await emitDomainEvent(trx, { organizationId: ctx.orgId, eventType: 'leave.rejected', aggregateType: 'leave_record', aggregateId: l.id, payload: { ...(userId ? { userId } : {}), employeeId: l.employeeId, leaveTypeName: type?.name ?? null, startDate: isoDate(l.startDate), endDate: isoDate(l.endDate), decisionNote: l.decisionNote }, actorUserId: ctx.actor.userId, requestId: ctx.actor.requestId });
  },
  async onCancelled(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    const l = await trx.updateTable('leaveRecords').set({ status: 'CANCELLED', withdrawnAt: new Date(), ...(ctx.comment ? { decisionNote: ctx.comment } : {}) })
      .where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).where('status', 'in', [...UNDECIDED]).returning('id').executeTakeFirst();
    // an undecided comp-off leave holds no credits; release anyway so a stray usage never outlives its leave
    if (l) await releaseCompOffCredits(trx, { organizationId: ctx.orgId, leaveRecordId: l.id, asOf: await orgToday(trx, ctx.orgId) });
  },
  async onInfoRequested(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    const l = await trx.updateTable('leaveRecords').set({ status: 'INFO_REQUESTED' })
      .where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).where('status', 'in', [...UNDECIDED]).returning('id').executeTakeFirst();
    if (!l) return;
    await trx.insertInto('leaveRequestComments').values({ organizationId: ctx.orgId, leaveRecordId: l.id, authorUserId: ctx.actor.userId, body: (ctx.comment ?? 'More information requested.').slice(0, 2000), kind: 'info_request' }).execute();
  },
  async onInfoAnswered(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    const exists = await trx.selectFrom('leaveRecords').select('id').where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).executeTakeFirst();
    if (!exists) return;
    await trx.updateTable('leaveRecords').set({ status: 'PENDING' }).where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).where('status', '=', 'INFO_REQUESTED').execute();
    await trx.insertInto('leaveRequestComments').values({ organizationId: ctx.orgId, leaveRecordId: ctx.entityId, authorUserId: ctx.actor.userId, body: (ctx.comment ?? '').trim().slice(0, 2000) || 'Replied.', kind: 'reply' }).execute();
  },
  async loadContexts(trx: Trx, orgId: string, entityIds: string[]) {
    const out = new Map<string, ApprovalContextDto>();
    if (!entityIds.length) return out;
    const rows = await trx.selectFrom('leaveRecords as l').innerJoin('leaveTypes as t', 't.id', 'l.leaveTypeId')
      .select(['l.id', 'l.employeeId', 'l.leaveTypeId', 't.name as leaveTypeName', 't.countMode', 'l.startDate', 'l.endDate', 'l.isHalfDay', 'l.halfDayPart', 'l.reason', 'l.status', 'l.days'])
      .where('l.organizationId', '=', orgId).where('l.id', 'in', entityIds).execute();
    if (!rows.length) return out;
    const today = await orgToday(trx, orgId);
    const types = await loadLeaveTypePolicies(trx, orgId, { includeInactive: true });
    for (const r of rows) {
      const start = isoDate(r.startDate); const end = isoDate(r.endDate);
      const year = Number(start.slice(0, 4));
      const range = { startDate: start, endDate: end, isHalfDay: r.isHalfDay };
      const days = r.days !== null ? Number(r.days) : countLeaveDaysByMode(range, await leaveWorkingCalendar(trx, orgId, r.employeeId, start, end), r.countMode === 'calendar' ? 'calendar' : 'working');
      // the balance of the type without this request (the approver sees what is left before it)
      const balance = (await loadLeaveBalances(trx, orgId, [r.employeeId], { year, asOf: today, types: types.filter((t) => t.id === r.leaveTypeId), excludeRecordIds: [r.id] })).get(r.employeeId)?.[0];
      out.set(r.id, { kind: 'LEAVE', leave: { id: r.id, leaveTypeId: r.leaveTypeId, leaveTypeName: r.leaveTypeName, startDate: start, endDate: end, isHalfDay: r.isHalfDay, halfDayPart: r.halfDayPart, days, reason: r.reason, status: r.status, balanceRemainingDays: balance?.availableAfterPendingDays ?? null, allowanceDays: balance?.tracked ? balance.entitlementDays : null } });
    }
    return out;
  },
  summary(context) {
    return context.kind === 'LEAVE' ? `${context.leave.leaveTypeName} · ${context.leave.startDate} → ${context.leave.endDate}` : null;
  },
};
