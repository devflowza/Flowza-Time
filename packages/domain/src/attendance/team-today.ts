import type { AttendanceEventType, AttendanceStatus, LivePunchState, TeamDayStatus } from '@flowza/contracts';

/**
 * The team board's reading of one report's day (HR portal Prompt 5, Finance B-61): one status chip from the engine's
 * daily record, approved leave and the day's normalised punches, plus the live in / out state and the worked time so far.
 * Pure: the API gathers the facts under the caller's RLS; the rules live here so the board and its tests agree.
 */

export interface TeamDayRecordFacts {
  status: AttendanceStatus;
  flags: readonly string[];
  firstInAt: string | null;
  workedMinutes: number;
}
export interface TeamDayFacts {
  /** The engine's record of the day (null before the day was computed). */
  record: TeamDayRecordFacts | null;
  /** Approved leave covers the day (full or half). */
  onLeave: boolean;
  /** At least one non-voided punch of the day. */
  hasPunch: boolean;
}

const MISSING = ['MISSING_IN', 'MISSING_OUT'];
const workingReading = (flags: readonly string[]): TeamDayStatus => {
  if (flags.some((f) => MISSING.includes(f))) return 'missing_punch';
  return flags.includes('LATE') ? 'late' : 'present';
};

/**
 * One chip per report. Order of precedence: the engine's non-working verdicts (leave, holiday, weekly off), then absence,
 * then presence (late when the engine flagged LATE, missing punch when it flagged MISSING_IN / MISSING_OUT). A day the
 * engine still holds PENDING reads from the punches: in with a first punch, otherwise not in yet (or on leave).
 */
export function teamDayStatus(facts: TeamDayFacts): TeamDayStatus {
  const r = facts.record;
  if (!r) return facts.onLeave ? 'on_leave' : facts.hasPunch ? 'present' : 'not_in_yet';
  switch (r.status) {
    case 'LEAVE': return 'on_leave';
    case 'HOLIDAY': return 'holiday';
    case 'WEEKLY_OFF': return 'weekly_off';
    case 'NOT_JOINED':
    case 'EXITED': return 'not_scheduled';
    case 'ABSENT': return facts.onLeave ? 'on_leave' : 'absent';
    case 'MISSING_PUNCH': return 'missing_punch';
    case 'PENDING':
      if (!r.firstInAt && !facts.hasPunch) return facts.onLeave ? 'on_leave' : 'not_in_yet';
      return workingReading(r.flags);
    case 'PRESENT':
    case 'HALF_DAY':
    default:
      return workingReading(r.flags);
  }
}

export interface PunchLike { eventType: AttendanceEventType | string; punchedAt: string | Date }

const IN_TYPES = new Set(['PUNCH_IN', 'BREAK_END']);
const OUT_TYPES = new Set(['PUNCH_OUT', 'BREAK_START']);
const ms = (v: string | Date) => (typeof v === 'string' ? Date.parse(v) : v.getTime());

/**
 * In / out from the day's punches, oldest first: a directed punch sets the state (IN / BREAK_END open a segment, OUT /
 * BREAK_START close it); an undirected PUNCH toggles it (the device did not say, so punches alternate).
 */
export function livePunchState(punches: readonly PunchLike[]): LivePunchState {
  let state: LivePunchState = 'NONE';
  for (const p of [...punches].sort((a, b) => ms(a.punchedAt) - ms(b.punchedAt))) {
    if (IN_TYPES.has(p.eventType)) state = 'IN';
    else if (OUT_TYPES.has(p.eventType)) state = 'OUT';
    else state = state === 'IN' ? 'OUT' : 'IN';
  }
  return state;
}

/**
 * Minutes inside work segments by the same pairing as `livePunchState`; an open segment runs until `now` (never
 * negative, capped at 24 h so a forgotten check-out cannot show days of work).
 */
export function workedSoFarMinutes(punches: readonly PunchLike[], now: Date): number {
  let state: LivePunchState = 'NONE';
  let openedAt: number | null = null;
  let total = 0;
  for (const p of [...punches].sort((a, b) => ms(a.punchedAt) - ms(b.punchedAt))) {
    const at = ms(p.punchedAt);
    const next: LivePunchState = IN_TYPES.has(p.eventType) ? 'IN' : OUT_TYPES.has(p.eventType) ? 'OUT' : state === 'IN' ? 'OUT' : 'IN';
    if (state !== 'IN' && next === 'IN') openedAt = at;
    if (state === 'IN' && next !== 'IN' && openedAt !== null) { total += Math.max(0, at - openedAt); openedAt = null; }
    state = next;
  }
  if (state === 'IN' && openedAt !== null) total += Math.max(0, now.getTime() - openedAt);
  return Math.min(24 * 60, Math.floor(total / 60_000));
}

export interface TeamTotals { reports: number; present: number; late: number; absent: number; onLeave: number; missingPunch: number; weeklyOff: number; holiday: number; notInYet: number; inNow: number; pendingItems: number }

/** Totals row of the board: present counts the late arrivals too (late is a subset of present). */
export function teamTotals(members: ReadonlyArray<{ status: TeamDayStatus; liveState: LivePunchState; pendingItems: number }>): TeamTotals {
  const t: TeamTotals = { reports: members.length, present: 0, late: 0, absent: 0, onLeave: 0, missingPunch: 0, weeklyOff: 0, holiday: 0, notInYet: 0, inNow: 0, pendingItems: 0 };
  for (const m of members) {
    if (m.status === 'present') t.present += 1;
    else if (m.status === 'late') { t.present += 1; t.late += 1; }
    else if (m.status === 'absent') t.absent += 1;
    else if (m.status === 'on_leave') t.onLeave += 1;
    else if (m.status === 'missing_punch') t.missingPunch += 1;
    else if (m.status === 'weekly_off') t.weeklyOff += 1;
    else if (m.status === 'holiday') t.holiday += 1;
    else if (m.status === 'not_in_yet') t.notInYet += 1;
    if (m.liveState === 'IN') t.inNow += 1;
    t.pendingItems += m.pendingItems;
  }
  return t;
}
