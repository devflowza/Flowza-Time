import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import type { AccessGrantDto } from '@flowza/contracts';
import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/platform.json';
import ar from '@/locales/ar/platform.json';
import { GrantsTable } from './grants-table';

registerNamespace('platform', en, ar);

const base: AccessGrantDto = {
  id: '11111111-1111-4111-8111-111111111111', organizationId: '22222222-2222-4222-8222-222222222222', organizationName: 'Acme', platformAdminUserId: '33333333-3333-4333-8333-333333333333',
  platformAdminEmail: 'support@flowza.test', accessLevel: 'write', reason: 'Ticket 1000 data repair', ticketRef: null, grantedBy: '44444444-4444-4444-8444-444444444444',
  approvedBy: '55555555-5555-4555-8555-555555555555', approvedAt: null, pendingApproval: true, canApprove: true, requestedHours: 3,
  startsAt: '2026-09-28T07:59:59.000Z', expiresAt: '2026-09-28T08:00:00.000Z', revokedAt: null, active: false, createdAt: '2026-09-28T08:00:00.000Z',
};

/** Security gate (Prompt 10): a write grant waits for its named second approver, who approves it here. */
describe('GrantsTable — write grants awaiting approval', () => {
  beforeEach(() => { resetApiMock(); grantAll(); });

  it('shows a pending write grant as awaiting approval, with its requested duration instead of a window', async () => {
    mockGet({ '/platform/access-grants': page([{ ...base, canApprove: false }]) });
    renderWithProviders(<GrantsTable />);
    expect(await screen.findByText('Awaiting approval')).toBeInTheDocument();
    expect(screen.getByText('3 hours, on approval')).toBeInTheDocument();
    // not the approver: no Approve button (the server refuses anyone else anyway); the request can still be withdrawn
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });

  it('lets the named approver approve it after confirming', async () => {
    mockGet({ '/platform/access-grants': page([base]) });
    apiMock.post.mockResolvedValue({ data: { ...base, pendingApproval: false, canApprove: false, active: true, approvedAt: '2026-09-28T08:05:00.000Z' } });
    renderWithProviders(<GrantsTable />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/support@flowza\.test gets write access to Acme for 3 hours/)).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/platform/access-grants/${base.id}/approve`, {}));
  });
});
