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
  /** True when the interpretation produced any measured gap information (PAIRED/DIRECTIONAL with ≥ 2 segments or BREAK_* events). */
  hasMeasuredBreaks: boolean;
}

export interface DuplicateCollapse {
  kept: EngineEvent[];
  duplicates: Array<{ event: EngineEvent; of: EngineEvent; secondsApart: number }>;
}

/**
 * Collapse repeated punches within `windowSeconds` of the last kept punch (§G.4). The first punch wins.
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

/** Interpret already de-duplicated, chronologically attributable punches under the rule set's mode. */
export function interpretPunches(events: readonly EngineEvent[], mode: PunchInterpretation, zone: string): Interpretation {
  const ordered = sortEvents(events).map((event) => ({ event, at: parseInstant(event.punchedAt, zone) }));
  if (mode === 'DIRECTIONAL') {
    const directed = ordered.some((p) => p.event.eventType !== 'PUNCH');
    return directed ? interpretDirectional(ordered) : { ...interpretPaired(ordered), mode, effectiveMode: 'PAIRED' };
  }
  if (mode === 'PAIRED') return interpretPaired(ordered);
  return interpretFirstLast(ordered);
}

type Timed = { event: EngineEvent; at: DateTime };

function interpretFirstLast(ordered: readonly Timed[]): Interpretation {
  const punches: InterpretedPunch[] = [];
  if (ordered.length === 0) return empty('FIRST_LAST');
  if (ordered.length === 1) {
    const only = ordered[0] as Timed;
    const treatAsOut = only.event.eventType === 'PUNCH_OUT' || only.event.eventType === 'BREAK_END';
    punches.push({ ...only, role: treatAsOut ? 'OUT' : 'IN', note: treatAsOut ? 'single punch with OUT direction → OUT, IN missing' : 'single punch → IN, OUT missing' });
    return {
      ...empty('FIRST_LAST'),
      punches,
      firstIn: treatAsOut ? null : only.at,
      lastOut: treatAsOut ? only.at : null,
      missingIn: treatAsOut,
      missingOut: !treatAsOut,
    };
  }
  ordered.forEach((p, index) => {
    if (index === 0) punches.push({ ...p, role: 'IN', note: 'first punch in window' });
    else if (index === ordered.length - 1) punches.push({ ...p, role: 'OUT', note: 'last punch in window' });
    else punches.push({ ...p, role: 'IGNORED', note: 'intermediate punch (FIRST_LAST)' });
  });
  const first = ordered[0] as Timed;
  const last = ordered[ordered.length - 1] as Timed;
  return { ...empty('FIRST_LAST'), punches, firstIn: first.at, lastOut: last.at, segments: [{ start: first.at, end: last.at }] };
}

function interpretPaired(ordered: readonly Timed[]): Interpretation {
  const punches: InterpretedPunch[] = [];
  const segments: WorkSegment[] = [];
  let open: DateTime | null = null;
  ordered.forEach((p, index) => {
    if (index % 2 === 0) {
      punches.push({ ...p, role: 'IN', note: `pair ${index / 2 + 1} IN` });
      open = p.at;
    } else {
      punches.push({ ...p, role: 'OUT', note: `pair ${(index - 1) / 2 + 1} OUT` });
      if (open) segments.push({ start: open, end: p.at });
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
function interpretDirectional(ordered: readonly Timed[]): Interpretation {
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
    switch (type) {
      case 'PUNCH_IN':
        if (state === 'OUT') { startSegment(p.at); push('IN', 'device direction IN'); }
        else if (state === 'BREAK') { endBreak(p.at); push('BREAK_END', 'IN while on break → break end'); }
        else push('IGNORED', 'IN while already in');
        break;
      case 'PUNCH_OUT':
        if (state === 'IN') { endSegment(p.at); push('OUT', 'device direction OUT'); }
        else if (state === 'BREAK') { endBreak(p.at); endSegment(p.at); push('OUT', 'OUT while on break → break end + out'); }
        else if (segments.length === 0 && orphanOut === null) { missingIn = true; orphanOut = p.at; push('OUT', 'OUT without prior IN → IN missing'); }
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
        else if (state === 'IN') { endSegment(p.at); push('OUT', 'undirected punch while in → OUT'); }
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
  // An OUT without any IN: the day has an OUT instant but no IN; later full segments (if any) still govern.
  if (orphanOut !== null && result.lastOut === null) result.lastOut = orphanOut;
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
  const hasMeasuredBreaks = closed.length > 1 || breaks.some((b) => b.end !== null);
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
    hasMeasuredBreaks,
  };
}

function empty(mode: PunchInterpretation): Interpretation {
  return { mode, effectiveMode: mode, punches: [], firstIn: null, lastOut: null, missingIn: false, missingOut: false, segments: [], measuredBreakMinutes: 0, hasMeasuredBreaks: false };
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
