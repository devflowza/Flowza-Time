import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);

import { renderWithProviders } from '@/features/employees/test-utils';
import { grant, grantAll, testState } from '@/features/employees/test-mocks';
import { Sidebar } from './sidebar';

describe('Sidebar', () => {
  beforeEach(() => {
    testState.orgId = 'org-1';
    testState.employeeId = null;
    testState.teamSize = 0;
    grantAll();
  });

  it('shows the "My team" section only to members with direct reports, whatever their permissions', () => {
    testState.employeeId = 'e1';
    testState.teamSize = 3;
    grant('dashboard.view');
    const { unmount } = renderWithProviders(<Sidebar />);
    expect(screen.getByText('My team')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Team overview' })).toHaveAttribute('href', '/team');
    unmount();
    testState.teamSize = 0;
    renderWithProviders(<Sidebar />);
    expect(screen.queryByRole('link', { name: 'Team overview' })).not.toBeInTheDocument();
  });

  it('renders navigation links with real utility classes, not a stringified className function', () => {
    // Regression: the links were wrapped in <TooltipTrigger asChild>, and Radix's Slot merges className by string
    // concatenation. A `className={({isActive}) => …}` render prop was therefore coerced to its own source text and
    // written into the class attribute verbatim — so `flex` never applied and every icon stacked above its label,
    // making each row 75px tall. Assert the rendered classes are actual utilities.
    const { container } = renderWithProviders(<Sidebar />);
    const links = [...container.querySelectorAll('a')];
    expect(links.length).toBeGreaterThan(5);
    for (const link of links) {
      expect(link.className).not.toContain('=>');
      expect(link.className).not.toContain('isActive');
    }
    expect(links[0]!.className.split(/\s+/)).toContain('flex');
  });

  it('marks the current route with aria-current so the active style has something to key off', () => {
    renderWithProviders(<Sidebar />, { route: '/employees' });
    const active = screen.getByRole('link', { name: 'Employees' });
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Devices' })).not.toHaveAttribute('aria-current');
  });

  it('hides the platform entry from an ordinary tenant user', () => {
    renderWithProviders(<Sidebar />);
    expect(screen.queryByRole('link', { name: 'Platform admin' })).not.toBeInTheDocument();
  });
});
