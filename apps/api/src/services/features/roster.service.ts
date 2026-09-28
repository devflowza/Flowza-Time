import type { RosterDayDto, RosterRowDto, ShiftRosterDto, ShiftRosterQuery } from '@flowza/contracts';
import { loadEmployeeWorkingCalendars } from '@flowza/database';
import { dayOfWeek, eachDate } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, requirePermission } from '../../lib/authorize.js';
import { type Actor, runUser, withSystemScope } from '../../lib/service.js';
import { isoDate, isoDateOrNull } from '../../lib/mappers.js';
import { likeContains, pageOf, toCount } from '../../lib/pagination.js';
import { attendancePolicy } from '../portal/common.js';
import { loadShifts, toShiftSummary } from '../portal/shift-resolve.js';
import { dv } from './sql-helpers.js';

/**
 * The monthly shift roster (HR portal Prompt 6b, Finance ATT-105 — the one schedule surface FlowZa did not have). For one page
 * of employees in the caller's branch scope it resolves every day with THE per-date working calendar
 * (`loadEmployeeWorkingCalendars` — the resolver the attendance engine's input loader, leave counting and comp-off share): the
 * branch / department / team in force ON that date from the employment history (review P1-4 — the roster used today's placement
 * for the whole month), the shift the engine resolves there (`resolveShift` over assignments and rotation patterns, the
 * organisation's default shift where nothing resolves), the weekly offs of that date's placement (employee → branch →
 * organisation) and rotation off days as "Off", that branch's holiday calendar (branch-limited holidays honoured) and approved
 * leave. So the roster, the engine and leave counting cannot disagree about a day.
 *
 * Branch / department filters apply PER DAY too: an employee is listed when they were placed in the filter's branches
 * (department) on at least one day of the month, and a day they spent elsewhere is left blank (as a day outside the employment
 * is) — a branch-scoped reader never sees another branch's days. shift.view; the employee list is read under the caller's RLS
 * (branch scope applies twice), the schedule reference data in the organisation's system scope (only for those employees).
 */
export async function shiftRoster(deps: ApiDeps, actor: Actor, orgId: string, q: ShiftRosterQuery): Promise<{ data: ShiftRosterDto; total: number }> {
  const grant = requirePermission(actor.principal, orgId, 'shift.view');
  const branches = branchFilter(grant, q.branchId);
  const dates = eachDate(`${q.month}-01`, lastDayOf(q.month));
  const from = dates[0]!;
  const to = dates.at(-1)!;
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('employees as e').where('e.organizationId', '=', orgId).where('e.deletedAt', 'is', null)
      .where('e.joiningDate', '<=', dv(to)).where((eb) => eb.or([eb('e.exitDate', 'is', null), eb('e.exitDate', '>=', dv(from))]))
      .where((eb) => eb.or([eb('e.employmentStatus', 'not in', ['terminated', 'resigned']), eb('e.exitDate', '>=', dv(from))]));
    // placed in the filter's branches / department on at least one day of the month: today's placement, or a history row
    // overlapping the month ([effective_from, effective_to))
    const placedIn = (column: 'branchId' | 'departmentId', ids: readonly string[]) => base.where((eb) => eb.or([
      eb(`e.${column}`, 'in', [...ids]),
      eb.exists(eb.selectFrom('employmentHistory as h').select('h.id').whereRef('h.employeeId', '=', 'e.id').where('h.organizationId', '=', orgId)
        .where(`h.${column}`, 'in', [...ids]).where('h.effectiveFrom', '<=', dv(to)).where((w) => w.or([w('h.effectiveTo', 'is', null), w('h.effectiveTo', '>', dv(from))]))),
    ]));
    if (branches) base = placedIn('branchId', branches);
    if (q.departmentId) base = placedIn('departmentId', [q.departmentId]);
    if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb('e.displayName', 'ilike', like), eb('e.employeeNumber', 'ilike', like)])); }
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('c')).executeTakeFirst())?.c);
    const page = pageOf(q);
    const employees = await base.select(['e.id', 'e.displayName', 'e.employeeNumber', 'e.branchId', 'e.departmentId', 'e.joiningDate', 'e.exitDate'])
      .orderBy('e.displayName').orderBy('e.id').limit(page.pageSize).offset(page.offset).execute();
    const empty: ShiftRosterDto = { month: q.month, from, to, dates, shifts: [], rows: [] };
    if (employees.length === 0) return { data: empty, total };
    const ids = employees.map((e) => e.id);

    return withSystemScope(trx, orgId, async (t) => {
      const [{ calendars }, policy, leave] = await Promise.all([
        loadEmployeeWorkingCalendars(t, orgId, ids, { from, to }),
        attendancePolicy(t, orgId),
        t.selectFrom('leaveRecords').select(['employeeId', 'startDate', 'endDate']).where('organizationId', '=', orgId).where('employeeId', 'in', ids).where('status', '=', 'APPROVED')
          .where('startDate', '<=', dv(to)).where('endDate', '>=', dv(from)).execute(),
      ]);
      const branchIds = [...new Set(employees.map((e) => e.branchId))];
      const departmentIds = [...new Set(employees.map((e) => e.departmentId).filter((x): x is string => !!x))];
      const [branchRows, departments] = await Promise.all([
        t.selectFrom('branches').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', branchIds).execute(),
        departmentIds.length ? t.selectFrom('departments').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', departmentIds).execute() : Promise.resolve([]),
      ]);
      const branchName = new Map(branchRows.map((b) => [b.id, b.name]));
      const departmentName = new Map(departments.map((d) => [d.id, d.name]));
      const defaultShiftId = policy.defaultShiftId ?? null;
      const inFilter = (placement: { branchId: string; departmentId: string | null }) =>
        (!branches || branches.includes(placement.branchId)) && (!q.departmentId || placement.departmentId === q.departmentId);

      const rows: RosterRowDto[] = [];
      const usedShifts = new Set<string>();
      for (const e of employees) {
        const calendar = calendars.get(e.id);
        const leaveRanges = leave.filter((l) => l.employeeId === e.id).map((l) => [isoDate(l.startDate), isoDate(l.endDate)] as const);
        const joined = isoDate(e.joiningDate);
        const exit = isoDateOrNull(e.exitDate);
        const days: Record<string, RosterDayDto> = {};
        for (const date of dates) {
          if (!calendar || date < joined || (exit && date > exit)) continue;
          const day = calendar.day(date);
          // the per-day filter: a day spent in a branch / department outside the filter (or the caller's scope) stays blank
          if (!inFilter(day.placement)) continue;
          const r = day.shift;
          const shiftId = r.shiftId ?? (r.isPatternOff ? null : defaultShiftId);
          if (shiftId) usedShifts.add(shiftId);
          days[date] = {
            shiftId,
            source: r.shiftId ? (r.source === 'PATTERN' ? 'PATTERN' : 'ASSIGNMENT') : r.isPatternOff ? 'PATTERN' : defaultShiftId ? 'DEFAULT' : 'NONE',
            isOff: day.weeklyOffDays.includes(dayOfWeek(date)),
            holidayName: day.holiday?.name ?? null,
            onLeave: leaveRanges.some(([s, en]) => s <= date && en >= date),
            branchId: day.placement.branchId,
          };
        }
        rows.push({ employeeId: e.id, employeeNumber: e.employeeNumber, employeeName: e.displayName, branchId: e.branchId, branchName: branchName.get(e.branchId) ?? null, departmentName: e.departmentId ? departmentName.get(e.departmentId) ?? null : null, days });
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
