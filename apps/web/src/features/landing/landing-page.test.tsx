import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
const auth = vi.hoisted(() => ({ state: { session: null as { access_token: string } | null, loading: false } }));
vi.mock('@/features/auth/auth-provider', () => ({ useAuth: () => auth.state }));

import i18n from '@/lib/i18n';
import { RequireAuth } from '@/components/layout/protected-route';
import { LocationDisplay } from '@/features/employees/test-utils';

function renderApp(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/auth/sign-in" element={<p>sign-in form</p>} />
        <Route path="/auth/sign-up" element={<p>sign-up form</p>} />
        <Route element={<RequireAuth />}>
          <Route index element={<p>dashboard</p>} />
          <Route path="employees" element={<p>employees</p>} />
        </Route>
      </Routes>
      <LocationDisplay />
    </MemoryRouter>,
  );
}

describe('the public front page', () => {
  beforeEach(async () => {
    auth.state = { session: null, loading: false };
    await i18n.changeLanguage('en');
  });

  it('is what an anonymous visitor sees at the root, with the way in and the FlowZa copyright', () => {
    renderApp('/');
    expect(screen.getByRole('heading', { level: 1, name: 'FlowZa Time — Cloud Attendance System' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
    const main = screen.getByRole('main');
    expect(within(main).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/sign-in');
    expect(within(main).getByRole('link', { name: 'Create account' })).toHaveAttribute('href', '/auth/sign-up');
    expect(screen.getByRole('contentinfo')).toHaveTextContent(`© ${new Date().getFullYear()} FlowZa. All rights reserved.`);
    expect(screen.queryByText('dashboard')).not.toBeInTheDocument();
  });

  it('pins the FlowZa style whatever style the last organisation left on the document', () => {
    document.documentElement.setAttribute('data-theme', 'midnight');
    const { container } = renderApp('/');
    expect(container.querySelector('[data-theme]')).toHaveAttribute('data-theme', 'emerald');
    document.documentElement.removeAttribute('data-theme');
  });

  it('still sends a deep link to the sign-in form', () => {
    renderApp('/employees');
    expect(screen.getByText('sign-in form')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('gives a signed-in member the app, not the front page', () => {
    auth.state = { session: { access_token: 'token' }, loading: false };
    renderApp('/');
    expect(screen.getByText('dashboard')).toBeInTheDocument();
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument();
  });

  it('renders nothing while the session is still being restored', () => {
    auth.state = { session: null, loading: true };
    renderApp('/');
    expect(screen.queryByRole('main')).not.toBeInTheDocument();
  });

  it('reads in Arabic, keeping the copyright line in its Latin order', async () => {
    await i18n.changeLanguage('ar');
    renderApp('/');
    expect(screen.getByRole('heading', { level: 1, name: 'فلوزا تايم — نظام الحضور السحابي' })).toBeInTheDocument();
    const footer = screen.getByRole('contentinfo');
    expect(footer).toHaveTextContent('جميع الحقوق محفوظة.');
    expect(within(footer).getByText(/© \d{4}/).closest('[dir="ltr"]')).not.toBeNull();
  });
});
