import { describe, expect, it } from 'vitest';
import { accessAllowed, meetingAttendance, meetingPhase } from './attendance.js';

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
