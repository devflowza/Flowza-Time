import { DateTime } from 'luxon';
import type { AttendanceActivityDayDto } from '@flowza/contracts';

/**
 * Geometry for the activity heartbeat. Every day is drawn on one shared clock window so the rows line up: a bar's
 * position is a percentage of that window, which the component turns into `inset-inline-start` / `width` so the
 * timeline mirrors correctly in Arabic without any of this knowing about direction.
 */

export interface TimelineBar {
  kind: 'OFFICE' | 'FIELD';
  startPct: number;
  widthPct: number;
  startAt: string;
  endAt: string | null;
  minutes: number;
  /** An IN with no matching OUT: drawn to the end of the window, but never counted as measured time. */
  open: boolean;
}

export interface TimelineRow {
  date: string;
  status: string;
  bars: TimelineBar[];
  day: AttendanceActivityDayDto | null;
}

export interface Timeline {
  /** Window bounds as minutes from local midnight; `to` may exceed 1440 for a shift that crosses it. */
  fromMinute: number;
  toMinute: number;
  ticks: number[];
  rows: TimelineRow[];
}

const DEFAULT_WINDOW = { from: 7 * 60, to: 19 * 60 };
const MIN_WINDOW_MINUTES = 4 * 60;

/** Minutes from local midnight of `date` to `iso`; negative before it, above 1440 after a midnight crossing. */
export function minuteOfDay(iso: string, date: string, zone: string): number {
  const start = DateTime.fromISO(date, { zone });
  const at = DateTime.fromISO(iso, { zone: 'utc' }).setZone(zone);
  if (!start.isValid || !at.isValid) return 0;
  return Math.round(at.diff(start.startOf('day'), 'minutes').minutes);
}

function tickStep(minutes: number): number {
  if (minutes <= 8 * 60) return 60;
  if (minutes <= 16 * 60) return 120;
  return 180;
}

/** Label for a window minute, e.g. 1500 → "01:00" (the day after). */
export function tickLabel(minute: number): string {
  const m = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Lay every day's segments out on one window. `dates` is the full calendar range, so days without a record still get a
 * row (an empty track) and the week reads as a week rather than as "the days that happened to have punches".
 */
export function buildTimeline(dates: readonly string[], days: readonly AttendanceActivityDayDto[], zone: string): Timeline {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const spans = days.map((d) => ({
    date: d.date,
    segments: d.segments.map((s) => ({
      kind: s.kind,
      startAt: s.startAt,
      endAt: s.endAt,
      minutes: s.minutes,
      from: minuteOfDay(s.startAt, d.date, zone),
      to: s.endAt === null ? null : minuteOfDay(s.endAt, d.date, zone),
    })),
  }));

  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const s of spans) {
    for (const seg of s.segments) {
      lo = Math.min(lo, seg.from);
      hi = Math.max(hi, seg.to ?? seg.from + 60);
    }
  }
  let fromMinute = Number.isFinite(lo) ? Math.floor(lo / 60) * 60 : DEFAULT_WINDOW.from;
  let toMinute = Number.isFinite(hi) ? Math.ceil(hi / 60) * 60 : DEFAULT_WINDOW.to;
  if (toMinute - fromMinute < MIN_WINDOW_MINUTES) toMinute = fromMinute + MIN_WINDOW_MINUTES;
  // Half an hour of air on each side so a bar never touches the edge of its track.
  fromMinute = Math.max(0, fromMinute - 30);
  toMinute += 30;

  const width = toMinute - fromMinute;
  const pct = (minute: number): number => Math.min(100, Math.max(0, ((minute - fromMinute) / width) * 100));
  const step = tickStep(width);
  const ticks: number[] = [];
  for (let m = Math.ceil(fromMinute / step) * step; m <= toMinute; m += step) ticks.push(m);

  const rows: TimelineRow[] = dates.map((date) => {
    const day = byDate.get(date) ?? null;
    const segments = spans.find((s) => s.date === date)?.segments ?? [];
    return {
      date,
      status: day?.status ?? 'NO_RECORD',
      day,
      bars: segments.map((seg) => {
        const startPct = pct(seg.from);
        const endPct = pct(seg.to ?? toMinute);
        return { kind: seg.kind, startPct, widthPct: Math.max(0.6, endPct - startPct), startAt: seg.startAt, endAt: seg.endAt, minutes: seg.minutes, open: seg.to === null };
      }),
    };
  });
  return { fromMinute, toMinute, ticks, rows };
}

/** Every date of an inclusive ISO range, so a period renders its whole calendar and not only its recorded days. */
export function datesOf(from: string, to: string, max = 366): string[] {
  const out: string[] = [];
  let cur = DateTime.fromISO(from, { zone: 'utc' });
  const end = DateTime.fromISO(to, { zone: 'utc' });
  if (!cur.isValid || !end.isValid) return out;
  while (cur <= end && out.length < max) {
    out.push(cur.toISODate()!);
    cur = cur.plus({ days: 1 });
  }
  return out;
}

/** The scheduled day the bar chart draws its target line at: the shift length most days share, ignoring days off. */
export function targetMinutes(days: readonly AttendanceActivityDayDto[]): number | null {
  const counts = new Map<number, number>();
  for (const d of days) {
    if (d.scheduledMinutes <= 0) continue;
    counts.set(d.scheduledMinutes, (counts.get(d.scheduledMinutes) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [minutes, n] of counts) if (n > bestCount) { best = minutes; bestCount = n; }
  return best;
}
