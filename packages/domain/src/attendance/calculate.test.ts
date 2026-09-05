import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@flowza/shared';
import { calculateDailyRecord, finaliseOvertime } from './calculate.js';
import { ENGINE_VERSION } from './types.js';
import { DATE, MUSCAT, RIYADH, at, fixedShift, flexibleShift, input, nightShift, punch, resetIds, rules } from './testing.js';

const D1 = '2026-03-11';
const FRIDAY = '2026-03-13';
const AFTER_WINDOW = at(DATE, '23:30'); // window of the 09:00–17:00 shift closes at 23:00
const DURING_SHIFT = at(DATE, '12:00');

function day(...times: string[]) {
  return times.map((t) => punch(DATE, t));
}

function stepNames(result: ReturnType<typeof calculateDailyRecord>): string[] {
  return result.trace.steps.map((s) => s.step);
}

describe('calculateDailyRecord — fixed shift basics', () => {
  beforeEach(resetIds);

  it('marks an on-time full day PRESENT with no flags and a complete trace', () => {
    const r = calculateDailyRecord(input({ events: day('08:55', '17:05') }));
    expect(r).toMatchObject({
      status: 'PRESENT',
      flags: [],
      workedMinutes: 490,
      scheduledMinutes: 480,
      lateMinutes: 0,
      earlyDepartureMinutes: 0,
      overtimeMinutes: 0,
      overtimeCategory: null,
      breakMinutes: 0,
      punchCount: 2,
      expectedStartAt: '2026-03-10T05:00:00Z',
      expectedEndAt: '2026-03-10T13:00:00Z',
      firstInAt: at(DATE, '08:55'),
      lastOutAt: at(DATE, '17:05'),
      shiftId: 'shift-day',
      ruleSetId: 'rules-1',
      shiftAssignmentId: 'assign-1',
    });
    expect(r.eventIds).toEqual(['evt-001', 'evt-002']);
    expect(r.trace.engineVersion).toBe(ENGINE_VERSION);
    expect(r.trace.inputs).toEqual({ shiftId: 'shift-day', shiftType: 'FIXED', ruleSetId: 'rules-1', timezone: MUSCAT, window: { start: at(DATE, '05:00'), end: at(DATE, '23:00') }, holiday: null, leave: null, weeklyOff: false });
    expect(r.trace.punches.map((p) => p.role)).toEqual(['IN', 'OUT']);
    expect(stepNames(r)).toEqual(expect.arrayContaining(['window', 'attribution', 'interpretation', 'dayType', 'schedule', 'breaks', 'worked', 'late', 'earlyDeparture', 'overtime', 'status']));
  });

  it('is deterministic', () => {
    const a = calculateDailyRecord(input({ events: day('08:55', '17:05') }));
    resetIds();
    const b = calculateDailyRecord(input({ events: day('08:55', '17:05') }));
    expect(a).toEqual(b);
  });

  it('does not count lateness inside the grace period', () => {
    const r = calculateDailyRecord(input({ events: day('09:08', '17:00') }));
    expect(r.lateMinutes).toBe(0);
    expect(r.flags).not.toContain('LATE');
    expect(r.status).toBe('PRESENT');
  });

  it('computes late minutes beyond grace and flags when above the threshold', () => {
    const r = calculateDailyRecord(input({ events: day('09:25', '17:00') }));
    expect(r.lateMinutes).toBe(15);
    expect(r.flags).toContain('LATE');
    const lenient = calculateDailyRecord(input({ events: day('09:25', '17:00'), rules: rules({ lateThresholdMinutes: 20 }) }));
    expect(lenient.lateMinutes).toBe(15);
    expect(lenient.flags).not.toContain('LATE');
    expect(lenient.trace.steps.find((s) => s.step === 'late')?.values).toMatchObject({ lateMinutes: 15, thresholdMinutes: 20, flagged: false });
  });

  it('uses the shift grace override when set', () => {
    const r = calculateDailyRecord(input({ shift: fixedShift({ graceInMinutes: 30 }), events: day('09:25', '17:00') }));
    expect(r.lateMinutes).toBe(0);
  });

  it('computes early departure with graceOut and threshold', () => {
    const r = calculateDailyRecord(input({ events: day('09:00', '16:30') }));
    expect(r.earlyDepartureMinutes).toBe(30);
    expect(r.flags).toContain('EARLY_DEPARTURE');
    expect(r.workedMinutes).toBe(450);
    const graced = calculateDailyRecord(input({ events: day('09:00', '16:30'), rules: rules({ graceOutMinutes: 15, earlyDepartureThresholdMinutes: 20 }) }));
    expect(graced.earlyDepartureMinutes).toBe(15);
    expect(graced.flags).not.toContain('EARLY_DEPARTURE');
  });

  it('flags UNDER_HOURS and HALF_DAY per thresholds', () => {
    const under = calculateDailyRecord(input({ events: day('09:00', '15:00') }));
    expect(under).toMatchObject({ status: 'PRESENT', workedMinutes: 360 });
    expect(under.flags).toContain('UNDER_HOURS');
    const half = calculateDailyRecord(input({ events: day('09:00', '12:20') }));
    expect(half).toMatchObject({ status: 'HALF_DAY', workedMinutes: 200, earlyDepartureMinutes: 280 });
    expect(half.flags).toEqual(expect.arrayContaining(['EARLY_DEPARTURE', 'UNDER_HOURS']));
  });

  it('deducts unpaid fixed breaks from scheduled and worked minutes', () => {
    const shift = fixedShift({ breaks: [{ start: '13:00', end: '14:00', paid: false }] });
    const full = calculateDailyRecord(input({ shift, events: day('09:00', '17:00') }));
    expect(full).toMatchObject({ scheduledMinutes: 420, workedMinutes: 420, breakMinutes: 60 });
    const left = calculateDailyRecord(input({ shift, events: day('09:00', '12:00') }));
    expect(left).toMatchObject({ workedMinutes: 180, breakMinutes: 0 });
  });

  it('rounds worked minutes per rule set', () => {
    const r = calculateDailyRecord(input({ events: day('08:55', '17:05'), rules: rules({ workedRoundingMinutes: 15, workedRoundingMode: 'DOWN' }) }));
    expect(r.workedMinutes).toBe(480);
  });
});

describe('calculateDailyRecord — overtime', () => {
  beforeEach(resetIds);

  it('applies threshold, rounding, minimum block and cap', () => {
    const r = calculateDailyRecord(input({ events: day('09:00', '18:50') }));
    // 110 min after end − 30 threshold = 80 → DOWN 15 → 75 → 30-min blocks → 60
    expect(r).toMatchObject({ overtimeMinutes: 60, overtimeCategory: 'REGULAR', workedMinutes: 590 });
    expect(r.flags).toContain('OVERTIME');
    const capped = calculateDailyRecord(input({ events: day('09:00', '18:50'), rules: rules({ overtimeMaxMinutesPerDay: 45 }) }));
    expect(capped.overtimeMinutes).toBe(45);
    const raw = calculateDailyRecord(input({ events: day('09:00', '18:50'), rules: rules({ overtimeStartAfterMinutes: 0, overtimeMinBlockMinutes: 0, overtimeRoundingMinutes: 0 }) }));
    expect(raw.overtimeMinutes).toBe(110);
  });

  it('does not award overtime below the threshold or when disabled', () => {
    expect(calculateDailyRecord(input({ events: day('09:00', '17:25') })).overtimeMinutes).toBe(0);
    const disabled = calculateDailyRecord(input({ events: day('09:00', '18:50'), rules: rules({ overtimeEnabled: false }) }));
    expect(disabled.overtimeMinutes).toBe(0);
    expect(disabled.flags).not.toContain('OVERTIME');
  });

  it('optionally counts early arrival as overtime', () => {
    const r = calculateDailyRecord(input({ events: day('08:00', '17:00'), rules: rules({ countEarlyInAsOvertime: true, overtimeStartAfterMinutes: 0, overtimeMinBlockMinutes: 0, overtimeRoundingMinutes: 0 }) }));
    expect(r.overtimeMinutes).toBe(60);
    const off = calculateDailyRecord(input({ events: day('08:00', '17:00'), rules: rules({ overtimeStartAfterMinutes: 0, overtimeMinBlockMinutes: 0, overtimeRoundingMinutes: 0 }) }));
    expect(off.overtimeMinutes).toBe(0);
  });

  it('finaliseOvertime rounds down, keeps whole blocks and caps', () => {
    expect(finaliseOvertime(80, rules())).toBe(60);
    expect(finaliseOvertime(29, rules())).toBe(0);
    expect(finaliseOvertime(125, rules({ overtimeMaxMinutesPerDay: 90 }))).toBe(90);
    expect(finaliseOvertime(47, rules({ overtimeMinBlockMinutes: 0, overtimeRoundingMinutes: 0 }))).toBe(47);
  });
});

describe('calculateDailyRecord — punch rounding and interpretation', () => {
  beforeEach(resetIds);

  it.each([
    ['NEAREST', '08:45', '17:15', 510],
    ['UP', '09:00', '17:15', 495],
    ['DOWN', '08:45', '17:00', 495],
  ] as const)('rounds punches %s to 15 minutes and keeps raw values in the trace', (mode, inTime, outTime, worked) => {
    const r = calculateDailyRecord(input({ events: day('08:52', '17:08'), rules: rules({ punchRoundingMinutes: 15, punchRoundingMode: mode }) }));
    expect(r.firstInAt).toBe(at(DATE, inTime));
    expect(r.lastOutAt).toBe(at(DATE, outTime));
    expect(r.workedMinutes).toBe(worked);
    const step = r.trace.steps.find((s) => s.step === 'rounding.punches');
    expect(step?.values).toMatchObject({ rawIn: at(DATE, '08:52'), rawOut: at(DATE, '17:08') });
    expect(r.trace.punches.map((p) => p.punchedAt)).toEqual([at(DATE, '08:52'), at(DATE, '17:08')]);
  });

  it('FIRST_LAST with six punches ignores the intermediate four but counts them', () => {
    const r = calculateDailyRecord(input({ events: day('09:00', '10:00', '10:30', '13:00', '13:45', '17:00') }));
    expect(r).toMatchObject({ status: 'PRESENT', workedMinutes: 480, punchCount: 6, breakMinutes: 0 });
    expect(r.eventIds).toHaveLength(6);
    expect(r.trace.punches.filter((p) => p.role === 'IGNORED')).toHaveLength(4);
  });

  it('PAIRED measures gaps as breaks and flags an odd punch count as MISSING_OUT', () => {
    const paired = rules({ punchInterpretation: 'PAIRED' });
    const even = calculateDailyRecord(input({ events: day('09:00', '13:00', '14:00', '18:00'), rules: paired }));
    expect(even).toMatchObject({ status: 'PRESENT', workedMinutes: 480, breakMinutes: 60 });
    const odd = calculateDailyRecord(input({ events: day('09:00', '13:00', '14:00'), rules: paired, now: AFTER_WINDOW }));
    expect(odd.flags).toContain('MISSING_OUT');
    expect(odd.workedMinutes).toBe(240);
    expect(odd.lastOutAt).toBe(at(DATE, '13:00'));
  });

  it('DIRECTIONAL trusts device directions and break events', () => {
    const events = [punch(DATE, '09:00', 'PUNCH_IN'), punch(DATE, '13:00', 'BREAK_START'), punch(DATE, '13:45', 'BREAK_END'), punch(DATE, '17:00', 'PUNCH_OUT')];
    const r = calculateDailyRecord(input({ events, rules: rules({ punchInterpretation: 'DIRECTIONAL' }) }));
    expect(r).toMatchObject({ status: 'PRESENT', workedMinutes: 435, breakMinutes: 45 });
    expect(r.trace.punches.map((p) => p.role)).toEqual(['IN', 'BREAK_START', 'BREAK_END', 'OUT']);
    const paidBreak = calculateDailyRecord(input({ events, shift: fixedShift({ breaks: [{ minutes: 30, paid: true }] }), rules: rules({ punchInterpretation: 'DIRECTIONAL' }) }));
    expect(paidBreak).toMatchObject({ workedMinutes: 465, breakMinutes: 15 });
  });

  it('collapses duplicate punches within the window, keeping the first', () => {
    const events = [punch(DATE, '09:00:00'), punch(DATE, '09:00:30'), punch(DATE, '17:00')];
    const r = calculateDailyRecord(input({ events }));
    expect(r).toMatchObject({ status: 'PRESENT', workedMinutes: 480, punchCount: 3 });
    expect(r.flags).toContain('DUPLICATE_PUNCHES_COLLAPSED');
    expect(r.eventIds).toEqual(['evt-001', 'evt-002', 'evt-003']);
    expect(r.trace.punches.map((p) => p.role)).toEqual(['IN', 'DUPLICATE', 'OUT']);
  });

  it('flags MANUAL_CORRECTION when a manual event is attributed', () => {
    const r = calculateDailyRecord(input({ events: [punch(DATE, '09:00'), punch(DATE, '17:00', 'PUNCH', MUSCAT, { source: 'MANUAL' })] }));
    expect(r.flags).toContain('MANUAL_CORRECTION');
  });

  it('lists voided events as IGNORED and excludes them from eventIds', () => {
    const voided = punch(DATE, '08:00', 'PUNCH', MUSCAT, { voided: true });
    const r = calculateDailyRecord(input({ events: [voided, ...day('09:00', '17:00')] }));
    expect(r.eventIds).not.toContain(voided.id);
    expect(r.punchCount).toBe(2);
    expect(r.trace.punches.find((p) => p.eventId === voided.id)).toMatchObject({ role: 'IGNORED', note: 'voided event' });
    expect(r.lateMinutes).toBe(0);
  });

  it('flags OUT_OF_WINDOW punches on the calendar day and keeps them out of the record', () => {
    const stray = punch(DATE, '03:00');
    const r = calculateDailyRecord(input({ events: [stray, ...day('09:00', '17:00')] }));
    expect(r.flags).toContain('OUT_OF_WINDOW');
    expect(r.eventIds).not.toContain(stray.id);
    expect(r.trace.punches.find((p) => p.eventId === stray.id)?.role).toBe('OUT_OF_WINDOW');
    expect(r.status).toBe('PRESENT');
  });
});

describe('calculateDailyRecord — cross-midnight', () => {
  beforeEach(resetIds);

  it('attributes IN 21:57 (D) and OUT 06:08 (D+1) to D and works 8h11m', () => {
    const r = calculateDailyRecord(input({ shift: nightShift(), events: [punch(DATE, '21:57'), punch(D1, '06:08')] }));
    expect(r).toMatchObject({ status: 'PRESENT', workedMinutes: 491, lateMinutes: 0, earlyDepartureMinutes: 0, overtimeMinutes: 0, expectedStartAt: at(DATE, '22:00'), expectedEndAt: at(D1, '06:00') });
    expect(r.flags).toEqual(['CROSS_MIDNIGHT']);
    expect(r.trace.inputs.window).toEqual({ start: at(DATE, '18:00'), end: at(D1, '12:00') });
  });

  it('keeps two consecutive nights on their own attendance dates', () => {
    const events = [punch(DATE, '21:57'), punch(D1, '06:08'), punch(D1, '21:50'), punch('2026-03-12', '06:02')];
    const first = calculateDailyRecord(input({ shift: nightShift(), events }));
    const second = calculateDailyRecord(input({ shift: nightShift(), events, attendanceDate: D1 }));
    expect(first.eventIds).toEqual(['evt-001', 'evt-002']);
    expect(second.eventIds).toEqual(['evt-003', 'evt-004']);
    expect(first.workedMinutes).toBe(491);
    expect(second.workedMinutes).toBe(492);
    expect(first.trace.punches.filter((p) => p.role === 'OUT_OF_WINDOW')).toHaveLength(2);
  });

  it('uses adjacentShifts for neighbouring windows when the schedule differs', () => {
    // Night on D, no shift on D+1: the 06:08 D+1 punch still belongs to D.
    const r = calculateDailyRecord(input({ shift: nightShift(), adjacentShifts: { previous: null, next: null }, events: [punch(DATE, '21:57'), punch(D1, '06:08')] }));
    expect(r.workedMinutes).toBe(491);
  });
});

describe('calculateDailyRecord — no punches and missing punches', () => {
  beforeEach(resetIds);

  it('is PENDING before the window closes and ABSENT afterwards', () => {
    expect(calculateDailyRecord(input({ now: DURING_SHIFT })).status).toBe('PENDING');
    expect(calculateDailyRecord(input({ now: AFTER_WINDOW })).status).toBe('ABSENT');
    expect(calculateDailyRecord(input()).status).toBe('ABSENT'); // no `now` → historical → day over
  });

  it('stays PENDING for review when auto-absent is disabled', () => {
    expect(calculateDailyRecord(input({ now: AFTER_WINDOW, rules: rules({ autoAbsentWithoutPunches: false }) })).status).toBe('PENDING');
  });

  it('treats IN without OUT as still working while the window is open', () => {
    const r = calculateDailyRecord(input({ events: day('09:20'), now: DURING_SHIFT }));
    expect(r.status).toBe('PENDING');
    expect(r.firstInAt).toBe(at(DATE, '09:20'));
    expect(r.lateMinutes).toBe(10);
    expect(r.flags).not.toContain('MISSING_OUT');
  });

  it('FLAG_ONLY: PRESENT with MISSING_OUT and unknown worked minutes', () => {
    const r = calculateDailyRecord(input({ events: day('09:20'), now: AFTER_WINDOW }));
    expect(r).toMatchObject({ status: 'PRESENT', workedMinutes: 0, lateMinutes: 10, lastOutAt: null, overtimeMinutes: 0 });
    expect(r.flags).toEqual(['LATE', 'MISSING_OUT']);
  });

  it('ASSUME_SHIFT_END: worked to the expected end, no overtime, real timestamps only', () => {
    const r = calculateDailyRecord(input({ events: day('09:00'), now: AFTER_WINDOW, rules: rules({ missingPunchBehavior: 'ASSUME_SHIFT_END' }) }));
    expect(r).toMatchObject({ status: 'PRESENT', workedMinutes: 480, overtimeMinutes: 0, earlyDepartureMinutes: 0, lastOutAt: null, firstInAt: at(DATE, '09:00') });
    expect(r.flags).toEqual(['MISSING_OUT']);
    expect(r.trace.steps.find((s) => s.step === 'missingPunch')?.values).toMatchObject({ assumed: at(DATE, '17:00') });
  });

  it('TREAT_AS_ABSENT and TREAT_AS_HALF_DAY', () => {
    expect(calculateDailyRecord(input({ events: day('09:00'), now: AFTER_WINDOW, rules: rules({ missingPunchBehavior: 'TREAT_AS_ABSENT' }) })).status).toBe('ABSENT');
    const half = calculateDailyRecord(input({ events: day('09:00'), now: AFTER_WINDOW, rules: rules({ missingPunchBehavior: 'TREAT_AS_HALF_DAY' }) }));
    expect(half.status).toBe('HALF_DAY');
    expect(half.flags).toContain('MISSING_OUT');
  });

  it('handles a lone directed OUT as MISSING_IN with early departure measured', () => {
    const r = calculateDailyRecord(input({ events: [punch(DATE, '16:00', 'PUNCH_OUT')], rules: rules({ punchInterpretation: 'DIRECTIONAL' }) }));
    expect(r.status).toBe('PRESENT');
    expect(r.flags).toEqual(['EARLY_DEPARTURE', 'MISSING_IN']);
    expect(r.earlyDepartureMinutes).toBe(60);
    const assumed = calculateDailyRecord(input({ events: [punch(DATE, '16:00', 'PUNCH_OUT')], rules: rules({ punchInterpretation: 'DIRECTIONAL', missingPunchBehavior: 'ASSUME_SHIFT_END' }) }));
    expect(assumed).toMatchObject({ workedMinutes: 420, lateMinutes: 0, firstInAt: null });
  });

  it('falls back to FLAG_ONLY for ASSUME_SHIFT_END without a shift', () => {
    const r = calculateDailyRecord(input({ shift: null, events: day('09:00'), rules: rules({ missingPunchBehavior: 'ASSUME_SHIFT_END' }) }));
    expect(r).toMatchObject({ status: 'PRESENT', workedMinutes: 0 });
    expect(r.flags).toEqual(['MISSING_OUT', 'NO_SHIFT']);
  });
});

describe('calculateDailyRecord — holidays, weekly off, leave', () => {
  beforeEach(resetIds);
  const holiday = { id: 'hol-1', name: 'National Day', isHalfDay: false };

  it('holiday without work', () => {
    const r = calculateDailyRecord(input({ holiday }));
    expect(r).toMatchObject({ status: 'HOLIDAY', scheduledMinutes: 0, workedMinutes: 0, flags: [], overtimeMinutes: 0 });
    expect(r.trace.inputs.holiday).toBe('National Day');
  });

  it('holiday with work keeps HOLIDAY status and counts all minutes as HOLIDAY overtime', () => {
    const r = calculateDailyRecord(input({ holiday, events: day('09:00', '17:00') }));
    expect(r).toMatchObject({ status: 'HOLIDAY', workedMinutes: 480, overtimeMinutes: 480, overtimeCategory: 'HOLIDAY', lateMinutes: 0 });
    expect(r.flags).toEqual(['OVERTIME', 'WORKED_ON_HOLIDAY']);
    const noOt = calculateDailyRecord(input({ holiday, events: day('09:00', '17:00'), rules: rules({ holidayWorkCountsAsOvertime: false }) }));
    expect(noOt).toMatchObject({ status: 'HOLIDAY', workedMinutes: 480, overtimeMinutes: 0, overtimeCategory: null, flags: ['WORKED_ON_HOLIDAY'] });
    const capped = calculateDailyRecord(input({ holiday, events: day('09:00', '17:00'), rules: rules({ overtimeMaxMinutesPerDay: 300 }) }));
    expect(capped.overtimeMinutes).toBe(300);
  });

  it('weekly off with work → WEEKLY_OFF overtime category', () => {
    const events = [punch(FRIDAY, '10:00'), punch(FRIDAY, '15:00')];
    const r = calculateDailyRecord(input({ attendanceDate: FRIDAY, events }));
    expect(r).toMatchObject({ status: 'WEEKLY_OFF', workedMinutes: 300, overtimeMinutes: 300, overtimeCategory: 'WEEKLY_OFF' });
    expect(r.flags).toEqual(['OVERTIME', 'WORKED_ON_WEEKLY_OFF']);
    expect(r.trace.inputs.weeklyOff).toBe(true);
    expect(calculateDailyRecord(input({ attendanceDate: FRIDAY })).status).toBe('WEEKLY_OFF');
  });

  it('holiday takes precedence over weekly off and leave', () => {
    const r = calculateDailyRecord(input({ attendanceDate: FRIDAY, holiday, leave: { id: 'lv', leaveTypeCode: 'ANNUAL', isPaid: true, isHalfDay: false, halfDayPart: null } }));
    expect(r.status).toBe('HOLIDAY');
  });

  it('approved full-day leave → LEAVE (work is recorded but earns no overtime)', () => {
    const leave = { id: 'lv-1', leaveTypeCode: 'SICK', isPaid: true, isHalfDay: false, halfDayPart: null };
    const r = calculateDailyRecord(input({ leave }));
    expect(r).toMatchObject({ status: 'LEAVE', scheduledMinutes: 0, flags: [] });
    expect(r.trace.inputs.leave).toBe('SICK');
    const worked = calculateDailyRecord(input({ leave, events: day('09:00', '17:00') }));
    expect(worked).toMatchObject({ status: 'LEAVE', workedMinutes: 480, overtimeMinutes: 0 });
  });

  it('half-day leave with afternoon work → HALF_DAY with halved expectations', () => {
    const leave = { id: 'lv-2', leaveTypeCode: 'ANNUAL', isPaid: true, isHalfDay: true, halfDayPart: 'FIRST_HALF' as const };
    const r = calculateDailyRecord(input({ leave, events: day('13:05', '17:00') }));
    expect(r).toMatchObject({ status: 'HALF_DAY', scheduledMinutes: 240, workedMinutes: 235, lateMinutes: 0, expectedStartAt: at(DATE, '13:00'), expectedEndAt: at(DATE, '17:00') });
    expect(r.flags).toEqual(['HALF_DAY_LEAVE']);
    const late = calculateDailyRecord(input({ leave, events: day('13:20', '17:00') }));
    expect(late.lateMinutes).toBe(10);
    expect(late.flags).toEqual(['LATE', 'HALF_DAY_LEAVE']);
  });

  it('half-day leave in the afternoon with morning work, and with no punches', () => {
    const leave = { id: 'lv-3', leaveTypeCode: 'ANNUAL', isPaid: true, isHalfDay: true, halfDayPart: 'SECOND_HALF' as const };
    const morning = calculateDailyRecord(input({ leave, events: day('09:00', '13:00') }));
    expect(morning).toMatchObject({ status: 'HALF_DAY', workedMinutes: 240, earlyDepartureMinutes: 0, expectedEndAt: at(DATE, '13:00') });
    expect(morning.flags).toEqual(['HALF_DAY_LEAVE']);
    const none = calculateDailyRecord(input({ leave, now: AFTER_WINDOW }));
    expect(none).toMatchObject({ status: 'ABSENT', flags: ['HALF_DAY_LEAVE'] });
    expect(calculateDailyRecord(input({ leave, now: DURING_SHIFT })).status).toBe('PENDING');
  });

  it('half-day holiday halves expectations without the leave flag', () => {
    const r = calculateDailyRecord(input({ holiday: { id: 'hol-2', name: 'Eve', isHalfDay: true }, events: day('09:00', '13:00') }));
    expect(r).toMatchObject({ status: 'HALF_DAY', scheduledMinutes: 240, workedMinutes: 240, flags: [] });
  });
});

describe('calculateDailyRecord — employment boundaries', () => {
  beforeEach(resetIds);

  it('NOT_JOINED before the joining date, even with punches', () => {
    const r = calculateDailyRecord(input({ employment: { joiningDate: '2026-04-01', exitDate: null, status: 'active' }, events: day('09:00', '17:00') }));
    expect(r).toMatchObject({ status: 'NOT_JOINED', workedMinutes: 0, scheduledMinutes: 0, expectedStartAt: null, punchCount: 2 });
    expect(r.eventIds).toHaveLength(2);
    expect(r.flags).toEqual([]);
  });

  it('EXITED after the exit date but not on it', () => {
    expect(calculateDailyRecord(input({ employment: { joiningDate: '2025-01-01', exitDate: '2026-03-01', status: 'resigned' } })).status).toBe('EXITED');
    expect(calculateDailyRecord(input({ employment: { joiningDate: '2025-01-01', exitDate: DATE, status: 'resigned' } })).status).toBe('ABSENT');
    expect(calculateDailyRecord(input({ employment: { joiningDate: DATE, exitDate: null, status: 'active' } })).status).toBe('ABSENT');
  });
});

describe('calculateDailyRecord — flexible shifts and no shift', () => {
  beforeEach(resetIds);

  it('flexible 8h: over hours earn overtime, under hours are flagged', () => {
    const over = calculateDailyRecord(input({ shift: flexibleShift(), events: day('10:00', '19:00') }));
    expect(over).toMatchObject({ status: 'PRESENT', scheduledMinutes: 480, workedMinutes: 540, overtimeMinutes: 30, overtimeCategory: 'REGULAR', expectedStartAt: null, expectedEndAt: null, lateMinutes: 0 });
    expect(over.flags).toEqual(['OVERTIME']);
    const under = calculateDailyRecord(input({ shift: flexibleShift(), events: day('10:00', '15:00') }));
    expect(under).toMatchObject({ status: 'PRESENT', workedMinutes: 300, overtimeMinutes: 0 });
    expect(under.flags).toEqual(['UNDER_HOURS']);
  });

  it('flexible core hours drive late and early departure', () => {
    const shift = flexibleShift({ coreStart: '10:00', coreEnd: '15:00' });
    const r = calculateDailyRecord(input({ shift, events: day('10:20', '14:30') }));
    expect(r).toMatchObject({ lateMinutes: 10, earlyDepartureMinutes: 30, expectedStartAt: at(DATE, '10:00'), expectedEndAt: at(DATE, '15:00') });
    expect(r.flags).toEqual(expect.arrayContaining(['LATE', 'EARLY_DEPARTURE']));
  });

  it('flexible day boundary keeps a 02:00 OUT on the previous day', () => {
    const r = calculateDailyRecord(input({ shift: flexibleShift(), events: [punch(DATE, '18:00'), punch(D1, '02:00')] }));
    expect(r).toMatchObject({ status: 'PRESENT', workedMinutes: 480 });
    expect(r.trace.inputs.window).toEqual({ start: at(DATE, '04:00'), end: at(D1, '04:00') });
  });

  it('flexible ASSUME_SHIFT_END assumes required minutes after the IN', () => {
    const r = calculateDailyRecord(input({ shift: flexibleShift(), events: day('10:00'), rules: rules({ missingPunchBehavior: 'ASSUME_SHIFT_END' }) }));
    expect(r).toMatchObject({ status: 'PRESENT', workedMinutes: 480 });
  });

  it('no shift: NO_SHIFT flag, worked hours from the calendar day, no expectations', () => {
    const r = calculateDailyRecord(input({ shift: null, shiftAssignmentId: null, events: day('09:00', '17:00') }));
    expect(r).toMatchObject({ status: 'PRESENT', shiftId: null, workedMinutes: 480, scheduledMinutes: 0, expectedStartAt: null, expectedEndAt: null, lateMinutes: 0, overtimeMinutes: 0 });
    expect(r.flags).toEqual(['NO_SHIFT']);
    expect(r.trace.inputs.shiftType).toBeNull();
    expect(calculateDailyRecord(input({ shift: null, now: at(DATE, '12:00') })).status).toBe('PENDING');
  });
});

describe('calculateDailyRecord — Ramadan and timezones', () => {
  beforeEach(resetIds);
  const ramadan = rules({ ramadanMode: { enabled: true, from: '2026-02-18', to: '2026-03-19', scheduledMinutes: 360, appliesTo: 'all' } });

  it('reduces scheduled minutes and shifts the expected end', () => {
    const r = calculateDailyRecord(input({ rules: ramadan, events: day('09:00', '15:00') }));
    expect(r).toMatchObject({ status: 'PRESENT', scheduledMinutes: 360, workedMinutes: 360, earlyDepartureMinutes: 0, expectedEndAt: at(DATE, '15:00') });
    expect(r.flags).toEqual(['RAMADAN_HOURS']);
    const stayed = calculateDailyRecord(input({ rules: ramadan, events: day('09:00', '16:30') }));
    expect(stayed.overtimeMinutes).toBe(60); // 90 after end − 30 threshold = 60
  });

  it('applies only within the configured dates and to eligible employees', () => {
    expect(calculateDailyRecord(input({ rules: ramadan, attendanceDate: '2026-03-20', events: [punch('2026-03-20', '09:00'), punch('2026-03-20', '17:00')] })).flags).not.toContain('RAMADAN_HOURS');
    const flagged = rules({ ramadanMode: { ...ramadan.ramadanMode, appliesTo: 'flagged_employees' } });
    expect(calculateDailyRecord(input({ rules: flagged, events: day('09:00', '15:00') })).flags).not.toContain('RAMADAN_HOURS');
    expect(calculateDailyRecord(input({ rules: flagged, ramadanEligible: true, events: day('09:00', '15:00') })).flags).toContain('RAMADAN_HOURS');
  });

  it('applies Ramadan hours to flexible shifts too', () => {
    const r = calculateDailyRecord(input({ rules: ramadan, shift: flexibleShift(), events: day('10:00', '16:00') }));
    expect(r).toMatchObject({ scheduledMinutes: 360, workedMinutes: 360, overtimeMinutes: 0 });
    expect(r.flags).toEqual(['RAMADAN_HOURS']);
  });

  it('produces the same local result in Asia/Muscat and Asia/Riyadh with different UTC instants', () => {
    const muscat = calculateDailyRecord(input({ events: day('08:55', '17:05') }));
    resetIds();
    const riyadh = calculateDailyRecord(input({ timezone: RIYADH, events: [punch(DATE, '08:55', 'PUNCH', RIYADH), punch(DATE, '17:05', 'PUNCH', RIYADH)] }));
    expect(muscat.expectedStartAt).toBe('2026-03-10T05:00:00Z');
    expect(riyadh.expectedStartAt).toBe('2026-03-10T06:00:00Z');
    expect(riyadh).toMatchObject({ status: 'PRESENT', workedMinutes: 490, lateMinutes: 0, timezone: RIYADH });
    expect(riyadh.trace.inputs.window).toEqual({ start: '2026-03-10T02:00:00Z', end: '2026-03-10T20:00:00Z' });
  });

  it('rejects an invalid timezone', () => {
    expect(() => calculateDailyRecord(input({ timezone: 'Nowhere/City' }))).toThrowError(AppError);
  });
});

describe('calculateDailyRecord — adversarial review', () => {
  beforeEach(resetIds);
  const holiday = { id: 'hol-1', name: 'National Day', isHalfDay: false };
  const halfLeave = { id: 'lv-h', leaveTypeCode: 'ANNUAL', isPaid: true, isHalfDay: true, halfDayPart: 'FIRST_HALF' as const };

  it('never awards regular overtime for merely completing the hours after a late arrival (§G.5: worked beyond scheduled)', () => {
    const r = calculateDailyRecord(input({ events: day('11:00', '19:00') }));
    expect(r).toMatchObject({ workedMinutes: 480, lateMinutes: 110, overtimeMinutes: 0, overtimeCategory: null });
    expect(r.flags).not.toContain('OVERTIME');
    expect(r.trace.steps.find((s) => s.step === 'overtime')?.values).toMatchObject({ afterEndMinutes: 120, beyondScheduledMinutes: 0, rawOvertimeMinutes: 0 });
  });

  it('caps overtime by the minutes actually worked when the whole span lies after the shift end', () => {
    const r = calculateDailyRecord(input({ events: day('18:00', '20:00'), rules: rules({ overtimeStartAfterMinutes: 0, overtimeMinBlockMinutes: 0, overtimeRoundingMinutes: 0 }) }));
    expect(r.workedMinutes).toBe(120);
    expect(r.overtimeMinutes).toBeLessThanOrEqual(120);
    expect(r.overtimeMinutes).toBe(0); // worked (120) does not exceed the 480 scheduled minutes
  });

  it('does not leave a stale OVERTIME flag or a regular-overtime step on a holiday whose work earns no overtime', () => {
    const r = calculateDailyRecord(input({ holiday, events: day('09:00', '18:50'), rules: rules({ holidayWorkCountsAsOvertime: false }) }));
    expect(r).toMatchObject({ status: 'HOLIDAY', overtimeMinutes: 0, overtimeCategory: null, flags: ['WORKED_ON_HOLIDAY'] });
    expect(r.trace.steps.filter((s) => s.step === 'overtime')).toHaveLength(1);
  });

  it('does not flag OVERTIME on a leave day with long hours', () => {
    const leave = { id: 'lv-1', leaveTypeCode: 'SICK', isPaid: true, isHalfDay: false, halfDayPart: null };
    const r = calculateDailyRecord(input({ leave, events: day('09:00', '19:00') }));
    expect(r).toMatchObject({ status: 'LEAVE', workedMinutes: 600, overtimeMinutes: 0, flags: [] });
  });

  it('records that scheduled minutes are zeroed on a non-working day', () => {
    const r = calculateDailyRecord(input({ holiday, events: day('09:00', '17:00') }));
    expect(r.scheduledMinutes).toBe(0);
    expect(stepNames(r)).toContain('schedule.nonWorking');
  });

  it('does not flag MISSING_OUT on a holiday while the punch window is still open', () => {
    const open = calculateDailyRecord(input({ holiday, events: day('10:00'), now: DURING_SHIFT }));
    expect(open.status).toBe('HOLIDAY');
    expect(open.flags).not.toContain('MISSING_OUT');
    const closed = calculateDailyRecord(input({ holiday, events: day('10:00'), now: AFTER_WINDOW }));
    expect(closed.flags).toContain('MISSING_OUT');
  });

  it('keeps an open PAIRED segment PENDING while the window is open instead of judging early departure', () => {
    const paired = rules({ punchInterpretation: 'PAIRED' });
    const r = calculateDailyRecord(input({ events: day('09:00', '13:00', '14:00'), rules: paired, now: at(DATE, '15:00') }));
    expect(r.status).toBe('PENDING');
    expect(r.flags).not.toContain('EARLY_DEPARTURE');
    expect(r.flags).not.toContain('MISSING_OUT');
    expect(r.lastOutAt).toBeNull();
    expect(r.firstInAt).toBe(at(DATE, '09:00'));
  });

  it('DIRECTIONAL orphan OUT followed by an open IN is a missing OUT, not a negative span with early departure', () => {
    const events = [punch(DATE, '08:00', 'PUNCH_OUT'), punch(DATE, '09:00', 'PUNCH_IN')];
    const r = calculateDailyRecord(input({ events, rules: rules({ punchInterpretation: 'DIRECTIONAL' }), now: AFTER_WINDOW }));
    expect(r).toMatchObject({ status: 'PRESENT', workedMinutes: 0, earlyDepartureMinutes: 0, lastOutAt: null, firstInAt: at(DATE, '09:00') });
    expect(r.flags).toEqual(['MISSING_IN', 'MISSING_OUT']);
  });

  it('flags MISSING_IN when a DIRECTIONAL day has an orphan OUT before a complete segment', () => {
    const events = [punch(DATE, '08:00', 'PUNCH_OUT'), punch(DATE, '09:00', 'PUNCH_IN'), punch(DATE, '17:00', 'PUNCH_OUT')];
    const r = calculateDailyRecord(input({ events, rules: rules({ punchInterpretation: 'DIRECTIONAL' }) }));
    expect(r).toMatchObject({ status: 'PRESENT', workedMinutes: 480 });
    expect(r.flags).toContain('MISSING_IN');
  });

  it('half-day leave stays HALF_DAY when the OUT is missing (FLAG_ONLY / ASSUME_SHIFT_END) so payroll counts the leave half', () => {
    const flagOnly = calculateDailyRecord(input({ leave: halfLeave, events: day('13:00'), now: AFTER_WINDOW }));
    expect(flagOnly.status).toBe('HALF_DAY');
    expect(flagOnly.flags).toEqual(['MISSING_OUT', 'HALF_DAY_LEAVE']);
    const assumed = calculateDailyRecord(input({ leave: halfLeave, events: day('13:00'), now: AFTER_WINDOW, rules: rules({ missingPunchBehavior: 'ASSUME_SHIFT_END' }) }));
    expect(assumed).toMatchObject({ status: 'HALF_DAY', workedMinutes: 240, scheduledMinutes: 240 });
  });

  it('half-day leave without a shift still yields HALF_DAY', () => {
    const r = calculateDailyRecord(input({ shift: null, shiftAssignmentId: null, leave: halfLeave, events: day('13:00', '17:00') }));
    expect(r.status).toBe('HALF_DAY');
    expect(r.flags).toEqual(['HALF_DAY_LEAVE', 'NO_SHIFT']);
  });

  it('ASSUME_SHIFT_END classifies the assumed day like a real one (short assumed span → HALF_DAY, UNDER_HOURS)', () => {
    const r = calculateDailyRecord(input({ events: day('15:00'), now: AFTER_WINDOW, rules: rules({ missingPunchBehavior: 'ASSUME_SHIFT_END' }) }));
    expect(r).toMatchObject({ status: 'HALF_DAY', workedMinutes: 120 });
    expect(r.flags).toEqual(expect.arrayContaining(['MISSING_OUT', 'UNDER_HOURS']));
  });

  it('keeps the attribution decision in the trace when overlapping windows were resolved by nearest scheduled start', () => {
    const shift = nightShift({ punchInWindowBeforeMinutes: 720, punchOutWindowAfterMinutes: 720 });
    // 10:00 D+1 lies in the D window (10:00 D → 18:00 D+1) and the D+1 window (10:00 D+1 → 18:00 D+2):
    // 12 h from both scheduled starts → exact tie → earlier date D, recorded on the punch.
    const r = calculateDailyRecord(input({ shift, events: [punch(DATE, '22:00'), punch(D1, '10:00')] }));
    const outPunch = r.trace.punches.find((p) => p.punchedAt === at(D1, '10:00'));
    expect(outPunch?.role).toBe('OUT');
    expect(outPunch?.note).toBe('last punch in window; overlapping windows 2026-03-10/2026-03-11 → nearest scheduled start (720 min)');
    expect(r.trace.punches.find((p) => p.punchedAt === at(DATE, '22:00'))?.note).toBe('first punch in window');
    expect(r.workedMinutes).toBe(720);
  });

  it('accepts an OUT exactly at the end of a FIXED window with no punch-out margin (closed interval per §G.3)', () => {
    const shift = fixedShift({ startTime: '16:00', endTime: '00:00', punchOutWindowAfterMinutes: 0 });
    const r = calculateDailyRecord(input({ shift, events: [punch(DATE, '16:00'), punch(D1, '00:00')] }));
    expect(r).toMatchObject({ status: 'PRESENT', workedMinutes: 480, punchCount: 2 });
    expect(r.flags).toEqual(['CROSS_MIDNIGHT']);
  });
});
