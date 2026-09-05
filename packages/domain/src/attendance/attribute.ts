import type { DateTime } from 'luxon';
import type { EngineEvent } from './types.js';
import { isWithinWindow, parseInstant, type PunchWindow } from './window.js';

export interface AttributionDecision {
  eventId: string;
  punchedAt: string;
  /** Attendance date the punch belongs to; `null` when it falls outside every candidate window. */
  attendanceDate: string | null;
  /** Dates whose windows contained the punch (ordered by date). */
  candidates: string[];
  reason: 'SINGLE_WINDOW' | 'NEAREST_SCHEDULED_START' | 'OUT_OF_WINDOW' | 'VOIDED';
  /** Distance (minutes) to the winning window's scheduled start; informational for the trace. */
  distanceMinutes: number | null;
}

export interface AttributionResult {
  byDate: Map<string, EngineEvent[]>;
  decisions: AttributionDecision[];
}

/**
 * Deterministic attribution of punches to attendance dates (§G.3).
 *
 * A punch belongs to the window that contains it. When consecutive windows overlap (generous punch
 * windows on cross-midnight shifts, flexible day boundaries) the punch goes to the window whose
 * scheduled start is nearest in absolute time; ties resolve to the earlier attendance date so the same
 * input always yields the same result. Voided events are never attributed but are still reported so the
 * calculation trace can list them as IGNORED. Events within a date are ordered by `punchedAt`, then `id`.
 */
export function attributeEvents(events: readonly EngineEvent[], windows: readonly PunchWindow[]): AttributionResult {
  const ordered = [...windows].sort((a, b) => a.attendanceDate.localeCompare(b.attendanceDate));
  const byDate = new Map<string, EngineEvent[]>();
  for (const w of ordered) byDate.set(w.attendanceDate, []);
  const decisions: AttributionDecision[] = [];

  for (const event of sortEvents(events)) {
    if (event.voided) {
      decisions.push({ eventId: event.id, punchedAt: event.punchedAt, attendanceDate: null, candidates: [], reason: 'VOIDED', distanceMinutes: null });
      continue;
    }
    const zone = ordered[0]?.timezone ?? 'utc';
    const instant = parseInstant(event.punchedAt, zone);
    const containing = ordered.filter((w) => isWithinWindow(w, instant));
    if (containing.length === 0) {
      decisions.push({ eventId: event.id, punchedAt: event.punchedAt, attendanceDate: null, candidates: [], reason: 'OUT_OF_WINDOW', distanceMinutes: null });
      continue;
    }
    const winner = containing.length === 1 ? containing[0] : nearestScheduledStart(containing, instant);
    if (!winner) continue; // unreachable: containing is non-empty
    byDate.get(winner.attendanceDate)?.push(event);
    decisions.push({
      eventId: event.id,
      punchedAt: event.punchedAt,
      attendanceDate: winner.attendanceDate,
      candidates: containing.map((w) => w.attendanceDate),
      reason: containing.length === 1 ? 'SINGLE_WINDOW' : 'NEAREST_SCHEDULED_START',
      distanceMinutes: Math.round(Math.abs(instant.diff(winner.scheduledStart, 'minutes').minutes)),
    });
  }
  return { byDate, decisions };
}

function nearestScheduledStart(candidates: readonly PunchWindow[], instant: DateTime): PunchWindow | undefined {
  let best: PunchWindow | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const w of candidates) {
    const distance = Math.abs(instant.diff(w.scheduledStart, 'milliseconds').milliseconds);
    if (distance < bestDistance) {
      best = w;
      bestDistance = distance;
    }
  }
  return best;
}

/** Stable chronological order: punchedAt ascending, then id — the basis of every deterministic step. */
export function sortEvents(events: readonly EngineEvent[]): EngineEvent[] {
  return [...events].sort((a, b) => {
    const ta = Date.parse(a.punchedAt);
    const tb = Date.parse(b.punchedAt);
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });
}
