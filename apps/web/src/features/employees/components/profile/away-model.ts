import type { AttendanceActivityDto, AttendanceAwayFiguresDto, AttendanceAwayIntervalDto, AwayIntervalKind } from '@flowza/contracts';

/**
 * Time away inside the working day (engine 1.5.0, docs/time-away.md) as the activity view and the portal draw it. The engine
 * classifies every gap between the first check-in and the last check-out: OFFICIAL duty, PERSONAL permission, BREAK (inside the
 * shift's break allowance), UNAPPROVED (the rest) and SHORT (a gap under the policy's tolerance, which stays worked time).
 * Colours are the tenant style's chart tokens, so the bars and the chips follow Settings → Dashboard.
 */

/** Stacking order of the "Hours per day" bars: on site first, then the classified away time, the unapproved part on top. */
export const AWAY_SERIES = ['onSite', 'official', 'permission', 'break', 'unapproved'] as const;
export type AwaySeriesKey = (typeof AWAY_SERIES)[number];

export const AWAY_SERIES_COLOR: Record<AwaySeriesKey, string> = {
  onSite: 'var(--color-chart-office)',
  official: 'var(--color-chart-field)',
  permission: 'var(--color-chart-permission)',
  break: 'var(--color-chart-break)',
  unapproved: 'var(--color-chart-unapproved)',
};

/** The dot / bar class of an interval kind (literal class names, so Tailwind generates them). SHORT gaps stay worked time. */
export const AWAY_KIND_BG: Record<AwayIntervalKind, string> = {
  OFFICIAL: 'bg-chart-field',
  PERMISSION: 'bg-chart-permission',
  BREAK: 'bg-chart-break',
  UNAPPROVED: 'bg-chart-unapproved',
  SHORT: 'bg-chart-office',
};

export type AwayBreakdown = Record<AwaySeriesKey, number>;

const ZERO: AwayBreakdown = { onSite: 0, official: 0, permission: 0, break: 0, unapproved: 0 };

/** Minutes per interval kind (every kind present, zero when absent). */
export function minutesByKind(intervals: readonly AttendanceAwayIntervalDto[] | undefined): Record<AwayIntervalKind, number> {
  const out: Record<AwayIntervalKind, number> = { BREAK: 0, OFFICIAL: 0, PERMISSION: 0, UNAPPROVED: 0, SHORT: 0 };
  for (const i of intervals ?? []) out[i.kind] = (out[i.kind] ?? 0) + Math.max(0, i.minutes);
  return out;
}

/**
 * How a span between the first and the last punch splits. `awayMinutes` counts every measured gap (breaks and short gaps
 * included), so the break share is what the classified kinds leave of it; a short gap is worked time, so it stays on site
 * when the intervals name it (the year range has no intervals: its short gaps fall in the break share, a few minutes at most).
 */
export function awayBreakdown(spanMinutes: number, away: AttendanceAwayFiguresDto | undefined, intervals?: readonly AttendanceAwayIntervalDto[]): AwayBreakdown {
  if (!away || away.awayMinutes <= 0) return { ...ZERO, onSite: Math.max(0, spanMinutes) };
  const short = minutesByKind(intervals).SHORT;
  const measured = Math.max(0, away.awayMinutes - short);
  const classified = away.officialDutyMinutes + away.permissionMinutes + away.unapprovedAwayMinutes;
  return {
    onSite: Math.max(0, spanMinutes - measured),
    official: Math.max(0, away.officialDutyMinutes),
    permission: Math.max(0, away.permissionMinutes),
    break: Math.max(0, measured - classified),
    unapproved: Math.max(0, away.unapprovedAwayMinutes),
  };
}

/** True when any day (or month) of the period measured time away: the activity view then shows the classified breakdown. */
export function hasAwayData(data: AttendanceActivityDto | undefined): boolean {
  if (!data) return false;
  if ((data.totals.away?.awayMinutes ?? 0) > 0) return true;
  return data.range === 'year' ? data.months.some((m) => (m.away?.awayMinutes ?? 0) > 0) : data.days.some((d) => (d.away?.awayMinutes ?? 0) > 0);
}
