import { ACTIVE_TIME_OFF_STATUSES, minutesToClock, clockToMinutes, windowMinutes, type ApprovalRequestStatus, type TimeOffCategory, type TimeOffGender, type TimeOffRequestDto, type TimeOffStatus, type TimeOffTypeDto } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { addDays, errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { type Actor, withSystemScope } from '../../lib/service.js';
import { isoDate, isoDateTime, isoDateTimeOrNull } from '../../lib/mappers.js';
import { orgToday } from '../features/recalc.js';
import { dv } from '../features/sql-helpers.js';
import { checkLeaveRangeLock, type LeaveEmployee } from '../leave/common.js';
import { recalcLeaveRange } from '../leave/lifecycle.js';

/**
 * Short leave (migration 20261019000310): the rules HR's "record short leave", the portal request and the approval hook share —
 * the type DTO, the request DTO, the validation of a window (type, applicability, length, monthly quota, overlaps, locked
 * periods) and the recalculation of the day an approved window changes. Types and usage are read in the organisation's system
 * scope: the caller was authorised for the employee first, and an employee must meet exactly the limits HR configured.
 */

export const TYPE_COLUMNS = ['id', 'code', 'name', 'nameAr', 'category', 'countsAsWork', 'maxMinutesPerRequest', 'monthlyQuotaMinutes', 'monthlyQuotaCount', 'requiresApproval', 'applicableGender', 'portalVisible', 'status', 'createdAt', 'updatedAt'] as const;
export interface TypeRow {
  id: string; code: string; name: string; nameAr: string | null; category: string; countsAsWork: boolean; maxMinutesPerRequest: number | null; monthlyQuotaMinutes: number | null; monthlyQuotaCount: number | null;
  requiresApproval: boolean; applicableGender: string; portalVisible: boolean; status: TimeOffTypeDto['status']; createdAt: Date | string; updatedAt: Date | string;
}
export function toTimeOffTypeDto(r: TypeRow): TimeOffTypeDto {
  return {
    id: r.id, code: String(r.code), name: r.name, nameAr: r.nameAr, category: r.category as TimeOffCategory, countsAsWork: r.countsAsWork,
    maxMinutesPerRequest: r.maxMinutesPerRequest, monthlyQuotaMinutes: r.monthlyQuotaMinutes, monthlyQuotaCount: r.monthlyQuotaCount,
    requiresApproval: r.requiresApproval, applicableGender: r.applicableGender as TimeOffGender, portalVisible: r.portalVisible, status: r.status,
    createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt),
  };
}
/** Every type of the organisation, under whatever context the transaction carries. */
export async function loadTimeOffTypes(trx: Trx, orgId: string): Promise<TimeOffTypeDto[]> {
  const rows = await trx.selectFrom('timeOffTypes').select(TYPE_COLUMNS).where('organizationId', '=', orgId).orderBy('name').orderBy('id').execute();
  return rows.map((r) => toTimeOffTypeDto(r as TypeRow));
}
export const typeAppliesTo = (t: Pick<TimeOffTypeDto, 'applicableGender'>, gender: string): boolean => t.applicableGender === 'all' || t.applicableGender === gender;

/** "HH:mm:ss" (a Postgres `time`) → "HH:mm"; 24:00:00 stays 24:00. */
export const clock = (v: string): string => minutesToClock(clockToMinutes(v));

// ----- request rows -----------------------------------------------------------------------------------------------------------

export const REQUEST_COLUMNS = ['r.id', 'r.employeeId', 'e.displayName as employeeName', 'e.employeeNumber', 'r.branchId', 'r.timeOffTypeId', 't.code as typeCode', 't.name as typeName', 't.nameAr as typeNameAr', 't.category', 't.countsAsWork',
  'r.requestDate', 'r.startTime', 'r.endTime', 'r.minutes', 'r.reason', 'r.status', 'r.decisionNote', 'r.decidedAt', 'r.cancelledAt', 'r.cancelReason', 'r.approvalRequestId', 'r.createdBy', 'r.createdAt', 'r.updatedAt'] as const;
export interface RequestRow {
  id: string; employeeId: string; employeeName: string | null; employeeNumber: string | null; branchId: string | null; timeOffTypeId: string; typeCode: string; typeName: string; typeNameAr: string | null; category: string; countsAsWork: boolean;
  requestDate: Date | string; startTime: string; endTime: string; minutes: number; reason: string; status: string; decisionNote: string | null; decidedAt: Date | null; cancelledAt: Date | null; cancelReason: string | null;
  approvalRequestId: string | null; createdBy: string | null; createdAt: Date; updatedAt: Date;
}
export function requestQuery(trx: Trx, orgId: string) {
  return trx.selectFrom('timeOffRequests as r')
    .innerJoin('timeOffTypes as t', (j) => j.onRef('t.id', '=', 'r.timeOffTypeId').onRef('t.organizationId', '=', 'r.organizationId'))
    .leftJoin('employees as e', (j) => j.onRef('e.id', '=', 'r.employeeId').onRef('e.organizationId', '=', 'r.organizationId'))
    .where('r.organizationId', '=', orgId);
}

/**
 * DTOs for a page of rows: the engine request behind each one (status, level, an open question) is read in the system scope for
 * these rows only. `viewer` decides `canWithdraw` (the employee's own pending filing) — HR's lists pass none.
 */
export async function toRequestDtos(trx: Trx, orgId: string, rows: RequestRow[], viewer?: { userId: string; employeeId: string | null; mayRequest: boolean }): Promise<TimeOffRequestDto[]> {
  if (!rows.length) return [];
  const requestIds = [...new Set(rows.map((r) => r.approvalRequestId).filter((x): x is string => !!x))];
  const employeeIds = [...new Set(rows.map((r) => r.employeeId))];
  const ref = await withSystemScope(trx, orgId, async (t) => ({
    requests: requestIds.length ? await t.selectFrom('approvalRequests').select(['id', 'status', 'currentStep', 'infoRequestedAt']).where('organizationId', '=', orgId).where('id', 'in', requestIds).execute() : [],
    steps: requestIds.length ? await t.selectFrom('approvalSteps').select(['requestId', (eb) => eb.fn.countAll<string>().as('n')]).where('requestId', 'in', requestIds).groupBy('requestId').execute() : [],
    // the logins of the employees: a request filed by none of them was recorded by HR on the employee's behalf
    subjects: await t.selectFrom('orgMemberships').select(['userId', 'employeeId']).where('organizationId', '=', orgId).where('employeeId', 'in', employeeIds).execute(),
  }));
  const subjects = ref.subjects;
  const reqById = new Map(ref.requests.map((r) => [r.id, r]));
  return rows.map((r) => {
    const req = r.approvalRequestId ? reqById.get(r.approvalRequestId) : undefined;
    const status = r.status as TimeOffStatus;
    // filed by somebody who is not a login of the employee: HR recorded it on their behalf
    const recordedByHr = !!r.createdBy && !subjects.some((s) => s.userId === r.createdBy && s.employeeId === r.employeeId);
    return {
      id: r.id, employeeId: r.employeeId, employeeName: r.employeeName, employeeNumber: r.employeeNumber, branchId: r.branchId,
      typeId: r.timeOffTypeId, typeCode: String(r.typeCode), typeName: r.typeName, typeNameAr: r.typeNameAr, category: r.category as TimeOffCategory, countsAsWork: r.countsAsWork,
      date: isoDate(r.requestDate), startTime: clock(r.startTime), endTime: clock(r.endTime), minutes: r.minutes, reason: r.reason, status,
      decisionNote: r.decisionNote, decidedAt: isoDateTimeOrNull(r.decidedAt), cancelledAt: isoDateTimeOrNull(r.cancelledAt), cancelReason: r.cancelReason,
      approvalRequestId: r.approvalRequestId, approvalStatus: req ? (req.status as ApprovalRequestStatus) : null, approvalCurrentStep: req?.currentStep ?? null,
      approvalStepCount: req ? Number(ref.steps.find((s) => s.requestId === req.id)?.n ?? 0) : null,
      infoRequested: !!req && req.status === 'PENDING' && req.infoRequestedAt !== null,
      recordedByHr,
      createdBy: r.createdBy, createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt),
      canWithdraw: !!viewer && viewer.mayRequest && status === 'PENDING' && r.createdBy === viewer.userId && viewer.employeeId === r.employeeId,
    };
  });
}

// ----- validation ---------------------------------------------------------------------------------------------------------------

export interface TimeOffWarning { code: string; message: string; params?: Record<string, unknown> }
export interface EvaluatedTimeOff { type: TimeOffTypeDto; minutes: number; warnings: TimeOffWarning[]; usage: { usedMinutes: number; usedCount: number } }
export interface EvaluateTimeOffInput {
  employee: LeaveEmployee;
  typeId: string;
  date: string;
  startTime: string;
  endTime: string;
  /** HR recording on the employee's behalf (leave.manage): the per-request length and the monthly quota only warn. */
  asHr: boolean;
  excludeId?: string;
}

/** Minutes the employee's PENDING / APPROVED requests of a type take in the calendar month of `date` (system scope). */
export async function monthUsage(trx: Trx, orgId: string, employeeId: string, typeId: string, date: string, excludeId?: string): Promise<{ usedMinutes: number; usedCount: number }> {
  const month = date.slice(0, 7);
  const first = `${month}-01`;
  const next = addDays(`${month}-28`, 4).slice(0, 7);
  let q = trx.selectFrom('timeOffRequests').select([(eb) => eb.fn.sum<string | null>('minutes').as('used'), (eb) => eb.fn.countAll<string>().as('n')])
    .where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('timeOffTypeId', '=', typeId).where('status', 'in', [...ACTIVE_TIME_OFF_STATUSES])
    .where('requestDate', '>=', dv(first)).where('requestDate', '<', dv(`${next}-01`));
  if (excludeId) q = q.where('id', '!=', excludeId);
  const row = await q.executeTakeFirst();
  return { usedMinutes: Number(row?.used ?? 0), usedCount: Number(row?.n ?? 0) };
}

const issue = (path: string, code: string, message: string, params?: Record<string, unknown>) => ({ path, code, message, ...(params ? { params } : {}) });

/**
 * Validate one window for an employee and return its type and minutes. Throws VALIDATION_ERROR (issues with codes:
 * NOT_EMPLOYED, UNKNOWN_TYPE, NOT_REQUESTABLE, NOT_APPLICABLE, MAX_PER_REQUEST, MONTHLY_QUOTA_MINUTES, MONTHLY_QUOTA_COUNT)
 * or CONFLICT (OVERLAP_SHORT_LEAVE, OVERLAP_LEAVE). For HR the length and quota rules come back as warnings instead.
 * The caller takes the employee's leave lock first (lockEmployeeLeave) so two concurrent requests cannot both pass.
 */
export async function evaluateTimeOff(trx: Trx, orgId: string, input: EvaluateTimeOffInput): Promise<EvaluatedTimeOff> {
  const { employee } = input;
  const minutes = windowMinutes(input.startTime, input.endTime);
  if (minutes === null) throw errors.validation('The end must be after the start, on the same day.', { issues: [issue('endTime', 'INVALID_WINDOW', 'Must be after startTime')] });
  if (input.date < employee.joiningDate || (employee.exitDate !== null && input.date > employee.exitDate)) {
    throw errors.validation('The employee is not employed on this date.', { issues: [issue('date', 'NOT_EMPLOYED', 'Outside the employment')] });
  }
  return withSystemScope(trx, orgId, async (t) => {
    const row = await t.selectFrom('timeOffTypes').select(TYPE_COLUMNS).where('organizationId', '=', orgId).where('id', '=', input.typeId).executeTakeFirst();
    const type = row ? toTimeOffTypeDto(row as TypeRow) : null;
    if (!type || type.status !== 'active') throw errors.validation('Short leave type not found or not active.', { issues: [issue('typeId', 'UNKNOWN_TYPE', 'Unknown short leave type')] });
    if (!input.asHr && !type.portalVisible) throw errors.validation(`${type.name} is recorded by HR; ask HR to record it for you.`, { issues: [issue('typeId', 'NOT_REQUESTABLE', 'Not requestable in the portal')] });
    if (!typeAppliesTo(type, employee.gender)) throw errors.validation(`${type.name} does not apply to this employee.`, { issues: [issue('typeId', 'NOT_APPLICABLE', 'Not applicable to the employee', { applicableGender: type.applicableGender })] });

    const problems: TimeOffWarning[] = [];
    if (type.maxMinutesPerRequest !== null && minutes > type.maxMinutesPerRequest) {
      problems.push({ code: 'MAX_PER_REQUEST', message: `${type.name} allows at most ${type.maxMinutesPerRequest} minutes per request (this one is ${minutes}).`, params: { max: type.maxMinutesPerRequest, minutes } });
    }
    const usage = await monthUsage(t, orgId, employee.id, type.id, input.date, input.excludeId);
    if (type.monthlyQuotaMinutes !== null && usage.usedMinutes + minutes > type.monthlyQuotaMinutes) {
      problems.push({ code: 'MONTHLY_QUOTA_MINUTES', message: `${type.name}: ${usage.usedMinutes} of ${type.monthlyQuotaMinutes} minutes are already used or requested this month; ${minutes} more would exceed the monthly quota.`, params: { usedMinutes: usage.usedMinutes, quotaMinutes: type.monthlyQuotaMinutes, minutes } });
    }
    if (type.monthlyQuotaCount !== null && usage.usedCount + 1 > type.monthlyQuotaCount) {
      problems.push({ code: 'MONTHLY_QUOTA_COUNT', message: `${type.name}: ${usage.usedCount} of ${type.monthlyQuotaCount} requests are already used or requested this month.`, params: { usedCount: usage.usedCount, quotaCount: type.monthlyQuotaCount } });
    }
    if (problems.length && !input.asHr) {
      throw errors.validation(problems[0]!.message, { issues: problems.map((p) => issue(p.code === 'MAX_PER_REQUEST' ? 'endTime' : 'typeId', p.code, p.message, p.params)) });
    }

    // overlaps: another active window of the employee on the day, or full-day leave covering it
    let other = t.selectFrom('timeOffRequests').select(['id', 'startTime', 'endTime']).where('organizationId', '=', orgId).where('employeeId', '=', employee.id)
      .where('requestDate', '=', dv(input.date)).where('status', 'in', [...ACTIVE_TIME_OFF_STATUSES]);
    if (input.excludeId) other = other.where('id', '!=', input.excludeId);
    const start = clockToMinutes(input.startTime); const end = clockToMinutes(input.endTime);
    const clash = (await other.execute()).find((o) => clockToMinutes(o.startTime) < end && clockToMinutes(o.endTime) > start);
    if (clash) throw errors.conflict(`There is already a short leave from ${clock(clash.startTime)} to ${clock(clash.endTime)} on this day. Withdraw or change it first.`, { reason: 'OVERLAP_SHORT_LEAVE', timeOffRequestId: clash.id });
    const leave = await t.selectFrom('leaveRecords').select('id').where('organizationId', '=', orgId).where('employeeId', '=', employee.id)
      .where('status', 'in', ['PENDING', 'APPROVED', 'INFO_REQUESTED']).where('isHalfDay', '=', false)
      .where('startDate', '<=', dv(input.date)).where('endDate', '>=', dv(input.date)).executeTakeFirst();
    if (leave) throw errors.conflict('The employee is on leave (pending or approved) for the whole day; a short leave is not needed.', { reason: 'OVERLAP_LEAVE', leaveRecordId: leave.id });
    return { type, minutes, warnings: input.asHr ? problems : [], usage };
  });
}

/** Locked attendance period on the date → PERIOD_LOCKED, unless the caller holds attendance.lock_period (B-54, like leave). */
export async function checkDayLock(trx: Trx, orgId: string, branchId: string | null, date: string, grant?: MembershipGrant): Promise<{ lockedOverride: boolean }> {
  return checkLeaveRangeLock(trx, orgId, branchId, date, date, grant);
}

/**
 * Recompute the days an approved window shapes once it appears or disappears: its date and — for a night shift that started
 * the evening before — the previous date, up to today (future days compute when they arrive). A queue job (RECALCULATE_RANGE).
 */
export async function recalcTimeOffDay(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, r: { date: string; employeeId: string; branchId: string | null }, reason: string): Promise<{ requestId: string; jobId: string } | null> {
  const today = await withSystemScope(trx, orgId, (t) => orgToday(t, orgId));
  if (r.date > today) return null;
  // by employee only: the branch the employee belonged to on the day is the recompute's business, not the request's snapshot
  return recalcLeaveRange(deps, trx, actor, orgId, addDays(r.date, -1), r.date, { branchId: null, employeeIds: [r.employeeId], reason });
}

/** Today in the organisation's timezone (system scope: an employee cannot read the organisation row's settings everywhere). */
export async function todayOf(trx: Trx, orgId: string): Promise<string> {
  return withSystemScope(trx, orgId, (t) => orgToday(t, orgId));
}
