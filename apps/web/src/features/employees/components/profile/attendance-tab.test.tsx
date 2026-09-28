import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);

import { grant, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import type { MonthlyRow } from '@/features/attendance/types';
import { AttendanceTab } from './attendance-tab';
import { recentDays } from './recent-days';

const EMP = 'e1';
const row = (days: MonthlyRow['days'], employeeId = EMP): MonthlyRow => ({
  employeeId, employeeNumber: 'MG-1012', employeeName: 'Priya Sharma', branchId: 'b1', days,
  totals: { present: 0, absent: 0, leave: 0, holiday: 0, weeklyOff: 0, halfDay: 0, late: 0, missingPunch: 0, workedMinutes: 0, overtimeMinutes: 0, lateMinutes: 0 },
});

describe('recentDays', () => {
  it('turns the monthly row\'s day map into recorded days, newest first, capped', () => {
    const r = row({
      '2026-09-01': { status: 'PRESENT', workedMinutes: 480, lateMinutes: 0, overtimeMinutes: 0, flags: [], recordId: 'r1' },
      '2026-09-02': null,
      '2026-09-03': { status: 'LEAVE', workedMinutes: 0, lateMinutes: 0, overtimeMinutes: 0, flags: [], recordId: 'r3' },
      '2026-09-04': { status: 'PRESENT', workedMinutes: 500, lateMinutes: 12, overtimeMinutes: 60, flags: ['LATE', 'OVERTIME'], recordId: 'r4' },
    });
    expect(recentDays([r], EMP, 2).map((d) => d.date)).toEqual(['2026-09-04', '2026-09-03']);
    expect(recentDays([r], EMP)[0]).toMatchObject({ status: 'PRESENT', lateMinutes: 12, overtimeMinutes: 60, flags: ['LATE', 'OVERTIME'], recordId: 'r4' });
  });

  it('never throws on the shapes that used to crash the profile: no rows, another employee, missing flags', () => {
    expect(recentDays(undefined, EMP)).toEqual([]);
    expect(recentDays([], EMP)).toEqual([]);
    const other = row({ '2026-09-01': { status: 'PRESENT', workedMinutes: 480, lateMinutes: 0, overtimeMinutes: 0, flags: undefined as unknown as string[], recordId: 'x' } }, 'someone-else');
    expect(recentDays([other], EMP)).toEqual([{ date: '2026-09-01', status: 'PRESENT', workedMinutes: 480, lateMinutes: 0, overtimeMinutes: 0, flags: [], recordId: 'x' }]);
  });
});

describe('AttendanceTab', () => {
  beforeEach(() => { resetApiMock(); grantAll(); testState.orgId = 'org-1'; });

  it('renders the employee\'s recorded days from the monthly endpoint instead of crashing on its row shape', async () => {
    mockGet({
      '/orgs/org-1/attendance/monthly': (query: Record<string, unknown> | undefined) => {
        expect(query).toMatchObject({ employeeId: EMP, pageSize: 1 });
        return page([row({
          '2026-09-01': { status: 'PRESENT', workedMinutes: 480, lateMinutes: 0, overtimeMinutes: 0, flags: [], recordId: 'r1' },
          '2026-09-02': { status: 'HALF_DAY', workedMinutes: 240, lateMinutes: 0, overtimeMinutes: 0, flags: ['HALF_DAY_LEAVE'], recordId: 'r2' },
          '2026-09-03': null,
        })]);
      },
    });
    renderWithProviders(<AttendanceTab employeeId={EMP} />);
    expect(await screen.findByText('HALF_DAY_LEAVE')).toBeInTheDocument();
    const rows = screen.getAllByRole('row').slice(1); // header first
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('02 Sep 2026');
    expect(rows[0]).toHaveTextContent('HALF_DAY');
    expect(rows[1]).toHaveTextContent('01 Sep 2026');
    expect(screen.getByRole('link', { name: /Open attendance/ })).toHaveAttribute('href', `/attendance?employeeId=${EMP}`);
  });

  it('6a-M8 the month strip carries the SUMMARY figures (a half day is ½ present + ½ leave / absent), not the register totals', async () => {
    const strip = { presentDays: 3, lateDays: 1, halfDays: 2, leaveDays: 1.5, absentDays: 3.5, missingPunchDays: 1, holidayDays: 1, weeklyOffDays: 2, daysWorked: 5, workedMinutes: 1365, overtimeMinutes: 270, averageWorkedMinutes: 273, lopDays: 1, unexcusedDays: 1, pendingDays: 0, recordCount: 11 };
    mockGet({
      // the register's monthly totals count the half day differently: they must not reach the strip
      '/orgs/org-1/attendance/monthly': page([{ ...row({ '2026-09-01': { status: 'PRESENT', workedMinutes: 480, lateMinutes: 0, overtimeMinutes: 0, flags: [], recordId: 'r1' } }), totals: { present: 3, absent: 3, leave: 1, holiday: 1, weeklyOff: 2, halfDay: 2, late: 1, missingPunch: 1, workedMinutes: 1365, overtimeMinutes: 270, lateMinutes: 15 } }]),
      '/orgs/org-1/attendance/summary': (query: Record<string, unknown> | undefined) => {
        expect(query).toMatchObject({ employeeId: EMP, pageSize: 1 });
        return { data: [{ ...strip, employeeId: EMP, employeeNumber: 'MG-1012', employeeName: 'Priya Sharma', branchId: 'b1', branchName: null, departmentId: null, departmentName: null, source: 'LIVE', finalizedAt: null }], meta: { page: 1, pageSize: 1, total: 1, totalPages: 1 } };
      },
    });
    renderWithProviders(<AttendanceTab employeeId={EMP} />);
    const el = await screen.findByTestId('attendance-month-strip');
    expect(el).toHaveTextContent('Absent3.5');
    expect(el).toHaveTextContent('Leave1.5');
    expect(el).toHaveTextContent('Worked22:45');
  });

  it('6a-M11 offers the print statement to report.export holders only', async () => {
    mockGet({ '/orgs/org-1/attendance/monthly': page([row({ '2026-09-01': { status: 'PRESENT', workedMinutes: 480, lateMinutes: 0, overtimeMinutes: 0, flags: [], recordId: 'r1' } })]), '/orgs/org-1/attendance/summary': { data: [], meta: { page: 1, pageSize: 1, total: 0, totalPages: 1 } } });
    const r = renderWithProviders(<AttendanceTab employeeId={EMP} />);
    expect(await screen.findByRole('link', { name: /Print view/ })).toBeInTheDocument();
    r.unmount();
    grant('attendance.view', 'employee.view');
    renderWithProviders(<AttendanceTab employeeId={EMP} />);
    await screen.findByRole('link', { name: /Open attendance/ });
    expect(screen.queryByRole('link', { name: /Print view/ })).not.toBeInTheDocument();
  });

  it('shows the empty state when the month has no records yet', async () => {
    mockGet({ '/orgs/org-1/attendance/monthly': page([row({ '2026-09-01': null })]) });
    renderWithProviders(<AttendanceTab employeeId={EMP} />);
    expect(await screen.findByText('No attendance records this month')).toBeInTheDocument();
  });
});
