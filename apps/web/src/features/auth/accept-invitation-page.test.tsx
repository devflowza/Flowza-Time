import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ session: null as unknown }));

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('./auth-provider', () => ({ useAuth: () => ({ session: h.session, user: null, loading: false, signOut: vi.fn() }) }));

import { renderWithProviders } from '@/features/employees/test-utils';
import { apiMock, resetApiMock, supabaseMock, ApiError } from '@/features/employees/test-mocks';
import { AcceptInvitationPage } from './accept-invitation-page';

const TOKEN = '11111111-1111-1111-1111-111111111111.secret-value-long-enough';
const at = (token?: string) => ({ route: token ? `/auth/invite?token=${encodeURIComponent(token)}` : '/auth/invite', path: '/auth/invite' });

describe('AcceptInvitationPage', () => {
  beforeEach(() => {
    h.session = null;
    resetApiMock();
    apiMock.post.mockReset();
    supabaseMock.auth.signUp?.mockReset?.();
    supabaseMock.auth.signInWithPassword?.mockReset?.();
  });

  it('refuses a link with no token instead of showing a form that cannot work', () => {
    renderWithProviders(<AcceptInvitationPage />, at());
    expect(screen.getByText('Invitation link is not valid')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('creates the account and redeems the token in one step', async () => {
    supabaseMock.auth.signUp.mockResolvedValue({ data: { session: { access_token: 't' }, user: { id: 'u2' } }, error: null });
    apiMock.post.mockResolvedValue({ data: { membershipId: 'm1', organizationId: 'o1' } });
    renderWithProviders(<AcceptInvitationPage />, at(TOKEN));

    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'owner@acme.om' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Sup3rSecret!pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account and join' }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/invitations/accept', { token: TOKEN }));
  });

  it('tells the invitee to confirm their email when signup returns no session', async () => {
    // Supabase creates the user but withholds a session when the project requires email confirmation. Without this
    // branch the invitee sits on a form that can never succeed.
    supabaseMock.auth.signUp.mockResolvedValue({ data: { session: null, user: { id: 'u2' } }, error: null });
    renderWithProviders(<AcceptInvitationPage />, at(TOKEN));

    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'owner@acme.om' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Sup3rSecret!pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account and join' }));

    expect(await screen.findByText('Confirm your email')).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('surfaces the API reason when the invitation was issued to a different address', async () => {
    h.session = { access_token: 't' };
    apiMock.post.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'This invitation was issued to a different email address.'));
    renderWithProviders(<AcceptInvitationPage />, at(TOKEN));
    expect(await screen.findByRole('alert')).toHaveTextContent('issued to a different email address');
  });

  it('redeems immediately for someone who is already signed in', async () => {
    h.session = { access_token: 't' };
    apiMock.post.mockResolvedValue({ data: { membershipId: 'm1', organizationId: 'o1' } });
    renderWithProviders(<AcceptInvitationPage />, at(TOKEN));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/invitations/accept', { token: TOKEN }));
  });
});
