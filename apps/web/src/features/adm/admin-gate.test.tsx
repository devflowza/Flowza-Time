import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);
const auth = vi.hoisted(() => ({ session: { access_token: 't' } as unknown }));
vi.mock('@/features/auth/auth-provider', () => ({ useAuth: () => ({ session: auth.session, user: null, loading: false, signOut: vi.fn() }) }));

import { renderWithProviders, testState } from '@/features/employees/test-utils';
import './i18n';
import { AdminGate } from './admin-gate';

const tree = <Routes><Route path="/adm/login" element={<p>admin sign-in</p>} /><Route element={<AdminGate />}><Route path="*" element={<p>portal content</p>} /></Route></Routes>;

describe('AdminGate', () => {
  afterEach(() => { auth.session = { access_token: 't' }; testState.orgId = 'org-1'; });

  it('sends a visitor without a session to the admin sign-in', async () => {
    auth.session = null;
    renderWithProviders(tree, { route: '/adm/tenants' });
    expect(await screen.findByTestId('location')).toHaveTextContent('/adm/login');
  });

  it('refuses a signed-in tenant user who is not a platform administrator', () => {
    testState.orgId = 'org-1'; // the mock's member is no platform admin
    renderWithProviders(tree, { route: '/adm' });
    expect(screen.getByText('Not a platform administrator')).toBeInTheDocument();
    expect(screen.queryByText('portal content')).not.toBeInTheDocument();
  });

  it('renders the portal for a platform administrator', () => {
    testState.orgId = null; // the mock's user without a membership is a platform admin
    renderWithProviders(tree, { route: '/adm' });
    expect(screen.getByText('portal content')).toBeInTheDocument();
  });
});
