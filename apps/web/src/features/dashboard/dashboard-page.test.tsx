import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { DashboardSummary } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import { todayIso } from '@/lib/format';
import enAttendance from '@/locales/en/attendance.json';
import arAttendance from '@/locales/ar/attendance.json';
import enApprovals from '@/locales/en/approvals.json';
import arApprovals from '@/locales/ar/approvals.json';
import enSync from '@/locales/en/sync.json';
import arSync from '@/locales/ar/sync.json';
import DashboardPage from './dashboard-page';
import { shiftDate } from './model';

registerNamespace('attendance', enAttendance, arAttendance);
registerNamespace('approvals', enApprovals, arApprovals);
registerNamespace('sync', enSync, arSync);

const today = todayIso('Asia/Muscat');
const summary: DashboardSummary = { date: today, employees: 512, presentToday: 431, absent: 44, late: 27, onLeave: 10, earlyDeparture: 6, overtimeMinutes: 1830, missingPunch: 9, devicesOnline: 18, devicesOffline: 1, devicesUnknown: 1, syncFailures24h: 2, pendingApprovals: 4 };
const trends = Array.from({ length: 8 }, (_, i) => {
  const date = shiftDate(today, i - 7);
  return { date, present: i === 0 ? 400 : i === 7 ? 431 : 420 + i, absent: 40, late: i === 0 ? 20 : 27, onLeave: 10, missingPunch: 5, overtimeMinutes: 100 };
});
const branches = [
  { branchId: 'b1', branchCode: 'MCT', branchName: 'Muscat HQ', employees: 300, present: 252, absent: 30, late: 10, onLeave: 8, missingPunch: 4, devicesOnline: 10, devicesOffline: 0 },
  { branchId: 'b2', branchCode: 'SOH', branchName: 'Sohar Plant', employees: 212, present: 179, absent: 14, late: 17, onLeave: 2, missingPunch: 5, devicesOnline: 8, devicesOffline: 2 },
];
const holiday = { id: 'h1', calendarId: 'c1', name: 'National Day', nameAr: 'العيد الوطني', date: shiftDate(today, 3), endDate: null, isHalfDay: false, type: 'public', branchIds: null, isTentative: false, createdAt: '2026-01-01T00:00:00Z' };
const record = {
  id: 'r1', employeeId: 'e1', employeeNumber: '1001', employeeName: 'Salim Al Harthy', attendanceDate: today, branchId: 'b1', branchName: 'Muscat HQ', departmentId: null, shiftId: null, timezone: 'Asia/Muscat',
  expectedStartAt: null, expectedEndAt: null, scheduledMinutes: 480, firstInAt: `${today}T04:02:00.000Z`, lastOutAt: null, workedMinutes: 0, breakMinutes: 0, lateMinutes: 0, earlyDepartureMinutes: 0, overtimeMinutes: 0, overtimeCategory: null,
  status: 'PRESENT', flags: [], punchCount: 1, hasCorrection: false, calculationVersion: 1, computedAt: `${today}T04:05:00.000Z`, lockedAt: null,
};

function mockDashboard(overrides: Record<string, unknown> = {}) {
  mockGet({
    '/orgs/org-1/dashboard/summary': { data: summary },
    '/orgs/org-1/dashboard/trends': { data: trends },
    '/orgs/org-1/dashboard/branches': { data: branches },
    '/orgs/org-1/approvals/inbox': page([]),
    '/orgs/org-1/holidays': { data: [holiday] },
    '/orgs/org-1/attendance/daily': page([record]),
    '/orgs/org-1/sync/jobs': page([]),
    ...overrides,
  });
}

describe('DashboardPage', () => {
  beforeEach(() => { resetApiMock(); grantAll(); testState.settings = {}; mockDashboard(); });

  it('renders the overview layout: greeting, KPIs with last-week deltas, branches, holidays and today\'s punches', async () => {
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByRole('heading', { level: 1, name: /Good (morning|afternoon|evening), Dev!/ })).toBeInTheDocument();
    expect(await screen.findByText('431')).toBeInTheDocument();
    expect(screen.getByText('Present today')).toBeInTheDocument();
    expect(screen.getByText('84% of employees')).toBeInTheDocument();
    // 431 today against 400 on the same weekday last week
    expect(await screen.findByText('+31')).toBeInTheDocument();
    expect(screen.getAllByText('vs last week').length).toBeGreaterThan(0);
    // branches ranked by rate: Muscat 84%, Sohar 84% → both present with their codes
    expect(await screen.findByText('Muscat HQ')).toBeInTheDocument();
    expect(screen.getByText('252 / 300')).toBeInTheDocument();
    // the side rail
    expect(screen.getByText('Pending approvals')).toBeInTheDocument();
    expect(await screen.findByText('National Day')).toBeInTheDocument();
    expect(screen.getByText('In 3 days')).toBeInTheDocument();
    expect(await screen.findByText('Salim Al Harthy')).toBeInTheDocument();
    expect(screen.getByText(/Checked in · Muscat HQ/)).toBeInTheDocument();
    expect(screen.getByText('Quote of the day')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Explore reports/ })).toHaveAttribute('href', '/reports');
    // the trend query always reaches back at least eight days so "vs last week" has its comparison day
    const trendCall = apiMock.get.mock.calls.find((c) => c[0] === '/orgs/org-1/dashboard/trends');
    expect(trendCall?.[1]).toEqual({ from: shiftDate(today, -13), to: today });
  });

  it('lists employees who are clocked in and still working in the activity feed', async () => {
    // an open day stays PENDING until the punch window closes; the feed asks for those records as well as PRESENT ones
    const working = { ...record, id: 'r2', employeeId: 'e2', employeeNumber: '1002', employeeName: 'Maryam Al Siyabi', status: 'PENDING', firstInAt: `${today}T04:20:00.000Z` };
    mockDashboard({ '/orgs/org-1/attendance/daily': (q: Record<string, unknown> | undefined) => page(q?.status === 'PENDING' ? [working] : [record]) });
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText('Maryam Al Siyabi')).toBeInTheDocument();
    expect(await screen.findByText('Salim Al Harthy')).toBeInTheDocument();
    expect(screen.getAllByText(/Checked in · Muscat HQ/)).toHaveLength(2);
  });

  it('follows the tenant\'s layout and greeting choice from /me', async () => {
    testState.settings = { dashboard: { layout: 'executive', showGreeting: false, trendDays: 7 } };
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(await screen.findByText('Attendance rate')).toBeInTheDocument();
    expect(screen.getByText('431 / 512 of employees')).toBeInTheDocument();
    // the executive layout has no rail
    expect(screen.queryByText('Pending approvals')).not.toBeInTheDocument();
    expect(screen.queryByText('Quote of the day')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Range' })).toHaveTextContent('Last 7 days');
  });

  it('hides widgets the member may not see, and the highlight card links to attendance without report access', async () => {
    grant('dashboard.view', 'attendance.view');
    renderWithProviders(<DashboardPage />);
    await screen.findByText('431');
    expect(screen.queryByText('Pending approvals')).not.toBeInTheDocument();
    expect(screen.queryByText('Upcoming holidays')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Explore reports/ })).toHaveAttribute('href', '/attendance');
    expect(apiMock.get.mock.calls.some((c) => c[0] === '/orgs/org-1/approvals/inbox')).toBe(false);
    expect(apiMock.get.mock.calls.some((c) => c[0] === '/orgs/org-1/holidays')).toBe(false);
  });

  it('steps back a day and offers the way back to today', async () => {
    renderWithProviders(<DashboardPage />);
    await screen.findByText('431');
    expect(screen.queryByRole('button', { name: 'Today' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous day' }));
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/dashboard/summary', { date: shiftDate(today, -1) }));
    expect(screen.getByRole('button', { name: 'Next day' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next day' })).toBeDisabled());
  });

  it('shows the operations layout with device health and the sync feed', async () => {
    testState.settings = { dashboard: { layout: 'operations' } };
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText('Device status')).toBeInTheDocument();
    expect(await screen.findByText('2 not reporting')).toBeInTheDocument(); // one offline, one unknown
    expect(screen.getByText('Recent sync jobs')).toBeInTheDocument();
    expect(screen.getByText('Recent attendance')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sync now/ })).toBeInTheDocument();
    expect(screen.queryByText('Upcoming holidays')).toBeInTheDocument(); // the rail stays
  });
});
