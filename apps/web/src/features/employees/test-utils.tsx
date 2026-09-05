/* eslint-disable react-refresh/only-export-components */
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { render, type RenderOptions } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui';
import i18n from '@/lib/i18n';
import { registerNamespace } from '@/lib/i18n-namespace';
import enEmployees from '@/locales/en/employees.json';
import arEmployees from '@/locales/ar/employees.json';
import enOrganization from '@/locales/en/organization.json';
import arOrganization from '@/locales/ar/organization.json';
import enUsers from '@/locales/en/users.json';
import arUsers from '@/locales/ar/users.json';
import enSettings from '@/locales/en/settings.json';
import arSettings from '@/locales/ar/settings.json';
import enAudit from '@/locales/en/audit.json';
import arAudit from '@/locales/ar/audit.json';
import enSearch from '@/locales/en/search.json';
import arSearch from '@/locales/ar/search.json';

/**
 * Shared test harness for the workforce/administration features (employees, organization, users, settings, audit, search).
 * Each test file must hoist the module mocks itself — from ./test-mocks, never from this file (import deadlock), e.g.
 *   vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
 *   vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
 *   vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
 *   vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);
 */

// ---- jsdom polyfills needed by Radix / cmdk ------------------------------------------------------------------------
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
}
if (typeof Element !== 'undefined') {
  Element.prototype.scrollIntoView ??= () => {};
  (Element.prototype as unknown as { hasPointerCapture?: () => boolean }).hasPointerCapture ??= () => false;
  (Element.prototype as unknown as { releasePointerCapture?: () => void }).releasePointerCapture ??= () => {};
  (Element.prototype as unknown as { setPointerCapture?: () => void }).setPointerCapture ??= () => {};
}

// ---- module mocks live in ./test-mocks.ts (no application imports; see the note there) ------------------------------
export { ApiError, apiClientModule, apiFetchMock, apiMock, envModule, grant, grantAll, mockGet, page, resetApiMock, supabaseMock, supabaseModule, testState, useMeModule } from './test-mocks';

// ---- render helpers -------------------------------------------------------------------------------------------------
registerNamespace('employees', enEmployees, arEmployees);
registerNamespace('organization', enOrganization, arOrganization);
registerNamespace('users', enUsers, arUsers);
registerNamespace('settings', enSettings, arSettings);
registerNamespace('audit', enAudit, arAudit);
registerNamespace('search', enSearch, arSearch);
void i18n.changeLanguage('en');

export function LocationDisplay() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname + loc.search}</output>;
}

export function renderWithProviders(ui: ReactNode, { route = '/', path = '*', ...options }: { route?: string; path?: string } & Omit<RenderOptions, 'wrapper'> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 }, mutations: { retry: 0 } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[route]}>
          <Routes><Route path={path} element={<>{ui}<LocationDisplay /></>} /></Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
    options,
  );
  return { ...utils, client };
}
