import { DateTime } from 'luxon';
import type { AttendanceAwayIntervalDto, TimeAwayPolicyDto } from '@flowza/contracts';
import { ApiError } from '@/lib/api-client';
import { localToUtcIso } from '@/features/corrections/time';

/**
 * Pure helpers of the portal's time away (docs/time-away.md): the times the dialogs propose and turn into instants (always in
 * the employee's zone, through Luxon), the personal-permission quota, today's totals and the refusals the API explains.
 */

/** `details.reason` of a refused time-away write that the portal explains in its own words. */
export const TIME_AWAY_REFUSALS = ['TIME_AWAY_DISABLED', 'TIME_AWAY_NOT_MEASURABLE', 'STEP_OUT_DISABLED', 'ALREADY_AWAY', 'NOT_ON_SITE', 'NOT_AWAY', 'RETURN_ON_DEVICE', 'TIME_AWAY_QUOTA', 'TIME_AWAY_TOO_LONG', 'TIME_AWAY_TOO_OLD'] as const;
export type TimeAwayRefusal = (typeof TIME_AWAY_REFUSALS)[number];

export function timeAwayRefusal(e: unknown): TimeAwayRefusal | null {
  const reason = e instanceof ApiError ? e.details?.['reason'] : undefined;
  return typeof reason === 'string' && (TIME_AWAY_REFUSALS as readonly string[]).includes(reason) ? (reason as TimeAwayRefusal) : null;
}

/** Shortest and longest step-out the API accepts (expected return 5 min – 12 h from now). */
export const STEP_OUT_MIN_MINUTES = 5;
export const STEP_OUT_MAX_MINUTES = 12 * 60;
/** Longest planned window the API accepts. */
export const WINDOW_MAX_MINUTES = 16 * 60;

/** The proposed return of a step-out: an hour from now, rounded up to the next five minutes, as HH:mm in the employee's zone. */
export function defaultBackTime(nowMs: number, zone: string): string {
  // every zone's offset is a whole number of five minutes, so rounding the instant rounds the local clock too
  const step = 5 * 60_000;
  return DateTime.fromMillis(Math.ceil((nowMs + 60 * 60_000) / step) * step, { zone }).toFormat('HH:mm');
}

/**
 * The instant of an expected return typed as HH:mm on the employee's day. A time that is not after now is read as the next
 * day (a night shift past midnight); null when incomplete.
 */
export function backInstant(date: string, time: string, zone: string, nowMs: number): string | null {
  const iso = localToUtcIso(date, time, zone);
  if (!iso) return null;
  if (Date.parse(iso) > nowMs) return iso;
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(zone).plus({ days: 1 }).toUTC().toISO();
}

/** A planned window from a date and two local times; an end not after the start is the next day (a window across midnight). */
export function windowInstants(date: string, from: string, to: string, zone: string): { startsAt: string; endsAt: string; minutes: number } | null {
  const startsAt = localToUtcIso(date, from, zone);
  let endsAt = localToUtcIso(date, to, zone);
  if (!startsAt || !endsAt) return null;
  if (Date.parse(endsAt) <= Date.parse(startsAt)) endsAt = DateTime.fromISO(endsAt, { zone: 'utc' }).setZone(zone).plus({ days: 1 }).toUTC().toISO();
  if (!endsAt) return null;
  return { startsAt, endsAt, minutes: Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60_000) };
}

/** Personal permission minutes left this month (pending and approved requests count), or null without a monthly limit. */
export function personalLeft(policy: Pick<TimeAwayPolicyDto, 'personalMonthlyQuotaMinutes' | 'personalUsedMinutes'>): number | null {
  return policy.personalMonthlyQuotaMinutes === null ? null : Math.max(0, policy.personalMonthlyQuotaMinutes - policy.personalUsedMinutes);
}

export interface AwayTotals { away: number; official: number; permission: number; break: number; unapproved: number }

/** Today's classified intervals summed by kind. A SHORT gap stays worked time, so it is not time away. */
export function intervalTotals(intervals: readonly AttendanceAwayIntervalDto[]): AwayTotals {
  const t: AwayTotals = { away: 0, official: 0, permission: 0, break: 0, unapproved: 0 };
  for (const i of intervals) {
    const m = Math.max(0, i.minutes);
    if (i.kind === 'SHORT') continue;
    t.away += m;
    if (i.kind === 'OFFICIAL') t.official += m;
    else if (i.kind === 'PERMISSION') t.permission += m;
    else if (i.kind === 'BREAK') t.break += m;
    else t.unapproved += m;
  }
  return t;
}

/** Minutes between two instants, rounded (negative when `to` is before `from`). */
export function minutesBetween(from: string | number, to: string | number): number {
  const a = typeof from === 'number' ? from : Date.parse(from);
  const b = typeof to === 'number' ? to : Date.parse(to);
  return Math.round((b - a) / 60_000);
}
