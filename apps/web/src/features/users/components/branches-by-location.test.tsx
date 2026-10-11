import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { MemberDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { BRANCHES, BRANCH_1, BRANCH_2, BRANCH_3, SIMPLE_LEVELS, SIMPLE_NODES, locationRoutes } from '@/features/employees/location-test-fixtures';
import { MemberDialog } from './member-dialog';
import { InviteDialog } from './invite-dialog';

/**
 * Member branch scope "by location" (docs/locations.md §2): a region (or a branch) adds every branch under it to the explicit
 * branch list; branches placed under the region later are not added, which the dialog says.
 */
const role = { id: '10000000-0000-0000-0000-000000000004', organizationId: null, key: 'hr_user', name: 'HR user', description: null, isSystem: true, permissions: [], memberCount: 1, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' };
const member = (over: Partial<MemberDto> = {}): MemberDto => ({
  id: 'mem-2', organizationId: 'org-1', userId: 'u2', email: 'salma@acme.om', fullName: 'Salma', avatarPath: null, roleId: role.id, roleKey: 'hr_user', roleName: 'HR user',
  status: 'active', allBranches: false, branchIds: [BRANCH_3], branchNames: ['Branch 3'], employeeId: null, employeeNumber: null, lastLoginAt: null, joinedAt: null, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z', ...over,
});
const routes = (extra: Record<string, unknown> = {}) => ({ '/orgs/org-1/roles': { data: [role] }, '/orgs/org-1/branches': page(BRANCHES), '/orgs/org-1/employees': page([]), ...locationRoutes(), ...extra });

/** Open a combobox and pick an option of its list by its label. */
async function pick(combobox: HTMLElement, label: string) {
  fireEvent.click(combobox);
  const option = await within(await screen.findByRole('listbox')).findByText(label);
  fireEvent.click(option.closest('[cmdk-item]') ?? option);
}
const byLocation = () => screen.getByRole('combobox', { name: 'Add branches by location' });
const checkbox = (name: string) => screen.getByRole('checkbox', { name });

describe('branch scope by location', () => {
  beforeEach(() => { resetApiMock(); grantAll(); });
  afterEach(() => { testState.allBranches = true; testState.branchIds = []; });

  it('member dialog: a region adds every branch under it to the explicit list, and says later branches are not included', async () => {
    mockGet(routes());
    apiMock.patch.mockResolvedValue({ data: member() });
    renderWithProviders(<MemberDialog member={member()} onClose={() => {}} />);
    await screen.findByRole('dialog');
    await waitFor(() => expect(byLocation()).toBeInTheDocument());
    expect(screen.getByText(/Branches added to it later are not included automatically/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add branches/ })).toBeDisabled();

    // only regions and branches are offered (no sites or floors)
    fireEvent.click(byLocation());
    const options = within(await screen.findByRole('listbox'));
    expect(await options.findByText('Muscat HQ')).toBeInTheDocument();
    expect(options.getByText('Branch 1')).toBeInTheDocument();
    expect(options.queryByText('Site A')).not.toBeInTheDocument();
    fireEvent.click(options.getByText('Muscat HQ').closest('[cmdk-item]')!);

    const add = await screen.findByRole('button', { name: /Add 2 branches/ });
    fireEvent.click(add);
    await waitFor(() => expect(checkbox('Branch 1')).toBeChecked());
    expect(checkbox('Branch 2')).toBeChecked();
    expect(checkbox('Branch 3')).toBeChecked(); // kept
    expect(screen.getByRole('button', { name: /Add branches/ })).toBeDisabled(); // the picker starts over

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    expect(apiMock.patch.mock.calls[0]![1]).toMatchObject({ allBranches: false, branchIds: [BRANCH_3, BRANCH_1, BRANCH_2] });
  });

  it('adds only what is not chosen yet, and a branch node adds that branch alone', async () => {
    mockGet(routes());
    renderWithProviders(<MemberDialog member={member({ branchIds: [BRANCH_1, BRANCH_2] })} onClose={() => {}} />);
    await waitFor(() => expect(byLocation()).toBeInTheDocument());
    await pick(byLocation(), 'Muscat HQ');
    expect(await screen.findByRole('button', { name: /Add 0 branches/ })).toBeDisabled();
    await pick(byLocation(), 'Branch 3');
    fireEvent.click(await screen.findByRole('button', { name: /Add 1 branch$/ }));
    await waitFor(() => expect(checkbox('Branch 3')).toBeChecked());
  });

  it('a branch-scoped administrator only adds the branches they may give (the ones the dialog lists)', async () => {
    testState.allBranches = false; testState.branchIds = [BRANCH_1];
    // RLS lists their branches only; the region itself stays visible in the tree
    mockGet(routes({ '/orgs/org-1/branches': page([BRANCHES[0]!]) }));
    renderWithProviders(<MemberDialog member={member({ branchIds: [] })} onClose={() => {}} />);
    await waitFor(() => expect(byLocation()).toBeInTheDocument());
    await pick(byLocation(), 'Muscat HQ');
    fireEvent.click(await screen.findByRole('button', { name: /Add 1 branch$/ }));
    await waitFor(() => expect(checkbox('Branch 1')).toBeChecked());
    expect(screen.queryByRole('checkbox', { name: 'Branch 2' })).not.toBeInTheDocument();
  });

  it('invite dialog: a region fills the branch scope of the invitation', async () => {
    mockGet(routes());
    apiMock.post.mockResolvedValue({ data: { id: 'inv1', organizationId: 'org-1', email: 'new@acme.om', roleId: role.id, allBranches: false, branchIds: [BRANCH_3], invitedBy: 'u1', expiresAt: '2030-01-08T10:00:00Z', acceptedAt: null, createdAt: '2030-01-01T10:00:00Z', token: 'org-1.t' } });
    renderWithProviders(<InviteDialog open onOpenChange={() => {}} />);
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'new@acme.om' } });
    fireEvent.keyDown(screen.getByRole('combobox', { name: /Role/ }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: /HR user/ }));
    fireEvent.click(screen.getByRole('switch', { name: /All branches/ }));
    await waitFor(() => expect(byLocation()).toBeInTheDocument());
    await pick(byLocation(), 'Southern Region');
    fireEvent.click(await screen.findByRole('button', { name: /Add 1 branch$/ }));
    await waitFor(() => expect(checkbox('Branch 3')).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/invitations', expect.objectContaining({ allBranches: false, branchIds: [BRANCH_3] })));
  });

  it('is not offered without group levels above the branches', async () => {
    mockGet(routes(locationRoutes(SIMPLE_LEVELS, SIMPLE_NODES)));
    renderWithProviders(<MemberDialog member={member()} onClose={() => {}} />);
    await screen.findByRole('checkbox', { name: 'Branch 3' });
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/location-levels'));
    expect(screen.queryByTestId('branches-by-location')).not.toBeInTheDocument();
  });
});

