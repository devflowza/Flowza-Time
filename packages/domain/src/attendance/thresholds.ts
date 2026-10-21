import type { AttendanceRules } from '@flowza/contracts';

/**
 * The worked minutes that make a full day and a half day for a day that expects `scheduledMinutes` (engine 1.5.1). The rule
 * set's thresholds scale with the day's `ratio` (Ramadan, half-day leave, reduced hours) as before; on top of that a day can
 * never demand more than its own schedule: a 5-hour shift worked to the end is a full day, not "under hours" for missing the
 * rule set's 7 hours, and a shift shorter than the half-day threshold is not a half day however well it is worked. Shifts at or
 * above the thresholds keep their figures exactly. `scheduledMinutes` 0 (nothing expected) leaves the thresholds alone.
 */
export function dayThresholds(rules: Pick<AttendanceRules, 'minFullDayMinutes' | 'halfDayThresholdMinutes'>, scheduledMinutes: number, ratio: number): { minFullDay: number; halfDay: number } {
  let minFullDay = Math.round(rules.minFullDayMinutes * ratio);
  let halfDay = Math.round(rules.halfDayThresholdMinutes * ratio);
  if (scheduledMinutes > 0) {
    minFullDay = Math.min(minFullDay, scheduledMinutes);
    if (scheduledMinutes < halfDay) halfDay = Math.floor(scheduledMinutes / 2);
  }
  return { minFullDay, halfDay };
}
