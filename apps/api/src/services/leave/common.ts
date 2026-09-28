import { sql } from 'kysely';
import type { LeaveBalanceDto, LeaveWarningDto } from '@flowza/contracts';
import { COMP_OFF_SYSTEM_KEY, compOffCoverage, loadLeaveBalances, loadLeaveTypePolicies, loadWorkingCalendars, type LeaveTypePolicy, type Trx } from '@flowza/database';
import { checkLeaveRequest, countLeaveDaysByMode, leaveDaysInWindow, type LeaveBalance, type MembershipGrant } from '@flowza/domain';
import { errors } from '@flowza/shared';
import { hasPermission } from '../../lib/authorize.js';
import { withSystemScope } from '../../lib/service.js';
import { isoDate, isoDateOrNull } from '../../lib/mappers.js';
import { orgToday } from '../features/recalc.js';
import { dv } from '../features/sql-helpers.js';
import { systemStep } from '../features/context.js';

/**
 * Leave v2 rules shared by HR's "record leave", the self-service apply / edit and the comp-off redemption (HR portal
 * Prompt 7): the validation matrix (domain `checkLeaveRequest`), the days a request charges (count mode of the type,
 * working calendar of the employee), the balance it lands on (the ONE balance function), half-day aware overlap and the
 * locked-period guard. Balances and calendars are read in the organisation's system scope: the caller was authorised
 * for the employee first, and a branch-scoped or team-scoped reader must see exactly the figures HR sees.
 */

export interface LeaveEmployee { id: string; branchId: string; departmentId: string | null; gender: string; employmentType: string; joiningDate: string; exitDate: string | null; displayName: string; employeeNumber: string }

/** The employee as the caller's RLS sees it (null when invisible or archived). */
export async function loadLeaveEmployee(trx: Trx, orgId: string, employeeId: string): Promise<LeaveEmployee | null> {
  const e = await trx.selectFrom('employees').select(['id', 'branchId', 'departmentId', 'gender', 'employmentType', 'joiningDate', 'exitDate', 'displayName', 'employeeNumber'])
    .where('organizationId', '=', orgId).where('id', '=', employeeId).where('deletedAt', 'is', null).executeTakeFirst();
  return e ? { id: e.id, branchId: e.branchId, departmentId: e.departmentId, gender: e.gender, employmentType: e.employmentType, joiningDate: isoDate(e.joiningDate), exitDate: isoDateOrNull(e.exitDate), displayName: e.displayName, employeeNumber: e.employeeNumber } : null;
}

export const isCompOffType = (t: Pick<LeaveTypePolicy, 'systemKey'>): boolean => t.systemKey === COMP_OFF_SYSTEM_KEY;

/**
 * Review P2-11: one writer of an employee's leave at a time (transaction-scoped advisory lock). Taken before the overlap
 * check, it makes a concurrent twin wait for the first request to commit and then meet the friendly overlap 409, instead of
 * dying on the exclusion constraint or a deadlock ("concurrent change, retry").
 */
export async function lockEmployeeLeave(trx: Trx, employeeId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`flowza:leave:${employeeId}`}, 0))`.execute(trx);
}

/**
 * Where a leave row (record / allocation) is written: always in the organisation's system step, after the service's own
 * checks — `leave.manage`, the branch scope of the employee / the stored row, segregation of duties (review P0-2: never
 * one's own leave, the owner's logged exception), the engine's rules. The security gate (migration 20260928001100, Prompt 10)
 * made leave_records / leave_allocations system-write-only: a client session can no longer write them at all, so a leave
 * can never be approved, moved or withdrawn around the approval engine (the Leave v2 open item). `own` is kept for the
 * callers' audit of the owner's exception.
 */
export async function ownRowWrite<T>(trx: Trx, orgId: string, _own: boolean, fn: (t: Trx) => Promise<T>): Promise<T> {
  return systemStep(trx, orgId, fn);
}

/** A stored leave row as the list / calendar readers select it. */
export interface StoredLeaveRow { id: string; employeeId: string; startDate: Date | string; endDate: Date | string; isHalfDay: boolean; days: unknown; countMode: string }

/**
 * Review P2-8 — the days of stored leave rows, read the way the balances read them (`leaveDaysInWindow`): the stored `days`
 * (the value at submission), computed on read for a row stored without them (recorded before leave v2) with the per-date
 * working calendar; with a `window`, also the days inside it (a calendar month: its total sums these, never the full days
 * of a leave that merely overlaps the month). Calendars are read in the organisation's system scope for the rows the
 * caller could already see.
 */
export async function leaveDaysOf(trx: Trx, orgId: string, rows: readonly StoredLeaveRow[], window?: { from: string; to: string }): Promise<Map<string, { days: number; daysInPeriod: number | null }>> {
  const out = new Map<string, { days: number; daysInPeriod: number | null }>();
  if (!rows.length) return out;
  const storedOf = (r: StoredLeaveRow): number | null => (r.days === null || r.days === undefined ? null : Number(r.days));
  const rangeOf = (r: StoredLeaveRow) => ({ startDate: isoDate(r.startDate), endDate: isoDate(r.endDate), isHalfDay: r.isHalfDay });
  const needs = rows.filter((r) => { const x = rangeOf(r); return storedOf(r) === null || (!!window && (x.startDate < window.from || x.endDate > window.to)); });
  const cals = needs.length
    ? await withSystemScope(trx, orgId, (t) => loadWorkingCalendars(t, orgId, [...new Set(needs.map((r) => r.employeeId))], needs.map((r) => rangeOf(r).startDate).sort()[0]!, needs.map((r) => rangeOf(r).endDate).sort().pop()!))
    : new Map();
  for (const r of rows) {
    const range = { ...rangeOf(r), days: storedOf(r) };
    const cal = cals.get(r.employeeId) ?? { weeklyOffDays: [], holidays: new Set<string>() };
    const mode = r.countMode === 'calendar' ? 'calendar' : 'working';
    out.set(r.id, { days: leaveDaysInWindow(range, cal, mode), daysInPeriod: window ? leaveDaysInWindow(range, cal, mode, window) : null });
  }
  return out;
}

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

/** Days in a message: "3", "0.5" (as the domain's rule messages write them). */
const fmtDays = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

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
    // comp-off (review P2-4): a credit pays only for leave dated on or before its expiry — what the credits can pay for THESE
    // dates, after the other undecided comp-off requests, is what the rule compares with (the balance shown is as of today)
    const available = compOff
      ? (await compOffCoverage(t, orgId, employee.id, { startDate: input.startDate, endDate: input.endDate, isHalfDay: input.isHalfDay, days, countMode: type.countMode }, input.excludeRecordId ? { excludeRecordId: input.excludeRecordId } : {})).coverableDays
      : balance && balance.tracked ? balance.availableAfterPendingDays : null;
    const result = checkLeaveRequest({
      // applicability (review P1-3): gender and employment type — the one rule the portal, the charger and the year close use
      type: { name: type.name, applicableGender: type.applicableGender, applicableEmploymentTypes: type.applicableEmploymentTypes, allowHalfDay: type.allowHalfDay, advanceNoticeDays: type.advanceNoticeDays, maxConsecutiveDays: type.maxConsecutiveDays, compOff },
      employeeGender: employee.gender, employeeEmploymentType: employee.employmentType, startDate: input.startDate, endDate: input.endDate, isHalfDay: input.isHalfDay, days, today, asHr: input.asHr,
      availableAfterPendingDays: available,
    });
    if (result.errors.length) {
      // comp-off: when credits usable today do not reach these dates, say why (they expire before the leave), rather than
      // leave the employee comparing "0 available" with the balance their comp-off card shows
      const today0 = compOff && balance ? balance.availableAfterPendingDays : null;
      const issues = result.errors.map((e) => (e.code === 'COMP_OFF_BALANCE' && today0 !== null && today0 > (available ?? 0)
        ? { ...e, message: `Not enough comp-off credit for these dates: ${fmtDays(Math.max(0, available ?? 0))} day(s) of your credits are still valid on them (${fmtDays(today0)} available today — the rest expire before the leave), this request needs ${fmtDays(days)}.`, params: { ...e.params, availableToday: today0 } }
        : e));
      const first = issues[0]!;
      throw errors.validation(first.message, { issues: issues.map((e) => ({ path: e.path, message: e.message, code: e.code, params: e.params })) });
    }
    return { type, days, warnings: result.warnings.map((w) => ({ code: w.code, message: w.message, params: w.params })), balance, today, compOff };
  });
}

/** Follow-up switch: a FIRST_HALF + SECOND_HALF pair on one date (see findLeaveOverlap). */
const ALLOW_HALF_DAY_PAIRS = false;

/**
 * Active leave (PENDING / INFO_REQUESTED / APPROVED) that clashes with the range: any shared date — also the other half of a
 * half day. The database exclusion (`leave_records_no_overlap`) admits a FIRST_HALF + SECOND_HALF pair, but the attendance
 * day loader charges ONE leave per date, so the pair would leave the other half to be worked (and to the unexcused-day
 * sweep). Until the loader combines both halves, the API refuses the pair: the employee asks for the full day instead.
 * `ALLOW_HALF_DAY_PAIRS` is the switch for that follow-up.
 */
export async function findLeaveOverlap(trx: Trx, orgId: string, employeeId: string, range: { startDate: string; endDate: string; isHalfDay: boolean; halfDayPart: string | null }, excludeId?: string): Promise<string | null> {
  return withSystemScope(trx, orgId, async (t) => {
    let q = t.selectFrom('leaveRecords').select(['id', 'startDate', 'endDate', 'isHalfDay', 'halfDayPart']).where('organizationId', '=', orgId).where('employeeId', '=', employeeId)
      .where('status', 'in', ['PENDING', 'APPROVED', 'INFO_REQUESTED']).where('startDate', '<=', dv(range.endDate)).where('endDate', '>=', dv(range.startDate));
    if (excludeId) q = q.where('id', '!=', excludeId);
    for (const other of await q.execute()) {
      const complementaryHalves = ALLOW_HALF_DAY_PAIRS && range.isHalfDay && other.isHalfDay && isoDate(other.startDate) === range.startDate && !!range.halfDayPart && !!other.halfDayPart && other.halfDayPart !== range.halfDayPart;
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
