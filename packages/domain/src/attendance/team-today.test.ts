import { describe, expect, it } from 'vitest';
import type { AttendanceStatus } from '@flowza/contracts';
import { livePunchState, teamDayStatus, teamTotals, workedSoFarMinutes } from './team-today.js';

const rec = (status: AttendanceStatus, flags: string[] = [], firstInAt: string | null = null) => ({ status, flags, firstInAt, workedMinutes: 0 });

describe('teamDayStatus', () => {
  it('reads the engine verdicts of non-working days', () => {
    expect(teamDayStatus({ record: rec('LEAVE'), onLeave: true, hasPunch: false })).toBe('on_leave');
    expect(teamDayStatus({ record: rec('HOLIDAY'), onLeave: false, hasPunch: false })).toBe('holiday');
    expect(teamDayStatus({ record: rec('WEEKLY_OFF'), onLeave: false, hasPunch: true })).toBe('weekly_off');
    expect(teamDayStatus({ record: rec('NOT_JOINED'), onLeave: false, hasPunch: false })).toBe('not_scheduled');
    expect(teamDayStatus({ record: rec('EXITED'), onLeave: false, hasPunch: false })).toBe('not_scheduled');
  });
  it('separates late and missing punches from plain presence', () => {
    expect(teamDayStatus({ record: rec('PRESENT'), onLeave: false, hasPunch: true })).toBe('present');
    expect(teamDayStatus({ record: rec('PRESENT', ['LATE']), onLeave: false, hasPunch: true })).toBe('late');
    expect(teamDayStatus({ record: rec('HALF_DAY', ['LATE']), onLeave: false, hasPunch: true })).toBe('late');
    expect(teamDayStatus({ record: rec('PRESENT', ['LATE', 'MISSING_OUT']), onLeave: false, hasPunch: true })).toBe('missing_punch');
    expect(teamDayStatus({ record: rec('MISSING_PUNCH'), onLeave: false, hasPunch: true })).toBe('missing_punch');
  });
  it('reads an open day (PENDING) from the punches', () => {
    expect(teamDayStatus({ record: rec('PENDING', [], '2026-09-28T05:00:00Z'), onLeave: false, hasPunch: true })).toBe('present');
    expect(teamDayStatus({ record: rec('PENDING', ['LATE'], '2026-09-28T05:40:00Z'), onLeave: false, hasPunch: true })).toBe('late');
    expect(teamDayStatus({ record: rec('PENDING'), onLeave: false, hasPunch: false })).toBe('not_in_yet');
    expect(teamDayStatus({ record: rec('PENDING'), onLeave: true, hasPunch: false })).toBe('on_leave');
  });
  it('without a record: leave, a punch the engine has not seen yet, or not in yet', () => {
    expect(teamDayStatus({ record: null, onLeave: true, hasPunch: false })).toBe('on_leave');
    expect(teamDayStatus({ record: null, onLeave: false, hasPunch: true })).toBe('present');
    expect(teamDayStatus({ record: null, onLeave: false, hasPunch: false })).toBe('not_in_yet');
  });
  it('an absence the engine has not recomputed after leave was approved reads as leave', () => {
    expect(teamDayStatus({ record: rec('ABSENT'), onLeave: true, hasPunch: false })).toBe('on_leave');
    expect(teamDayStatus({ record: rec('ABSENT'), onLeave: false, hasPunch: false })).toBe('absent');
  });
});

describe('livePunchState / workedSoFarMinutes', () => {
  const now = new Date('2026-09-28T10:00:00Z');
  it('directed punches set the state', () => {
    expect(livePunchState([])).toBe('NONE');
    expect(livePunchState([{ eventType: 'PUNCH_IN', punchedAt: '2026-09-28T05:00:00Z' }])).toBe('IN');
    expect(livePunchState([{ eventType: 'PUNCH_IN', punchedAt: '2026-09-28T05:00:00Z' }, { eventType: 'BREAK_START', punchedAt: '2026-09-28T08:00:00Z' }])).toBe('OUT');
    expect(livePunchState([{ eventType: 'BREAK_END', punchedAt: '2026-09-28T08:30:00Z' }, { eventType: 'PUNCH_IN', punchedAt: '2026-09-28T05:00:00Z' }, { eventType: 'BREAK_START', punchedAt: '2026-09-28T08:00:00Z' }])).toBe('IN');
  });
  it('undirected punches alternate', () => {
    expect(livePunchState([{ eventType: 'PUNCH', punchedAt: '2026-09-28T05:00:00Z' }])).toBe('IN');
    expect(livePunchState([{ eventType: 'PUNCH', punchedAt: '2026-09-28T05:00:00Z' }, { eventType: 'PUNCH', punchedAt: '2026-09-28T09:00:00Z' }])).toBe('OUT');
  });
  it('counts closed segments and the open one until now', () => {
    const punches = [
      { eventType: 'PUNCH_IN', punchedAt: '2026-09-28T05:00:00Z' },
      { eventType: 'BREAK_START', punchedAt: '2026-09-28T08:00:00Z' },
      { eventType: 'BREAK_END', punchedAt: '2026-09-28T08:30:00Z' },
    ];
    expect(workedSoFarMinutes(punches, now)).toBe(180 + 90);
    expect(workedSoFarMinutes([...punches, { eventType: 'PUNCH_OUT', punchedAt: '2026-09-28T09:30:00Z' }], now)).toBe(180 + 60);
  });
  it('never negative, capped at a day', () => {
    expect(workedSoFarMinutes([{ eventType: 'PUNCH_IN', punchedAt: '2026-09-28T11:00:00Z' }], now)).toBe(0);
    expect(workedSoFarMinutes([{ eventType: 'PUNCH_IN', punchedAt: '2026-09-25T11:00:00Z' }], now)).toBe(1440);
  });
});

describe('teamTotals', () => {
  it('present includes late; in-now and pending add up', () => {
    const t = teamTotals([
      { status: 'present', liveState: 'IN', pendingItems: 1 },
      { status: 'late', liveState: 'IN', pendingItems: 0 },
      { status: 'absent', liveState: 'NONE', pendingItems: 2 },
      { status: 'on_leave', liveState: 'NONE', pendingItems: 0 },
      { status: 'missing_punch', liveState: 'OUT', pendingItems: 0 },
      { status: 'not_in_yet', liveState: 'NONE', pendingItems: 0 },
    ]);
    expect(t).toEqual({ reports: 6, present: 2, late: 1, absent: 1, onLeave: 1, missingPunch: 1, weeklyOff: 0, holiday: 0, notInYet: 1, inNow: 2, pendingItems: 3 });
  });
});
