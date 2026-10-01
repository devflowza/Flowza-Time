import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { EmployeeDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '../test-utils';
import EmployeesListPage from './employees-list-page';

const emp = (id: string, name: string, n: string): EmployeeDto => ({
  id, organizationId: 'org-1', employeeNumber: n, firstName: name, middleName: null, lastName: 'X', displayName: name, displayNameAr: null, photoPath: null, photoUrl: null, gender: 'unspecified', dateOfBirth: null, nationalityCode: null,
  email: `${name.toLowerCase()}@acme.om`, phone: null, joiningDate: '2024-02-01', exitDate: null, employmentStatus: 'active', employmentType: 'full_time', branchId: 'b1', branchName: 'Muscat', departmentId: null, departmentName: null, designationId: null, designationName: null,
  managerEmployeeId: null, managerName: null, userId: null, deviceUserId: n, cardNumber: null, fingerprintEnrolled: false, faceEnrolled: false, weeklyOffDays: null, customFields: {}, deviceSyncSummary: { total: 2, inSync: 1, pending: 0, failed: 1, offline: 0 }, deletedAt: null, createdAt: '2024-02-01T00:00:00Z', updatedAt: '2024-02-01T00:00:00Z',
});

describe('EmployeesListPage', () => {
  beforeEach(() => { resetApiMock(); grantAll(); });

  it('renders server rows, exposes bulk actions on selection and queues a device sync (202)', async () => {
    mockGet({ '/orgs/org-1/employees': page([emp('e1', 'Ali', '1001'), emp('e2', 'Sara', '1002')]), '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]) });
    apiMock.post.mockResolvedValue({ data: { jobId: 'job-9', status: 'QUEUED', message: 'ok' } });
    renderWithProviders(<EmployeesListPage />, { route: '/employees' });

    expect((await screen.findAllByText('Ali')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Sara').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1 in sync', { exact: false }).length).toBeGreaterThan(0);
    expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/employees', expect.objectContaining({ page: 1, pageSize: 25, sort: 'displayName' }));

    fireEvent.click(screen.getAllByLabelText('Select row')[0]!);
    fireEvent.click(screen.getAllByLabelText('Select row')[1]!);
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Sync to devices/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Queue sync' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/employees/bulk', { action: 'sync_devices', employeeIds: ['e1', 'e2'] }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
    await waitFor(() => expect(screen.queryByText('2 selected')).not.toBeInTheDocument());
  });

  it('shows the empty state with Add / Import when the organisation has no employees', async () => {
    mockGet({ '/orgs/org-1/employees': page([]), '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]) });
    renderWithProviders(<EmployeesListPage />, { route: '/employees' });
    expect(await screen.findByText('No employees yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Add employee/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Import from CSV/ })).toBeInTheDocument();
  });

  it('once the user limit is reached it says "Maximum users reached" and the employee cannot be added', async () => {
    mockGet({ '/orgs/org-1/employees': page([emp('e1', 'Ali', '1001')]), '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]),
      '/orgs/org-1/user-limit': { data: { used: 20, limit: 20, remaining: 0, reached: true, source: 'seats' } } });
    renderWithProviders(<EmployeesListPage />, { route: '/employees' });
    const banner = await screen.findByTestId('user-limit-banner');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveTextContent('Maximum users reached');
    expect(banner).toHaveTextContent('20 / 20 users');
    expect(within(banner).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20');
    expect(screen.getByRole('button', { name: /Add employee/ })).toBeDisabled();
    // importing stays open: an import may only update existing employees (the API refuses one that adds past the limit)
    expect(screen.getByRole('button', { name: /Import/ })).toBeEnabled();
  });

  it('warns when few users are left and keeps adding open; no banner without a limit', async () => {
    mockGet({ '/orgs/org-1/employees': page([emp('e1', 'Ali', '1001')]), '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]),
      '/orgs/org-1/user-limit': { data: { used: 18, limit: 20, remaining: 2, reached: false, source: 'seats' } } });
    const first = renderWithProviders(<EmployeesListPage />, { route: '/employees' });
    const banner = await screen.findByTestId('user-limit-banner');
    expect(banner).toHaveTextContent('2 users left');
    expect(banner).toHaveTextContent('18 / 20 users');
    expect(screen.getByRole('button', { name: /Add employee/ })).toBeEnabled();
    first.unmount();
    mockGet({ '/orgs/org-1/employees': page([emp('e1', 'Ali', '1001')]), '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]),
      '/orgs/org-1/user-limit': { data: { used: 300, limit: null, remaining: null, reached: false, source: null } } });
    renderWithProviders(<EmployeesListPage />, { route: '/employees' });
    await screen.findAllByText('Ali');
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/user-limit'));
    expect(screen.queryByTestId('user-limit-banner')).not.toBeInTheDocument();
  });

  it('debounces the search box into the URL (?search=) and passes it to the API', async () => {
    mockGet({ '/orgs/org-1/employees': page([emp('e1', 'Ali', '1001')]), '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]) });
    renderWithProviders(<EmployeesListPage />, { route: '/employees' });
    await screen.findAllByText('Ali');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'sar' } });
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('search=sar'), { timeout: 2000 });
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/employees', expect.objectContaining({ search: 'sar', page: 1 })));
  });
});
