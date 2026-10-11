import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { DashboardSummary } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { BRANCH_1, BRANCH_2, BRANCH_3, LOC, SIMPLE_LEVELS, SIMPLE_NODES, locationRoutes } from '@/features/employees/location-test-fixtures';
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

/** The dashboard for one location (docs/locations.md §2): the counts and the trend for it, the branch table under it. */

const today = todayIso('Asia/Muscat');
const summary: DashboardSummary = { date: today, employees: 120, presentToday: 100, absent: 10, late: 5, onLeave: 4, earlyDeparture: 1, overtimeMinutes: 60, missingPunch: 2, devicesOnline: 3, devicesOffline: 0, devicesUnknown: 0, syncFailures24h: 0, pendingApprovals: 0 };
const row = (branchId: string, branchName: string) => ({ branchId, branchCode: branchName.replace(/\W+/g, '').toUpperCase(), branchName, employees: 40, present: 30, absent: 5, late: 2, onLeave: 1, missingPunch: 1, devicesOnline: 1, devicesOffline: 0 });

function mockDashboard(levels = locationRoutes()) {
  mockGet({
    '/orgs/org-1/dashboard/summary': { data: summary },
    '/orgs/org-1/dashboard/trends': { data: [] },
    '/orgs/org-1/dashboard/branches': { data: [row(BRANCH_1, 'Branch 1'), row(BRANCH_2, 'Branch 2'), row(BRANCH_3, 'Branch 3')] },
    ...levels,
    '*': page([]),
  });
}

describe('DashboardPage — location filter', () => {
  beforeEach(() => { resetApiMock(); grantAll(); testState.settings = {}; });

  it('asks the summary and the trend for the chosen location and keeps the branches under it', async () => {
    mockDashboard();
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText('Branch 3')).toBeInTheDocument();
    const filter = await screen.findByRole('combobox', { name: 'Filter by location' });
    expect(filter).toHaveTextContent('All locations');

    fireEvent.click(filter);
    const option = await within(await screen.findByRole('listbox')).findByText('Muscat HQ');
    fireEvent.click(option.closest('[cmdk-item]')!);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/dashboard/summary', { date: today, locationId: LOC.hq }));
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/dashboard/trends', { from: shiftDate(today, -13), to: today, locationId: LOC.hq }));
    expect(screen.getByText("Here's what's happening at Muscat HQ today.")).toBeInTheDocument();
    // the branch table: Muscat HQ's branches only
    await waitFor(() => expect(screen.queryByText('Branch 3')).not.toBeInTheDocument());
    expect(screen.getByText('Branch 1')).toBeInTheDocument();
    expect(screen.getByText('Branch 2')).toBeInTheDocument();
  });

  it('offers no filter and asks for the whole scope without a hierarchy', async () => {
    mockDashboard(locationRoutes(SIMPLE_LEVELS, SIMPLE_NODES));
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText('Branch 3')).toBeInTheDocument();
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/location-levels'));
    expect(screen.queryByRole('combobox', { name: 'Filter by location' })).not.toBeInTheDocument();
    expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/dashboard/summary', { date: today });
    expect(apiMock.get.mock.calls.filter((c) => c[0] === '/orgs/org-1/dashboard/summary').every((c) => !('locationId' in (c[1] as object)))).toBe(true);
  });
});
