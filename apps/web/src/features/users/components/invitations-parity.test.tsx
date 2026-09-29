import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { EmployeePortalAccessDto, InvitationDto, PortalAccessAddressDto } from '@flowza/contracts';

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
const address = (over: Partial<PortalAccessAddressDto> = {}): PortalAccessAddressDto => ({ email: 'salma@acme.om', source: 'work', changedAt: null, changedByUserId: null, changedByName: null, recentlyChangedByOther: false, ...over });
const access = (over: Partial<EmployeePortalAccessDto> = {}): EmployeePortalAccessDto => ({ employeeId: 'e5', state: 'none', membership: null, invitation: null, addresses: [address()], employeeLeft: false, ...over });
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

  it('shows the e-mail delivery of each invitation and queues a failed e-mail again', async () => {
    mockGet({ '/orgs/org-1/invitations': { data: [
      invitation({ id: 'inv-f', email: 'failed@acme.om', deliverySentAt: null, deliveryStatus: 'failed', deliveryAttempts: 5, deliveryLastError: 'email send failed: The acme.om domain is not verified' }),
      invitation({ id: 'inv-r', email: 'retry@acme.om', deliverySentAt: null, deliveryStatus: 'retrying', deliveryAttempts: 2, deliveryNextAttemptAt: '2099-10-05T00:00:00Z' }),
      invitation({ id: 'inv-q', email: 'queued@acme.om', deliverySentAt: null, deliveryStatus: 'queued', deliveryAttempts: 0 }),
      invitation({ id: 'inv-c', email: 'console@acme.om', deliveryStatus: 'sent', deliveryProvider: 'console' }),
    ] }, '/orgs/org-1/branches': page([]) });
    apiMock.post.mockResolvedValue({ data: { jobId: '42', status: 'QUEUED', invitation: invitation({ id: 'inv-f', deliveryStatus: 'queued' }) } });
    renderWithProviders(<InvitationsTab />);
    const rows = await screen.findAllByTestId('invitation-row');
    const [failed, retrying, queued, console] = rows as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    expect(within(failed).getByTestId('invitation-delivery')).toHaveAttribute('data-status', 'failed');
    expect(failed).toHaveTextContent('E-mail failed');
    expect(failed).toHaveTextContent('The acme.om domain is not verified');
    expect(retrying).toHaveTextContent('Attempt 2 of 5 failed — retrying');
    expect(within(retrying).queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
    expect(queued).toHaveTextContent('Sending…');
    expect(console).toHaveTextContent('Not delivered');
    fireEvent.click(within(failed).getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/invitations/inv-f/send-email'));
  });

  it('offers no resend or revoke to a user.view-only role', async () => {
    grant('user.view');
    mockGet({ '/orgs/org-1/invitations': { data: [invitation({ deliveryStatus: 'failed', deliverySentAt: null })] }, '/orgs/org-1/branches': page([]) });
    renderWithProviders(<InvitationsTab />);
    const row = await screen.findByTestId('invitation-row');
    expect(within(row).queryByRole('button', { name: /Resend/ })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
  });
});

describe('PortalAccessCard — FlowZa Time access on an employee profile (B-69 / B-70 / B-74)', () => {
  beforeEach(() => { resetApiMock(); grant('user.view', 'user.manage'); });

  it('invites the address the administrator picked, with the default role, then shows the link once', async () => {
    mockGet({ '/orgs/org-1/employees/e5/portal-access': { data: access() }, '/orgs/org-1/roles': { data: [] } });
    apiMock.post.mockResolvedValue({ data: { invitation: invitation({ token: 'org-1.fresh-secret-token' }), access: access({ state: 'invited' }) } });
    renderWithProviders(<PortalAccessCard employeeId="e5" employeeName="Salma" />);
    expect(await screen.findByTestId('portal-access-state')).toHaveTextContent('No access');
    fireEvent.click(screen.getByRole('button', { name: /Invite to FlowZa Time/ }));
    const dialog = await screen.findByRole('dialog');
    // offered, never pre-selected
    const radio = within(dialog).getByRole('radio', { name: /salma@acme\.om/ });
    expect(radio).not.toBeChecked();
    expect(within(dialog).getByRole('button', { name: /Invite to FlowZa Time/ })).toBeDisabled();
    expect(dialog).toHaveTextContent('Work email field · no change recorded');
    fireEvent.click(radio);
    fireEvent.click(within(dialog).getByRole('button', { name: /Invite to FlowZa Time/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/employees/e5/portal-access/invite', { email: 'salma@acme.om' }));
    expect(await screen.findByDisplayValue(/token=org-1\.fresh-secret-token/)).toBeInTheDocument();
  });

  it('5-P0-2 a portal invitation never goes to an address the admin did not choose; a recent change by someone else is flagged', async () => {
    const recent = new Date(Date.now() - 2 * 3_600_000).toISOString();
    mockGet({
      '/orgs/org-1/employees/e5/portal-access': { data: access({ addresses: [
        address({ changedAt: '2025-01-10T06:00:00Z', changedByUserId: 'u-hr', changedByName: 'Huda HR' }),
        address({ email: 'attacker@evil.test', source: 'personal', changedAt: recent, changedByUserId: 'u-x', changedByName: 'Rashid Clerk', recentlyChangedByOther: true }),
      ] }) },
      '/orgs/org-1/roles': { data: [] },
    });
    apiMock.post.mockResolvedValue({ data: { invitation: invitation({ email: 'attacker@evil.test', token: 'org-1.t' }), access: access({ state: 'invited' }) } });
    renderWithProviders(<PortalAccessCard employeeId="e5" employeeName="Salma" />);
    fireEvent.click(await screen.findByRole('button', { name: /Invite to FlowZa Time/ }));
    const dialog = await screen.findByRole('dialog');
    const options = within(dialog).getAllByTestId('access-address');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent(/Work email field · last changed by Huda HR on/);
    expect(options[1]).toHaveTextContent(/Personal email field · last changed by Rashid Clerk on/);
    // the warning is on the changed address, before anything is chosen; nothing is chosen for the administrator
    expect(within(options[1]!).getByTestId('access-address-warning')).toHaveTextContent('Changed in the last 7 days by someone else');
    expect(within(options[0]!).queryByTestId('access-address-warning')).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole('radio').filter((r) => (r as HTMLInputElement).checked)).toHaveLength(0);
    expect(within(dialog).getByRole('button', { name: /Invite to FlowZa Time/ })).toBeDisabled();
    // choosing it knowingly: the warning repeats as an alert naming who changed it
    fireEvent.click(within(dialog).getByRole('radio', { name: /attacker@evil\.test/ }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Rashid Clerk changed this address recently. Only invite attacker@evil.test if the employee confirmed it is theirs');
    fireEvent.click(within(dialog).getByRole('button', { name: /Invite to FlowZa Time/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/employees/e5/portal-access/invite', { email: 'attacker@evil.test' }));
  });

  it('5-P0-2 another address can be typed in; with none on the record it is the only choice', async () => {
    mockGet({ '/orgs/org-1/employees/e5/portal-access': { data: access({ addresses: [] }) }, '/orgs/org-1/roles': { data: [] } });
    apiMock.post.mockResolvedValue({ data: { invitation: invitation({ email: 'typed@acme.om', token: 'org-1.t' }), access: access({ state: 'invited' }) } });
    renderWithProviders(<PortalAccessCard employeeId="e5" employeeName="Salma" />);
    fireEvent.click(await screen.findByRole('button', { name: /Invite to FlowZa Time/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('The record has no work or personal email');
    expect(within(dialog).getByRole('radio', { name: /Another address/ })).toBeChecked();
    fireEvent.change(within(dialog).getByLabelText(/^Email/), { target: { value: 'typed@acme.om' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Invite to FlowZa Time/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/employees/e5/portal-access/invite', { email: 'typed@acme.om' }));
  });

  it('5-P0-1 offers no revoke / restore on the reader\'s own login', async () => {
    mockGet({ '/orgs/org-1/employees/e5/portal-access': { data: access({ state: 'active', membership: { ...membership('active'), id: 'mem-1' } }) }, '/orgs/org-1/roles': { data: [] } });
    renderWithProviders(<PortalAccessCard employeeId="e5" employeeName="Salma" />);
    expect(await screen.findByTestId('portal-access-state')).toHaveTextContent('Active');
    expect(screen.queryByRole('button', { name: /Revoke access/ })).not.toBeInTheDocument();
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
