import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type { EmployeeDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/team.json';
import ar from '@/locales/ar/team.json';
import { apiMock, grant, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import TeamPage from './team-page';

registerNamespace('team', en, ar);

const report = (id: string, name: string, managerEmployeeId: string | null, secondaryManagerEmployeeId: string | null): EmployeeDto => ({
  id, organizationId: 'org-1', employeeNumber: id.toUpperCase(), firstName: name, middleName: null, lastName: 'X', displayName: name, displayNameAr: null, photoPath: null, photoUrl: null, gender: 'unspecified', dateOfBirth: null, nationalityCode: null,
  email: null, phone: null, joiningDate: '2024-02-01', exitDate: null, employmentStatus: 'active', employmentType: 'full_time', branchId: 'b1', branchName: 'Muscat', departmentId: null, departmentName: 'IT', designationId: null, designationName: 'Engineer',
  managerEmployeeId, managerName: null, secondaryManagerEmployeeId, secondaryManagerName: null, userId: null, deviceUserId: '1', cardNumber: null, fingerprintEnrolled: false, faceEnrolled: false, weeklyOffDays: null, customFields: {},
  deviceSyncSummary: { total: 0, inSync: 0, pending: 0, failed: 0, offline: 0 }, deletedAt: null, createdAt: '2024-02-01T00:00:00Z', updatedAt: '2024-02-01T00:00:00Z',
} as EmployeeDto);

describe('TeamPage', () => {
  beforeEach(() => {
    resetApiMock();
    testState.orgId = 'org-1';
    testState.employeeId = 'e4';
    testState.teamSize = 2;
  });

  it('lists the direct reports for a line manager holding employee.view_team (without the organisation-wide employee.view)', async () => {
    grant('employee.view_team');
    mockGet({ '/orgs/org-1/employees': page([report('e5', 'Salma', 'e4', null), report('e6', 'Yousuf', null, 'e4')]) });
    renderWithProviders(<TeamPage />, { route: '/team' });
    expect(await screen.findByRole('link', { name: 'Salma' })).toHaveAttribute('href', '/employees/e5');
    expect(screen.getByRole('link', { name: 'Yousuf' })).toBeInTheDocument();
    expect(screen.getByText('Secondary manager')).toBeInTheDocument();
    expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/employees', expect.objectContaining({ teamOf: 'e4' }));
  });

  it('shows the team size and the hint — and never asks for the list — when the role holds no directory key', async () => {
    grant('dashboard.view');
    renderWithProviders(<TeamPage />, { route: '/team' });
    expect(await screen.findByText(/employee\.view_team permission/)).toBeInTheDocument();
    expect(screen.getByText('2 direct reports')).toBeInTheDocument();
    expect(apiMock.get).not.toHaveBeenCalledWith('/orgs/org-1/employees', expect.anything());
  });
});
