import { describe, expect, it } from 'vitest';
import { computeSelfStats, punctualityOf, punctualityWindows, selfStatsRange, type SelfStatsDay } from './self-stats.js';

const day = (date: string, status: SelfStatsDay['status'], over: Partial<SelfStatsDay> = {}): SelfStatsDay => ({
  date, status, flags: [], workedMinutes: status === 'PRESENT' ? 480 : status === 'HALF_DAY' ? 240 : 0, lateMinutes: 0, firstInAt: null, expectedStartAt: null, ...over,
});
const at = (date: string, hhmm: string) => `${date}T${hhmm}:00.000Z`;
const SETTINGS = { attendanceTargetPct: 95, fullDayHours: 8 };

describe('computeSelfStats', () => {
  it('attendance % counts present, late and missing-punch days fully, half days by half; leave and offs are outside the denominator', () => {
    const days = [
      day('2026-09-01', 'PRESENT'),
      day('2026-09-02', 'PRESENT', { flags: ['LATE'], lateMinutes: 12 }),
      day('2026-09-03', 'HALF_DAY'),
      day('2026-09-04', 'WEEKLY_OFF'),
      day('2026-09-05', 'ABSENT'),
      day('2026-09-06', 'LEAVE'),
      day('2026-09-07', 'MISSING_PUNCH', { flags: ['MISSING_OUT'], workedMinutes: 0 }),
      day('2026-09-08', 'HOLIDAY'),
    ];
    const s = computeSelfStats(days, SETTINGS, { from: '2026-09-01', to: '2026-09-30', today: '2026-09-08' });
    expect(s.to).toBe('2026-09-08');
    expect(s.workingDays).toBe(5);
    expect(s.presentDays).toBe(3);
    expect(s.halfDays).toBe(1);
    expect(s.absentDays).toBe(1);
    expect(s.leaveDays).toBe(1);
    expect(s.lateDays).toBe(1);
    expect(s.missingCheckouts).toBe(1);
    expect(s.attendancePct).toBe(70); // (3 + 0.5) / 5
    expect(s.workedDays).toBe(3);
    expect(s.avgHoursPerDay).toBe(6.7); // (480 + 480 + 240) / 3 / 60
    expect(s.hints.map((h) => h.kind)).toEqual(['low_attendance', 'short_hours', 'late_days', 'absent_days', 'missing_checkouts']);
    expect(s.hints[0]).toEqual({ kind: 'low_attendance', value: 70, target: 95 });
  });

  it('a clean month has no hints; half-day leave counts half a leave day', () => {
    const days = [day('2026-09-01', 'PRESENT'), day('2026-09-02', 'PRESENT', { flags: ['HALF_DAY_LEAVE'] })];
    const s = computeSelfStats(days, SETTINGS, { from: '2026-09-01', to: '2026-09-02', today: '2026-09-10' });
    expect(s.attendancePct).toBe(100);
    expect(s.leaveDays).toBe(0.5);
    expect(s.hints).toEqual([]);
  });

  it('no working days → null percentages, no hints; future days are ignored', () => {
    const s = computeSelfStats([day('2026-09-10', 'PRESENT'), day('2026-09-06', 'WEEKLY_OFF')], SETTINGS, { from: '2026-09-01', to: '2026-09-30', today: '2026-09-09' });
    expect(s.workingDays).toBe(0);
    expect(s.attendancePct).toBeNull();
    expect(s.avgHoursPerDay).toBeNull();
    expect(s.hints).toEqual([]);
  });
});

describe('punctuality', () => {
  it('windows: last 7 days, this month to date, last full month', () => {
    expect(punctualityWindows('2026-09-03')).toEqual({ last7Days: ['2026-08-28', '2026-09-03'], thisMonth: ['2026-09-01', '2026-09-03'], lastMonth: ['2026-08-01', '2026-08-31'] });
    expect(punctualityWindows('2026-03-31').lastMonth).toEqual(['2026-02-01', '2026-02-28']);
    expect(punctualityWindows('2026-01-15').lastMonth).toEqual(['2025-12-01', '2025-12-31']);
  });

  it('signed arrival delta vs the expected start, delay beyond grace from the engine', () => {
    const days = [
      day('2026-09-01', 'PRESENT', { firstInAt: at('2026-09-01', '08:50'), expectedStartAt: at('2026-09-01', '09:00') }),
      day('2026-09-02', 'PRESENT', { firstInAt: at('2026-09-02', '09:20'), expectedStartAt: at('2026-09-02', '09:00'), lateMinutes: 5, flags: ['LATE'] }),
      day('2026-09-03', 'PRESENT', { firstInAt: at('2026-09-03', '09:30'), expectedStartAt: null }), // no expected start: skipped
      day('2026-08-31', 'PRESENT', { firstInAt: at('2026-08-31', '09:40'), expectedStartAt: at('2026-08-31', '09:00'), lateMinutes: 25 }),
    ];
    expect(punctualityOf(days, '2026-09-01', '2026-09-30')).toEqual({ from: '2026-09-01', to: '2026-09-30', days: 2, onTimeDays: 1, lateDays: 1, avgArrivalDeltaMinutes: 5, totalDelayMinutes: 5, avgDelayMinutes: 3 });
    const s = computeSelfStats(days, SETTINGS, { from: '2026-09-01', to: '2026-09-30', today: '2026-09-03' });
    expect(s.punctuality.thisMonth.days).toBe(2);
    expect(s.punctuality.lastMonth).toMatchObject({ days: 1, lateDays: 1, avgArrivalDeltaMinutes: 40, totalDelayMinutes: 25 });
    expect(s.punctuality.last7Days.days).toBe(3);
    expect(punctualityOf([], '2026-09-01', '2026-09-30')).toMatchObject({ days: 0, avgArrivalDeltaMinutes: null, avgDelayMinutes: null });
  });
});

describe('selfStatsRange', () => {
  it('30 days, this month, this year', () => {
    expect(selfStatsRange('30d', '2026-09-28')).toEqual({ from: '2026-08-30', to: '2026-09-28' });
    expect(selfStatsRange('month', '2026-09-28')).toEqual({ from: '2026-09-01', to: '2026-09-28' });
    expect(selfStatsRange('year', '2026-09-28')).toEqual({ from: '2026-01-01', to: '2026-09-28' });
  });
});
