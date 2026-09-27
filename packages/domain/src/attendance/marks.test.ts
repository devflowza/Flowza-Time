import { describe, expect, it } from 'vitest';
import { ATTENDANCE_FLAGS } from '@flowza/contracts';
import { applyDayMarks, calculateDailyRecord, normalisePayEffect } from './calculate.js';
import { DATE, input, punch, resetIds } from './testing.js';
import type { EngineDayMark } from './types.js';

const day = (inTime: string, outTime: string, payload?: Partial<NonNullable<ReturnType<typeof punch>['payload']>>) => [
  punch(DATE, inTime, 'PUNCH_IN', undefined, payload ? { payload } : {}),
  punch(DATE, outTime, 'PUNCH_OUT', undefined, payload ? { payload } : {}),
];
const mark = (kind: EngineDayMark['kind'], payEffectDays = 0, source: EngineDayMark['source'] = 'HR', id = `mark-${kind.toLowerCase()}`): EngineDayMark => ({ id, kind, payEffectDays, source });
const stepNames = (r: ReturnType<typeof calculateDailyRecord>) => r.trace.steps.map((s) => s.step);

describe('policy-parity flags from the punch payload (HR portal Prompt 3)', () => {
  it('flags SELF_SERVICE_PUNCH for web / mobile check-ins and nothing for device punches', () => {
    const device = calculateDailyRecord(input({ events: day('09:00', '17:00') }));
    expect(device.flags).not.toContain('SELF_SERVICE_PUNCH');
    resetIds();
    const web = calculateDailyRecord(input({ events: day('09:00', '17:00', { channel: 'web' }) }));
    expect(web.flags).toContain('SELF_SERVICE_PUNCH');
    expect(web.trace.steps.find((s) => s.step === 'punch.selfService')?.values).toMatchObject({ events: ['evt-001', 'evt-002'] });
    const mobile = calculateDailyRecord(input({ events: [punch(DATE, '09:00', 'PUNCH_IN', undefined, { payload: { channel: 'mobile' } }), punch(DATE, '17:00', 'PUNCH_OUT')] }));
    expect(mobile.flags).toContain('SELF_SERVICE_PUNCH');
    expect(mobile.status).toBe('PRESENT');
  });

  it('flags OUTSIDE_GEOFENCE for outside / mock verdicts and not for allowed or no-fence ones', () => {
    for (const verdict of ['flagged', 'logged', 'denied_outside', 'DENIED_MOCK']) {
      const r = calculateDailyRecord(input({ events: day('09:00', '17:00', { channel: 'mobile', geofenceVerdict: verdict }) }));
      expect(r.flags, verdict).toContain('OUTSIDE_GEOFENCE');
      expect(r.trace.steps.find((s) => s.step === 'punch.geofence')?.detail).toContain(verdict.toLowerCase());
    }
    for (const verdict of ['allowed', 'no_fence', 'no_fences_assigned']) {
      const r = calculateDailyRecord(input({ events: day('09:00', '17:00', { channel: 'mobile', geofenceVerdict: verdict }) }));
      expect(r.flags, verdict).not.toContain('OUTSIDE_GEOFENCE');
    }
    const mock = calculateDailyRecord(input({ events: day('09:00', '17:00', { channel: 'mobile', geofenceVerdict: 'allowed', isMock: true }) }));
    expect(mock.flags).toContain('OUTSIDE_GEOFENCE');
    expect(mock.trace.steps.find((s) => s.step === 'punch.geofence')?.detail).toContain('mock location');
  });

  it('flags OUT_OF_WINDOW when the payload says the punch fell outside the policy window', () => {
    const r = calculateDailyRecord(input({ events: day('09:00', '17:00', { channel: 'web', outOfWindow: true }) }));
    expect(r.flags).toContain('OUT_OF_WINDOW');
    expect(stepNames(r)).toContain('punch.outOfWindow');
    expect(r.status).toBe('PRESENT'); // a policy-window breach is a flag, never a status change
    const inside = calculateDailyRecord(input({ events: day('09:00', '17:00', { channel: 'web', outOfWindow: false }) }));
    expect(inside.flags).not.toContain('OUT_OF_WINDOW');
  });

  it('only reads the payload of events attributed to the date', () => {
    const otherDay = punch('2026-03-11', '09:00', 'PUNCH_IN', undefined, { payload: { channel: 'web', geofenceVerdict: 'denied_outside' } });
    const r = calculateDailyRecord(input({ events: [...day('09:00', '17:00'), otherDay] }));
    expect(r.flags).not.toContain('SELF_SERVICE_PUNCH');
    expect(r.flags).not.toContain('OUTSIDE_GEOFENCE');
  });
});

describe('day marks', () => {
  it('a record without marks has lopDays 0 and is not unexcused', () => {
    const r = calculateDailyRecord(input({ events: day('09:00', '17:00') }));
    expect(r).toMatchObject({ lopDays: 0, unexcused: false });
    expect(stepNames(r)).not.toContain('marks');
  });

  it('UNEXCUSED adds the flag and the boolean without touching the status', () => {
    const r = calculateDailyRecord(input({ events: [], dayMarks: [mark('UNEXCUSED', 0, 'SWEEP')] }));
    expect(r.status).toBe('ABSENT');
    expect(r.flags).toContain('UNEXCUSED');
    expect(r).toMatchObject({ lopDays: 0, unexcused: true });
    expect(r.trace.steps.find((s) => s.step === 'marks.unexcused')?.detail).toContain('SWEEP');
  });

  it('LOP carries the pay effect into lopDays and the PAY_EFFECT_* flag', () => {
    const full = calculateDailyRecord(input({ events: [], dayMarks: [mark('UNEXCUSED', 0, 'SWEEP'), mark('LOP', 1, 'SWEEP')] }));
    expect(full.flags).toEqual(expect.arrayContaining(['UNEXCUSED', 'LOP', 'PAY_EFFECT_FULL']));
    expect(full.flags).not.toContain('PAY_EFFECT_HALF');
    expect(full).toMatchObject({ status: 'ABSENT', lopDays: 1, unexcused: true });
    const half = calculateDailyRecord(input({ events: day('10:30', '17:00'), dayMarks: [mark('LOP', 0.5)] }));
    expect(half.flags).toEqual(expect.arrayContaining(['LATE', 'LOP', 'PAY_EFFECT_HALF']));
    expect(half).toMatchObject({ status: 'PRESENT', lopDays: 0.5, unexcused: false });
  });

  it('PAY_EFFECT (charged to leave) flags the half / full day but costs no pay', () => {
    const r = calculateDailyRecord(input({ events: day('10:30', '17:00'), dayMarks: [mark('PAY_EFFECT', 0.5, 'NOTE_REVIEW')] }));
    expect(r.flags).toContain('PAY_EFFECT_HALF');
    expect(r.flags).not.toContain('LOP');
    expect(r).toMatchObject({ lopDays: 0, unexcused: false });
    expect(r.trace.steps.find((s) => s.step === 'marks.payEffect')?.detail).toContain('charged to paid leave');
  });

  it('EXCUSED keeps the LATE / ABSENT consequences on the record but zeroes the loss of pay and supersedes other marks', () => {
    const late = calculateDailyRecord(input({ events: day('10:30', '17:00'), dayMarks: [mark('EXCUSED'), mark('LOP', 0.5), mark('UNEXCUSED')] }));
    expect(late.status).toBe('PRESENT');
    expect(late.lateMinutes).toBeGreaterThan(0);
    expect(late.flags).toContain('LATE');
    expect(late.flags).toContain('EXCUSED');
    expect(late.flags).not.toContain('LOP');
    expect(late.flags).not.toContain('UNEXCUSED');
    expect(late.flags).not.toContain('PAY_EFFECT_HALF');
    expect(late).toMatchObject({ lopDays: 0, unexcused: false });
    expect(late.trace.steps.find((s) => s.step === 'marks.excused')?.values).toMatchObject({ superseded: ['mark-lop', 'mark-unexcused'] });
    const absent = calculateDailyRecord(input({ events: [], dayMarks: [mark('EXCUSED')] }));
    expect(absent).toMatchObject({ status: 'ABSENT', lopDays: 0, unexcused: false });
    expect(absent.flags).toContain('EXCUSED');
  });

  it('keeps flags in the canonical order and leaves the core result untouched (pure)', () => {
    const core = calculateDailyRecord(input({ events: day('10:30', '17:00') }));
    const marked = applyDayMarks(core, [mark('LOP', 1), mark('UNEXCUSED')]);
    expect(core.flags).not.toContain('LOP');
    expect(core.trace.steps.map((s) => s.step)).not.toContain('marks');
    const order = (flags: readonly string[]) => flags.map((f) => ATTENDANCE_FLAGS.indexOf(f as (typeof ATTENDANCE_FLAGS)[number]));
    expect(order(marked.flags)).toEqual([...order(marked.flags)].sort((a, b) => a - b));
    expect(marked.trace.steps.length).toBe(core.trace.steps.length + 3);
  });

  it('is deterministic: equal inputs serialise identically whatever the order of the marks', () => {
    resetIds();
    const a = calculateDailyRecord(input({ events: day('09:00', '17:00'), dayMarks: [mark('LOP', 1), mark('UNEXCUSED')] }));
    resetIds();
    const b = calculateDailyRecord(input({ events: day('09:00', '17:00'), dayMarks: [mark('UNEXCUSED'), mark('LOP', 1)] }));
    expect(JSON.stringify({ ...a, trace: undefined })).toBe(JSON.stringify({ ...b, trace: undefined }));
  });

  it('normalises pay effects to 0 / 0.5 / 1', () => {
    expect([0, 0.25, 0.5, 0.75, 1, 2, Number.NaN, -1].map(normalisePayEffect)).toEqual([0, 0, 0.5, 0.5, 1, 1, 0, 0]);
    const r = calculateDailyRecord(input({ events: [], dayMarks: [mark('LOP', 0)] }));
    expect(r.flags).not.toContain('LOP');
    expect(r.lopDays).toBe(0);
  });
});
