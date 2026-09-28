import type { RosterDayDto, RosterRowDto, ShiftRosterDto, ShiftRosterQuery } from '@flowza/contracts';
import { holidayDates, resolveShift, type EngineShiftAssignment, type EngineShiftPattern } from '@flowza/domain';
import { dayOfWeek, eachDate } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, requirePermission } from '../../lib/authorize.js';
import { type Actor, runUser, withSystemScope } from '../../lib/service.js';
import { isoDate, isoDateOrNull, jsonArray } from '../../lib/mappers.js';
import { likeContains, pageOf, toCount } from '../../lib/pagination.js';
import { attendancePolicy } from '../portal/common.js';
import { loadShifts, toShiftSummary } from '../portal/shift-resolve.js';
import { dv } from './sql-helpers.js';

/**
 * The monthly shift roster (HR portal Prompt 6b, Finance ATT-105 — the one schedule surface FlowZa did not have). For one page
 * of employees in the caller's branch scope it runs the ENGINE's own resolution per day — `resolveShift` over the assignments
 * and rotation patterns, the organisation's default shift where nothing resolves — with weekly offs (employee → branch →
 * organisation) and pattern off days as "Off", the branch's holiday calendar and approved leave: the same rules as the
 * portal's shift tab (`resolveDays`), batched so a page costs a fixed number of queries whatever its size.
 *
 * shift.view; the employee list is read under the caller's RLS (branch scope applies twice), the schedule reference data in
 * the organisation's system scope (the shifts / assignments the listed employees already point at).
 */
const nums = (v: unknown): number[] | null => (Array.isArray(v) ? v.map(Number) : null);

export async function shiftRoster(deps: ApiDeps, actor: Actor, orgId: string, q: ShiftRosterQuery): Promise<{ data: ShiftRosterDto; total: number }> {
  const grant = requirePermission(actor.principal, orgId, 'shift.view');
  const branches = branchFilter(grant, q.branchId);
  const dates = eachDate(`${q.month}-01`, lastDayOf(q.month));
  const from = dates[0]!;
  const to = dates.at(-1)!;
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('employees').where('organizationId', '=', orgId).where('deletedAt', 'is', null)
      .where('joiningDate', '<=', dv(to)).where((eb) => eb.or([eb('exitDate', 'is', null), eb('exitDate', '>=', dv(from))]))
      .where((eb) => eb.or([eb('employmentStatus', 'not in', ['terminated', 'resigned']), eb('exitDate', '>=', dv(from))]));
    if (branches) base = base.where('branchId', 'in', branches);
    if (q.departmentId) base = base.where('departmentId', '=', q.departmentId);
    if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb('displayName', 'ilike', like), eb('employeeNumber', 'ilike', like)])); }
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('c')).executeTakeFirst())?.c);
    const page = pageOf(q);
    const employees = await base.select(['id', 'displayName', 'employeeNumber', 'branchId', 'departmentId', 'weeklyOffDays', 'joiningDate', 'exitDate'])
      .orderBy('displayName').orderBy('id').limit(page.pageSize).offset(page.offset).execute();
    const empty: ShiftRosterDto = { month: q.month, from, to, dates, shifts: [], rows: [] };
    if (employees.length === 0) return { data: empty, total };
    const ids = employees.map((e) => e.id);

    return withSystemScope(trx, orgId, async (t) => {
      const branchIds = [...new Set(employees.map((e) => e.branchId))];
      const departmentIds = [...new Set(employees.map((e) => e.departmentId).filter((x): x is string => !!x))];
      const [org, branchRows, departments, teams, defaultCalendar, assignmentRows, patternRows, policy, leave] = await Promise.all([
        t.selectFrom('organizations').select(['weeklyOffDays']).where('id', '=', orgId).executeTakeFirstOrThrow(),
        t.selectFrom('branches').select(['id', 'name', 'weeklyOffDays', 'holidayCalendarId']).where('organizationId', '=', orgId).where('id', 'in', branchIds).execute(),
        departmentIds.length ? t.selectFrom('departments').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', departmentIds).execute() : Promise.resolve([]),
        t.selectFrom('teamMembers').select(['employeeId', 'teamId']).where('organizationId', '=', orgId).where('employeeId', 'in', ids).execute(),
        t.selectFrom('holidayCalendars').select('id').where('organizationId', '=', orgId).where('isDefault', '=', true).executeTakeFirst(),
        t.selectFrom('shiftAssignments').select(['id', 'targetType', 'targetId', 'shiftId', 'shiftPatternId', 'effectiveFrom', 'effectiveTo']).where('organizationId', '=', orgId)
          .where('effectiveFrom', '<=', dv(to)).where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', dv(from))])).execute(),
        t.selectFrom('shiftPatterns').select(['id', 'cycleLengthDays', 'anchorDate', 'sequence']).where('organizationId', '=', orgId).execute(),
        attendancePolicy(t, orgId),
        t.selectFrom('leaveRecords').select(['employeeId', 'startDate', 'endDate']).where('organizationId', '=', orgId).where('employeeId', 'in', ids).where('status', '=', 'APPROVED')
          .where('startDate', '<=', dv(to)).where('endDate', '>=', dv(from)).execute(),
      ]);
      const branchById = new Map(branchRows.map((b) => [b.id, b]));
      const calendarOf = (branchId: string) => branchById.get(branchId)?.holidayCalendarId ?? defaultCalendar?.id ?? null;
      const calendarIds = [...new Set(employees.map((e) => calendarOf(e.branchId)).filter((x): x is string => !!x))];
      const holidays = calendarIds.length ? await t.selectFrom('holidays').select(['calendarId', 'date', 'endDate', 'name', 'branchIds']).where('organizationId', '=', orgId).where('calendarId', 'in', calendarIds)
        .where('date', '<=', dv(to)).where((eb) => eb.or([eb('endDate', '>=', dv(from)), eb.and([eb('endDate', 'is', null), eb('date', '>=', dv(from))])])).execute() : [];
      const assignments: EngineShiftAssignment[] = assignmentRows.map((a) => ({ id: a.id, targetType: a.targetType, targetId: a.targetId, shiftId: a.shiftId, shiftPatternId: a.shiftPatternId, effectiveFrom: isoDate(a.effectiveFrom), effectiveTo: isoDateOrNull(a.effectiveTo) }));
      const patterns: EngineShiftPattern[] = patternRows.map((p) => ({ id: p.id, cycleLengthDays: p.cycleLengthDays, anchorDate: isoDate(p.anchorDate), sequence: jsonArray(p.sequence) as EngineShiftPattern['sequence'] }));
      const teamsOf = new Map<string, string[]>();
      for (const m of teams) teamsOf.set(m.employeeId, [...(teamsOf.get(m.employeeId) ?? []), m.teamId]);
      const departmentName = new Map(departments.map((d) => [d.id, d.name]));
      const defaultShiftId = policy.defaultShiftId ?? null;
      const orgOff = nums(org.weeklyOffDays) ?? [];

      const rows: RosterRowDto[] = [];
      const usedShifts = new Set<string>();
      for (const e of employees) {
        const branch = branchById.get(e.branchId);
        const weeklyOff = nums(e.weeklyOffDays) ?? nums(branch?.weeklyOffDays) ?? orgOff;
        const calendarId = calendarOf(e.branchId);
        const holidayName = new Map<string, string>();
        for (const h of holidays.filter((x) => x.calendarId === calendarId && (!x.branchIds || x.branchIds.includes(e.branchId)))) {
          for (const d of holidayDates([{ date: isoDate(h.date), endDate: isoDateOrNull(h.endDate) }])) if (!holidayName.has(d)) holidayName.set(d, h.name);
        }
        const leaveRanges = leave.filter((l) => l.employeeId === e.id).map((l) => [isoDate(l.startDate), isoDate(l.endDate)] as const);
        const scope = { employeeId: e.id, teamIds: teamsOf.get(e.id) ?? [], departmentId: e.departmentId, branchId: e.branchId, organizationId: orgId };
        const joined = isoDate(e.joiningDate);
        const exit = isoDateOrNull(e.exitDate);
        const days: Record<string, RosterDayDto> = {};
        for (const date of dates) {
          if (date < joined || (exit && date > exit)) continue;
          const r = resolveShift(assignments, patterns, scope, date);
          const shiftId = r.shiftId ?? (r.isPatternOff ? null : defaultShiftId);
          if (shiftId) usedShifts.add(shiftId);
          days[date] = {
            shiftId,
            source: r.shiftId ? (r.source === 'PATTERN' ? 'PATTERN' : 'ASSIGNMENT') : r.isPatternOff ? 'PATTERN' : defaultShiftId ? 'DEFAULT' : 'NONE',
            isOff: r.isPatternOff || weeklyOff.includes(dayOfWeek(date)),
            holidayName: holidayName.get(date) ?? null,
            onLeave: leaveRanges.some(([s, en]) => s <= date && en >= date),
          };
        }
        rows.push({ employeeId: e.id, employeeNumber: e.employeeNumber, employeeName: e.displayName, branchId: e.branchId, branchName: branch?.name ?? null, departmentName: e.departmentId ? departmentName.get(e.departmentId) ?? null : null, days });
      }
      const shifts = await loadShifts(t, orgId, [...usedShifts]);
      return { data: { ...empty, shifts: [...shifts.values()].map(toShiftSummary).sort((a, b) => a.code.localeCompare(b.code)), rows }, total };
    });
  });
}

function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}
