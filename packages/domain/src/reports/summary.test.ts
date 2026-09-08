import { describe, expect, it } from 'vitest';
import { formatDays, leaveGroupOf, summariseCodes } from './summary.js';

const LT = [
  { code: 'AL', name: 'Annual Leave', isPaid: true },
  { code: 'SL', name: 'Sick Leave', isPaid: true },
  { code: 'NP', name: 'No Pay Leave', isPaid: false },
  { code: 'SD', name: 'Site Duty', isPaid: true, treatAsPresent: true },
];
const day = (status: string, extra: Record<string, unknown> = {}) => ({ status, flags: [] as string[], leaveTypeCode: null, firstInAt: null, lastOutAt: null, workedMinutes: 0, scheduledMinutes: 540, overtimeMinutes: 0, overtimeCategory: null, ...extra });
const present = (worked: number, ot = 0, category: string | null = 'REGULAR') => day('PRESENT', { firstInAt: '2017-11-01T04:00:00Z', lastOutAt: '2017-11-01T14:00:00Z', workedMinutes: worked, overtimeMinutes: ot, overtimeCategory: category });

describe('summariseCodes', () => {
  it('reproduces the sample groups: T/PR = PR + HL + OF + SD + ½HP, T/OL = paid leave, T/AB = AB + no-pay', () => {
    const s = summariseCodes([
      present(540), present(540), present(600, 60), // 3 present, 1 h OT1
      day('HOLIDAY'), day('WEEKLY_OFF'), day('WEEKLY_OFF'),
      day('LEAVE', { leaveTypeCode: 'SD' }), // site duty counts as present
      day('HALF_DAY', { firstInAt: '2017-11-01T04:00:00Z', lastOutAt: '2017-11-01T08:00:00Z', workedMinutes: 240 }), // HP
      day('LEAVE', { leaveTypeCode: 'AL' }), day('LEAVE', { leaveTypeCode: 'AL' }), day('LEAVE', { leaveTypeCode: 'SL' }),
      day('ABSENT'), day('LEAVE', { leaveTypeCode: 'NP' }),
      day('WEEKLY_OFF', { flags: ['WORKED_ON_WEEKLY_OFF'], firstInAt: '2017-11-01T04:00:00Z', lastOutAt: '2017-11-01T09:00:00Z', workedMinutes: 300, scheduledMinutes: 0, overtimeMinutes: 300, overtimeCategory: 'WEEKLY_OFF' }),
    ], LT);
    expect(s.present).toBe(3);
    expect(s.holiday).toBe(1);
    expect(s.weeklyOff).toBe(3);
    expect(s.halfDayPresent).toBe(1);
    expect(s.leave).toEqual({ SD: 1, AL: 2, SL: 1, NP: 1 });
    expect(s.totalPresent).toBe(3 + 1 + 3 + 1 + 0.5);
    expect(s.totalLeave).toBe(3);
    expect(s.totalAbsent).toBe(2);
    expect(s.ot1Minutes).toBe(60);
    expect(s.ot2Minutes).toBe(300);
    // under time: 540-240 = 300 on the half day (the 540-min days worked full or over)
    expect(s.utMinutes).toBe(300);
  });
  it('splits a half-day leave between the leave type and the present count', () => {
    const s = summariseCodes([day('HALF_DAY', { flags: ['HALF_DAY_LEAVE'], leaveTypeCode: 'AL', workedMinutes: 240, firstInAt: '2017-11-01T04:00:00Z', lastOutAt: '2017-11-01T08:00:00Z' }), day('ABSENT', { flags: ['HALF_DAY_LEAVE'], leaveTypeCode: 'SL' })], LT);
    expect(s.present).toBe(0.5);
    expect(s.absent).toBe(0.5);
    expect(s.leave).toEqual({ AL: 0.5, SL: 0.5 });
    expect(s.totalLeave).toBe(1);
  });
  it('treats a leave whose type is gone as ordinary paid leave, and ignores days that are not the employee\'s', () => {
    const s = summariseCodes([day('LEAVE', { leaveTypeCode: 'ZZ' }), day('LEAVE'), day('PENDING'), day('NOT_JOINED')], LT);
    expect(s.leave).toEqual({ ZZ: 1, LV: 1 });
    expect(s.totalLeave).toBe(2);
    expect(leaveGroupOf('np', LT)).toBe('absent');
    expect(leaveGroupOf('sd', LT)).toBe('present');
  });
});

describe('formatDays', () => {
  it('prints whole counts as integers, fractions with one decimal, totals always with one decimal, zero as a dash when asked', () => {
    expect(formatDays(22)).toBe('22');
    expect(formatDays(0.5)).toBe('0.5');
    expect(formatDays(30, { alwaysDecimal: true })).toBe('30.0');
    expect(formatDays(0, { zeroAsDash: true })).toBe('-');
    expect(formatDays(0, { alwaysDecimal: true })).toBe('0.0');
  });
});
