import type { RoundTheClockInput, RoundTheClockPlanDto, RoundTheClockTemplate } from '@flowza/contracts';

/*
 * Round-the-clock (24/7) rotation templates (Enterprise, module `advanced_scheduling`; docs/enterprise/plan.md §8). Pure.
 *
 * A template is a set of back-to-back shifts covering the 24 hours of a day (2 × 12 h or 3 × 8 h, starting at
 * `firstShiftStart`) and ONE base cycle of shift keys / off days. Four crews (A–D) follow that cycle, each offset by a
 * quarter of it (cycle / 4 days), so every shift of every day is worked by exactly one crew:
 *
 *   TWO_SHIFT_4ON4OFF        D D D D · · · · N N N N · · · ·                           (16 days)
 *   TWO_SHIFT_PANAMA_223     2-2-3 on days for 14 days, then the same on nights          (28 days)
 *   THREE_SHIFT_CONTINENTAL  M M E E N N · ·                                           (8 days)
 *   THREE_SHIFT_WEEKLY       a week of mornings, of evenings, of nights, a week off      (28 days)
 *
 * The crew offset is folded into each crew's SEQUENCE (crew k works on day d what the base cycle has on day d − k·cycle/4),
 * so every crew's rotation pattern uses the same anchor date (day 0 of the cycle). `patternCycleDay(pattern, date)` maps a
 * date onto that sequence exactly as the preview shows it — the web renders `sequence` day by day per crew without knowing
 * any offset.
 *
 * Average weekly hours are the scheduled (gross) shift hours: 42 for all four templates (the unpaid break inside each shift
 * is part of the shift's span and is deducted by the engine from the worked time, not from the roster).
 */

export const ROUND_THE_CLOCK_CREWS = ['A', 'B', 'C', 'D'] as const;
export type RoundTheClockCrew = (typeof ROUND_THE_CLOCK_CREWS)[number];

interface TemplateShift { key: string; label: string; hours: number; color: string }
interface TemplateDef { shifts: TemplateShift[]; cycle: Array<string | null> }

const DAY_COLOR = '#F59E0B';
const NIGHT_COLOR = '#4338CA';
const MORNING_COLOR = '#0EA5E9';
const EVENING_COLOR = '#F97316';

const repeat = <T>(value: T, n: number): T[] => Array.from({ length: n }, () => value);
/** Panama 2-2-3 over 14 days: work 2, off 2, work 3, off 2, work 2, off 3 (7 shifts). Shifted by 7 days it is its own complement. */
const PANAMA = [1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0] as const;
const panama = (key: string): Array<string | null> => PANAMA.map((w) => (w ? key : null));

const TWO_SHIFTS: TemplateShift[] = [
  { key: 'D', label: 'Day', hours: 12, color: DAY_COLOR },
  { key: 'N', label: 'Night', hours: 12, color: NIGHT_COLOR },
];
const THREE_SHIFTS: TemplateShift[] = [
  { key: 'M', label: 'Morning', hours: 8, color: MORNING_COLOR },
  { key: 'E', label: 'Evening', hours: 8, color: EVENING_COLOR },
  { key: 'N', label: 'Night', hours: 8, color: NIGHT_COLOR },
];

export const ROUND_THE_CLOCK_TEMPLATE_DEFS: Readonly<Record<RoundTheClockTemplate, TemplateDef>> = {
  TWO_SHIFT_4ON4OFF: { shifts: TWO_SHIFTS, cycle: [...repeat('D', 4), ...repeat(null, 4), ...repeat('N', 4), ...repeat(null, 4)] },
  TWO_SHIFT_PANAMA_223: { shifts: TWO_SHIFTS, cycle: [...panama('D'), ...panama('N')] },
  THREE_SHIFT_CONTINENTAL: { shifts: THREE_SHIFTS, cycle: ['M', 'M', 'E', 'E', 'N', 'N', null, null] },
  THREE_SHIFT_WEEKLY: { shifts: THREE_SHIFTS, cycle: [...repeat('M', 7), ...repeat('E', 7), ...repeat('N', 7), ...repeat(null, 7)] },
};

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};
const toHhmm = (minutes: number): string => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const mod = (n: number, m: number): number => ((n % m) + m) % m;

export type RoundTheClockPlanInput = Pick<RoundTheClockInput, 'template' | 'codePrefix' | 'namePrefix'> & Partial<Pick<RoundTheClockInput, 'firstShiftStart' | 'breakMinutes'>>;

/** The shifts, crew patterns, 24/7 coverage proof and average hours of a template (nothing is created). */
export function buildRoundTheClockPlan(input: RoundTheClockPlanInput): RoundTheClockPlanDto {
  const def = ROUND_THE_CLOCK_TEMPLATE_DEFS[input.template];
  const prefix = input.codePrefix.trim();
  const namePrefix = input.namePrefix.trim();
  const breakMinutes = input.breakMinutes ?? 60;
  let start = toMinutes((input.firstShiftStart ?? '06:00').slice(0, 5));
  const shifts: RoundTheClockPlanDto['shifts'] = def.shifts.map((s) => {
    const shift = { key: s.key, code: `${prefix}-${s.key}`, name: `${namePrefix} ${s.label}`, startTime: toHhmm(start), endTime: toHhmm(start + s.hours * 60), breakMinutes, color: s.color };
    start += s.hours * 60;
    return shift;
  });

  const cycleLengthDays = def.cycle.length;
  const offset = cycleLengthDays / ROUND_THE_CLOCK_CREWS.length;
  const crews: RoundTheClockPlanDto['crews'] = ROUND_THE_CLOCK_CREWS.map((crew, k) => ({
    crew,
    code: `${prefix}-${crew}`,
    name: `${namePrefix} Crew ${crew}`,
    cycleLengthDays,
    sequence: def.cycle.map((_, day) => {
      const key = def.cycle[mod(day - k * offset, cycleLengthDays)] ?? null;
      return key === null ? { day, off: true as const } : { day, shiftKey: key };
    }),
  }));

  // coverage: on every day of the cycle, how many crews work each shift (one person per crew)
  let minCrewsPerShift = Number.POSITIVE_INFINITY;
  for (let day = 0; day < cycleLengthDays; day += 1) {
    for (const s of def.shifts) {
      const n = crews.filter((c) => { const e = c.sequence[day]; return !!e && 'shiftKey' in e && e.shiftKey === s.key; }).length;
      minCrewsPerShift = Math.min(minCrewsPerShift, n);
    }
  }
  if (!Number.isFinite(minCrewsPerShift)) minCrewsPerShift = 0;

  const hoursByKey = new Map(def.shifts.map((s) => [s.key, s.hours]));
  const cycleHours = def.cycle.reduce((sum, key) => sum + (key === null ? 0 : hoursByKey.get(key) ?? 0), 0);
  const averageWeeklyHours = Math.round((cycleHours / (cycleLengthDays / 7)) * 100) / 100;

  return { template: input.template, shifts, crews, coverageCheck: { covered: minCrewsPerShift >= 1, minCrewsPerShift }, averageWeeklyHours };
}

/** A crew's sequence with the plan's shift keys replaced by created shift ids (the `shift_patterns.sequence` shape). */
export function crewSequenceWithShiftIds(sequence: RoundTheClockPlanDto['crews'][number]['sequence'], shiftIdByKey: ReadonlyMap<string, string>): Array<{ day: number; shiftId: string } | { day: number; off: true }> {
  return sequence.map((e) => {
    if ('off' in e) return { day: e.day, off: true as const };
    const shiftId = shiftIdByKey.get(e.shiftKey);
    if (!shiftId) throw new Error(`unknown shift key ${e.shiftKey}`);
    return { day: e.day, shiftId };
  });
}
