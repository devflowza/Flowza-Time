import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';

const h = vi.hoisted(() => ({ session: null as unknown }));

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('./auth-provider', () => ({ useAuth: () => ({ session: h.session, user: null, loading: false, signOut: vi.fn() }) }));

import { renderWithProviders } from '@/features/employees/test-utils';
import { apiMock, resetApiMock, supabaseMock } from '@/features/employees/test-mocks';
import { SignUpPage } from './sign-up-page';
import { PENDING_ORGANIZATION_KEY } from './create-organization';

const at = { route: '/auth/sign-up', path: '/auth/sign-up' };
/** The page plus a home route to land on, so a redirect is observable instead of unmounting the whole tree. */
const withHome = (
  <Routes>
    <Route path="/auth/sign-up" element={<SignUpPage />} />
    <Route path="/" element={<output data-testid="home">home</output>} />
  </Routes>
);
const STRONG = 'Sup3rSecret!pass';

function fill({ company = 'Acme Trading', email = 'owner@acme.om', password = STRONG, confirm = password }: { company?: string; email?: string; password?: string; confirm?: string } = {}) {
  fireEvent.change(screen.getByLabelText('Company name'), { target: { value: company } });
  fireEvent.change(screen.getByLabelText('Work email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: confirm } });
}
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

describe('SignUpPage', () => {
  beforeEach(() => {
    h.session = null;
    resetApiMock();
    supabaseMock.auth.signUp.mockReset();
    window.localStorage.clear();
  });

  it('renders the form with a link back to sign-in', () => {
    renderWithProviders(<SignUpPage />, at);
    expect(screen.getByRole('heading', { name: 'Create your FlowZa Time account' })).toBeInTheDocument();
    expect(screen.getByLabelText('Company name')).toBeInTheDocument();
    expect(screen.getByLabelText('Work email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText('Confirm password')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/sign-in');
  });

  it('blocks an empty submission before any network call', async () => {
    renderWithProviders(<SignUpPage />, at);
    submit();
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter your company name (at least 2 characters).')).toBeInTheDocument();
    expect(screen.getByText('Use at least 12 characters.')).toBeInTheDocument();
    expect(supabaseMock.auth.signUp).not.toHaveBeenCalled();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('rejects an invalid email address', async () => {
    renderWithProviders(<SignUpPage />, at);
    fill({ email: 'not-an-email' });
    submit();
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(supabaseMock.auth.signUp).not.toHaveBeenCalled();
  });

  it('demands 12 characters for the new password', async () => {
    renderWithProviders(<SignUpPage />, at);
    fill({ password: 'short1!A' });
    submit();
    expect(await screen.findByText('Use at least 12 characters.')).toBeInTheDocument();
    expect(supabaseMock.auth.signUp).not.toHaveBeenCalled();
  });

  it('refuses when the confirmation does not match the password', async () => {
    renderWithProviders(<SignUpPage />, at);
    fill({ confirm: `${STRONG}x` });
    submit();
    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
    expect(supabaseMock.auth.signUp).not.toHaveBeenCalled();
  });

  it('creates the account, then the organisation as its owner, and only then leaves the page', async () => {
    supabaseMock.auth.signUp.mockImplementation(async () => {
      h.session = { access_token: 't' };
      return { data: { session: { access_token: 't' }, user: { id: 'u2' } }, error: null };
    });
    let finishOrg!: () => void;
    apiMock.post.mockImplementation(() => new Promise((resolve) => { finishOrg = () => resolve({ data: { organization: { id: 'o1' }, membershipId: 'm1' } }); }));
    renderWithProviders(withHome, { route: '/auth/sign-up', path: '*' });
    fill();
    submit();
    await waitFor(() => expect(supabaseMock.auth.signUp).toHaveBeenCalledTimes(1));
    expect(supabaseMock.auth.signUp).toHaveBeenCalledWith({
      email: 'owner@acme.om',
      password: STRONG,
      options: { emailRedirectTo: expect.stringMatching(/\/auth\/callback$/) },
    });
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs', { displayName: 'Acme Trading', timezone: expect.any(String) }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
    // the session is already published, but the page holds the redirect until the organisation exists
    expect(screen.queryByTestId('home')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create account' })).toHaveAttribute('aria-busy', 'true');
    finishOrg();
    expect(await screen.findByTestId('home')).toBeInTheDocument();
    expect(window.localStorage.getItem(PENDING_ORGANIZATION_KEY)).toBeNull();
  });

  it('still leaves the page when the organisation call fails, keeping the details parked for the shell to retry', async () => {
    supabaseMock.auth.signUp.mockImplementation(async () => {
      h.session = { access_token: 't' };
      return { data: { session: { access_token: 't' }, user: { id: 'u2' } }, error: null };
    });
    apiMock.post.mockRejectedValue(new Error('boom'));
    renderWithProviders(withHome, { route: '/auth/sign-up', path: '*' });
    fill();
    submit();
    expect(await screen.findByTestId('home')).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(PENDING_ORGANIZATION_KEY) ?? 'null')).toMatchObject({ displayName: 'Acme Trading' });
  });

  it('tells the user to confirm their email when Supabase returns no session', async () => {
    supabaseMock.auth.signUp.mockResolvedValue({ data: { session: null, user: { id: 'u2' } }, error: null });
    renderWithProviders(<SignUpPage />, at);
    fill();
    submit();
    expect(await screen.findByText('Confirm your email')).toBeInTheDocument();
    expect(screen.getByText(/We created your account for owner@acme\.om/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/sign-in');
    // no session, so no organisation yet: the company details wait for the first sign-in
    expect(apiMock.post).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(PENDING_ORGANIZATION_KEY) ?? 'null')).toMatchObject({ displayName: 'Acme Trading' });
  });

  it('surfaces the Supabase error and keeps the form', async () => {
    supabaseMock.auth.signUp.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'User already registered' } });
    renderWithProviders(<SignUpPage />, at);
    fill();
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('User already registered');
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('sends someone who is already signed in to the dashboard', () => {
    h.session = { access_token: 't' };
    renderWithProviders(withHome, { route: '/auth/sign-up', path: '*' });
    expect(screen.queryByLabelText('Work email')).not.toBeInTheDocument();
    expect(screen.getByTestId('home')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
  });
});
