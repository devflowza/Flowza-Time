import { DateTime } from 'luxon';
import { addDays } from '@flowza/shared';
import type { PunchWindow } from './window.js';

/** A punch may be stamped this much ahead of the server clock (device / browser drift) before it counts as "in the future". */
export const PUNCH_FUTURE_TOLERANCE_MS = 5 * 60_000;

export type PunchDayProblem = 'WRONG_DAY' | 'IN_FUTURE';

export interface PunchDayVerdict {
  ok: boolean;
  problem: PunchDayProblem | null;
  /** The punch's calendar date in the branch zone. */
  punchDate: string;
  /** The calendar dates a punch of this attendance day may carry: the day itself, plus the next one on an overnight day. */
  allowedDates: string[];
}

/**
 * Whether a manually entered punch (a correction, an HR record edit, a regularisation) belongs to the attendance day.
 *
 * The punch's calendar date in the branch zone must be the attendance date — or the NEXT day when the day's shift runs past
 * midnight (an overnight shift; a flexible shift's day runs to its day boundary on the next date, so the early hours before
 * it count) — and a punch cannot be dated after "now". Without this a correction for 20 Oct could be filed with a punch on
 * 20 Dec: the engine never attributes it to the day, so the approved correction would change nothing and look done.
 */
export function checkPunchOnAttendanceDay(args: {
  punchedAt: string | Date;
  attendanceDate: string;
  timezone: string;
  window: Pick<PunchWindow, 'kind' | 'crossesMidnight' | 'windowEnd'>;
  now: Date;
}): PunchDayVerdict {
  const at = DateTime.fromJSDate(typeof args.punchedAt === 'string' ? new Date(args.punchedAt) : args.punchedAt, { zone: args.timezone });
  const punchDate = at.toISODate() ?? '';
  const nextDay = addDays(args.attendanceDate, 1);
  const { window } = args;
  // overnight FIXED shift: the whole next calendar day; FLEXIBLE: the next date up to the day boundary the window ends at
  const nextDayOk = window.crossesMidnight || (window.kind === 'FLEXIBLE' && at < window.windowEnd);
  const allowedDates = window.crossesMidnight || window.kind === 'FLEXIBLE' ? [args.attendanceDate, nextDay] : [args.attendanceDate];
  const sameDay = punchDate === args.attendanceDate;
  const onNextDay = punchDate === nextDay && nextDayOk;
  if (!at.isValid || (!sameDay && !onNextDay)) return { ok: false, problem: 'WRONG_DAY', punchDate, allowedDates };
  if (at.toMillis() > args.now.getTime() + PUNCH_FUTURE_TOLERANCE_MS) return { ok: false, problem: 'IN_FUTURE', punchDate, allowedDates };
  return { ok: true, problem: null, punchDate, allowedDates };
}

/** The sentence a refused punch gets (API errors and the web form say the same thing). */
export function punchDayMessage(verdict: PunchDayVerdict, attendanceDate: string): string {
  if (verdict.problem === 'IN_FUTURE') return 'A punch cannot be dated in the future: it can only be recorded once it has happened.';
  const overnight = verdict.allowedDates.length > 1;
  return `The punch date (${verdict.punchDate}) must be the attendance date (${attendanceDate})${overnight ? ` or the next day (${verdict.allowedDates[1]}) for an overnight shift` : ''}.`;
}
