import { describe, expect, it } from 'vitest';
import { attendancePolicySectionsSchema } from '@flowza/contracts';
import { monthBounds, overtimeSummaryFrom, summariseOvertime, type OvertimeDayRecord } from './overtime.js';

const sections = (overtime: Record<string, unknown> = {}) => attendancePolicySectionsSchema.parse({
  overtime: { weeklyThresholdMinutes: 2400, maxDailyWorkMinutes: 600, rates: { regular: 1.25, weekly: 1.5, weeklyOff: 2, holiday: 2.5 }, ...overtime },
});
const rec = (date: string, workedMinutes: number, overtimeMinutes = 0, overtimeCategory: string | null = overtimeMinutes ? 'REGULAR' : null): OvertimeDayRecord => ({ date, workedMinutes, overtimeMinutes, overtimeCategory });

// March 2026 starts on a Sunday: its first ISO week is Monday 23 February → Sunday 1 March.
const RECORDS: OvertimeDayRecord[] = [
  // week 23 Feb – 1 Mar (Sunday in March): 5 × 540 + 300 worked, no daily overtime → 3000 − 2400 = 600 weekly
  rec('2026-02-23', 540), rec('2026-02-24', 540), rec('2026-02-25', 540), rec('2026-02-26', 540), rec('2026-02-27', 540), rec('2026-02-28', 300),
  // week 2 – 8 Mar: 5 × 480 + a weekly off worked (480 overtime WEEKLY_OFF) → 2880 − 2400 − 480 = 0 (never paid twice)
  rec('2026-03-02', 480), rec('2026-03-03', 480), rec('2026-03-04', 480), rec('2026-03-05', 480), rec('2026-03-06', 480), rec('2026-03-07', 480, 480, 'WEEKLY_OFF'),
  // week 9 – 15 Mar: 660 (180 regular overtime, over the 600 daily maximum) + 4 × 540 → 2820 − 2400 − 180 = 240 weekly
  rec('2026-03-09', 660, 180), rec('2026-03-10', 540), rec('2026-03-11', 540), rec('2026-03-12', 540), rec('2026-03-13', 540),
  // week 16 – 22 Mar: a holiday worked (480 overtime HOLIDAY) + 4 × 480 → 2400 − 2400 − 480 → 0
  rec('2026-03-16', 480), rec('2026-03-17', 480), rec('2026-03-18', 480, 480, 'HOLIDAY'), rec('2026-03-19', 480), rec('2026-03-20', 480),
  // 30 and 31 March belong to the week of Sunday 5 April (next month's summary); 700 is over the daily maximum
  rec('2026-03-30', 600, 120), rec('2026-03-31', 700, 120),
  // April is not March
  rec('2026-04-01', 900, 300),
];

describe('summariseOvertime', () => {
  it('reads the whole first week from the previous month and weights every category by its rate', () => {
    expect(overtimeSummaryFrom('2026-03')).toBe('2026-02-23');
    expect(monthBounds('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    const s = summariseOvertime(RECORDS, sections(), '2026-03');
    expect(s).toEqual({
      month: '2026-03',
      workedMinutes: 2400 + 480 + 660 + 2160 + 1920 + 480 + 600 + 700,
      regularOvertimeMinutes: 420,
      weeklyOffOvertimeMinutes: 480,
      holidayOvertimeMinutes: 480,
      weeklyOvertimeMinutes: 840,
      weightedOvertimeMinutes: 420 * 1.25 + 840 * 1.5 + 480 * 2 + 480 * 2.5,
      daysOverDailyMaximum: 2,
    });
  });

  it('a week whose Sunday is in the next month is left to that month', () => {
    // April 2026: the first Sunday is the 5th, so its first week is 30 March – 5 April
    expect(overtimeSummaryFrom('2026-04')).toBe('2026-03-30');
    const s = summariseOvertime(RECORDS, sections({ weeklyThresholdMinutes: 1200 }), '2026-04');
    // 600 + 700 + 900 worked that week, 120 + 120 + 300 daily overtime → 2200 − 1200 − 540 = 460
    expect(s.weeklyOvertimeMinutes).toBe(460);
    expect(s.workedMinutes).toBe(900);
    expect(s.regularOvertimeMinutes).toBe(300);
  });

  it('no weekly threshold → no weekly overtime; no daily maximum → no day over it; minutes are rounded once', () => {
    const s = summariseOvertime([rec('2026-05-04', 1000, 7)], sections({ weeklyThresholdMinutes: null, maxDailyWorkMinutes: null }), '2026-05');
    expect(s.weeklyOvertimeMinutes).toBe(0);
    expect(s.daysOverDailyMaximum).toBe(0);
    expect(s.weightedOvertimeMinutes).toBe(9); // 7 × 1.25 = 8.75
  });

  it('an empty month is all zeros', () => {
    expect(summariseOvertime([], sections(), '2026-02')).toMatchObject({ workedMinutes: 0, weeklyOvertimeMinutes: 0, weightedOvertimeMinutes: 0, daysOverDailyMaximum: 0 });
  });
});
