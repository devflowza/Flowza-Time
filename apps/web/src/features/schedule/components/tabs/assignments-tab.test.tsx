import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

/** The repo's cmdk Combobox: click opens the listbox, items are `[cmdk-item]`. */
async function openListbox(combobox: HTMLElement) {
  fireEvent.click(combobox);
  return within(await screen.findByRole('listbox'));
}
/** Pick an item and wait for its popover to be gone (a closing listbox would answer the next `findByRole('listbox')`). */
async function clickItem(el: HTMLElement) {
  fireEvent.click(el.closest('[cmdk-item]') ?? el);
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
}

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { testState } from '@/features/employees/test-mocks';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/schedule.json';
import ar from '@/locales/ar/schedule.json';
import { AssignmentsTab } from './assignments-tab';

registerNamespace('schedule', en, ar);

const MANAGER = 'e0000000-0000-4000-8000-000000000001';
const REPORT = 'e0000000-0000-4000-8000-000000000002';
const STRANGER = 'e0000000-0000-4000-8000-000000000003';
const SHIFT = '22222222-2222-4222-8222-222222222222';
const assignment = (id: string, targetId: string, targetName: string, canManage: boolean) => ({
  id, targetType: 'EMPLOYEE', targetId, targetName, branchId: 'b1', shiftId: SHIFT, shiftName: 'Morning', shiftPatternId: null, patternName: null,
  effectiveFrom: '2026-10-01', effectiveTo: null, createdBy: null, createdAt: '2026-10-01T00:00:00Z', canManage,
});

describe('Assignments tab for a line manager (field report 2026-10-21: no way to assign shifts)', () => {
  beforeEach(() => {
    resetApiMock();
    testState.employeeId = MANAGER;
    mockGet({
      '/orgs/org-1/shift-assignments': page([assignment('a-report', REPORT, 'Divya Report', true), assignment('a-other', STRANGER, 'Sam Stranger', false)]),
      '/orgs/org-1/shifts': page([{ id: SHIFT, code: 'M', name: 'Morning', type: 'FIXED', startTime: '09:00', endTime: '17:00', status: 'active', color: '#0a7' }]),
      '/orgs/org-1/shift-patterns': { data: [] },
      '/orgs/org-1/branches': page([]),
      '/orgs/org-1/teams': page([]),
      '/orgs/org-1/employees': page([
        { id: MANAGER, displayName: 'Mina Manager', employeeNumber: 'E-1' },
        { id: REPORT, displayName: 'Divya Report', employeeNumber: 'E-2' },
      ]),
    });
  });

  it('offers "Assign shift" with shift.assign_team alone, lets the manager pick direct reports only, and files an EMPLOYEE assignment', async () => {
    grant('shift.view', 'shift.assign_team', 'employee.view_team');
    apiMock.post.mockResolvedValue({ data: { ...assignment('new', REPORT, 'Divya Report', true), recalculationJobId: null } });
    renderWithProviders(<AssignmentsTab />);
    fireEvent.click((await screen.findAllByRole('button', { name: /Assign shift/ }))[0]!);
    const dialog = await screen.findByRole('dialog');
    // the target type is fixed to Employee and the hint says whose shifts these are
    expect(within(dialog).getByDisplayValue('Employee')).toHaveAttribute('readonly');
    expect(within(dialog).getByText(/employees who report to you directly/)).toBeInTheDocument();
    // the manager's own record (in the directory they can read) is not a choice
    const targets = await openListbox(within(dialog).getByRole('combobox', { name: /Target/ }));
    expect(await targets.findByText('Divya Report')).toBeInTheDocument();
    expect(targets.queryByText('Mina Manager')).not.toBeInTheDocument();
    await clickItem(targets.getByText('Divya Report'));
    const shifts = await openListbox(within(dialog).getByRole('combobox', { name: /^Shift/ }));
    await clickItem(await shifts.findByText('Morning'));
    expect(within(dialog).getAllByRole('combobox').map((c) => c.textContent)).toEqual(['Divya Report', 'Morning']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [path, body] = apiMock.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/orgs/org-1/shift-assignments');
    expect(body).toMatchObject({ targetType: 'EMPLOYEE', targetId: REPORT, shiftId: SHIFT });
  });

  it('shows End / Remove only on the rows the API says the manager can change', async () => {
    grant('shift.view', 'shift.assign_team', 'employee.view_team');
    renderWithProviders(<AssignmentsTab />);
    await screen.findAllByText('Divya Report');
    // one row-actions menu: the report's assignment; the stranger's assignment is read-only
    expect(screen.getAllByRole('button', { name: /actions/i }).filter((b) => b.closest('tr'))).toHaveLength(1);
  });

  it('offers nothing to assign without either key', async () => {
    grant('shift.view');
    renderWithProviders(<AssignmentsTab />);
    await screen.findAllByText('Divya Report');
    expect(screen.queryByRole('button', { name: /Assign shift/ })).not.toBeInTheDocument();
  });

  it('with shift.assign the target type stays selectable (organisation, branch, department, team, employee)', async () => {
    grant('shift.view', 'shift.assign');
    renderWithProviders(<AssignmentsTab />);
    fireEvent.click((await screen.findAllByRole('button', { name: /Assign shift/ }))[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('combobox', { name: /Assign to/ })).toBeInTheDocument();
    expect(within(dialog).queryByText(/employees who report to you directly/)).not.toBeInTheDocument();
  });
});
