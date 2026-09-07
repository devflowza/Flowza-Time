import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

const h = vi.hoisted(() => ({ me: null as { isLoading: boolean; isError: boolean; error?: unknown; data?: unknown; refetch: () => void } | null }));

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);
vi.mock('@/features/auth/auth-provider', () => ({ useAuth: () => ({ session: {}, user: null, loading: false, signOut: vi.fn() }) }));
vi.mock('@/features/me/use-me', async () => {
  const { useMeModule } = await import('@/features/employees/test-mocks');
  return { ...useMeModule, useMe: () => h.me ?? useMeModule.useMe() };
});

import { ApiError, renderWithProviders, supabaseMock } from '@/features/employees/test-utils';
import { AppShell } from './app-shell';

describe('AppShell', () => {
  beforeEach(() => {
    h.me = null;
    supabaseMock.auth.mfa.listFactors.mockResolvedValue({ data: { totp: [], all: [] }, error: null });
  });

  it('shows the enrolment gate — not the generic error — when /me is refused for a session below aal2', async () => {
    h.me = { isLoading: false, isError: true, error: new ApiError(403, 'FORBIDDEN', 'MFA needed', 'r1', { reason: 'MFA_REQUIRED' }), refetch: vi.fn() };
    renderWithProviders(<AppShell />);
    expect(await screen.findByText('Two-factor authentication required')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Set up authenticator' })).toBeInTheDocument();
  });

  it('still shows the generic error state for any other failure', async () => {
    h.me = { isLoading: false, isError: true, error: new ApiError(500, 'INTERNAL', 'boom'), refetch: vi.fn() };
    renderWithProviders(<AppShell />);
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('Two-factor authentication required')).not.toBeInTheDocument();
  });
});
