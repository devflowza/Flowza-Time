import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { LocationLevelRole } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { BranchesTab } from './branches-tab';

/** Waits that need the levels and the locations to load (slower when the whole suite runs in parallel). */
const SLOW = { timeout: 5_000 };

const T = '2026-10-10T00:00:00Z';
const level = (id: string, position: number, role: LocationLevelRole, name: string) => ({ id, organizationId: 'org-1', position, role, name, nameAr: null, icon: 'other', locationCount: 1, createdAt: T, updatedAt: T });
const node = (id: string, parentId: string | null, levelId: string, role: LocationLevelRole, name: string, branchId: string | null = null) => ({
  id, organizationId: 'org-1', levelId, role, parentId, branchId, code: name.toUpperCase(), name, nameAr: null, latitude: null, longitude: null,
  path: [], depth: 1, status: 'active', employeeCount: 0, deviceCount: 0, childCount: 0, createdAt: T, updatedAt: T,
});
const branch = (id: string, code: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, organizationId: 'org-1', code, name, nameAr: null, countryCode: 'OM', city: null, address: {}, timezone: 'Asia/Muscat', latitude: null, longitude: null,
  geofenceRadiusM: null, contact: {}, weeklyOffDays: null, holidayCalendarId: null, status: 'active', createdAt: T, updatedAt: T, ...extra,
});
const BRANCHES = page([
  branch('b1', 'SOH', 'Sohar', { parentLocationId: 'n-north' }),
  branch('b2', 'MCT', 'Muscat', { parentLocationId: null }),
  branch('b3', 'SUR', 'Sur'), // an older API without the field: the tree says where it sits
]);
const NODES = [
  node('n-hq', null, 'l-hq', 'group', 'Muscat HQ'), node('n-north', 'n-hq', 'l-rg', 'group', 'Northern Region'),
  node('n-b1', 'n-north', 'l-br', 'branch', 'Sohar', 'b1'), node('n-b2', null, 'l-br', 'branch', 'Muscat', 'b2'), node('n-b3', 'n-hq', 'l-br', 'branch', 'Sur', 'b3'),
];
const rowOf = (code: string) => screen.getAllByText(code).map((el) => el.closest('tr')).find(Boolean)!;

describe('BranchesTab — where each branch sits', () => {
  beforeEach(() => { resetApiMock(); grantAll(); });

  it('shows a "Part of" column with the path of the group location, or a dash at the top level', async () => {
    mockGet({
      '/orgs/org-1/branches': BRANCHES,
      '/orgs/org-1/location-levels': { data: [level('l-hq', 1, 'group', 'Headquarters'), level('l-rg', 2, 'group', 'Region'), level('l-br', 3, 'branch', 'Branch')] },
      '/orgs/org-1/locations': { data: NODES },
    });
    renderWithProviders(<BranchesTab />);
    expect(await screen.findByRole('columnheader', { name: 'Part of' }, SLOW)).toBeInTheDocument();
    expect(within(rowOf('SOH')).getByText('Muscat HQ › Northern Region')).toBeInTheDocument();
    expect(within(rowOf('MCT')).getAllByText('—').length).toBeGreaterThan(0);
    expect(within(rowOf('MCT')).queryByText(/Muscat HQ/)).toBeNull();
    expect(within(rowOf('SUR')).getByText('Muscat HQ')).toBeInTheDocument();
  });

  it('has no such column while the organisation has no level above its branches', async () => {
    mockGet({
      '/orgs/org-1/branches': BRANCHES,
      '/orgs/org-1/location-levels': { data: [level('l-br', 1, 'branch', 'Branch')] },
      '/orgs/org-1/locations': { data: NODES.filter((n) => n.role === 'branch') },
    });
    renderWithProviders(<BranchesTab />);
    await screen.findAllByText('SOH', {}, SLOW);
    expect(screen.queryByRole('columnheader', { name: 'Part of' })).toBeNull();
  });
});
