import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { InviteDialog } from './invite-dialog';

const branch = (id: string, name: string) => ({ id, organizationId: 'org-1', code: id.toUpperCase(), name, nameAr: null, countryCode: 'OM', city: null, address: {}, timezone: 'Asia/Muscat', latitude: null, longitude: null, geofenceRadiusM: null, contact: {}, weeklyOffDays: null, holidayCalendarId: null, status: 'active', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' });
const role = { id: '10000000-0000-0000-0000-000000000003', organizationId: null, key: 'hr_admin', name: 'HR admin', description: null, isSystem: true, permissions: [], memberCount: 1, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' };

describe('InviteDialog', () => {
  beforeEach(() => {
    resetApiMock(); grantAll();
    mockGet({ '/orgs/org-1/roles': { data: [role] }, '/orgs/org-1/branches': page([branch('b1', 'Muscat'), branch('b2', 'Salalah')]), '/orgs/org-1/employees': page([]) });
  });

  it('enforces the schema refine: branch-scoped invitations need at least one branch', async () => {
    renderWithProviders(<InviteDialog open onOpenChange={() => {}} />);
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('switch', { name: /All branches/ }));
    expect(await screen.findByText('Muscat')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    await screen.findByText('Select at least one branch or grant all branches');
    expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(2); // email + role + branches
    expect(apiMock.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Salalah' }));
    await waitFor(() => expect(screen.queryByText('Select at least one branch or grant all branches')).not.toBeInTheDocument());
  });

  it('shows the one-time token with a copy button after a successful invitation', async () => {
    apiMock.post.mockResolvedValue({ data: { id: 'inv1', organizationId: 'org-1', email: 'new@acme.om', roleId: role.id, allBranches: true, branchIds: [], invitedBy: 'u1', expiresAt: '2030-01-08T10:00:00Z', acceptedAt: null, createdAt: '2030-01-01T10:00:00Z', token: 'org-1.secret-token-value' } });
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    renderWithProviders(<InviteDialog open onOpenChange={() => {}} />);
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'new@acme.om' } });
    // Radix Select: open with keyboard, pick the role option
    const trigger = screen.getByRole('combobox', { name: /Role/ });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const option = await screen.findByRole('option', { name: /HR admin/ });
    fireEvent.pointerUp(option); fireEvent.click(option);
    fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/invitations', expect.objectContaining({ email: 'new@acme.om', roleId: role.id, allBranches: true, branchIds: [] })));
    const tokenInput = await screen.findByLabelText('Invitation token');
    expect(tokenInput).toHaveValue('org-1.secret-token-value');
    fireEvent.click(screen.getByRole('button', { name: 'Copy token' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('org-1.secret-token-value'));
    expect(screen.getByText(/never shown again/)).toBeInTheDocument();
  });
});
