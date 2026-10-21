import { describe, expect, it } from 'vitest';
import { checkPunchOnAttendanceDay, punchDayMessage } from './punch-day.js';
import { computePunchWindow } from './window.js';
import { DATE, MUSCAT, fixedShift, flexibleShift, nightShift } from './testing.js';

// Muscat is UTC+4 all year: 2026-03-10 local = 2026-03-09T20:00Z .. 2026-03-10T20:00Z
const NOW = new Date('2026-10-21T08:00:00Z');
const dayWindow = (date: string) => computePunchWindow(fixedShift(), date, MUSCAT);

const check = (punchedAt: string, attendanceDate: string, window = dayWindow(attendanceDate), now = NOW) =>
  checkPunchOnAttendanceDay({ punchedAt, attendanceDate, timezone: MUSCAT, window, now });

describe('checkPunchOnAttendanceDay', () => {
  it('accepts a punch on the attendance date', () => {
    expect(check('2026-10-20T05:00:00Z', '2026-10-20')).toMatchObject({ ok: true, problem: null, punchDate: '2026-10-20', allowedDates: ['2026-10-20'] });
  });

  it('refuses a punch a month after the attendance date, naming the dates it may carry', () => {
    const v = check('2026-12-20T14:00:00Z', '2026-10-20');
    expect(v).toMatchObject({ ok: false, problem: 'WRONG_DAY', punchDate: '2026-12-20', allowedDates: ['2026-10-20'] });
    expect(punchDayMessage(v, '2026-10-20')).toBe('The punch date (2026-12-20) must be the attendance date (2026-10-20).');
  });

  it('refuses the day before and the day after on a day shift', () => {
    expect(check('2026-10-19T10:00:00Z', '2026-10-20').problem).toBe('WRONG_DAY');
    expect(check('2026-10-21T01:00:00Z', '2026-10-20').problem).toBe('WRONG_DAY');
  });

  it('reads the date in the branch zone, not UTC', () => {
    // 22:30 UTC on the 19th is 02:30 on the 20th in Muscat
    expect(check('2026-10-19T22:30:00Z', '2026-10-20')).toMatchObject({ ok: true, punchDate: '2026-10-20' });
  });

  it('allows the next day on an overnight shift only', () => {
    const night = computePunchWindow(nightShift(), '2026-10-19', MUSCAT);
    expect(check('2026-10-20T02:00:00Z', '2026-10-19', night)).toMatchObject({ ok: true, punchDate: '2026-10-20', allowedDates: ['2026-10-19', '2026-10-20'] });
    expect(check('2026-10-21T02:00:00Z', '2026-10-19', night).problem).toBe('WRONG_DAY');
    expect(punchDayMessage(check('2026-10-22T02:00:00Z', '2026-10-19', night), '2026-10-19')).toContain('or the next day (2026-10-20) for an overnight shift');
  });

  it('lets a flexible shift reach the next date until its day boundary only', () => {
    const flex = computePunchWindow(flexibleShift(), '2026-10-19', MUSCAT); // boundary 04:00 → window ends 2026-10-20 04:00 local
    expect(check('2026-10-19T21:30:00Z', '2026-10-19', flex).ok).toBe(true); // 01:30 on the 20th, local
    expect(check('2026-10-20T01:00:00Z', '2026-10-19', flex).problem).toBe('WRONG_DAY'); // 05:00 on the 20th, local
  });

  it('refuses a punch in the future, with a small tolerance for clock drift', () => {
    expect(check('2026-10-21T10:00:00Z', '2026-10-21')).toMatchObject({ ok: false, problem: 'IN_FUTURE' });
    expect(check('2026-10-21T08:04:00Z', '2026-10-21').ok).toBe(true);
    expect(check('2026-10-21T08:06:00Z', '2026-10-21').problem).toBe('IN_FUTURE');
    expect(punchDayMessage(check('2026-10-21T10:00:00Z', '2026-10-21'), '2026-10-21')).toMatch(/future/);
  });

  it('judges the day before the time: a wrong date is reported as the wrong day even when it is also in the future', () => {
    expect(check('2026-12-20T14:00:00Z', '2026-10-20', dayWindow('2026-10-20'), NOW).problem).toBe('WRONG_DAY');
  });

  it('treats a day without a shift as a plain calendar day', () => {
    const none = computePunchWindow(null, DATE, MUSCAT);
    expect(check('2026-03-10T10:00:00Z', DATE, none, new Date('2026-12-01T00:00:00Z')).ok).toBe(true);
    expect(check('2026-03-11T10:00:00Z', DATE, none, new Date('2026-12-01T00:00:00Z')).problem).toBe('WRONG_DAY');
  });

  it('refuses an unparseable punch time', () => {
    expect(check('not a time', '2026-10-20').ok).toBe(false);
  });
});
