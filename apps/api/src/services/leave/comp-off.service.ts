import { DateTime } from 'luxon';
import { resolveAttendanceSettings, resolveLeaveSettings, type CompOffCreditDto, type CompOffPreviewDto, type CompOffWorkedOnType, type SelfCompOffDto, type SelfCompOffRequestInput } from '@flowza/contracts';
import { compOffLeaveType, loadEmployeeWorkingCalendars, type Trx } from '@flowza/database';
import { compOffDaysEarned, type MembershipGrant } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { hasPermission, requireMembership } from '../../lib/authorize.js';
import { type Actor, audit, runUser, withSystemScope } from '../../lib/service.js';
import { isoDate, isoDateTime } from '../../lib/mappers.js';
import { orgToday } from '../features/recalc.js';
import { dv } from '../features/sql-helpers.js';
import { systemStep } from '../features/context.js';
import { submit } from '../approvals/engine.js';
import { loadLeaveEmployee, type LeaveEmployee } from './common.js';
import { loadLeaveView, selfCompOffBalance } from './self-leave.service.js';

/**
 * Compensatory off (leave v2, Finance parity A13 / B-60). An employee who worked on a weekly off day or a holiday asks for a
 * credit (POST /me/comp-off): half a day from half of `attendance.stats.fullDayHours` worked, a full day from the full hours.
 * The request goes through the approval engine (entity COMP_OFF; the approver sees what the daily record says about the
 * day); approval makes the credit usable until `worked_on + leave.compOffExpiryDays` (default 90). Credits are redeemed by
 * applying for leave of the organisation's comp-off type — consumed earliest expiry first when that leave is approved,
 * released when it is cancelled (hooks/leave.ts). A daily worker sweep expires what was not used.
 */

interface SelfScope { grant: MembershipGrant; employeeId: string }
function selfScope(actor: Actor, orgId: string): SelfScope {
  const grant = requireMembership(actor.principal, orgId);
  if (!grant.employeeId) throw errors.forbidden('Your account is not linked to an employee record in this organisation.');
  return { grant, employeeId: grant.employeeId };
}

export interface CompOffRules { fullDayHours: number; halfDayHours: number; expiryDays: number }
async function compOffRules(t: Trx, orgId: string): Promise<CompOffRules> {
  const row = await t.selectFrom('organizationSettings').select(['attendance', 'leave']).where('organizationId', '=', orgId).executeTakeFirst();
  const fullDayHours = resolveAttendanceSettings(row?.attendance).stats.fullDayHours;
  return { fullDayHours, halfDayHours: fullDayHours / 2, expiryDays: resolveLeaveSettings(row?.leave).compOffExpiryDays };
}

type CreditRow = { id: string; employeeId: string; workedOn: Date | string; workedOnType: string; workedMinutes: number; daysEarned: unknown; location: string; summary: string; status: string; usedDays: unknown; expiresOn: Date | string | null; decisionNote: string | null; approvalRequestId: string | null; createdAt: Date; updatedAt: Date };
const CREDIT_COLUMNS = ['id', 'employeeId', 'workedOn', 'workedOnType', 'workedMinutes', 'daysEarned', 'location', 'summary', 'status', 'usedDays', 'expiresOn', 'decisionNote', 'approvalRequestId', 'createdAt', 'updatedAt'] as const;

async function toCreditDtos(trx: Trx, orgId: string, rows: CreditRow[], today: string): Promise<CompOffCreditDto[]> {
  const requestIds = [...new Set(rows.map((r) => r.approvalRequestId).filter((x): x is string => !!x))];
  const requests = requestIds.length ? await withSystemScope(trx, orgId, (t) => t.selectFrom('approvalRequests').select(['id', 'status']).where('organizationId', '=', orgId).where('id', 'in', requestIds).execute()) : [];
  const statusOf = new Map(requests.map((r) => [r.id, r.status]));
  return rows.map((r) => {
    const earned = Number(r.daysEarned); const used = Number(r.usedDays);
    const expiresOn = r.expiresOn === null ? null : isoDate(r.expiresOn);
    const usable = (r.status === 'approved' || r.status === 'partially_used') && expiresOn !== null && expiresOn >= today;
    return {
      id: r.id, employeeId: r.employeeId, workedOn: isoDate(r.workedOn), workedOnType: r.workedOnType as CompOffWorkedOnType, workedMinutes: r.workedMinutes, daysEarned: earned, location: r.location, summary: r.summary,
      status: r.status as CompOffCreditDto['status'], usedDays: used, remainingDays: usable ? Math.max(0, Math.round((earned - used) * 2) / 2) : 0, expiresOn, decisionNote: r.decisionNote,
      approvalRequestId: r.approvalRequestId, approvalStatus: r.approvalRequestId ? (statusOf.get(r.approvalRequestId) as CompOffCreditDto['approvalStatus']) ?? null : null,
      createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt),
    };
  });
}

async function ownEmployee(trx: Trx, orgId: string, scope: SelfScope): Promise<LeaveEmployee> {
  const emp = await loadLeaveEmployee(trx, orgId, scope.employeeId);
  if (!emp) throw errors.notFound('Employee record');
  return emp;
}

/** GET /me/comp-off — the credits (newest worked day first), the comp-off balance and the rules the request form shows. */
export async function getSelfCompOff(deps: ApiDeps, actor: Actor, orgId: string): Promise<SelfCompOffDto> {
  const scope = selfScope(actor, orgId);
  if (!hasPermission(scope.grant, 'leave.request') && !hasPermission(scope.grant, 'leave.view')) throw errors.forbidden('Missing permission: leave.request.');
  return runUser(deps.db, actor, async (trx) => {
    const emp = await ownEmployee(trx, orgId, scope);
    const rows = (await trx.selectFrom('compOffCredits').select(CREDIT_COLUMNS).where('organizationId', '=', orgId).where('employeeId', '=', emp.id).orderBy('workedOn', 'desc').orderBy('createdAt', 'desc').limit(200).execute()) as CreditRow[];
    const { today, rules } = await withSystemScope(trx, orgId, async (t) => ({ today: await orgToday(t, orgId), rules: await compOffRules(t, orgId) }));
    const view = await loadLeaveView(trx, orgId, emp);
    const balance = selfCompOffBalance(view) ?? { leaveTypeId: null, earnedDays: 0, usedDays: 0, availableDays: 0, pendingDays: 0, availableAfterPendingDays: 0 };
    return { balance, credits: await toCreditDtos(trx, orgId, rows, today), rules };
  });
}

interface WorkedDay { workedOnType: CompOffWorkedOnType | null; holidayName: string | null; recordedMinutes: number | null; alreadyRequested: boolean; reason: string | null }

/**
 * What the worked date is (weekly off / holiday per the employee's working calendar ON THAT DATE — review P1-1 / P1-2: the
 * branch the employee was placed in then, its holiday calendar, and a rotation pattern's off days, exactly as the attendance
 * engine sees the day), what the daily record says, and why it cannot earn a credit (null = it can). System scope.
 */
async function assessWorkedDay(t: Trx, orgId: string, emp: LeaveEmployee, workedOn: string, today: string, rules: CompOffRules): Promise<WorkedDay> {
  const day = (await loadEmployeeWorkingCalendars(t, orgId, [emp.id], { from: workedOn, to: workedOn })).calendars.get(emp.id)?.day(workedOn);
  const holiday = !!day?.holiday;
  const weeklyOff = !!day && day.weeklyOffDays.includes(DateTime.fromISO(workedOn, { zone: 'utc' }).weekday % 7);
  const holidayName = day?.holiday?.name ?? null;
  const record = await t.selectFrom('attendanceDailyRecords').select('workedMinutes').where('organizationId', '=', orgId).where('employeeId', '=', emp.id).where('attendanceDate', '=', dv(workedOn)).executeTakeFirst();
  const already = await t.selectFrom('compOffCredits').select('id').where('organizationId', '=', orgId).where('employeeId', '=', emp.id).where('workedOn', '=', dv(workedOn)).where('status', 'not in', ['rejected', 'cancelled']).executeTakeFirst();
  const workedOnType: CompOffWorkedOnType | null = holiday ? 'holiday' : weeklyOff ? 'weekly_off' : null;
  const lastDay = DateTime.fromISO(workedOn, { zone: 'utc' }).plus({ days: rules.expiryDays }).toISODate()!;
  const reason = workedOn > today ? 'future'
    : workedOn < emp.joiningDate ? 'before_joining'
    : emp.exitDate && workedOn > emp.exitDate ? 'after_exit'
    : !workedOnType ? 'working_day'
    : lastDay < today ? 'expired'
    : already ? 'already_requested'
    : null;
  return { workedOnType, holidayName, recordedMinutes: record ? record.workedMinutes : null, alreadyRequested: !!already, reason };
}

const REASON_MESSAGES: Record<string, string> = {
  future: 'Comp-off is earned for a day already worked; this date is in the future.',
  before_joining: 'This date is before your joining date.',
  after_exit: 'This date is after your exit date.',
  working_day: 'Comp-off is earned for work on a weekly off day or a holiday; this date is a working day.',
  expired: 'A credit for this date would already have expired; it is too late to request it.',
  already_requested: 'You already requested comp-off for this date.',
};

/** GET /me/comp-off/preview?workedOn — what a worked date would earn (drives the request form). */
export async function previewCompOff(deps: ApiDeps, actor: Actor, orgId: string, workedOn: string): Promise<CompOffPreviewDto> {
  const scope = selfScope(actor, orgId);
  if (!hasPermission(scope.grant, 'leave.request')) throw errors.forbidden('Missing permission: leave.request.');
  return runUser(deps.db, actor, async (trx) => {
    const emp = await ownEmployee(trx, orgId, scope);
    return withSystemScope(trx, orgId, async (t) => {
      const today = await orgToday(t, orgId);
      const rules = await compOffRules(t, orgId);
      const day = await assessWorkedDay(t, orgId, emp, workedOn, today, rules);
      return { workedOn, workedOnType: day.workedOnType, holidayName: day.holidayName, recordedMinutes: day.recordedMinutes, daysEarned: compOffDaysEarned(day.recordedMinutes ?? 0, rules.fullDayHours), alreadyRequested: day.alreadyRequested, eligible: day.reason === null, reason: day.reason };
    });
  });
}

/**
 * POST /me/comp-off — ask for a credit for work on a weekly off day or a holiday. The day type comes from the employee's
 * calendar (never the client), the days from the minutes worked (≥ full-day hours → 1, ≥ half of them → 0.5); one active
 * request per date. Routed by the approval engine (COMP_OFF; without a workflow: the leave.approve holders in reach).
 */
export async function requestCompOff(deps: ApiDeps, actor: Actor, orgId: string, input: SelfCompOffRequestInput): Promise<CompOffCreditDto> {
  const scope = selfScope(actor, orgId);
  if (!hasPermission(scope.grant, 'leave.request')) throw errors.forbidden('Missing permission: leave.request.');
  return runUser(deps.db, actor, async (trx) => {
    const emp = await ownEmployee(trx, orgId, scope);
    const { today, rules, day, type } = await withSystemScope(trx, orgId, async (t) => {
      const now = await orgToday(t, orgId);
      const r = await compOffRules(t, orgId);
      return { today: now, rules: r, day: await assessWorkedDay(t, orgId, emp, input.workedOn, now, r), type: await compOffLeaveType(t, orgId) };
    });
    if (!type || type.status !== 'active') throw errors.conflict('Comp-off is not set up in this organisation; ask HR.');
    if (day.reason === 'already_requested') throw errors.conflict(REASON_MESSAGES['already_requested']!, { workedOn: input.workedOn });
    if (day.reason) throw errors.validation(REASON_MESSAGES[day.reason] ?? 'This date cannot earn a comp-off credit.', { issues: [{ path: 'workedOn', message: day.reason, code: day.reason.toUpperCase() }] });
    const daysEarned = compOffDaysEarned(input.workedMinutes, rules.fullDayHours);
    if (daysEarned === 0) throw errors.validation(`Comp-off needs at least ${rules.halfDayHours} hour(s) of work for half a day.`, { issues: [{ path: 'workedMinutes', message: 'Below half a day', code: 'BELOW_HALF_DAY' }] });
    // review P2-10 / P0-2: validated above (the day type from the calendar, the minutes, one request per date), written in the
    // system context — the database refuses a credit written from the person's own session
    const row = await systemStep(trx, orgId, (t) => t.insertInto('compOffCredits').values({
      organizationId: orgId, employeeId: emp.id, branchId: emp.branchId, workedOn: input.workedOn, workedOnType: day.workedOnType!, workedMinutes: input.workedMinutes, daysEarned,
      location: input.location, summary: input.summary, status: 'pending_approval', createdBy: actor.userId,
    }).returning('id').executeTakeFirstOrThrow());
    const submitted = await submit(deps, trx, actor, orgId, {
      entityType: 'COMP_OFF', entityId: row.id, employeeId: emp.id, branchId: emp.branchId, departmentId: emp.departmentId, units: daysEarned, requestedBy: actor.userId,
      noWorkflow: { kind: 'PERMISSION', permission: 'leave.approve' },
    });
    await systemStep(trx, orgId, (t) => t.updateTable('compOffCredits').set({ approvalRequestId: submitted.requestId }).where('id', '=', row.id).execute());
    await audit(trx, actor, orgId, 'comp_off.requested', 'comp_off_credit', { entityId: row.id, branchId: emp.branchId, newValue: { workedOn: input.workedOn, workedOnType: day.workedOnType, workedMinutes: input.workedMinutes, recordedMinutes: day.recordedMinutes, daysEarned, approvalRequestId: submitted.requestId } });
    const saved = (await trx.selectFrom('compOffCredits').select(CREDIT_COLUMNS).where('id', '=', row.id).execute()) as CreditRow[];
    const [dto] = await toCreditDtos(trx, orgId, saved, today);
    return dto!;
  });
}
