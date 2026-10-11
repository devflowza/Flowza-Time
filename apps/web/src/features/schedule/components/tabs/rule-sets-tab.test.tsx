import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/schedule.json';
import ar from '@/locales/ar/schedule.json';
import { BR1, BRANCHES, N_B1, N_SA, locationRoutes } from '@/features/scheduling/test-locations';
import { RuleSetsTab } from './rule-sets-tab';

registerNamespace('schedule', en, ar);

const GROUP = '0a000000-0000-4000-8000-0000000000c1';
const base = { description: '', branchId: null, countryCode: null, departmentId: null, employeeGroupId: null, shiftId: null, effectiveFrom: '2026-01-01', effectiveTo: null, version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', graceInMinutes: 10, minFullDayMinutes: 420, overtimeEnabled: true, overtimeStartAfterMinutes: 0, ramadanMode: { enabled: false, appliesTo: 'all' }, policy: { points: { enabled: false } } };
const POLICIES = [
  { ...base, id: 'p-org', name: 'Organisation default', specificity: 0 },
  { ...base, id: 'p-group', name: 'Oman – Office Employees', countryCode: 'OM', employeeGroupId: GROUP, specificity: 18, policy: { points: { enabled: true } } },
];

describe('Rules tab — attendance policies', () => {
  beforeEach(() => {
    resetApiMock(); grantAll();
    mockGet({ '/orgs/org-1/attendance-rule-sets': { data: POLICIES }, '/orgs/org-1/employee-groups': { data: [{ id: GROUP, code: 'OFFICE', name: 'Office staff', nameAr: null, description: '', status: 'active', memberCount: 3, policyCount: 1, createdAt: '', updatedAt: '' }] } });
  });
  afterEach(() => { testState.disabledModules = new Set(); });

  it('lists the most specific policy first with its scope chips, and offers "Which policy applies?"', async () => {
    renderWithProviders(<RuleSetsTab />);
    const rows = await screen.findAllByRole('row');
    expect(within(rows[1]!).getByText('Oman – Office Employees')).toBeInTheDocument();
    expect(within(rows[1]!).getByTestId('scope-country')).toHaveTextContent('Oman');
    expect(await within(rows[1]!).findByText('Office staff')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('18')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Organisation-wide')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Specificity' })).toBeInTheDocument();
    expect(screen.getByTestId('which-policy-card')).toBeInTheDocument();
  });

  it('without the module: no specificity column and no resolution card', async () => {
    testState.disabledModules = new Set(['attendance_policies']);
    renderWithProviders(<RuleSetsTab />);
    expect(await screen.findByText('Organisation default')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Specificity' })).toBeNull();
    expect(screen.queryByTestId('which-policy-card')).toBeNull();
  });
});

describe('Rules tab — policies by location (docs/locations.md §3)', () => {
  const LOCATED = [
    { ...base, id: 'p-site', name: 'Site A policy', branchId: BR1, locationId: N_SA, specificity: 4 },
    { ...base, id: 'p-branch', name: 'Branch 1 policy', branchId: BR1, locationId: null, specificity: 4 },
  ];
  let lastQuery: Record<string, unknown> | undefined;
  beforeEach(() => {
    resetApiMock(); grantAll(); lastQuery = undefined;
    mockGet({ ...locationRoutes(), '/orgs/org-1/branches': page(BRANCHES), '/orgs/org-1/attendance-rule-sets': (q: Record<string, unknown> | undefined) => { lastQuery = q; return { data: LOCATED }; } });
  });

  it('shows the scope as a path of the tree and says that the deeper location wins', async () => {
    renderWithProviders(<RuleSetsTab />);
    await waitFor(() => expect(screen.getByTestId('scope-location')).toHaveTextContent('Muscat HQ › Branch 1 › Site A'));
    // a branch policy reads as its node's path below the groups
    expect(screen.getByTestId('scope-branch')).toHaveTextContent('Muscat HQ › Branch 1');
    expect(screen.getByRole('columnheader', { name: 'Specificity' }).getAttribute('title')).toMatch(/deeper one wins/);
  });

  it('filters by the policies\' own location: any node of the tree, by its id', async () => {
    renderWithProviders(<RuleSetsTab />);
    const filter = await screen.findByRole('combobox', { name: 'Location' });
    expect(filter).toHaveTextContent('Any location');
    fireEvent.click(filter);
    fireEvent.click(await screen.findByRole('option', { name: /^Site A/ }));
    await waitFor(() => expect(lastQuery).toMatchObject({ locationId: N_SA }));
    expect(lastQuery?.['branchId']).toBeUndefined();
    // a branch's node too (the API matches the branch's own policies)
    fireEvent.click(screen.getByRole('combobox', { name: 'Location' }));
    fireEvent.click(await screen.findByRole('option', { name: /^Branch 1/ }));
    await waitFor(() => expect(lastQuery).toMatchObject({ locationId: N_B1 }));
    expect(lastQuery?.['branchId']).toBeUndefined();
  });
});
