import type { AttendancePolicySections } from '@flowza/contracts';
import { addDays, dayOfWeek } from '@flowza/shared';

/**
 * The overtime summary of one employee for one calendar month (Enterprise, attendance_policies — docs/enterprise/plan.md §3):
 * what the payroll export multiplies by the hourly wage. Pure. It reads the engine's stored figures only — `workedMinutes`,
 * `overtimeMinutes` and `overtimeCategory` of each daily record — and the policy's overtime section:
 *
 *   regular / weekly-off / holiday overtime   Σ the daily overtime of the month's days, by category
 *   weekly overtime                           per ISO week (Monday–Sunday) whose SUNDAY falls in the month — the whole week is
 *                                             read, so it may start in the previous month (the caller loads from the Monday
 *                                             before the 1st): max(0, Σ worked − weeklyThresholdMinutes − Σ daily overtime of
 *                                             that week). Every daily overtime category is netted out, so a minute already paid
 *                                             as daily, weekly-off or holiday overtime is never paid twice (plan §2: "a weekly
 *                                             threshold counts only the minutes not already paid as daily overtime"). No
 *                                             threshold = no weekly overtime.
 *   weighted overtime                         Σ minutes × the policy's rate per category, rounded to whole minutes
 *   days over the daily maximum               days of the month whose worked minutes exceed `maxDailyWorkMinutes`
 */
export interface OvertimeDayRecord { date: string; workedMinutes: number; overtimeMinutes: number; overtimeCategory: string | null }
export interface OvertimeSummary {
  month: string;
  workedMinutes: number;
  regularOvertimeMinutes: number;
  weeklyOffOvertimeMinutes: number;
  holidayOvertimeMinutes: number;
  weeklyOvertimeMinutes: number;
  weightedOvertimeMinutes: number;
  daysOverDailyMaximum: number;
}
export type OvertimePolicySections = Pick<AttendancePolicySections, 'overtime'>;

/** First and last day of a `YYYY-MM` month. */
export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/** The first day the overtime summary of `month` reads: the Monday of the week whose Sunday is the month's first Sunday. */
export function overtimeSummaryFrom(month: string): string {
  const { from } = monthBounds(month);
  const firstSunday = addDays(from, (7 - dayOfWeek(from)) % 7);
  return addDays(firstSunday, -6);
}

export function summariseOvertime(records: readonly OvertimeDayRecord[], sections: OvertimePolicySections, month: string): OvertimeSummary {
  const { from, to } = monthBounds(month);
  const ot = sections.overtime;
  const byDate = new Map<string, OvertimeDayRecord>();
  for (const r of records) byDate.set(r.date, r);

  let workedMinutes = 0; let regular = 0; let weeklyOff = 0; let holiday = 0; let daysOverDailyMaximum = 0;
  for (const r of byDate.values()) {
    if (r.date < from || r.date > to) continue;
    workedMinutes += r.workedMinutes;
    if (r.overtimeCategory === 'WEEKLY_OFF') weeklyOff += r.overtimeMinutes;
    else if (r.overtimeCategory === 'HOLIDAY') holiday += r.overtimeMinutes;
    else regular += r.overtimeMinutes; // REGULAR (and any overtime recorded without a category)
    if (ot.maxDailyWorkMinutes !== null && r.workedMinutes > ot.maxDailyWorkMinutes) daysOverDailyMaximum += 1;
  }

  let weekly = 0;
  if (ot.weeklyThresholdMinutes !== null) {
    // every Sunday of the month closes one ISO week
    for (let sunday = addDays(from, (7 - dayOfWeek(from)) % 7); sunday <= to; sunday = addDays(sunday, 7)) {
      let worked = 0; let dailyOvertime = 0;
      for (let d = addDays(sunday, -6); d <= sunday; d = addDays(d, 1)) {
        const r = byDate.get(d);
        if (!r) continue;
        worked += r.workedMinutes;
        dailyOvertime += r.overtimeMinutes;
      }
      weekly += Math.max(0, worked - ot.weeklyThresholdMinutes - dailyOvertime);
    }
  }

  const rates = ot.rates;
  const weightedOvertimeMinutes = Math.round(regular * rates.regular + weekly * rates.weekly + weeklyOff * rates.weeklyOff + holiday * rates.holiday);
  return { month, workedMinutes, regularOvertimeMinutes: regular, weeklyOffOvertimeMinutes: weeklyOff, holidayOvertimeMinutes: holiday, weeklyOvertimeMinutes: weekly, weightedOvertimeMinutes, daysOverDailyMaximum };
}
