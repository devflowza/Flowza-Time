import { describe, expect, it } from 'vitest';
import { summarisePeriod, type PeriodRecordLike } from './period.js';

function record(attendanceDate: string, status: PeriodRecordLike['status'], overrides: Partial<PeriodRecordLike> = {}): PeriodRecordLike {
  return { attendanceDate, status, flags: [], workedMinutes: 0, overtimeMinutes: 0, overtimeCategory: null, lateMinutes: 0, earlyDepartureMinutes: 0, ...overrides };
}

describe('summarisePeriod', () => {
  const records: PeriodRecordLike[] = [
    record('2026-03-01', 'PRESENT', { workedMinutes: 480 }),
    record('2026-03-02', 'PRESENT', { workedMinutes: 540, overtimeMinutes: 60, overtimeCategory: 'REGULAR', flags: ['OVERTIME', 'LATE'], lateMinutes: 12 }),
    record('2026-03-03', 'HALF_DAY', { workedMinutes: 200, flags: ['UNDER_HOURS'], earlyDepartureMinutes: 280 }),
    record('2026-03-04', 'HALF_DAY', { workedMinutes: 240, flags: ['HALF_DAY_LEAVE'], leaveIsPaid: true }),
    record('2026-03-05', 'ABSENT'),
    record('2026-03-06', 'WEEKLY_OFF', { workedMinutes: 300, overtimeMinutes: 300, overtimeCategory: 'WEEKLY_OFF', flags: ['WORKED_ON_WEEKLY_OFF', 'OVERTIME'] }),
    record('2026-03-07', 'WEEKLY_OFF'),
    record('2026-03-08', 'HOLIDAY', { workedMinutes: 120, overtimeMinutes: 120, overtimeCategory: 'HOLIDAY', flags: ['WORKED_ON_HOLIDAY', 'OVERTIME'] }),
    record('2026-03-09', 'LEAVE', { leaveIsPaid: true }),
    record('2026-03-10', 'LEAVE', { leaveIsPaid: false }),
    record('2026-03-11', 'PRESENT', { flags: ['MISSING_OUT'] }),
    record('2026-03-12', 'MISSING_PUNCH', { flags: ['MISSING_IN'] }),
    record('2026-03-13', 'ABSENT', { flags: ['HALF_DAY_LEAVE'], leaveIsPaid: false }),
    record('2026-03-14', 'PENDING'),
    record('2026-02-28', 'PRESENT', { workedMinutes: 999 }), // outside the period
    record('2026-03-15', 'NOT_JOINED'),
  ];

  it('produces payroll totals matching attendance_period_summaries columns', () => {
    const s = summarisePeriod(records, { periodStart: '2026-03-01', periodEnd: '2026-03-31' });
    expect(s).toEqual({
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      recordCount: 15,
      workingDays: 11,
      presentDays: 1 + 1 + 0.5 + 0.5 + 1 + 1,
      absentDays: 0.5 + 1 + 0.5,
      leaveDays: 0.5 + 1 + 1 + 0.5,
      paidLeaveDays: 0.5 + 1,
      holidayDays: 1,
      weeklyOffDays: 2,
      halfDays: 2,
      missingPunchDays: 2,
      lateDays: 1,
      regularMinutes: 480 + 480 + 200 + 240 + 0 + 0,
      overtimeMinutes: 60,
      overtimeWeeklyOffMinutes: 300,
      overtimeHolidayMinutes: 120,
      totalOvertimeMinutes: 480,
      lateMinutes: 12,
      earlyDepartureMinutes: 280,
      pendingDays: 1,
    });
  });

  it('defaults leave to paid unless told otherwise', () => {
    const s = summarisePeriod([record('2026-03-09', 'LEAVE')], { periodStart: '2026-03-01', periodEnd: '2026-03-31' });
    expect(s.paidLeaveDays).toBe(1);
    const unpaid = summarisePeriod([record('2026-03-09', 'LEAVE')], { periodStart: '2026-03-01', periodEnd: '2026-03-31', defaultLeavePaid: false });
    expect(unpaid.paidLeaveDays).toBe(0);
    expect(unpaid.leaveDays).toBe(1);
  });

  it('returns zeros for an empty period', () => {
    const s = summarisePeriod([], { periodStart: '2026-03-01', periodEnd: '2026-03-31' });
    expect(s.workingDays).toBe(0);
    expect(s.presentDays).toBe(0);
    expect(s.recordCount).toBe(0);
  });
});
