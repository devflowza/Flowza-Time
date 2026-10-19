import { beforeEach, describe, expect, it } from 'vitest';
import { calculateDailyRecord } from './calculate.js';
import { intersect, minutesIn, subtract, union } from './time-off.js';
import type { EngineHourAllowance, EngineTimeOff } from './types.js';
import { DATE, at, fixedShift, flexibleShift, input, punch, resetIds, rules } from './testing.js';

const FRIDAY = '2026-03-13';
const day = (...times: string[]) => times.map((t) => punch(DATE, t));
const paired = rules({ punchInterpretation: 'PAIRED' });
let n = 0;
function win(start: string, end: string, category: EngineTimeOff['category'] = 'PERSONAL', overrides: Partial<EngineTimeOff> = {}): EngineTimeOff {
  n += 1;
  return { id: `to-${n}`, date: DATE, start: at(DATE, start), end: at(DATE, end), countsAsWork: category === 'OFFICIAL' || category === 'REMOTE', typeCode: category.slice(0, 3), category, ...overrides };
}
const allowance = (minutesPerDay: number, position: EngineHourAllowance['position'], kind: EngineHourAllowance['kind'] = 'NURSING'): EngineHourAllowance => ({ id: `al-${position}`, kind, minutesPerDay, position });
const steps = (r: ReturnType<typeof calculateDailyRecord>) => r.trace.steps.map((s) => s.step);

describe('span helpers', () => {
  it('unions, subtracts and intersects half-open spans', () => {
    expect(union([{ s: 5, e: 10 }, { s: 0, e: 6 }, { s: 12, e: 14 }])).toEqual([{ s: 0, e: 10 }, { s: 12, e: 14 }]);
    expect(subtract([{ s: 0, e: 10 }], [{ s: 2, e: 4 }, { s: 8, e: 20 }])).toEqual([{ s: 0, e: 2 }, { s: 4, e: 8 }]);
    expect(intersect([{ s: 0, e: 10 }], [{ s: 5, e: 15 }])).toEqual([{ s: 5, e: 10 }]);
    expect(minutesIn([{ s: 0, e: 60_000 * 30 }, { s: 60_000 * 10, e: 60_000 * 40 }])).toBe(40);
  });
});

describe('short leave windows (engine 1.5.0)', () => {
  beforeEach(() => { resetIds(); n = 0; });

  it('leaves a day without windows, allowances or gaps as the core computed it (figures 0)', () => {
    const r = calculateDailyRecord(input({ events: day('09:00', '17:00') }));
    expect(r).toMatchObject({ status: 'PRESENT', flags: [], workedMinutes: 480, excusedMinutes: 0, creditedMinutes: 0, lostMinutes: 0 });
    expect(steps(r).some((s) => s.startsWith('timeOff') || s === 'lostTime')).toBe(false);
  });

  it('excuses the lateness a permission at the start of the day covers (grace after it) and the hours it took', () => {
    const plain = calculateDailyRecord(input({ events: day('11:05', '17:00') }));
    expect(plain).toMatchObject({ lateMinutes: 115, flags: ['LATE', 'UNDER_HOURS'] });
    const r = calculateDailyRecord(input({ events: day('11:05', '17:00'), timeOff: [win('09:00', '11:00')] }));
    expect(r).toMatchObject({ status: 'PRESENT', lateMinutes: 0, workedMinutes: 355, excusedMinutes: 120, creditedMinutes: 0, flags: ['SHORT_LEAVE'] });
    expect(steps(r)).toEqual(expect.arrayContaining(['timeOff.windows', 'timeOff.excused', 'timeOff.punctuality', 'timeOff.status']));
  });

  it('only drops the late minutes inside a window that does not cover the start', () => {
    const r = calculateDailyRecord(input({ events: day('11:00', '17:00'), timeOff: [win('10:00', '11:00')] }));
    // late from 09:10 (grace) to 11:00 = 110, minus the 60 inside the window
    expect(r.lateMinutes).toBe(50);
    expect(r.flags).toContain('LATE');
    expect(r.excusedMinutes).toBe(60);
  });

  it('excuses early departure into a permission at the end of the day', () => {
    const r = calculateDailyRecord(input({ events: day('09:00', '15:00'), timeOff: [win('15:00', '17:00')] }));
    expect(r).toMatchObject({ earlyDepartureMinutes: 0, excusedMinutes: 120, status: 'PRESENT' });
    expect(r.flags).not.toContain('EARLY_DEPARTURE');
    expect(r.flags).not.toContain('UNDER_HOURS');
  });

  it('credits an official assignment not overlapping punched work to the worked minutes', () => {
    const r = calculateDailyRecord(input({ events: day('09:00', '13:00'), timeOff: [win('13:00', '17:00', 'OFFICIAL')] }));
    expect(r).toMatchObject({ status: 'PRESENT', workedMinutes: 480, creditedMinutes: 240, excusedMinutes: 0, earlyDepartureMinutes: 0, flags: ['OFFICIAL_ASSIGNMENT'] });
    // FIRST_LAST: an assignment inside the punched span is already worked time — nothing is credited twice
    const inside = calculateDailyRecord(input({ events: day('09:00', '17:00'), timeOff: [win('11:00', '14:00', 'OFFICIAL')] }));
    expect(inside).toMatchObject({ workedMinutes: 480, creditedMinutes: 0 });
  });

  it('makes a remote-work day without punches present', () => {
    const absent = calculateDailyRecord(input({ events: [] }));
    expect(absent.status).toBe('ABSENT');
    const r = calculateDailyRecord(input({ events: [], timeOff: [win('09:00', '17:00', 'REMOTE')] }));
    expect(r).toMatchObject({ status: 'PRESENT', workedMinutes: 480, creditedMinutes: 480, flags: ['REMOTE_WORK'] });
    // a short permission alone does not turn an absence into presence
    const permission = calculateDailyRecord(input({ events: [], timeOff: [win('09:00', '10:00')] }));
    expect(permission).toMatchObject({ status: 'ABSENT', excusedMinutes: 60 });
  });

  it('credits nothing while the punched hours are unknown (missing punch)', () => {
    const r = calculateDailyRecord(input({ events: day('09:00'), timeOff: [win('13:00', '17:00', 'OFFICIAL')] }));
    expect(r).toMatchObject({ status: 'MISSING_PUNCH', creditedMinutes: 0, workedMinutes: 0 });
    expect(r.flags).toContain('OFFICIAL_ASSIGNMENT');
  });

  it('ignores windows on a weekly off, a holiday and a full-day leave', () => {
    const off = calculateDailyRecord(input({ attendanceDate: FRIDAY, events: [], timeOff: [{ ...win('09:00', '17:00', 'REMOTE'), date: FRIDAY, start: at(FRIDAY, '09:00'), end: at(FRIDAY, '17:00') }] }));
    expect(off).toMatchObject({ status: 'WEEKLY_OFF', flags: [], creditedMinutes: 0 });
    const holiday = calculateDailyRecord(input({ holiday: { id: 'h', name: 'National Day', isHalfDay: false }, timeOff: [win('09:00', '11:00')] }));
    expect(holiday).toMatchObject({ status: 'HOLIDAY', flags: [], excusedMinutes: 0 });
  });

  it('is deterministic', () => {
    const once = input({ events: day('09:00', '12:00', '13:30', '16:00'), rules: paired, timeOff: [win('12:00', '12:30'), win('16:00', '17:00', 'OFFICIAL')], hourAllowances: [allowance(30, 'EITHER')] });
    const r = calculateDailyRecord(once);
    expect(calculateDailyRecord(structuredClone(once))).toEqual(r);
    expect(r).toMatchObject({ creditedMinutes: 60, excusedMinutes: 30, lostMinutes: 60, scheduledMinutes: 450 });
  });
});

describe('lost time (out of office during working hours)', () => {
  beforeEach(() => { resetIds(); n = 0; });

  it('counts the PAIRED gaps inside the schedule as lost time', () => {
    const r = calculateDailyRecord(input({ events: day('09:00', '12:00', '13:00', '17:00'), rules: paired }));
    expect(r).toMatchObject({ lostMinutes: 60, workedMinutes: 420 });
    expect(r.flags).toContain('LOST_TIME');
    expect(steps(r)).toContain('lostTime');
  });

  it('tolerates the rule set allowance (the customer uses 20 minutes)', () => {
    const r = calculateDailyRecord(input({ events: day('09:00', '12:00', '12:15', '17:00'), rules: rules({ punchInterpretation: 'PAIRED', outOfOfficeAllowanceMinutes: 20 }) }));
    expect(r.lostMinutes).toBe(0);
    expect(r.flags).not.toContain('LOST_TIME');
    const longer = calculateDailyRecord(input({ events: day('09:00', '12:00', '13:00', '17:00'), rules: rules({ punchInterpretation: 'PAIRED', outOfOfficeAllowanceMinutes: 20 }) }));
    expect(longer.lostMinutes).toBe(40);
  });

  it('does not count time an approved window covers, nor the scheduled break', () => {
    const covered = calculateDailyRecord(input({ events: day('09:00', '12:00', '13:00', '17:00'), rules: rules({ punchInterpretation: 'PAIRED', outOfOfficeAllowanceMinutes: 20 }), timeOff: [win('12:00', '12:30')] }));
    expect(covered).toMatchObject({ lostMinutes: 10, excusedMinutes: 30 });
    expect(covered.flags).toEqual(expect.arrayContaining(['SHORT_LEAVE', 'LOST_TIME']));
    const official = calculateDailyRecord(input({ events: day('09:00', '12:00', '13:00', '17:00'), rules: paired, timeOff: [win('12:00', '13:00', 'OFFICIAL')] }));
    expect(official).toMatchObject({ lostMinutes: 0, creditedMinutes: 60, workedMinutes: 480 });
    const lunch = calculateDailyRecord(input({ shift: fixedShift({ breaks: [{ start: '12:00', end: '12:45', paid: false }] }), events: day('09:00', '12:00', '13:00', '17:00'), rules: paired }));
    expect(lunch.lostMinutes).toBe(15);
    const allowanceBreak = calculateDailyRecord(input({ shift: fixedShift({ breaks: [{ minutes: 30, paid: false }] }), events: day('09:00', '12:00', '13:00', '17:00'), rules: paired }));
    expect(allowanceBreak.lostMinutes).toBe(30);
  });

  it('counts DIRECTIONAL out / in gaps but not explicit break punches', () => {
    const directional = rules({ punchInterpretation: 'DIRECTIONAL' });
    const out = calculateDailyRecord(input({ events: [punch(DATE, '09:00', 'PUNCH_IN'), punch(DATE, '11:00', 'PUNCH_OUT'), punch(DATE, '11:45', 'PUNCH_IN'), punch(DATE, '17:00', 'PUNCH_OUT')], rules: directional }));
    expect(out.lostMinutes).toBe(45);
    resetIds();
    const breakPunches = calculateDailyRecord(input({ events: [punch(DATE, '09:00', 'PUNCH_IN'), punch(DATE, '12:00', 'BREAK_START'), punch(DATE, '12:30', 'BREAK_END'), punch(DATE, '17:00', 'PUNCH_OUT')], rules: directional }));
    expect(breakPunches.lostMinutes).toBe(0);
  });

  it('loses nothing in FIRST_LAST, which ignores mid-day punches', () => {
    const r = calculateDailyRecord(input({ events: day('09:00', '12:00', '13:00', '17:00') }));
    expect(r).toMatchObject({ lostMinutes: 0, workedMinutes: 480 });
    expect(r.flags).not.toContain('LOST_TIME');
  });

  it('only counts gaps inside the scheduled span', () => {
    // out between 17:00 and 18:00 (after the shift end): not lost
    const r = calculateDailyRecord(input({ events: day('09:00', '17:00', '18:00', '19:00'), rules: paired }));
    expect(r.lostMinutes).toBe(0);
  });
});

describe('reduced hours (nursing hour, disability)', () => {
  beforeEach(() => { resetIds(); n = 0; });

  it('START moves the expected start later: no lateness within it', () => {
    const r = calculateDailyRecord(input({ events: day('10:00', '17:00'), hourAllowances: [allowance(60, 'START')] }));
    expect(r).toMatchObject({ scheduledMinutes: 420, lateMinutes: 0, expectedStartAt: at(DATE, '10:00'), status: 'PRESENT', flags: ['REDUCED_HOURS'] });
    // beyond the allowance (and the grace) the arrival is late
    resetIds();
    const late = calculateDailyRecord(input({ events: day('10:30', '17:00'), hourAllowances: [allowance(60, 'START')] }));
    expect(late.lateMinutes).toBe(20);
    expect(late.flags).toEqual(['LATE', 'REDUCED_HOURS']);
  });

  it('END moves the expected end earlier', () => {
    const r = calculateDailyRecord(input({ events: day('09:00', '16:00'), hourAllowances: [allowance(60, 'END', 'DISABILITY')] }));
    expect(r).toMatchObject({ scheduledMinutes: 420, earlyDepartureMinutes: 0, expectedEndAt: at(DATE, '16:00'), status: 'PRESENT', flags: ['REDUCED_HOURS'] });
  });

  it('EITHER forgives lateness first, then early departure', () => {
    const both = calculateDailyRecord(input({ events: day('09:40', '16:30'), hourAllowances: [allowance(60, 'EITHER')] }));
    expect(both).toMatchObject({ lateMinutes: 0, earlyDepartureMinutes: 0, scheduledMinutes: 420, flags: ['REDUCED_HOURS'] });
    resetIds();
    const lateOnly = calculateDailyRecord(input({ events: day('10:30', '16:30'), hourAllowances: [allowance(60, 'EITHER')] }));
    // 80 late (from 09:10) − 60 → 20 late; the early 30 keeps nothing to forgive it with
    expect(lateOnly).toMatchObject({ lateMinutes: 20, earlyDepartureMinutes: 30 });
    expect(lateOnly.flags).toEqual(expect.arrayContaining(['LATE', 'EARLY_DEPARTURE', 'REDUCED_HOURS']));
  });

  it('scales the full-day threshold to the reduced schedule', () => {
    // 07:00 worked on an 8 h day is under hours; with a 60-min allowance it is a full day
    const plain = calculateDailyRecord(input({ events: day('09:00', '16:00'), rules: rules({ minFullDayMinutes: 450 }) }));
    expect(plain.flags).toContain('UNDER_HOURS');
    resetIds();
    const reduced = calculateDailyRecord(input({ events: day('09:00', '16:00'), rules: rules({ minFullDayMinutes: 450 }), hourAllowances: [allowance(60, 'END')] }));
    expect(reduced.flags).not.toContain('UNDER_HOURS');
  });

  it('a flexible day: the reduced minutes shorten the required hours', () => {
    const r = calculateDailyRecord(input({ shift: flexibleShift(), events: day('09:00', '16:00'), hourAllowances: [allowance(60, 'END')] }));
    expect(r).toMatchObject({ scheduledMinutes: 420, earlyDepartureMinutes: 0 });
    expect(r.flags).not.toContain('EARLY_DEPARTURE');
  });

  it('does nothing on a non-working day', () => {
    const r = calculateDailyRecord(input({ attendanceDate: FRIDAY, events: [], hourAllowances: [allowance(60, 'START')] }));
    expect(r).toMatchObject({ status: 'WEEKLY_OFF', scheduledMinutes: 0, flags: [] });
  });
});
