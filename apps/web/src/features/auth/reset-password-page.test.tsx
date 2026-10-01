import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string } },
  loading: false,
  recovery: false,
  signOut: vi.fn(async () => undefined),
}));

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);
vi.mock('./auth-provider', () => ({ useAuth: () => ({ session: h.session, user: h.session?.user ?? null, loading: h.loading, recovery: h.recovery, signOut: h.signOut }) }));

import { renderWithProviders } from '@/features/employees/test-utils';
import { supabaseMock } from '@/features/employees/test-mocks';
import { ResetPasswordPage } from './reset-password-page';
import { markPasswordRecovery, passwordRecoveryUserId } from './password-recovery';

const GOOD = 'Sup3rSecret!pass';
const at = (route: string) => ({ route, path: '/auth/reset' });
const fill = (password: string, confirm = password) => {
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: confirm } });
  fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
};

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    h.session = null; h.loading = false; h.recovery = false; h.signOut.mockClear();
    localStorage.clear();
    supabaseMock.auth.verifyOtp.mockReset().mockResolvedValue({ data: { session: { access_token: 't' }, user: { id: 'u1' } }, error: null });
    supabaseMock.auth.updateUser.mockReset().mockResolvedValue({ data: {}, error: null });
    supabaseMock.auth.signOut.mockClear();
    supabaseMock.auth.mfa.listFactors.mockReset().mockResolvedValue({ data: { totp: [], all: [] }, error: null });
  });

  it('a token-hash link: nothing is verified until the new password is submitted, then the password is set', async () => {
    renderWithProviders(<ResetPasswordPage />, at('/auth/reset?token_hash=pkce_abc&type=recovery'));
    expect(screen.getByText('Choose a new password')).toBeInTheDocument();
    // opening the page (as a mail scanner does) spends nothing
    expect(supabaseMock.auth.verifyOtp).not.toHaveBeenCalled();

    fill(GOOD);
    await waitFor(() => expect(screen.getByText('Password changed')).toBeInTheDocument());
    expect(supabaseMock.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'pkce_abc', type: 'recovery' });
    expect(supabaseMock.auth.updateUser).toHaveBeenCalledWith({ password: GOOD });
    // other sessions on the account are signed out, this one stays
    expect(supabaseMock.auth.signOut).toHaveBeenCalledWith({ scope: 'others' });
    // the spent link is not left in the address bar for a reload
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/auth/reset'));
    expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute('href', '/');
  });

  it('does not spend the link on a password the policy refuses', async () => {
    renderWithProviders(<ResetPasswordPage />, at('/auth/reset?token_hash=pkce_abc&type=recovery'));
    fill('alllowercase123!');
    expect(await screen.findByText('Use upper and lower case letters, a digit and a symbol.')).toBeInTheDocument();
    fill(GOOD, `${GOOD}x`);
    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
    expect(supabaseMock.auth.verifyOtp).not.toHaveBeenCalled();
  });

  it('a link that was already used (a mail scanner opened it first) says so and offers a new one', async () => {
    supabaseMock.auth.verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'Email link is invalid or has expired', code: 'otp_expired', status: 403 } });
    renderWithProviders(<ResetPasswordPage />, at('/auth/reset?token_hash=pkce_abc&type=recovery'));
    fill(GOOD);
    expect(await screen.findByText('This link has expired')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', '/auth/forgot');
    expect(supabaseMock.auth.updateUser).not.toHaveBeenCalled();
  });

  it('a verified link whose password the server refused is not verified a second time', async () => {
    supabaseMock.auth.updateUser.mockResolvedValueOnce({ data: {}, error: { message: 'same', code: 'same_password', status: 422 } });
    renderWithProviders(<ResetPasswordPage />, at('/auth/reset?token_hash=pkce_abc&type=recovery'));
    fill(GOOD);
    expect(await screen.findByText('Choose a password that is different from your current one.')).toBeInTheDocument();
    fill('An0ther!Password');
    await waitFor(() => expect(screen.getByText('Password changed')).toBeInTheDocument());
    expect(supabaseMock.auth.verifyOtp).toHaveBeenCalledTimes(1);
    expect(supabaseMock.auth.updateUser).toHaveBeenLastCalledWith({ password: 'An0ther!Password' });
  });

  it("Supabase's error redirect (otp_expired) shows the expired state, not an empty form", () => {
    renderWithProviders(<ResetPasswordPage />, at('/auth/reset?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'));
    expect(screen.getByTestId('reset-link-problem')).toHaveAttribute('data-kind', 'expired');
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  });

  it('a PKCE link this browser could not exchange asks for the browser it was requested from', () => {
    renderWithProviders(<ResetPasswordPage />, at('/auth/reset?code=4b1e'));
    expect(screen.getByTestId('reset-link-problem')).toHaveAttribute('data-kind', 'otherBrowser');
  });

  it('without a link or a session it explains where the link is', () => {
    renderWithProviders(<ResetPasswordPage />, at('/auth/reset'));
    expect(screen.getByTestId('reset-link-problem')).toHaveAttribute('data-kind', 'missing');
  });

  it('a recovery session (the link was exchanged on load) sets the password directly and ends the recovery', async () => {
    h.session = { user: { id: 'u1', email: 'rakshitha@example.com' } };
    h.recovery = true;
    markPasswordRecovery('u1');
    // Supabase redirected with the code already exchanged; a second click of the same e-mail adds an error — the
    // recovery session still lets the person finish
    renderWithProviders(<ResetPasswordPage />, at('/auth/reset?error_code=otp_expired'));
    expect(screen.getByText('You opened a password-reset link for rakshitha@example.com. Choose a new password to continue.')).toBeInTheDocument();
    fill(GOOD);
    await waitFor(() => expect(screen.getByText('Password changed')).toBeInTheDocument());
    expect(supabaseMock.auth.verifyOtp).not.toHaveBeenCalled();
    expect(supabaseMock.auth.updateUser).toHaveBeenCalledWith({ password: GOOD });
    expect(passwordRecoveryUserId()).toBeNull();
  });

  it('a recovery session can be abandoned by signing out', async () => {
    h.session = { user: { id: 'u1', email: 'rakshitha@example.com' } };
    h.recovery = true;
    renderWithProviders(<ResetPasswordPage />, { route: '/auth/reset', path: '*' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel and sign out' }));
    await waitFor(() => expect(h.signOut).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/auth/sign-in'));
  });

  it('an account protected by an authenticator verifies a code, then the password is set', async () => {
    h.session = { user: { id: 'u1', email: 'admin@flowza.ai' } };
    h.recovery = true;
    supabaseMock.auth.updateUser.mockResolvedValueOnce({ data: {}, error: { message: 'AAL2 required', code: 'insufficient_aal', status: 401 } });
    supabaseMock.auth.mfa.listFactors.mockResolvedValue({ data: { totp: [{ id: 'f1', status: 'verified' }], all: [] }, error: null });
    supabaseMock.auth.mfa.challenge.mockResolvedValue({ data: { id: 'c1' }, error: null });
    supabaseMock.auth.mfa.verify.mockResolvedValue({ data: {}, error: null });
    renderWithProviders(<ResetPasswordPage />, at('/auth/reset'));
    fill(GOOD);
    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(screen.getByText('Password changed')).toBeInTheDocument());
    expect(supabaseMock.auth.mfa.verify).toHaveBeenCalledWith({ factorId: 'f1', challengeId: 'c1', code: '123456' });
    expect(supabaseMock.auth.updateUser).toHaveBeenCalledTimes(2);
  });

  it('a member who is simply signed in changes their password here', async () => {
    h.session = { user: { id: 'u1', email: 'hr@acme.om' } };
    renderWithProviders(<ResetPasswordPage />, at('/auth/reset'));
    expect(screen.getByText('Change your password')).toBeInTheDocument();
    expect(screen.getByText('Signed in as hr@acme.om.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to FlowZa Time' })).toHaveAttribute('href', '/');
  });
});
