import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import type { DashboardDepartmentRow, DashboardMonthToDate, DashboardSummary } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import { todayIso } from '@/lib/format';
import enAttendance from '@/locales/en/attendance.json';
import arAttendance from '@/locales/ar/attendance.json';
import enApprovals from '@/locales/en/approvals.json';
import arApprovals from '@/locales/ar/approvals.json';
import DashboardPage from './dashboard-page';

registerNamespace('attendance', enAttendance, arAttendance);
registerNamespace('approvals', enApprovals, arApprovals);

/** Statistics and indicators (2026-10-19): attendance by department for the day, and the month-to-date indicators. */
const today = todayIso('Asia/Muscat');
const summary: DashboardSummary = { date: today, employees: 40, presentToday: 30, absent: 6, late: 4, onLeave: 2, earlyDeparture: 1, overtimeMinutes: 90, missingPunch: 1, devicesOnline: 2, devicesOffline: 0, devicesUnknown: 0, syncFailures24h: 0, pendingApprovals: 0 };
const departments: DashboardDepartmentRow[] = [
  { departmentId: 'd1', departmentName: 'Finance', employees: 12, present: 11, absent: 1, late: 3, onLeave: 0, missingPunch: 0, attendanceRate: 91.7 },
  { departmentId: null, departmentName: null, employees: 3, present: 1, absent: 2, late: 0, onLeave: 0, missingPunch: 0, attendanceRate: 33.3 },
];
const mtd: DashboardMonthToDate = { from: `${today.slice(0, 7)}-01`, to: today, workingDays: 200, presentDays: 188, absentDays: 12, lateDays: 21, lateMinutes: 415, earlyDepartureDays: 5, missingPunchDays: 3, leaveDays: 9, shortfallMinutes: 640, overtimeMinutes: 300, attendanceRate: 94, avgWorkedMinutes: 462 };

function mockDashboard(overrides: Record<string, unknown> = {}) {
  mockGet({
    '/orgs/org-1/dashboard/summary': { data: summary },
    '/orgs/org-1/dashboard/trends': { data: [] },
    '/orgs/org-1/dashboard/branches': { data: [] },
    '/orgs/org-1/dashboard/departments': { data: departments },
    '/orgs/org-1/dashboard/month-to-date': { data: mtd },
    '/orgs/org-1/approvals': page([]),
    '/orgs/org-1/holidays': { data: [] },
    '/orgs/org-1/attendance/daily': page([]),
    '/orgs/org-1/sync/jobs': page([]),
    ...overrides,
  });
}

describe('dashboard statistics widgets', () => {
  beforeEach(() => { resetApiMock(); grantAll(); testState.settings = {}; mockDashboard(); });

  it('shows the day per department (rate, late, absent) and the month-to-date indicators', async () => {
    renderWithProviders(<DashboardPage />);
    const table = await screen.findByTestId('department-breakdown');
    const rows = within(table).getAllByRole('row');
    const finance = rows.find((r) => r.textContent?.includes('Finance'))!;
    expect(finance).toHaveTextContent('91.7%');
    expect(finance).toHaveTextContent('Present 11 / 12');
    expect(within(finance).getByRole('progressbar', { name: 'Finance' })).toHaveAttribute('aria-valuenow', '91.7');
    expect(rows.find((r) => r.textContent?.includes('No department'))).toHaveTextContent('33.3%');
    const indicators = await screen.findByTestId('month-to-date');
    expect(indicators).toHaveTextContent('Attendance rate (MTD)94%');
    expect(indicators).toHaveTextContent('188 of 200 working days');
    expect(indicators).toHaveTextContent('Late arrivals21');
    expect(indicators).toHaveTextContent('6h 55m late in total');
    expect(indicators).toHaveTextContent('Absences12');
    expect(indicators).toHaveTextContent('Average worked7h 42m');
    expect(indicators).toHaveTextContent('Short hours10h 40m');
    // the widgets ask for the day the page shows
    expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/dashboard/departments', { date: today });
    expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/dashboard/month-to-date', { date: today });
  });

  it('follows the Settings → Dashboard toggles, and fetches nothing for a hidden widget', async () => {
    testState.settings = { dashboard: { showDepartmentBreakdown: false } };
    const { unmount } = renderWithProviders(<DashboardPage />);
    expect(await screen.findByTestId('month-to-date')).toBeInTheDocument();
    expect(screen.queryByTestId('department-breakdown')).not.toBeInTheDocument();
    expect(apiMock.get.mock.calls.some((c) => c[0] === '/orgs/org-1/dashboard/departments')).toBe(false);
    unmount();
    apiMock.get.mockClear();
    testState.settings = { dashboard: { showDepartmentBreakdown: false, showMonthToDate: false } };
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText('Present today')).toBeInTheDocument();
    expect(screen.queryByTestId('statistics-row')).not.toBeInTheDocument();
    await waitFor(() => expect(apiMock.get.mock.calls.some((c) => c[0] === '/orgs/org-1/dashboard/month-to-date')).toBe(false));
  });

  it('shows the statistics in the executive layout too', async () => {
    testState.settings = { dashboard: { layout: 'executive' } };
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByTestId('department-breakdown')).toBeInTheDocument();
    expect(await screen.findByTestId('month-to-date')).toBeInTheDocument();
  });
});
