import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { MemberDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { MemberDialog } from './member-dialog';
import { MembersTab } from './members-tab';

/**
 * THE member-management rule in the users screens (HR portal Prompt 5 review, P0-1 / P0-3): nobody is offered a change of
 * their own role, branch scope or status, and a branch-scoped administrator is never offered "all branches". The API refuses
 * all of it anyway; these tests pin that the screens do not offer what the API refuses.
 */
const B1 = 'b0000000-0000-4000-8000-000000000001';
const member = (over: Partial<MemberDto> = {}): MemberDto => ({
  id: 'mem-2', organizationId: 'org-1', userId: 'u2', email: 'salma@acme.om', fullName: 'Salma', avatarPath: null, roleId: '10000000-0000-0000-0000-000000000004', roleKey: 'hr_user', roleName: 'HR user',
  status: 'active', allBranches: false, branchIds: [B1], branchNames: ['Muscat'], employeeId: null, employeeNumber: null, lastLoginAt: null, joinedAt: null, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z', ...over,
});
const branch = { id: B1, organizationId: 'org-1', code: 'MCT', name: 'Muscat', nameAr: null, countryCode: 'OM', city: null, address: {}, timezone: 'Asia/Muscat', latitude: null, longitude: null, geofenceRadiusM: null, contact: {}, weeklyOffDays: null, holidayCalendarId: null, status: 'active', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' };
const role = { id: '10000000-0000-0000-0000-000000000004', organizationId: null, key: 'hr_user', name: 'HR user', description: null, isSystem: true, permissions: [], memberCount: 1, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' };

describe('MemberDialog / MembersTab — the member-management rule', () => {
  beforeEach(() => {
    resetApiMock(); grant('user.view', 'user.manage', 'employee.view');
    mockGet({ '/orgs/org-1/roles': { data: [role] }, '/orgs/org-1/branches': page([branch]), '/orgs/org-1/employees': page([]), '/orgs/org-1/members': page([member(), member({ id: 'mem-1', userId: 'u1', email: 'dev@flowza.ai', fullName: 'Dev', allBranches: true, branchIds: [], branchNames: [] })]) });
  });
  afterEach(() => { testState.roleKey = 'org_admin'; testState.allBranches = true; testState.branchIds = []; });

  it('5-P0-1 an owner editing their own membership may only change the employee link', async () => {
    testState.roleKey = 'owner';
    apiMock.patch.mockResolvedValue({ data: member({ id: 'mem-1' }) });
    renderWithProviders(<MemberDialog member={member({ id: 'mem-1', userId: 'u1', roleKey: 'owner', roleName: 'Owner', allBranches: true, branchIds: [] })} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('member-self-hint')).toHaveTextContent('your role, branches and status can only be changed by another owner');
    expect(within(dialog).getByRole('combobox', { name: /Role/ })).toBeDisabled();
    expect(within(dialog).getByRole('combobox', { name: /Status/ })).toBeDisabled();
    expect(within(dialog).getByRole('switch', { name: /All branches/ })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: /Save/ }));
    // only the link travels: the API accepts an owner's own link and refuses every other change of one's own membership
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/orgs/org-1/members/mem-1', { employeeId: null }));
  });

  it('5-P0-1 a branch-scoped administrator is never offered "all branches" for a member they scope', async () => {
    testState.allBranches = false; testState.branchIds = [B1];
    renderWithProviders(<MemberDialog member={member()} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    const all = within(dialog).getByRole('switch', { name: /All branches/ });
    expect(all).not.toBeChecked();
    expect(all).toBeDisabled();
    expect(dialog).toHaveTextContent('Your own access is limited to some branches');
    // another member's role and status stay editable for them
    expect(within(dialog).getByRole('combobox', { name: /Role/ })).toBeEnabled();
  });

  it('5-P0-1 the members list does not offer editing or suspending one\'s own membership (an owner may still link it)', async () => {
    renderWithProviders(<MembersTab />);
    const own = (await screen.findByText('dev@flowza.ai')).closest('tr')!;
    fireEvent.keyDown(within(own).getByRole('button', { name: /Actions/ }), { key: 'ArrowDown' });
    expect(await screen.findByRole('menuitem', { name: /Edit/ })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: /Suspend/ })).toHaveAttribute('data-disabled');
  });
});
