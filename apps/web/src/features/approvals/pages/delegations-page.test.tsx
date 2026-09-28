import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import type { ApprovalDelegationDto } from '@flowza/contracts';
import { apiMock, grant, mockGet, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/approvals.json';
import ar from '@/locales/ar/approvals.json';
import DelegationsPage from './delegations-page';

registerNamespace('approvals', en, ar);

const delegation = (over: Partial<ApprovalDelegationDto> = {}): ApprovalDelegationDto => ({
  id: 'd1', organizationId: 'org-1', delegatorUserId: 'u1', delegatorName: 'Dev', delegateUserId: 'u7', delegateName: 'Deputy', entityTypes: ['LEAVE'], startsOn: '2000-01-01', endsOn: '2999-12-31', isActive: true, reason: 'Annual leave', createdAt: '2024-03-01T08:00:00Z', revokedAt: null, ...over,
});

describe('DelegationsPage', () => {
  beforeEach(() => {
    resetApiMock(); testState.teamSize = 0;
    mockGet({
      '/orgs/org-1/approval-delegations': { data: [delegation(), delegation({ id: 'd2', delegateName: 'Old deputy', isActive: false, revokedAt: '2024-03-02T08:00:00Z', entityTypes: null })] },
      '/orgs/org-1/approval-delegations/candidates': { data: [{ userId: 'u7', fullName: 'Deputy', email: 'deputy@test.local' }, { userId: 'u8', fullName: 'Second', email: 'second@test.local' }] },
    });
  });

  it('lists my delegations with their state and revokes an active one', async () => {
    grant('approval.delegate');
    apiMock.delete.mockResolvedValue(undefined);
    renderWithProviders(<DelegationsPage />, { route: '/approvals/delegations' });
    expect(await screen.findByText('Deputy')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    expect(screen.getByText('All request types')).toBeInTheDocument();
    // only the active row can be revoked
    const revoke = screen.getAllByRole('button', { name: /Revoke/ });
    expect(revoke).toHaveLength(1);
    fireEvent.click(revoke[0]!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Revoke/ }));
    await waitFor(() => expect(apiMock.delete).toHaveBeenCalledWith('/orgs/org-1/approval-delegations/d1'));
  });

  it('creates a delegation to a colleague for chosen request types', async () => {
    grant('approval.delegate');
    apiMock.post.mockResolvedValue({ data: delegation({ id: 'd3' }) });
    renderWithProviders(<DelegationsPage />, { route: '/approvals/delegations' });
    await screen.findByText('Deputy');
    fireEvent.click(screen.getByRole('button', { name: /Delegate my approvals/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText('Approver')).not.toBeInTheDocument(); // on-behalf picker is HR's (approval.manage)
    fireEvent.click(within(dialog).getByRole('combobox'));
    fireEvent.click(await screen.findByText('Second'));
    fireEvent.click(within(dialog).getByLabelText('Leave'));
    fireEvent.change(within(dialog).getByLabelText(/Until/), { target: { value: '2999-01-31' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/approval-delegations', expect.objectContaining({ delegateUserId: 'u8', entityTypes: ['LEAVE'], endsOn: '2999-01-31' })));
  });

  it('without approval.delegate the page only lists (nothing to create)', async () => {
    grant('dashboard.view');
    mockGet({ '/orgs/org-1/approval-delegations': { data: [] } });
    renderWithProviders(<DelegationsPage />, { route: '/approvals/delegations' });
    expect(await screen.findByText('You cannot delegate approvals.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delegate my approvals/ })).not.toBeInTheDocument();
  });
});
