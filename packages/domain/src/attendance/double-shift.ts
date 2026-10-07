import type { ShiftBreak } from '@flowza/contracts';
import type { EngineShift } from './types.js';

/**
 * Double shifts (Enterprise, docs/enterprise/plan.md §9): an employee who works two shifts on one attendance date — the
 * resolved shift plus an ADDITIONAL shift assignment — is calculated as ONE fixed day running from the start of the earlier
 * shift to the end of the later one, with the time between them as an unpaid break. Late is judged against the first start,
 * early departure against the last end, overtime after the last end; the worked minutes leave the gap out (a punched break
 * there is measured as usual). The daily record keeps the primary shift's id and the trace / flag DOUBLE_SHIFT say both.
 *
 * Both shifts must be FIXED (a flexible shift has no position in the day to combine), must not overlap, and must fit in less
 * than 24 hours from the first start. Both are placed on the attendance date: an additional shift that starts at 02:00 is
 * the 02:00 of that date, before a 06:00 primary — not the night after it. Pure.
 */
export type DoubleShiftRefusal = 'SAME_SHIFT' | 'NOT_FIXED' | 'OVERLAP' | 'TOO_LONG';
export type DoubleShiftResult = { ok: true; shift: EngineShift } | { ok: false; reason: DoubleShiftRefusal };

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};
const toHhmm = (minutes: number): string => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** [start, end) of a fixed shift in minutes from the attendance date's midnight (end on D+1 when it crosses midnight). */
function span(shift: EngineShift): { start: number; end: number } | null {
  if (shift.type !== 'FIXED' || !shift.startTime || !shift.endTime) return null;
  const start = toMinutes(shift.startTime);
  let end = toMinutes(shift.endTime);
  if (end <= start) end += 1440;
  return { start, end };
}

export function composeDoubleShift(primary: EngineShift, additional: EngineShift): DoubleShiftResult {
  if (primary.id === additional.id) return { ok: false, reason: 'SAME_SHIFT' };
  const p = span(primary);
  const a = span(additional);
  if (!p || !a) return { ok: false, reason: 'NOT_FIXED' };
  const [first, second, firstSpan, secondSpan] = a.start < p.start ? [additional, primary, a, p] : [primary, additional, p, a];
  if (firstSpan.end > secondSpan.start) return { ok: false, reason: 'OVERLAP' };
  if (secondSpan.end - firstSpan.start >= 1440) return { ok: false, reason: 'TOO_LONG' };

  const gap = secondSpan.start - firstSpan.end;
  const breaks: ShiftBreak[] = [...first.breaks, ...second.breaks];
  if (gap > 0) breaks.push({ start: toHhmm(firstSpan.end), end: toHhmm(secondSpan.start), paid: false });
  return {
    ok: true,
    shift: {
      id: primary.id,
      code: `${first.code}+${second.code}`,
      name: `${first.name} + ${second.name}`,
      type: 'FIXED',
      startTime: toHhmm(firstSpan.start),
      endTime: toHhmm(secondSpan.end),
      requiredMinutes: null,
      coreStart: null,
      coreEnd: null,
      dayBoundary: primary.dayBoundary,
      breaks,
      punchInWindowBeforeMinutes: first.punchInWindowBeforeMinutes,
      punchOutWindowAfterMinutes: second.punchOutWindowAfterMinutes,
      graceInMinutes: first.graceInMinutes,
      graceOutMinutes: second.graceOutMinutes,
      segments: [
        { shiftId: first.id, code: first.code, startTime: toHhmm(firstSpan.start), endTime: toHhmm(firstSpan.end) },
        { shiftId: second.id, code: second.code, startTime: toHhmm(secondSpan.start), endTime: toHhmm(secondSpan.end) },
      ],
    },
  };
}
