import type { DateTime } from 'luxon';
import { ATTENDANCE_FLAGS, type AttendanceFlag, type AttendanceRules, type AttendanceStatus } from '@flowza/contracts';
import { addDays, dayOfWeek, minutesBetween } from '@flowza/shared';
import { attributeEvents } from './attribute.js';
import { collapseDuplicates, computeBreaks, interpretPunches, scheduledBreakMinutes, type Interpretation } from './interpret.js';
import { roundMinutes, roundPunches } from './rounding.js';
import { ENGINE_VERSION, type CalculationTrace, type DailyCalculationInput, type DailyCalculationResult, type EngineShift, type TraceStep } from './types.js';
import { assertTimezone, computePunchWindow, localInstant, parseInstant, toUtcIso, type PunchWindow } from './window.js';

type TracePunch = CalculationTrace['punches'][number];
type HalfDayOff = 'FIRST_HALF' | 'SECOND_HALF' | null;
type DayType = 'WORKING' | 'HOLIDAY' | 'WEEKLY_OFF' | 'LEAVE';

/** Collects trace steps and flags in a deterministic order. */
class Recorder {
  readonly steps: TraceStep[] = [];
  private readonly flagSet = new Set<AttendanceFlag>();

  step(step: string, detail: string, values?: Record<string, unknown>): void {
    this.steps.push(values ? { step, detail, values } : { step, detail });
  }

  flag(flag: AttendanceFlag): void {
    this.flagSet.add(flag);
  }

  /** Flags in the canonical `ATTENDANCE_FLAGS` order so equal inputs always serialise identically. */
  flags(): AttendanceFlag[] {
    return ATTENDANCE_FLAGS.filter((f) => this.flagSet.has(f));
  }
}

interface Schedule {
  kind: PunchWindow['kind'];
  expectedStart: DateTime | null;
  expectedEnd: DateTime | null;
  /** Minutes the employee is expected to work on this date after Ramadan / half-day adjustments. */
  scheduledMinutes: number;
  /** Scheduled minutes of a normal full day on this shift (before adjustments); 0 when unknown. */
  baseScheduledMinutes: number;
  /** scheduled / base — scales the full-day / half-day thresholds on reduced days. */
  ratio: number;
  unpaidFixedBreakMinutes: number;
  halfDayOff: HalfDayOff;
}

interface WorkFigures {
  firstIn: DateTime | null;
  lastOut: DateTime | null;
  workedMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  earlyDepartureMinutes: number;
  overtimeMinutes: number;
  overtimeCategory: DailyCalculationResult['overtimeCategory'];
}

const iso = (dt: DateTime | null): string | null => (dt ? toUtcIso(dt) : null);
const local = (dt: DateTime): string => dt.toISO({ suppressMilliseconds: true, includeOffset: true }) ?? dt.toString();

/**
 * Pure, deterministic daily attendance calculation (§G.4–G.6). Every decision is written to
 * `trace.steps`; every input event appears in `trace.punches` with the role it played.
 *
 * Precedence: NOT_JOINED / EXITED → HOLIDAY → WEEKLY_OFF → LEAVE → punches. When `input.now` is omitted the
 * day is treated as over (historical recomputation), so missing punches are judged, not left PENDING.
 */
export function calculateDailyRecord(input: DailyCalculationInput): DailyCalculationResult {
  const { attendanceDate: date, timezone: zone, shift, rules } = input;
  assertTimezone(zone);
  const rec = new Recorder();

  // 1. Punch windows for the date and its neighbours (§G.3).
  const window = computePunchWindow(shift, date, zone);
  const previousShift = input.adjacentShifts?.previous === undefined ? shift : input.adjacentShifts.previous;
  const nextShift = input.adjacentShifts?.next === undefined ? shift : input.adjacentShifts.next;
  const windows = [computePunchWindow(previousShift, addDays(date, -1), zone), window, computePunchWindow(nextShift, addDays(date, 1), zone)];
  rec.step('window', `${window.kind} punch window [${local(window.windowStart)}, ${local(window.windowEnd)})`, {
    kind: window.kind,
    scheduledStart: iso(window.scheduledStart),
    scheduledEnd: iso(window.scheduledEnd),
    windowStart: iso(window.windowStart),
    windowEnd: iso(window.windowEnd),
    crossesMidnight: window.crossesMidnight,
  });
  if (window.crossesMidnight) rec.flag('CROSS_MIDNIGHT');
  if (shift === null) rec.flag('NO_SHIFT');

  // 2. Attribution of every supplied event.
  const attribution = attributeEvents(input.events, windows);
  const attributed = attribution.byDate.get(date) ?? [];
  const tracePunches = new Map<string, TracePunch>();
  let outOfWindowOnDate = 0;
  for (const d of attribution.decisions) {
    const at = parseInstant(d.punchedAt, zone);
    const base = { eventId: d.eventId, punchedAt: d.punchedAt, local: local(at) };
    if (d.reason === 'VOIDED') tracePunches.set(d.eventId, { ...base, role: 'IGNORED', note: 'voided event' });
    else if (d.attendanceDate === date) tracePunches.set(d.eventId, { ...base, role: 'IGNORED', note: d.reason === 'NEAREST_SCHEDULED_START' ? `overlapping windows ${d.candidates.join('/')} → nearest scheduled start (${d.distanceMinutes} min)` : 'in window' });
    else {
      const note = d.attendanceDate === null ? 'outside every punch window' : `attributed to ${d.attendanceDate} (${d.reason === 'NEAREST_SCHEDULED_START' ? `nearest scheduled start, ${d.distanceMinutes} min` : 'only containing window'})`;
      tracePunches.set(d.eventId, { ...base, role: 'OUT_OF_WINDOW', note });
      if (d.attendanceDate === null && at.toISODate() === date) outOfWindowOnDate += 1;
    }
  }
  rec.step('attribution', `${attributed.length} of ${input.events.length} events attributed to ${date}`, {
    attributed: attributed.map((e) => e.id),
    voided: attribution.decisions.filter((d) => d.reason === 'VOIDED').length,
    attributedElsewhere: attribution.decisions.filter((d) => d.attendanceDate !== null && d.attendanceDate !== date).length,
    outOfWindow: attribution.decisions.filter((d) => d.reason === 'OUT_OF_WINDOW').length,
    tieBreak: 'nearest scheduled start; earlier date on exact tie',
  });
  if (outOfWindowOnDate > 0) {
    rec.flag('OUT_OF_WINDOW');
    rec.step('attribution.outOfWindow', `${outOfWindowOnDate} punch(es) on calendar day ${date} fall outside every window`, { count: outOfWindowOnDate });
  }
  if (attributed.some((e) => e.source === 'MANUAL' || e.source === 'CORRECTION')) rec.flag('MANUAL_CORRECTION');

  // 3. Duplicate collapsing and interpretation (§G.4).
  const { kept, duplicates } = collapseDuplicates(attributed, rules.duplicatePunchWindowSeconds);
  for (const dup of duplicates) {
    const entry = tracePunches.get(dup.event.id);
    if (entry) tracePunches.set(dup.event.id, { ...entry, role: 'DUPLICATE', note: `${dup.secondsApart}s after ${dup.of.id} (window ${rules.duplicatePunchWindowSeconds}s)` });
  }
  if (duplicates.length > 0) {
    rec.flag('DUPLICATE_PUNCHES_COLLAPSED');
    rec.step('duplicates', `${duplicates.length} duplicate punch(es) collapsed`, { collapsed: duplicates.map((d) => d.event.id), windowSeconds: rules.duplicatePunchWindowSeconds });
  }
  const interpretation = interpretPunches(kept, rules.punchInterpretation, zone);
  for (const p of interpretation.punches) {
    const entry = tracePunches.get(p.event.id);
    if (entry) tracePunches.set(p.event.id, { ...entry, role: p.role, note: p.note });
  }
  rec.step('interpretation', `${interpretation.effectiveMode}${interpretation.effectiveMode !== interpretation.mode ? ` (fallback from ${interpretation.mode})` : ''}: firstIn ${iso(interpretation.firstIn) ?? '—'}, lastOut ${iso(interpretation.lastOut) ?? '—'}`, {
    mode: interpretation.mode,
    effectiveMode: interpretation.effectiveMode,
    firstIn: iso(interpretation.firstIn),
    lastOut: iso(interpretation.lastOut),
    missingIn: interpretation.missingIn,
    missingOut: interpretation.missingOut,
    segments: interpretation.segments.length,
    measuredBreakMinutes: interpretation.measuredBreakMinutes,
  });

  const trace: CalculationTrace = {
    engineVersion: ENGINE_VERSION,
    inputs: {
      shiftId: shift?.id ?? null,
      shiftType: shift?.type ?? null,
      ruleSetId: input.ruleSetId,
      timezone: zone,
      window: { start: toUtcIso(window.windowStart), end: toUtcIso(window.windowEnd) },
      holiday: input.holiday ? `${input.holiday.name}${input.holiday.isHalfDay ? ' (half day)' : ''}` : null,
      leave: input.leave ? `${input.leave.leaveTypeCode}${input.leave.isHalfDay ? ` (${input.leave.halfDayPart ?? 'SECOND_HALF'})` : ''}` : null,
      weeklyOff: input.weeklyOffDays.includes(dayOfWeek(date)),
    },
    punches: [...tracePunches.values()],
    steps: rec.steps,
  };

  const base = {
    employeeId: input.employeeId,
    attendanceDate: date,
    timezone: zone,
    shiftId: shift?.id ?? null,
    shiftAssignmentId: input.shiftAssignmentId,
    ruleSetId: input.ruleSetId,
    punchCount: attributed.length,
    eventIds: attributed.map((e) => e.id),
    trace,
  };
  const emptyWork: WorkFigures = { firstIn: null, lastOut: null, workedMinutes: 0, breakMinutes: 0, lateMinutes: 0, earlyDepartureMinutes: 0, overtimeMinutes: 0, overtimeCategory: null };
  const finish = (status: AttendanceStatus, schedule: Schedule | null, work: WorkFigures): DailyCalculationResult => ({
    ...base,
    expectedStartAt: iso(schedule?.expectedStart ?? null),
    expectedEndAt: iso(schedule?.expectedEnd ?? null),
    scheduledMinutes: schedule?.scheduledMinutes ?? 0,
    firstInAt: iso(work.firstIn),
    lastOutAt: iso(work.lastOut),
    workedMinutes: work.workedMinutes,
    breakMinutes: work.breakMinutes,
    lateMinutes: work.lateMinutes,
    earlyDepartureMinutes: work.earlyDepartureMinutes,
    overtimeMinutes: work.overtimeMinutes,
    overtimeCategory: work.overtimeCategory,
    status,
    flags: rec.flags(),
  });

  // 4. Employment boundaries.
  if (date < input.employment.joiningDate) {
    rec.step('employment', `date precedes joining date ${input.employment.joiningDate} → NOT_JOINED`, { joiningDate: input.employment.joiningDate });
    return finish('NOT_JOINED', null, emptyWork);
  }
  if (input.employment.exitDate !== null && date > input.employment.exitDate) {
    rec.step('employment', `date follows exit date ${input.employment.exitDate} → EXITED`, { exitDate: input.employment.exitDate });
    return finish('EXITED', null, emptyWork);
  }

  // 5. Day type (holiday > weekly off > leave > working).
  const dayType = classifyDay(input, rec);
  const halfDayOff: HalfDayOff = dayType === 'WORKING' ? halfDayPart(input, rec) : null;

  // 6. Expectations.
  const schedule = buildSchedule(input, window, halfDayOff, rec);
  const now = input.now ? parseInstant(input.now, zone) : null;
  const dayOver = now === null || now >= window.windowEnd;
  rec.step('now', now ? `now ${toUtcIso(now)} → window ${dayOver ? 'closed' : 'open'}` : 'no `now` supplied → day treated as over', { now: iso(now), dayOver });

  // 7. Non-working days: status is fixed; work (if any) is recorded and may count as overtime.
  if (dayType !== 'WORKING') {
    const status: AttendanceStatus = dayType;
    const restSchedule: Schedule = { ...schedule, scheduledMinutes: 0 };
    if (interpretation.firstIn === null && interpretation.lastOut === null) {
      rec.step('status', `${status}: no punches`, { status });
      return finish(status, restSchedule, emptyWork);
    }
    const work = measureWork(interpretation, schedule, rules, shift, date, zone, window, rec);
    if (dayType === 'HOLIDAY') rec.flag('WORKED_ON_HOLIDAY');
    if (dayType === 'WEEKLY_OFF') rec.flag('WORKED_ON_WEEKLY_OFF');
    if (interpretation.missingOut) rec.flag('MISSING_OUT');
    if (interpretation.missingIn) rec.flag('MISSING_IN');
    const otAllowed = rules.overtimeEnabled && ((dayType === 'HOLIDAY' && rules.holidayWorkCountsAsOvertime) || (dayType === 'WEEKLY_OFF' && rules.weeklyOffWorkCountsAsOvertime));
    let overtimeMinutes = 0;
    let overtimeCategory: WorkFigures['overtimeCategory'] = null;
    if (otAllowed && work.workedMinutes > 0) {
      overtimeMinutes = capOvertime(work.workedMinutes, rules);
      overtimeCategory = dayType === 'HOLIDAY' ? 'HOLIDAY' : 'WEEKLY_OFF';
      rec.flag('OVERTIME');
      rec.step('overtime', `all ${work.workedMinutes} worked minutes count as ${overtimeCategory} overtime${overtimeMinutes !== work.workedMinutes ? ` (capped at ${overtimeMinutes})` : ''}`, { worked: work.workedMinutes, overtime: overtimeMinutes, category: overtimeCategory, cap: rules.overtimeMaxMinutesPerDay ?? null });
    } else {
      rec.step('overtime', dayType === 'LEAVE' ? 'work on a leave day does not earn overtime' : `work on ${dayType} does not count as overtime (rule disabled)`, { overtimeEnabled: rules.overtimeEnabled });
    }
    rec.step('status', `${status} with work recorded`, { status, worked: work.workedMinutes });
    return finish(status, restSchedule, { ...work, lateMinutes: 0, earlyDepartureMinutes: 0, overtimeMinutes, overtimeCategory });
  }

  // 8. Working day without punches.
  if (interpretation.firstIn === null && interpretation.lastOut === null) {
    if (!dayOver) {
      rec.step('status', 'no punches and the punch window is still open → PENDING', { status: 'PENDING' });
      return finish('PENDING', schedule, emptyWork);
    }
    if (rules.autoAbsentWithoutPunches) {
      rec.step('status', 'no punches after window close → ABSENT (autoAbsentWithoutPunches)', { status: 'ABSENT' });
      return finish('ABSENT', schedule, emptyWork);
    }
    rec.step('status', 'no punches after window close; autoAbsentWithoutPunches is off → PENDING for review', { status: 'PENDING' });
    return finish('PENDING', schedule, emptyWork);
  }

  // 9. Missing punch handling.
  if (interpretation.missingOut && interpretation.lastOut === null && !dayOver) {
    rec.step('status', 'IN without OUT while the punch window is open → still working → PENDING', { status: 'PENDING' });
    const work = measureWork(interpretation, schedule, rules, shift, date, zone, window, rec);
    return finish('PENDING', schedule, { ...work, workedMinutes: 0, breakMinutes: 0, earlyDepartureMinutes: 0, overtimeMinutes: 0 });
  }
  if (interpretation.missingOut && interpretation.lastOut === null) return finish(...resolveMissingPunch('OUT', interpretation, schedule, rules, shift, date, zone, window, rec));
  if (interpretation.missingIn && interpretation.firstIn === null) return finish(...resolveMissingPunch('IN', interpretation, schedule, rules, shift, date, zone, window, rec));

  // 10. Complete day.
  const work = measureWork(interpretation, schedule, rules, shift, date, zone, window, rec);
  if (interpretation.missingOut) rec.flag('MISSING_OUT'); // PAIRED/DIRECTIONAL: last segment open but an earlier OUT exists
  const status = classifyWorkingStatus(work.workedMinutes, schedule, rules, halfDayOff, rec);
  return finish(status, schedule, work);
}

/* ------------------------------------------------------------------------------------------------ */

function classifyDay(input: DailyCalculationInput, rec: Recorder): DayType {
  if (input.holiday && !input.holiday.isHalfDay) {
    rec.step('dayType', `holiday "${input.holiday.name}" → HOLIDAY`, { holidayId: input.holiday.id });
    return 'HOLIDAY';
  }
  const weekday = dayOfWeek(input.attendanceDate);
  if (input.weeklyOffDays.includes(weekday)) {
    rec.step('dayType', `weekday ${weekday} is a weekly off day → WEEKLY_OFF`, { weekday, weeklyOffDays: input.weeklyOffDays });
    return 'WEEKLY_OFF';
  }
  if (input.leave && !input.leave.isHalfDay) {
    rec.step('dayType', `approved full-day leave ${input.leave.leaveTypeCode} → LEAVE`, { leaveId: input.leave.id, isPaid: input.leave.isPaid });
    return 'LEAVE';
  }
  rec.step('dayType', 'working day', { holiday: input.holiday?.id ?? null, leave: input.leave?.id ?? null });
  return 'WORKING';
}

function halfDayPart(input: DailyCalculationInput, rec: Recorder): HalfDayOff {
  if (input.leave?.isHalfDay) {
    const part = input.leave.halfDayPart ?? 'SECOND_HALF';
    rec.flag('HALF_DAY_LEAVE');
    rec.step('halfDay', `half-day leave ${input.leave.leaveTypeCode} on ${part} → expectations halved`, { leaveId: input.leave.id, part });
    return part;
  }
  if (input.holiday?.isHalfDay) {
    rec.step('halfDay', `half-day holiday "${input.holiday.name}" → second half off, expectations halved`, { holidayId: input.holiday.id });
    return 'SECOND_HALF';
  }
  return null;
}

function ramadanApplies(input: DailyCalculationInput): number | null {
  const mode = input.rules.ramadanMode;
  if (!mode.enabled || mode.scheduledMinutes === undefined || mode.from === undefined || mode.to === undefined) return null;
  if (input.attendanceDate < mode.from || input.attendanceDate > mode.to) return null;
  if (mode.appliesTo !== 'all' && input.ramadanEligible !== true) return null;
  return mode.scheduledMinutes;
}

function buildSchedule(input: DailyCalculationInput, window: PunchWindow, halfDayOff: HalfDayOff, rec: Recorder): Schedule {
  const { shift, attendanceDate: date, timezone: zone } = input;
  let expectedStart: DateTime | null = null;
  let expectedEnd: DateTime | null = null;
  let scheduled = 0;
  let unpaidFixed = 0;

  if (shift && window.kind === 'FIXED') {
    unpaidFixed = scheduledBreakMinutes(shift.breaks).unpaid;
    expectedStart = window.scheduledStart;
    expectedEnd = window.scheduledEnd;
    scheduled = Math.max(0, minutesBetween(expectedStart, expectedEnd) - unpaidFixed);
    rec.step('schedule', `FIXED ${shift.startTime}–${shift.endTime}: ${minutesBetween(expectedStart, expectedEnd)} min span − ${unpaidFixed} min unpaid breaks = ${scheduled} scheduled`, { expectedStart: toUtcIso(expectedStart), expectedEnd: toUtcIso(expectedEnd), unpaidBreakMinutes: unpaidFixed, scheduledMinutes: scheduled });
  } else if (shift && window.kind === 'FLEXIBLE') {
    scheduled = Math.max(0, shift.requiredMinutes ?? 0);
    if (shift.coreStart) expectedStart = localInstant(date, shift.coreStart, zone);
    if (shift.coreEnd) {
      expectedEnd = localInstant(date, shift.coreEnd, zone);
      if (expectedStart && expectedEnd <= expectedStart) expectedEnd = localInstant(date, shift.coreEnd, zone, 1);
    }
    rec.step('schedule', `FLEXIBLE: ${scheduled} required minutes${shift.coreStart && shift.coreEnd ? `, core ${shift.coreStart}–${shift.coreEnd}` : ''}`, { requiredMinutes: scheduled, coreStart: iso(expectedStart), coreEnd: iso(expectedEnd) });
  } else {
    rec.step('schedule', 'no shift assigned → no expectations; worked hours from first/last punch on the calendar day');
  }
  const baseScheduled = scheduled;

  const ramadan = ramadanApplies(input);
  if (ramadan !== null && window.kind !== 'NONE') {
    const reduced = Math.min(scheduled, ramadan);
    if (expectedStart && window.kind === 'FIXED') expectedEnd = expectedStart.plus({ minutes: reduced + unpaidFixed });
    rec.flag('RAMADAN_HOURS');
    rec.step('ramadan', `Ramadan hours: scheduled ${scheduled} → ${reduced} min${expectedEnd && window.kind === 'FIXED' ? `, expected end ${toUtcIso(expectedEnd)}` : ''}`, { from: input.rules.ramadanMode.from, to: input.rules.ramadanMode.to, appliesTo: input.rules.ramadanMode.appliesTo, scheduledMinutes: reduced });
    scheduled = reduced;
  }

  if (halfDayOff !== null && scheduled > 0) {
    const half = Math.round(scheduled / 2);
    if (expectedStart && expectedEnd) {
      const midpoint = expectedStart.plus({ minutes: Math.round(minutesBetween(expectedStart, expectedEnd) / 2) });
      if (halfDayOff === 'FIRST_HALF') expectedStart = midpoint;
      else expectedEnd = midpoint;
    }
    rec.step('halfDay.schedule', `${halfDayOff} off: scheduled ${scheduled} → ${half} min`, { expectedStart: iso(expectedStart), expectedEnd: iso(expectedEnd), scheduledMinutes: half });
    scheduled = half;
  }

  return { kind: window.kind, expectedStart, expectedEnd, scheduledMinutes: scheduled, baseScheduledMinutes: baseScheduled, ratio: baseScheduled > 0 ? scheduled / baseScheduled : 1, unpaidFixedBreakMinutes: unpaidFixed, halfDayOff };
}

/** Punch rounding, breaks, worked, late/early and regular overtime for a day with at least one punch. */
function measureWork(interpretation: Interpretation, schedule: Schedule, rules: AttendanceRules, shift: EngineShift | null, date: string, zone: string, window: PunchWindow, rec: Recorder, assumed: { firstIn?: DateTime; lastOut?: DateTime } = {}): WorkFigures {
  const rawIn = interpretation.firstIn ?? assumed.firstIn ?? null;
  const rawOut = interpretation.lastOut ?? assumed.lastOut ?? null;
  const rounded = roundPunches(rawIn, rawOut, rules.punchRoundingMinutes, rules.punchRoundingMode);
  if (rounded.changed) {
    rec.step('rounding.punches', `punches rounded ${rules.punchRoundingMode} to ${rules.punchRoundingMinutes} min`, { rawIn: iso(rawIn), roundedIn: iso(rounded.firstIn), rawOut: iso(rawOut), roundedOut: iso(rounded.lastOut) });
  }
  const firstIn = rounded.firstIn;
  const lastOut = rounded.lastOut;

  let workedMinutes = 0;
  let breakMinutes = 0;
  if (firstIn && lastOut) {
    const breaks = computeBreaks({ breaks: shift?.breaks ?? [], interpretation, firstIn, lastOut, attendanceDate: date, zone, crossesMidnight: window.crossesMidnight });
    breakMinutes = breaks.unpaidMinutes;
    const span = Math.max(0, minutesBetween(firstIn, lastOut));
    const rawWorked = Math.max(0, span - breakMinutes);
    workedMinutes = Math.max(0, roundMinutes(rawWorked, rules.workedRoundingMinutes, rules.workedRoundingMode));
    rec.step('breaks', `${breaks.source}: ${breaks.unpaidMinutes} min unpaid deducted, ${breaks.paidMinutes} min paid`, { source: breaks.source, unpaidMinutes: breaks.unpaidMinutes, paidMinutes: breaks.paidMinutes, detail: breaks.detail });
    rec.step('worked', `${span} min span − ${breakMinutes} min unpaid breaks = ${rawWorked}${workedMinutes !== rawWorked ? ` → rounded ${rules.workedRoundingMode} ${rules.workedRoundingMinutes} = ${workedMinutes}` : ''} min`, { spanMinutes: span, rawWorkedMinutes: rawWorked, workedMinutes });
  }

  // Late / early departure relative to expected start/end (core hours for FLEXIBLE).
  const graceIn = shift?.graceInMinutes ?? rules.graceInMinutes;
  const graceOut = shift?.graceOutMinutes ?? rules.graceOutMinutes;
  let lateMinutes = 0;
  let earlyDepartureMinutes = 0;
  if (firstIn && schedule.expectedStart && !assumed.firstIn) {
    lateMinutes = Math.max(0, minutesBetween(schedule.expectedStart.plus({ minutes: graceIn }), firstIn));
    const flagged = lateMinutes > rules.lateThresholdMinutes;
    if (flagged) rec.flag('LATE');
    rec.step('late', `IN ${toUtcIso(firstIn)} vs expected ${toUtcIso(schedule.expectedStart)} + ${graceIn} min grace → ${lateMinutes} min late${flagged ? ' (flagged)' : lateMinutes > 0 ? ` (≤ threshold ${rules.lateThresholdMinutes}, not flagged)` : ''}`, { graceInMinutes: graceIn, lateMinutes, thresholdMinutes: rules.lateThresholdMinutes, flagged });
  }
  if (lastOut && schedule.expectedEnd && !assumed.lastOut) {
    earlyDepartureMinutes = Math.max(0, minutesBetween(lastOut, schedule.expectedEnd.minus({ minutes: graceOut })));
    const flagged = earlyDepartureMinutes > rules.earlyDepartureThresholdMinutes;
    if (flagged) rec.flag('EARLY_DEPARTURE');
    rec.step('earlyDeparture', `OUT ${toUtcIso(lastOut)} vs expected ${toUtcIso(schedule.expectedEnd)} − ${graceOut} min grace → ${earlyDepartureMinutes} min early${flagged ? ' (flagged)' : ''}`, { graceOutMinutes: graceOut, earlyDepartureMinutes, thresholdMinutes: rules.earlyDepartureThresholdMinutes, flagged });
  }

  // Regular overtime (§G.5).
  let overtimeMinutes = 0;
  let overtimeCategory: WorkFigures['overtimeCategory'] = null;
  const assumedPunch = assumed.firstIn !== undefined || assumed.lastOut !== undefined;
  if (!rules.overtimeEnabled) {
    rec.step('overtime', 'overtime disabled by rule set', { overtimeEnabled: false });
  } else if (assumedPunch) {
    rec.step('overtime', 'no overtime on an assumed punch', { assumed: true });
  } else if (firstIn && lastOut && schedule.kind === 'FIXED' && schedule.expectedStart && schedule.expectedEnd) {
    const afterEnd = Math.max(0, minutesBetween(schedule.expectedEnd, lastOut));
    const earlyIn = rules.countEarlyInAsOvertime ? Math.max(0, minutesBetween(firstIn, schedule.expectedStart)) : 0;
    const raw = Math.max(0, afterEnd + earlyIn - rules.overtimeStartAfterMinutes);
    overtimeMinutes = finaliseOvertime(raw, rules);
    rec.step('overtime', `${afterEnd} min after expected end${rules.countEarlyInAsOvertime ? ` + ${earlyIn} min early in` : ''} − ${rules.overtimeStartAfterMinutes} min threshold = ${raw} raw → ${overtimeMinutes} min (round DOWN ${rules.overtimeRoundingMinutes}, block ${rules.overtimeMinBlockMinutes}, cap ${rules.overtimeMaxMinutesPerDay ?? '∞'})`, { afterEndMinutes: afterEnd, earlyInMinutes: earlyIn, rawOvertimeMinutes: raw, overtimeMinutes });
  } else if (firstIn && lastOut && schedule.kind === 'FLEXIBLE') {
    const raw = Math.max(0, workedMinutes - schedule.scheduledMinutes - rules.overtimeStartAfterMinutes);
    overtimeMinutes = finaliseOvertime(raw, rules);
    rec.step('overtime', `FLEXIBLE: ${workedMinutes} worked − ${schedule.scheduledMinutes} required − ${rules.overtimeStartAfterMinutes} threshold = ${raw} raw → ${overtimeMinutes} min`, { workedMinutes, requiredMinutes: schedule.scheduledMinutes, rawOvertimeMinutes: raw, overtimeMinutes });
  } else {
    rec.step('overtime', 'no overtime basis (no shift or incomplete punches)', { kind: schedule.kind });
  }
  if (overtimeMinutes > 0) {
    overtimeCategory = 'REGULAR';
    rec.flag('OVERTIME');
  }

  return { firstIn, lastOut, workedMinutes, breakMinutes, lateMinutes, earlyDepartureMinutes, overtimeMinutes, overtimeCategory };
}

/** Round DOWN to the OT rounding interval, keep whole minimum blocks, apply the daily cap. */
export function finaliseOvertime(rawMinutes: number, rules: AttendanceRules): number {
  const rounded = roundMinutes(Math.max(0, rawMinutes), rules.overtimeRoundingMinutes, 'DOWN');
  const block = rules.overtimeMinBlockMinutes;
  const blocked = block > 0 ? Math.floor(rounded / block) * block : rounded;
  return capOvertime(blocked, rules);
}

function capOvertime(minutes: number, rules: AttendanceRules): number {
  const cap = rules.overtimeMaxMinutesPerDay;
  return typeof cap === 'number' ? Math.min(minutes, cap) : minutes;
}

type MissingSide = 'IN' | 'OUT';

function resolveMissingPunch(side: MissingSide, interpretation: Interpretation, schedule: Schedule, rules: AttendanceRules, shift: EngineShift | null, date: string, zone: string, window: PunchWindow, rec: Recorder): [AttendanceStatus, Schedule, WorkFigures] {
  const flag: AttendanceFlag = side === 'OUT' ? 'MISSING_OUT' : 'MISSING_IN';
  rec.flag(flag);
  const behaviour = rules.missingPunchBehavior;
  const partial = (): WorkFigures => {
    const w = measureWork(interpretation, schedule, rules, shift, date, zone, window, rec);
    return { ...w, workedMinutes: 0, breakMinutes: 0, overtimeMinutes: 0, overtimeCategory: null };
  };

  switch (behaviour) {
    case 'FLAG_ONLY': {
      rec.step('missingPunch', `${flag} after window close → FLAG_ONLY: PRESENT, worked minutes unknown (0)`, { behaviour, status: 'PRESENT' });
      return ['PRESENT', schedule, partial()];
    }
    case 'TREAT_AS_ABSENT': {
      rec.step('missingPunch', `${flag} → TREAT_AS_ABSENT`, { behaviour, status: 'ABSENT' });
      return ['ABSENT', schedule, partial()];
    }
    case 'TREAT_AS_HALF_DAY': {
      rec.step('missingPunch', `${flag} → TREAT_AS_HALF_DAY`, { behaviour, status: 'HALF_DAY' });
      return ['HALF_DAY', schedule, partial()];
    }
    case 'ASSUME_SHIFT_END': {
      const assumed = assumedInstant(side, interpretation, schedule);
      if (assumed === null) {
        rec.step('missingPunch', `${flag} → ASSUME_SHIFT_END has no schedule to assume from (no shift) → FLAG_ONLY`, { behaviour, status: 'PRESENT' });
        return ['PRESENT', schedule, partial()];
      }
      rec.step('missingPunch', `${flag} → ASSUME_SHIFT_END: ${side} assumed at ${toUtcIso(assumed)}`, { behaviour, assumed: toUtcIso(assumed), status: 'PRESENT' });
      const work = measureWork(interpretation, schedule, rules, shift, date, zone, window, rec, side === 'OUT' ? { lastOut: assumed } : { firstIn: assumed });
      // The assumed instant is not a punch: keep the real timestamps only.
      const figures: WorkFigures = side === 'OUT' ? { ...work, lastOut: null } : { ...work, firstIn: null };
      return ['PRESENT', schedule, figures];
    }
    default: {
      const exhaustive: never = behaviour;
      return exhaustive;
    }
  }
}

function assumedInstant(side: MissingSide, interpretation: Interpretation, schedule: Schedule): DateTime | null {
  if (schedule.kind === 'FIXED') return side === 'OUT' ? schedule.expectedEnd : schedule.expectedStart;
  if (schedule.kind === 'FLEXIBLE') {
    const minutes = schedule.scheduledMinutes + schedule.unpaidFixedBreakMinutes;
    if (side === 'OUT') return interpretation.firstIn ? interpretation.firstIn.plus({ minutes }) : null;
    return interpretation.lastOut ? interpretation.lastOut.minus({ minutes }) : null;
  }
  return null;
}

function classifyWorkingStatus(workedMinutes: number, schedule: Schedule, rules: AttendanceRules, halfDayOff: HalfDayOff, rec: Recorder): AttendanceStatus {
  if (schedule.kind === 'NONE') {
    rec.step('status', `PRESENT (no shift: ${workedMinutes} worked minutes, no thresholds)`, { status: 'PRESENT', workedMinutes });
    return 'PRESENT';
  }
  const minFullDay = Math.round(rules.minFullDayMinutes * schedule.ratio);
  const halfDayThreshold = Math.round(rules.halfDayThresholdMinutes * schedule.ratio);
  if (workedMinutes < minFullDay) {
    rec.flag('UNDER_HOURS');
    rec.step('underHours', `${workedMinutes} worked < ${minFullDay} min full day${schedule.ratio !== 1 ? ` (${rules.minFullDayMinutes} × ${schedule.ratio})` : ''} → UNDER_HOURS`, { workedMinutes, minFullDayMinutes: minFullDay });
  }
  if (halfDayOff !== null) {
    rec.step('status', `half-day leave/holiday with ${workedMinutes} worked minutes → HALF_DAY`, { status: 'HALF_DAY', workedMinutes });
    return 'HALF_DAY';
  }
  if (workedMinutes < halfDayThreshold) {
    rec.step('status', `${workedMinutes} worked < ${halfDayThreshold} min half-day threshold → HALF_DAY`, { status: 'HALF_DAY', workedMinutes, halfDayThresholdMinutes: halfDayThreshold });
    return 'HALF_DAY';
  }
  rec.step('status', `PRESENT (${workedMinutes} worked minutes)`, { status: 'PRESENT', workedMinutes });
  return 'PRESENT';
}

