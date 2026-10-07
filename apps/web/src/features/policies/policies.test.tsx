import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import './i18n';
import PoliciesPage from './pages/policies-page';
import { policiesRoutes } from './routes';

const OFFICE = { id: 'g1', code: 'OFFICE', name: 'Office staff', nameAr: 'موظفو المكتب', description: 'Head office', status: 'active', memberCount: 12, policyCount: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
const occurrences = { LATE: 3, VERY_LATE: 1, EARLY_DEPARTURE: 0, ABSENT: 1, MISSING_PUNCH: 0, UNEXCUSED: 0, REPEATED_LATE: 1 };
const POINTS = [
  { employeeId: 'e1', employeeNumber: 'EMP1', displayName: 'Aisha Al Balushi', branchId: 'b1', policyId: 'p1', policyName: 'Oman – Office Employees', pointsEnabled: true, points: 10.5, occurrences, escalation: { action: 'WRITTEN_WARNING', threshold: 10 }, nextEscalation: { action: 'FINAL_WARNING', threshold: 15 } },
  { employeeId: 'e2', employeeNumber: 'EMP2', displayName: 'Rahul Nair', branchId: 'b1', policyId: 'p2', policyName: 'Operations', pointsEnabled: false, points: 0, occurrences: { ...occurrences, LATE: 0, VERY_LATE: 0, ABSENT: 0, REPEATED_LATE: 0 }, escalation: null, nextEscalation: null },
];

beforeEach(() => { resetApiMock(); grantAll(); });
afterEach(() => { testState.disabledModules = new Set(); testState.allBranches = true; });

describe('Attendance policies page — employee groups', () => {
  it('lists the groups with their members and policies, and creates one', async () => {
    mockGet({ '/orgs/org-1/employee-groups': { data: [OFFICE] } });
    apiMock.post.mockResolvedValue({ data: { ...OFFICE, id: 'g2', code: 'SALES', name: 'Sales staff', memberCount: 0, policyCount: 0 } });
    renderWithProviders(<PoliciesPage />, { route: '/attendance/policies?tab=groups' });
    expect(await screen.findByRole('button', { name: 'Office staff' })).toBeInTheDocument();
    const row = screen.getByRole('button', { name: 'Office staff' }).closest('tr')!;
    expect(within(row).getByText('OFFICE')).toBeInTheDocument();
    expect(within(row).getByText('12')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add group' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Code/), { target: { value: 'SALES' } });
    fireEvent.change(within(dialog).getByLabelText(/^Name\b(?! \()/), { target: { value: 'Sales staff' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [path, body] = apiMock.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/orgs/org-1/employee-groups');
    expect(body).toEqual({ code: 'SALES', name: 'Sales staff', nameAr: null, description: '', status: 'active' });
  });

  it('a branch-scoped manager sees the groups but cannot change them', async () => {
    testState.allBranches = false;
    mockGet({ '/orgs/org-1/employee-groups': { data: [OFFICE] } });
    renderWithProviders(<PoliciesPage />, { route: '/attendance/policies?tab=groups' });
    expect(await screen.findByRole('button', { name: 'Office staff' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add group' })).toBeNull();
  });
});

describe('Attendance policies page — points & discipline', () => {
  it('shows each employee\'s points under their policy with the escalation reached, and "off" for a policy without points', async () => {
    let lastQuery: Record<string, unknown> | undefined;
    mockGet({ '/orgs/org-1/attendance-policies/points': (q: Record<string, unknown> | undefined) => { lastQuery = q; return { ...page(POINTS), meta: { ...page(POINTS).meta, asOf: '2026-03-31' } }; } });
    renderWithProviders(<PoliciesPage />, { route: '/attendance/policies?tab=points&asOf=2026-03-31' });
    // DataTable renders a table and a card fallback: every value exists twice
    expect((await screen.findAllByText('Written warning')).length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('escalation-badge')[0]).toHaveTextContent('Written warning');
    expect(screen.getAllByText('10.5').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Final warning at 15').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Off').length).toBeGreaterThan(0);
    expect(lastQuery).toMatchObject({ asOf: '2026-03-31', page: 1 });
  });

  it('opens an employee\'s events', async () => {
    mockGet({
      '/orgs/org-1/attendance-policies/points': { ...page(POINTS), meta: { ...page(POINTS).meta, asOf: '2026-03-31' } },
      '/orgs/org-1/attendance-policies/points/e1': { data: { ...POINTS[0], asOf: '2026-03-31', windowFrom: '2026-01-01', events: [{ date: '2026-03-10', kind: 'VERY_LATE', points: 2, expiresOn: '2026-06-08', policyId: 'p1' }, { date: '2026-03-11', kind: 'ABSENT', points: 3, expiresOn: '2026-06-09', policyId: 'p1' }] } },
    });
    renderWithProviders(<PoliciesPage />, { route: '/attendance/policies?tab=points&asOf=2026-03-31' });
    fireEvent.click((await screen.findAllByText('Aisha Al Balushi'))[0]!);
    const drawer = await screen.findByTestId('points-drawer');
    expect(await within(drawer).findByText('Very late')).toBeInTheDocument();
    expect(within(drawer).getByText('Absent')).toBeInTheDocument();
    expect(within(drawer).getByText('+3')).toBeInTheDocument();
  });
});

describe('Attendance policies — module and permission gates', () => {
  it('the route explains a missing module instead of rendering the page', async () => {
    testState.disabledModules = new Set(['attendance_policies']);
    renderWithProviders(<>{policiesRoutes[0]!.element}</>);
    expect(await screen.findByText(/is not part of your subscription/)).toBeInTheDocument();
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it('the route needs attendance.view', async () => {
    grant('shift.view');
    renderWithProviders(<>{policiesRoutes[0]!.element}</>);
    expect(await screen.findByText('You do not have permission to view this page.')).toBeInTheDocument();
  });
});
