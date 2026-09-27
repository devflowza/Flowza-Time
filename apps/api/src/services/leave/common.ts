import type { LeaveBalanceDto, LeaveWarningDto } from '@flowza/contracts';
import { COMP_OFF_SYSTEM_KEY, loadLeaveBalances, loadLeaveTypePolicies, loadWorkingCalendars, type LeaveTypePolicy, type Trx } from '@flowza/database';
import { checkLeaveRequest, countLeaveDaysByMode, type LeaveBalance, type MembershipGrant } from '@flowza/domain';
import { errors } from '@flowza/shared';
import { hasPermission } from '../../lib/authorize.js';
import { withSystemScope } from '../../lib/service.js';
import { isoDate, isoDateOrNull } from '../../lib/mappers.js';
import { orgToday } from '../features/recalc.js';
import { dv } from '../features/sql-helpers.js';

/**
 * Leave v2 rules shared by HR's "record leave", the self-service apply / edit and the comp-off redemption (HR portal
 * Prompt 7): the validation matrix (domain `checkLeaveRequest`), the days a request charges (count mode of the type,
 * working calendar of the employee), the balance it lands on (the ONE balance function), half-day aware overlap and the
 * locked-period guard. Balances and calendars are read in the organisation's system scope: the caller was authorised
 * for the employee first, and a branch-scoped or team-scoped reader must see exactly the figures HR sees.
 */

export interface LeaveEmployee { id: string; branchId: string; departmentId: string | null; gender: string; joiningDate: string; exitDate: string | null; displayName: string; employeeNumber: string }

/** The employee as the caller's RLS sees it (null when invisible or archived). */
export async function loadLeaveEmployee(trx: Trx, orgId: string, employeeId: string): Promise<LeaveEmployee | null> {
  const e = await trx.selectFrom('employees').select(['id', 'branchId', 'departmentId', 'gender', 'joiningDate', 'exitDate', 'displayName', 'employeeNumber'])
    .where('organizationId', '=', orgId).where('id', '=', employeeId).where('deletedAt', 'is', null).executeTakeFirst();
  return e ? { id: e.id, branchId: e.branchId, departmentId: e.departmentId, gender: e.gender, joiningDate: isoDate(e.joiningDate), exitDate: isoDateOrNull(e.exitDate), displayName: e.displayName, employeeNumber: e.employeeNumber } : null;
}

export const isCompOffType = (t: Pick<LeaveTypePolicy, 'systemKey'>): boolean => t.systemKey === COMP_OFF_SYSTEM_KEY;

export function toBalanceDto(t: LeaveTypePolicy, b: LeaveBalance): LeaveBalanceDto {
  return {
    leaveTypeId: t.id, code: t.code, name: t.name, nameAr: t.nameAr, color: t.color, isPaid: t.isPaid, countMode: t.countMode, accrual: t.accrual, compOff: isCompOffType(t),
    tracked: b.tracked, hasAllocation: b.hasAllocation, allocatedDays: b.allocatedDays, carriedForwardDays: b.carriedForwardDays, carriedForwardExpiresOn: b.carriedForwardExpiresOn, carriedForwardExpiredDays: b.carriedForwardExpiredDays,
    openingBalanceDays: b.openingBalanceDays, adjustmentDays: b.adjustmentDays, entitlementDays: b.entitlementDays, takenDays: b.takenDays, pendingDays: b.pendingDays,
    accruedToDateDays: b.accruedToDateDays, availableDays: b.availableDays, availableAfterPendingDays: b.availableAfterPendingDays,
  };
}

export interface EvaluatedLeave {
  type: LeaveTypePolicy;
  /** Days the request charges (type count mode, working calendar). */
  days: number;
  warnings: LeaveWarningDto[];
  /** The type's balance for the request's year without the request itself. */
  balance: LeaveBalance | null;
  today: string;
  compOff: boolean;
}

export interface EvaluateLeaveInput {
  employee: LeaveEmployee;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  isHalfDay: boolean;
  /** HR recording leave (leave.manage): advance notice / consecutive cap only warn. */
  asHr: boolean;
  /** The request being edited (not counted against itself). */
  excludeRecordId?: string;
}

/**
 * Validate a request against its type and the employee and compute its days + warnings. Throws VALIDATION_ERROR with
 * `issues[]` (path, message, code, params) for the first failing rules; warnings never throw.
 */
export async function evaluateLeaveRequest(trx: Trx, orgId: string, input: EvaluateLeaveInput): Promise<EvaluatedLeave> {
  const { employee } = input;
  if (input.endDate < input.startDate) throw errors.validation('endDate must be on/after startDate.', { issues: [{ path: 'endDate', message: 'Before startDate' }] });
  if (input.isHalfDay && input.startDate !== input.endDate) throw errors.validation('Half-day leave must be a single day.', { issues: [{ path: 'endDate', message: 'Must equal startDate' }] });
  if (input.startDate < employee.joiningDate) throw errors.validation('Leave cannot start before the joining date.', { issues: [{ path: 'startDate', message: 'Before joining date' }] });
  if (employee.exitDate && input.endDate > employee.exitDate) throw errors.validation('Leave cannot end after the exit date.', { issues: [{ path: 'endDate', message: 'After exit date' }] });
  return withSystemScope(trx, orgId, async (t) => {
    const type = (await loadLeaveTypePolicies(t, orgId)).find((x) => x.id === input.leaveTypeId);
    if (!type) throw errors.validation('Leave type not found or archived.', { issues: [{ path: 'leaveTypeId', message: 'Unknown leave type' }] });
    const today = await orgToday(t, orgId);
    const year = Number(input.startDate.slice(0, 4));
    const cal = (await loadWorkingCalendars(t, orgId, [employee.id], input.startDate, input.endDate)).get(employee.id) ?? { weeklyOffDays: [], holidays: new Set<string>() };
    const range = { startDate: input.startDate, endDate: input.endDate, isHalfDay: input.isHalfDay };
    const days = countLeaveDaysByMode(range, cal, type.countMode);
    const balance = (await loadLeaveBalances(t, orgId, [employee.id], { year, asOf: today, types: [type], ...(input.excludeRecordId ? { excludeRecordIds: [input.excludeRecordId] } : {}) })).get(employee.id)?.[0] ?? null;
    // a request crossing into the next year: the balance check covers the start year (its days are charged there first)
    const compOff = isCompOffType(type);
    const result = checkLeaveRequest({
      type: { name: type.name, applicableGender: type.applicableGender, allowHalfDay: type.allowHalfDay, advanceNoticeDays: type.advanceNoticeDays, maxConsecutiveDays: type.maxConsecutiveDays, compOff },
      employeeGender: employee.gender, startDate: input.startDate, endDate: input.endDate, isHalfDay: input.isHalfDay, days, today, asHr: input.asHr,
      availableAfterPendingDays: balance && balance.tracked ? balance.availableAfterPendingDays : null,
    });
    if (result.errors.length) {
      const first = result.errors[0]!;
      throw errors.validation(first.message, { issues: result.errors.map((e) => ({ path: e.path, message: e.message, code: e.code, params: e.params })) });
    }
    return { type, days, warnings: result.warnings.map((w) => ({ code: w.code, message: w.message, params: w.params })), balance, today, compOff };
  });
}

/** Active leave (PENDING / INFO_REQUESTED / APPROVED) that clashes with the range: dates overlap, except a FIRST_HALF and a SECOND_HALF on the same date. */
export async function findLeaveOverlap(trx: Trx, orgId: string, employeeId: string, range: { startDate: string; endDate: string; isHalfDay: boolean; halfDayPart: string | null }, excludeId?: string): Promise<string | null> {
  return withSystemScope(trx, orgId, async (t) => {
    let q = t.selectFrom('leaveRecords').select(['id', 'startDate', 'endDate', 'isHalfDay', 'halfDayPart']).where('organizationId', '=', orgId).where('employeeId', '=', employeeId)
      .where('status', 'in', ['PENDING', 'APPROVED', 'INFO_REQUESTED']).where('startDate', '<=', dv(range.endDate)).where('endDate', '>=', dv(range.startDate));
    if (excludeId) q = q.where('id', '!=', excludeId);
    for (const other of await q.execute()) {
      const complementaryHalves = range.isHalfDay && other.isHalfDay && isoDate(other.startDate) === range.startDate && !!range.halfDayPart && !!other.halfDayPart && other.halfDayPart !== range.halfDayPart;
      if (!complementaryHalves) return other.id;
    }
    return null;
  });
}

export async function assertNoOverlap(trx: Trx, orgId: string, employeeId: string, range: { startDate: string; endDate: string; isHalfDay: boolean; halfDayPart: string | null }, excludeId?: string): Promise<void> {
  const clash = await findLeaveOverlap(trx, orgId, employeeId, range, excludeId);
  if (clash) throw errors.conflict('There is already leave in this range (pending or approved). Withdraw or change it first.', { leaveRecordId: clash });
}

/**
 * Any day of [start, end] inside an active lock for the branch (or an organisation-wide lock) → PERIOD_LOCKED, except for
 * holders of `attendance.lock_period` (B-54: they may correct a locked period; the caller records the override). Read in
 * the system scope: an employee cannot see the locks table, and a lock must hold for them too.
 */
export async function checkLeaveRangeLock(trx: Trx, orgId: string, branchId: string | null, start: string, end: string, grant?: MembershipGrant): Promise<{ lockedOverride: boolean }> {
  const lock = await withSystemScope(trx, orgId, (t) => t.selectFrom('attendancePeriodLocks').select('id').where('organizationId', '=', orgId).where('unlockedAt', 'is', null)
    .where('periodStart', '<=', dv(end)).where('periodEnd', '>=', dv(start))
    .where((eb) => (branchId ? eb.or([eb('branchId', 'is', null), eb('branchId', '=', branchId)]) : eb('branchId', 'is', null))).executeTakeFirst());
  if (!lock) return { lockedOverride: false };
  if (grant && hasPermission(grant, 'attendance.lock_period')) return { lockedOverride: true };
  throw errors.periodLocked('The period is locked; unlock it before changing leave in this range.');
}
