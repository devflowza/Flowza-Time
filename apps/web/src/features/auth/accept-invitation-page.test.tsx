import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ session: null as unknown, signOut: vi.fn() }));

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('./auth-provider', () => ({ useAuth: () => ({ session: h.session, user: null, loading: false, signOut: h.signOut }) }));

import { renderWithProviders } from '@/features/employees/test-utils';
import { apiMock, resetApiMock, supabaseMock, ApiError } from '@/features/employees/test-mocks';
import { AcceptInvitationPage } from './accept-invitation-page';
import { readPendingInvitation, rememberPendingInvitation } from './pending-invitation';

const TOKEN = '11111111-1111-1111-1111-111111111111.secret-value-long-enough';
const at = (token?: string) => ({ route: token ? `/auth/invite?token=${encodeURIComponent(token)}` : '/auth/invite', path: '/auth/invite' });

describe('AcceptInvitationPage', () => {
  beforeEach(() => {
    h.session = null;
    h.signOut.mockReset();
    localStorage.clear();
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
    // only the (read-only) validation reached the API; nothing was accepted
    expect(apiMock.post.mock.calls.some((c) => c[0] === '/invitations/accept')).toBe(false);
    // ...and the invitation is remembered, so signing in once confirmed joins it (the shell redirects back here)
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/sign-in');
    expect(readPendingInvitation()).toBe(TOKEN);
  });

  it('asks Supabase to send the invitee back to this link after they confirm', async () => {
    // Otherwise the confirmation link lands on the project's Site URL, where a member-less invitee can do nothing.
    supabaseMock.auth.signUp.mockResolvedValue({ data: { session: null, user: { id: 'u2' } }, error: null });
    renderWithProviders(<AcceptInvitationPage />, at(TOKEN));
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'owner@acme.om' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Sup3rSecret!pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account and join' }));
    await waitFor(() =>
      expect(supabaseMock.auth.signUp).toHaveBeenCalledWith(
        expect.objectContaining({ options: expect.objectContaining({ emailRedirectTo: expect.stringContaining('/auth/invite') }) }),
      ),
    );
  });

  it('lets an existing account sign in with a password shorter than the new-password minimum', async () => {
    // The 12-character rule is for CHOOSING a password, not for presenting one. Both live accounts predate the policy
    // (11 and 9 chars), so gating sign-in on it locked them out of their own invitations.
    supabaseMock.auth.signInWithPassword.mockResolvedValue({ data: { session: { access_token: 't' }, user: { id: 'u1' } }, error: null });
    apiMock.post.mockResolvedValue({ data: { membershipId: 'm1', organizationId: 'o1' } });
    renderWithProviders(<AcceptInvitationPage />, at(TOKEN));

    fireEvent.click(screen.getByRole('button', { name: 'I already have an account' }));
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'dev@flowza.ai' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Flowza@2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(supabaseMock.auth.signInWithPassword).toHaveBeenCalled());
  });

  it('still demands 12 characters when creating a new account', async () => {
    renderWithProviders(<AcceptInvitationPage />, at(TOKEN));
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'owner@acme.om' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short1!A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account and join' }));
    expect(await screen.findByText('Use at least 12 characters.')).toBeInTheDocument();
    expect(supabaseMock.auth.signUp).not.toHaveBeenCalled();
  });

  it('redeems the single-use token exactly once when sign-in and the auto-redeem effect race', async () => {
    // supabase-js publishes SIGNED_IN before signInWithPassword resolves, so the effect fires while the manual
    // accept() is still in flight. Two POSTs of a single-use token means the loser reports "already accepted".
    h.session = null;
    supabaseMock.auth.signInWithPassword.mockImplementation(async () => {
      h.session = { access_token: 't' };
      return { data: { session: { access_token: 't' }, user: { id: 'u1' } }, error: null };
    });
    apiMock.post.mockResolvedValue({ data: { membershipId: 'm1', organizationId: 'o1' } });
    renderWithProviders(<AcceptInvitationPage />, at(TOKEN));

    fireEvent.click(screen.getByRole('button', { name: 'I already have an account' }));
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'dev@flowza.ai' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Flowza@2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalled());
    expect(apiMock.post.mock.calls.filter((c) => c[0] === '/invitations/accept')).toHaveLength(1);
  });

  it('surfaces the API reason when the invitation was issued to a different address', async () => {
    h.session = { access_token: 't' };
    apiMock.post.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'This invitation was issued to a different email address.'));
    renderWithProviders(<AcceptInvitationPage />, at(TOKEN));
    expect(await screen.findByRole('alert')).toHaveTextContent('issued to a different email address');
  });

  it('keeps a signed-in invitee on a retry, not on the create-account form, when joining fails', async () => {
    // The confirmation link brings the invitee back here signed in. When the accept call then failed (API unreachable),
    // the page used to fall back to "Create account and join": repeating it sent them waiting for a confirmation email
    // that never comes, and signing in asked for a password they had typed once and were no longer sure of.
    h.session = { access_token: 't', user: { email: 'rakshitha@acme.om' } };
    apiMock.post.mockImplementation((path: string) => (path === '/invitations/accept'
      ? Promise.reject(new ApiError(0, 'NETWORK_ERROR', 'Could not reach the API at http://localhost:4000'))
      : Promise.resolve({ data: null })));
    renderWithProviders(<AcceptInvitationPage />, at(TOKEN));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the API');
    expect(screen.getByText('You are signed in as rakshitha@acme.om.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create account and join' })).not.toBeInTheDocument();

    apiMock.post.mockResolvedValue({ data: { membershipId: 'm1', organizationId: 'o1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(apiMock.post.mock.calls.filter((c) => c[0] === '/invitations/accept')).toHaveLength(2));
  });

  it('lets a signed-in invitee switch to another account', async () => {
    h.session = { access_token: 't', user: { email: 'someone.else@acme.om' } };
    apiMock.post.mockImplementation((path: string) => (path === '/invitations/accept'
      ? Promise.reject(new ApiError(403, 'FORBIDDEN', 'This invitation was issued to a different email address.'))
      : Promise.resolve({ data: null })));
    renderWithProviders(<AcceptInvitationPage />, at(TOKEN));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Use a different account' }));
    expect(h.signOut).toHaveBeenCalled();
  });

  it('sends an address that already has an account to sign in, instead of waiting for an email that never comes', async () => {
    // Supabase answers a repeated sign-up of a confirmed address with a stand-in user without identities, and no email.
    supabaseMock.auth.signUp.mockResolvedValue({ data: { session: null, user: { id: 'u2', identities: [] } }, error: null });
    renderWithProviders(<AcceptInvitationPage />, at(TOKEN));
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'owner@acme.om' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Sup3rSecret!pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account and join' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('An account already exists for owner@acme.om');
    expect(screen.queryByText('Confirm your email')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute('href', '/auth/forgot');
  });

  it('says the email is unconfirmed rather than that the password is wrong', async () => {
    supabaseMock.auth.signInWithPassword.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'Email not confirmed', code: 'email_not_confirmed', status: 400 } });
    renderWithProviders(<AcceptInvitationPage />, at(TOKEN));
    fireEvent.click(screen.getByRole('button', { name: 'I already have an account' }));
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'owner@acme.om' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Sup3rSecret!pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Confirm your email first');
    expect(screen.queryByText('Invalid email or password.')).not.toBeInTheDocument();
  });

  it('remembers the invitation when the invitee goes to reset their password', () => {
    renderWithProviders(<AcceptInvitationPage />, at(TOKEN));
    fireEvent.click(screen.getByRole('button', { name: 'I already have an account' }));
    fireEvent.click(screen.getByRole('link', { name: 'Forgot password?' }));
    expect(readPendingInvitation()).toBe(TOKEN);
  });

  it('redeems immediately for someone who is already signed in', async () => {
    h.session = { access_token: 't' };
    apiMock.post.mockResolvedValue({ data: { membershipId: 'm1', organizationId: 'o1' } });
    renderWithProviders(<AcceptInvitationPage />, at(TOKEN));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/invitations/accept', { token: TOKEN }));
  });

  describe('HR portal Prompt 6b: the validate preview (Finance B-70)', () => {
    const previewOf = (state: 'valid' | 'accepted' | 'revoked' | 'expired') => ({ data: { state, organizationName: 'Acme Trading', employeeName: 'Salma Al Harthy', emailMasked: 's***@a***.om', expiresAt: '2026-10-05T00:00:00Z' } });
    const route = (validate: () => Promise<unknown>) => apiMock.post.mockImplementation((path: string) => (path === '/invitations/validate' ? validate() : Promise.resolve({ data: { membershipId: 'm1', organizationId: 'o1' } })));

    it('shows what the invitation is before anybody signs in, and keeps the form', async () => {
      route(() => Promise.resolve(previewOf('valid')));
      renderWithProviders(<AcceptInvitationPage />, at(TOKEN));
      const preview = await screen.findByTestId('invitation-preview');
      expect(preview).toHaveTextContent('Invitation to Acme Trading');
      expect(preview).toHaveTextContent('Sent to s***@a***.om');
      expect(preview).toHaveTextContent('Employee record: Salma Al Harthy');
      expect(preview).toHaveTextContent('Valid');
      expect(apiMock.post).toHaveBeenCalledWith('/invitations/validate', { token: TOKEN });
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
      expect(apiMock.post.mock.calls.some((c) => c[0] === '/invitations/accept')).toBe(false);
    });

    it.each([
      ['expired', 'This invitation has expired. Ask your administrator to resend it.'],
      ['revoked', 'This invitation was withdrawn or replaced by a newer one. Ask your administrator to send it again.'],
      ['accepted', 'This invitation was already used. Sign in with the invited address to open Acme Trading.'],
    ] as const)('explains a %s invitation instead of offering the form — and never tries to accept it, even when signed in', async (state, text) => {
      h.session = { access_token: 't' };
      route(() => Promise.resolve(previewOf(state)));
      renderWithProviders(<AcceptInvitationPage />, at(TOKEN));
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
      if (state === 'accepted') expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/auth/sign-in');
      await new Promise((r) => setTimeout(r, 20));
      expect(apiMock.post.mock.calls.some((c) => c[0] === '/invitations/accept')).toBe(false);
    });

    it('reads an unknown token (404) as an invalid link', async () => {
      route(() => Promise.reject(new ApiError(404, 'NOT_FOUND', 'Invitation not found')));
      renderWithProviders(<AcceptInvitationPage />, at(TOKEN));
      expect(await screen.findByText('This invitation link is not valid')).toBeInTheDocument();
    });

    it('keeps the form usable when validation itself fails (rate limit): the accept call decides', async () => {
      route(() => Promise.reject(new ApiError(429, 'RATE_LIMITED', 'Too many requests')));
      renderWithProviders(<AcceptInvitationPage />, at(TOKEN));
      await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/invitations/validate', { token: TOKEN }));
      expect(await screen.findByLabelText('Password')).toBeInTheDocument();
      expect(screen.queryByTestId('invitation-preview')).not.toBeInTheDocument();
    });

    it('re-reads the invitation after a failed accept, so a join whose answer was lost shows the way in', async () => {
      // The first accept landed but its answer never arrived; the retry is refused as single use. Only the invitation's
      // state can tell the invitee they are in.
      h.session = { access_token: 't', user: { email: 'salma@acme.om' } };
      let validations = 0;
      apiMock.post.mockImplementation((path: string) => {
        if (path === '/invitations/validate') { validations += 1; return Promise.resolve(previewOf(validations === 1 ? 'valid' : 'accepted')); }
        return Promise.reject(new ApiError(0, 'NETWORK_ERROR', 'Could not reach the API at http://localhost:4000'));
      });
      renderWithProviders(<AcceptInvitationPage />, at(TOKEN));
      expect(await screen.findByText('This invitation was already used. Sign in with the invited address to open Acme Trading.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/auth/sign-in');
    });
  });

  it('forgets a remembered invitation once it opens, so the shell never redirects here twice', async () => {
    rememberPendingInvitation(TOKEN);
    renderWithProviders(<AcceptInvitationPage />, at(TOKEN));
    await waitFor(() => expect(readPendingInvitation()).toBeNull());
  });
});
