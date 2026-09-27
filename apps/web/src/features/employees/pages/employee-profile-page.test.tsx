import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type { EmployeeDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { RequirePermission } from '@/components/layout/protected-route';
import { grant, grantAll, mockGet, renderWithProviders, resetApiMock, testState } from '../test-utils';
import EmployeeProfilePage from './employee-profile-page';

const employee = (id: string, name: string, managerEmployeeId: string | null): EmployeeDto & { currentHistory: null } => ({
  id, organizationId: 'org-1', employeeNumber: id.toUpperCase(), firstName: name, middleName: null, lastName: 'X', displayName: name, displayNameAr: null, photoPath: null, photoUrl: null, gender: 'unspecified', dateOfBirth: null, nationalityCode: null,
  email: null, phone: null, joiningDate: '2024-02-01', exitDate: null, employmentStatus: 'active', employmentType: 'full_time', branchId: 'b1', branchName: 'Muscat', departmentId: null, departmentName: null, designationId: null, designationName: null,
  managerEmployeeId, managerName: managerEmployeeId ? 'Mansoor' : null, secondaryManagerEmployeeId: null, secondaryManagerName: null, userId: null, deviceUserId: '5', cardNumber: null, fingerprintEnrolled: false, faceEnrolled: false, weeklyOffDays: null, customFields: {},
  deviceSyncSummary: { total: 0, inSync: 0, pending: 0, failed: 0, offline: 0 }, deletedAt: null, createdAt: '2024-02-01T00:00:00Z', updatedAt: '2024-02-01T00:00:00Z', currentHistory: null,
} as EmployeeDto & { currentHistory: null });

const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent);
/** The profile route's guard, as features/employees/routes.tsx mounts it. */
const profileRoute = () => <RequirePermission permissions={['employee.view', 'employee.view_team']} any><EmployeeProfilePage /></RequirePermission>;

describe('EmployeeProfilePage for a line manager (employee.view_team)', () => {
  beforeEach(() => {
    resetApiMock();
    testState.orgId = 'org-1';
    testState.employeeId = 'e4';
    mockGet({ '/orgs/org-1/employees/e5': { data: employee('e5', 'Salma', 'e4') }, '/orgs/org-1/employees/e4': { data: employee('e4', 'Mansoor', null) } });
  });

  it('opens a direct report\'s profile with the team key alone, showing only what that key can read', async () => {
    grant('employee.view_team', 'attendance.view_own');
    renderWithProviders(profileRoute(), { route: '/employees/e5', path: '/employees/:id' });
    expect(await screen.findByRole('heading', { name: 'Salma' })).toBeInTheDocument();
    // history / devices / attendance of somebody else sit behind other keys (and attendance.view_own would show the
    // viewer's OWN month): hidden rather than empty or wrong
    expect(tabNames()).toEqual(['Overview']);
    // no directory to go back to: the breadcrumb leads to the team
    expect(screen.getByRole('link', { name: 'My team' })).toHaveAttribute('href', '/team');
  });

  it('shows the tabs RLS fills from the viewer\'s own rows on their own profile, and falls back to Overview for a hidden tab in the URL', async () => {
    grant('employee.view_team', 'attendance.view_own');
    renderWithProviders(profileRoute(), { route: '/employees/e4?tab=documents', path: '/employees/:id' });
    expect(await screen.findByRole('heading', { name: 'Mansoor' })).toBeInTheDocument();
    expect(tabNames()).toEqual(['Overview', 'Employment history', 'Devices', 'Attendance']);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps every tab for HR, and refuses the page to a member holding neither directory key', async () => {
    grantAll();
    const { unmount } = renderWithProviders(profileRoute(), { route: '/employees/e5', path: '/employees/:id' });
    await screen.findByRole('heading', { name: 'Salma' });
    expect(tabNames()).toEqual(['Overview', 'Employment history', 'Devices', 'Attendance', 'Activity', 'Documents', 'Danger zone']);
    expect(screen.getByRole('link', { name: 'Employees' })).toHaveAttribute('href', '/employees');
    unmount();
    grant('attendance.view_own');
    renderWithProviders(profileRoute(), { route: '/employees/e5', path: '/employees/:id' });
    expect(screen.getByText('You do not have permission to view this page.')).toBeInTheDocument();
  });
});
