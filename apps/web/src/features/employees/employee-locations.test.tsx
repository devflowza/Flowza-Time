import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { EmployeeDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock } from './test-utils';
import { BRANCHES, BRANCH_1, BRANCH_2, GROUP_LEVELS, GROUP_NODES, LOC, SIMPLE_LEVELS, SIMPLE_NODES, locationRoutes } from './location-test-fixtures';
import type { EmployeeDetail } from './api';
import EmployeeNewPage from './pages/employee-new-page';
import EmployeesListPage from './pages/employees-list-page';
import EmployeeProfilePage from './pages/employee-profile-page';
import { OverviewTab } from './components/profile/overview-tab';

/** Where an employee works inside the branch (docs/locations.md §2): a place of the branch on the form, the list and the profile. */

const employee = (over: Partial<EmployeeDetail> = {}): EmployeeDetail => ({
  id: 'e0000000-0000-4000-8000-000000000005', organizationId: 'org-1', employeeNumber: 'E5', firstName: 'Salma', middleName: null, lastName: 'Said', displayName: 'Salma Said', displayNameAr: null,
  photoPath: null, photoUrl: null, gender: 'female', dateOfBirth: null, nationalityCode: null, email: null, phone: null, joiningDate: '2024-02-01', exitDate: null, employmentStatus: 'active',
  employmentType: 'full_time', branchId: BRANCH_1, branchName: 'Branch 1', workLocationId: LOC.floor2, workLocationName: 'Site A › Floor 2', departmentId: null, departmentName: null,
  designationId: null, designationName: null, managerEmployeeId: null, managerName: null, secondaryManagerEmployeeId: null, secondaryManagerName: null, userId: null, deviceUserId: '5', cardNumber: null,
  fingerprintEnrolled: false, faceEnrolled: false, weeklyOffDays: null, customFields: {}, deviceSyncSummary: { total: 0, inSync: 0, pending: 0, failed: 0, offline: 0 }, deletedAt: null,
  createdAt: '2024-02-01T00:00:00Z', updatedAt: '2024-02-01T00:00:00Z', currentHistory: null, ...over,
});

/** Open a combobox and pick an option of its list by its label. */
async function pick(combobox: HTMLElement, label: string) {
  fireEvent.click(combobox);
  const option = await within(await screen.findByRole('listbox')).findByText(label);
  fireEvent.click(option.closest('[cmdk-item]') ?? option);
}
const branchBox = () => screen.getByRole('combobox', { name: /^Branch/ });
const workLocationBox = () => screen.getByRole('combobox', { name: /^Work location/ });
const formRoutes = (levels = locationRoutes()) => ({ '/orgs/org-1/branches': page(BRANCHES), ...levels, '/orgs/org-1/departments': page([]), '/orgs/org-1/designations': page([]), '/orgs/org-1/employees': page([]) });

describe('employee work location', () => {
  beforeEach(() => { resetApiMock(); grantAll(); });

  it('offers the places of the chosen branch, clears the choice when the branch changes and creates the employee with it', async () => {
    mockGet(formRoutes());
    apiMock.post.mockResolvedValue({ data: employee({ id: 'e9' }) });
    renderWithProviders(<EmployeeNewPage />, { route: '/employees/new', path: '/employees/new' });
    fireEvent.change(await screen.findByLabelText(/^Employee number/), { target: { value: 'E9' } });
    fireEvent.change(screen.getByLabelText(/^First name/), { target: { value: 'Salma' } });
    fireEvent.change(screen.getByLabelText(/^Last name/), { target: { value: 'Said' } });

    expect(await screen.findByText('Where the employee works inside the branch: a site, floor or zone.')).toBeInTheDocument();
    await pick(branchBox(), 'Branch 1');
    await waitFor(() => expect(branchBox()).toHaveTextContent('Branch 1'));
    fireEvent.click(workLocationBox());
    const places = within(await screen.findByRole('listbox'));
    expect(await places.findByText('Site A')).toBeInTheDocument();
    expect(places.queryByText('Site X')).not.toBeInTheDocument(); // Branch 2's
    fireEvent.click(places.getByText('Floor 2').closest('[cmdk-item]')!);
    await waitFor(() => expect(workLocationBox()).toHaveTextContent('Floor 2'));
    // the hint names the whole path below the branch
    expect(screen.getByText('Site A › Floor 2')).toBeInTheDocument();

    await pick(branchBox(), 'Branch 2');
    await waitFor(() => expect(branchBox()).toHaveTextContent('Branch 2'));
    expect(workLocationBox()).toHaveTextContent('No specific place');
    await pick(workLocationBox(), 'Site X');
    await waitFor(() => expect(workLocationBox()).toHaveTextContent('Site X'));

    fireEvent.click(screen.getByRole('button', { name: 'Create employee' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [path, body] = apiMock.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/orgs/org-1/employees');
    expect(body).toMatchObject({ employeeNumber: 'E9', branchId: BRANCH_2, workLocationId: LOC.siteX });
  });

  it('shows no work location to an organisation without place levels and sends none', async () => {
    mockGet(formRoutes(locationRoutes(SIMPLE_LEVELS, SIMPLE_NODES)));
    apiMock.post.mockResolvedValue({ data: employee({ id: 'e9' }) });
    renderWithProviders(<EmployeeNewPage />, { route: '/employees/new', path: '/employees/new' });
    fireEvent.change(await screen.findByLabelText(/^Employee number/), { target: { value: 'E9' } });
    fireEvent.change(screen.getByLabelText(/^First name/), { target: { value: 'Salma' } });
    fireEvent.change(screen.getByLabelText(/^Last name/), { target: { value: 'Said' } });
    await pick(branchBox(), 'Branch 1');
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/location-levels'));
    expect(screen.queryByRole('combobox', { name: /^Work location/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create employee' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect((apiMock.post.mock.calls[0] as [string, Record<string, unknown>])[1]).not.toHaveProperty('workLocationId');
  });

  it('edit: shows the saved place with its path, and clearing it sends workLocationId: null without an effective date', async () => {
    mockGet(formRoutes());
    apiMock.patch.mockResolvedValue({ data: employee({ workLocationId: null, workLocationName: null }) });
    renderWithProviders(<OverviewTab employee={employee()} />);
    await waitFor(() => expect(workLocationBox()).toHaveTextContent('Floor 2'));
    expect(screen.getByText('Site A › Floor 2')).toBeInTheDocument();
    fireEvent.click(within(workLocationBox()).getByLabelText('Clear'));
    await waitFor(() => expect(workLocationBox()).toHaveTextContent('No specific place'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    expect(apiMock.patch.mock.calls[0]).toEqual([`/orgs/org-1/employees/${employee().id}`, { workLocationId: null }]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('names the work location in the profile header', async () => {
    mockGet({ [`/orgs/org-1/employees/${employee().id}`]: { data: employee() }, ...locationRoutes() });
    renderWithProviders(<EmployeeProfilePage />, { route: `/employees/${employee().id}`, path: '/employees/:id' });
    expect(await screen.findByRole('heading', { name: 'Salma Said' })).toBeInTheDocument();
    expect(screen.getByText('E5 · Branch 1 › Site A › Floor 2')).toBeInTheDocument();
  });
});

describe('employee list by location', () => {
  beforeEach(() => { resetApiMock(); grantAll(); });

  const rows: EmployeeDto[] = [employee(), employee({ id: 'e0000000-0000-4000-8000-000000000006', employeeNumber: 'E6', displayName: 'Ali Harthy', workLocationId: null, workLocationName: null })];

  it('shows the work location and filters by a location (paging restarts)', async () => {
    mockGet({ '/orgs/org-1/employees': page(rows, 80), '/orgs/org-1/branches': page(BRANCHES), '/orgs/org-1/departments': page([]), ...locationRoutes() });
    renderWithProviders(<EmployeesListPage />, { route: '/employees?page=2' });
    expect((await screen.findAllByText('Salma Said')).length).toBeGreaterThan(0);
    expect(await screen.findByRole('columnheader', { name: 'Work location' })).toBeInTheDocument();
    expect(screen.getAllByText('Site A › Floor 2').length).toBeGreaterThan(0);
    // the card fallback carries it after the branch
    expect(screen.getByText('E5 · Branch 1 › Site A › Floor 2')).toBeInTheDocument();

    await pick(screen.getByRole('combobox', { name: 'Filter by location' }), 'Site A');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`locationId=${LOC.siteA}`));
    expect(screen.getByTestId('location')).toHaveTextContent('page=1');
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/employees', expect.objectContaining({ locationId: LOC.siteA, page: 1 })));
  });

  it('keeps the list unchanged without a hierarchy', async () => {
    mockGet({ '/orgs/org-1/employees': page(rows), '/orgs/org-1/branches': page(BRANCHES), '/orgs/org-1/departments': page([]), ...locationRoutes(SIMPLE_LEVELS, SIMPLE_NODES) });
    renderWithProviders(<EmployeesListPage />, { route: '/employees' });
    expect((await screen.findAllByText('Salma Said')).length).toBeGreaterThan(0);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/location-levels'));
    expect(screen.queryByRole('columnheader', { name: 'Work location' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Filter by location' })).not.toBeInTheDocument();
  });

  it('offers the filter but no place column to an organisation with regions only', async () => {
    mockGet({ '/orgs/org-1/employees': page(rows), '/orgs/org-1/branches': page(BRANCHES), '/orgs/org-1/departments': page([]), ...locationRoutes(GROUP_LEVELS, GROUP_NODES) });
    renderWithProviders(<EmployeesListPage />, { route: '/employees' });
    await pick(await screen.findByRole('combobox', { name: 'Filter by location' }), 'Muscat HQ');
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/employees', expect.objectContaining({ locationId: LOC.hq })));
    expect(screen.queryByRole('columnheader', { name: 'Work location' })).not.toBeInTheDocument();
  });
});

