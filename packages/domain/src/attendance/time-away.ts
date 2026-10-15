import type { DateTime } from 'luxon';
import type { AttendancePolicySections, AwayIntervalKind, PunchInterpretation, ShiftBreak } from '@flowza/contracts';
import type { Interpretation } from './interpret.js';
import { parseInstant, toUtcIso } from './window.js';

/**
 * Time away inside the working day (engine 1.5.0, docs/time-away.md).
 *
 * Between the first check-in and the last check-out an employee may leave the site and come back: an OUT → IN pair on a
 * two-way terminal (or on separate exit / entry terminals), or a break-out → back (the portal's "Step out" followed by a
 * check-in on an entry-only terminal or the portal's "I'm back"). Every such gap is MEASURED by the punch interpretation
 * (`segments` gaps + `breakSpans`) and CLASSIFIED here against the employee's APPROVED time-away windows:
 *
 *   SHORT       a gap under `ignoreUnderMinutes` (a step outside the reader's reach) — stays worked time;
 *   OFFICIAL    inside an approved OFFICIAL window (+ `returnGraceMinutes` after its end) — worked when the policy says so;
 *   PERMISSION  inside an approved PERSONAL window (+ grace) — excused, unpaid;
 *   BREAK       the rest, up to the shift's break allowance (every break of the shift, paid or not), in time order;
 *   UNAPPROVED  whatever is left — unpaid, flagged UNAPPROVED_AWAY beyond `flagUnapprovedAfterMinutes`.
 *
 * Pure and deterministic: no clock, no IO. FIRST_LAST keeps only the first and the last punch, so it never measures a gap:
 * time away needs PAIRED or DIRECTIONAL (`timeAwayActive`).
 */

/** An APPROVED time-away request window of the employee overlapping the day (loaded by the worker). */
export interface EngineTimeAway {
  id: string;
  kind: 'OFFICIAL' | 'PERSONAL';
  startsAt: string; // UTC ISO
  endsAt: string;   // UTC ISO
}

export type TimeAwayPolicy = AttendancePolicySections['timeAway'];

export interface ClassifiedAway {
  kind: AwayIntervalKind;
  start: DateTime;
  end: DateTime;
  minutes: number;
  requestId: string | null;
}

export interface TimeAwayClassification {
  intervals: ClassifiedAway[];
  /** Every measured away minute between the first IN and the last OUT (breaks and short gaps included). */
  awayMinutes: number;
  shortMinutes: number;
  officialMinutes: number;
  permissionMinutes: number;
  breakMinutes: number;
  unapprovedMinutes: number;
}

export const EMPTY_TIME_AWAY: TimeAwayClassification = { intervals: [], awayMinutes: 0, shortMinutes: 0, officialMinutes: 0, permissionMinutes: 0, breakMinutes: 0, unapprovedMinutes: 0 };

/** Why time away is not measured for a day, or null when it is. */
export function timeAwayInactiveReason(policy: TimeAwayPolicy, mode: PunchInterpretation): 'DISABLED' | 'FIRST_LAST_INTERPRETATION' | null {
  if (!policy.enabled) return 'DISABLED';
  if (mode === 'FIRST_LAST') return 'FIRST_LAST_INTERPRETATION';
  return null;
}

/** True when the day's policy measures time away under this punch interpretation. */
export function timeAwayActive(policy: TimeAwayPolicy, mode: PunchInterpretation): boolean {
  return timeAwayInactiveReason(policy, mode) === null;
}

/** The shift's break allowance in minutes: every break, paid or unpaid, fixed-length or scheduled range. */
export function breakAllowanceMinutes(breaks: readonly ShiftBreak[]): number {
  let total = 0;
  for (const b of breaks) {
    if ('minutes' in b) total += b.minutes;
    else {
      const [sh, sm] = b.start.split(':').map(Number) as [number, number];
      const [eh, em] = b.end.split(':').map(Number) as [number, number];
      const s = sh * 60 + sm;
      const e = eh * 60 + em;
      total += e >= s ? e - s : e + 1440 - s;
    }
  }
  return total;
}

type Span = { start: DateTime; end: DateTime };

/**
 * The measured away intervals of an interpretation, in time order: the gaps between consecutive CLOSED work segments
 * (an OUT and the next IN) and the explicit BREAK_START → BREAK_END spans. An open break (stepped out, not back yet) is not
 * an interval until it closes. `includeOpenTail`: also the gap before a trailing OPEN segment (back on site, not checked
 * out yet) — for a day still in progress; a finished day ends at its last closed OUT, so that gap lies outside it.
 */
export function awayIntervalsOf(interpretation: Pick<Interpretation, 'segments' | 'breakSpans'>, opts: { includeOpenTail?: boolean } = {}): Span[] {
  const last = interpretation.segments[interpretation.segments.length - 1];
  const tail = opts.includeOpenTail && last && last.end === null ? last : null;
  const closed = [...interpretation.segments.filter((s): s is Span => s.end !== null), ...(tail ? [{ start: tail.start, end: tail.start }] : [])];
  const out: Span[] = [];
  for (let i = 1; i < closed.length; i += 1) {
    const prev = closed[i - 1] as Span;
    const cur = closed[i] as Span;
    if (cur.start > prev.end) out.push({ start: prev.end, end: cur.start });
  }
  for (const b of interpretation.breakSpans) if (b.end > b.start) out.push({ start: b.start, end: b.end });
  return out.sort((a, b) => a.start.toMillis() - b.start.toMillis());
}

const minutesOf = (s: Span): number => s.end.diff(s.start, 'minutes').minutes;

/** Split `span` by the windows: covered pieces (with their window) and the uncovered rest, all in time order. */
function splitByWindows(span: Span, windows: ReadonlyArray<{ start: DateTime; end: DateTime; request: EngineTimeAway }>): Array<{ start: DateTime; end: DateTime; request: EngineTimeAway | null }> {
  let rest: Span[] = [span];
  const covered: Array<{ start: DateTime; end: DateTime; request: EngineTimeAway }> = [];
  for (const w of windows) {
    const next: Span[] = [];
    for (const r of rest) {
      const s = w.start > r.start ? w.start : r.start;
      const e = w.end < r.end ? w.end : r.end;
      if (e <= s) { next.push(r); continue; }
      covered.push({ start: s, end: e, request: w.request });
      if (s > r.start) next.push({ start: r.start, end: s });
      if (e < r.end) next.push({ start: e, end: r.end });
    }
    rest = next;
  }
  return [...covered, ...rest.map((r) => ({ ...r, request: null }))].sort((a, b) => a.start.toMillis() - b.start.toMillis());
}

/** Classify the measured away intervals of a day (see the module comment). Minutes are rounded per piece. */
export function classifyTimeAway(params: {
  intervals: readonly Span[];
  windows: readonly EngineTimeAway[];
  zone: string;
  policy: TimeAwayPolicy;
  breakAllowanceMinutes: number;
}): TimeAwayClassification {
  const { policy, zone } = params;
  const windows = [...params.windows]
    .map((request) => ({ start: parseInstant(request.startsAt, zone), end: parseInstant(request.endsAt, zone).plus({ minutes: policy.returnGraceMinutes }), request }))
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start.toMillis() - b.start.toMillis() || a.request.id.localeCompare(b.request.id));
  let allowance = Math.max(0, params.breakAllowanceMinutes);
  const intervals: ClassifiedAway[] = [];
  const push = (kind: AwayIntervalKind, start: DateTime, end: DateTime, requestId: string | null): void => {
    const minutes = Math.round(end.diff(start, 'minutes').minutes);
    if (minutes <= 0 && end <= start) return;
    intervals.push({ kind, start, end, minutes, requestId });
  };
  for (const span of params.intervals) {
    if (minutesOf(span) < policy.ignoreUnderMinutes) { push('SHORT', span.start, span.end, null); continue; }
    for (const piece of splitByWindows(span, windows)) {
      if (piece.request) { push(piece.request.kind === 'OFFICIAL' ? 'OFFICIAL' : 'PERMISSION', piece.start, piece.end, piece.request.id); continue; }
      // uncovered: the break allowance first (in time order), the rest unapproved
      const pieceMinutes = minutesOf(piece);
      if (allowance > 0) {
        const asBreak = Math.min(allowance, pieceMinutes);
        const breakEnd = piece.start.plus({ minutes: asBreak });
        push('BREAK', piece.start, breakEnd, null);
        allowance -= asBreak;
        if (breakEnd < piece.end) push('UNAPPROVED', breakEnd, piece.end, null);
      } else push('UNAPPROVED', piece.start, piece.end, null);
    }
  }
  const sum = (kind: AwayIntervalKind): number => intervals.filter((i) => i.kind === kind).reduce((a, i) => a + i.minutes, 0);
  return {
    intervals,
    awayMinutes: intervals.reduce((a, i) => a + i.minutes, 0),
    shortMinutes: sum('SHORT'),
    officialMinutes: sum('OFFICIAL'),
    permissionMinutes: sum('PERMISSION'),
    breakMinutes: sum('BREAK'),
    unapprovedMinutes: sum('UNAPPROVED'),
  };
}

/** The intervals as the trace stores them (UTC ISO), which the API reads back for the portal and the reports. */
export function traceAwayIntervals(c: TimeAwayClassification): Array<{ kind: AwayIntervalKind; startAt: string; endAt: string; minutes: number; requestId: string | null }> {
  return c.intervals.map((i) => ({ kind: i.kind, startAt: toUtcIso(i.start), endAt: toUtcIso(i.end), minutes: i.minutes, requestId: i.requestId }));
}
