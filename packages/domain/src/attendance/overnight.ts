import { sortEvents, type AttributionDecision, type AttributionResult } from './attribute.js';
import { scheduledBreakMinutes } from './interpret.js';
import type { EngineEvent, EngineShift } from './types.js';
import type { PunchWindow } from './window.js';

/**
 * Overnight check-outs on FLEXIBLE shifts (engine 1.3.0). A flexible attendance day runs from its day boundary to the next
 * one, so a night worker who checked in at 22:00 and out at 06:00 under a 00:00 boundary used to get a check-in without a
 * check-out on the first day (Missing OUT, 0 worked) and a lone check-out on the second. The check-out that closes a day's
 * open check-in now stays with that day, wherever the boundary is:
 *
 *  - the earlier day has a FLEXIBLE shift and ends inside a work session: its last check-in / check-out punch is a directed
 *    check-in (`PUNCH_IN`);
 *  - the next day opens with one or more directed check-outs (`PUNCH_OUT`) before any check-in (`PUNCH_IN` or an undirected
 *    `PUNCH`); break punches among them travel with them;
 *  - the last of those check-outs comes within the shift's required minutes + unpaid breaks + OVERNIGHT_SLACK_MINUTES of the
 *    check-in (never more than OVERNIGHT_MAX_SPAN_MINUTES), so a forgotten check-out is not closed by the next day's lone
 *    check-out much later.
 *
 * Only directed punches pair up: a device that reports no direction cannot tell a night shift's check-out from the next day's
 * check-in — for those, set the shift's day boundary to an hour nobody works. The rule reads nothing but the two days' punches
 * and the earlier day's shift, so the calculations of both days take the same decision (the 20-hour cap keeps it inside the
 * events every calculation loads).
 */
export const OVERNIGHT_SLACK_MINUTES = 240;
export const OVERNIGHT_MAX_SPAN_MINUTES = 20 * 60;

/** The longest check-in → check-out span paired across a flexible shift's day boundary. */
export function overnightMaxSpanMinutes(shift: Pick<EngineShift, 'requiredMinutes' | 'breaks'>): number {
  return Math.min(OVERNIGHT_MAX_SPAN_MINUTES, Math.max(0, shift.requiredMinutes ?? 0) + scheduledBreakMinutes(shift.breaks).unpaid + OVERNIGHT_SLACK_MINUTES);
}

const isPunch = (e: EngineEvent): boolean => e.eventType === 'PUNCH_IN' || e.eventType === 'PUNCH_OUT' || e.eventType === 'PUNCH';

/** The day's open check-in: its last check-in / check-out punch when that is a directed check-in, else null. */
export function openCheckIn(events: readonly EngineEvent[]): EngineEvent | null {
  const punches = sortEvents(events).filter((e) => !e.voided && isPunch(e));
  const last = punches[punches.length - 1];
  return last?.eventType === 'PUNCH_IN' ? last : null;
}

export interface OvernightCarry {
  /** The attendance date the check-out was punched in (its window). */
  from: string;
  /** The attendance date whose open check-in it closes. */
  to: string;
  checkIn: EngineEvent;
  /** The carried events, oldest first: the check-out(s) and any break punch before the last one. */
  events: EngineEvent[];
  spanMinutes: number;
}

/** The leading check-out run of `next` that closes the open check-in of `previous`, or null (see the module comment). */
export function overnightCarry(
  previous: { window: PunchWindow; shift: EngineShift | null; events: readonly EngineEvent[] },
  next: { window: PunchWindow; events: readonly EngineEvent[] },
): OvernightCarry | null {
  if (previous.window.kind !== 'FLEXIBLE' || previous.shift === null) return null;
  const checkIn = openCheckIn(previous.events);
  if (!checkIn) return null;
  const leading: EngineEvent[] = [];
  let carried = 0;
  for (const e of sortEvents(next.events)) {
    if (e.voided) continue;
    if (e.eventType === 'PUNCH_IN' || e.eventType === 'PUNCH') break;
    leading.push(e);
    if (e.eventType === 'PUNCH_OUT') carried = leading.length;
  }
  const events = leading.slice(0, carried);
  const checkOut = events[events.length - 1];
  if (!checkOut) return null;
  const spanMinutes = Math.round((Date.parse(checkOut.punchedAt) - Date.parse(checkIn.punchedAt)) / 60_000);
  if (spanMinutes <= 0 || spanMinutes > overnightMaxSpanMinutes(previous.shift)) return null;
  return { from: next.window.attendanceDate, to: previous.window.attendanceDate, checkIn, events, spanMinutes };
}

/**
 * `overnightCarry` over consecutive windows, oldest first: the carried events move to the earlier date and their attribution
 * decisions say so (`OVERNIGHT_CHECK_OUT`). Whether a day ends with an open check-in depends on its last punch only, which a
 * carry never takes away, so the order in which neighbouring days give and receive does not change any decision.
 */
export function carryOvernightCheckOuts(attribution: AttributionResult, windows: readonly PunchWindow[], shiftOf: (date: string) => EngineShift | null): { attribution: AttributionResult; carries: OvernightCarry[] } {
  const ordered = [...windows].sort((a, b) => a.attendanceDate.localeCompare(b.attendanceDate));
  const byDate = new Map<string, EngineEvent[]>([...attribution.byDate].map(([date, list]): [string, EngineEvent[]] => [date, [...list]]));
  const carries: OvernightCarry[] = [];
  for (let i = 0; i + 1 < ordered.length; i += 1) {
    const previous = ordered[i];
    const next = ordered[i + 1];
    if (!previous || !next) continue;
    const carry = overnightCarry(
      { window: previous, shift: shiftOf(previous.attendanceDate), events: byDate.get(previous.attendanceDate) ?? [] },
      { window: next, events: byDate.get(next.attendanceDate) ?? [] },
    );
    if (!carry) continue;
    const moved = new Set(carry.events.map((e) => e.id));
    byDate.set(next.attendanceDate, (byDate.get(next.attendanceDate) ?? []).filter((e) => !moved.has(e.id)));
    byDate.set(previous.attendanceDate, sortEvents([...(byDate.get(previous.attendanceDate) ?? []), ...carry.events]));
    carries.push(carry);
  }
  if (carries.length === 0) return { attribution, carries };
  const carriedTo = new Map(carries.flatMap((c) => c.events.map((e) => [e.id, c.to] as const)));
  const decisions = attribution.decisions.map((d): AttributionDecision => {
    const to = carriedTo.get(d.eventId);
    return to === undefined ? d : { ...d, attendanceDate: to, reason: 'OVERNIGHT_CHECK_OUT', distanceMinutes: null };
  });
  return { attribution: { byDate, decisions }, carries };
}
