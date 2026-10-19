import { ATTENDANCE_FLAGS, type AttendanceFlag, type AttendanceStatus } from '@flowza/contracts';
import { minutesBetween } from '@flowza/shared';
import { collapseDuplicates, interpretPunches, scheduledBreakMinutes } from './interpret.js';
import type { DailyCalculationInput, DailyCalculationResult, EngineHourAllowance, EngineShift, EngineTimeOff, TraceStep } from './types.js';
import { computePunchWindow, localInstant, type PunchWindow } from './window.js';

/**
 * Short leave, reduced hours and lost time (engine 1.5.0) — applied to the computed day by `calculateDailyRecord`, before the
 * reviewed day marks. Pure and deterministic; every decision is a `timeOff.*` / `lostTime` trace step.
 *
 * On a WORKING day (PRESENT, ABSENT, HALF_DAY, MISSING_PUNCH, PENDING — never a holiday, weekly off, full-day leave or a day
 * outside the employment):
 *  1. Approved windows (`input.timeOff`) concern the day when they touch its scheduled span (expected start → end); without a
 *     schedule, the windows asked for on the date. Flags: OFFICIAL_ASSIGNMENT (OFFICIAL), REMOTE_WORK (REMOTE), SHORT_LEAVE
 *     (every other category).
 *  2. Reduced hours (`input.hourAllowances`, a day with a schedule): the scheduled minutes shrink by the minutes per day (flag
 *     REDUCED_HOURS); START moves the expected start later and END the expected end earlier (fixed shifts); EITHER forgives
 *     lateness first, then early departure.
 *  3. Credit: the part of a `countsAsWork` window inside the schedule that no punched work overlaps is added to the worked
 *     minutes (`creditedMinutes`) — a remote-work day without punches is worked. Only where the punched hours are known (a
 *     complete day, or no punches at all).
 *  4. Excused: the part of a non-work window inside the schedule not worked and not credited (`excusedMinutes`). Lateness and
 *     early departure are re-measured: the expected start advances through a window that covers it (and the grace applies
 *     after it), the expected end retreats through one that covers it, and late / early minutes inside any window are dropped.
 *     LATE / VERY_LATE / EARLY_DEPARTURE follow the new figures.
 *  5. Status, when anything above applied (never on a half-day leave / holiday): the worked (with credit) plus excused minutes
 *     against the rule set's thresholds scaled to the reduced schedule — a punched day is PRESENT or HALF_DAY (UNDER_HOURS
 *     follows); an absent day becomes PRESENT / HALF_DAY only when the approved windows reach the thresholds.
 *  6. Lost time: in PAIRED / DIRECTIONAL punching, the out-of-office gaps between punched work segments inside the scheduled
 *     span, minus approved windows, scheduled break ranges, `{minutes}` break allowances and the rule set's
 *     `outOfOfficeAllowanceMinutes` (`lostMinutes`, flag LOST_TIME). FIRST_LAST ignores mid-day punches: nothing is lost.
 * A day without windows, allowances or gaps keeps every figure of the core calculation (the three new figures are 0).
 */
export function applyTimeOff(result: DailyCalculationResult, input: DailyCalculationInput): DailyCalculationResult {
  const unchanged: DailyCalculationResult = { ...result, excusedMinutes: 0, creditedMinutes: 0, lostMinutes: 0 };
  if (!WORKING_STATUSES.has(result.status)) return unchanged;
  const { rules, shift, timezone: zone, attendanceDate: date } = input;
  const window = computePunchWindow(shift, date, zone);
  const expStart = ms(result.expectedStartAt);
  const expEnd = ms(result.expectedEndAt);
  const span: Span | null = expStart !== null && expEnd !== null && expEnd > expStart ? { s: expStart, e: expEnd } : null;
  const steps: TraceStep[] = [];
  const flags = new Set<AttendanceFlag>(result.flags);

  // 1. the windows of the day
  const windows = timeOffSpans(input.timeOff ?? []);
  const relevant = windows.filter((w) => (span ? w.s < span.e && w.e > span.s : w.date === date));
  const allWin = union(relevant);
  const workWin = union(relevant.filter((w) => w.countsAsWork));
  const offWin = union(relevant.filter((w) => !w.countsAsWork));
  for (const w of relevant) flags.add(w.category === 'OFFICIAL' ? 'OFFICIAL_ASSIGNMENT' : w.category === 'REMOTE' ? 'REMOTE_WORK' : 'SHORT_LEAVE');
  if (relevant.length > 0) {
    steps.push({ step: 'timeOff.windows', detail: `${relevant.length} approved short leave window(s): ${relevant.map((w) => `${w.typeCode} ${iso(w.s)}–${iso(w.e)}${w.countsAsWork ? ' (work)' : ''}`).join(', ')}`, values: { windows: relevant.map((w) => ({ id: w.id, typeCode: w.typeCode, category: w.category, countsAsWork: w.countsAsWork, start: iso(w.s), end: iso(w.e) })) } });
  }

  // 2. reduced hours
  const allowances = result.scheduledMinutes > 0 ? [...(input.hourAllowances ?? [])].filter((a) => a.minutesPerDay > 0).sort((a, b) => a.id.localeCompare(b.id)) : [];
  const sumOf = (p: EngineHourAllowance['position']) => allowances.filter((a) => a.position === p).reduce((n, a) => n + a.minutesPerDay, 0);
  const startA = sumOf('START'); const endA = sumOf('END'); const eitherA = sumOf('EITHER');
  const reduce = Math.min(startA + endA + eitherA, result.scheduledMinutes);
  const scheduledMinutes = result.scheduledMinutes - reduce;
  let expectedStartAt = result.expectedStartAt;
  let expectedEndAt = result.expectedEndAt;
  if (reduce > 0) {
    flags.add('REDUCED_HOURS');
    if (window.kind === 'FIXED' && expStart !== null && startA > 0) expectedStartAt = iso(expStart + Math.min(startA, reduce) * MINUTE);
    if (window.kind === 'FIXED' && expEnd !== null && endA > 0) expectedEndAt = iso(expEnd - endA * MINUTE);
    if (window.kind === 'FLEXIBLE' && expEnd !== null) expectedEndAt = iso(expEnd - reduce * MINUTE);
    steps.push({ step: 'timeOff.reducedHours', detail: `reduced hours ${allowances.map((a) => `${a.kind} ${a.minutesPerDay} min (${a.position})`).join(', ')} → scheduled ${result.scheduledMinutes} → ${scheduledMinutes} min`, values: { allowances: allowances.map((a) => ({ id: a.id, kind: a.kind, minutesPerDay: a.minutesPerDay, position: a.position })), scheduledMinutes, expectedStartAt, expectedEndAt } });
  }

  // 3–4. credit and excused minutes against the punched work
  const punched = punchedWork(result, input);
  const complete = result.firstInAt !== null && result.lastOutAt !== null;
  const none = result.firstInAt === null && result.lastOutAt === null && result.workedMinutes === 0;
  const hoursKnown = complete || none;
  const creditedSpans = hoursKnown ? subtract(span ? clip(workWin, span) : workWin, punched.spans) : [];
  const creditedMinutes = minutesIn(creditedSpans);
  const excusedMinutes = span ? minutesIn(subtract(subtract(clip(offWin, span), punched.spans), workWin)) : 0;
  if (workWin.length > 0) steps.push({ step: 'timeOff.credit', detail: hoursKnown ? `${creditedMinutes} min of work-like short leave not overlapping punched work → credited to the worked minutes (${result.workedMinutes} → ${result.workedMinutes + creditedMinutes})` : 'punched hours unknown (missing punch) → nothing credited until the punch is corrected', values: { creditedMinutes, hoursKnown } });
  if (offWin.length > 0) steps.push({ step: 'timeOff.excused', detail: `${excusedMinutes} scheduled min not worked are covered by approved short leave → excused`, values: { excusedMinutes } });
  const workedMinutes = result.workedMinutes + creditedMinutes;

  // lateness / early departure re-measured
  let lateMinutes = result.lateMinutes;
  let earlyDepartureMinutes = result.earlyDepartureMinutes;
  const graceIn = shift?.graceInMinutes ?? rules.graceInMinutes;
  const graceOut = shift?.graceOutMinutes ?? rules.graceOutMinutes;
  const firstIn = ms(result.firstInAt);
  const lastOut = ms(result.lastOutAt);
  let effectiveStart: number | null = null;
  if (lateMinutes > 0 && firstIn !== null && expStart !== null && (startA > 0 || allWin.length > 0)) {
    effectiveStart = advanceThrough(expStart + startA * MINUTE, allWin);
    const from = effectiveStart + graceIn * MINUTE;
    lateMinutes = Math.min(lateMinutes, firstIn > from ? minutesIn(subtract([{ s: from, e: firstIn }], allWin)) : 0);
  }
  if (earlyDepartureMinutes > 0 && lastOut !== null && expEnd !== null) {
    if (window.kind === 'FIXED' && (endA > 0 || allWin.length > 0)) {
      const until = retreatThrough(expEnd - endA * MINUTE, allWin) - graceOut * MINUTE;
      earlyDepartureMinutes = Math.min(earlyDepartureMinutes, lastOut < until ? minutesIn(subtract([{ s: lastOut, e: until }], allWin)) : 0);
    } else if (window.kind === 'FLEXIBLE' && startA + endA + creditedMinutes + excusedMinutes > 0) {
      // a required-hours day: the shortfall shrinks by the reduced minutes and the approved windows; the grace forgives a small rest
      const shortfall = Math.max(0, earlyDepartureMinutes - startA - endA - creditedMinutes - excusedMinutes);
      earlyDepartureMinutes = shortfall > graceOut ? shortfall : 0;
    }
  }
  if (eitherA > 0) {
    const forLate = Math.min(lateMinutes, eitherA);
    const forEarly = Math.min(earlyDepartureMinutes, eitherA - forLate);
    lateMinutes -= forLate;
    earlyDepartureMinutes -= forEarly;
    if (forLate + forEarly > 0) steps.push({ step: 'timeOff.either', detail: `reduced hours (EITHER ${eitherA} min) forgive ${forLate} min late, then ${forEarly} min early`, values: { forgivenLate: forLate, forgivenEarly: forEarly } });
  }
  if (lateMinutes !== result.lateMinutes) {
    if (lateMinutes <= rules.lateThresholdMinutes) { flags.delete('LATE'); flags.delete('VERY_LATE'); } else if (flags.has('VERY_LATE') && firstIn !== null) {
      const veryLateAfter = rules.policy.late.veryLateAfterMinutes;
      const from = effectiveStart ?? (expStart ?? firstIn);
      if (veryLateAfter === null || Math.round((firstIn - from) / MINUTE) <= veryLateAfter) flags.delete('VERY_LATE');
    }
  }
  if (earlyDepartureMinutes !== result.earlyDepartureMinutes && earlyDepartureMinutes <= rules.earlyDepartureThresholdMinutes) flags.delete('EARLY_DEPARTURE');
  if (lateMinutes !== result.lateMinutes || earlyDepartureMinutes !== result.earlyDepartureMinutes) {
    steps.push({ step: 'timeOff.punctuality', detail: `late ${result.lateMinutes} → ${lateMinutes} min, early departure ${result.earlyDepartureMinutes} → ${earlyDepartureMinutes} min (approved short leave / reduced hours)`, values: { lateMinutes, earlyDepartureMinutes, excusedLateMinutes: result.lateMinutes - lateMinutes, excusedEarlyMinutes: result.earlyDepartureMinutes - earlyDepartureMinutes, effectiveStart: effectiveStart === null ? null : iso(effectiveStart) } });
  }

  // 5. status
  let status: AttendanceStatus = result.status;
  const halfDayOff = input.leave?.isHalfDay === true || input.holiday?.isHalfDay === true;
  if ((creditedMinutes > 0 || excusedMinutes > 0 || reduce > 0) && !halfDayOff) {
    const now = input.now ? Date.parse(input.now) : null;
    const dayOver = now === null || now >= window.windowEnd.toMillis();
    const absentDay = none && (status === 'ABSENT' || (status === 'PENDING' && dayOver));
    if (window.kind === 'NONE') {
      if (absentDay && creditedMinutes > 0) status = 'PRESENT';
    } else {
      const base = baseScheduledMinutes(shift, window);
      const ratio = base > 0 ? scheduledMinutes / base : 1;
      const minFullDay = Math.round(rules.minFullDayMinutes * ratio);
      const halfDayThreshold = Math.round(rules.halfDayThresholdMinutes * ratio);
      const effective = workedMinutes + excusedMinutes;
      if (complete && (status === 'PRESENT' || status === 'HALF_DAY')) {
        status = effective < halfDayThreshold ? 'HALF_DAY' : 'PRESENT';
        if (effective < minFullDay) flags.add('UNDER_HOURS'); else flags.delete('UNDER_HOURS');
      } else if (absentDay) {
        if (effective >= minFullDay && effective > 0) status = 'PRESENT';
        else if (effective >= halfDayThreshold && effective > 0) { status = 'HALF_DAY'; flags.add('UNDER_HOURS'); }
      }
      if (status !== result.status || flags.has('UNDER_HOURS') !== result.flags.includes('UNDER_HOURS')) {
        steps.push({ step: 'timeOff.status', detail: `${workedMinutes} worked (incl. ${creditedMinutes} credited) + ${excusedMinutes} excused = ${effective} min vs full day ${minFullDay} / half day ${halfDayThreshold}${ratio !== 1 ? ` (× ${Math.round(ratio * 1000) / 1000})` : ''} → ${status}`, values: { status, previousStatus: result.status, effectiveMinutes: effective, minFullDayMinutes: minFullDay, halfDayThresholdMinutes: halfDayThreshold } });
      }
    }
  }

  // 6. lost time
  let lostMinutes = 0;
  if (span && punched.gaps.length > 0) {
    const gaps = clip(union(punched.gaps), span);
    const outside = minutesIn(gaps);
    const covered = minutesIn(intersect(gaps, allWin));
    const breakRanges = shift ? union(scheduledBreakRanges(shift, date, zone, window.crossesMidnight, span.s)) : [];
    const uncovered = subtract(subtract(gaps, allWin), breakRanges);
    const raw = minutesIn(uncovered);
    const breakAllowance = shift ? shift.breaks.reduce((n, b) => n + ('minutes' in b ? b.minutes : 0), 0) : 0;
    const allowance = rules.outOfOfficeAllowanceMinutes ?? 0;
    lostMinutes = Math.max(0, raw - breakAllowance - allowance);
    if (lostMinutes > 0) flags.add('LOST_TIME');
    if (outside > 0) {
      steps.push({ step: 'lostTime', detail: `${outside} min out of office inside the schedule − ${covered} min approved short leave − ${outside - covered - raw} min scheduled breaks = ${raw}; − ${breakAllowance} min break allowance − ${allowance} min tolerance → ${lostMinutes} min lost`, values: { outOfOfficeMinutes: outside, coveredMinutes: covered, uncoveredMinutes: raw, breakAllowanceMinutes: breakAllowance, allowanceMinutes: allowance, lostMinutes, gaps: gaps.map((g) => ({ start: iso(g.s), end: iso(g.e) })) } });
    }
  }

  if (steps.length === 0 && flags.size === result.flags.length) return unchanged;
  return {
    ...result,
    expectedStartAt, expectedEndAt, scheduledMinutes, workedMinutes, lateMinutes, earlyDepartureMinutes, status,
    flags: ATTENDANCE_FLAGS.filter((f) => flags.has(f)),
    excusedMinutes, creditedMinutes, lostMinutes,
    trace: { ...result.trace, steps: [...result.trace.steps, ...steps] },
  };
}

/* ------------------------------------------------------------------------------------------------ */

const WORKING_STATUSES: ReadonlySet<AttendanceStatus> = new Set(['PRESENT', 'ABSENT', 'HALF_DAY', 'MISSING_PUNCH', 'PENDING']);
const MINUTE = 60_000;

/** A half-open span of epoch milliseconds. */
export interface Span { s: number; e: number }
type WindowSpan = Span & Omit<EngineTimeOff, 'start' | 'end'>;

const ms = (v: string | null): number | null => (v === null ? null : Date.parse(v));
const iso = (v: number): string => new Date(v).toISOString().replace('.000Z', 'Z');

function timeOffSpans(windows: readonly EngineTimeOff[]): WindowSpan[] {
  return windows
    .map(({ start, end, ...rest }) => ({ ...rest, s: Date.parse(start), e: Date.parse(end) }))
    .filter((w) => Number.isFinite(w.s) && Number.isFinite(w.e) && w.e > w.s)
    .sort((a, b) => a.s - b.s || a.e - b.e || a.id.localeCompare(b.id));
}

/** Sorted, merged spans. */
export function union(spans: readonly Span[]): Span[] {
  const sorted = spans.filter((x) => x.e > x.s).map((x) => ({ s: x.s, e: x.e })).sort((a, b) => a.s - b.s || a.e - b.e);
  const out: Span[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.s <= last.e) last.e = Math.max(last.e, x.e);
    else out.push(x);
  }
  return out;
}
/** `a` minus every span of `b`. */
export function subtract(a: readonly Span[], b: readonly Span[]): Span[] {
  let out = union(a);
  for (const cut of union(b)) {
    out = out.flatMap((x) => (cut.e <= x.s || cut.s >= x.e ? [x] : [
      ...(cut.s > x.s ? [{ s: x.s, e: cut.s }] : []),
      ...(cut.e < x.e ? [{ s: cut.e, e: x.e }] : []),
    ]));
  }
  return out;
}
export function intersect(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const x of union(a)) for (const y of union(b)) { const s = Math.max(x.s, y.s); const e = Math.min(x.e, y.e); if (e > s) out.push({ s, e }); }
  return union(out);
}
const clip = (a: readonly Span[], bound: Span): Span[] => intersect(a, [bound]);
export const minutesIn = (spans: readonly Span[]): number => Math.round(union(spans).reduce((n, x) => n + (x.e - x.s), 0) / MINUTE);

/** The expected start, moved past every window that covers it (a permission at the start of the day). */
function advanceThrough(at: number, windows: readonly Span[]): number {
  let t = at;
  for (const w of windows) if (w.s <= t && w.e > t) t = w.e;
  return t;
}
/** The expected end, moved before every window that covers it (a permission at the end of the day). */
function retreatThrough(at: number, windows: readonly Span[]): number {
  let t = at;
  for (const w of [...windows].reverse()) if (w.s < t && w.e >= t) t = w.s;
  return t;
}

/**
 * The punched work of the day, as the core measured it: the closed work segments (the first starting at the rounded first IN,
 * the last ending at the rounded last OUT) minus explicit break spans, and the out-of-office gaps between consecutive segments
 * (none in FIRST_LAST, which ignores mid-day punches). The interpretation is re-run on the events attributed to the date — the
 * same pure functions with the same inputs, so it is the core's own.
 */
function punchedWork(result: DailyCalculationResult, input: DailyCalculationInput): { spans: Span[]; gaps: Span[] } {
  const ids = new Set(result.eventIds);
  const attributed = input.events.filter((e) => ids.has(e.id));
  if (attributed.length === 0) return { spans: [], gaps: [] };
  const collapse = collapseDuplicates(attributed, input.rules.duplicatePunchWindowSeconds);
  const interpretation = interpretPunches(collapse.kept, input.rules.punchInterpretation, input.timezone, collapse.duplicates);
  const closed: Span[] = [];
  for (const x of interpretation.segments) if (x.end !== null) closed.push({ s: x.start.toMillis(), e: x.end.toMillis() });
  const gaps: Span[] = [];
  for (let i = 1; i < closed.length; i += 1) {
    const prev = closed[i - 1]!; const cur = closed[i]!;
    if (cur.s > prev.e) gaps.push({ s: prev.e, e: cur.s });
  }
  const firstIn = ms(result.firstInAt);
  const lastOut = ms(result.lastOutAt);
  if (firstIn === null || lastOut === null || lastOut <= firstIn) return { spans: [], gaps };
  const segments = closed.length === 0 ? [{ s: firstIn, e: lastOut }] : closed.map((x, i) => ({ s: i === 0 ? firstIn : x.s, e: i === closed.length - 1 ? lastOut : x.e }));
  const breaks = interpretation.breakSpans.map((b) => ({ s: b.start.toMillis(), e: b.end.toMillis() }));
  return { spans: subtract(segments, breaks), gaps };
}

/** Scheduled minutes of a normal full day on the shift (before Ramadan / half-day / reduced hours): the ratio's base. */
function baseScheduledMinutes(shift: EngineShift | null, window: PunchWindow): number {
  if (!shift) return 0;
  if (window.kind === 'FIXED') return Math.max(0, minutesBetween(window.scheduledStart, window.scheduledEnd) - scheduledBreakMinutes(shift.breaks).unpaid);
  if (window.kind === 'FLEXIBLE') return Math.max(0, shift.requiredMinutes ?? 0);
  return 0;
}

/** The shift's `{start, end}` break ranges on the date (a cross-midnight shift may schedule them after midnight). */
function scheduledBreakRanges(shift: EngineShift, date: string, zone: string, crossesMidnight: boolean, spanStart: number): Span[] {
  const out: Span[] = [];
  for (const b of shift.breaks) {
    if ('minutes' in b) continue;
    const start = localInstant(date, b.start, zone);
    let end = localInstant(date, b.end, zone);
    if (end <= start) end = localInstant(date, b.end, zone, 1);
    const shiftDay = crossesMidnight && end.toMillis() <= spanStart;
    out.push({ s: (shiftDay ? start.plus({ days: 1 }) : start).toMillis(), e: (shiftDay ? end.plus({ days: 1 }) : end).toMillis() });
  }
  return out;
}
