import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { attendanceRuleSetInputSchema, DEFAULT_ATTENDANCE_RULES, resolveAttendanceSettings, shiftBreakSchema, type AttendanceRules, type AttendanceSettings, type ShiftBreak } from '@flowza/contracts';
import { addDays, errors, isValidTimezone, localDateTime } from '@flowza/shared';
import { resolveRuleSet, type DailyCalculationInput, type EngineDayMark, type EngineEvent, type EngineHoliday, type EngineLeave, type EnginePunchPayload, type EngineRuleSet, type EngineShift } from '@flowza/domain';
import type { Trx } from '../context.js';
import { activeMarksOn } from './day-marks.js';
import { loadEmployeeWorkingCalendars } from './working-calendar.js';

/*
 * The pure engine's input for one (employee, date), loaded from the database. Moved here from the worker
 * (apps/worker/src/handlers/attendance/load-inputs.ts, which re-exports it) in HR portal Prompt 6a so the API's record
 * preview (POST /attendance/preview) runs the engine on EXACTLY the inputs the recompute uses — one loader, no drift.
 * Runs under whatever context the caller's transaction carries: the worker's system context, or the API caller's RLS.
 */

// Small coercion helpers (the worker's attendance/common.ts keeps its own copies for its other handlers).
function asObject(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') { try { return asObject(JSON.parse(v)); } catch { return {}; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  if (typeof v === 'string') { try { return asArray(JSON.parse(v)); } catch { return []; } }
  return Array.isArray(v) ? v : [];
}
/** `date` columns arrive as JS Dates built from local components (pg-types) or as `YYYY-MM-DD` strings. */
function isoDate(v: Date | string): string {
  if (typeof v === 'string') return v.slice(0, 10);
  return DateTime.fromJSDate(v).toISODate() ?? v.toISOString().slice(0, 10);
}
const asDate = (date: string) => sql<Date>`${date}::date`;
/** The organisation's effective attendance settings (`organization_settings.attendance`, defaults filled in; never throws). */
async function loadAttendanceSettings(trx: Trx, organizationId: string): Promise<AttendanceSettings> {
  const row = await trx.selectFrom('organizationSettings').select('attendance').where('organizationId', '=', organizationId).executeTakeFirst();
  return resolveAttendanceSettings(asObject(row?.attendance));
}

/**
 * The self-service facts of a raw punch payload (written by the check-in endpoint of Prompt 4), read defensively: only the
 * known keys with the expected shapes are passed to the engine, so a vendor payload that happens to carry a `channel`
 * key of its own cannot flag a device punch as self-service. Returns null when the payload says nothing the engine reads.
 */
export function punchPayloadOf(raw: unknown): EnginePunchPayload | null {
  const o = asObject(raw);
  if (Object.keys(o).length === 0) return null;
  const out: EnginePunchPayload = {};
  if (o['channel'] === 'web' || o['channel'] === 'mobile') out.channel = o['channel'];
  const verdict = o['geofenceVerdict'] ?? o['geofence_verdict'] ?? o['verdict'];
  if (typeof verdict === 'string' && verdict.length > 0 && verdict.length <= 40) out.geofenceVerdict = verdict;
  if (o['isMock'] === true || o['is_mock'] === true) out.isMock = true;
  if (o['outOfWindow'] === true || o['out_of_window'] === true) out.outOfWindow = true;
  return Object.keys(out).length === 0 ? null : out;
}

export interface LoadedDailyInputs {
  input: DailyCalculationInput;
  /** Effective branch / department on the date (employment history, fallback employee master). */
  branchId: string;
  departmentId: string | null;
  timezone: string;
  /** Source per event id, so the recompute can derive `has_correction` from the attributed events. */
  eventSources: Map<string, EngineEvent['source']>;
  leave: { id: string; isPaid: boolean } | null;
  /** The organisation's effective attendance settings (defaults filled in). */
  settings: AttendanceSettings;
}

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

// The rotation-pattern mapper moved to the per-date working calendar (leave v2 review P1-1); re-exported for existing importers.
export { toEnginePattern } from './working-calendar.js';

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
    .select(['id', 'joiningDate', 'exitDate', 'customFields', 'deletedAt'])
    .where('organizationId', '=', organizationId).where('id', '=', employeeId).executeTakeFirst();
  if (!employee || employee.deletedAt) return null;

  // Placement, shift assignment, weekly offs and the holiday of D−1, D and D+1 come from THE per-date working calendar
  // (leave v2 review P1-1 / P1-2): leave day counting, balances and the comp-off preview read the same resolver, so leave
  // and attendance agree on every date — the branch in force on the date (employment history), its weekly offs and holiday
  // calendar, and a rotation pattern's off days.
  const [{ calendars, context }, settings] = await Promise.all([
    loadEmployeeWorkingCalendars(trx, organizationId, [employeeId], { from: addDays(date, -1), to: addDays(date, 1) }),
    loadAttendanceSettings(trx, organizationId),
  ]);
  const calendar = calendars.get(employeeId);
  if (!calendar) return null;
  const day = calendar.day(date);
  const today = day.placement;
  const branch = context.branches.get(today.branchId);
  if (!branch) throw errors.notFound('Branch', today.branchId);
  const orgTimezone = context.organization.timezone;
  const timezone = isValidTimezone(branch.timezone) ? branch.timezone : isValidTimezone(orgTimezone) ? orgTimezone : 'UTC';

  // Shift resolution for D−1, D, D+1 (adjacent windows matter for cross-midnight attribution, §G.3).
  const resolved = day.shift;
  const resolvedPrev = calendar.day(addDays(date, -1)).shift;
  const resolvedNext = calendar.day(addDays(date, 1)).shift;
  // `settings.attendance.defaultShiftId` applies wherever no assignment resolves (today and the neighbouring dates) — it is an
  // organisation-wide fallback, not an assignment, so `shiftAssignmentId` stays null. A rotation pattern's off day resolves
  // to "no shift on purpose" and must not fall back either.
  const defaultShiftId = settings.defaultShiftId ?? null;
  const effectiveShiftId = (r: { shiftId: string | null; isPatternOff: boolean }): string | null => r.shiftId ?? (r.isPatternOff ? null : defaultShiftId);
  const shiftIds = [...new Set([effectiveShiftId(resolved), effectiveShiftId(resolvedPrev), effectiveShiftId(resolvedNext)].filter((s): s is string => s !== null))];
  const shiftRows = shiftIds.length
    ? await trx.selectFrom('shifts').select(['id', 'code', 'name', 'type', 'startTime', 'endTime', 'requiredMinutes', 'coreStart', 'coreEnd', 'dayBoundary', 'breaks', 'punchInWindowBeforeMinutes', 'punchOutWindowAfterMinutes', 'graceInMinutes', 'graceOutMinutes'])
      .where('organizationId', '=', organizationId).where('id', 'in', shiftIds).execute()
    : [];
  const shifts = new Map(shiftRows.map((s) => [s.id, toEngineShift(s)]));
  // an unknown (deleted) default shift silently resolves to "no shift" (the engine flags NO_SHIFT) rather than failing the day
  const shiftOf = (id: string | null): EngineShift | null => (id === null ? null : shifts.get(id) ?? null);
  const shift = shiftOf(effectiveShiftId(resolved));

  // Rule set: branch-specific first, then organisation default (falls back to contract defaults when none is configured).
  const ruleSetRows = await loadRuleSetRows(trx, organizationId, today.branchId);
  const ruleSets: Array<EngineRuleSet & { row: RuleSetRow }> = ruleSetRows.map((r) => ({ id: r.id, branchId: r.branchId, effectiveFrom: isoDate(r.effectiveFrom), effectiveTo: r.effectiveTo === null ? null : isoDate(r.effectiveTo), rules: DEFAULT_ATTENDANCE_RULES, row: r }));
  const ruleSet = resolveRuleSet(ruleSets, date, today.branchId);
  const rules = ruleSet ? toAttendanceRules(ruleSet.row) : DEFAULT_ATTENDANCE_RULES;

  // Weekly off: employee → branch → organisation; a rotation pattern off-day counts as a weekly off for this date. Holiday:
  // the branch calendar (or the organisation default calendar). Both from the per-date working calendar above.
  const weeklyOffDays = day.weeklyOffDays;
  const holiday: EngineHoliday | null = day.holiday;

  // Approved leave covering the date.
  const leaveRow = await trx.selectFrom('leaveRecords as l').innerJoin('leaveTypes as t', 't.id', 'l.leaveTypeId')
    .select(['l.id', 'l.isHalfDay', 'l.halfDayPart', 't.code', 't.isPaid'])
    .where('l.organizationId', '=', organizationId).where('l.employeeId', '=', employeeId).where('l.status', '=', 'APPROVED')
    .where('l.startDate', '<=', asDate(date)).where('l.endDate', '>=', asDate(date))
    .orderBy('l.isHalfDay', 'asc').orderBy('l.createdAt', 'desc')
    .executeTakeFirst();
  const leave: EngineLeave | null = leaveRow ? { id: leaveRow.id, leaveTypeCode: String(leaveRow.code), isPaid: leaveRow.isPaid, isHalfDay: leaveRow.isHalfDay, halfDayPart: leaveRow.halfDayPart } : null;

  // Events in a generous window; the engine attributes them to punch windows. The raw payload rides along (same
  // partition key) so the self-service facts of a punch — channel, geofence verdict, policy window — reach the engine.
  const windowStart = localDateTime(addDays(date, -1), '00:00', timezone).toJSDate();
  const windowEnd = localDateTime(addDays(date, 2), '00:00', timezone).toJSDate();
  const eventRows = await trx.selectFrom('attendanceEvents as ev')
    .leftJoin('attendanceRawTransactions as rt', (join) => join.onRef('rt.id', '=', 'ev.rawTransactionId').onRef('rt.punchedAt', '=', 'ev.punchedAt'))
    .select(['ev.id', 'ev.punchedAt', 'ev.eventType', 'ev.source', 'ev.verificationMethod', 'ev.deviceId', 'ev.voidedAt', 'rt.rawPayload'])
    .where('ev.organizationId', '=', organizationId).where('ev.employeeId', '=', employeeId)
    .where('ev.punchedAt', '>=', windowStart).where('ev.punchedAt', '<', windowEnd)
    .orderBy('ev.punchedAt', 'asc').orderBy('ev.id', 'asc').execute();
  const eventSources = new Map<string, EngineEvent['source']>();
  const events: EngineEvent[] = eventRows.map((e) => {
    eventSources.set(e.id, e.source);
    const payload = punchPayloadOf(e.rawPayload);
    return { id: e.id, punchedAt: (e.punchedAt instanceof Date ? e.punchedAt : new Date(e.punchedAt)).toISOString(), eventType: e.eventType, source: e.source, verificationMethod: e.verificationMethod, deviceId: e.deviceId, voided: e.voidedAt !== null, ...(payload ? { payload } : {}) };
  });

  // Active day marks (reviewed verdicts) for the date — folded in by the engine as flags / lopDays.
  const dayMarks: EngineDayMark[] = (await activeMarksOn(trx, organizationId, employeeId, date)).map((m) => ({ id: m.id, kind: m.kind, payEffectDays: m.payEffectDays, source: m.source }));

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
    dayMarks,
    settings: { nonWorkingDay: settings.nonWorkingDay },
    now: now.toISOString(),
    adjacentShifts: { previous: shiftOf(effectiveShiftId(resolvedPrev)), next: shiftOf(effectiveShiftId(resolvedNext)) },
  };
  return { input, branchId: today.branchId, departmentId: today.departmentId, timezone, eventSources, leave: leave ? { id: leave.id, isPaid: leave.isPaid } : null, settings };
}
