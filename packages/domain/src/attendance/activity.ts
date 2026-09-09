/**
 * Activity segments (§G.5, presentation of the calculated day).
 *
 * A daily record already knows *how much* the employee worked; the activity view needs to know *when*. The engine's
 * trace records every attributed punch with the role it was given, so the same interpretation that produced
 * `worked_minutes` also produces the spans: an IN (or a BREAK_END) opens an in-office span, an OUT (or a BREAK_START)
 * closes it, and the time between two in-office spans is time the employee was away between the first and the last
 * punch of the day — field work, a client visit or a break.
 *
 * Pure: no IO, no clock. Everything is UTC ISO in, UTC ISO out.
 */

export type ActivitySegmentKind = 'OFFICE' | 'FIELD';

export interface ActivitySegment {
  kind: ActivitySegmentKind;
  startAt: string;
  /** null on a span the employee has not closed yet (an IN with no matching OUT). */
  endAt: string | null;
  /** 0 on an open span — its length is not known until the employee punches out. */
  minutes: number;
}

/** A trace punch as it is stored (every field optional: old and partial traces still have to render). */
export interface ActivityPunchLike {
  punchedAt?: string | null;
  role?: string | null;
  eventId?: string | null;
}

/** Roles that put the employee inside, and roles that take them back out. Anything else is not a state change. */
const OPENS: ReadonlySet<string> = new Set(['IN', 'BREAK_END']);
const CLOSES: ReadonlySet<string> = new Set(['OUT', 'BREAK_START']);

interface Instant {
  iso: string;
  ms: number;
}

function parse(punches: readonly ActivityPunchLike[]): Array<Instant & { opens: boolean }> {
  const out: Array<Instant & { opens: boolean }> = [];
  for (const p of punches) {
    const role = typeof p?.role === 'string' ? p.role : '';
    const iso = typeof p?.punchedAt === 'string' ? p.punchedAt : '';
    if (!iso || (!OPENS.has(role) && !CLOSES.has(role))) continue;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) continue;
    out.push({ iso, ms, opens: OPENS.has(role) });
  }
  return out.sort((a, b) => a.ms - b.ms);
}

function span(kind: ActivitySegmentKind, from: Instant, to: Instant): ActivitySegment {
  return { kind, startAt: from.iso, endAt: to.iso, minutes: Math.round((to.ms - from.ms) / 60_000) };
}

/**
 * Split a day's attributed punches into OFFICE spans and the FIELD spans between them.
 *
 * `bounds` is the fallback for a record whose trace carries no usable punch (an imported or pre-trace record):
 * `first_in_at` → `last_out_at` is exactly one in-office span, which is what FIRST_LAST interpretation would have
 * produced anyway. Nothing is invented beyond that — a record with neither trace nor punch times gets no segments.
 */
export function activitySegments(
  punches: readonly ActivityPunchLike[] | null | undefined,
  bounds: { firstInAt?: string | null; lastOutAt?: string | null } = {},
): ActivitySegment[] {
  const segments: ActivitySegment[] = [];
  let open: Instant | null = null;
  let closed: Instant | null = null;
  for (const p of parse(punches ?? [])) {
    if (p.opens) {
      if (open) continue; // already inside: a second IN adds nothing
      if (closed && p.ms > closed.ms) segments.push(span('FIELD', closed, p));
      open = p;
    } else {
      if (!open) continue; // an OUT with no IN before it opens nothing to close
      if (p.ms > open.ms) segments.push(span('OFFICE', open, p));
      closed = p;
      open = null;
    }
  }
  if (open) segments.push({ kind: 'OFFICE', startAt: open.iso, endAt: null, minutes: 0 });
  if (segments.length > 0) return segments;

  const firstIn = typeof bounds.firstInAt === 'string' ? bounds.firstInAt : null;
  if (!firstIn || !Number.isFinite(Date.parse(firstIn))) return segments;
  const lastOut = typeof bounds.lastOutAt === 'string' ? bounds.lastOutAt : null;
  const outMs = lastOut === null ? Number.NaN : Date.parse(lastOut);
  if (lastOut === null || !Number.isFinite(outMs) || outMs <= Date.parse(firstIn)) {
    return [{ kind: 'OFFICE', startAt: firstIn, endAt: null, minutes: 0 }];
  }
  return [span('OFFICE', { iso: firstIn, ms: Date.parse(firstIn) }, { iso: lastOut, ms: outMs })];
}

/** Minutes of each kind, for callers that want the measured split rather than the engine's rounded totals. */
export function segmentMinutes(segments: readonly ActivitySegment[]): { officeMinutes: number; fieldMinutes: number } {
  let officeMinutes = 0;
  let fieldMinutes = 0;
  for (const s of segments) {
    if (s.kind === 'OFFICE') officeMinutes += s.minutes;
    else fieldMinutes += s.minutes;
  }
  return { officeMinutes, fieldMinutes };
}
