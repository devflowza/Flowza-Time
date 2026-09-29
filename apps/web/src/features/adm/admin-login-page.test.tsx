import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);
vi.mock('@/features/auth/auth-provider', () => ({ useAuth: () => ({ session: null, user: null, loading: false, signOut: vi.fn() }) }));

import { ApiError } from '@/lib/api-client';
import { apiMock, renderWithProviders, supabaseMock } from '@/features/employees/test-utils';
import './i18n';
import AdminLoginPage from './admin-login-page';

const signIn = async () => {
  fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'dev@flowza.ai' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Secret-Password-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
};

describe('AdminLoginPage (/adm/login)', () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    supabaseMock.auth.signOut.mockClear();
    supabaseMock.auth.signInWithPassword.mockClear();
  });

  it('signs a tenant user straight back out: the portal is for platform administrators only', async () => {
    apiMock.get.mockResolvedValue({ data: { user: { id: 'u1', email: 'owner@acme.test', isPlatformAdmin: false }, memberships: [] } });
    renderWithProviders(<AdminLoginPage />, { route: '/adm/login' });
    await signIn();
    expect(await screen.findByRole('alert')).toHaveTextContent('This sign-in is for platform administrators only.');
    expect(supabaseMock.auth.signOut).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('location')).toHaveTextContent('/adm/login');
  });

  it('hands a platform administrator below aal2 to the portal, whose gate asks for the second factor', async () => {
    apiMock.get.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'MFA required', 'req-1', { reason: 'MFA_REQUIRED' }));
    renderWithProviders(<AdminLoginPage />, { route: '/adm/login' });
    await signIn();
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/adm$/));
    expect(supabaseMock.auth.signOut).not.toHaveBeenCalled();
  });

  it('reports wrong credentials without calling the API', async () => {
    supabaseMock.auth.signInWithPassword.mockResolvedValueOnce({ data: { session: null, user: null }, error: { message: 'Invalid login credentials' } } as never);
    renderWithProviders(<AdminLoginPage />, { route: '/adm/login' });
    await signIn();
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.');
    expect(apiMock.get).not.toHaveBeenCalled();
  });
});
