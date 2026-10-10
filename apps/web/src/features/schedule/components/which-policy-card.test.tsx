import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import type { PolicyResolutionDto, PolicyScopeDto } from '@flowza/contracts';
import { grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/schedule.json';
import ar from '@/locales/ar/schedule.json';
import { BR1, BRANCHES, N_B1, N_F2, N_HQ, N_SA, N_SB, locationRoutes } from '@/features/scheduling/test-locations';
import { WhichPolicyCard } from './which-policy-card';

registerNamespace('schedule', en, ar);

const EMP = 'e0000000-0000-4000-8000-000000000001';
const none: PolicyScopeDto = { countryCode: null, branchId: null, departmentId: null, employeeGroupId: null, shiftId: null, locationId: null };
const candidate = (id: string, name: string, scope: Partial<PolicyScopeDto>, matches: boolean, mismatch: PolicyResolutionDto['candidates'][number]['mismatch'] = null) =>
  ({ id, name, scope: { ...none, ...scope }, effectiveFrom: '2026-01-01', effectiveTo: null, specificity: 4, matches, mismatch });
/** Aisha works on Floor 2 of Site A in Branch 1: the Site A policy is the deepest on her chain; Site B's is not on it. */
const RESOLUTION: PolicyResolutionDto = {
  employeeId: EMP, date: '2026-10-10',
  scope: { ...none, countryCode: 'OM', branchId: BR1, locationId: N_F2, locationIds: [N_HQ, N_B1, N_SA, N_F2] },
  policy: { id: 'p-site-a', name: 'Site A policy', specificity: 4 },
  candidates: [
    candidate('p-site-a', 'Site A policy', { branchId: BR1, locationId: N_SA }, true),
    candidate('p-branch', 'Branch 1 policy', { branchId: BR1 }, true),
    candidate('p-site-b', 'Site B policy', { branchId: BR1, locationId: N_SB }, false, 'LOCATION'),
  ],
};

describe('Which policy applies? — the location chain', () => {
  beforeEach(() => {
    resetApiMock(); grantAll();
    mockGet({
      ...locationRoutes(), '/orgs/org-1/branches': page(BRANCHES),
      '/orgs/org-1/employees': page([{ id: EMP, displayName: 'Aisha Al Balushi', employeeNumber: 'E-1' }]),
      '/orgs/org-1/attendance-policies/resolve': { data: RESOLUTION },
    });
  });

  it('shows where the employee sits as a path, the place policy that wins and why another place\'s does not apply', async () => {
    renderWithProviders(<WhichPolicyCard />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Employee' }));
    fireEvent.click(await screen.findByRole('option', { name: /Aisha Al Balushi/ }));
    await waitFor(() => expect(screen.getByTestId('which-policy-location')).toHaveTextContent('Muscat HQ › Branch 1 › Site A › Floor 2'));
    expect(screen.getByTestId('which-policy-branch')).toHaveTextContent('Branch 1');
    expect(screen.getByTestId('which-policy-winner')).toHaveTextContent('Site A policy');
    const winner = screen.getByTestId('which-policy-candidate-p-site-a');
    expect(within(winner).getByText('Applies')).toBeInTheDocument();
    expect(winner).toHaveTextContent('Muscat HQ › Branch 1 › Site A');
    expect(screen.getByTestId('which-policy-candidate-p-branch')).toHaveTextContent('Matches, but a more specific policy wins');
    const other = screen.getByTestId('which-policy-candidate-p-site-b');
    expect(other).toHaveTextContent('Another location: the employee does not work there');
    expect(other).toHaveTextContent('Muscat HQ › Branch 1 › Site B');
  });

  it('an organisation without a hierarchy shows no location column', async () => {
    mockGet({
      '/orgs/org-1/location-levels': { data: [] }, '/orgs/org-1/locations': { data: [] }, '/orgs/org-1/branches': page(BRANCHES),
      '/orgs/org-1/employees': page([{ id: EMP, displayName: 'Aisha Al Balushi', employeeNumber: 'E-1' }]),
      '/orgs/org-1/attendance-policies/resolve': { data: { ...RESOLUTION, scope: { ...RESOLUTION.scope, locationId: N_B1, locationIds: [N_B1] }, candidates: [] } },
    });
    renderWithProviders(<WhichPolicyCard />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Employee' }));
    fireEvent.click(await screen.findByRole('option', { name: /Aisha Al Balushi/ }));
    expect(await screen.findByTestId('which-policy-branch')).toBeInTheDocument();
    expect(screen.queryByTestId('which-policy-location')).toBeNull();
  });
});
