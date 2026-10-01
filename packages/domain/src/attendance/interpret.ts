import type { DateTime } from 'luxon';
import type { AttendanceEventType, PunchInterpretation, ShiftBreak } from '@flowza/contracts';
import { timeToMinutes } from '@flowza/shared';
import { sortEvents } from './attribute.js';
import type { EngineEvent } from './types.js';
import { localInstant, parseInstant } from './window.js';

export type PunchRole = 'IN' | 'OUT' | 'BREAK_START' | 'BREAK_END' | 'IGNORED' | 'DUPLICATE';

export interface InterpretedPunch {
  event: EngineEvent;
  at: DateTime;
  role: PunchRole;
  note: string;
}

export interface WorkSegment { start: DateTime; end: DateTime | null }
export interface BreakSegment { start: DateTime; end: DateTime | null }

export interface Interpretation {
  mode: PunchInterpretation;
  /** Effective mode after DIRECTIONAL falls back to PAIRED for fully undirected input. */
  effectiveMode: PunchInterpretation;
  punches: InterpretedPunch[];
  firstIn: DateTime | null;
  lastOut: DateTime | null;
  missingIn: boolean;
  missingOut: boolean;
  /** Closed work segments (IN → OUT) in order. */
  segments: WorkSegment[];
  /** Measured, unpaid-by-default break minutes (gaps between segments + explicit BREAK_* spans). */
  measuredBreakMinutes: number;
  /** The explicit BREAK_START → BREAK_END spans (DIRECTIONAL), closed ones only — inside the segments they interrupt. */
  breakSpans: Array<{ start: DateTime; end: DateTime }>;
  /** True when the interpretation produced any measured gap information (PAIRED/DIRECTIONAL with ≥ 2 segments or BREAK_* events). */
  hasMeasuredBreaks: boolean;
}

export interface DuplicateCollapse {
  kept: EngineEvent[];
  duplicates: Array<{ event: EngineEvent; of: EngineEvent; secondsApart: number }>;
}

/**
 * Collapse repeated punches within `windowSeconds` of the last kept punch (§G.4). The first punch of a burst
 * is kept here; `interpretPunches` then moves an OUT to the burst's LATEST punch, so a day's IN is the
 * earliest tap and its OUT the latest one.
 * Two punches count as repeats when they carry the same direction, or when either is an undirected
 * `PUNCH` (a double tap on a device that cannot report direction). A PUNCH_IN followed by a PUNCH_OUT
 * seconds later is kept — the device explicitly reported two directions.
 */
export function collapseDuplicates(events: readonly EngineEvent[], windowSeconds: number): DuplicateCollapse {
  const kept: EngineEvent[] = [];
  const duplicates: DuplicateCollapse['duplicates'] = [];
  let last: EngineEvent | undefined;
  for (const event of sortEvents(events)) {
    if (last && windowSeconds > 0) {
      const secondsApart = (Date.parse(event.punchedAt) - Date.parse(last.punchedAt)) / 1000;
      if (secondsApart <= windowSeconds && sameDirection(last.eventType, event.eventType)) {
        duplicates.push({ event, of: last, secondsApart });
        continue;
      }
    }
    kept.push(event);
    last = event;
  }
  return { kept, duplicates };
}

function sameDirection(a: AttendanceEventType, b: AttendanceEventType): boolean {
  return a === b || a === 'PUNCH' || b === 'PUNCH';
}

/**
 * Interpret already de-duplicated, chronologically attributable punches under the rule set's mode.
 *
 * Pass the `duplicates` from `collapseDuplicates` so an OUT takes the LATEST punch of its burst: an employee
 * who taps OUT at 19:47:05 and again at 19:47:08 left at 19:47:08 — the day's OUT is the maximum punch, not
 * the first tap of the last burst. The role is still decided by the burst's first punch (its direction), only
 * the instant moves; an IN keeps the earliest tap. Every repeat lies between its burst's first punch and the
 * next kept punch, so moving the OUT never reorders anything.
 */
export function interpretPunches(
  events: readonly EngineEvent[],
  mode: PunchInterpretation,
  zone: string,
  duplicates: DuplicateCollapse['duplicates'] = [],
): Interpretation {
  const ordered = sortEvents(events).map((event) => ({ event, at: parseInstant(event.punchedAt, zone) }));
  const latest = latestRepeats(duplicates);
  const outOf = (p: Timed): Timed => {
    const repeat = latest.get(p.event.id);
    return repeat ? { event: repeat, at: parseInstant(repeat.punchedAt, zone) } : p;
  };
  if (mode === 'DIRECTIONAL') {
    const directed = ordered.some((p) => p.event.eventType !== 'PUNCH');
    return directed ? interpretDirectional(ordered, outOf) : { ...interpretPaired(ordered, outOf), mode, effectiveMode: 'PAIRED' };
  }
  if (mode === 'PAIRED') return interpretPaired(ordered, outOf);
  return interpretFirstLast(ordered, outOf);
}

type Timed = { event: EngineEvent; at: DateTime };
/** The punch an OUT is recorded at: the latest repeat of the burst `p` opens, or `p` itself. */
type OutOf = (p: Timed) => Timed;

/** Kept punch id → the latest punch collapsed into it. */
function latestRepeats(duplicates: DuplicateCollapse['duplicates']): Map<string, EngineEvent> {
  const latest = new Map<string, EngineEvent>();
  for (const d of duplicates) {
    const current = latest.get(d.of.id);
    if (!current || sortEvents([current, d.event])[1] === d.event) latest.set(d.of.id, d.event);
  }
  return latest;
}

/**
 * Duplicates restated against the punch the day actually uses. When an OUT moved to the latest punch of its
 * burst, the burst's first punch becomes a duplicate of that latest punch (negative `secondsApart`: it came
 * before it) and every other repeat is measured from it too. Bursts that stayed on their first punch are
 * returned unchanged.
 */
export function duplicatesAgainstUsedPunch(
  duplicates: DuplicateCollapse['duplicates'],
  interpretation: Pick<Interpretation, 'punches'>,
): DuplicateCollapse['duplicates'] {
  const firstOf = new Map(duplicates.map((d) => [d.event.id, d.of]));
  const usedFor = new Map<string, EngineEvent>(); // burst first punch id → the repeat the OUT moved to
  for (const p of interpretation.punches) {
    const first = firstOf.get(p.event.id);
    if (first) usedFor.set(first.id, p.event);
  }
  if (usedFor.size === 0) return duplicates;
  const restated: DuplicateCollapse['duplicates'] = [];
  for (const d of duplicates) {
    const used = usedFor.get(d.of.id);
    if (!used) restated.push(d);
    else if (d.event.id === used.id) restated.push({ event: d.of, of: used, secondsApart: -d.secondsApart });
    else restated.push({ event: d.event, of: used, secondsApart: (Date.parse(d.event.punchedAt) - Date.parse(used.punchedAt)) / 1000 });
  }
  const order = new Map(sortEvents(restated.map((d) => d.event)).map((e, i) => [e.id, i]));
  return restated.sort((a, b) => (order.get(a.event.id) ?? 0) - (order.get(b.event.id) ?? 0));
}

function interpretFirstLast(ordered: readonly Timed[], outOf: OutOf): Interpretation {
  const punches: InterpretedPunch[] = [];
  if (ordered.length === 0) return empty('FIRST_LAST');
  if (ordered.length === 1) {
    const only = ordered[0] as Timed;
    const treatAsOut = only.event.eventType === 'PUNCH_OUT' || only.event.eventType === 'BREAK_END';
    const used = treatAsOut ? outOf(only) : only;
    punches.push({ ...used, role: treatAsOut ? 'OUT' : 'IN', note: treatAsOut ? 'single punch with OUT direction → OUT, IN missing' : 'single punch → IN, OUT missing' });
    return {
      ...empty('FIRST_LAST'),
      punches,
      firstIn: treatAsOut ? null : used.at,
      lastOut: treatAsOut ? used.at : null,
      missingIn: treatAsOut,
      missingOut: !treatAsOut,
    };
  }
  const first = ordered[0] as Timed;
  const last = outOf(ordered[ordered.length - 1] as Timed);
  ordered.forEach((p, index) => {
    if (index === 0) punches.push({ ...p, role: 'IN', note: 'first punch in window' });
    else if (index === ordered.length - 1) punches.push({ ...last, role: 'OUT', note: 'last punch in window' });
    else punches.push({ ...p, role: 'IGNORED', note: 'intermediate punch (FIRST_LAST)' });
  });
  return { ...empty('FIRST_LAST'), punches, firstIn: first.at, lastOut: last.at, segments: [{ start: first.at, end: last.at }] };
}

function interpretPaired(ordered: readonly Timed[], outOf: OutOf): Interpretation {
  const punches: InterpretedPunch[] = [];
  const segments: WorkSegment[] = [];
  let open: DateTime | null = null;
  ordered.forEach((p, index) => {
    if (index % 2 === 0) {
      punches.push({ ...p, role: 'IN', note: `pair ${index / 2 + 1} IN` });
      open = p.at;
    } else {
      const out = outOf(p);
      punches.push({ ...out, role: 'OUT', note: `pair ${(index - 1) / 2 + 1} OUT` });
      if (open) segments.push({ start: open, end: out.at });
      open = null;
    }
  });
  const missingOut = open !== null;
  if (open) segments.push({ start: open, end: null });
  return finish('PAIRED', punches, segments, [], false, missingOut);
}

/**
 * State machine for DIRECTIONAL: OUT → (PUNCH_IN) → IN → (BREAK_START) → BREAK → (BREAK_END) → IN → (PUNCH_OUT) → OUT.
 * Undirected PUNCH toggles the state (IN when out, OUT when in, BREAK_END when on break).
 */
function interpretDirectional(ordered: readonly Timed[], outOf: OutOf): Interpretation {
  const punches: InterpretedPunch[] = [];
  const segments: WorkSegment[] = [];
  const breaks: BreakSegment[] = [];
  let state: 'OUT' | 'IN' | 'BREAK' = 'OUT';
  let currentSegment: WorkSegment | null = null;
  let currentBreak: BreakSegment | null = null;
  let missingIn = false;
  let orphanOut: DateTime | null = null;

  const startSegment = (at: DateTime): void => { currentSegment = { start: at, end: null }; segments.push(currentSegment); state = 'IN'; };
  const endSegment = (at: DateTime): void => { if (currentSegment) currentSegment.end = at; currentSegment = null; state = 'OUT'; };
  const startBreak = (at: DateTime): void => { currentBreak = { start: at, end: null }; breaks.push(currentBreak); state = 'BREAK'; };
  const endBreak = (at: DateTime): void => { if (currentBreak) currentBreak.end = at; currentBreak = null; state = 'IN'; };

  ordered.forEach((p) => {
    const type = p.event.eventType;
    const push = (role: PunchRole, note: string): void => { punches.push({ ...p, role, note }); };
    // An OUT is recorded at the latest punch of its burst; the burst's first punch decided the direction.
    const pushOut = (note: string): DateTime => { const out = outOf(p); punches.push({ ...out, role: 'OUT', note }); return out.at; };
    switch (type) {
      case 'PUNCH_IN':
        if (state === 'OUT') { startSegment(p.at); push('IN', 'device direction IN'); }
        else if (state === 'BREAK') { endBreak(p.at); push('BREAK_END', 'IN while on break → break end'); }
        else push('IGNORED', 'IN while already in');
        break;
      case 'PUNCH_OUT':
        if (state === 'IN') endSegment(pushOut('device direction OUT'));
        else if (state === 'BREAK') { const at = pushOut('OUT while on break → break end + out'); endBreak(at); endSegment(at); }
        else if (segments.length === 0 && orphanOut === null) { missingIn = true; orphanOut = pushOut('OUT without prior IN → IN missing'); }
        else push('IGNORED', 'OUT while already out');
        break;
      case 'BREAK_START':
        if (state === 'IN') { startBreak(p.at); push('BREAK_START', 'device direction break start'); }
        else push('IGNORED', `break start while ${state.toLowerCase()}`);
        break;
      case 'BREAK_END':
        if (state === 'BREAK') { endBreak(p.at); push('BREAK_END', 'device direction break end'); }
        else push('IGNORED', `break end while ${state.toLowerCase()}`);
        break;
      case 'PUNCH':
        if (state === 'OUT') { startSegment(p.at); push('IN', 'undirected punch while out → IN'); }
        else if (state === 'IN') endSegment(pushOut('undirected punch while in → OUT'));
        else { endBreak(p.at); push('BREAK_END', 'undirected punch while on break → break end'); }
        break;
      default: {
        const exhaustive: never = type;
        return exhaustive;
      }
    }
  });
  const missingOut = state !== 'OUT';
  const result = finish('DIRECTIONAL', punches, segments, breaks, missingIn, missingOut);
  // A lone OUT without any IN is the day's OUT instant. Once a later IN opened a segment the orphan is only
  // evidence of the missing IN: reporting it as lastOut would put the OUT before the IN (negative span).
  if (orphanOut !== null && segments.length === 0) result.lastOut = orphanOut;
  return result;
}

function finish(mode: PunchInterpretation, punches: InterpretedPunch[], segments: WorkSegment[], breaks: BreakSegment[], missingIn: boolean, missingOut: boolean): Interpretation {
  const firstIn = segments[0]?.start ?? null;
  const closed = segments.filter((s): s is { start: DateTime; end: DateTime } => s.end !== null);
  const lastOut = closed.length > 0 ? (closed[closed.length - 1] as { end: DateTime }).end : null;
  let gapMinutes = 0;
  for (let i = 1; i < closed.length; i += 1) {
    const prev = closed[i - 1] as { end: DateTime };
    const cur = closed[i] as { start: DateTime };
    gapMinutes += Math.max(0, cur.start.diff(prev.end, 'minutes').minutes);
  }
  let breakMinutes = 0;
  for (const b of breaks) if (b.end) breakMinutes += Math.max(0, b.end.diff(b.start, 'minutes').minutes);
  const breakSpans = breaks.filter((b): b is { start: DateTime; end: DateTime } => b.end !== null);
  const hasMeasuredBreaks = closed.length > 1 || breakSpans.length > 0;
  return {
    mode,
    effectiveMode: mode,
    punches,
    firstIn,
    lastOut,
    missingIn,
    missingOut,
    segments,
    measuredBreakMinutes: Math.round(gapMinutes + breakMinutes),
    breakSpans,
    hasMeasuredBreaks,
  };
}

function empty(mode: PunchInterpretation): Interpretation {
  return { mode, effectiveMode: mode, punches: [], firstIn: null, lastOut: null, missingIn: false, missingOut: false, segments: [], measuredBreakMinutes: 0, breakSpans: [], hasMeasuredBreaks: false };
}

/* ------------------------------------------------------------------------------------------------ */
/* Breaks                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

export interface BreakComputation {
  /** Minutes deducted from the worked span. */
  unpaidMinutes: number;
  /** Break minutes that stay paid (informational). */
  paidMinutes: number;
  source: 'MEASURED' | 'FIXED' | 'NONE';
  detail: string;
}

/** Sum of `{minutes}` breaks and scheduled `{start,end}` ranges, split by paid flag, for a shift on a date. */
export function scheduledBreakMinutes(breaks: readonly ShiftBreak[]): { paid: number; unpaid: number } {
  let paid = 0;
  let unpaid = 0;
  for (const b of breaks) {
    const minutes = 'minutes' in b ? b.minutes : rangeMinutes(b.start, b.end);
    if (b.paid) paid += minutes;
    else unpaid += minutes;
  }
  return { paid, unpaid };
}

function rangeMinutes(start: string, end: string): number {
  const s = timeToMinutes(start);
  const e = timeToMinutes(end);
  return e >= s ? e - s : e + 1440 - s;
}

/**
 * Break minutes to deduct from `[firstIn, lastOut]` (§G.5).
 *
 * - Measured breaks (PAIRED/DIRECTIONAL gaps or BREAK_* spans) take precedence over shift-defined breaks so
 *   the same pause is never deducted twice; paid `{minutes}` allowances from the shift are credited back
 *   against the measured total.
 * - Otherwise fixed `{minutes}` breaks are deducted in full (clamped to the worked span) and scheduled
 *   `{start,end}` ranges are deducted only for the part that overlaps the worked span — an employee who left
 *   before lunch does not lose lunch.
 */
export function computeBreaks(params: {
  breaks: readonly ShiftBreak[];
  interpretation: Pick<Interpretation, 'measuredBreakMinutes' | 'hasMeasuredBreaks'>;
  firstIn: DateTime | null;
  lastOut: DateTime | null;
  attendanceDate: string;
  zone: string;
  crossesMidnight: boolean;
}): BreakComputation {
  const { breaks, interpretation, firstIn, lastOut } = params;
  if (!firstIn || !lastOut || lastOut <= firstIn) return { unpaidMinutes: 0, paidMinutes: 0, source: 'NONE', detail: 'no worked span' };
  const span = Math.round(lastOut.diff(firstIn, 'minutes').minutes);

  if (interpretation.hasMeasuredBreaks) {
    const paidAllowance = breaks.reduce((sum, b) => sum + ('minutes' in b && b.paid ? b.minutes : 0), 0);
    const measured = interpretation.measuredBreakMinutes;
    const paid = Math.min(measured, paidAllowance);
    return { unpaidMinutes: Math.min(span, measured - paid), paidMinutes: paid, source: 'MEASURED', detail: `measured ${measured} min, paid allowance ${paidAllowance} min` };
  }

  let unpaid = 0;
  let paid = 0;
  const notes: string[] = [];
  for (const b of breaks) {
    let minutes: number;
    if ('minutes' in b) {
      minutes = b.minutes;
      notes.push(`${b.paid ? 'paid' : 'unpaid'} fixed ${minutes} min`);
    } else {
      const start = localInstant(params.attendanceDate, b.start, params.zone);
      let end = localInstant(params.attendanceDate, b.end, params.zone);
      if (end <= start) end = localInstant(params.attendanceDate, b.end, params.zone, 1);
      // Cross-midnight shifts may schedule the break after midnight: shift the range forward when it falls before the IN.
      const [rs, re] = params.crossesMidnight && end <= firstIn ? [start.plus({ days: 1 }), end.plus({ days: 1 })] : [start, end];
      const overlapStart = rs > firstIn ? rs : firstIn;
      const overlapEnd = re < lastOut ? re : lastOut;
      minutes = overlapEnd > overlapStart ? Math.round(overlapEnd.diff(overlapStart, 'minutes').minutes) : 0;
      notes.push(`${b.paid ? 'paid' : 'unpaid'} ${b.start}-${b.end} overlap ${minutes} min`);
    }
    if (b.paid) paid += minutes;
    else unpaid += minutes;
  }
  if (breaks.length === 0) return { unpaidMinutes: 0, paidMinutes: 0, source: 'NONE', detail: 'shift defines no breaks' };
  return { unpaidMinutes: Math.min(span, unpaid), paidMinutes: paid, source: 'FIXED', detail: notes.join('; ') };
}
