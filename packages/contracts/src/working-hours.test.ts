import { describe, expect, it } from 'vitest';
import { DEFAULT_ATTENDANCE_RULES, attendanceRuleSetInputSchema, overlappingSpecialPeriods, specialHoursPeriodSchema, specialPeriodsSchema } from './attendance.js';
import { holidayCalendarInputSchema, holidayCopyYearSchema, holidayInputSchema, shiftInputSchema } from './shifts.js';
import { ruleSetUpdateSchema, shiftUpdateSchema } from './dto-features/schedule.js';

const p = (from: string, to: string, name = `${from}`) => ({ name, from, to, scheduledMinutes: 300 });

describe('working-hours policy contracts (engine 1.5.0)', () => {
  it('defaults keep the old behaviour: deduct, no periods, no flexible start band, holidays not recurring, rollover on', () => {
    expect(DEFAULT_ATTENDANCE_RULES).toMatchObject({ graceMode: 'deduct', specialPeriods: [] });
    expect(shiftInputSchema.parse({ code: 'D', name: 'Day', startTime: '07:00', endTime: '14:00' }).flexStartMinutes).toBe(0);
    expect(holidayInputSchema.parse({ name: 'National Day', date: '2026-11-18' }).recursYearly).toBe(false);
    expect(holidayCalendarInputSchema.parse({ name: 'Oman' }).autoRollover).toBe(true);
  });

  it('a flexible start band is 0–240 minutes', () => {
    expect(shiftInputSchema.safeParse({ code: 'D', name: 'Day', startTime: '07:00', endTime: '14:00', flexStartMinutes: 241 }).success).toBe(false);
    expect(shiftInputSchema.safeParse({ code: 'D', name: 'Day', startTime: '07:00', endTime: '14:00', flexStartMinutes: 120 }).success).toBe(true);
  });

  it('a period needs hours or minutes, a last day on/after the first, and an end other than the start', () => {
    expect(specialHoursPeriodSchema.safeParse({ name: 'x', from: '2026-07-01', to: '2026-08-31' }).success).toBe(false);
    expect(specialHoursPeriodSchema.safeParse({ name: 'x', from: '2026-07-01', to: '2026-06-30', scheduledMinutes: 300 }).success).toBe(false);
    expect(specialHoursPeriodSchema.safeParse({ name: 'x', from: '2026-07-01', to: '2026-08-31', startTime: '08:00', endTime: '08:00' }).success).toBe(false);
    expect(specialHoursPeriodSchema.parse({ name: 'x', from: '2026-07-01', to: '2026-08-31', startTime: '08:00', endTime: '13:00' })).toMatchObject({ appliesTo: 'all' });
  });

  it('refuses overlapping periods (inclusive days) and more than 20', () => {
    expect(overlappingSpecialPeriods([p('2026-07-01', '2026-07-31', 'July'), p('2026-08-01', '2026-08-31')])).toEqual([]);
    expect(overlappingSpecialPeriods([p('2026-07-01', '2026-07-31', 'July'), p('2026-07-31', '2026-08-31')])).toEqual([[1, 'July']]);
    // a long period swallowing a later one is caught even with a short one in between
    expect(overlappingSpecialPeriods([p('2026-01-01', '2026-12-31', 'Year'), p('2026-03-01', '2026-03-02'), p('2026-06-01', '2026-06-02')])).toEqual([[1, 'Year'], [2, 'Year']]);
    const res = specialPeriodsSchema.safeParse([p('2026-07-01', '2026-07-31', 'July'), p('2026-07-15', '2026-08-15')]);
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]).toMatchObject({ path: [1, 'from'], message: 'Overlaps the period “July”' });
    expect(specialPeriodsSchema.safeParse(Array.from({ length: 21 }, (_, i) => p(`2026-01-${String(i + 1).padStart(2, '0')}`, `2026-01-${String(i + 1).padStart(2, '0')}`))).success).toBe(false);
    expect(attendanceRuleSetInputSchema.safeParse({ name: 'x', effectiveFrom: '2026-01-01', specialPeriods: [p('2026-07-01', '2026-07-31'), p('2026-07-10', '2026-07-20')] }).success).toBe(false);
  });

  it('PATCH bodies carry no defaults: one field does not reset the grace mode, the periods or the band', () => {
    expect(ruleSetUpdateSchema.parse({ graceInMinutes: 5 })).toEqual({ graceInMinutes: 5 });
    expect(shiftUpdateSchema.parse({ name: 'Day' })).toEqual({ name: 'Day' });
    // the periods keep their overlap check on PATCH
    expect(ruleSetUpdateSchema.safeParse({ specialPeriods: [p('2026-07-01', '2026-07-31'), p('2026-07-10', '2026-07-20')] }).success).toBe(false);
  });

  it('copy to year: another year, non-recurring holidays off by default', () => {
    expect(holidayCopyYearSchema.parse({ fromYear: 2026 })).toEqual({ fromYear: 2026, includeNonRecurring: false });
    expect(holidayCopyYearSchema.safeParse({ fromYear: 2026, toYear: 2026 }).success).toBe(false);
  });
});
