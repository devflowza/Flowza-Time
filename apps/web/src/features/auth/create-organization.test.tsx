import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('./auth-provider', () => ({ useAuth: () => ({ session: { access_token: 't' }, user: null, loading: false, signOut: vi.fn() }) }));

import { renderWithProviders } from '@/features/employees/test-utils';
import { apiMock, ApiError, resetApiMock } from '@/features/employees/test-mocks';
import { CreateOrganizationScreen } from './create-organization-screen';
import { PENDING_ORGANIZATION_KEY, readPendingOrganization, savePendingOrganization } from './create-organization';

describe('CreateOrganizationScreen', () => {
  beforeEach(() => { resetApiMock(); window.localStorage.clear(); });

  it('explains the situation and still offers sign-out', () => {
    renderWithProviders(<CreateOrganizationScreen />);
    expect(screen.getByRole('heading', { name: 'Create your organisation' })).toBeInTheDocument();
    expect(screen.getByText(/not a member of any organisation yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.getByLabelText('Company name')).toHaveValue('');
  });

  it('prefills the company parked by a sign-up that needed email confirmation, and clears it on success', async () => {
    savePendingOrganization({ displayName: 'Acme Trading', timezone: 'Asia/Dubai' });
    apiMock.post.mockResolvedValue({ data: { organization: { id: 'o1' }, membershipId: 'm1' } });
    const { client } = renderWithProviders(<CreateOrganizationScreen />);
    const spy = vi.spyOn(client, 'invalidateQueries');
    expect(screen.getByLabelText('Company name')).toHaveValue('Acme Trading');
    fireEvent.click(screen.getByRole('button', { name: 'Create organisation' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs', { displayName: 'Acme Trading', timezone: 'Asia/Dubai' }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['me'] }));
    expect(window.localStorage.getItem(PENDING_ORGANIZATION_KEY)).toBeNull();
  });

  it('validates the name before calling the API', async () => {
    renderWithProviders(<CreateOrganizationScreen />);
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organisation' }));
    expect(await screen.findByText('Enter your company name (at least 2 characters).')).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("shows the API's reason when creation is refused", async () => {
    apiMock.post.mockRejectedValue(new ApiError(409, 'INVALID_STATE', 'Your account already belongs to an organisation.'));
    renderWithProviders(<CreateOrganizationScreen />);
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Acme Trading' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organisation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already belongs to an organisation');
  });

  it('ignores a corrupt parked value', () => {
    window.localStorage.setItem(PENDING_ORGANIZATION_KEY, '{not json');
    expect(readPendingOrganization()).toBeNull();
    window.localStorage.setItem(PENDING_ORGANIZATION_KEY, JSON.stringify({ displayName: '' }));
    expect(readPendingOrganization()).toBeNull();
  });
});
