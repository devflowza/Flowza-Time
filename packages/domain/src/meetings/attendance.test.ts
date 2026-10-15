import { describe, expect, it } from 'vitest';
import { accessAllowed, entryMeeting, meetingAttendance, meetingLiveAt, meetingPhase, type RoomMeetingSpec } from './attendance.js';

const meeting = { startsAt: '2026-10-15T06:00:00Z', endsAt: '2026-10-15T07:00:00Z', lateAfterMinutes: 5 }; // 10:00–11:00 Muscat
const open = { restricted: false, allowedDepartmentIds: [], allowedEmployeeIds: [] };
const entry = (employeeId: string | null, at: string, card = employeeId ?? 'x') => ({ employeeId, deviceEmployeeId: card, occurredAt: at });

describe('meeting attendance from room access', () => {
  it('classifies invitees: on time, late (minutes from the start), absent; repeat entries count', () => {
    const r = meetingAttendance({
      meeting, room: open, departmentOf: new Map(), now: '2026-10-15T08:00:00Z',
      invitees: [{ employeeId: 'a', required: true }, { employeeId: 'b', required: true }, { employeeId: 'c', required: false }],
      entries: [entry('a', '2026-10-15T05:52:00Z'), entry('b', '2026-10-15T06:09:00Z'), entry('a', '2026-10-15T06:30:00Z')],
    });
    expect(r.phase).toBe('over');
    expect(r.attendees).toEqual([
      { employeeId: 'a', required: true, status: 'ON_TIME', enteredAt: '2026-10-15T05:52:00Z', lateMinutes: 0, entries: 2 },
      { employeeId: 'b', required: true, status: 'LATE', enteredAt: '2026-10-15T06:09:00Z', lateMinutes: 9, entries: 1 },
      { employeeId: 'c', required: false, status: 'ABSENT', enteredAt: null, lateMinutes: 0, entries: 0 },
    ]);
    expect(r.counts).toEqual({ invited: 3, attended: 2, late: 1, absent: 1, walkIns: 0 });
  });

  it('ignores entries outside the arrival window and the meeting; an invitee is upcoming before the start', () => {
    const r = meetingAttendance({ meeting, room: open, departmentOf: new Map(), now: '2026-10-15T05:50:00Z', invitees: [{ employeeId: 'a', required: true }], entries: [entry('a', '2026-10-15T05:30:00Z'), entry('a', '2026-10-15T07:05:00Z')] });
    expect(r.phase).toBe('upcoming');
    expect(r.attendees[0]).toMatchObject({ status: 'UPCOMING', enteredAt: null });
  });

  it('reports walk-ins once each; in a restricted room an unknown card or a person outside the allowed lists is unauthorised', () => {
    const room = { restricted: true, allowedDepartmentIds: ['dep-fin'], allowedEmployeeIds: ['vip'] };
    const r = meetingAttendance({
      meeting, room, departmentOf: new Map([['x', 'dep-it'], ['y', 'dep-fin']]), now: '2026-10-15T06:30:00Z', invitees: [{ employeeId: 'a', required: true }],
      entries: [entry('x', '2026-10-15T06:01:00Z'), entry('x', '2026-10-15T06:02:00Z'), entry('y', '2026-10-15T06:03:00Z'), entry('vip', '2026-10-15T06:04:00Z'), entry(null, '2026-10-15T06:05:00Z', '99881')],
    });
    expect(r.phase).toBe('in_progress');
    expect(r.walkIns.map((w) => [w.employeeId ?? w.deviceEmployeeId, w.unauthorized])).toEqual([['x', true], ['y', false], ['vip', false], ['99881', true]]);
    expect(r.attendees[0]?.status).toBe('ABSENT');
  });

  it('the organiser is expected like an invitee: never a walk-in, never unauthorised, not on the attendee list', () => {
    const room = { restricted: true, allowedDepartmentIds: ['dep-fin'], allowedEmployeeIds: [] };
    const r = meetingAttendance({
      meeting, room, departmentOf: new Map([['org', 'dep-hr']]), now: '2026-10-15T06:30:00Z', organizerEmployeeId: 'org',
      invitees: [{ employeeId: 'a', required: true }], entries: [entry('org', '2026-10-15T05:58:00Z')],
    });
    expect(r.walkIns).toEqual([]);
    expect(r.attendees.map((a) => a.employeeId)).toEqual(['a']);
    expect(r.counts.walkIns).toBe(0);
  });

  it('back-to-back: an invitee of the next meeting arriving early is no walk-in of this one; a stranger still is', () => {
    const room = { restricted: true, allowedDepartmentIds: ['dep-fin'], allowedEmployeeIds: [] };
    // this meeting 10:00–11:00, the next one 11:00–12:00 (Muscat): its arrival window opens at 10:45
    const next: RoomMeetingSpec = { id: 'next', startsAt: '2026-10-15T07:00:00Z', endsAt: '2026-10-15T08:00:00Z', organizerEmployeeId: 'boss', inviteeIds: ['it1'], status: 'scheduled', cancelledAt: null };
    const r = meetingAttendance({
      meeting, room, departmentOf: new Map([['it1', 'dep-it'], ['boss', 'dep-it'], ['x', 'dep-it']]), now: '2026-10-15T08:00:00Z', otherMeetings: [next],
      invitees: [{ employeeId: 'a', required: true }],
      // it1 at 10:50 (inside the next window); boss at 10:50 organises the next one; it1 again at 10:30 (before the next window); x at 10:55
      entries: [entry('it1', '2026-10-15T06:50:00Z'), entry('boss', '2026-10-15T06:50:00Z'), entry('x', '2026-10-15T06:55:00Z'), entry('it1', '2026-10-15T06:30:00Z')],
    });
    expect(r.walkIns.map((w) => [w.employeeId, w.enteredAt, w.unauthorized])).toEqual([['it1', '2026-10-15T06:30:00Z', true], ['x', '2026-10-15T06:55:00Z', true]]);
    // a neighbour cancelled before the entry no longer covers it
    const cancelled = meetingAttendance({
      meeting, room, departmentOf: new Map([['it1', 'dep-it']]), now: '2026-10-15T08:00:00Z', otherMeetings: [{ ...next, status: 'cancelled', cancelledAt: '2026-10-15T05:00:00Z' }],
      invitees: [], entries: [entry('it1', '2026-10-15T06:50:00Z')],
    });
    expect(cancelled.walkIns.map((w) => w.employeeId)).toEqual(['it1']);
  });

  it('entryMeeting: every covering meeting counts for the invitation; the meeting reported is deterministic', () => {
    const a: RoomMeetingSpec = { id: 'a', startsAt: '2026-10-15T06:00:00Z', endsAt: '2026-10-15T07:00:00Z', organizerEmployeeId: 'orgA', inviteeIds: ['p'], status: 'scheduled', cancelledAt: null };
    const b: RoomMeetingSpec = { id: 'b', startsAt: '2026-10-15T07:00:00Z', endsAt: '2026-10-15T08:00:00Z', organizerEmployeeId: null, inviteeIds: ['q'], status: 'scheduled', cancelledAt: null };
    const at = (employeeId: string | null, occurredAt: string) => ({ employeeId, occurredAt });
    // 10:50 is inside both windows: q (invited to B) belongs to B whichever order the meetings come in
    expect(entryMeeting(at('q', '2026-10-15T06:50:00Z'), [a, b])).toEqual({ meeting: b, invited: true });
    expect(entryMeeting(at('q', '2026-10-15T06:50:00Z'), [b, a])).toEqual({ meeting: b, invited: true });
    expect(entryMeeting(at('p', '2026-10-15T06:50:00Z'), [b, a])).toEqual({ meeting: a, invited: true });
    expect(entryMeeting(at('orgA', '2026-10-15T06:50:00Z'), [b, a])).toEqual({ meeting: a, invited: true });
    // a stranger: the meeting in progress, else the upcoming one
    expect(entryMeeting(at('z', '2026-10-15T06:50:00Z'), [b, a])).toEqual({ meeting: a, invited: false });
    expect(entryMeeting(at(null, '2026-10-15T07:00:00Z'), [a, b])).toEqual({ meeting: b, invited: false });
    expect(entryMeeting(at('z', '2026-10-15T05:50:00Z'), [b, a])).toEqual({ meeting: a, invited: false });
    expect(entryMeeting(at('z', '2026-10-15T09:00:00Z'), [a, b])).toEqual({ meeting: null, invited: false });
  });

  it('a meeting cancelled after an entry still covers it; one cancelled before does not', () => {
    const m: RoomMeetingSpec = { id: 'm', startsAt: '2026-10-15T06:00:00Z', endsAt: '2026-10-15T07:00:00Z', organizerEmployeeId: null, inviteeIds: ['x'], status: 'cancelled', cancelledAt: '2026-10-15T08:00:00Z' };
    expect(meetingLiveAt(m, '2026-10-15T06:02:00Z')).toBe(true);
    expect(entryMeeting({ employeeId: 'x', occurredAt: '2026-10-15T06:02:00Z' }, [m])).toEqual({ meeting: m, invited: true });
    expect(entryMeeting({ employeeId: 'x', occurredAt: '2026-10-15T06:02:00Z' }, [{ ...m, cancelledAt: '2026-10-15T06:01:00Z' }])).toEqual({ meeting: null, invited: false });
  });

  it('access rules: open rooms admit everybody, restricted ones their lists and the invitees of a meeting in progress', () => {
    const room = { restricted: true, allowedDepartmentIds: ['d1'], allowedEmployeeIds: ['e1'] };
    expect(accessAllowed(open, { employeeId: null, departmentId: null })).toBe(true);
    expect(accessAllowed(room, { employeeId: 'e1', departmentId: null })).toBe(true);
    expect(accessAllowed(room, { employeeId: 'e2', departmentId: 'd1' })).toBe(true);
    expect(accessAllowed(room, { employeeId: 'e3', departmentId: 'd2' })).toBe(false);
    expect(accessAllowed(room, { employeeId: 'e3', departmentId: 'd2' }, true)).toBe(true);
    expect(meetingPhase(meeting, '2026-10-15T07:00:00Z')).toBe('over');
  });
});
