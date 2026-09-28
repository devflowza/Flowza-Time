import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { EmployeePortalAccessDto, InvitationDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { InvitationsTab } from './invitations-tab';
import { PortalAccessCard } from './portal-access-card';

const invitation = (over: Partial<InvitationDto> = {}): InvitationDto => ({
  id: 'inv-1', organizationId: 'org-1', email: 'salma@acme.om', roleId: '10000000-0000-0000-0000-000000000008', roleName: 'Employee', allBranches: false, branchIds: [], invitedBy: 'u1', invitedByName: 'Dev', employeeId: 'e5', employeeNumber: 'E005',
  expiresAt: '2099-10-05T00:00:00Z', acceptedAt: null, createdAt: '2026-09-28T06:00:00Z', deliverySentAt: '2026-09-28T06:01:00Z', ...over,
});
const access = (over: Partial<EmployeePortalAccessDto> = {}): EmployeePortalAccessDto => ({ employeeId: 'e5', state: 'none', membership: null, invitation: null, suggestedEmail: 'salma@acme.om', suggestedEmailSource: 'work', employeeLeft: false, ...over });
const membership = (status: 'active' | 'suspended') => ({ id: 'm5', userId: 'u5', email: 'salma@acme.om', fullName: 'Salma', roleId: 'r', roleName: 'Employee', status, lastLoginAt: null });

describe('Invitations list — resend (HR portal Prompt 6b, B-67/68)', () => {
  beforeEach(() => { resetApiMock(); grant('user.view', 'user.manage'); });

  it('resends an invitation — the old token dies, the new link is shown once — and shows when it was e-mailed', async () => {
    mockGet({ '/orgs/org-1/invitations': { data: [invitation()] }, '/orgs/org-1/branches': page([]) });
    apiMock.post.mockResolvedValue({ data: invitation({ id: 'inv-2', token: 'org-1.new-secret-token-value' }) });
    renderWithProviders(<InvitationsTab />);
    const row = await screen.findByTestId('invitation-row');
    expect(row).toHaveTextContent(/E-mailed/);
    fireEvent.click(within(row).getByRole('button', { name: /Resend/ }));
    const confirm = await screen.findByRole('dialog');
    expect(confirm).toHaveTextContent('Resend the invitation to salma@acme.om?');
    fireEvent.click(within(confirm).getByRole('button', { name: /Resend/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/invitations/inv-1/resend'));
    expect(await screen.findByDisplayValue(/\/auth\/invite\?token=org-1\.new-secret-token-value/)).toBeInTheDocument();
  });

  it('offers no resend or revoke to a user.view-only role', async () => {
    grant('user.view');
    mockGet({ '/orgs/org-1/invitations': { data: [invitation()] }, '/orgs/org-1/branches': page([]) });
    renderWithProviders(<InvitationsTab />);
    const row = await screen.findByTestId('invitation-row');
    expect(within(row).queryByRole('button', { name: /Resend/ })).not.toBeInTheDocument();
  });
});

describe('PortalAccessCard — FlowZa Time access on an employee profile (B-69 / B-70 / B-74)', () => {
  beforeEach(() => { resetApiMock(); grant('user.view', 'user.manage'); });

  it('invites with the work e-mail and the default role, then shows the link once', async () => {
    mockGet({ '/orgs/org-1/employees/e5/portal-access': { data: access() }, '/orgs/org-1/roles': { data: [] } });
    apiMock.post.mockResolvedValue({ data: { invitation: invitation({ token: 'org-1.fresh-secret-token' }), access: access({ state: 'invited' }) } });
    renderWithProviders(<PortalAccessCard employeeId="e5" employeeName="Salma" />);
    expect(await screen.findByTestId('portal-access-state')).toHaveTextContent('No access');
    fireEvent.click(screen.getByRole('button', { name: /Invite to FlowZa Time/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/Email/)).toHaveValue('salma@acme.om');
    expect(dialog).toHaveTextContent('From the work email');
    fireEvent.click(within(dialog).getByRole('button', { name: /Invite to FlowZa Time/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/employees/e5/portal-access/invite', { email: 'salma@acme.om' }));
    expect(await screen.findByDisplayValue(/token=org-1\.fresh-secret-token/)).toBeInTheDocument();
  });

  it('revokes an active login with a reason (the employee link stays) and restores a revoked one', async () => {
    mockGet({ '/orgs/org-1/employees/e5/portal-access': { data: access({ state: 'active', membership: membership('active') }) }, '/orgs/org-1/roles': { data: [] } });
    apiMock.post.mockResolvedValue({ data: access({ state: 'suspended', membership: membership('suspended') }) });
    const r = renderWithProviders(<PortalAccessCard employeeId="e5" employeeName="Salma" />);
    expect(await screen.findByTestId('portal-access-state')).toHaveTextContent('Active');
    expect(screen.getByText(/Never signed in/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Revoke access/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), { target: { value: 'Left on sabbatical' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Revoke access/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/employees/e5/portal-access/revoke', { reason: 'Left on sabbatical' }));
    r.unmount();
    resetApiMock();
    mockGet({ '/orgs/org-1/employees/e5/portal-access': { data: access({ state: 'suspended', membership: membership('suspended') }) }, '/orgs/org-1/roles': { data: [] } });
    apiMock.post.mockResolvedValue({ data: access({ state: 'active', membership: membership('active') }) });
    renderWithProviders(<PortalAccessCard employeeId="e5" employeeName="Salma" />);
    expect(await screen.findByTestId('portal-access-state')).toHaveTextContent('Access revoked');
    fireEvent.click(screen.getByRole('button', { name: /Restore access/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /Restore access/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/employees/e5/portal-access/restore', {}));
  });

  it('resends a pending invitation, and offers nothing for an employee who has left', async () => {
    mockGet({ '/orgs/org-1/employees/e5/portal-access': { data: access({ state: 'invited', invitation: { id: 'inv-1', email: 'salma@acme.om', roleId: 'r', roleName: 'Employee', expiresAt: '2099-10-05T00:00:00Z', createdAt: '2026-09-28T06:00:00Z', expired: false } }) }, '/orgs/org-1/roles': { data: [] } });
    apiMock.post.mockResolvedValue({ data: { action: 'reinvited', invitation: invitation({ token: 'org-1.again-secret' }), access: access({ state: 'invited' }) } });
    const r = renderWithProviders(<PortalAccessCard employeeId="e5" employeeName="Salma" />);
    fireEvent.click(await screen.findByRole('button', { name: /Resend invitation/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/employees/e5/portal-access/resend'));
    r.unmount();
    resetApiMock();
    mockGet({ '/orgs/org-1/employees/e5/portal-access': { data: access({ state: 'suspended', membership: membership('suspended'), employeeLeft: true }) }, '/orgs/org-1/roles': { data: [] } });
    renderWithProviders(<PortalAccessCard employeeId="e5" employeeName="Salma" />);
    expect(await screen.findByText('The employee has left: access cannot be granted or restored.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restore access/ })).not.toBeInTheDocument();
  });

  it('is not rendered — and not requested — without user.view', () => {
    grant('employee.view');
    const { container } = renderWithProviders(<PortalAccessCard employeeId="e5" employeeName="Salma" />);
    expect(container.querySelector('[data-testid="portal-access-card"]')).toBeNull();
    expect(apiMock.get).not.toHaveBeenCalled();
  });
});
