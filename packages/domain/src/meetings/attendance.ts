/**
 * Meeting attendance from room access (Enterprise module meeting_rooms, docs/time-away.md §4). Pure and deterministic: the
 * caller supplies the meeting, its invitees, the room's entries around the meeting and the clock.
 *
 *   - An invitee ATTENDED when they entered the room between `arrivalWindowMinutes` before the start and the end: ON_TIME up
 *     to `lateAfterMinutes` after the start, LATE after it (minutes late from the start). Every entry in that window counts.
 *   - No entry: UPCOMING before the start, ABSENT from the start on (an invitee still on the way is absent until they enter).
 *   - A person who entered in that window without an invitation is a WALK-IN; in a RESTRICTED room a walk-in who is neither
 *     allowed (department / employee) is UNAUTHORISED, and so is any entry by an unknown card.
 */

export type AttendeeStatus = 'ON_TIME' | 'LATE' | 'ABSENT' | 'UPCOMING';
export type MeetingPhase = 'upcoming' | 'in_progress' | 'over';

export interface MeetingSpec { startsAt: string; endsAt: string; lateAfterMinutes: number }
export interface RoomAccessRule { restricted: boolean; allowedDepartmentIds: readonly string[]; allowedEmployeeIds: readonly string[] }
export interface RoomEntry { employeeId: string | null; deviceEmployeeId: string; occurredAt: string }
export interface MeetingInviteeSpec { employeeId: string; required: boolean }

export interface AttendeeResult { employeeId: string; required: boolean; status: AttendeeStatus; enteredAt: string | null; lateMinutes: number; entries: number }
export interface WalkInResult { employeeId: string | null; deviceEmployeeId: string; enteredAt: string; unauthorized: boolean }
export interface MeetingAttendanceResult {
  phase: MeetingPhase;
  attendees: AttendeeResult[];
  walkIns: WalkInResult[];
  counts: { invited: number; attended: number; late: number; absent: number; walkIns: number };
}

export const ARRIVAL_WINDOW_MINUTES = 15;

const ms = (iso: string): number => Date.parse(iso);

export function meetingPhase(meeting: Pick<MeetingSpec, 'startsAt' | 'endsAt'>, now: string): MeetingPhase {
  const t = ms(now);
  if (t < ms(meeting.startsAt)) return 'upcoming';
  return t < ms(meeting.endsAt) ? 'in_progress' : 'over';
}

/** May this person enter the room (restricted rooms only check anything)? Invitees of a meeting in progress always may. */
export function accessAllowed(room: RoomAccessRule, person: { employeeId: string | null; departmentId: string | null }, invitedNow = false): boolean {
  if (!room.restricted) return true;
  if (person.employeeId === null) return false;
  if (invitedNow) return true;
  return room.allowedEmployeeIds.includes(person.employeeId) || (person.departmentId !== null && room.allowedDepartmentIds.includes(person.departmentId));
}

export function meetingAttendance(params: {
  meeting: MeetingSpec;
  invitees: readonly MeetingInviteeSpec[];
  entries: readonly RoomEntry[];
  room: RoomAccessRule;
  /** Department of each person who entered (walk-ins are judged against the room's allowed departments). */
  departmentOf: ReadonlyMap<string, string | null>;
  now: string;
  arrivalWindowMinutes?: number;
}): MeetingAttendanceResult {
  const { meeting, room } = params;
  const start = ms(meeting.startsAt);
  const end = ms(meeting.endsAt);
  const from = start - (params.arrivalWindowMinutes ?? ARRIVAL_WINDOW_MINUTES) * 60_000;
  const phase = meetingPhase(meeting, params.now);
  const inWindow = [...params.entries].filter((e) => { const t = ms(e.occurredAt); return t >= from && t <= end; })
    .sort((a, b) => ms(a.occurredAt) - ms(b.occurredAt) || a.deviceEmployeeId.localeCompare(b.deviceEmployeeId));
  const invited = new Set(params.invitees.map((i) => i.employeeId));

  const attendees = [...params.invitees].sort((a, b) => a.employeeId.localeCompare(b.employeeId)).map((inv): AttendeeResult => {
    const mine = inWindow.filter((e) => e.employeeId === inv.employeeId);
    const first = mine[0];
    if (!first) return { employeeId: inv.employeeId, required: inv.required, status: phase === 'upcoming' ? 'UPCOMING' : 'ABSENT', enteredAt: null, lateMinutes: 0, entries: 0 };
    const afterStart = Math.max(0, Math.round((ms(first.occurredAt) - start) / 60_000));
    const late = ms(first.occurredAt) > start + meeting.lateAfterMinutes * 60_000;
    return { employeeId: inv.employeeId, required: inv.required, status: late ? 'LATE' : 'ON_TIME', enteredAt: first.occurredAt, lateMinutes: late ? afterStart : 0, entries: mine.length };
  });

  const seen = new Set<string>();
  const walkIns: WalkInResult[] = [];
  for (const e of inWindow) {
    if (e.employeeId !== null && invited.has(e.employeeId)) continue;
    const key = e.employeeId ?? `card:${e.deviceEmployeeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const allowed = accessAllowed(room, { employeeId: e.employeeId, departmentId: e.employeeId ? params.departmentOf.get(e.employeeId) ?? null : null });
    walkIns.push({ employeeId: e.employeeId, deviceEmployeeId: e.deviceEmployeeId, enteredAt: e.occurredAt, unauthorized: !allowed });
  }
  const attended = attendees.filter((a) => a.status === 'ON_TIME' || a.status === 'LATE').length;
  return {
    phase, attendees, walkIns,
    counts: { invited: attendees.length, attended, late: attendees.filter((a) => a.status === 'LATE').length, absent: attendees.filter((a) => a.status === 'ABSENT').length, walkIns: walkIns.length },
  };
}
