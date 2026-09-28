import type { SelfShiftDayDto, SelfShiftSummaryDto } from '@flowza/contracts';
import { effectiveBranchIdOn, type Trx } from '@flowza/database';
import { holidayDates, resolveShift, type EngineShiftAssignment, type EngineShiftPattern } from '@flowza/domain';
import { dayOfWeek, eachDate } from '@flowza/shared';
import { isoDate, isoDateOrNull, jsonArray } from '../../lib/mappers.js';
import { withSystemScope } from '../../lib/service.js';
import { dv } from '../features/sql-helpers.js';
import { type EmployeeCtx, attendancePolicy } from './common.js';

/**
 * Which shift an employee works on given dates (HR portal Prompt 4: the portal's shift tab, swap validation and the swap
 * hook): the engine's own resolution (`resolveShift` — most specific assignment, rotation patterns) with the organisation's
 * default shift where nothing resolves, plus the day's weekly off (employee → branch → organisation, pattern off days),
 * holiday and approved leave. Read in the organisation's system scope for an already authorised employee (an employee's
 * role cannot read shifts or assignments).
 *
 * Every date is resolved with the branch EFFECTIVE on that date (employment history — `effectiveBranchIdOn`, review P2-13),
 * the way the engine and `GET /shifts/resolve` do: a future-dated transfer updates `employees.branch_id` at once, but the days
 * before the transfer keep the old branch's assignments, weekly offs and holidays. Department and teams are the current ones
 * (employment history does not carry teams).
 */
export interface ResolvedDay extends Omit<SelfShiftDayDto, 'swap'> { shiftId: string | null; assignmentId: string | null; assignmentTarget: string | null }

type ShiftRow = { id: string; code: string; name: string; type: string; startTime: string | null; endTime: string | null; requiredMinutes: number | null; graceInMinutes: number | null; crossesMidnight: boolean | null; color: string | null; breaks: unknown };

const hhmm = (v: string | null) => (v === null ? null : v.slice(0, 5));
const minutes = (hm: string) => { const [h, m] = hm.split(':'); return Number(h) * 60 + Number(m); };
function breakMinutes(raw: unknown): number {
  let total = 0;
  for (const b of jsonArray<Record<string, unknown>>(raw)) {
    if (typeof b['minutes'] === 'number') total += b['minutes'];
    else if (typeof b['start'] === 'string' && typeof b['end'] === 'string') { const d = minutes(b['end']) - minutes(b['start']); total += d >= 0 ? d : d + 1440; }
  }
  return total;
}
export function toShiftSummary(s: ShiftRow): SelfShiftSummaryDto {
  const start = hhmm(s.startTime); const end = hhmm(s.endTime);
  return {
    id: s.id, code: s.code, name: s.name, type: s.type === 'FLEXIBLE' ? 'FLEXIBLE' : 'FIXED', startTime: start, endTime: end, requiredMinutes: s.requiredMinutes, graceInMinutes: s.graceInMinutes,
    crossesMidnight: s.crossesMidnight ?? (start !== null && end !== null && end <= start), color: s.color, breakMinutes: breakMinutes(s.breaks),
  };
}

export async function loadShifts(t: Trx, orgId: string, ids: readonly string[]): Promise<Map<string, ShiftRow>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await t.selectFrom('shifts').select(['id', 'code', 'name', 'type', 'startTime', 'endTime', 'requiredMinutes', 'graceInMinutes', 'crossesMidnight', 'color', 'breaks']).where('organizationId', '=', orgId).where('id', 'in', unique).execute();
  return new Map(rows.map((r) => [r.id, r as ShiftRow]));
}

/** One employee over [from, to] (inclusive; at most a year). */
export async function resolveDays(trx: Trx, orgId: string, emp: EmployeeCtx, from: string, to: string): Promise<ResolvedDay[]> {
  const dates = eachDate(from, to).slice(0, 366);
  if (dates.length === 0) return [];
  return withSystemScope(trx, orgId, async (t) => {
    const branchOn = new Map<string, string>();
    for (const date of dates) branchOn.set(date, (await effectiveBranchIdOn(t, orgId, emp.id, date)) ?? emp.branchId);
    const branchIds = [...new Set(branchOn.values())];
    const [branchRows, defaultCalendar] = await Promise.all([
      t.selectFrom('branches').select(['id', 'weeklyOffDays', 'holidayCalendarId']).where('organizationId', '=', orgId).where('id', 'in', branchIds).execute(),
      t.selectFrom('holidayCalendars').select('id').where('organizationId', '=', orgId).where('isDefault', '=', true).executeTakeFirst(),
    ]);
    const branchById = new Map(branchRows.map((b) => [b.id, b]));
    const calendarOf = (branchId: string): string | null => branchById.get(branchId)?.holidayCalendarId ?? defaultCalendar?.id ?? null;
    const calendarIds = [...new Set(branchIds.map(calendarOf).filter((x): x is string => !!x))];
    const [assignmentRows, patternRows, policy, holidays, leave] = await Promise.all([
      t.selectFrom('shiftAssignments').select(['id', 'targetType', 'targetId', 'shiftId', 'shiftPatternId', 'effectiveFrom', 'effectiveTo']).where('organizationId', '=', orgId)
        .where('effectiveFrom', '<=', dv(to)).where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', dv(from))])).execute(),
      t.selectFrom('shiftPatterns').select(['id', 'cycleLengthDays', 'anchorDate', 'sequence']).where('organizationId', '=', orgId).execute(),
      attendancePolicy(t, orgId),
      calendarIds.length ? t.selectFrom('holidays').select(['calendarId', 'date', 'endDate', 'name', 'branchIds']).where('organizationId', '=', orgId).where('calendarId', 'in', calendarIds)
        .where('date', '<=', dv(to)).where((eb) => eb.or([eb('endDate', '>=', dv(from)), eb.and([eb('endDate', 'is', null), eb('date', '>=', dv(from))])])).execute() : Promise.resolve([]),
      t.selectFrom('leaveRecords').select(['startDate', 'endDate']).where('organizationId', '=', orgId).where('employeeId', '=', emp.id).where('status', '=', 'APPROVED')
        .where('startDate', '<=', dv(to)).where('endDate', '>=', dv(from)).execute(),
    ]);
    const assignments: EngineShiftAssignment[] = assignmentRows.map((a) => ({ id: a.id, targetType: a.targetType, targetId: a.targetId, shiftId: a.shiftId, shiftPatternId: a.shiftPatternId, effectiveFrom: isoDate(a.effectiveFrom), effectiveTo: isoDateOrNull(a.effectiveTo) }));
    const patterns: EngineShiftPattern[] = patternRows.map((p) => ({ id: p.id, cycleLengthDays: p.cycleLengthDays, anchorDate: isoDate(p.anchorDate), sequence: jsonArray(p.sequence) as EngineShiftPattern['sequence'] }));
    // a holiday applies on a date when it is in the calendar of the branch effective that day and covers that branch
    const holidayOn = (date: string): string | null => {
      const branchId = branchOn.get(date)!;
      const calendarId = calendarOf(branchId);
      for (const h of holidays) {
        if (h.calendarId !== calendarId || (h.branchIds && !h.branchIds.includes(branchId))) continue;
        if (holidayDates([{ date: isoDate(h.date), endDate: isoDateOrNull(h.endDate) }]).has(date)) return h.name;
      }
      return null;
    };
    const leaveOn = (d: string) => leave.some((l) => isoDate(l.startDate) <= d && isoDate(l.endDate) >= d);
    const nums = (v: unknown): number[] | null => (Array.isArray(v) ? v.map(Number) : null);
    // weekly offs: the employee's own, else the branch effective that day, else the organisation's (the engine's precedence)
    const weeklyOffOn = (date: string): number[] => emp.weeklyOffDays ?? nums(branchById.get(branchOn.get(date)!)?.weeklyOffDays) ?? emp.orgWeeklyOffDays;
    const scopeOn = (date: string) => ({ employeeId: emp.id, teamIds: emp.teamIds, departmentId: emp.departmentId, branchId: branchOn.get(date)!, organizationId: orgId });
    const defaultShiftId = policy.defaultShiftId ?? null;
    const resolved = dates.map((date) => ({ date, r: resolveShift(assignments, patterns, scopeOn(date), date) }));
    const shiftIds = resolved.map(({ r }) => r.shiftId ?? (r.isPatternOff ? null : defaultShiftId)).filter((x): x is string => !!x);
    const shifts = await loadShifts(t, orgId, shiftIds);
    return resolved.map(({ date, r }): ResolvedDay => {
      const source: ResolvedDay['source'] = r.shiftId ? (r.source === 'PATTERN' ? 'PATTERN' : 'ASSIGNMENT') : r.isPatternOff ? 'PATTERN' : defaultShiftId ? 'DEFAULT' : 'NONE';
      const shiftId = r.shiftId ?? (r.isPatternOff ? null : defaultShiftId);
      const shift = shiftId ? shifts.get(shiftId) : undefined;
      return {
        date, shift: shift ? toShiftSummary(shift) : null, shiftId: shift ? shift.id : null, source, isOff: r.isPatternOff || weeklyOffOn(date).includes(dayOfWeek(date)),
        holidayName: holidayOn(date), onLeave: leaveOn(date), assignmentId: r.assignment?.id ?? null, assignmentTarget: r.assignment?.targetType ?? null,
      };
    });
  });
}

/** A day on which the employee is expected at work on a shift (swap eligibility). */
export const worksShift = (d: ResolvedDay): boolean => !!d.shiftId && !d.isOff && !d.onLeave && !d.holidayName;
