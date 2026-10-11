import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { grant, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import OrganizationPage from './organization-page';

/** Waits that need the levels and the locations to load (slower when the whole suite runs in parallel). */
const SLOW = { timeout: 5_000 };

const T = '2026-10-10T00:00:00Z';

describe('OrganizationPage', () => {
  beforeEach(() => {
    resetApiMock();
    mockGet({
      '/orgs/org-1/branches': page([]),
      '/orgs/org-1/location-levels': { data: [{ id: 'l-br', organizationId: 'org-1', position: 1, role: 'branch', name: 'Branch', nameAr: 'فرع', icon: 'branch', locationCount: 0, createdAt: T, updatedAt: T }] },
      '/orgs/org-1/locations': { data: [] },
    });
  });

  it('puts Locations after Branches for members who can view branches, and opens it from ?tab=locations', async () => {
    grant('branch.view');
    renderWithProviders(<OrganizationPage />, { route: '/organization?tab=locations' });
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Branches', 'Locations']);
    expect(screen.getByRole('tab', { name: 'Locations' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('heading', { name: 'Levels' }, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Location tree' })).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Branches' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/organization?tab=branches'));
  });
});
