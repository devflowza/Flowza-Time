import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY_SECTIONS, type AttendancePolicySections, type AttendanceRules } from '@flowza/contracts';
import { calculateDailyRecord } from './calculate.js';
import { awayIntervalsOf, breakAllowanceMinutes, classifyTimeAway, timeAwayActive, timeAwayInactiveReason, type EngineTimeAway } from './time-away.js';
import { parseInstant } from './window.js';
import { DATE, MUSCAT, at, fixedShift, flexibleShift, input, punch, resetIds, rules } from './testing.js';

/** The policy of the brief: an 08:00–14:00 office day, time away measured on a two-way or entry-only terminal. */
const SHIFT = fixedShift({ id: 'shift-office', code: 'OFF', name: 'Office 08:00–14:00', startTime: '08:00', endTime: '14:00' });
const AFTER_WINDOW = at(DATE, '23:30');

function awayRules(timeAway: Partial<AttendancePolicySections['timeAway']> = {}, overrides: Partial<AttendanceRules> = {}): AttendanceRules {
  return rules({
    punchInterpretation: 'DIRECTIONAL',
    minFullDayMinutes: 330,
    halfDayThresholdMinutes: 180,
    policy: { ...DEFAULT_POLICY_SECTIONS, timeAway: { ...DEFAULT_POLICY_SECTIONS.timeAway, enabled: true, ...timeAway } },
    ...overrides,
  });
}
const window = (id: string, kind: EngineTimeAway['kind'], from: string, to: string): EngineTimeAway => ({ id, kind, startsAt: at(DATE, from), endsAt: at(DATE, to) });
const awayStep = (r: ReturnType<typeof calculateDailyRecord>) => r.trace.steps.find((s) => s.step === 'timeAway');

describe('time away — classification (pure)', () => {
  const t = (time: string) => parseInstant(at(DATE, time), MUSCAT);
  const policy = { ...DEFAULT_POLICY_SECTIONS.timeAway, enabled: true };

  it('is measured only with the policy on and a punch interpretation that keeps the punches in between', () => {
    expect(timeAwayActive(policy, 'DIRECTIONAL')).toBe(true);
    expect(timeAwayActive(policy, 'PAIRED')).toBe(true);
    expect(timeAwayInactiveReason(policy, 'FIRST_LAST')).toBe('FIRST_LAST_INTERPRETATION');
    expect(timeAwayInactiveReason(DEFAULT_POLICY_SECTIONS.timeAway, 'DIRECTIONAL')).toBe('DISABLED');
  });

  it('counts every break of the shift, paid or not, fixed or scheduled, as the break allowance', () => {
    expect(breakAllowanceMinutes([{ minutes: 30, paid: false }, { start: '12:00', end: '12:45', paid: true }])).toBe(75);
    expect(breakAllowanceMinutes([{ start: '23:30', end: '00:15', paid: false }])).toBe(45);
    expect(breakAllowanceMinutes([])).toBe(0);
  });

  it('finds the gaps between closed segments and the explicit break spans, in time order', () => {
    const spans = awayIntervalsOf({
      segments: [{ start: t('08:00'), end: t('10:00') }, { start: t('12:00'), end: t('14:00') }, { start: t('15:00'), end: null }],
      breakSpans: [{ start: t('13:00'), end: t('13:20') }],
    });
    expect(spans.map((s) => [s.start.toFormat('HH:mm'), s.end.toFormat('HH:mm')])).toEqual([['10:00', '12:00'], ['13:00', '13:20']]);
  });

  it('splits one gap by the approved windows (+ return grace); the rest takes the break allowance first, then is unapproved', () => {
    const c = classifyTimeAway({
      intervals: [{ start: t('10:00'), end: t('12:40') }],
      windows: [window('req-1', 'OFFICIAL', '10:00', '12:00')],
      zone: MUSCAT,
      policy: { ...policy, returnGraceMinutes: 10 },
      breakAllowanceMinutes: 15,
    });
    expect(c.intervals.map((i) => [i.kind, i.start.toFormat('HH:mm'), i.end.toFormat('HH:mm'), i.minutes, i.requestId])).toEqual([
      ['OFFICIAL', '10:00', '12:10', 130, 'req-1'],
      ['BREAK', '12:10', '12:25', 15, null],
      ['UNAPPROVED', '12:25', '12:40', 15, null],
    ]);
    expect(c).toMatchObject({ awayMinutes: 160, officialMinutes: 130, breakMinutes: 15, unapprovedMinutes: 15, permissionMinutes: 0, shortMinutes: 0 });
  });

  it('keeps a gap under the tolerance as a SHORT gap and never charges it to the allowance', () => {
    const c = classifyTimeAway({ intervals: [{ start: t('09:00'), end: t('09:03') }], windows: [], zone: MUSCAT, policy: { ...policy, ignoreUnderMinutes: 5 }, breakAllowanceMinutes: 30 });
    expect(c).toMatchObject({ shortMinutes: 3, breakMinutes: 0, unapprovedMinutes: 0, awayMinutes: 3 });
  });

  it('spends the break allowance in time order across the day', () => {
    const c = classifyTimeAway({ intervals: [{ start: t('10:00'), end: t('10:20') }, { start: t('12:00'), end: t('12:30') }], windows: [], zone: MUSCAT, policy, breakAllowanceMinutes: 30 });
    expect(c.intervals.map((i) => [i.kind, i.minutes])).toEqual([['BREAK', 20], ['BREAK', 10], ['UNAPPROVED', 20]]);
  });
});

describe('time away — 08:00–14:00 office day (calculateDailyRecord)', () => {
  beforeEach(resetIds);

  it('two-way terminal: OUT 10:00 → IN 12:00 with no approval is two hours unapproved, deducted and flagged', () => {
    const r = calculateDailyRecord(input({ shift: SHIFT, rules: awayRules(), now: AFTER_WINDOW, events: [punch(DATE, '08:00', 'PUNCH_IN'), punch(DATE, '10:00', 'PUNCH_OUT'), punch(DATE, '12:00', 'PUNCH_IN'), punch(DATE, '14:00', 'PUNCH_OUT')] }));
    expect(r).toMatchObject({ firstInAt: at(DATE, '08:00'), lastOutAt: at(DATE, '14:00'), workedMinutes: 240, breakMinutes: 0, awayMinutes: 120, officialDutyMinutes: 0, permissionMinutes: 0, unapprovedAwayMinutes: 120 });
    expect(r.flags).toEqual(expect.arrayContaining(['TIME_AWAY', 'UNAPPROVED_AWAY', 'UNDER_HOURS']));
    expect(awayStep(r)?.values?.['intervals']).toEqual([{ kind: 'UNAPPROVED', startAt: at(DATE, '10:00'), endAt: at(DATE, '12:00'), minutes: 120, requestId: null }]);
  });

  it('approved official duty 10:00–12:00 counts as worked: a full day, no UNAPPROVED_AWAY', () => {
    const r = calculateDailyRecord(input({
      shift: SHIFT, rules: awayRules(), now: AFTER_WINDOW, timeAway: [window('req-official', 'OFFICIAL', '10:00', '12:00')],
      events: [punch(DATE, '08:00', 'PUNCH_IN'), punch(DATE, '10:00', 'PUNCH_OUT'), punch(DATE, '12:05', 'PUNCH_IN'), punch(DATE, '14:00', 'PUNCH_OUT')],
    }));
    expect(r).toMatchObject({ status: 'PRESENT', workedMinutes: 360, awayMinutes: 125, officialDutyMinutes: 125, unapprovedAwayMinutes: 0 });
    expect(r.flags).toContain('TIME_AWAY');
    expect(r.flags).not.toContain('UNAPPROVED_AWAY');
    expect(r.flags).not.toContain('UNDER_HOURS');
  });

  it('official duty is excused but not paid when the policy says so', () => {
    const r = calculateDailyRecord(input({
      shift: SHIFT, rules: awayRules({ officialCountsAsWorked: false }), now: AFTER_WINDOW, timeAway: [window('req-official', 'OFFICIAL', '10:00', '12:00')],
      events: [punch(DATE, '08:00', 'PUNCH_IN'), punch(DATE, '10:00', 'PUNCH_OUT'), punch(DATE, '12:00', 'PUNCH_IN'), punch(DATE, '14:00', 'PUNCH_OUT')],
    }));
    expect(r).toMatchObject({ status: 'PRESENT', workedMinutes: 240, officialDutyMinutes: 120 });
    expect(r.flags).not.toContain('UNDER_HOURS');
  });

  it('approved personal permission is unpaid but excused: the day is not short', () => {
    const r = calculateDailyRecord(input({
      shift: SHIFT, rules: awayRules(), now: AFTER_WINDOW, timeAway: [window('req-personal', 'PERSONAL', '10:00', '12:00')],
      events: [punch(DATE, '08:00', 'PUNCH_IN'), punch(DATE, '10:00', 'PUNCH_OUT'), punch(DATE, '12:00', 'PUNCH_IN'), punch(DATE, '14:00', 'PUNCH_OUT')],
    }));
    expect(r).toMatchObject({ status: 'PRESENT', workedMinutes: 240, permissionMinutes: 120, unapprovedAwayMinutes: 0 });
    expect(r.flags).not.toContain('UNDER_HOURS');
    expect(r.trace.steps.find((s) => s.step === 'timeAway.status')?.values).toMatchObject({ workedMinutes: 240, excusedMinutes: 120 });
  });

  it('entry-only terminal: portal step-out (break-out) and the terminal check-in on return measure the time away', () => {
    const r = calculateDailyRecord(input({
      shift: SHIFT, rules: awayRules(), now: AFTER_WINDOW, timeAway: [window('req-step', 'OFFICIAL', '10:00', '11:30')],
      events: [
        punch(DATE, '08:00', 'PUNCH_IN', MUSCAT, { deviceId: 'entry-terminal' }),
        punch(DATE, '10:00', 'BREAK_START', MUSCAT, { source: 'MOBILE', deviceId: 'self-service', payload: { channel: 'web' } }),
        punch(DATE, '11:35', 'PUNCH_IN', MUSCAT, { deviceId: 'entry-terminal' }),
        punch(DATE, '14:00', 'PUNCH_OUT', MUSCAT, { source: 'MOBILE', deviceId: 'self-service', payload: { channel: 'web' } }),
      ],
    }));
    // the return at 11:35 is inside the window's 10-minute grace: all 95 minutes are official duty
    expect(r).toMatchObject({ workedMinutes: 360, awayMinutes: 95, officialDutyMinutes: 95, unapprovedAwayMinutes: 0, status: 'PRESENT' });
  });

  it('a lunch inside the break allowance stays a break, the rest of a long absence is unapproved', () => {
    const shift = { ...SHIFT, breaks: [{ minutes: 30, paid: false }] };
    const r = calculateDailyRecord(input({ shift, rules: awayRules(), now: AFTER_WINDOW, events: [punch(DATE, '08:00', 'PUNCH_IN'), punch(DATE, '11:00', 'PUNCH_OUT'), punch(DATE, '12:15', 'PUNCH_IN'), punch(DATE, '14:00', 'PUNCH_OUT')] }));
    expect(r).toMatchObject({ breakMinutes: 30, awayMinutes: 75, unapprovedAwayMinutes: 45, workedMinutes: 285 });
    expect(r.flags).toContain('UNAPPROVED_AWAY');
  });

  it('a short gap under the tolerance is neither deducted nor flagged', () => {
    const r = calculateDailyRecord(input({ shift: SHIFT, rules: awayRules(), now: AFTER_WINDOW, events: [punch(DATE, '08:00', 'PUNCH_IN'), punch(DATE, '09:30', 'PUNCH_OUT'), punch(DATE, '09:33', 'PUNCH_IN'), punch(DATE, '14:00', 'PUNCH_OUT')] }));
    expect(r).toMatchObject({ workedMinutes: 360, awayMinutes: 3, unapprovedAwayMinutes: 0, breakMinutes: 0 });
    expect(r.flags).not.toContain('TIME_AWAY');
  });

  it('unapproved time under the flag threshold is deducted but not flagged', () => {
    const r = calculateDailyRecord(input({ shift: SHIFT, rules: awayRules({ flagUnapprovedAfterMinutes: 15 }), now: AFTER_WINDOW, events: [punch(DATE, '08:00', 'PUNCH_IN'), punch(DATE, '09:30', 'PUNCH_OUT'), punch(DATE, '09:40', 'PUNCH_IN'), punch(DATE, '14:00', 'PUNCH_OUT')] }));
    expect(r).toMatchObject({ workedMinutes: 350, unapprovedAwayMinutes: 10 });
    expect(r.flags).toContain('TIME_AWAY');
    expect(r.flags).not.toContain('UNAPPROVED_AWAY');
  });

  it('a pending day (still at work) already reports the away time of the closed intervals', () => {
    const r = calculateDailyRecord(input({ shift: SHIFT, rules: awayRules(), now: at(DATE, '12:30'), events: [punch(DATE, '08:00', 'PUNCH_IN'), punch(DATE, '10:00', 'PUNCH_OUT'), punch(DATE, '12:00', 'PUNCH_IN')] }));
    expect(r).toMatchObject({ status: 'PENDING', workedMinutes: 0, awayMinutes: 120, unapprovedAwayMinutes: 120 });
  });

  it('FIRST_LAST keeps only the first and the last punch: nothing is measured and the trace says why', () => {
    const r = calculateDailyRecord(input({ shift: SHIFT, rules: awayRules({}, { punchInterpretation: 'FIRST_LAST' }), now: AFTER_WINDOW, events: [punch(DATE, '08:00'), punch(DATE, '10:00'), punch(DATE, '12:00'), punch(DATE, '14:00')] }));
    expect(r).toMatchObject({ workedMinutes: 360, awayMinutes: 0, unapprovedAwayMinutes: 0 });
    expect(awayStep(r)?.values).toEqual({ inactive: 'FIRST_LAST_INTERPRETATION' });
  });

  it('with the policy off nothing changes: the gap is a measured break as before and the away figures stay 0', () => {
    const r = calculateDailyRecord(input({ shift: SHIFT, rules: rules({ punchInterpretation: 'DIRECTIONAL' }), now: AFTER_WINDOW, events: [punch(DATE, '08:00', 'PUNCH_IN'), punch(DATE, '10:00', 'PUNCH_OUT'), punch(DATE, '12:00', 'PUNCH_IN'), punch(DATE, '14:00', 'PUNCH_OUT')] }));
    expect(r).toMatchObject({ workedMinutes: 240, breakMinutes: 120, awayMinutes: 0, officialDutyMinutes: 0, permissionMinutes: 0, unapprovedAwayMinutes: 0 });
    expect(awayStep(r)).toBeUndefined();
    expect(r.flags).not.toContain('TIME_AWAY');
  });

  it('is deterministic: the same inputs give the same record', () => {
    const make = () => { resetIds(); return calculateDailyRecord(input({ shift: SHIFT, rules: awayRules(), now: AFTER_WINDOW, timeAway: [window('w', 'PERSONAL', '10:00', '11:00')], events: [punch(DATE, '08:00', 'PUNCH_IN'), punch(DATE, '10:00', 'PUNCH_OUT'), punch(DATE, '11:30', 'PUNCH_IN'), punch(DATE, '14:00', 'PUNCH_OUT')] })); };
    expect(JSON.stringify(make())).toBe(JSON.stringify(make()));
  });
});

describe('time away — a non-working day still in progress (review C1)', () => {
  beforeEach(resetIds);
  const FRIDAY = '2026-03-13'; // a weekly off of the fixtures (weeklyOffDays [5, 6])

  it('weekly off, PAIRED, back on site and not checked out yet: the open tail is neither deducted nor reported', () => {
    const r = calculateDailyRecord(input({ attendanceDate: FRIDAY, shift: SHIFT, rules: awayRules({}, { punchInterpretation: 'PAIRED' }), now: at(FRIDAY, '12:30'), events: [punch(FRIDAY, '08:00'), punch(FRIDAY, '10:00'), punch(FRIDAY, '12:00')] }));
    expect(r).toMatchObject({ status: 'WEEKLY_OFF', workedMinutes: 120, lastOutAt: at(FRIDAY, '10:00'), awayMinutes: 0, unapprovedAwayMinutes: 0 });
    expect(r.flags).not.toContain('TIME_AWAY');
    expect(r.flags).not.toContain('UNAPPROVED_AWAY');
    expect(awayStep(r)?.values?.['intervals']).toEqual([]);
  });

  it('holiday, DIRECTIONAL, IN 08:00 / OUT 12:00 / IN 13:00 at 13:30: 240 worked, as with the policy off', () => {
    const holiday = { id: 'hol-1', name: 'National Day', isHalfDay: false };
    const events = () => [punch(DATE, '08:00', 'PUNCH_IN'), punch(DATE, '12:00', 'PUNCH_OUT'), punch(DATE, '13:00', 'PUNCH_IN')];
    const on = calculateDailyRecord(input({ holiday, shift: SHIFT, rules: awayRules(), now: at(DATE, '13:30'), events: events() }));
    const off = calculateDailyRecord(input({ holiday, shift: SHIFT, rules: rules({ punchInterpretation: 'DIRECTIONAL' }), now: at(DATE, '13:30'), events: events() }));
    expect(off).toMatchObject({ status: 'HOLIDAY', workedMinutes: 240 });
    expect(on).toMatchObject({ status: 'HOLIDAY', workedMinutes: 240, awayMinutes: 0, unapprovedAwayMinutes: 0 });
    expect(on.flags).not.toContain('UNAPPROVED_AWAY');
  });

  it('a working day in the same state stays PENDING and still reports the open tail (unchanged)', () => {
    const r = calculateDailyRecord(input({ shift: SHIFT, rules: awayRules({}, { punchInterpretation: 'PAIRED' }), now: at(DATE, '12:30'), events: [punch(DATE, '08:00'), punch(DATE, '10:00'), punch(DATE, '12:00')] }));
    expect(r).toMatchObject({ status: 'PENDING', workedMinutes: 0, awayMinutes: 120, unapprovedAwayMinutes: 120 });
    expect(r.flags).toContain('UNAPPROVED_AWAY');
  });
});

describe('time away — the shift\'s unpaid break stays a floor (review C2)', () => {
  beforeEach(resetIds);
  const LUNCH = fixedShift({ id: 'shift-lunch', code: 'LUN', name: 'Office 08:00–17:00', startTime: '08:00', endTime: '17:00', breaks: [{ minutes: 60, paid: false }] });
  const officialDay = () => [punch(DATE, '08:00', 'PUNCH_IN'), punch(DATE, '10:00', 'PUNCH_OUT'), punch(DATE, '12:00', 'PUNCH_IN'), punch(DATE, '17:00', 'PUNCH_OUT')];
  const plainDay = () => [punch(DATE, '08:00', 'PUNCH_IN'), punch(DATE, '17:00', 'PUNCH_OUT')];
  const official = [window('req-official', 'OFFICIAL', '10:00', '12:00')];

  it('FIXED with a 60-min unpaid lunch: an approved official 10:00–12:00 earns what a plain day earns', () => {
    const plain = calculateDailyRecord(input({ shift: LUNCH, rules: awayRules(), now: AFTER_WINDOW, events: plainDay() }));
    const r = calculateDailyRecord(input({ shift: LUNCH, rules: awayRules(), now: AFTER_WINDOW, timeAway: official, events: officialDay() }));
    expect(plain).toMatchObject({ workedMinutes: 480, breakMinutes: 60 });
    expect(r).toMatchObject({ status: 'PRESENT', workedMinutes: 480, breakMinutes: 60, officialDutyMinutes: 120, overtimeMinutes: 0 });
    expect(r.trace.steps.find((s) => s.step === 'breaks')?.values).toMatchObject({ source: 'TIME_AWAY', unpaidMinutes: 60, measuredUnpaidMinutes: 0, floorMinutes: 60 });
  });

  it('FLEXIBLE 480 required + 60 unpaid: neither an official window nor a short gap turns the lunch into overtime', () => {
    const flex = flexibleShift({ breaks: [{ minutes: 60, paid: false }] });
    const plain = calculateDailyRecord(input({ shift: flex, rules: awayRules(), events: plainDay() }));
    const off = calculateDailyRecord(input({ shift: flex, rules: awayRules(), timeAway: official, events: officialDay() }));
    const short = calculateDailyRecord(input({ shift: flex, rules: awayRules(), events: [punch(DATE, '08:00', 'PUNCH_IN'), punch(DATE, '09:30', 'PUNCH_OUT'), punch(DATE, '09:32', 'PUNCH_IN'), punch(DATE, '17:00', 'PUNCH_OUT')] }));
    expect(plain).toMatchObject({ workedMinutes: 480, overtimeMinutes: 0 });
    expect(off).toMatchObject({ workedMinutes: 480, overtimeMinutes: 0, officialDutyMinutes: 120 });
    expect(short).toMatchObject({ workedMinutes: 480, overtimeMinutes: 0, awayMinutes: 2 });
  });

  it('an approved 1 h personal permission costs its hour on top of the lunch (excused for the status)', () => {
    const r = calculateDailyRecord(input({
      shift: LUNCH, rules: awayRules(), now: AFTER_WINDOW, timeAway: [window('req-personal', 'PERSONAL', '15:00', '16:00')],
      events: [punch(DATE, '08:00', 'PUNCH_IN'), punch(DATE, '15:00', 'PUNCH_OUT'), punch(DATE, '16:00', 'PUNCH_IN'), punch(DATE, '17:00', 'PUNCH_OUT')],
    }));
    expect(r).toMatchObject({ status: 'PRESENT', workedMinutes: 420, breakMinutes: 60, permissionMinutes: 60 });
    expect(r.trace.steps.find((s) => s.step === 'timeAway.status')?.values).toMatchObject({ workedMinutes: 420, excusedMinutes: 60 });
  });

  it('a punched lunch shorter than the shift\'s break still deducts the shift\'s break once, never twice', () => {
    const r = calculateDailyRecord(input({ shift: LUNCH, rules: awayRules(), now: AFTER_WINDOW, events: [punch(DATE, '08:00', 'PUNCH_IN'), punch(DATE, '12:00', 'PUNCH_OUT'), punch(DATE, '12:30', 'PUNCH_IN'), punch(DATE, '17:00', 'PUNCH_OUT')] }));
    expect(r).toMatchObject({ workedMinutes: 480, breakMinutes: 60, awayMinutes: 30, unapprovedAwayMinutes: 0 });
  });

  it('a scheduled lunch range already inside deducted time away is not deducted again', () => {
    const range = { ...LUNCH, breaks: [{ start: '12:00', end: '13:00', paid: false }] };
    const away = () => [punch(DATE, '08:00', 'PUNCH_IN'), punch(DATE, '11:00', 'PUNCH_OUT'), punch(DATE, '14:00', 'PUNCH_IN'), punch(DATE, '17:00', 'PUNCH_OUT')];
    // 11:00–14:00 on approved permission: 08–11 + 14–17 worked, the lunch hour lies inside the permission
    const permission = calculateDailyRecord(input({ shift: range, rules: awayRules(), now: AFTER_WINDOW, timeAway: [window('req-personal', 'PERSONAL', '11:00', '14:00')], events: away() }));
    expect(permission).toMatchObject({ workedMinutes: 360, breakMinutes: 0, permissionMinutes: 180 });
    // unapproved: the first hour is the break allowance, the lunch range lies inside the unapproved rest
    const unapproved = calculateDailyRecord(input({ shift: range, rules: awayRules(), now: AFTER_WINDOW, events: away() }));
    expect(unapproved).toMatchObject({ workedMinutes: 360, breakMinutes: 60, unapprovedAwayMinutes: 120 });
    // official duty around the lunch range counts as worked: the lunch is deducted like on a plain day
    const offDuty = calculateDailyRecord(input({ shift: range, rules: awayRules(), now: AFTER_WINDOW, timeAway: official, events: officialDay() }));
    expect(offDuty).toMatchObject({ workedMinutes: 480, breakMinutes: 60, officialDutyMinutes: 120 });
  });
});

describe('time away — a step-out never closed under ASSUME_SHIFT_END (review D1)', () => {
  beforeEach(resetIds);
  const assumeEnd = (timeAway: Partial<AttendancePolicySections['timeAway']> = {}) => awayRules(timeAway, { missingPunchBehavior: 'ASSUME_SHIFT_END' });
  const stepOut = (time: string) => punch(DATE, time, 'BREAK_START', MUSCAT, { source: 'MOBILE', deviceId: 'self-service', payload: { channel: 'web' } });
  const neverBack = () => [punch(DATE, '08:00', 'PUNCH_IN', MUSCAT, { deviceId: 'entry-terminal' }), stepOut('12:00')];

  it('the time from the step-out to the assumed check-out is unapproved time away, not worked time', () => {
    const r = calculateDailyRecord(input({ shift: SHIFT, rules: assumeEnd(), now: AFTER_WINDOW, events: neverBack() }));
    expect(r).toMatchObject({ status: 'PRESENT', firstInAt: at(DATE, '08:00'), lastOutAt: null, workedMinutes: 240, awayMinutes: 120, unapprovedAwayMinutes: 120 });
    expect(r.flags).toEqual(expect.arrayContaining(['MISSING_OUT', 'TIME_AWAY', 'UNAPPROVED_AWAY', 'UNDER_HOURS']));
    // the one `timeAway` step the API reads back carries the interval
    expect(r.trace.steps.filter((s) => s.step === 'timeAway')).toHaveLength(1);
    expect(awayStep(r)?.values?.['intervals']).toEqual([{ kind: 'UNAPPROVED', startAt: at(DATE, '12:00'), endAt: at(DATE, '14:00'), minutes: 120, requestId: null }]);
    expect(r.trace.steps.find((s) => s.step === 'timeAway.openBreak')?.values).toMatchObject({ openBreakAt: at(DATE, '12:00'), assumedOut: at(DATE, '14:00'), minutes: 120 });
  });

  it('an approved window over the step-out still counts as permission / official duty', () => {
    const personal = calculateDailyRecord(input({ shift: SHIFT, rules: assumeEnd(), now: AFTER_WINDOW, timeAway: [window('req-personal', 'PERSONAL', '12:00', '14:00')], events: neverBack() }));
    expect(personal).toMatchObject({ status: 'PRESENT', workedMinutes: 240, permissionMinutes: 120, unapprovedAwayMinutes: 0 });
    expect(personal.flags).not.toContain('UNDER_HOURS');
    resetIds();
    const official = calculateDailyRecord(input({ shift: SHIFT, rules: assumeEnd(), now: AFTER_WINDOW, timeAway: [window('req-official', 'OFFICIAL', '12:00', '14:00')], events: neverBack() }));
    expect(official).toMatchObject({ status: 'PRESENT', workedMinutes: 360, officialDutyMinutes: 120, unapprovedAwayMinutes: 0 });
  });

  it('a closed step-out earlier in the day is classified with the open one', () => {
    const r = calculateDailyRecord(input({ shift: SHIFT, rules: assumeEnd(), now: AFTER_WINDOW, events: [punch(DATE, '08:00', 'PUNCH_IN'), stepOut('10:00'), punch(DATE, '10:30', 'PUNCH_IN'), stepOut('12:00')] }));
    expect(r).toMatchObject({ workedMinutes: 210, awayMinutes: 150, unapprovedAwayMinutes: 150 });
  });

  it('a step-out at or after the assumed check-out changes nothing', () => {
    const r = calculateDailyRecord(input({ shift: SHIFT, rules: assumeEnd(), now: AFTER_WINDOW, events: [punch(DATE, '08:00', 'PUNCH_IN'), stepOut('14:30')] }));
    expect(r).toMatchObject({ workedMinutes: 360, awayMinutes: 0 });
    expect(r.trace.steps.find((s) => s.step === 'timeAway.openBreak')).toBeUndefined();
  });

  it('FLAG_ONLY and the policy off behave as before', () => {
    const flagOnly = calculateDailyRecord(input({ shift: SHIFT, rules: awayRules(), now: AFTER_WINDOW, events: neverBack() }));
    expect(flagOnly).toMatchObject({ status: 'MISSING_PUNCH', workedMinutes: 0, awayMinutes: 0 });
    resetIds();
    const off = calculateDailyRecord(input({ shift: SHIFT, rules: rules({ punchInterpretation: 'DIRECTIONAL', missingPunchBehavior: 'ASSUME_SHIFT_END', minFullDayMinutes: 330, halfDayThresholdMinutes: 180 }), now: AFTER_WINDOW, events: neverBack() }));
    expect(off).toMatchObject({ status: 'PRESENT', workedMinutes: 360, awayMinutes: 0 });
    expect(awayStep(off)).toBeUndefined();
  });
});
