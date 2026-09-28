import { describe, expect, it } from 'vitest';
import { dueOccurrence, latestScheduleRunAtOrBefore, nextScheduleRun, periodParameters, schedulePeriod, scopeReportForRecipient } from './schedule.js';

const at = (iso: string) => new Date(iso);

describe('nextScheduleRun', () => {
  it('monthly: the run day at the run time in the organisation zone (Asia/Muscat = UTC+4)', () => {
    const t = { cadence: 'monthly' as const, runDay: 1, runTime: '07:00', timezone: 'Asia/Muscat' };
    expect(nextScheduleRun(t, at('2026-09-15T10:00:00Z')).toISOString()).toBe('2026-10-01T03:00:00.000Z');
    // just before the local run time on the run day → today
    expect(nextScheduleRun(t, at('2026-10-01T02:59:00Z')).toISOString()).toBe('2026-10-01T03:00:00.000Z');
    // exactly at the run time → strictly after, so next month
    expect(nextScheduleRun(t, at('2026-10-01T03:00:00Z')).toISOString()).toBe('2026-11-01T03:00:00.000Z');
  });

  it('monthly: the local calendar decides the month, not UTC (23:30 UTC on the 31st is already the 1st in Muscat)', () => {
    const t = { cadence: 'monthly' as const, runDay: 1, runTime: '07:00', timezone: 'Asia/Muscat' };
    // 2026-08-31T23:30Z = 2026-09-01 03:30 local → the run of 1 Sep 07:00 local is still ahead
    expect(nextScheduleRun(t, at('2026-08-31T23:30:00Z')).toISOString()).toBe('2026-09-01T03:00:00.000Z');
  });

  it('monthly: rolls over the year end and keeps day 28 in February', () => {
    const t = { cadence: 'monthly' as const, runDay: 28, runTime: '18:30', timezone: 'UTC' };
    expect(nextScheduleRun(t, at('2026-12-29T00:00:00Z')).toISOString()).toBe('2027-01-28T18:30:00.000Z');
    expect(nextScheduleRun(t, at('2027-01-29T00:00:00Z')).toISOString()).toBe('2027-02-28T18:30:00.000Z');
  });

  it('weekly: 0 = Sunday … 6 = Saturday', () => {
    const sunday = { cadence: 'weekly' as const, runDay: 0, runTime: '08:00', timezone: 'UTC' };
    // 2026-09-23 is a Wednesday
    expect(nextScheduleRun(sunday, at('2026-09-23T12:00:00Z')).toISOString()).toBe('2026-09-27T08:00:00.000Z');
    const monday = { cadence: 'weekly' as const, runDay: 1, runTime: '08:00', timezone: 'UTC' };
    expect(nextScheduleRun(monday, at('2026-09-27T09:00:00Z')).toISOString()).toBe('2026-09-28T08:00:00.000Z');
    // on the run day after the run time → next week
    expect(nextScheduleRun(monday, at('2026-09-28T09:00:00Z')).toISOString()).toBe('2026-10-05T08:00:00.000Z');
  });

  it('keeps the local wall-clock time across a DST change (Europe/London, last Sunday of October)', () => {
    const t = { cadence: 'weekly' as const, runDay: 1, runTime: '07:00', timezone: 'Europe/London' };
    // Monday 19 Oct 2026 07:00 BST = 06:00Z; Monday 26 Oct 2026 07:00 GMT = 07:00Z
    expect(nextScheduleRun(t, at('2026-10-19T06:30:00Z')).toISOString()).toBe('2026-10-26T07:00:00.000Z');
  });

  it('falls back to UTC for an invalid zone', () => {
    const t = { cadence: 'monthly' as const, runDay: 5, runTime: '07:00', timezone: 'Not/AZone' };
    expect(nextScheduleRun(t, at('2026-09-01T00:00:00Z')).toISOString()).toBe('2026-09-05T07:00:00.000Z');
  });
});

describe('latestScheduleRunAtOrBefore / dueOccurrence', () => {
  const t = { cadence: 'monthly' as const, runDay: 1, runTime: '07:00', timezone: 'UTC' };
  it('the last occurrence at or before now', () => {
    expect(latestScheduleRunAtOrBefore(t, at('2026-09-15T00:00:00Z')).toISOString()).toBe('2026-09-01T07:00:00.000Z');
    expect(latestScheduleRunAtOrBefore(t, at('2026-09-01T07:00:00Z')).toISOString()).toBe('2026-09-01T07:00:00.000Z');
    expect(latestScheduleRunAtOrBefore(t, at('2026-09-01T06:59:00Z')).toISOString()).toBe('2026-08-01T07:00:00.000Z');
  });
  it('a punctual run covers its stored occurrence', () => {
    expect(dueOccurrence(t, at('2026-09-01T07:00:00Z'), at('2026-09-01T07:04:00Z'))).toEqual({ scheduledFor: at('2026-09-01T07:00:00Z'), missed: 0 });
  });
  it('a run late by more than one cadence covers the latest occurrence and counts the skipped ones', () => {
    const due = dueOccurrence(t, at('2026-06-01T07:00:00Z'), at('2026-09-10T00:00:00Z'));
    expect(due.scheduledFor.toISOString()).toBe('2026-09-01T07:00:00.000Z');
    expect(due.missed).toBe(3);
  });
});

describe('schedulePeriod', () => {
  const run = at('2026-09-01T03:00:00Z'); // 1 Sep 07:00 in Muscat
  it('previous_month = the whole calendar month before the run', () => {
    expect(schedulePeriod({ periodRule: 'previous_month' }, run, 'Asia/Muscat')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(schedulePeriod({ periodRule: 'previous_month' }, at('2027-01-01T03:00:00Z'), 'Asia/Muscat')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(schedulePeriod({ periodRule: 'previous_month' }, at('2028-03-01T03:00:00Z'), 'Asia/Muscat')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });
  it('month_to_date = the first of the month to yesterday (a run on the 1st covers the previous month)', () => {
    expect(schedulePeriod({ periodRule: 'month_to_date' }, at('2026-09-15T03:00:00Z'), 'Asia/Muscat')).toEqual({ from: '2026-09-01', to: '2026-09-14' });
    expect(schedulePeriod({ periodRule: 'month_to_date' }, run, 'Asia/Muscat')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
  });
  it('previous_week follows the organisation first day of the week', () => {
    const monday = at('2026-09-28T04:00:00Z'); // Monday 28 Sep
    expect(schedulePeriod({ periodRule: 'previous_week', firstDayOfWeek: 0 }, monday, 'UTC')).toEqual({ from: '2026-09-20', to: '2026-09-26' });
    expect(schedulePeriod({ periodRule: 'previous_week', firstDayOfWeek: 1 }, monday, 'UTC')).toEqual({ from: '2026-09-21', to: '2026-09-27' });
    expect(schedulePeriod({ periodRule: 'previous_week', firstDayOfWeek: 6 }, monday, 'UTC')).toEqual({ from: '2026-09-19', to: '2026-09-25' });
  });
  it('custom = the last complete cut-off period (26 → 25)', () => {
    expect(schedulePeriod({ periodRule: 'custom', customFromDay: 26, customToDay: 25 }, at('2026-09-26T04:00:00Z'), 'UTC')).toEqual({ from: '2026-08-26', to: '2026-09-25' });
    // run ON the to-day: that day is not over yet → the previous period
    expect(schedulePeriod({ periodRule: 'custom', customFromDay: 26, customToDay: 25 }, at('2026-09-25T04:00:00Z'), 'UTC')).toEqual({ from: '2026-07-26', to: '2026-08-25' });
    expect(schedulePeriod({ periodRule: 'custom', customFromDay: 16, customToDay: 15 }, at('2027-01-03T04:00:00Z'), 'UTC')).toEqual({ from: '2026-11-16', to: '2026-12-15' });
  });
  it('uses the local date of the occurrence', () => {
    // 2026-08-31T21:00Z is already 1 Sep in Muscat
    expect(schedulePeriod({ periodRule: 'previous_month' }, at('2026-08-31T21:00:00Z'), 'Asia/Muscat')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(schedulePeriod({ periodRule: 'previous_month' }, at('2026-08-31T21:00:00Z'), 'UTC')).toEqual({ from: '2026-07-01', to: '2026-07-31' });
  });
});

describe('periodParameters', () => {
  const p = { from: '2026-08-01', to: '2026-08-31' };
  it('maps the period onto each report type', () => {
    expect(periodParameters('monthly_attendance', p)).toEqual({ month: '2026-08' });
    expect(periodParameters('late_report', p)).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(periodParameters('weekly_attendance', { from: '2026-09-20', to: '2026-09-26' })).toEqual({ from: '2026-09-20' });
    expect(periodParameters('employee_directory', p)).toEqual({});
  });

  it('6a-M13 a whole-month type asked for month to date gets the exact days, never the rest of the month', () => {
    // a run on the 15th: month to date = the 1st up to yesterday
    const mtd = schedulePeriod({ periodRule: 'month_to_date' }, at('2026-10-15T03:00:00Z'), 'Asia/Muscat');
    expect(mtd).toEqual({ from: '2026-10-01', to: '2026-10-14' });
    expect(periodParameters('monthly_attendance', mtd)).toEqual({ month: '2026-10', from: '2026-10-01', to: '2026-10-14' });
    expect(periodParameters('monthly_summary', mtd)).toEqual({ month: '2026-10', from: '2026-10-01', to: '2026-10-14' });
    // a run on the 1st covers the whole previous month: the month alone, as before
    const onFirst = schedulePeriod({ periodRule: 'month_to_date' }, at('2026-11-01T03:00:00Z'), 'Asia/Muscat');
    expect(periodParameters('monthly_attendance', onFirst)).toEqual({ month: '2026-10' });
    // February and a leap year: the month's real last day
    expect(periodParameters('monthly_summary', { from: '2028-02-01', to: '2028-02-29' })).toEqual({ month: '2028-02' });
    expect(periodParameters('monthly_summary', { from: '2028-02-01', to: '2028-02-28' })).toEqual({ month: '2028-02', from: '2028-02-01', to: '2028-02-28' });
  });
});

describe('scopeReportForRecipient', () => {
  const ALL = ['report.view', 'report.export', 'attendance.view', 'employee.view'];
  const emps = new Map([['e-a', 'b-a'], ['e-b', 'b-b']]);
  it('an organisation-wide recipient keeps the filters as chosen', () => {
    const d = scopeReportForRecipient({ userId: 'u', permissions: ALL, allBranches: true, branchIds: [] }, 'late_report', { from: '2026-08-01', to: '2026-08-31' }, emps);
    expect(d).toEqual({ ok: true, kind: 'ORGANIZATION', parameters: { from: '2026-08-01', to: '2026-08-31' }, branchId: null, branchCount: null, employeeCount: null });
  });
  it('a branch-scoped recipient gets their branch scope injected — never the whole organisation', () => {
    const one = scopeReportForRecipient({ userId: 'u', permissions: ALL, allBranches: false, branchIds: ['b-a'] }, 'late_report', { from: '2026-08-01', to: '2026-08-31' }, emps);
    expect(one).toMatchObject({ ok: true, kind: 'BRANCHES', branchId: 'b-a', parameters: { branchId: 'b-a', branchScope: ['b-a'] } });
    const two = scopeReportForRecipient({ userId: 'u', permissions: ALL, allBranches: false, branchIds: ['b-a', 'b-b'] }, 'late_report', { from: '2026-08-01' }, emps);
    expect(two).toMatchObject({ ok: true, kind: 'BRANCHES', branchId: null, parameters: { branchIds: ['b-a', 'b-b'], branchScope: ['b-a', 'b-b'] } });
  });
  it('a sender-supplied scope can never widen the recipient: injected keys are replaced', () => {
    const d = scopeReportForRecipient({ userId: 'u', permissions: ALL, allBranches: false, branchIds: ['b-a'] }, 'late_report', { branchScope: ['b-b'], branchIds: ['b-b'] }, emps);
    expect(d).toMatchObject({ ok: true, parameters: { branchId: 'b-a', branchScope: ['b-a'] } });
    expect((d as { parameters: Record<string, unknown> }).parameters['branchIds']).toBeUndefined();
  });
  it('refuses filters outside the recipient scope instead of narrowing them to a different report', () => {
    const g = { userId: 'u', permissions: ALL, allBranches: false, branchIds: ['b-a'] };
    expect(scopeReportForRecipient(g, 'late_report', { branchId: 'b-b' }, emps)).toEqual({ ok: false, reason: 'outside_scope:branch' });
    expect(scopeReportForRecipient(g, 'employee_attendance', { employeeIds: ['e-a', 'e-b'] }, emps)).toEqual({ ok: false, reason: 'outside_scope:employees' });
    expect(scopeReportForRecipient(g, 'employee_attendance', { employeeIds: ['e-a'] }, emps)).toMatchObject({ ok: true });
    expect(scopeReportForRecipient({ ...g, branchIds: [] }, 'late_report', {}, emps)).toEqual({ ok: false, reason: 'no_branch_access' });
    expect(scopeReportForRecipient({ ...g, allBranches: true }, 'employee_attendance', { employeeIds: ['gone'] }, emps)).toEqual({ ok: false, reason: 'outside_scope:employees' });
  });
  it('a line manager (team variant only) receives their direct reports and nobody else', () => {
    const manager = { userId: 'm', permissions: ['report.view', 'report.export', 'attendance.view_team'], allBranches: true, branchIds: [] as string[], teamEmployeeIds: ['e-b', 'e-a'] };
    expect(scopeReportForRecipient(manager, 'late_report', { from: '2026-08-01', to: '2026-08-31' }, emps)).toEqual({ ok: true, kind: 'TEAM', parameters: { from: '2026-08-01', to: '2026-08-31', employeeIds: ['e-a', 'e-b'] }, branchId: null, branchCount: null, employeeCount: 2 });
    expect(scopeReportForRecipient(manager, 'employee_attendance', { employeeIds: ['e-a'] }, emps)).toMatchObject({ ok: true, kind: 'TEAM', parameters: { employeeIds: ['e-a'] } });
    expect(scopeReportForRecipient({ ...manager, teamEmployeeIds: ['e-a'] }, 'employee_attendance', { employeeIds: ['e-a', 'e-b'] }, emps)).toEqual({ ok: false, reason: 'outside_scope:employees' });
    expect(scopeReportForRecipient({ ...manager, teamEmployeeIds: [] }, 'late_report', {}, emps)).toEqual({ ok: false, reason: 'no_team' });
    // the audit log has no line-manager variant
    expect(scopeReportForRecipient({ ...manager, permissions: [...manager.permissions, 'attendance.view'] }, 'audit_report', {}, emps)).toEqual({ ok: false, reason: 'missing_permission:audit.view' });
    // a branch-restricted manager keeps the branch scope as well
    expect(scopeReportForRecipient({ ...manager, allBranches: false, branchIds: ['b-a'] }, 'late_report', {}, emps)).toMatchObject({ ok: true, kind: 'TEAM', branchId: null, parameters: { employeeIds: ['e-a', 'e-b'], branchIds: ['b-a'], branchScope: ['b-a'] } });
  });
  it('requires report.view, report.export and the report type permissions', () => {
    const g = { userId: 'u', allBranches: true, branchIds: [] };
    expect(scopeReportForRecipient({ ...g, permissions: ['report.view', 'attendance.view'] }, 'late_report', {}, emps)).toEqual({ ok: false, reason: 'missing_permission:report.export' });
    expect(scopeReportForRecipient({ ...g, permissions: ['report.view', 'report.export'] }, 'late_report', {}, emps)).toEqual({ ok: false, reason: 'missing_permission:attendance.view' });
    expect(scopeReportForRecipient({ ...g, permissions: ['report.view', 'report.export', 'attendance.view'] }, 'audit_report', {}, emps)).toEqual({ ok: false, reason: 'missing_permission:audit.view' });
  });
});
