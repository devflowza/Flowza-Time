import { DateTime } from 'luxon';
import { errors, isValidTimezone, localDateTime, timeToMinutes } from '@flowza/shared';
import type { EngineShift } from './types.js';

/**
 * Punch window of one attendance date (§G.3).
 *
 * - FIXED shifts: `scheduledStart`/`scheduledEnd` are the shift start/end instants; the window is
 *   `[start − punchInWindowBeforeMinutes, end + punchOutWindowAfterMinutes)`. When `endTime <= startTime`
 *   the shift crosses midnight and `scheduledEnd` falls on the next calendar day.
 * - FLEXIBLE shifts: the attendance day runs from `dayBoundary` (local) to `dayBoundary` of the next day;
 *   `scheduledStart` is the day boundary (used for attribution) and `scheduledEnd` the next boundary.
 * - No shift: the calendar day `[00:00, 00:00 next day)` in the branch timezone.
 *
 * All instants are Luxon DateTimes in the branch zone. FIXED windows are closed intervals
 * `[windowStart, windowEnd]` exactly as §G.3 defines them, so an OUT punched at the very end of a shift with no
 * punch-out margin is still accepted; FLEXIBLE and calendar-day windows are half-open `[windowStart, windowEnd)`
 * so adjacent days never share an instant. Overlaps between FIXED windows are resolved by attribution.
 */
export interface PunchWindow {
  attendanceDate: string;
  timezone: string;
  kind: 'FIXED' | 'FLEXIBLE' | 'NONE';
  shiftId: string | null;
  scheduledStart: DateTime;
  scheduledEnd: DateTime;
  windowStart: DateTime;
  windowEnd: DateTime;
  crossesMidnight: boolean;
}

export const DEFAULT_DAY_BOUNDARY = '04:00';
const MIDNIGHT = '00:00';

/** Ensures the zone is a valid IANA identifier; the engine never silently computes in UTC. */
export function assertTimezone(timezone: string): void {
  if (!isValidTimezone(timezone)) throw errors.validation(`Invalid IANA timezone "${timezone}".`, { timezone });
}

/** Local `date` + `HH:mm` in `zone`; adds `dayOffset` calendar days first (DST-safe through Luxon). */
export function localInstant(date: string, time: string, zone: string, dayOffset = 0): DateTime {
  const base = localDateTime(date, time, zone);
  return dayOffset === 0 ? base : localDateTime(base.plus({ days: dayOffset }).toISODate() ?? date, time, zone);
}

/** True when a FIXED shift's end time is on the following calendar day. */
export function crossesMidnight(startTime: string, endTime: string): boolean {
  return timeToMinutes(endTime) <= timeToMinutes(startTime);
}

/** Start/end instants of a FIXED shift on `date`. */
export function fixedShiftBounds(shift: EngineShift, date: string, zone: string): { start: DateTime; end: DateTime; crossesMidnight: boolean } {
  if (shift.startTime === null || shift.endTime === null) {
    throw errors.validation(`FIXED shift "${shift.code}" needs startTime and endTime.`, { shiftId: shift.id });
  }
  const overnight = crossesMidnight(shift.startTime, shift.endTime);
  const start = localInstant(date, shift.startTime, zone);
  const end = localInstant(date, shift.endTime, zone, overnight ? 1 : 0);
  return { start, end, crossesMidnight: overnight };
}

/** `[boundary(date), boundary(date + 1))` in `zone`. */
export function dayBounds(date: string, boundary: string, zone: string): { start: DateTime; end: DateTime } {
  return { start: localInstant(date, boundary, zone), end: localInstant(date, boundary, zone, 1) };
}

export function computePunchWindow(shift: EngineShift | null, attendanceDate: string, timezone: string): PunchWindow {
  assertTimezone(timezone);
  if (shift === null) {
    const { start, end } = dayBounds(attendanceDate, MIDNIGHT, timezone);
    return { attendanceDate, timezone, kind: 'NONE', shiftId: null, scheduledStart: start, scheduledEnd: end, windowStart: start, windowEnd: end, crossesMidnight: false };
  }
  if (shift.type === 'FLEXIBLE') {
    const { start, end } = dayBounds(attendanceDate, shift.dayBoundary || DEFAULT_DAY_BOUNDARY, timezone);
    return { attendanceDate, timezone, kind: 'FLEXIBLE', shiftId: shift.id, scheduledStart: start, scheduledEnd: end, windowStart: start, windowEnd: end, crossesMidnight: false };
  }
  const { start, end, crossesMidnight: overnight } = fixedShiftBounds(shift, attendanceDate, timezone);
  return {
    attendanceDate,
    timezone,
    kind: 'FIXED',
    shiftId: shift.id,
    scheduledStart: start,
    scheduledEnd: end,
    windowStart: start.minus({ minutes: shift.punchInWindowBeforeMinutes }),
    windowEnd: end.plus({ minutes: shift.punchOutWindowAfterMinutes }),
    crossesMidnight: overnight,
  };
}

/** Containment test used by attribution: FIXED windows include their end instant, the others do not. */
export function isWithinWindow(window: PunchWindow, instant: DateTime): boolean {
  if (instant < window.windowStart) return false;
  return window.kind === 'FIXED' ? instant <= window.windowEnd : instant < window.windowEnd;
}

/** UTC ISO string (millisecond precision suppressed when zero) — the engine's canonical output format. */
export function toUtcIso(dt: DateTime): string {
  return dt.toUTC().toISO({ suppressMilliseconds: true }) ?? dt.toUTC().toISO() ?? '';
}

/** Parse a UTC ISO input timestamp and express it in `zone`. */
export function parseInstant(iso: string, zone: string): DateTime {
  const dt = DateTime.fromISO(iso, { setZone: true }).setZone(zone);
  if (!dt.isValid) throw errors.validation(`Invalid timestamp "${iso}".`, { iso });
  return dt;
}
