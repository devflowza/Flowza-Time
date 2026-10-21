/**
 * The worked-minutes thresholds a day is judged against: full day (below it → UNDER_HOURS) and half day (below it → HALF_DAY).
 *
 * The rule set holds them as absolute minutes for a normal full day (default 420 / 240) and they are scaled by `ratio` on
 * reduced days (half-day leave, Ramadan hours, reduced hours). A shift SHORTER than the full-day minimum (a 4-hour part-time
 * shift, a 5-minute trial shift) can never reach an absolute threshold, so an employee who worked every scheduled minute was
 * marked HALF_DAY / UNDER_HOURS. A day can never require more than the shift schedules: the full-day threshold is capped at the
 * scheduled minutes and the half-day threshold keeps its proportion of it (240 / 420 of the shift), never above the full day.
 */
export function statusThresholds(
  rules: { minFullDayMinutes: number; halfDayThresholdMinutes: number },
  scheduledMinutes: number,
  ratio: number,
): { minFullDay: number; halfDay: number } {
  let minFullDay = Math.round(rules.minFullDayMinutes * ratio);
  let halfDay = Math.round(rules.halfDayThresholdMinutes * ratio);
  if (minFullDay > scheduledMinutes) {
    halfDay = Math.round(halfDay * (scheduledMinutes / minFullDay));
    minFullDay = scheduledMinutes;
  }
  return { minFullDay, halfDay: Math.min(halfDay, minFullDay) };
}
