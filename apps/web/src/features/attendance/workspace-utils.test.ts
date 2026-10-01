import { describe, expect, it } from 'vitest';
import type { AttendanceCalendarDayDto } from '@flowza/contracts';
import { calendarDayLabel, checkOutBeforeIn, dotsOf, FINANCE_STATUS_MAPPING, isFuturePunch, isManualStatus, issueField, localToUtcIso, monthWeeks, syncRangeOf, utcToLocalTime, weekdayOrder } from './workspace-utils';
import type { CorrectionDto } from './types';

const day = (over: Partial<AttendanceCalendarDayDto> = {}): AttendanceCalendarDayDto => ({
  recordId: 'r1', status: 'PRESENT', flags: [], statusSource: 'AUTO', firstInAt: '2026-09-01T04:05:00Z', lastOutAt: '2026-09-01T13:10:00Z',
  workedMinutes: 545, lateMinutes: 5, earlyDepartureMinutes: 0, overtimeMinutes: 25, timezone: 'Asia/Muscat', ...over,
});
const t = (k: string, o?: Record<string, unknown>) => (o && 'defaultValue' in o ? `${k}` : k);

describe('workspace utils', () => {
  it('lays a month out in weeks starting on the organisation\'s first day of the week', () => {
    const sunday = monthWeeks('2026-09', 0); // 1 Sep 2026 is a Tuesday
    expect(sunday[0]).toEqual([null, null, '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']);
    expect(sunday.flat().filter(Boolean)).toHaveLength(30);
    expect(sunday.every((w) => w.length === 7)).toBe(true);
    const saturday = monthWeeks('2026-09', 6);
    expect(saturday[0]!.slice(0, 4)).toEqual([null, null, null, '2026-09-01']);
    expect(weekdayOrder(6)).toEqual([6, 0, 1, 2, 3, 4, 5]);
    expect(monthWeeks('nope')).toEqual([]);
  });

  it('converts wall-clock times of a zone to UTC and back, with the next-day check-out', () => {
    expect(localToUtcIso('2026-09-01', '08:30', 'Asia/Muscat')).toBe('2026-09-01T04:30:00Z');
    expect(localToUtcIso('2026-09-01', '01:15', 'Asia/Muscat', true)).toBe('2026-09-01T21:15:00Z');
    expect(localToUtcIso('2026-09-01', '8:30', 'Asia/Muscat')).toBeNull();
    expect(utcToLocalTime('2026-09-01T21:15:00Z', 'Asia/Muscat', '2026-09-01')).toEqual({ time: '01:15', nextDay: true });
    expect(utcToLocalTime(null, 'Asia/Muscat', '2026-09-01')).toBeNull();
    expect(checkOutBeforeIn('2026-09-01T04:30:00Z', '2026-09-01T04:00:00Z')).toBe(true);
    expect(checkOutBeforeIn('2026-09-01T04:30:00Z', '2026-09-01T04:30:00Z')).toBe(true);
    expect(checkOutBeforeIn('2026-09-01T04:30:00Z', null)).toBe(false);
  });

  it('refuses a punch later than now, with the API\'s five-minute clock tolerance', () => {
    const now = Date.parse('2026-10-01T08:00:00Z'); // 12:00 in Muscat
    expect(isFuturePunch(localToUtcIso('2026-10-01', '16:46', 'Asia/Muscat'), now)).toBe(true);
    expect(isFuturePunch(localToUtcIso('2026-10-01', '03:50', 'Asia/Muscat', true), now)).toBe(true);
    expect(isFuturePunch(localToUtcIso('2026-10-01', '11:45', 'Asia/Muscat'), now)).toBe(false);
    expect(isFuturePunch('2026-10-01T08:05:00Z', now)).toBe(false);
    expect(isFuturePunch('2026-10-01T08:05:01Z', now)).toBe(true);
    expect(isFuturePunch(null, now)).toBe(false);
  });

  it('reads the field a validation error names', () => {
    expect(issueField({ issues: [{ path: 'outAt', message: 'In the future' }] })).toBe('outAt');
    expect(issueField({ issues: [{ path: 'date', message: 'x' }, { path: 'inAt', message: 'y' }] })).toBe('inAt');
    expect(issueField({ issues: [{ path: 'date', message: 'x' }] })).toBeNull();
    expect(issueField({ issues: 'nope' })).toBeNull();
    expect(issueField(undefined)).toBeNull();
  });

  it('describes a calendar day for its tooltip and picks one dot per colour', () => {
    const label = calendarDayLabel(t, t, '2026-09-01', day({ flags: ['LATE', 'OVERTIME', 'MISSING_OUT', 'MISSING_IN'], statusSource: 'MANUAL' }), 'Asia/Muscat');
    expect(label).toContain('status.PRESENT (source.MANUAL)');
    expect(label).toContain('calendar.inOut 08:05–17:10');
    expect(label).toContain('columns.late 5m');
    expect(label).toContain('flags.MISSING_OUT, flags.MISSING_IN');
    expect(calendarDayLabel(t, t, '2026-09-02', undefined, 'Asia/Muscat')).toMatch(/calendar\.noRecord$/);
    // MISSING_IN and MISSING_OUT share red: one dot
    expect(dotsOf(day({ flags: ['LATE', 'MISSING_IN', 'MISSING_OUT', 'OVERTIME'] }))).toEqual(['bg-amber-500', 'bg-red-600', 'bg-blue-600']);
    expect(dotsOf(undefined)).toEqual([]);
  });

  it('treats a day as Manual only when a SET_STATUS correction was applied', () => {
    const c = (type: string, status: string) => ({ type, status }) as CorrectionDto;
    expect(isManualStatus({ corrections: [c('SET_STATUS', 'APPLIED')] })).toBe(true);
    expect(isManualStatus({ corrections: [c('SET_STATUS', 'PENDING'), c('EDIT_PUNCH', 'APPLIED')] })).toBe(false);
    expect(isManualStatus({ corrections: undefined as unknown as CorrectionDto[] })).toBe(false);
  });

  it('syncs the range the register shows: the daily date, else the month up to today', () => {
    expect(syncRangeOf(new URLSearchParams('tab=daily&date=2026-09-10'), '2026-09-20')).toEqual({ fromDate: '2026-09-10', toDate: '2026-09-10' });
    expect(syncRangeOf(new URLSearchParams(''), '2026-09-20')).toEqual({ fromDate: '2026-09-20', toDate: '2026-09-20' });
    expect(syncRangeOf(new URLSearchParams('tab=calendar'), '2026-09-20')).toEqual({ fromDate: '2026-09-01', toDate: '2026-09-20' });
    expect(syncRangeOf(new URLSearchParams('tab=monthly&month=2026-08'), '2026-09-20')).toEqual({ fromDate: '2026-08-01', toDate: '2026-08-31' });
    expect(syncRangeOf(new URLSearchParams('employeeId=e1'), '2026-09-20')).toEqual({ fromDate: '2026-09-01', toDate: '2026-09-20' });
  });

  it('maps all ten Flowza Finance statuses', () => {
    expect(FINANCE_STATUS_MAPPING.map((m) => m.finance)).toEqual(['present', 'late', 'half_day', 'absent', 'on_leave', 'holiday', 'weekend', 'incomplete', 'holiday_work', 'weekly_off_work']);
    expect(FINANCE_STATUS_MAPPING.find((m) => m.finance === 'late')!.flags).toEqual(['LATE']);
  });
});
