import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, mockGet, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { Sidebar } from '@/components/layout/sidebar';
import { portalRoutes } from './routes';
import MyRequestsPage from './pages/requests-page';

const EMP = '11111111-1111-4111-8111-111111111111';
// The keys of two system roles (reference data + 20260927000100 + 20260928000100 + 20261007000100), both linked to an employee record.
// HR User reads attendance organisation-wide but holds neither attendance.view_own nor attendance.checkin / attendance.note.
const HR_USER = ['dashboard.view', 'employee.view', 'employee.view_team', 'attendance.view', 'attendance.correct', 'attendance.request_correction', 'attendance.review_notes',
  'leave.view', 'leave.manage', 'leave.request', 'leave.approve', 'shift.view', 'shift.assign', 'holiday.view', 'report.view', 'report.export'] as const;
const EMPLOYEE = ['attendance.view_own', 'attendance.checkin', 'attendance.note', 'attendance.request_correction', 'holiday.view', 'leave.request', 'shift.request_swap', 'shift.request_change'] as const;

const element = (path: string) => portalRoutes.find((r) => r.path === path)!.element;
const myLinks = () => screen.queryAllByRole('link').map((a) => a.getAttribute('href')).filter((h): h is string => !!h && h.startsWith('/my'));

beforeEach(() => { resetApiMock(); testState.orgId = 'org-1'; testState.employeeId = EMP; testState.teamSize = 0; testState.disabledModules = new Set(); });

describe('self-service portal — a role sees only the pages its keys open', () => {
  it('offers an HR user the pages their keys read, without My reports or Check in / out', () => {
    grant(...HR_USER);
    renderWithProviders(<Sidebar />);
    expect(myLinks()).toEqual(['/my', '/my/attendance', '/my/leave', '/my/profile', '/my/requests', '/my/shift']);
  });

  it('offers an employee every self-service page', () => {
    grant(...EMPLOYEE);
    renderWithProviders(<Sidebar />);
    expect(myLinks()).toEqual(['/my', '/my/attendance', '/my/leave', '/my/profile', '/my/checkin', '/my/requests', '/my/shift', '/my/reports']);
  });

  it('keeps only the overview and the profile for a role without any self-service key', () => {
    grant();
    renderWithProviders(<Sidebar />);
    expect(myLinks()).toEqual(['/my', '/my/profile']);
  });

  it('answers HR opening My reports with "permission denied" instead of the API\'s refusal, and asks the API nothing', () => {
    grant(...HR_USER);
    renderWithProviders(element('my/reports'), { route: '/my/reports' });
    expect(screen.getByText('Permission denied')).toBeInTheDocument();
    expect(screen.getByText('You do not have permission to view this page.')).toBeInTheDocument();
    expect(screen.queryByText(/Missing permission|request id|try again/i)).toBeNull();
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it.each([
    ['my/attendance', 'attendance.view_own'],
    ['my/leave', 'leave.request'],
    ['my/checkin', 'attendance.checkin'],
    ['my/requests', 'attendance.note'],
    ['my/shift', 'shift.request_swap'],
    ['my/reports', 'attendance.view_own'],
  ] as const)('denies %s without its key and opens it with %s', (path, key) => {
    grant();
    const denied = renderWithProviders(element(path), { route: `/${path}` });
    expect(screen.getByText('Permission denied')).toBeInTheDocument();
    denied.unmount();
    grant(key);
    renderWithProviders(element(path), { route: `/${path}` });
    expect(screen.queryByText('Permission denied')).toBeNull();
  });

  it('keeps the overview and the profile open to every linked member', () => {
    grant();
    for (const path of ['my', 'my/profile']) {
      const r = renderWithProviders(element(path), { route: `/${path}` });
      expect(screen.queryByText('Permission denied')).toBeNull();
      r.unmount();
    }
  });
});

describe('My requests — only the tabs and actions the role can use', () => {
  it('shows an HR user the regularisations and swaps they may read, never asking for the reasons or selfies their keys do not open', async () => {
    grant(...HR_USER);
    mockGet({ '/orgs/org-1/me/regularisations': { data: [] }, '/orgs/org-1/me/shift-swaps': { data: [] } });
    renderWithProviders(<MyRequestsPage />, { route: '/my/requests?tab=reasons' });
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual(['Regularisations', 'Shift swaps']);
    // a link to a tab the role does not have opens the first one it has
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/me/regularisations'));
    expect(apiMock.get.mock.calls.map((c) => c[0])).not.toContain('/orgs/org-1/me/attendance/notes');
    expect(apiMock.get.mock.calls.map((c) => c[0])).not.toContain('/orgs/org-1/me/selfie-checkins');
    // giving a reason needs attendance.note; requesting a regularisation is open to attendance.request_correction
    expect(screen.queryByRole('button', { name: /Add a reason/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Request regularisation/ })).toBeInTheDocument();
  });

  it('shows an employee every tab and both actions', () => {
    grant(...EMPLOYEE);
    mockGet({ '/orgs/org-1/me/attendance/notes': { data: [] } });
    renderWithProviders(<MyRequestsPage />, { route: '/my/requests' });
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Reasons', 'Regularisations', 'Shift swaps', 'Selfie check-ins']);
    expect(screen.getByRole('button', { name: /Add a reason/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Request regularisation/ })).toBeInTheDocument();
  });
});
