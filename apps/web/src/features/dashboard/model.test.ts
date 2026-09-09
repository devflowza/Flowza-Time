import { describe, expect, it } from 'vitest';
import type { DashboardTrendPoint } from '@flowza/contracts';
import { daypart, daysUntil, deltaVsLastWeek, firstName, pct, quoteIndex, sparkValues, todaySlices, toTrendPoints, trendWindow } from './model';

const point = (date: string, present: number, late: number, absent: number, onLeave: number, extra: Partial<DashboardTrendPoint> = {}): DashboardTrendPoint => ({ date, present, late, absent, onLeave, missingPunch: 0, overtimeMinutes: 0, ...extra });

describe('dashboard model', () => {
  it('derives series that do not overlap: on time is present minus late, total is every record of the day', () => {
    const [p] = toTrendPoints([point('2026-09-09', 40, 6, 5, 2)]);
    expect(p).toMatchObject({ onTime: 34, late: 6, absent: 5, onLeave: 2, total: 47 });
    // late is a flag on present records, so it can never exceed present; a corrupt row must not produce a negative bar
    expect(toTrendPoints([point('2026-09-09', 3, 5, 0, 0)])[0]!.onTime).toBe(0);
  });

  it('compares a day with the same weekday one week earlier, and says nothing when that day is outside the series', () => {
    const points = toTrendPoints([point('2026-09-02', 400, 20, 30, 4), point('2026-09-08', 420, 25, 28, 6), point('2026-09-09', 431, 27, 44, 10)]);
    expect(deltaVsLastWeek(points, '2026-09-09', 'present')).toBe(31);
    expect(deltaVsLastWeek(points, '2026-09-09', 'late')).toBe(7);
    expect(deltaVsLastWeek(points, '2026-09-08', 'present')).toBeNull(); // 2026-09-01 is not in the series
    expect(deltaVsLastWeek(points, '2026-09-10', 'present')).toBeNull(); // the day itself is not in the series
  });

  it('keeps the headcount ring honest: slices are disjoint and add up to the active employees', () => {
    const slices = todaySlices({ date: '2026-09-09', employees: 50, presentToday: 38, absent: 5, late: 3, onLeave: 2, earlyDeparture: 2, overtimeMinutes: 0, missingPunch: 0, devicesOnline: 0, devicesOffline: 0, devicesUnknown: 0, syncFailures24h: 0, pendingApprovals: 0 });
    expect(Object.fromEntries(slices.map((s) => [s.key, s.value]))).toEqual({ onTime: 35, late: 3, absent: 5, onLeave: 2, unrecorded: 5 });
    expect(slices.reduce((sum, s) => sum + s.value, 0)).toBe(50);
  });

  it('never shows a negative "unrecorded" slice when the counts exceed the headcount', () => {
    const slices = todaySlices({ date: '2026-09-09', employees: 10, presentToday: 8, absent: 3, late: 0, onLeave: 1, earlyDeparture: 0, overtimeMinutes: 0, missingPunch: 0, devicesOnline: 0, devicesOffline: 0, devicesUnknown: 0, syncFailures24h: 0, pendingApprovals: 0 });
    expect(slices.find((s) => s.key === 'unrecorded')!.value).toBe(0);
  });

  it('windows, day counts, percentages and sparklines', () => {
    expect(trendWindow('2026-09-09', 7)).toEqual({ from: '2026-09-03', to: '2026-09-09' });
    expect(trendWindow('2026-03-01', 30)).toEqual({ from: '2026-01-31', to: '2026-03-01' });
    expect(daysUntil('2026-09-09', '2026-09-12')).toBe(3);
    expect(daysUntil('2026-09-09', '2026-09-09')).toBe(0);
    expect(daysUntil('2026-09-09', '2026-09-08')).toBe(-1);
    expect(pct(38, 50)).toBe(76);
    expect(pct(1, 3)).toBe(33);
    expect(pct(5, 0)).toBe(0);
    const points = toTrendPoints(Array.from({ length: 10 }, (_, i) => point(`2026-09-${String(i + 1).padStart(2, '0')}`, i, 0, 0, 0)));
    expect(sparkValues(points, 'present')).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(sparkValues(points, 'present', 3)).toEqual([7, 8, 9]);
  });

  it('greeting helpers', () => {
    expect(daypart(6)).toBe('morning');
    expect(daypart(11)).toBe('morning');
    expect(daypart(12)).toBe('afternoon');
    expect(daypart(16)).toBe('afternoon');
    expect(daypart(17)).toBe('evening');
    expect(daypart(23)).toBe('evening');
    expect(firstName('Hassan Al Balushi')).toBe('Hassan');
    expect(firstName('  ')).toBe('');
    expect(firstName(null)).toBe('');
    // one quote per day, the same for everybody, cycling through the list
    expect(quoteIndex('2026-01-01', 7)).toBe(1);
    expect(quoteIndex('2026-01-07', 7)).toBe(0);
    expect(quoteIndex('2026-01-08', 7)).toBe(1);
    expect(quoteIndex('2026-01-08', 0)).toBe(0);
  });
});
