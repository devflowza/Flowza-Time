import { DateTime } from 'luxon';
import type { AttendanceStatus } from '@flowza/contracts';

/**
 * The employee's own attendance statistics (HR portal Prompt 4; Finance `attendanceSelfStats` + `attendancePunctuality`,
 * B-13 … B-16), computed from the engine's daily records — the one verdict every other screen shows.
 *
 *   working days      `attendanceRateOf` below: the days the employee was expected at work (approved leave, weekly offs,
 *                     holidays, not-joined / exited and uncomputed days are outside; a half-day-leave day counts 0.5)
 *   attendance %      `attendanceRateOf` × 100, one decimal — the SAME definition as the portal's month card and home page
 *                     (HR portal Prompt 4 review, P2-14)
 *   avg hours / day   worked time over the days with worked time > 0
 *   hints             attendance below the target, average day shorter than `fullDayHours`, late arrivals, absences,
 *                     missing check-outs (MISSING_OUT — never today's running day, whose check-out is still to come)
 *   punctuality       per window (last 7 days, this month, last month): the signed arrival delta vs the expected start
 *                     (grace ignored, as a clock would show it) and the delay beyond grace — the engine's `lateMinutes`
 */
export interface SelfStatsDay {
  date: string;
  status: AttendanceStatus;
  flags: readonly string[];
  workedMinutes: number;
  lateMinutes: number;
  firstInAt: string | null;
  expectedStartAt: string | null;
}
export interface SelfStatsSettings { attendanceTargetPct: number; fullDayHours: number }
export interface SelfStatsOptions { from: string; to: string; today: string }

export type SelfStatsHintKind = 'low_attendance' | 'short_hours' | 'late_days' | 'absent_days' | 'missing_checkouts';
export interface SelfStatsHint { kind: SelfStatsHintKind; value: number; target: number | null }
export interface PunctualityWindow { from: string; to: string; days: number; onTimeDays: number; lateDays: number; avgArrivalDeltaMinutes: number | null; totalDelayMinutes: number; avgDelayMinutes: number | null }
export interface SelfStatsResult {
  from: string; to: string;
  workingDays: number; presentDays: number; halfDays: number; absentDays: number; leaveDays: number; lateDays: number; missingCheckouts: number;
  workedDays: number; workedMinutes: number; avgHoursPerDay: number | null; attendancePct: number | null;
  targets: { attendancePct: number; fullDayHours: number };
  hints: SelfStatsHint[];
  punctuality: { last7Days: PunctualityWindow; thisMonth: PunctualityWindow; lastMonth: PunctualityWindow };
}

const WORKING: ReadonlySet<AttendanceStatus> = new Set(['PRESENT', 'HALF_DAY', 'ABSENT', 'MISSING_PUNCH']);
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** A day as the attendance rate reads it (the engine's verdict). */
export interface AttendanceRateDay { status: AttendanceStatus; flags: readonly string[] }
export interface AttendanceRate {
  /** Days the employee was expected at work (0.5 steps). */
  expectedDays: number;
  /** Of those, the days they attended (0.5 steps). */
  attendedDays: number;
  /** attended / expected, 0..1; null before the first expected day. */
  rate: number | null;
}

/**
 * THE attendance rate of the employee portal (HR portal Prompt 4 review, P2-14) — one definition shared by the statistics
 * card, the month card and the home page, so the same page never shows two percentages:
 *   expected   the days the engine judged as working days: PRESENT, HALF_DAY, ABSENT and MISSING_PUNCH. Approved leave is
 *              outside — a full-day LEAVE counts 0, a day with half-day leave counts 0.5 (only its working half was
 *              expected) — as are weekly offs, holidays, not-joined / exited and uncomputed (PENDING) days.
 *   attended   PRESENT and MISSING_PUNCH days count in full (a missing-punch day had the employee at work: one punch),
 *              HALF_DAY by half — except on a half-day-leave day, where the half worked IS the expected half.
 *   rate       attended / expected, capped at 1.
 * Finance (B-13) counts calendar working days with leave inside; the portal decided against it: a day of approved leave is
 * not a day of missed attendance.
 */
export function attendanceRateOf(days: readonly AttendanceRateDay[]): AttendanceRate {
  let expected = 0; let attended = 0;
  for (const d of days) {
    if (!WORKING.has(d.status)) continue;
    const halfLeave = d.flags.includes('HALF_DAY_LEAVE');
    const weight = halfLeave ? 0.5 : 1;
    const credit = d.status === 'PRESENT' || d.status === 'MISSING_PUNCH' ? 1 : d.status === 'HALF_DAY' ? (halfLeave ? 1 : 0.5) : 0;
    expected += weight;
    attended += credit * weight;
  }
  return { expectedDays: expected, attendedDays: attended, rate: expected > 0 ? Math.min(1, attended / expected) : null };
}

/**
 * Today's running day is never a missing check-out (P2-14): a day whose only gap is the check-out, on the employee's
 * today, is simply still open. A missing check-IN today is a real gap.
 */
export function isOpenDay(d: { date: string; flags: readonly string[] }, today: string): boolean {
  return d.date === today && d.flags.includes('MISSING_OUT') && !d.flags.includes('MISSING_IN');
}

function addDays(date: string, n: number): string { return DateTime.fromISO(date, { zone: 'utc' }).plus({ days: n }).toISODate()!; }

/** The three punctuality windows ending on / around `today`. */
export function punctualityWindows(today: string): { last7Days: [string, string]; thisMonth: [string, string]; lastMonth: [string, string] } {
  const t = DateTime.fromISO(today, { zone: 'utc' });
  const lastMonth = t.minus({ months: 1 });
  return {
    last7Days: [addDays(today, -6), today],
    thisMonth: [t.startOf('month').toISODate()!, today],
    lastMonth: [lastMonth.startOf('month').toISODate()!, lastMonth.endOf('month').toISODate()!],
  };
}

export function punctualityOf(days: readonly SelfStatsDay[], from: string, to: string): PunctualityWindow {
  let count = 0; let onTime = 0; let late = 0; let deltaSum = 0; let delaySum = 0;
  for (const d of days) {
    if (d.date < from || d.date > to || !d.firstInAt || !d.expectedStartAt) continue;
    const delta = Math.round((Date.parse(d.firstInAt) - Date.parse(d.expectedStartAt)) / 60_000);
    if (!Number.isFinite(delta)) continue;
    count += 1; deltaSum += delta;
    const delay = Math.max(0, d.lateMinutes);
    delaySum += delay;
    if (delay > 0) late += 1; else onTime += 1;
  }
  return { from, to, days: count, onTimeDays: onTime, lateDays: late, avgArrivalDeltaMinutes: count ? Math.round(deltaSum / count) : null, totalDelayMinutes: delaySum, avgDelayMinutes: count ? Math.round(delaySum / count) : null };
}

/**
 * Statistics over [from, to] (future days ignored). `days` may reach further back than `from`: the punctuality windows
 * (this month, last month) read what they need from the same list.
 */
export function computeSelfStats(days: readonly SelfStatsDay[], settings: SelfStatsSettings, opts: SelfStatsOptions): SelfStatsResult {
  const to = opts.to < opts.today ? opts.to : opts.today;
  const inRange = days.filter((d) => d.date >= opts.from && d.date <= to);
  let presentDays = 0; let halfDays = 0; let absentDays = 0; let leaveDays = 0; let lateDays = 0; let missingCheckouts = 0; let workedDays = 0; let workedMinutes = 0;
  for (const d of inRange) {
    if (d.status === 'PRESENT' || d.status === 'MISSING_PUNCH') presentDays += 1;
    if (d.status === 'HALF_DAY') halfDays += 1;
    if (d.status === 'ABSENT') absentDays += 1;
    if (d.status === 'LEAVE') leaveDays += 1;
    else if (d.flags.includes('HALF_DAY_LEAVE')) leaveDays += 0.5;
    if (d.flags.includes('LATE')) lateDays += 1;
    if (d.flags.includes('MISSING_OUT') && !isOpenDay(d, opts.today)) missingCheckouts += 1;
    if (d.workedMinutes > 0) { workedDays += 1; workedMinutes += d.workedMinutes; }
  }
  const rate = attendanceRateOf(inRange);
  const workingDays = rate.expectedDays;
  const attendancePct = rate.rate === null ? null : round1(rate.rate * 100);
  const avgHoursPerDay = workedDays > 0 ? round1(workedMinutes / workedDays / 60) : null;
  const hints: SelfStatsHint[] = [];
  if (attendancePct !== null && attendancePct < settings.attendanceTargetPct) hints.push({ kind: 'low_attendance', value: attendancePct, target: settings.attendanceTargetPct });
  if (avgHoursPerDay !== null && avgHoursPerDay < settings.fullDayHours) hints.push({ kind: 'short_hours', value: avgHoursPerDay, target: settings.fullDayHours });
  if (lateDays > 0) hints.push({ kind: 'late_days', value: lateDays, target: null });
  if (absentDays > 0) hints.push({ kind: 'absent_days', value: absentDays, target: null });
  if (missingCheckouts > 0) hints.push({ kind: 'missing_checkouts', value: missingCheckouts, target: null });
  const w = punctualityWindows(opts.today);
  return {
    from: opts.from, to, workingDays, presentDays, halfDays, absentDays, leaveDays, lateDays, missingCheckouts, workedDays, workedMinutes, avgHoursPerDay, attendancePct,
    targets: { attendancePct: settings.attendanceTargetPct, fullDayHours: settings.fullDayHours },
    hints,
    punctuality: { last7Days: punctualityOf(days, ...w.last7Days), thisMonth: punctualityOf(days, ...w.thisMonth), lastMonth: punctualityOf(days, ...w.lastMonth) },
  };
}

/** The [from, to] of a statistics range ending today: the last 30 days, this calendar month, or this calendar year. */
export function selfStatsRange(range: '30d' | 'month' | 'year', today: string): { from: string; to: string } {
  const t = DateTime.fromISO(today, { zone: 'utc' });
  if (range === 'month') return { from: t.startOf('month').toISODate()!, to: today };
  if (range === 'year') return { from: t.startOf('year').toISODate()!, to: today };
  return { from: addDays(today, -29), to: today };
}
