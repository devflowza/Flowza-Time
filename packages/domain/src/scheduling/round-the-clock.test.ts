import { describe, expect, it } from 'vitest';
import { ROUND_THE_CLOCK_TEMPLATES, roundTheClockInputSchema, shiftPatternInputSchema, type RoundTheClockTemplate } from '@flowza/contracts';
import { patternCycleDay } from '../attendance/resolve-shift.js';
import { buildRoundTheClockPlan, crewSequenceWithShiftIds } from './round-the-clock.js';

const base = { codePrefix: '247', namePrefix: 'Plant', anchorDate: '2026-10-01' };
const plan = (template: RoundTheClockTemplate, extra: Record<string, unknown> = {}) => buildRoundTheClockPlan(roundTheClockInputSchema.parse({ ...base, template, ...extra }));

/** Crews working each shift key on each day of the cycle. */
function crewsPerShiftPerDay(p: ReturnType<typeof plan>): Array<Map<string, string[]>> {
  const cycle = p.crews[0]!.cycleLengthDays;
  return Array.from({ length: cycle }, (_, day) => {
    const m = new Map<string, string[]>(p.shifts.map((s) => [s.key, []]));
    for (const c of p.crews) {
      const e = c.sequence[day]!;
      expect(e.day).toBe(day);
      if ('shiftKey' in e) m.get(e.shiftKey)!.push(c.crew);
    }
    return m;
  });
}

describe('buildRoundTheClockPlan', () => {
  it.each(ROUND_THE_CLOCK_TEMPLATES)('%s covers every shift of every day with exactly one crew', (template) => {
    const p = plan(template);
    expect(p.template).toBe(template);
    expect(p.crews.map((c) => c.crew)).toEqual(['A', 'B', 'C', 'D']);
    for (const day of crewsPerShiftPerDay(p)) for (const crews of day.values()) expect(crews).toHaveLength(1);
    expect(p.coverageCheck).toEqual({ covered: true, minCrewsPerShift: 1 });
    expect(p.averageWeeklyHours).toBe(42);
  });

  it('cycle lengths and shift sets follow the plan (§8)', () => {
    expect(plan('TWO_SHIFT_4ON4OFF').crews[0]!.cycleLengthDays).toBe(16);
    expect(plan('TWO_SHIFT_PANAMA_223').crews[0]!.cycleLengthDays).toBe(28);
    expect(plan('THREE_SHIFT_CONTINENTAL').crews[0]!.cycleLengthDays).toBe(8);
    expect(plan('THREE_SHIFT_WEEKLY').crews[0]!.cycleLengthDays).toBe(28);
    // crew A of the 4-on-4-off: four days, four off, four nights, four off
    const a = plan('TWO_SHIFT_4ON4OFF').crews[0]!.sequence.map((e) => ('off' in e ? '-' : e.shiftKey)).join('');
    expect(a).toBe('DDDD----NNNN----');
    // crew B is the same cycle a quarter later
    const b = plan('TWO_SHIFT_4ON4OFF').crews[1]!.sequence.map((e) => ('off' in e ? '-' : e.shiftKey)).join('');
    expect(b).toBe('----DDDD----NNNN');
    expect(plan('THREE_SHIFT_CONTINENTAL').crews[0]!.sequence.map((e) => ('off' in e ? '-' : e.shiftKey)).join('')).toBe('MMEENN--');
    expect(plan('TWO_SHIFT_PANAMA_223').crews[0]!.sequence.map((e) => ('off' in e ? '-' : e.shiftKey)).join('')).toBe('DD--DDD--DD---NN--NNN--NN---');
  });

  it('shifts run back to back from the first start, with the break and distinct colours', () => {
    const two = plan('TWO_SHIFT_PANAMA_223', { firstShiftStart: '07:00', breakMinutes: 45 });
    expect(two.shifts).toEqual([
      expect.objectContaining({ key: 'D', code: '247-D', name: 'Plant Day', startTime: '07:00', endTime: '19:00', breakMinutes: 45 }),
      expect.objectContaining({ key: 'N', code: '247-N', name: 'Plant Night', startTime: '19:00', endTime: '07:00', breakMinutes: 45 }),
    ]);
    const three = plan('THREE_SHIFT_WEEKLY');
    expect(three.shifts.map((s) => [s.code, s.startTime, s.endTime])).toEqual([['247-M', '06:00', '14:00'], ['247-E', '14:00', '22:00'], ['247-N', '22:00', '06:00']]);
    expect(new Set(three.shifts.map((s) => s.color)).size).toBe(3);
    expect(new Set(two.shifts.map((s) => s.color)).size).toBe(2);
    expect(three.crews.map((c) => [c.code, c.name])).toEqual([['247-A', 'Plant Crew A'], ['247-B', 'Plant Crew B'], ['247-C', 'Plant Crew C'], ['247-D', 'Plant Crew D']]);
  });

  it.each(ROUND_THE_CLOCK_TEMPLATES)('%s crew sequences are valid rotation patterns', (template) => {
    const p = plan(template);
    const ids = new Map(p.shifts.map((s, i) => [s.key, `00000000-0000-4000-8000-00000000000${i + 1}`]));
    for (const c of p.crews) {
      const parsed = shiftPatternInputSchema.safeParse({ code: c.code, name: c.name, cycleLengthDays: c.cycleLengthDays, sequence: crewSequenceWithShiftIds(c.sequence, ids), anchorDate: base.anchorDate });
      expect(parsed.success).toBe(true);
      const days = c.sequence.map((e) => e.day);
      expect(new Set(days).size).toBe(days.length);
      expect(Math.max(...days)).toBeLessThan(c.cycleLengthDays);
    }
  });

  it('the sequence day of a date is patternCycleDay against the shared anchor (what the API stores)', () => {
    const p = plan('THREE_SHIFT_CONTINENTAL');
    const pattern = { anchorDate: '2026-10-01', cycleLengthDays: p.crews[0]!.cycleLengthDays };
    // 2026-10-03 is day 2 of the cycle: crew A works evenings, crew B mornings
    const day = patternCycleDay(pattern, '2026-10-03');
    expect(day).toBe(2);
    expect(p.crews[0]!.sequence[day]).toEqual({ day: 2, shiftKey: 'E' });
    expect(p.crews[1]!.sequence[day]).toEqual({ day: 2, shiftKey: 'M' });
    // before the anchor the cycle runs backwards
    expect(patternCycleDay(pattern, '2026-09-30')).toBe(7);
  });

  it('defaults: 06:00 and a 60-minute break', () => {
    const p = buildRoundTheClockPlan({ template: 'TWO_SHIFT_4ON4OFF', codePrefix: 'X', namePrefix: 'Site' });
    expect(p.shifts[0]).toMatchObject({ startTime: '06:00', endTime: '18:00', breakMinutes: 60 });
  });
});
