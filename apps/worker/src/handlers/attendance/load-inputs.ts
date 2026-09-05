import { sql } from 'kysely';
import { attendanceRuleSetInputSchema, DEFAULT_ATTENDANCE_RULES, shiftBreakSchema, type AttendanceRules, type EmploymentStatus, type ShiftBreak } from '@flowza/contracts';
import { addDays, dayOfWeek, errors, isValidTimezone, localDateTime } from '@flowza/shared';
import type { Trx } from '@flowza/database';
import { resolveRuleSet, resolveShift, type DailyCalculationInput, type EngineEvent, type EngineHoliday, type EngineLeave, type EngineRuleSet, type EngineShift, type EngineShiftAssignment, type EngineShiftPattern, type EmployeeScope } from '@flowza/domain';
import { asArray, asDate, asObject, isoDate } from './common.js';
import { historyOn } from './normalize.js';

export interface LoadedDailyInputs {
  input: DailyCalculationInput;
  /** Effective branch / department on the date (employment history, fallback employee master). */
  branchId: string;
  departmentId: string | null;
  timezone: string;
  /** Source per event id, so the recompute can derive `has_correction` from the attributed events. */
  eventSources: Map<string, EngineEvent['source']>;
  leave: { id: string; isPaid: boolean } | null;
}

interface HistoryRow { branchId: string; departmentId: string | null; employmentStatus: EmploymentStatus; effectiveFrom: string; effectiveTo: string | null }

/** `time` columns arrive as `HH:mm:ss`; the engine speaks `HH:mm`. */
const hhmm = (t: string | null): string | null => (t === null ? null : t.slice(0, 5));

export function toEngineShift(row: { id: string; code: string; name: string; type: 'FIXED' | 'FLEXIBLE'; startTime: string | null; endTime: string | null; requiredMinutes: number | null; coreStart: string | null; coreEnd: string | null; dayBoundary: string; breaks: unknown; punchInWindowBeforeMinutes: number; punchOutWindowAfterMinutes: number; graceInMinutes: number | null; graceOutMinutes: number | null }): EngineShift {
  const breaks: ShiftBreak[] = [];
  for (const b of asArray(row.breaks)) {
    const parsed = shiftBreakSchema.safeParse(b);
    if (parsed.success) breaks.push(parsed.data);
  }
  return {
    id: row.id, code: String(row.code), name: row.name, type: row.type,
    startTime: hhmm(row.startTime), endTime: hhmm(row.endTime), requiredMinutes: row.requiredMinutes,
    coreStart: hhmm(row.coreStart), coreEnd: hhmm(row.coreEnd), dayBoundary: hhmm(row.dayBoundary) ?? '04:00', breaks,
    punchInWindowBeforeMinutes: row.punchInWindowBeforeMinutes, punchOutWindowAfterMinutes: row.punchOutWindowAfterMinutes,
    graceInMinutes: row.graceInMinutes, graceOutMinutes: row.graceOutMinutes,
  };
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

/** `ramadan_mode` jsonb tolerates the snake_case keys documented in the migration. */
export function normaliseRamadanMode(raw: unknown): Record<string, unknown> {
  const o = asObject(raw);
  const appliesTo = o['appliesTo'] ?? o['applies_to'];
  const out: Record<string, unknown> = { enabled: o['enabled'] === true, appliesTo: appliesTo === undefined || appliesTo === 'all' ? 'all' : 'flagged_employees' };
  const scheduled = o['scheduledMinutes'] ?? o['scheduled_minutes'];
  if (typeof scheduled === 'number') out['scheduledMinutes'] = scheduled;
  if (typeof o['from'] === 'string') out['from'] = o['from'].slice(0, 10);
  if (typeof o['to'] === 'string') out['to'] = o['to'].slice(0, 10);
  return out;
}

type RuleSetRow = Awaited<ReturnType<typeof loadRuleSetRows>>[number];
async function loadRuleSetRows(trx: Trx, organizationId: string, branchId: string) {
  return trx.selectFrom('attendanceRuleSets').selectAll().where('organizationId', '=', organizationId)
    .where((eb) => eb.or([eb('branchId', 'is', null), eb('branchId', '=', branchId)])).execute();
}

/** Map a rule set row onto `AttendanceRules`, validating through the shared contract schema (the DB constraints mirror it). */
export function toAttendanceRules(row: RuleSetRow): AttendanceRules {
  const parsed = attendanceRuleSetInputSchema.safeParse({
    name: row.name, effectiveFrom: isoDate(row.effectiveFrom), effectiveTo: row.effectiveTo === null ? null : isoDate(row.effectiveTo), branchId: row.branchId,
    graceInMinutes: row.graceInMinutes, graceOutMinutes: row.graceOutMinutes, lateThresholdMinutes: row.lateThresholdMinutes, earlyDepartureThresholdMinutes: row.earlyDepartureThresholdMinutes,
    minFullDayMinutes: row.minFullDayMinutes, halfDayThresholdMinutes: row.halfDayThresholdMinutes, overtimeEnabled: row.overtimeEnabled, overtimeStartAfterMinutes: row.overtimeStartAfterMinutes,
    overtimeMinBlockMinutes: row.overtimeMinBlockMinutes, overtimeRoundingMinutes: row.overtimeRoundingMinutes, overtimeMaxMinutesPerDay: row.overtimeMaxMinutesPerDay, countEarlyInAsOvertime: row.countEarlyInAsOvertime,
    punchRoundingMinutes: row.punchRoundingMinutes, punchRoundingMode: row.punchRoundingMode, workedRoundingMinutes: row.workedRoundingMinutes, workedRoundingMode: row.workedRoundingMode,
    punchInterpretation: row.punchInterpretation, duplicatePunchWindowSeconds: row.duplicatePunchWindowSeconds, missingPunchBehavior: row.missingPunchBehavior, autoAbsentWithoutPunches: row.autoAbsentWithoutPunches,
    weeklyOffWorkCountsAsOvertime: row.weeklyOffWorkCountsAsOvertime, holidayWorkCountsAsOvertime: row.holidayWorkCountsAsOvertime, ramadanMode: normaliseRamadanMode(row.ramadanMode),
  });
  if (!parsed.success) throw errors.validation('Attendance rule set is invalid.', { ruleSetId: row.id, issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  const { name: _n, branchId: _b, effectiveFrom: _f, effectiveTo: _t, ...rules } = parsed.data;
  return rules;
}

/**
 * Build the pure engine's input for one (employee, date): effective branch/department/timezone from employment history,
 * shift via `resolveShift` (employee > team > department > branch > organisation, plus D−1/D+1 for attribution), rule set via
 * `resolveRuleSet`, holidays from the branch (or default) calendar, approved leave, weekly-off (employee → branch → org),
 * non-voided events in `[D−1 00:00, D+2 00:00)` local. Returns null when the employee does not exist (or is deleted).
 */
export async function loadDailyInputs(trx: Trx, organizationId: string, employeeId: string, date: string, now: Date): Promise<LoadedDailyInputs | null> {
  const employee = await trx.selectFrom('employees')
    .select(['id', 'branchId', 'departmentId', 'joiningDate', 'exitDate', 'employmentStatus', 'weeklyOffDays', 'customFields', 'deletedAt'])
    .where('organizationId', '=', organizationId).where('id', '=', employeeId).executeTakeFirst();
  if (!employee || employee.deletedAt) return null;

  const historyRows = await trx.selectFrom('employmentHistory').select(['branchId', 'departmentId', 'employmentStatus', 'effectiveFrom', 'effectiveTo'])
    .where('organizationId', '=', organizationId).where('employeeId', '=', employeeId).orderBy('effectiveFrom', 'desc').execute();
  const history: HistoryRow[] = historyRows.map((h) => ({ branchId: h.branchId, departmentId: h.departmentId, employmentStatus: h.employmentStatus, effectiveFrom: isoDate(h.effectiveFrom), effectiveTo: h.effectiveTo === null ? null : isoDate(h.effectiveTo) }));
  const placement = (d: string): { branchId: string; departmentId: string | null; status: EmploymentStatus } => {
    const h = historyOn(history, d);
    return h ? { branchId: h.branchId, departmentId: h.departmentId, status: h.employmentStatus } : { branchId: employee.branchId, departmentId: employee.departmentId, status: employee.employmentStatus };
  };
  const today = placement(date);
  const previous = placement(addDays(date, -1));
  const next = placement(addDays(date, 1));

  const [org, branches, teamRows] = await Promise.all([
    trx.selectFrom('organizations').select(['weeklyOffDays', 'timezone']).where('id', '=', organizationId).executeTakeFirstOrThrow(),
    trx.selectFrom('branches').select(['id', 'timezone', 'weeklyOffDays', 'holidayCalendarId']).where('organizationId', '=', organizationId)
      .where('id', 'in', [...new Set([today.branchId, previous.branchId, next.branchId])]).execute(),
    trx.selectFrom('teamMembers').select('teamId').where('organizationId', '=', organizationId).where('employeeId', '=', employeeId).execute(),
  ]);
  const branch = branches.find((b) => b.id === today.branchId);
  if (!branch) throw errors.notFound('Branch', today.branchId);
  const timezone = isValidTimezone(branch.timezone) ? branch.timezone : isValidTimezone(org.timezone) ? org.timezone : 'UTC';
  const teamIds = teamRows.map((t) => t.teamId);

  // Shift resolution for D−1, D, D+1 (adjacent windows matter for cross-midnight attribution, §G.3).
  const branchIds = [...new Set([today.branchId, previous.branchId, next.branchId])];
  const departmentIds = [...new Set([today.departmentId, previous.departmentId, next.departmentId].filter((d): d is string => d !== null))];
  const assignmentRows = await trx.selectFrom('shiftAssignments').select(['id', 'targetType', 'targetId', 'shiftId', 'shiftPatternId', 'effectiveFrom', 'effectiveTo'])
    .where('organizationId', '=', organizationId)
    .where((eb) => eb.or([
      eb.and([eb('targetType', '=', 'EMPLOYEE'), eb('targetId', '=', employeeId)]),
      ...(teamIds.length ? [eb.and([eb('targetType', '=', 'TEAM'), eb('targetId', 'in', teamIds)])] : []),
      ...(departmentIds.length ? [eb.and([eb('targetType', '=', 'DEPARTMENT'), eb('targetId', 'in', departmentIds)])] : []),
      eb.and([eb('targetType', '=', 'BRANCH'), eb('targetId', 'in', branchIds)]),
      eb.and([eb('targetType', '=', 'ORGANIZATION'), eb('targetId', '=', organizationId)]),
    ]))
    .execute();
  const assignments: EngineShiftAssignment[] = assignmentRows.map((a) => ({ id: a.id, targetType: a.targetType, targetId: a.targetId, shiftId: a.shiftId, shiftPatternId: a.shiftPatternId, effectiveFrom: isoDate(a.effectiveFrom), effectiveTo: a.effectiveTo === null ? null : isoDate(a.effectiveTo) }));
  const patternIds = [...new Set(assignments.map((a) => a.shiftPatternId).filter((p): p is string => p !== null))];
  const patterns: EngineShiftPattern[] = patternIds.length
    ? (await trx.selectFrom('shiftPatterns').select(['id', 'cycleLengthDays', 'anchorDate', 'sequence']).where('organizationId', '=', organizationId).where('id', 'in', patternIds).execute()).map(toEnginePattern)
    : [];
  const scopeFor = (p: { branchId: string; departmentId: string | null }): EmployeeScope => ({ employeeId, teamIds, departmentId: p.departmentId, branchId: p.branchId, organizationId });
  const resolved = resolveShift(assignments, patterns, scopeFor(today), date);
  const resolvedPrev = resolveShift(assignments, patterns, scopeFor(previous), addDays(date, -1));
  const resolvedNext = resolveShift(assignments, patterns, scopeFor(next), addDays(date, 1));
  const shiftIds = [...new Set([resolved.shiftId, resolvedPrev.shiftId, resolvedNext.shiftId].filter((s): s is string => s !== null))];
  const shiftRows = shiftIds.length
    ? await trx.selectFrom('shifts').select(['id', 'code', 'name', 'type', 'startTime', 'endTime', 'requiredMinutes', 'coreStart', 'coreEnd', 'dayBoundary', 'breaks', 'punchInWindowBeforeMinutes', 'punchOutWindowAfterMinutes', 'graceInMinutes', 'graceOutMinutes'])
      .where('organizationId', '=', organizationId).where('id', 'in', shiftIds).execute()
    : [];
  const shifts = new Map(shiftRows.map((s) => [s.id, toEngineShift(s)]));
  const shiftOf = (id: string | null): EngineShift | null => (id === null ? null : shifts.get(id) ?? null);
  const shift = shiftOf(resolved.shiftId);

  // Rule set: branch-specific first, then organisation default (falls back to contract defaults when none is configured).
  const ruleSetRows = await loadRuleSetRows(trx, organizationId, today.branchId);
  const ruleSets: Array<EngineRuleSet & { row: RuleSetRow }> = ruleSetRows.map((r) => ({ id: r.id, branchId: r.branchId, effectiveFrom: isoDate(r.effectiveFrom), effectiveTo: r.effectiveTo === null ? null : isoDate(r.effectiveTo), rules: DEFAULT_ATTENDANCE_RULES, row: r }));
  const ruleSet = resolveRuleSet(ruleSets, date, today.branchId);
  const rules = ruleSet ? toAttendanceRules(ruleSet.row) : DEFAULT_ATTENDANCE_RULES;

  // Weekly off: employee → branch → organisation; a rotation pattern off-day counts as a weekly off for this date.
  let weeklyOffDays = (employee.weeklyOffDays ?? branch.weeklyOffDays ?? org.weeklyOffDays ?? []).map(Number);
  if (resolved.isPatternOff && !weeklyOffDays.includes(dayOfWeek(date))) weeklyOffDays = [...weeklyOffDays, dayOfWeek(date)];

  // Holidays from the branch calendar (or the organisation default calendar).
  let calendarId = branch.holidayCalendarId;
  if (!calendarId) calendarId = (await trx.selectFrom('holidayCalendars').select('id').where('organizationId', '=', organizationId).where('isDefault', '=', true).executeTakeFirst())?.id ?? null;
  let holiday: EngineHoliday | null = null;
  if (calendarId) {
    const h = await trx.selectFrom('holidays').select(['id', 'name', 'isHalfDay'])
      .where('organizationId', '=', organizationId).where('calendarId', '=', calendarId)
      .where('date', '<=', asDate(date))
      .where(sql<boolean>`coalesce(end_date, date) >= ${date}::date`)
      .where(sql<boolean>`(branch_ids is null or ${today.branchId}::uuid = any(branch_ids))`)
      .orderBy('isHalfDay', 'asc').orderBy('date', 'desc').orderBy('id', 'asc')
      .executeTakeFirst();
    if (h) holiday = { id: h.id, name: h.name, isHalfDay: h.isHalfDay };
  }

  // Approved leave covering the date.
  const leaveRow = await trx.selectFrom('leaveRecords as l').innerJoin('leaveTypes as t', 't.id', 'l.leaveTypeId')
    .select(['l.id', 'l.isHalfDay', 'l.halfDayPart', 't.code', 't.isPaid'])
    .where('l.organizationId', '=', organizationId).where('l.employeeId', '=', employeeId).where('l.status', '=', 'APPROVED')
    .where('l.startDate', '<=', asDate(date)).where('l.endDate', '>=', asDate(date))
    .orderBy('l.isHalfDay', 'asc').orderBy('l.createdAt', 'desc')
    .executeTakeFirst();
  const leave: EngineLeave | null = leaveRow ? { id: leaveRow.id, leaveTypeCode: String(leaveRow.code), isPaid: leaveRow.isPaid, isHalfDay: leaveRow.isHalfDay, halfDayPart: leaveRow.halfDayPart } : null;

  // Events in a generous window; the engine attributes them to punch windows.
  const windowStart = localDateTime(addDays(date, -1), '00:00', timezone).toJSDate();
  const windowEnd = localDateTime(addDays(date, 2), '00:00', timezone).toJSDate();
  const eventRows = await trx.selectFrom('attendanceEvents').select(['id', 'punchedAt', 'eventType', 'source', 'verificationMethod', 'deviceId', 'voidedAt'])
    .where('organizationId', '=', organizationId).where('employeeId', '=', employeeId)
    .where('punchedAt', '>=', windowStart).where('punchedAt', '<', windowEnd)
    .orderBy('punchedAt', 'asc').orderBy('id', 'asc').execute();
  const eventSources = new Map<string, EngineEvent['source']>();
  const events: EngineEvent[] = eventRows.map((e) => {
    eventSources.set(e.id, e.source);
    return { id: e.id, punchedAt: (e.punchedAt instanceof Date ? e.punchedAt : new Date(e.punchedAt)).toISOString(), eventType: e.eventType, source: e.source, verificationMethod: e.verificationMethod, deviceId: e.deviceId, voided: e.voidedAt !== null };
  });

  const input: DailyCalculationInput = {
    employeeId,
    attendanceDate: date,
    timezone,
    shift,
    rules,
    ruleSetId: ruleSet?.id ?? null,
    shiftAssignmentId: resolved.assignment?.id ?? null,
    weeklyOffDays,
    holiday,
    leave,
    events,
    employment: { joiningDate: isoDate(employee.joiningDate), exitDate: employee.exitDate === null ? null : isoDate(employee.exitDate), status: today.status },
    ramadanEligible: asObject(employee.customFields)['ramadanEligible'] === true,
    now: now.toISOString(),
    adjacentShifts: { previous: shiftOf(resolvedPrev.shiftId), next: shiftOf(resolvedNext.shiftId) },
  };
  return { input, branchId: today.branchId, departmentId: today.departmentId, timezone, eventSources, leave: leave ? { id: leave.id, isPaid: leave.isPaid } : null };
}
