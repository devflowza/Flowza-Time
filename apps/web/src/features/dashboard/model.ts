import { DateTime } from 'luxon';
import type { DashboardSummary, DashboardTrendPoint } from '@flowza/contracts';

/**
 * Pure helpers behind the dashboard widgets. Everything here is deterministic and free of React so the arithmetic
 * (deltas, percentages, the disjoint attendance series) can be unit-tested without rendering a chart.
 */

/** Trend point with the derived, non-overlapping series the charts stack: `late` is a flag on present records, so the
 *  "on time" bar is present minus late and the four bars add up to the records of the day. */
export interface TrendPoint extends DashboardTrendPoint { onTime: number; total: number }
export const toTrendPoints = (points: readonly DashboardTrendPoint[]): TrendPoint[] =>
  points.map((p) => ({ ...p, onTime: Math.max(p.present - p.late, 0), total: p.present + p.absent + p.onLeave }));

export type TrendKey = 'present' | 'absent' | 'late' | 'onLeave' | 'missingPunch' | 'overtimeMinutes' | 'onTime' | 'total';

export const shiftDate = (isoDate: string, days: number): string => DateTime.fromISO(isoDate).plus({ days }).toISODate() ?? isoDate;

/** Inclusive window of `days` days ending on `to`. */
export const trendWindow = (to: string, days: number): { from: string; to: string } => ({ from: shiftDate(to, -(days - 1)), to });

/** Value on `date` minus the value on the same weekday a week earlier; null when either day is outside the series. */
export function deltaVsLastWeek(points: readonly TrendPoint[], date: string, key: TrendKey): number | null {
  const now = points.find((p) => p.date === date);
  const then = points.find((p) => p.date === shiftDate(date, -7));
  if (!now || !then) return null;
  return now[key] - then[key];
}

/** Last `n` values of a series, oldest first, for a sparkline. */
export const sparkValues = (points: readonly TrendPoint[], key: TrendKey, n = 7): number[] => points.slice(-n).map((p) => p[key]);

/** Whole percentage, 0 when there is nothing to divide by. */
export const pct = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 100) : 0);

export type TodaySliceKey = 'onTime' | 'late' | 'absent' | 'onLeave' | 'unrecorded';
export interface TodaySlice { key: TodaySliceKey; value: number }
/** Disjoint slices of the headcount for the donut: late is carved out of present; whoever has no record yet
 *  (weekly off, holiday, not processed) is "unrecorded" so the ring always represents every active employee. */
export function todaySlices(s: DashboardSummary): TodaySlice[] {
  const late = Math.min(s.late, s.presentToday);
  const onTime = s.presentToday - late;
  const unrecorded = Math.max(s.employees - s.presentToday - s.absent - s.onLeave, 0);
  return [
    { key: 'onTime', value: onTime },
    { key: 'late', value: late },
    { key: 'absent', value: s.absent },
    { key: 'onLeave', value: s.onLeave },
    { key: 'unrecorded', value: unrecorded },
  ];
}

/** Calendar days from `from` to `to` (negative when `to` is earlier). */
export const daysUntil = (from: string, to: string): number => Math.round(DateTime.fromISO(to).diff(DateTime.fromISO(from), 'days').days);

export type Daypart = 'morning' | 'afternoon' | 'evening';
export const daypart = (hour: number): Daypart => (hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening');

export const firstName = (fullName: string | null | undefined): string => (fullName ?? '').trim().split(/\s+/)[0] ?? '';

/** Same quote for everyone on a given day, a different one the next day. */
export const quoteIndex = (isoDate: string, count: number): number => (count > 0 ? DateTime.fromISO(isoDate).ordinal % count : 0);
