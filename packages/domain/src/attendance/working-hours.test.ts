import { beforeEach, describe, expect, it } from 'vitest';
import type { SpecialHoursPeriod } from '@flowza/contracts';
import { applyGrace, calculateDailyRecord, specialPeriodOn } from './calculate.js';
import { composeDoubleShift } from './double-shift.js';
import { ENGINE_VERSION } from './types.js';
import { DATE, at, fixedShift, flexibleShift, input, nightShift, punch, resetIds, rules } from './testing.js';

/*
 * Working-hours policies (engine 1.5.0): a FIXED shift's flexible start band, the rule set's grace mode and approved
 * working-hours periods ("circulars"). Every test pins the trace step that explains the decision.
 */
const D1 = '2026-03-11';
const day = (...times: string[]) => times.map((t) => punch(DATE, t));
const step = (r: ReturnType<typeof calculateDailyRecord>, name: string) => r.trace.steps.find((s) => s.step === name);
/** 07:00–14:00 with a two-hour flexible start (the customer's example). */
const early = fixedShift({ startTime: '07:00', endTime: '14:00', flexStartMinutes: 120 });
const period = (over: Partial<SpecialHoursPeriod> = {}): SpecialHoursPeriod => ({ name: 'Summer hours', reference: 'Circular 12/2026', from: '2026-03-01', to: '2026-03-31', appliesTo: 'all', ...over });

describe('engine version', () => {
  it('is 1.5.1', () => expect(ENGINE_VERSION).toBe('attendance-engine/1.5.1'));
});

describe('flexible start band on a FIXED shift', () => {
  beforeEach(resetIds);

  it('arrive 08:30 on 07:00–14:00 with 120 min: expected 08:30–15:30, not late, a full day', () => {
    const r = calculateDailyRecord(input({ shift: early, rules: rules({ graceInMinutes: 0 }), events: day('08:30', '15:30') }));
    expect(r).toMatchObject({ status: 'PRESENT', expectedStartAt: at(DATE, '08:30'), expectedEndAt: at(DATE, '15:30'), scheduledMinutes: 420, workedMinutes: 420, lateMinutes: 0, earlyDepartureMinutes: 0, overtimeMinutes: 0, flags: [] });
    expect(step(r, 'schedule.flexStart')?.values).toMatchObject({ flexStartMinutes: 120, bandStart: at(DATE, '07:00'), bandEnd: at(DATE, '09:00'), movedMinutes: 90, expectedEnd: at(DATE, '15:30') });
  });

  it('an arrival before the band starts the day at the band start (early-in), the end does not move', () => {
    const r = calculateDailyRecord(input({ shift: early, rules: rules({ countEarlyInAsOvertime: true }), events: day('06:30', '14:00') }));
    expect(r).toMatchObject({ expectedStartAt: at(DATE, '07:00'), expectedEndAt: at(DATE, '14:00'), lateMinutes: 0, overtimeMinutes: 30 });
    expect(step(r, 'schedule.flexStart')?.values).toMatchObject({ movedMinutes: 0 });
  });

  it('after the band: late counts from the band end (+ grace per mode) and the day ends band end + length', () => {
    const deduct = calculateDailyRecord(input({ shift: early, rules: rules({ graceInMinutes: 10 }), events: day('09:20', '16:00') }));
    expect(deduct).toMatchObject({ expectedStartAt: at(DATE, '09:00'), expectedEndAt: at(DATE, '16:00'), lateMinutes: 10, earlyDepartureMinutes: 0 });
    expect(deduct.flags).toContain('LATE');
    expect(step(deduct, 'late')?.detail).toContain('flexible start until');
    resetIds();
    const tolerance = calculateDailyRecord(input({ shift: early, rules: rules({ graceInMinutes: 10, graceMode: 'tolerance' }), events: day('09:20', '16:00') }));
    expect(tolerance.lateMinutes).toBe(20);
  });

  it('leaving before the moved end is early departure; staying after it is overtime', () => {
    const left = calculateDailyRecord(input({ shift: early, events: day('08:30', '15:00') }));
    expect(left).toMatchObject({ earlyDepartureMinutes: 30, overtimeMinutes: 0 });
    expect(left.flags).toContain('EARLY_DEPARTURE');
    resetIds();
    const stayed = calculateDailyRecord(input({ shift: early, events: day('08:30', '16:30') }));
    expect(stayed).toMatchObject({ earlyDepartureMinutes: 0, overtimeMinutes: 60, overtimeCategory: 'REGULAR' });
  });

  it('follows the exact check-in inside the band (seconds included): never a minute late by rounding', () => {
    const r = calculateDailyRecord(input({ shift: early, rules: rules({ graceInMinutes: 0 }), events: day('08:30:40', '15:31') }));
    expect(r).toMatchObject({ lateMinutes: 0, earlyDepartureMinutes: 0, expectedStartAt: '2026-03-10T04:30:40Z', expectedEndAt: '2026-03-10T11:30:40Z' });
  });

  it('no punches: the day is expected from the band start; a missing OUT assumed at the moved end (ASSUME_SHIFT_END)', () => {
    const absent = calculateDailyRecord(input({ shift: early, events: [] }));
    expect(absent).toMatchObject({ status: 'ABSENT', expectedStartAt: at(DATE, '07:00'), expectedEndAt: at(DATE, '14:00') });
    resetIds();
    const assumed = calculateDailyRecord(input({ shift: early, rules: rules({ missingPunchBehavior: 'ASSUME_SHIFT_END' }), events: day('08:00') }));
    expect(assumed).toMatchObject({ status: 'PRESENT', workedMinutes: 420, lastOutAt: null, expectedEndAt: at(DATE, '15:00') });
  });

  it('the punch-out window counts from the latest expected end, so a late band start can still check out', () => {
    const tight = fixedShift({ startTime: '07:00', endTime: '14:00', flexStartMinutes: 120, punchOutWindowAfterMinutes: 0 });
    const r = calculateDailyRecord(input({ shift: tight, events: day('09:00', '16:00') }));
    expect(r.trace.inputs.window).toEqual({ start: at(DATE, '03:00'), end: at(DATE, '16:00') });
    expect(r).toMatchObject({ lastOutAt: at(DATE, '16:00'), workedMinutes: 420, earlyDepartureMinutes: 0 });
  });

  it('overnight is not broken: 22:00–06:00 with a 60 min band, in at 22:40 → expected end 06:40 the next morning', () => {
    const night = nightShift({ flexStartMinutes: 60 });
    const events = [punch(DATE, '22:40'), punch(D1, '06:40')];
    const r = calculateDailyRecord(input({ shift: night, rules: rules({ graceInMinutes: 0 }), events }));
    expect(r).toMatchObject({ status: 'PRESENT', expectedStartAt: at(DATE, '22:40'), expectedEndAt: at(D1, '06:40'), workedMinutes: 480, lateMinutes: 0, earlyDepartureMinutes: 0, overtimeMinutes: 0 });
    expect(r.flags).toContain('CROSS_MIDNIGHT');
  });

  it('a band of 0 changes nothing and a FLEXIBLE shift ignores it', () => {
    const plain = calculateDailyRecord(input({ shift: fixedShift({ flexStartMinutes: 0 }), events: day('09:30', '17:00') }));
    expect(plain).toMatchObject({ expectedStartAt: at(DATE, '09:00'), lateMinutes: 20 });
    expect(step(plain, 'schedule.flexStart')).toBeUndefined();
    resetIds();
    const flex = calculateDailyRecord(input({ shift: flexibleShift({ flexStartMinutes: 120 }), events: day('10:00', '18:00') }));
    expect(step(flex, 'schedule.flexStart')).toBeUndefined();
    expect(flex).toMatchObject({ workedMinutes: 480, lateMinutes: 0, earlyDepartureMinutes: 0 });
  });

  it('a double shift stores no band (its second shift keeps its clock)', () => {
    const morning = fixedShift({ id: 'm', code: 'M', startTime: '06:00', endTime: '10:00', flexStartMinutes: 60 });
    const evening = fixedShift({ id: 'e', code: 'E', startTime: '16:00', endTime: '20:00', flexStartMinutes: 60 });
    const composed = composeDoubleShift(morning, evening);
    expect(composed.ok && composed.shift.flexStartMinutes).toBe(0);
  });
});

describe('grace mode', () => {
  beforeEach(resetIds);

  it('applyGrace: deduct takes the grace off, tolerance forgives within and counts in full beyond', () => {
    expect([applyGrace(15, 10, 'deduct'), applyGrace(10, 10, 'deduct'), applyGrace(0, 10, 'deduct'), applyGrace(-5, 10, 'deduct')]).toEqual([5, 0, 0, 0]);
    expect([applyGrace(15, 10, 'tolerance'), applyGrace(10, 10, 'tolerance'), applyGrace(11, 10, 'tolerance'), applyGrace(3, 0, 'tolerance')]).toEqual([15, 0, 11, 3]);
  });

  it('late arrival: deduct (default) vs tolerance, with the mode in the trace', () => {
    const deduct = calculateDailyRecord(input({ rules: rules({ graceInMinutes: 10 }), events: day('09:15', '17:00') }));
    expect(deduct.lateMinutes).toBe(5);
    expect(step(deduct, 'late')?.values).toMatchObject({ graceMode: 'deduct', minutesAfterExpectedStart: 15, lateMinutes: 5 });
    resetIds();
    const tolerance = calculateDailyRecord(input({ rules: rules({ graceInMinutes: 10, graceMode: 'tolerance' }), events: day('09:15', '17:00') }));
    expect(tolerance.lateMinutes).toBe(15);
    expect(step(tolerance, 'late')?.detail).toContain('beyond it, every minute counts');
    resetIds();
    const within = calculateDailyRecord(input({ rules: rules({ graceInMinutes: 10, graceMode: 'tolerance' }), events: day('09:10', '17:00') }));
    expect(within).toMatchObject({ lateMinutes: 0, flags: [] });
  });

  it('the late threshold still decides the flag on top of the tolerance', () => {
    const r = calculateDailyRecord(input({ rules: rules({ graceInMinutes: 10, graceMode: 'tolerance', lateThresholdMinutes: 20 }), events: day('09:15', '17:00') }));
    expect(r.lateMinutes).toBe(15);
    expect(r.flags).not.toContain('LATE');
  });

  it('early departure on a FIXED shift follows the mode; a shift grace override uses it too', () => {
    const tol = rules({ graceOutMinutes: 10, graceMode: 'tolerance' });
    expect(calculateDailyRecord(input({ rules: tol, events: day('09:00', '16:52') })).earlyDepartureMinutes).toBe(0);
    resetIds();
    expect(calculateDailyRecord(input({ rules: tol, events: day('09:00', '16:45') })).earlyDepartureMinutes).toBe(15);
    resetIds();
    expect(calculateDailyRecord(input({ rules: rules({ graceOutMinutes: 10 }), events: day('09:00', '16:45') })).earlyDepartureMinutes).toBe(5);
    resetIds();
    const override = calculateDailyRecord(input({ shift: fixedShift({ graceInMinutes: 30 }), rules: rules({ graceMode: 'tolerance' }), events: day('09:31', '17:00') }));
    expect(override.lateMinutes).toBe(31);
  });

  it('a FLEXIBLE check-out keeps the 1.3.0 tolerance in both modes; its core-start arrival follows the mode', () => {
    const shift = flexibleShift({ dayBoundary: '00:00', graceOutMinutes: 1 });
    for (const graceMode of ['deduct', 'tolerance'] as const) {
      resetIds();
      const r = calculateDailyRecord(input({ shift, rules: rules({ graceMode }), events: [punch(DATE, '08:00'), punch(DATE, '15:58')] }));
      expect(r.earlyDepartureMinutes).toBe(2);
      expect(step(r, 'earlyDeparture')?.values).toMatchObject({ graceMode: 'tolerance', ruleSetGraceMode: graceMode });
    }
    const core = flexibleShift({ dayBoundary: '00:00', coreStart: '10:00', coreEnd: '14:00' });
    resetIds();
    expect(calculateDailyRecord(input({ shift: core, rules: rules({ graceInMinutes: 10 }), events: day('10:15', '18:15') })).lateMinutes).toBe(5);
    resetIds();
    expect(calculateDailyRecord(input({ shift: core, rules: rules({ graceInMinutes: 10, graceMode: 'tolerance' }), events: day('10:15', '18:15') })).lateMinutes).toBe(15);
  });
});

describe('approved working hours (special periods)', () => {
  beforeEach(resetIds);
  const base = fixedShift({ startTime: '07:00', endTime: '14:00' });

  it('a period with start and end replaces the shift hours, scales the full-day threshold and flags SPECIAL_HOURS', () => {
    const r = calculateDailyRecord(input({ shift: base, rules: rules({ specialPeriods: [period({ startTime: '08:00', endTime: '13:00' })] }), events: day('08:00', '13:00') }));
    expect(r).toMatchObject({ status: 'PRESENT', expectedStartAt: at(DATE, '08:00'), expectedEndAt: at(DATE, '13:00'), scheduledMinutes: 300, workedMinutes: 300, lateMinutes: 0, earlyDepartureMinutes: 0, flags: ['SPECIAL_HOURS'] });
    expect(step(r, 'specialHours')?.values).toMatchObject({ period: 'Summer hours', reference: 'Circular 12/2026', scheduledMinutes: 300, before: { scheduledMinutes: 420 } });
    resetIds();
    expect(calculateDailyRecord(input({ shift: base, rules: rules({ specialPeriods: [period({ startTime: '08:00', endTime: '13:00' })] }), events: day('08:20', '13:00') })).lateMinutes).toBe(10);
  });

  it('scheduled minutes alone end the day start + minutes + unpaid breaks; a start alone keeps the shift length', () => {
    const minutes = calculateDailyRecord(input({ shift: fixedShift({ startTime: '07:00', endTime: '14:00', breaks: [{ minutes: 30, paid: false }] }), rules: rules({ specialPeriods: [period({ scheduledMinutes: 300 })] }), events: day('07:00', '12:30') }));
    expect(minutes).toMatchObject({ expectedEndAt: at(DATE, '12:30'), scheduledMinutes: 300, workedMinutes: 300, earlyDepartureMinutes: 0 });
    resetIds();
    const start = calculateDailyRecord(input({ shift: base, rules: rules({ specialPeriods: [period({ startTime: '08:00' })] }), events: day('08:00', '15:00') }));
    expect(start).toMatchObject({ expectedStartAt: at(DATE, '08:00'), expectedEndAt: at(DATE, '15:00'), scheduledMinutes: 420 });
  });

  it('times plus minutes: the times bound the day, the minutes are what must be worked', () => {
    const r = calculateDailyRecord(input({ shift: base, rules: rules({ specialPeriods: [period({ startTime: '08:00', endTime: '14:00', scheduledMinutes: 300 })] }), events: day('08:00', '14:00') }));
    expect(r).toMatchObject({ expectedStartAt: at(DATE, '08:00'), expectedEndAt: at(DATE, '14:00'), scheduledMinutes: 300, workedMinutes: 360, overtimeMinutes: 0 });
  });

  it('only on the period\'s dates, and only for flagged employees when limited to them', () => {
    const outside = calculateDailyRecord(input({ shift: base, attendanceDate: '2026-04-01', rules: rules({ specialPeriods: [period({ startTime: '08:00', endTime: '13:00' })] }), events: [punch('2026-04-01', '07:00'), punch('2026-04-01', '14:00')] }));
    expect(outside).toMatchObject({ scheduledMinutes: 420, flags: [] });
    const flagged = rules({ specialPeriods: [period({ scheduledMinutes: 300, appliesTo: 'flagged_employees' })] });
    resetIds();
    expect(calculateDailyRecord(input({ shift: base, rules: flagged, events: day('07:00', '14:00') })).flags).not.toContain('SPECIAL_HOURS');
    resetIds();
    expect(calculateDailyRecord(input({ shift: base, rules: flagged, specialHoursEligible: true, events: day('07:00', '12:00') })).flags).toEqual(['SPECIAL_HOURS']);
    expect(specialPeriodOn(flagged, DATE, false)).toBeNull();
    expect(specialPeriodOn(flagged, DATE, true)?.name).toBe('Summer hours');
  });

  it('takes precedence over Ramadan hours on the dates both cover', () => {
    const both = rules({ ramadanMode: { enabled: true, from: '2026-02-18', to: '2026-03-19', scheduledMinutes: 360, appliesTo: 'all' }, specialPeriods: [period({ scheduledMinutes: 300 })] });
    const r = calculateDailyRecord(input({ shift: base, rules: both, events: day('07:00', '12:00') }));
    expect(r).toMatchObject({ scheduledMinutes: 300, expectedEndAt: at(DATE, '12:00'), flags: ['SPECIAL_HOURS'] });
    expect(step(r, 'ramadan')?.values).toMatchObject({ supersededBy: 'Summer hours' });
  });

  it('FLEXIBLE: the minutes are the required minutes; a period with clock times only does not apply (Ramadan still may)', () => {
    const r = calculateDailyRecord(input({ shift: flexibleShift(), rules: rules({ specialPeriods: [period({ scheduledMinutes: 360 })] }), events: day('09:00', '15:00') }));
    expect(r).toMatchObject({ scheduledMinutes: 360, workedMinutes: 360, earlyDepartureMinutes: 0, overtimeMinutes: 0, flags: ['SPECIAL_HOURS'] });
    resetIds();
    const timesOnly = rules({ ramadanMode: { enabled: true, from: '2026-02-18', to: '2026-03-19', scheduledMinutes: 360, appliesTo: 'all' }, specialPeriods: [period({ startTime: '08:00', endTime: '13:00' })] });
    const t = calculateDailyRecord(input({ shift: flexibleShift(), rules: timesOnly, events: day('09:00', '15:00') }));
    expect(t.flags).toEqual(['RAMADAN_HOURS']);
    expect(step(t, 'specialHours')?.detail).toContain('not applied');
  });

  it('combines with a flexible start band: the band follows the period start', () => {
    const r = calculateDailyRecord(input({ shift: fixedShift({ startTime: '07:00', endTime: '14:00', flexStartMinutes: 60 }), rules: rules({ specialPeriods: [period({ startTime: '08:00', endTime: '13:00' })] }), events: day('08:30', '13:30') }));
    expect(r).toMatchObject({ expectedStartAt: at(DATE, '08:30'), expectedEndAt: at(DATE, '13:30'), lateMinutes: 0, earlyDepartureMinutes: 0, scheduledMinutes: 300, flags: ['SPECIAL_HOURS'] });
  });

  it('an overnight period: 23:00–05:00 on a 22:00–06:00 shift ends the next morning', () => {
    const events = [punch(DATE, '23:00'), punch(D1, '05:00')];
    const r = calculateDailyRecord(input({ shift: nightShift(), rules: rules({ specialPeriods: [period({ startTime: '23:00', endTime: '05:00' })] }), events }));
    expect(r).toMatchObject({ status: 'PRESENT', expectedStartAt: at(DATE, '23:00'), expectedEndAt: at(D1, '05:00'), scheduledMinutes: 360, workedMinutes: 360, lateMinutes: 0, earlyDepartureMinutes: 0 });
    expect(r.flags).toEqual(['CROSS_MIDNIGHT', 'SPECIAL_HOURS']);
  });

  it('a half day inside a period halves the period\'s hours', () => {
    const r = calculateDailyRecord(input({ shift: base, leave: { id: 'l1', leaveTypeCode: 'AL', isPaid: true, isHalfDay: true, halfDayPart: 'SECOND_HALF' }, rules: rules({ specialPeriods: [period({ startTime: '08:00', endTime: '13:00' })] }), events: day('08:00', '10:30') }));
    expect(r).toMatchObject({ status: 'HALF_DAY', scheduledMinutes: 150, expectedStartAt: at(DATE, '08:00'), expectedEndAt: at(DATE, '10:30'), earlyDepartureMinutes: 0 });
  });
});
