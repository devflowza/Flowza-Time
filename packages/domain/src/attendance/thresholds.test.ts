import { describe, expect, it } from 'vitest';
import { statusThresholds } from './thresholds.js';

const RULES = { minFullDayMinutes: 420, halfDayThresholdMinutes: 240 };

describe('statusThresholds', () => {
  it('keeps the rule-set minutes when the shift schedules at least that much', () => {
    expect(statusThresholds(RULES, 480, 1)).toEqual({ minFullDay: 420, halfDay: 240 });
    expect(statusThresholds(RULES, 420, 1)).toEqual({ minFullDay: 420, halfDay: 240 });
  });

  it('scales by the ratio on a reduced day', () => {
    expect(statusThresholds(RULES, 240, 0.5)).toEqual({ minFullDay: 210, halfDay: 120 });
  });

  it('never requires more than the shift schedules, keeping the half-day proportion', () => {
    expect(statusThresholds(RULES, 240, 1)).toEqual({ minFullDay: 240, halfDay: 137 });
    expect(statusThresholds(RULES, 5, 1)).toEqual({ minFullDay: 5, halfDay: 3 });
    expect(statusThresholds(RULES, 0, 1)).toEqual({ minFullDay: 0, halfDay: 0 });
  });

  it('keeps a zero full-day rule and never lets the half day exceed the full day', () => {
    expect(statusThresholds({ minFullDayMinutes: 0, halfDayThresholdMinutes: 0 }, 480, 1)).toEqual({ minFullDay: 0, halfDay: 0 });
    expect(statusThresholds({ minFullDayMinutes: 200, halfDayThresholdMinutes: 300 }, 480, 1)).toEqual({ minFullDay: 200, halfDay: 200 });
  });
});
