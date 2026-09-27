import { DateTime } from 'luxon';
import type { AttendanceStatus, SelfAttendanceMonthDto, SelfDayDto, SelfHolidayDto, SelfLeaveDto, SelfLeaveRecordDto, SelfLeaveRequestInput, SelfLeaveTypeDto, SelfMonthTotals, SelfOverviewDto, SelfProfileDto } from '@flowza/contracts';
import { emitDomainEvent, type Trx } from '@flowza/database';
import { countLeaveDays, holidayDates, leaveBalances, type MembershipGrant, type WorkingCalendar } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { hasPermission, requireMembership } from '../lib/authorize.js';
import { type Actor, audit, runUser, withSystemScope } from '../lib/service.js';
import { toCount } from '../lib/pagination.js';
import { isoDate, isoDateOrNull, isoDateTime, isoDateTimeOrNull, numberOrNull } from '../lib/mappers.js';
import { DAILY_RECORD_COLUMNS, toDailyRecordDto, type DailyRecordRow } from './features/mappers.js';
import { dv } from './features/sql-helpers.js';
import { assertLeaveRangeUnlocked, assertNoLeaveOverlap } from './features/schedule.service.js';

/**
 * Employee self-service (/orgs/:orgId/me/…): the caller's own employee record in one organisation.
 *
 * The employee is always the membership's employee link — never a client-supplied id. Own rows (employee, daily
 * records, leave, corrections) are read under the caller's RLS through the policies' self column. The few reference
 * names an employee's role cannot read (their branch, department, designation, manager, team, shift names) are
 * resolved in the organisation's system scope, and only for the ids on the caller's own rows.
 */

interface SelfScope { grant: MembershipGrant; employeeId: string }

function selfScope(actor: Actor, orgId: string): SelfScope {
  const grant = requireMembership(actor.principal, orgId);
  if (!grant.employeeId) throw errors.forbidden('Your account is not linked to an employee record in this organisation.');
  return { grant, employeeId: grant.employeeId };
}
function requireOwnAttendance(s: SelfScope): void {
  if (!hasPermission(s.grant, 'attendance.view_own') && !hasPermission(s.grant, 'attendance.view')) throw errors.forbidden('Missing permission: attendance.view_own.');
}
const canSeeOwnLeave = (s: SelfScope) => hasPermission(s.grant, 'leave.request') || hasPermission(s.grant, 'leave.view');
function requireOwnLeave(s: SelfScope): void {
  if (!canSeeOwnLeave(s)) throw errors.forbidden('Missing permission: leave.request.');
}

// ----- the employee's working calendar ---------------------------------------------------------------------------------

interface SelfContext {
  employee: { id: string; displayName: string; branchId: string; departmentId: string | null; designationId: string | null; managerEmployeeId: string | null; joiningDate: string; exitDate: string | null; weeklyOffDays: number[] | null };
  branch: { id: string; name: string; timezone: string | null; weeklyOffDays: number[] | null; holidayCalendarId: string | null } | null;
  orgTimezone: string;
  orgWeeklyOffDays: number[];
  calendarId: string | null;
  timezone: string;
  weeklyOffDays: number[];
}

async function loadContext(trx: Trx, orgId: string, employeeId: string): Promise<SelfContext> {
  const emp = await trx.selectFrom('employees').select(['id', 'displayName', 'branchId', 'departmentId', 'designationId', 'managerEmployeeId', 'joiningDate', 'exitDate', 'weeklyOffDays'])
    .where('organizationId', '=', orgId).where('id', '=', employeeId).where('deletedAt', 'is', null).executeTakeFirst();
  if (!emp) throw errors.notFound('Employee record');
  const ref = await withSystemScope(trx, orgId, async (t) => {
    const [org, branch, defaultCalendar] = await Promise.all([
      t.selectFrom('organizations').select(['timezone', 'weeklyOffDays']).where('id', '=', orgId).executeTakeFirstOrThrow(),
      t.selectFrom('branches').select(['id', 'name', 'timezone', 'weeklyOffDays', 'holidayCalendarId']).where('organizationId', '=', orgId).where('id', '=', emp.branchId).executeTakeFirst(),
      t.selectFrom('holidayCalendars').select('id').where('organizationId', '=', orgId).where('isDefault', '=', true).executeTakeFirst(),
    ]);
    return { org, branch, defaultCalendarId: defaultCalendar?.id ?? null };
  });
  const nums = (v: unknown): number[] | null => (Array.isArray(v) ? v.map(Number) : null);
  const branch = ref.branch ? { id: ref.branch.id, name: ref.branch.name, timezone: ref.branch.timezone, weeklyOffDays: nums(ref.branch.weeklyOffDays), holidayCalendarId: ref.branch.holidayCalendarId } : null;
  const orgWeeklyOffDays = nums(ref.org.weeklyOffDays) ?? [];
  const employee = { id: emp.id, displayName: emp.displayName, branchId: emp.branchId, departmentId: emp.departmentId, designationId: emp.designationId, managerEmployeeId: emp.managerEmployeeId, joiningDate: isoDate(emp.joiningDate), exitDate: isoDateOrNull(emp.exitDate), weeklyOffDays: nums(emp.weeklyOffDays) };
  return {
    employee, branch, orgTimezone: ref.org.timezone, orgWeeklyOffDays,
    calendarId: branch?.holidayCalendarId ?? ref.defaultCalendarId,
    timezone: branch?.timezone || ref.org.timezone || 'UTC',
    // same precedence as the engine: employee → branch → organisation
    weeklyOffDays: employee.weeklyOffDays ?? branch?.weeklyOffDays ?? orgWeeklyOffDays,
  };
}

async function loadHolidays(trx: Trx, orgId: string, ctx: SelfContext, from: string, to: string) {
  if (!ctx.calendarId) return [];
  return trx.selectFrom('holidays').select(['date', 'endDate', 'name', 'nameAr', 'branchIds'])
    .where('organizationId', '=', orgId).where('calendarId', '=', ctx.calendarId)
    .where('date', '<=', dv(to)).where((eb) => eb.or([eb('endDate', '>=', dv(from)), eb.and([eb('endDate', 'is', null), eb('date', '>=', dv(from))])]))
    .orderBy('date').execute()
    .then((rows) => rows.filter((h) => !h.branchIds || h.branchIds.includes(ctx.employee.branchId)).map((h) => ({ date: isoDate(h.date), endDate: isoDateOrNull(h.endDate), name: h.name, nameAr: h.nameAr })));
}

const todayIn = (tz: string) => DateTime.now().setZone(tz).toISODate() ?? DateTime.utc().toISODate()!;

// ----- attendance ------------------------------------------------------------------------------------------------------

async function ownRecords(trx: Trx, orgId: string, employeeId: string, from: string, to: string, opts: { order?: 'asc' | 'desc'; limit?: number } = {}): Promise<SelfDayDto[]> {
  let q = trx.selectFrom('attendanceDailyRecords as r').innerJoin('employees as e', 'e.id', 'r.employeeId').leftJoin('branches as b', 'b.id', 'r.branchId').leftJoin('departments as dp', 'dp.id', 'r.departmentId').leftJoin('shifts as s', 's.id', 'r.shiftId')
    .select(DAILY_RECORD_COLUMNS).where('r.organizationId', '=', orgId).where('r.employeeId', '=', employeeId)
    .where('r.attendanceDate', '>=', dv(from)).where('r.attendanceDate', '<=', dv(to)).orderBy('r.attendanceDate', opts.order ?? 'asc');
  if (opts.limit) q = q.limit(opts.limit);
  const rows = (await q.execute()) as DailyRecordRow[];
  return fillNames(trx, orgId, rows.map(toDailyRecordDto));
}

/** Branch / department / shift names hidden from the employee's RLS scope, resolved for the ids on their own rows. */
async function fillNames(trx: Trx, orgId: string, days: SelfDayDto[]): Promise<SelfDayDto[]> {
  const missing = <K extends 'branchName' | 'departmentName' | 'shiftName'>(key: K, id: (d: SelfDayDto) => string | null) => [...new Set(days.filter((d) => !d[key]).map(id).filter((x): x is string => !!x))];
  const branchIds = missing('branchName', (d) => d.branchId);
  const departmentIds = missing('departmentName', (d) => d.departmentId);
  const shiftIds = missing('shiftName', (d) => d.shiftId);
  if (!branchIds.length && !departmentIds.length && !shiftIds.length) return days;
  const names = await withSystemScope(trx, orgId, async (t) => ({
    branches: branchIds.length ? await t.selectFrom('branches').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', branchIds).execute() : [],
    departments: departmentIds.length ? await t.selectFrom('departments').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', departmentIds).execute() : [],
    shifts: shiftIds.length ? await t.selectFrom('shifts').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', shiftIds).execute() : [],
  }));
  const b = new Map(names.branches.map((x) => [x.id, x.name])); const dp = new Map(names.departments.map((x) => [x.id, x.name])); const s = new Map(names.shifts.map((x) => [x.id, x.name]));
  return days.map((d) => ({ ...d, branchName: d.branchName ?? b.get(d.branchId) ?? null, departmentName: d.departmentName ?? (d.departmentId ? dp.get(d.departmentId) ?? null : null), shiftName: d.shiftName ?? (d.shiftId ? s.get(d.shiftId) ?? null : null) }));
}

const NOT_EXPECTED: ReadonlySet<AttendanceStatus> = new Set(['HOLIDAY', 'WEEKLY_OFF', 'NOT_JOINED', 'EXITED', 'PENDING']);

export function monthTotals(days: readonly SelfDayDto[]): SelfMonthTotals {
  const t: SelfMonthTotals = { present: 0, absent: 0, leave: 0, holiday: 0, weeklyOff: 0, halfDay: 0, late: 0, missingPunch: 0, workedMinutes: 0, overtimeMinutes: 0, lateMinutes: 0, earlyDepartureMinutes: 0, workingDays: 0, attendanceRate: null };
  for (const d of days) {
    if (d.status === 'PRESENT') t.present += 1; else if (d.status === 'ABSENT') t.absent += 1; else if (d.status === 'LEAVE') t.leave += 1; else if (d.status === 'HOLIDAY') t.holiday += 1; else if (d.status === 'WEEKLY_OFF') t.weeklyOff += 1; else if (d.status === 'HALF_DAY') t.halfDay += 1;
    if (d.flags.includes('LATE')) t.late += 1;
    if (d.status === 'MISSING_PUNCH' || d.flags.includes('MISSING_IN') || d.flags.includes('MISSING_OUT')) t.missingPunch += 1;
    if (!NOT_EXPECTED.has(d.status)) t.workingDays += 1;
    t.workedMinutes += d.workedMinutes; t.overtimeMinutes += d.overtimeMinutes; t.lateMinutes += d.lateMinutes; t.earlyDepartureMinutes += d.earlyDepartureMinutes;
  }
  // a MISSING_PUNCH day still had the employee at work; count it with present for the rate
  const attended = t.present + t.halfDay * 0.5 + days.filter((d) => d.status === 'MISSING_PUNCH').length;
  t.attendanceRate = t.workingDays > 0 ? Math.min(1, attended / t.workingDays) : null;
  return t;
}

export async function getAttendanceMonth(deps: ApiDeps, actor: Actor, orgId: string, q: { month?: string }): Promise<SelfAttendanceMonthDto> {
  const scope = selfScope(actor, orgId);
  requireOwnAttendance(scope);
  return runUser(deps.db, actor, async (trx) => {
    const ctx = await loadContext(trx, orgId, scope.employeeId);
    const month = q.month ?? todayIn(ctx.timezone).slice(0, 7);
    const start = DateTime.fromISO(`${month}-01`, { zone: 'utc' });
    if (!start.isValid) throw errors.validation('Invalid month.', { issues: [{ path: 'month', message: 'Expected yyyy-MM' }] });
    const from = start.toISODate()!; const to = start.endOf('month').toISODate()!;
    const days = await ownRecords(trx, orgId, scope.employeeId, from, to);
    const leaveByDate: SelfAttendanceMonthDto['leaveByDate'] = {};
    if (canSeeOwnLeave(scope)) {
      const leave = await trx.selectFrom('leaveRecords as l').innerJoin('leaveTypes as t', 't.id', 'l.leaveTypeId').select(['l.startDate', 'l.endDate', 'l.isHalfDay', 't.name', 't.color'])
        .where('l.organizationId', '=', orgId).where('l.employeeId', '=', scope.employeeId).where('l.status', '=', 'APPROVED').where('l.startDate', '<=', dv(to)).where('l.endDate', '>=', dv(from)).execute();
      for (const l of leave) {
        for (let d = DateTime.fromISO(isoDate(l.startDate), { zone: 'utc' }); d.toISODate()! <= isoDate(l.endDate); d = d.plus({ days: 1 })) {
          const iso = d.toISODate()!;
          if (iso >= from && iso <= to) leaveByDate[iso] = { leaveTypeName: l.name, color: l.color, isHalfDay: l.isHalfDay };
        }
      }
    }
    const holidaysByDate: Record<string, string> = {};
    for (const h of await loadHolidays(trx, orgId, ctx, from, to)) for (const d of holidayDates([h])) if (d >= from && d <= to) holidaysByDate[d] = h.name;
    return { month, days, totals: monthTotals(days), leaveByDate, holidaysByDate };
  });
}

// ----- leave -----------------------------------------------------------------------------------------------------------

type OwnLeaveRow = { id: string; leaveTypeId: string; code: string; name: string; color: string | null; isPaid: boolean; startDate: Date | string; endDate: Date | string; isHalfDay: boolean; halfDayPart: string | null; reason: string | null; status: SelfLeaveRecordDto['status']; decisionNote: string | null; approvedBy: string | null; approvedAt: Date | null; createdAt: Date; updatedAt: Date };

async function ownLeaveRows(trx: Trx, orgId: string, employeeId: string, filter: { from?: string; to?: string; id?: string } = {}): Promise<OwnLeaveRow[]> {
  let q = trx.selectFrom('leaveRecords as l').innerJoin('leaveTypes as t', 't.id', 'l.leaveTypeId')
    .select(['l.id', 'l.leaveTypeId', 't.code', 't.name', 't.color', 't.isPaid', 'l.startDate', 'l.endDate', 'l.isHalfDay', 'l.halfDayPart', 'l.reason', 'l.status', 'l.decisionNote', 'l.approvedBy', 'l.approvedAt', 'l.createdAt', 'l.updatedAt'])
    .where('l.organizationId', '=', orgId).where('l.employeeId', '=', employeeId);
  if (filter.id) q = q.where('l.id', '=', filter.id);
  if (filter.from) q = q.where('l.endDate', '>=', dv(filter.from));
  if (filter.to) q = q.where('l.startDate', '<=', dv(filter.to));
  return (await q.orderBy('l.startDate', 'desc').orderBy('l.createdAt', 'desc').execute()) as OwnLeaveRow[];
}

async function toLeaveDtos(trx: Trx, orgId: string, rows: OwnLeaveRow[], cal: WorkingCalendar): Promise<SelfLeaveRecordDto[]> {
  const approverIds = [...new Set(rows.map((r) => r.approvedBy).filter((x): x is string => !!x))];
  const approvers = approverIds.length ? await withSystemScope(trx, orgId, (t) => t.selectFrom('userProfiles').select(['id', 'fullName']).where('id', 'in', approverIds).execute()) : [];
  const nameOf = new Map(approvers.map((a) => [a.id, a.fullName]));
  return rows.map((r) => {
    const range = { startDate: isoDate(r.startDate), endDate: isoDate(r.endDate), isHalfDay: r.isHalfDay };
    return {
      id: r.id, leaveTypeId: r.leaveTypeId, leaveTypeCode: r.code, leaveTypeName: r.name, color: r.color, isPaid: r.isPaid, ...range, halfDayPart: r.halfDayPart, days: countLeaveDays(range, cal),
      reason: r.reason, status: r.status, decisionNote: r.decisionNote, approvedByName: r.approvedBy ? nameOf.get(r.approvedBy) || null : null, approvedAt: isoDateTimeOrNull(r.approvedAt), createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt),
    };
  });
}

async function leaveTypes(trx: Trx, orgId: string): Promise<SelfLeaveTypeDto[]> {
  const rows = await trx.selectFrom('leaveTypes').select(['id', 'code', 'name', 'nameAr', 'isPaid', 'color', 'annualAllowanceDays']).where('organizationId', '=', orgId).where('status', '=', 'active').orderBy('name').execute();
  return rows.map((t) => ({ id: t.id, code: t.code, name: t.name, nameAr: t.nameAr, isPaid: t.isPaid, color: t.color, annualAllowanceDays: numberOrNull(t.annualAllowanceDays) }));
}

async function workingCalendar(trx: Trx, orgId: string, ctx: SelfContext, from: string, to: string): Promise<{ cal: WorkingCalendar; holidays: SelfHolidayDto[] }> {
  const holidays = await loadHolidays(trx, orgId, ctx, from, to);
  return { cal: { weeklyOffDays: ctx.weeklyOffDays, holidays: holidayDates(holidays) }, holidays };
}

export async function getLeave(deps: ApiDeps, actor: Actor, orgId: string, q: { year?: number }): Promise<SelfLeaveDto> {
  const scope = selfScope(actor, orgId);
  requireOwnLeave(scope);
  return runUser(deps.db, actor, async (trx) => {
    const ctx = await loadContext(trx, orgId, scope.employeeId);
    const year = q.year ?? Number(todayIn(ctx.timezone).slice(0, 4));
    const from = `${year}-01-01`; const to = `${year}-12-31`;
    // next year's holidays too: a request made in December often ends in January
    const { cal, holidays } = await workingCalendar(trx, orgId, ctx, from, `${year + 1}-12-31`);
    const [types, rows] = await Promise.all([leaveTypes(trx, orgId), ownLeaveRows(trx, orgId, scope.employeeId, { from, to })]);
    const records = await toLeaveDtos(trx, orgId, rows, cal);
    const balances = leaveBalances(types.map((t) => ({ leaveTypeId: t.id, allowanceDays: t.annualAllowanceDays })), records, cal, year);
    return { year, types, balances, records, calendar: { weeklyOffDays: ctx.weeklyOffDays, holidays: [...holidayDates(holidays)].sort() } };
  });
}

export async function applyLeave(deps: ApiDeps, actor: Actor, orgId: string, input: SelfLeaveRequestInput): Promise<SelfLeaveRecordDto> {
  const scope = selfScope(actor, orgId);
  if (!hasPermission(scope.grant, 'leave.request')) throw errors.forbidden('Missing permission: leave.request.');
  const isHalfDay = input.isHalfDay ?? false;
  return runUser(deps.db, actor, async (trx) => {
    const ctx = await loadContext(trx, orgId, scope.employeeId);
    if (input.startDate < ctx.employee.joiningDate) throw errors.validation('Leave cannot start before your joining date.', { issues: [{ path: 'startDate', message: 'Before joining date' }] });
    if (ctx.employee.exitDate && input.endDate > ctx.employee.exitDate) throw errors.validation('Leave cannot end after your exit date.', { issues: [{ path: 'endDate', message: 'After exit date' }] });
    const type = await trx.selectFrom('leaveTypes').select(['id', 'name']).where('organizationId', '=', orgId).where('id', '=', input.leaveTypeId).where('status', '=', 'active').executeTakeFirst();
    if (!type) throw errors.validation('Leave type not found or archived.', { issues: [{ path: 'leaveTypeId', message: 'Unknown leave type' }] });
    const { cal } = await workingCalendar(trx, orgId, ctx, input.startDate, input.endDate);
    if (countLeaveDays({ startDate: input.startDate, endDate: input.endDate, isHalfDay }, cal) === 0) throw errors.validation('Every date in this range is a weekly off day or a holiday.', { issues: [{ path: 'startDate', message: 'No working days in range' }] });
    await assertLeaveRangeUnlocked(trx, orgId, ctx.employee.branchId, input.startDate, input.endDate);
    await assertNoLeaveOverlap(trx, orgId, scope.employeeId, input.startDate, input.endDate);
    const row = await trx.insertInto('leaveRecords').values({
      organizationId: orgId, employeeId: scope.employeeId, branchId: ctx.employee.branchId, leaveTypeId: input.leaveTypeId, startDate: input.startDate, endDate: input.endDate,
      isHalfDay, halfDayPart: isHalfDay ? input.halfDayPart ?? 'FIRST_HALF' : null, reason: input.reason, status: 'PENDING', source: 'INTERNAL', createdBy: actor.userId,
    }).returning('id').executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'leave.requested', 'leave_record', { entityId: row.id, branchId: ctx.employee.branchId, newValue: { ...input, isHalfDay } });
    await emitDomainEvent(trx, { organizationId: orgId, eventType: 'leave.requested', aggregateType: 'leave_record', aggregateId: row.id, payload: { employeeId: scope.employeeId, employeeName: ctx.employee.displayName, leaveTypeName: type.name, startDate: input.startDate, endDate: input.endDate }, actorUserId: actor.userId, requestId: actor.requestId });
    const saved = await ownLeaveRows(trx, orgId, scope.employeeId, { id: row.id });
    return (await toLeaveDtos(trx, orgId, saved, cal))[0]!;
  });
}

/** Withdraw one's own request while it is still PENDING; approved leave is changed by HR. */
export async function cancelLeave(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<SelfLeaveRecordDto> {
  const scope = selfScope(actor, orgId);
  if (!hasPermission(scope.grant, 'leave.request')) throw errors.forbidden('Missing permission: leave.request.');
  return runUser(deps.db, actor, async (trx) => {
    const [before] = await ownLeaveRows(trx, orgId, scope.employeeId, { id });
    if (!before) throw errors.notFound('Leave request', id);
    if (before.status !== 'PENDING') throw errors.invalidState(`Only a pending request can be withdrawn (current: ${before.status}). Ask HR to change approved leave.`);
    const res = await trx.updateTable('leaveRecords').set({ status: 'CANCELLED' }).where('organizationId', '=', orgId).where('id', '=', id).where('employeeId', '=', scope.employeeId).where('status', '=', 'PENDING').executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) throw errors.conflict('The request changed meanwhile. Please refresh.');
    await audit(trx, actor, orgId, 'leave.withdrawn', 'leave_record', { entityId: id, oldValue: { status: before.status }, newValue: { status: 'CANCELLED' } });
    const ctx = await loadContext(trx, orgId, scope.employeeId);
    const { cal } = await workingCalendar(trx, orgId, ctx, isoDate(before.startDate), isoDate(before.endDate));
    const after = await ownLeaveRows(trx, orgId, scope.employeeId, { id });
    return (await toLeaveDtos(trx, orgId, after, cal))[0]!;
  });
}

// ----- profile and overview --------------------------------------------------------------------------------------------

export async function getProfile(deps: ApiDeps, actor: Actor, orgId: string): Promise<SelfProfileDto> {
  const scope = selfScope(actor, orgId);
  return runUser(deps.db, actor, async (trx) => {
    const e = await trx.selectFrom('employees').select(['id', 'employeeNumber', 'displayName', 'displayNameAr', 'firstName', 'lastName', 'email', 'phone', 'gender', 'dateOfBirth', 'nationalityCode', 'joiningDate', 'employmentStatus', 'employmentType', 'photoPath', 'branchId', 'departmentId', 'designationId', 'managerEmployeeId', 'weeklyOffDays'])
      .where('organizationId', '=', orgId).where('id', '=', scope.employeeId).where('deletedAt', 'is', null).executeTakeFirst();
    if (!e) throw errors.notFound('Employee record');
    const ctx = await loadContext(trx, orgId, scope.employeeId);
    const ref = await withSystemScope(trx, orgId, async (t) => ({
      department: e.departmentId ? await t.selectFrom('departments').select(['id', 'name']).where('organizationId', '=', orgId).where('id', '=', e.departmentId).executeTakeFirst() : undefined,
      designation: e.designationId ? await t.selectFrom('designations').select(['id', 'name']).where('organizationId', '=', orgId).where('id', '=', e.designationId).executeTakeFirst() : undefined,
      manager: e.managerEmployeeId ? await t.selectFrom('employees').select(['id', 'displayName', 'employeeNumber']).where('organizationId', '=', orgId).where('id', '=', e.managerEmployeeId).executeTakeFirst() : undefined,
      teams: await t.selectFrom('teamMembers as tm').innerJoin('teams as tt', 'tt.id', 'tm.teamId').select(['tt.id', 'tt.name']).where('tm.organizationId', '=', orgId).where('tm.employeeId', '=', scope.employeeId).orderBy('tt.name').execute(),
      role: /^[0-9a-f-]{36}$/i.test(scope.grant.roleId) ? await t.selectFrom('roles').select('name').where('id', '=', scope.grant.roleId).executeTakeFirst() : undefined,
    }));
    return {
      employeeId: e.id, employeeNumber: e.employeeNumber, displayName: e.displayName, displayNameAr: e.displayNameAr, firstName: e.firstName, lastName: e.lastName, email: e.email, phone: e.phone,
      gender: e.gender, dateOfBirth: isoDateOrNull(e.dateOfBirth), nationality: e.nationalityCode, joiningDate: isoDate(e.joiningDate), employmentStatus: e.employmentStatus, employmentType: e.employmentType,
      photoUrl: null,
      branch: ctx.branch ? { id: ctx.branch.id, name: ctx.branch.name, timezone: ctx.branch.timezone } : null,
      department: ref.department ?? null, designation: ref.designation ?? null,
      manager: ref.manager ? { id: ref.manager.id, name: ref.manager.displayName, employeeNumber: ref.manager.employeeNumber } : null,
      teams: ref.teams, weeklyOffDays: ctx.weeklyOffDays, roleName: ref.role?.name ?? scope.grant.roleKey,
    };
  });
}

export async function getOverview(deps: ApiDeps, actor: Actor, orgId: string): Promise<SelfOverviewDto> {
  const scope = selfScope(actor, orgId);
  const attendance = hasPermission(scope.grant, 'attendance.view_own') || hasPermission(scope.grant, 'attendance.view');
  const leave = canSeeOwnLeave(scope);
  return runUser(deps.db, actor, async (trx) => {
    const ctx = await loadContext(trx, orgId, scope.employeeId);
    const today = todayIn(ctx.timezone);
    const monthStart = `${today.slice(0, 7)}-01`;
    const year = Number(today.slice(0, 4));
    const inAYear = DateTime.fromISO(today, { zone: 'utc' }).plus({ years: 1 }).toISODate()!;
    const { cal, holidays } = await workingCalendar(trx, orgId, ctx, `${year}-01-01`, inAYear);

    const monthDays = attendance ? await ownRecords(trx, orgId, scope.employeeId, monthStart, today) : [];
    const recent = attendance ? await ownRecords(trx, orgId, scope.employeeId, DateTime.fromISO(today, { zone: 'utc' }).minus({ days: 13 }).toISODate()!, today, { order: 'desc', limit: 7 }) : [];
    const pendingCorrections = attendance
      ? toCount((await trx.selectFrom('attendanceCorrections').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('employeeId', '=', scope.employeeId).where('status', '=', 'PENDING').executeTakeFirst())?.n)
      : 0;

    let balances: SelfOverviewDto['balances'] = []; let upcomingLeave: SelfLeaveRecordDto[] = []; let pendingLeave = 0;
    if (leave) {
      const [types, rows] = await Promise.all([leaveTypes(trx, orgId), ownLeaveRows(trx, orgId, scope.employeeId, { from: `${year}-01-01` })]);
      const records = await toLeaveDtos(trx, orgId, rows, cal);
      const typeById = new Map(types.map((t) => [t.id, t]));
      // tracked types (with an allowance) and anything already used or requested this year
      balances = leaveBalances(types.map((t) => ({ leaveTypeId: t.id, allowanceDays: t.annualAllowanceDays })), records, cal, year)
        .filter((b) => b.allowanceDays !== null || b.usedDays > 0 || b.pendingDays > 0)
        .map((b) => { const t = typeById.get(b.leaveTypeId)!; return { ...b, name: t.name, code: t.code, color: t.color }; });
      upcomingLeave = records.filter((r) => r.endDate >= today && (r.status === 'APPROVED' || r.status === 'PENDING')).sort((a, b) => a.startDate.localeCompare(b.startDate)).slice(0, 5);
      pendingLeave = records.filter((r) => r.status === 'PENDING').length;
    }

    return {
      date: today, timezone: ctx.timezone,
      today: monthDays.find((d) => d.attendanceDate === today) ?? null,
      month: { month: today.slice(0, 7), totals: monthTotals(monthDays) },
      recent, balances, upcomingLeave, pendingLeave, pendingCorrections,
      upcomingHolidays: holidays.filter((h) => (h.endDate ?? h.date) >= today).slice(0, 5),
    };
  });
}
