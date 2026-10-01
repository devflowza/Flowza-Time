import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';

const h = vi.hoisted(() => ({ recovery: false, toastError: vi.fn() }));

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('./auth-provider', () => ({ useAuth: () => ({ session: null, user: null, loading: false, recovery: h.recovery, signOut: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: h.toastError } }));

import '@/lib/i18n';
import { resetAuthCallbackForTests } from '@/lib/auth-callback';
import { AuthGate } from './auth-gate';

function renderAt(path: string) {
  const router = createMemoryRouter([{ element: <AuthGate />, children: [
    { path: '/', element: <p>home</p> },
    { path: '/my', element: <p>portal</p> },
    { path: '/auth/reset', element: <p>reset page</p> },
  ] }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe('AuthGate', () => {
  beforeEach(() => { h.recovery = false; h.toastError.mockReset(); resetAuthCallbackForTests(); });
  afterEach(() => { window.history.replaceState(null, '', '/'); resetAuthCallbackForTests(); });

  it('keeps a session opened by a reset link on the reset page, whatever path it asks for', async () => {
    h.recovery = true;
    const router = renderAt('/my');
    expect(await screen.findByText('reset page')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/auth/reset');
  });

  it('lets every other session through', () => {
    renderAt('/my');
    expect(screen.getByText('portal')).toBeInTheDocument();
  });

  it('reports an e-mail link Supabase refused once, with the way to a new one', async () => {
    window.history.replaceState(null, '', '/?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    renderAt('/');
    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1));
    expect(h.toastError).toHaveBeenCalledWith('That e-mail link has expired or was already used', expect.objectContaining({ action: expect.objectContaining({ label: 'Request a new link' }) }));
  });

  it('leaves that to the reset page when the link opened it', async () => {
    window.history.replaceState(null, '', '/auth/reset?error=access_denied&error_code=otp_expired');
    renderAt('/auth/reset');
    expect(await screen.findByText('reset page')).toBeInTheDocument();
    expect(h.toastError).not.toHaveBeenCalled();
  });
});
