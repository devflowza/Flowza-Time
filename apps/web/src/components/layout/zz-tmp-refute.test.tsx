import { describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);
vi.mock('@/features/auth/auth-provider', () => ({ useAuth: () => ({ session: {}, user: null, loading: false, signOut: vi.fn() }) }));
vi.mock('@/features/me/use-me', async () => {
  const { useMeModule } = await import('@/features/employees/test-mocks');
  return { ...useMeModule, useMe: () => ({ isLoading: false, isError: false, isFetching: false, data: { user: { id: 'u1', email: 'dev@flowza.ai', fullName: 'Owner', avatarUrl: null, locale: 'en', mfaEnrolled: true, isPlatformAdmin: true }, memberships: [] }, refetch: vi.fn() }) };
});
import { AppShell } from './app-shell';
import { TooltipProvider } from '@/components/ui';
import { LocationDisplay, testState } from '@/features/employees/test-utils';

describe('tmp', () => {
  it('what renders at /platform for an org-less platform admin (HEAD behaviour, unchanged by the diff)', async () => {
    testState.orgId = null;
    const client = new QueryClient();
    render(<QueryClientProvider client={client}><TooltipProvider><MemoryRouter initialEntries={['/platform']}><Routes><Route element={<AppShell />}><Route path="platform" element={<div>PLATFORM PAGE</div>} /><Route index element={<div>DASHBOARD</div>} /></Route></Routes><LocationDisplay /></MemoryRouter></TooltipProvider></QueryClientProvider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    console.log('LOCATION=', screen.getByTestId('location').textContent, 'PLATFORM PAGE present=', !!screen.queryByText('PLATFORM PAGE'), 'BODY=', document.body.innerHTML.slice(0, 300));
    expect(true).toBe(true);
  });
});
