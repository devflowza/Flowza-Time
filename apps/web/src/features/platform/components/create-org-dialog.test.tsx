import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/platform.json';
import ar from '@/locales/ar/platform.json';
import { CreateOrgDialog } from './create-org-dialog';

registerNamespace('platform', en, ar);

const plan = { id: '11111111-1111-4111-8111-111111111111', key: 'trial', name: 'Trial', description: null, prices: {}, limits: {}, features: [], isActive: true, sortOrder: 0 };

describe('CreateOrgDialog', () => {
  beforeEach(() => { resetApiMock(); grantAll(); mockGet({ '/platform/plans': { data: [plan] } }); });

  it('validates with the shared createOrganizationSchema before posting', async () => {
    renderWithProviders(<CreateOrgDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(4)); // code, legal, display, owner name, owner email
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('creates the organisation and shows the one-time invitation token', async () => {
    apiMock.post.mockResolvedValue({ data: { organization: { id: 'o1', displayName: 'Acme', timezone: 'Asia/Muscat' }, ownerMembershipId: null, invitation: { id: 'i1', email: 'owner@acme.om', token: 'tok-secret-123', expiresAt: '2030-01-01T00:00:00Z' } } });
    renderWithProviders(<CreateOrgDialog open onOpenChange={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText(/Company code/), { target: { value: 'ACME' } });
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByLabelText(/Legal name/), { target: { value: 'Acme Trading LLC' } });
    fireEvent.change(screen.getByLabelText(/Owner name/), { target: { value: 'Salim' } });
    fireEvent.change(screen.getByLabelText(/Owner email/), { target: { value: 'owner@acme.om' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/platform/orgs', expect.objectContaining({ companyCode: 'ACME', displayName: 'Acme', legalName: 'Acme Trading LLC', ownerEmail: 'owner@acme.om', ownerFullName: 'Salim', planKey: 'trial', timezone: 'Asia/Muscat', countryCode: 'OM', currencyCode: 'OMR', weeklyOffDays: [5, 6] }), expect.objectContaining({ idempotencyKey: expect.any(String) })));
    expect(await screen.findByText('tok-secret-123')).toBeInTheDocument();
    expect(screen.getByText(/owner@acme.om/)).toBeInTheDocument();
  });
});
