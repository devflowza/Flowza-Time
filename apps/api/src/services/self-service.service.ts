import { DateTime } from 'luxon';
import type { SelfAttendanceMonthDto, SelfDayDto, SelfHolidayDto, SelfLeaveRecordDto, SelfMonthTotals, SelfOverviewDto, SelfProfileDto } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { attendanceRateOf, holidayDates, isOpenDay, type MembershipGrant, type WorkingCalendar } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { hasPermission, requireMembership } from '../lib/authorize.js';
import { type Actor, runUser, withSystemScope } from '../lib/service.js';
import { toCount } from '../lib/pagination.js';
import { isoDate, isoDateOrNull } from '../lib/mappers.js';
import { DAILY_RECORD_COLUMNS, toDailyRecordDto, type DailyRecordRow } from './features/mappers.js';
import { dv } from './features/sql-helpers.js';
import { overviewLeave } from './leave/self-leave.service.js';

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

/**
 * The month card's totals. The working days and the attendance rate are THE portal definition shared with the statistics
 * card (`attendanceRateOf`, HR portal Prompt 4 review P2-14 — approved leave is outside the denominator), and `today`'s
 * running day is never counted as a missing punch while only its check-out is outstanding.
 */
export function monthTotals(days: readonly SelfDayDto[], today?: string): SelfMonthTotals {
  const t: SelfMonthTotals = { present: 0, absent: 0, leave: 0, holiday: 0, weeklyOff: 0, halfDay: 0, late: 0, missingPunch: 0, workedMinutes: 0, overtimeMinutes: 0, lateMinutes: 0, earlyDepartureMinutes: 0, workingDays: 0, attendedDays: 0, attendanceRate: null };
  for (const d of days) {
    if (d.status === 'PRESENT') t.present += 1; else if (d.status === 'ABSENT') t.absent += 1; else if (d.status === 'LEAVE') t.leave += 1; else if (d.status === 'HOLIDAY') t.holiday += 1; else if (d.status === 'WEEKLY_OFF') t.weeklyOff += 1; else if (d.status === 'HALF_DAY') t.halfDay += 1;
    if (d.flags.includes('LATE')) t.late += 1;
    const open = today !== undefined && isOpenDay({ date: d.attendanceDate, flags: d.flags }, today);
    if (!open && (d.status === 'MISSING_PUNCH' || d.flags.includes('MISSING_IN') || d.flags.includes('MISSING_OUT'))) t.missingPunch += 1;
    t.workedMinutes += d.workedMinutes; t.overtimeMinutes += d.overtimeMinutes; t.lateMinutes += d.lateMinutes; t.earlyDepartureMinutes += d.earlyDepartureMinutes;
  }
  const rate = attendanceRateOf(days);
  t.workingDays = rate.expectedDays; t.attendedDays = rate.attendedDays; t.attendanceRate = rate.rate;
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
      const leave = await trx.selectFrom('leaveRecords as l').innerJoin('leaveTypes as t', 't.id', 'l.leaveTypeId').select(['l.startDate', 'l.endDate', 'l.isHalfDay', 't.name', 't.nameAr', 't.color'])
        .where('l.organizationId', '=', orgId).where('l.employeeId', '=', scope.employeeId).where('l.status', '=', 'APPROVED').where('l.startDate', '<=', dv(to)).where('l.endDate', '>=', dv(from)).execute();
      for (const l of leave) {
        for (let d = DateTime.fromISO(isoDate(l.startDate), { zone: 'utc' }); d.toISODate()! <= isoDate(l.endDate); d = d.plus({ days: 1 })) {
          const iso = d.toISODate()!;
          if (iso >= from && iso <= to) leaveByDate[iso] = { leaveTypeName: l.name, leaveTypeNameAr: l.nameAr, color: l.color, isHalfDay: l.isHalfDay };
        }
      }
    }
    const holidaysByDate: Record<string, string> = {}; const holidaysByDateAr: Record<string, string> = {};
    for (const h of await loadHolidays(trx, orgId, ctx, from, to)) {
      for (const d of holidayDates([h])) {
        if (d < from || d > to) continue;
        holidaysByDate[d] = h.name;
        if (h.nameAr) holidaysByDateAr[d] = h.nameAr; else delete holidaysByDateAr[d];
      }
    }
    return { month, days, totals: monthTotals(days, todayIn(ctx.timezone)), leaveByDate, holidaysByDate, holidaysByDateAr };
  });
}

// ----- leave -----------------------------------------------------------------------------------------------------------

// Leave v2 (HR portal Prompt 7) lives in services/leave/self-leave.service.ts; the routes keep importing it from here.
export { applyLeave, cancelLeave, editLeave, getLeave, getTeamLeave, replyLeave, withdrawLeave } from './leave/self-leave.service.js';

async function workingCalendar(trx: Trx, orgId: string, ctx: SelfContext, from: string, to: string): Promise<{ cal: WorkingCalendar; holidays: SelfHolidayDto[] }> {
  const holidays = await loadHolidays(trx, orgId, ctx, from, to);
  return { cal: { weeklyOffDays: ctx.weeklyOffDays, holidays: holidayDates(holidays) }, holidays };
}

// ----- profile and overview --------------------------------------------------------------------------------------------

export async function getProfile(deps: ApiDeps, actor: Actor, orgId: string): Promise<SelfProfileDto> {
  const scope = selfScope(actor, orgId);
  return runUser(deps.db, actor, async (trx) => {
    const e = await trx.selectFrom('employees').select(['id', 'employeeNumber', 'displayName', 'displayNameAr', 'firstName', 'lastName', 'email', 'phone', 'gender', 'dateOfBirth', 'nationalityCode', 'joiningDate', 'employmentStatus', 'employmentType', 'photoPath', 'branchId', 'departmentId', 'designationId', 'managerEmployeeId', 'secondaryManagerEmployeeId', 'weeklyOffDays'])
      .where('organizationId', '=', orgId).where('id', '=', scope.employeeId).where('deletedAt', 'is', null).executeTakeFirst();
    if (!e) throw errors.notFound('Employee record');
    const ctx = await loadContext(trx, orgId, scope.employeeId);
    const ref = await withSystemScope(trx, orgId, async (t) => ({
      department: e.departmentId ? await t.selectFrom('departments').select(['id', 'name']).where('organizationId', '=', orgId).where('id', '=', e.departmentId).executeTakeFirst() : undefined,
      designation: e.designationId ? await t.selectFrom('designations').select(['id', 'name']).where('organizationId', '=', orgId).where('id', '=', e.designationId).executeTakeFirst() : undefined,
      manager: e.managerEmployeeId ? await t.selectFrom('employees').select(['id', 'displayName', 'employeeNumber']).where('organizationId', '=', orgId).where('id', '=', e.managerEmployeeId).executeTakeFirst() : undefined,
      secondaryManager: e.secondaryManagerEmployeeId ? await t.selectFrom('employees').select(['id', 'displayName', 'employeeNumber']).where('organizationId', '=', orgId).where('id', '=', e.secondaryManagerEmployeeId).executeTakeFirst() : undefined,
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
      secondaryManager: ref.secondaryManager ? { id: ref.secondaryManager.id, name: ref.secondaryManager.displayName, employeeNumber: ref.secondaryManager.employeeNumber } : null,
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
    const { holidays } = await workingCalendar(trx, orgId, ctx, `${year}-01-01`, inAYear);

    const monthDays = attendance ? await ownRecords(trx, orgId, scope.employeeId, monthStart, today) : [];
    const recent = attendance ? await ownRecords(trx, orgId, scope.employeeId, DateTime.fromISO(today, { zone: 'utc' }).minus({ days: 13 }).toISODate()!, today, { order: 'desc', limit: 7 }) : [];
    const pendingCorrections = attendance
      ? toCount((await trx.selectFrom('attendanceCorrections').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('employeeId', '=', scope.employeeId).where('status', '=', 'PENDING').executeTakeFirst())?.n)
      : 0;

    let balances: SelfOverviewDto['balances'] = []; let upcomingLeave: SelfLeaveRecordDto[] = []; let pendingLeave = 0;
    // tracked types and anything already used or requested this year, through the one balance function (leave v2)
    if (leave) ({ balances, upcomingLeave, pendingLeave } = await overviewLeave(trx, orgId, scope.employeeId, scope.grant, actor.userId));

    return {
      date: today, timezone: ctx.timezone,
      today: monthDays.find((d) => d.attendanceDate === today) ?? null,
      month: { month: today.slice(0, 7), totals: monthTotals(monthDays, today) },
      recent, balances, upcomingLeave, pendingLeave, pendingCorrections,
      upcomingHolidays: holidays.filter((h) => (h.endDate ?? h.date) >= today).slice(0, 5),
    };
  });
}
