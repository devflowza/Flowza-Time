import { ATTENDANCE_POINT_KINDS, type AttendancePointKind, type AttendancePolicySections, type DisciplineAction } from '@flowza/contracts';
import { addDays } from '@flowza/shared';

/**
 * Attendance points & disciplinary escalation (Enterprise, attendance_policies — docs/enterprise/plan.md §2/§4). Pure and
 * deterministic: the same daily records and policy sections always give the same events, in date order.
 *
 * The standing on `asOf` counts the events of the rolling window — the `points.expiryDays` days ending on `asOf`, inclusive.
 * Only the records inside the window are read (the repeated-late walk too), so a point drops off exactly `expiryDays` days
 * after the day that earned it (`expiresOn` = date + expiryDays, the first day it no longer counts).
 *
 * One occurrence per day and kind:
 *   VERY_LATE flag → VERY_LATE (instead of LATE); else LATE flag → LATE
 *   EARLY_DEPARTURE flag → EARLY_DEPARTURE
 *   status ABSENT → ABSENT
 *   status MISSING_PUNCH, or flag MISSING_IN / MISSING_OUT → MISSING_PUNCH (once a day)
 *   UNEXCUSED flag → UNEXCUSED
 *   a day flagged EXCUSED earns nothing (it does not count towards repeated late either)
 * Repeated late (`late.repeatedLate`: N occurrences within D days): the late days (LATE or VERY_LATE) are walked in date order
 * keeping those of the last D days; when N are reached one REPEATED_LATE event is emitted on that date and the count restarts.
 */
export interface PointsDayRecord { date: string; status: string; flags: readonly string[] }
export interface AttendancePointEvent { date: string; kind: AttendancePointKind; points: number; expiresOn: string }
export interface EscalationStep { action: DisciplineAction; threshold: number }
export interface AttendancePointsResult {
  /** First and last day of the rolling window (inclusive). */
  windowFrom: string;
  asOf: string;
  /** False when the policy has points switched off: no events, 0 points. */
  enabled: boolean;
  total: number;
  occurrences: Record<AttendancePointKind, number>;
  events: AttendancePointEvent[];
  /** The highest escalation step whose threshold the total reached (null = none) and the first one above the total. */
  escalation: EscalationStep | null;
  nextEscalation: EscalationStep | null;
}

export type PointsPolicySections = Pick<AttendancePolicySections, 'points' | 'late'>;

export function emptyOccurrences(): Record<AttendancePointKind, number> {
  return Object.fromEntries(ATTENDANCE_POINT_KINDS.map((k) => [k, 0])) as Record<AttendancePointKind, number>;
}

const isLateDay = (flags: readonly string[]): boolean => flags.includes('VERY_LATE') || flags.includes('LATE');

/** Escalation reached by `total` on the policy's ladder (ascending thresholds). */
export function escalationFor(ladder: AttendancePolicySections['points']['escalation'], total: number): { escalation: EscalationStep | null; nextEscalation: EscalationStep | null } {
  let escalation: EscalationStep | null = null;
  let nextEscalation: EscalationStep | null = null;
  for (const step of [...ladder].sort((a, b) => a.points - b.points)) {
    if (step.points <= total) escalation = { action: step.action, threshold: step.points };
    else if (!nextEscalation) nextEscalation = { action: step.action, threshold: step.points };
  }
  return { escalation, nextEscalation };
}

export function computeAttendancePoints(records: readonly PointsDayRecord[], sections: PointsPolicySections, asOf: string): AttendancePointsResult {
  const p = sections.points;
  const windowFrom = addDays(asOf, -(p.expiryDays - 1));
  const occurrences = emptyOccurrences();
  if (!p.enabled) return { windowFrom, asOf, enabled: false, total: 0, occurrences, events: [], escalation: null, nextEscalation: null };

  // one record per date (the last one wins should a caller pass duplicates), inside the window, in date order
  const byDate = new Map<string, PointsDayRecord>();
  for (const r of records) if (r.date >= windowFrom && r.date <= asOf) byDate.set(r.date, r);
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  const events: AttendancePointEvent[] = [];
  const emit = (date: string, kind: AttendancePointKind, points: number) => {
    events.push({ date, kind, points, expiresOn: addDays(date, p.expiryDays) });
    occurrences[kind] += 1;
  };
  const repeated = sections.late.repeatedLate;
  let recentLate: string[] = [];

  for (const day of days) {
    const flags = day.flags;
    if (flags.includes('EXCUSED')) continue;
    if (flags.includes('VERY_LATE')) emit(day.date, 'VERY_LATE', p.veryLate);
    else if (flags.includes('LATE')) emit(day.date, 'LATE', p.late);
    if (flags.includes('EARLY_DEPARTURE')) emit(day.date, 'EARLY_DEPARTURE', p.earlyDeparture);
    if (day.status === 'ABSENT') emit(day.date, 'ABSENT', p.absent);
    if (day.status === 'MISSING_PUNCH' || flags.includes('MISSING_IN') || flags.includes('MISSING_OUT')) emit(day.date, 'MISSING_PUNCH', p.missingPunch);
    if (flags.includes('UNEXCUSED')) emit(day.date, 'UNEXCUSED', p.unexcused);
    if (repeated && isLateDay(flags)) {
      // keep the late days of the last `periodDays` days (this one included)
      const earliest = addDays(day.date, -(repeated.periodDays - 1));
      recentLate = [...recentLate.filter((d) => d >= earliest), day.date];
      if (recentLate.length >= repeated.occurrences) { emit(day.date, 'REPEATED_LATE', p.repeatedLate); recentLate = []; }
    }
  }

  // points are multiples of 0.5: the sum is exact in binary floating point
  const total = events.reduce((s, e) => s + e.points, 0);
  return { windowFrom, asOf, enabled: true, total, occurrences, events, ...escalationFor(p.escalation, total) };
}
