import { sql } from 'kysely';
import { DateTime } from 'luxon';
import type { EmploymentStatus } from '@flowza/contracts';
import { dayOfWeek } from '@flowza/shared';
import { resolveShift, type EmployeeScope, type EngineHoliday, type EngineShiftAssignment, type EngineShiftPattern, type ResolvedShiftDetail, type WorkingCalendar } from '@flowza/domain';
import type { Trx } from '../context.js';

/*
 * THE per-date working calendar (leave v2 review P1-1 / P1-2) — one resolver shared by the attendance input loader
 * (`loadDailyInputs`), leave day counting (`loadWorkingCalendars`: the apply / edit / HR record paths and every figure read
 * from stored leave), the balance function and the comp-off preview. For each date it answers exactly what the attendance
 * engine uses:
 *
 *   placement     the branch / department / status in force on the date: the `employment_history` row with the latest
 *                 `effective_from` on or before it, else the employee record (the rule of `effectiveBranchIdOn`);
 *   weekly offs   employee → branch (of that date's placement) → organisation, plus the date's weekday when the employee's
 *                 rotation pattern is off on it (`resolveShift` → `isPatternOff`);
 *   holiday       the holiday calendar of that date's branch (else the organisation's default calendar), branch-limited
 *                 holidays honoured — the first by (full day before half day, latest start, id);
 *   off           a weekly off (incl. a rotation off day) or a holiday: a date leave does not charge (a half-day holiday
 *                 included, as before) and comp-off can be earned on.
 *
 * Bulk: one query per table for any number of employees; dates resolve lazily (memoised). Holidays are loaded for the
 * window only; shift assignments / patterns / history are loaded whole. Runs under the caller's context — the history and
 * branches are branch-scoped by RLS, so readers that authorised the employee first load it in the organisation's system
 * scope (as the balance readers do).
 */

export interface DayPlacement { branchId: string; departmentId: string | null; status: EmploymentStatus }

export interface WorkingDay {
  date: string;
  placement: DayPlacement;
  /** Weekly off days of the date (0=Sun..6=Sat): the placement's weekly offs plus the date's weekday on a rotation off day. */
  weeklyOffDays: number[];
  /** The resolved shift assignment of the date (null shift = none assigned or a rotation off day). */
  shift: ResolvedShiftDetail;
  holiday: EngineHoliday | null;
  /** A weekly off (incl. a rotation off day) or a holiday. */
  off: boolean;
}

export interface CalendarBranch { id: string; timezone: string; weeklyOffDays: number[] | null; holidayCalendarId: string | null }

export interface EmployeeWorkingCalendar {
  employeeId: string;
  /** The employee record's own placement (current branch / department / status). */
  master: DayPlacement;
  /** Resolve one date (memoised). Holidays are known inside the loaded window only. */
  day(date: string): WorkingDay;
  /**
   * The leave-counting view: domain `WorkingCalendar` with the per-date `isOff`. `weeklyOffDays` are those of the current
   * placement and `holidays` every holiday date of the window (per-date placement) — display for older clients.
   */
  calendar: WorkingCalendar;
  /** Every non-working date of the window (the per-date view the portal's apply form counts with). */
  offDates(): string[];
}

export interface WorkingCalendarContext {
  organization: { weeklyOffDays: number[] | null; timezone: string };
  branches: ReadonlyMap<string, CalendarBranch>;
  window: { from: string; to: string };
}

interface HistoryRow extends DayPlacement { effectiveFrom: string }
interface HolidayRow { id: string; calendarId: string; name: string; isHalfDay: boolean; date: string; endDate: string | null; branchIds: string[] | null }

/** `date` columns arrive as JS Dates built from local components (pg-types) or as `YYYY-MM-DD` strings. */
function isoDate(v: Date | string): string {
  if (typeof v === 'string') return v.slice(0, 10);
  return DateTime.fromJSDate(v).toISODate() ?? v.toISOString().slice(0, 10);
}
const nums = (v: unknown): number[] | null => (Array.isArray(v) ? v.map(Number) : null);
function asObject(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') { try { return asObject(JSON.parse(v)); } catch { return {}; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  if (typeof v === 'string') { try { return asArray(JSON.parse(v)); } catch { return []; } }
  return Array.isArray(v) ? v : [];
}

/** `shift_patterns.sequence` is stored as `[{"day":0,"shift_id":"…"},{"day":3,"off":true}]` (snake or camel case). */
export function toEnginePattern(row: { id: string; cycleLengthDays: number; anchorDate: Date | string; sequence: unknown }): EngineShiftPattern {
  const sequence: EngineShiftPattern['sequence'] = [];
  for (const raw of asArray(row.sequence)) {
    const o = asObject(raw);
    const day = Number(o['day']);
    if (!Number.isInteger(day)) continue;
    const shiftId = o['shiftId'] ?? o['shift_id'];
    if (o['off'] === true || typeof shiftId !== 'string') sequence.push({ day, off: true });
    else sequence.push({ day, shiftId });
  }
  return { id: row.id, cycleLengthDays: row.cycleLengthDays, anchorDate: isoDate(row.anchorDate), sequence };
}

/** The history row in force on `date` under the rule of `effectiveBranchIdOn`: the latest `effectiveFrom` on or before it. */
export function historyRowOn<T extends { effectiveFrom: string }>(rows: readonly T[], date: string): T | undefined {
  let best: T | undefined;
  for (const r of rows) if (r.effectiveFrom <= date && (best === undefined || r.effectiveFrom > best.effectiveFrom)) best = r;
  return best;
}

function* eachDate(from: string, to: string): Generator<string> {
  let d = DateTime.fromISO(from, { zone: 'utc' });
  const end = DateTime.fromISO(to, { zone: 'utc' });
  if (!d.isValid || !end.isValid) return;
  for (; d <= end; d = d.plus({ days: 1 })) yield d.toISODate()!;
}

/**
 * Per-date working calendars of several employees for a window (inclusive `YYYY-MM-DD` dates). Unknown employees are
 * absent from the map; deleted employees are included (history stays readable).
 */
export async function loadEmployeeWorkingCalendars(trx: Trx, organizationId: string, employeeIds: readonly string[], window: { from: string; to: string }): Promise<{ calendars: Map<string, EmployeeWorkingCalendar>; context: WorkingCalendarContext }> {
  const ids = [...new Set(employeeIds)];
  const [org, employees, historyRows, teamRows, defaultCalendar] = await Promise.all([
    trx.selectFrom('organizations').select(['weeklyOffDays', 'timezone']).where('id', '=', organizationId).executeTakeFirst(),
    ids.length ? trx.selectFrom('employees').select(['id', 'branchId', 'departmentId', 'employmentStatus', 'weeklyOffDays']).where('organizationId', '=', organizationId).where('id', 'in', ids).execute() : Promise.resolve([]),
    ids.length ? trx.selectFrom('employmentHistory').select(['employeeId', 'branchId', 'departmentId', 'employmentStatus', 'effectiveFrom']).where('organizationId', '=', organizationId).where('employeeId', 'in', ids).execute() : Promise.resolve([]),
    ids.length ? trx.selectFrom('teamMembers').select(['employeeId', 'teamId']).where('organizationId', '=', organizationId).where('employeeId', 'in', ids).execute() : Promise.resolve([]),
    trx.selectFrom('holidayCalendars').select('id').where('organizationId', '=', organizationId).where('isDefault', '=', true).executeTakeFirst(),
  ]);
  const historyByEmployee = new Map<string, HistoryRow[]>();
  for (const h of historyRows) {
    const list = historyByEmployee.get(h.employeeId) ?? [];
    list.push({ branchId: h.branchId, departmentId: h.departmentId, status: h.employmentStatus, effectiveFrom: isoDate(h.effectiveFrom) });
    historyByEmployee.set(h.employeeId, list);
  }
  const teamsByEmployee = new Map<string, string[]>();
  for (const t of teamRows) teamsByEmployee.set(t.employeeId, [...(teamsByEmployee.get(t.employeeId) ?? []), t.teamId]);
  const branchIds = [...new Set([...employees.map((e) => e.branchId), ...historyRows.map((h) => h.branchId)])];
  const departmentIds = [...new Set([...employees.map((e) => e.departmentId), ...historyRows.map((h) => h.departmentId)].filter((d): d is string => d !== null))];
  const teamIds = [...new Set(teamRows.map((t) => t.teamId))];

  const [branchRows, assignmentRows] = await Promise.all([
    branchIds.length ? trx.selectFrom('branches').select(['id', 'timezone', 'weeklyOffDays', 'holidayCalendarId']).where('organizationId', '=', organizationId).where('id', 'in', branchIds).execute() : Promise.resolve([]),
    ids.length ? trx.selectFrom('shiftAssignments').select(['id', 'targetType', 'targetId', 'shiftId', 'shiftPatternId', 'effectiveFrom', 'effectiveTo'])
      .where('organizationId', '=', organizationId)
      .where((eb) => eb.or([
        eb.and([eb('targetType', '=', 'EMPLOYEE'), eb('targetId', 'in', ids)]),
        ...(teamIds.length ? [eb.and([eb('targetType', '=', 'TEAM'), eb('targetId', 'in', teamIds)])] : []),
        ...(departmentIds.length ? [eb.and([eb('targetType', '=', 'DEPARTMENT'), eb('targetId', 'in', departmentIds)])] : []),
        ...(branchIds.length ? [eb.and([eb('targetType', '=', 'BRANCH'), eb('targetId', 'in', branchIds)])] : []),
        eb.and([eb('targetType', '=', 'ORGANIZATION'), eb('targetId', '=', organizationId)]),
      ]))
      .execute() : Promise.resolve([]),
  ]);
  const branches = new Map<string, CalendarBranch>(branchRows.map((b) => [b.id, { id: b.id, timezone: b.timezone, weeklyOffDays: nums(b.weeklyOffDays), holidayCalendarId: b.holidayCalendarId }]));
  const assignments: EngineShiftAssignment[] = assignmentRows.map((a) => ({ id: a.id, targetType: a.targetType, targetId: a.targetId, shiftId: a.shiftId, shiftPatternId: a.shiftPatternId, effectiveFrom: isoDate(a.effectiveFrom), effectiveTo: a.effectiveTo === null ? null : isoDate(a.effectiveTo) }));
  const patternIds = [...new Set(assignments.map((a) => a.shiftPatternId).filter((p): p is string => p !== null))];
  const calendarIds = [...new Set([...branchRows.map((b) => b.holidayCalendarId), defaultCalendar?.id ?? null].filter((c): c is string => !!c))];
  const [patternRows, holidayRows] = await Promise.all([
    patternIds.length ? trx.selectFrom('shiftPatterns').select(['id', 'cycleLengthDays', 'anchorDate', 'sequence']).where('organizationId', '=', organizationId).where('id', 'in', patternIds).execute() : Promise.resolve([]),
    calendarIds.length ? trx.selectFrom('holidays').select(['id', 'calendarId', 'name', 'isHalfDay', 'date', 'endDate', 'branchIds']).where('organizationId', '=', organizationId).where('calendarId', 'in', calendarIds)
      .where('date', '<=', sql<Date>`${window.to}::date`).where(sql<boolean>`coalesce(end_date, date) >= ${window.from}::date`).execute() : Promise.resolve([]),
  ]);
  const patterns: EngineShiftPattern[] = patternRows.map(toEnginePattern);
  // holidays by calendar and date (a multi-day holiday on each of its dates inside the window), in the engine's order:
  // full day before half day, the latest start, then id
  const holidaysByCalendarDate = new Map<string, HolidayRow[]>();
  const holidays: HolidayRow[] = holidayRows.map((h) => ({ id: h.id, calendarId: h.calendarId, name: h.name, isHalfDay: h.isHalfDay, date: isoDate(h.date), endDate: h.endDate === null ? null : isoDate(h.endDate), branchIds: h.branchIds }));
  holidays.sort((a, b) => Number(a.isHalfDay) - Number(b.isHalfDay) || b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  for (const h of holidays) {
    const from = h.date < window.from ? window.from : h.date;
    const last = h.endDate ?? h.date;
    const to = last > window.to ? window.to : last;
    for (const d of eachDate(from, to)) {
      const key = `${h.calendarId}|${d}`;
      holidaysByCalendarDate.set(key, [...(holidaysByCalendarDate.get(key) ?? []), h]);
    }
  }
  const orgWeeklyOff = nums(org?.weeklyOffDays);
  const context: WorkingCalendarContext = { organization: { weeklyOffDays: orgWeeklyOff, timezone: org?.timezone ?? 'UTC' }, branches, window };

  const calendars = new Map<string, EmployeeWorkingCalendar>();
  for (const e of employees) {
    const history = historyByEmployee.get(e.id) ?? [];
    const master: DayPlacement = { branchId: e.branchId, departmentId: e.departmentId, status: e.employmentStatus };
    const employeeWeeklyOff = nums(e.weeklyOffDays);
    const employeeTeams = teamsByEmployee.get(e.id) ?? [];
    const memo = new Map<string, WorkingDay>();
    const day = (date: string): WorkingDay => {
      const hit = memo.get(date);
      if (hit) return hit;
      const h = historyRowOn(history, date);
      const placement: DayPlacement = h ? { branchId: h.branchId, departmentId: h.departmentId, status: h.status } : master;
      const branch = branches.get(placement.branchId);
      const scope: EmployeeScope = { employeeId: e.id, teamIds: employeeTeams, departmentId: placement.departmentId, branchId: placement.branchId, organizationId };
      const shift = resolveShift(assignments, patterns, scope, date);
      const weekday = dayOfWeek(date);
      let weeklyOffDays = employeeWeeklyOff ?? branch?.weeklyOffDays ?? orgWeeklyOff ?? [];
      if (shift.isPatternOff && !weeklyOffDays.includes(weekday)) weeklyOffDays = [...weeklyOffDays, weekday];
      const calendarId = branch?.holidayCalendarId ?? defaultCalendar?.id ?? null;
      const h0 = calendarId ? (holidaysByCalendarDate.get(`${calendarId}|${date}`) ?? []).find((x) => !x.branchIds || x.branchIds.includes(placement.branchId)) : undefined;
      const holiday: EngineHoliday | null = h0 ? { id: h0.id, name: h0.name, isHalfDay: h0.isHalfDay } : null;
      const resolved: WorkingDay = { date, placement, weeklyOffDays, shift, holiday, off: weeklyOffDays.includes(weekday) || holiday !== null };
      memo.set(date, resolved);
      return resolved;
    };
    // display fields of the counting view: the current placement's weekly offs and the window's holiday dates (per-date
    // placement, no shift resolution needed)
    const holidayDateSet = new Set<string>();
    for (const d of eachDate(window.from, window.to)) {
      const h = historyRowOn(history, d);
      const branchId = h ? h.branchId : master.branchId;
      const calendarId = branches.get(branchId)?.holidayCalendarId ?? defaultCalendar?.id ?? null;
      if (calendarId && (holidaysByCalendarDate.get(`${calendarId}|${d}`) ?? []).some((x) => !x.branchIds || x.branchIds.includes(branchId))) holidayDateSet.add(d);
    }
    const currentWeeklyOff = employeeWeeklyOff ?? branches.get(master.branchId)?.weeklyOffDays ?? orgWeeklyOff ?? [];
    calendars.set(e.id, {
      employeeId: e.id,
      master,
      day,
      calendar: { weeklyOffDays: currentWeeklyOff, holidays: holidayDateSet, isOff: (date: string) => day(date).off },
      offDates: () => { const out: string[] = []; for (const d of eachDate(window.from, window.to)) if (day(d).off) out.push(d); return out; },
    });
  }
  return { calendars, context };
}
