import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { grantAll, mockGet, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/schedule.json';
import ar from '@/locales/ar/schedule.json';
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
