import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { EmployeeDto, OrgChartNodeDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '../test-utils';
import { ApiError } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { idSegment } from '../api';
import { orgChartPathQuery } from '../org-chart/api';
import OrgChartPage from './org-chart-page';

const node = (id: string, name: string, extra: Partial<OrgChartNodeDto> = {}): OrgChartNodeDto => ({
  id, employeeNumber: `N-${id}`, displayName: name, displayNameAr: null, photoUrl: null, designationName: 'Engineer', departmentName: 'IT', branchId: 'b1', branchName: 'Muscat',
  employmentStatus: 'active', managerEmployeeId: null, secondaryManagerEmployeeId: null, secondaryManagerName: null, directReportCount: 0, ...extra,
});
const emp = (id: string, name: string, extra: Partial<EmployeeDto> = {}): EmployeeDto => ({
  id, organizationId: 'org-1', employeeNumber: `N-${id}`, firstName: name, middleName: null, lastName: 'X', displayName: name, displayNameAr: null, photoPath: null, photoUrl: null, gender: 'unspecified', dateOfBirth: null, nationalityCode: null,
  email: null, phone: null, joiningDate: '2024-02-01', exitDate: null, employmentStatus: 'active', employmentType: 'full_time', branchId: 'b1', branchName: 'Muscat', departmentId: null, departmentName: null, designationId: null, designationName: null,
  managerEmployeeId: null, managerName: null, secondaryManagerEmployeeId: null, secondaryManagerName: null, userId: null, deviceUserId: id, cardNumber: null, fingerprintEnrolled: false, faceEnrolled: false, weeklyOffDays: null, customFields: {},
  deviceSyncSummary: { total: 0, inSync: 0, pending: 0, failed: 0, offline: 0 }, deletedAt: null, createdAt: '2024-02-01T00:00:00Z', updatedAt: '2024-02-01T00:00:00Z', ...extra,
} as EmployeeDto);

// Salim (CEO) ← Huda (CTO) ← Aisha;  Salim ← Omar (CFO, dotted line to Huda);  Nasser and Laila are not on the chart yet.
// The people a `?focus=` lands on carry real ids: the page takes nothing else from the URL.
const DEV_ID = '0d0d0d0d-0000-4000-8000-000000000004';
const NASSER_ID = '0d0d0d0d-0000-4000-8000-000000000005';
const GONE_ID = '0d0d0d0d-0000-4000-8000-000000000007';
const CEO = node('ceo', 'Salim Al-Busaidi', { designationName: 'Chief executive', directReportCount: 2 });
const CTO = node('cto', 'Huda Al-Lawati', { managerEmployeeId: 'ceo', directReportCount: 1 });
const CFO = node('cfo', 'Omar Al-Rawahi', { managerEmployeeId: 'ceo', secondaryManagerEmployeeId: 'cto', secondaryManagerName: 'Huda Al-Lawati' });
const DEV = node(DEV_ID, 'Aisha Al-Hinai', { managerEmployeeId: 'cto', employeeNumber: 'N-dev' });
const NASSER = node(NASSER_ID, 'Nasser Al-Kindi', { employeeNumber: 'N-nasser' });
const LAILA = node('laila', 'Laila Al-Farsi');
const EMPLOYEES = [
  emp('ceo', 'Salim Al-Busaidi'), emp('cto', 'Huda Al-Lawati', { managerEmployeeId: 'ceo', managerName: 'Salim Al-Busaidi' }), emp('cfo', 'Omar Al-Rawahi', { managerEmployeeId: 'ceo', managerName: 'Salim Al-Busaidi' }),
  emp(DEV_ID, 'Aisha Al-Hinai', { managerEmployeeId: 'cto', managerName: 'Huda Al-Lawati', employeeNumber: 'N-dev' }), emp(NASSER_ID, 'Nasser Al-Kindi', { employeeNumber: 'N-nasser' }), emp('laila', 'Laila Al-Farsi'),
  emp(GONE_ID, 'Khalfan Left', { employmentStatus: 'resigned' }),
];

type Query = Record<string, unknown> | undefined;
const levels = (q: Query) => {
  if (q?.['managerId'] === 'ceo') return page([CTO, CFO]);
  if (q?.['managerId'] === 'cto') return page([DEV]);
  if (q?.['managerId']) return page([]);
  if (q?.['view'] === 'unassigned') return page(q['search'] ? [NASSER, LAILA].filter((n) => n.employeeNumber === q['search']) : [NASSER, LAILA]);
  return page([CEO]);
};
const routes = (extra: Record<string, unknown> = {}) => ({
  '/orgs/org-1/org-chart': levels, '/orgs/org-1/employees': page(EMPLOYEES), '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]), ...extra,
});
const orgChartCalls = () => apiMock.get.mock.calls.filter(([path]) => path === '/orgs/org-1/org-chart').map(([, q]) => q as Record<string, unknown>);
const openMenu = async (card: HTMLElement, name: string, item: RegExp) => {
  fireEvent.keyDown(within(card).getByRole('button', { name: `Actions for ${name}` }), { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
};
const expand = async (id: string) => {
  const card = await screen.findByTestId(`org-card-${id}`);
  fireEvent.click(within(card).getByRole('button', { name: /reports?$/ }));
};
const pick = async (dialog: HTMLElement, field: RegExp, option: RegExp) => {
  fireEvent.click(within(dialog).getByRole('combobox', { name: field }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
};

describe('OrgChartPage', () => {
  beforeEach(() => { resetApiMock(); grantAll(); apiMock.post.mockResolvedValue({ data: { updated: 1, employeeIds: ['x'] } }); });

  it('draws the heads of the chart and opens a card\'s team on demand (GET ?managerId=), with the dotted line on the card', async () => {
    mockGet(routes());
    renderWithProviders(<OrgChartPage />, { route: '/employees/org-chart' });
    const ceo = await screen.findByTestId('org-card-ceo');
    expect(within(ceo).getByRole('link', { name: 'Salim Al-Busaidi' })).toHaveAttribute('href', '/employees/ceo');
    expect(within(ceo).getByText('Chief executive')).toBeInTheDocument();
    expect(within(ceo).getByText('IT · Muscat')).toBeInTheDocument();
    expect(orgChartCalls()).toContainEqual(expect.objectContaining({ view: 'top', page: 1, pageSize: 100 }));
    // the team is not fetched until it is opened
    expect(orgChartCalls().some((q) => q['managerId'])).toBe(false);

    const toggle = within(ceo).getByRole('button', { name: 'Salim Al-Busaidi: 2 reports' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const cto = await screen.findByTestId('org-card-cto');
    expect(orgChartCalls()).toContainEqual(expect.objectContaining({ managerId: 'ceo', page: 1, pageSize: 100 }));
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toContainElement(cto);
    expect(within(screen.getByTestId('org-card-cfo')).getByText('Also reports to Huda Al-Lawati')).toBeInTheDocument();
    // a card without reports has nothing to expand
    expect(within(screen.getByTestId('org-card-cfo')).queryByRole('button', { name: /reports?$/ })).not.toBeInTheDocument();
    // the people not on the chart yet are counted on the Unassigned button
    expect(screen.getByRole('button', { name: /Unassigned/ })).toHaveTextContent('2');

    // collapse again, and Collapse all
    fireEvent.click(toggle);
    expect(screen.queryByTestId('org-card-cto')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    await screen.findByTestId('org-card-cto');
    fireEvent.click(screen.getByRole('button', { name: /Collapse all/ }));
    expect(screen.queryByTestId('org-card-cto')).not.toBeInTheDocument();
  });

  it('lists the unassigned people in a side panel and gives the selected ones a manager in one go', async () => {
    mockGet(routes());
    apiMock.post.mockResolvedValue({ data: { updated: 2, employeeIds: [NASSER_ID, 'laila'] } });
    const success = vi.spyOn(toast, 'success');
    renderWithProviders(<OrgChartPage />, { route: '/employees/org-chart' });
    await screen.findByTestId('org-card-ceo');
    fireEvent.click(screen.getByRole('button', { name: /Unassigned/ }));
    const panel = await screen.findByRole('complementary', { name: /Unassigned/ });
    expect(await within(panel).findByText('Nasser Al-Kindi')).toBeInTheDocument();
    expect(within(panel).getByText('Laila Al-Farsi')).toBeInTheDocument();
    const assign = within(panel).getByRole('button', { name: 'Assign manager to selected (0)' });
    expect(assign).toBeDisabled();
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Select all shown' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Assign manager to selected (2)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Assign manager (2)' });
    await pick(dialog, /New line manager/, /Huda Al-Lawati/);
    const reads = orgChartCalls().length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply to 2' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/employees/bulk', { action: 'assign_manager', employeeIds: [NASSER_ID, 'laila'], managerEmployeeId: 'cto', line: 'primary', effectiveFrom: expect.any(String) }, expect.anything()));
    await waitFor(() => expect(success).toHaveBeenCalledWith('2 employees updated'));
    // the chart and the list refresh (the org-chart entity is invalidated with the employees)
    await waitFor(() => expect(orgChartCalls().length).toBeGreaterThan(reads));
  });

  it('changes one person\'s manager from the card menu (and says who they report to now)', async () => {
    mockGet(routes());
    renderWithProviders(<OrgChartPage />, { route: '/employees/org-chart' });
    await expand('ceo');
    const cfo = await screen.findByTestId('org-card-cfo');
    await openMenu(cfo, 'Omar Al-Rawahi', /Change manager/);
    const dialog = await screen.findByRole('dialog', { name: 'Change the manager of Omar Al-Rawahi' });
    expect(within(dialog).getByText('Currently reports to Salim Al-Busaidi.')).toBeInTheDocument();
    // the person cannot manage themself, nor can anybody who left
    fireEvent.click(within(dialog).getByRole('combobox', { name: /New line manager/ }));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).queryByRole('option', { name: /Omar Al-Rawahi/ })).not.toBeInTheDocument();
    expect(within(listbox).queryByRole('option', { name: /Khalfan Left/ })).not.toBeInTheDocument();
    fireEvent.click(within(listbox).getByRole('option', { name: /Huda Al-Lawati/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/employees/bulk', { action: 'assign_manager', employeeIds: ['cfo'], managerEmployeeId: 'cto', line: 'primary', effectiveFrom: expect.any(String) }, expect.anything()));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // the team stays open after the change (expanded state is kept)
    expect(screen.getByTestId('org-card-cto')).toBeInTheDocument();

    // the dotted line from the same menu: no effective date
    await openMenu(screen.getByTestId('org-card-cfo'), 'Omar Al-Rawahi', /Set secondary manager/);
    const second = await screen.findByRole('dialog', { name: 'Set the secondary manager of Omar Al-Rawahi' });
    expect(within(second).queryByLabelText('Effective from')).not.toBeInTheDocument();
    await pick(second, /New secondary manager/, /Aisha Al-Hinai/);
    fireEvent.click(within(second).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenLastCalledWith('/orgs/org-1/employees/bulk', { action: 'assign_manager', employeeIds: ['cfo'], managerEmployeeId: DEV_ID, line: 'secondary' }, expect.anything()));
  });

  it('removes a manager after a confirmation', async () => {
    mockGet(routes());
    renderWithProviders(<OrgChartPage />, { route: '/employees/org-chart' });
    await expand('ceo');
    await openMenu(await screen.findByTestId('org-card-cto'), 'Huda Al-Lawati', /^Remove manager/);
    const dialog = await screen.findByRole('dialog', { name: 'Remove the manager of Huda Al-Lawati?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove manager' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/employees/bulk', { action: 'assign_manager', employeeIds: ['cto'], managerEmployeeId: null, line: 'primary', effectiveFrom: expect.any(String) }, expect.anything()));
  });

  it('adds direct reports: a searchable checklist with chips, the manager and their current team left out', async () => {
    mockGet(routes());
    renderWithProviders(<OrgChartPage />, { route: '/employees/org-chart' });
    await expand('ceo');
    await openMenu(await screen.findByTestId('org-card-cto'), 'Huda Al-Lawati', /Add direct reports/);
    const dialog = await screen.findByRole('dialog', { name: 'Add direct reports to Huda Al-Lawati' });
    const results = within(dialog).getByRole('list', { name: 'Employees' });
    await within(results).findByText('Nasser Al-Kindi');
    // not the manager, not anybody who left; her current report is ticked and locked
    expect(within(results).queryByText('Huda Al-Lawati')).not.toBeInTheDocument();
    expect(within(results).queryByText('Khalfan Left')).not.toBeInTheDocument();
    expect(within(results).getByRole('checkbox', { name: /Aisha Al-Hinai/ })).toBeDisabled();
    // her own manager cannot join her team (the line would go round in a circle): locked, and the row says why
    expect(within(results).getByRole('checkbox', { name: /^Salim Al-Busaidi/ })).toBeDisabled();
    expect(within(results).getByText('Above Huda Al-Lawati in the reporting line')).toBeInTheDocument();
    const submit = within(dialog).getByRole('button', { name: 'Add to team (0)' });
    expect(submit).toBeDisabled();
    fireEvent.click(within(results).getByRole('checkbox', { name: /Nasser Al-Kindi/ }));
    fireEvent.click(within(results).getByRole('checkbox', { name: /Laila Al-Farsi/ }));
    fireEvent.click(within(results).getByRole('checkbox', { name: /Omar Al-Rawahi/ }));
    // a chip per chosen person; removing a chip unticks them
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Omar Al-Rawahi' }));
    expect(within(results).getByRole('checkbox', { name: /Omar Al-Rawahi/ })).not.toBeChecked();
    // the search goes to the server
    fireEvent.change(within(dialog).getByRole('searchbox', { name: 'Search employees' }), { target: { value: 'al' } });
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/employees', expect.objectContaining({ search: 'al' })));
    fireEvent.change(within(dialog).getByLabelText('Effective from'), { target: { value: '2026-12-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to team (2)' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/employees/bulk', { action: 'assign_manager', employeeIds: [NASSER_ID, 'laila'], managerEmployeeId: 'cto', line: 'primary', effectiveFrom: '2026-12-01' }, expect.anything()));
  });

  it('?focus= reads the person\'s path, opens every manager above them and lands on their card', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    mockGet(routes({ [`/orgs/org-1/org-chart/path/${DEV_ID}`]: { data: { employeeId: DEV_ID, placement: 'tree', ancestorIds: ['ceo', 'cto'] } } }));
    renderWithProviders(<OrgChartPage />, { route: `/employees/org-chart?focus=${DEV_ID}` });
    const dev = await screen.findByTestId(`org-card-${DEV_ID}`);
    expect(apiMock.get).toHaveBeenCalledWith(`/orgs/org-1/org-chart/path/${DEV_ID}`, {});
    expect(orgChartCalls()).toContainEqual(expect.objectContaining({ managerId: 'ceo' }));
    expect(orgChartCalls()).toContainEqual(expect.objectContaining({ managerId: 'cto' }));
    expect(dev).toHaveAttribute('data-focused', 'true');
    expect(within(screen.getByTestId('org-card-ceo')).getByRole('button', { name: /reports$/ })).toHaveAttribute('aria-expanded', 'true');
    expect(within(screen.getByTestId('org-card-cto')).getByRole('button', { name: /report$/ })).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(within(dev).getByRole('link', { name: 'Aisha Al-Hinai' })).toHaveFocus();
    scroll.mockRestore();
  });

  it('focusing somebody who is not on the chart opens Unassigned on them; somebody outside the chart gets a hint', async () => {
    const info = vi.spyOn(toast, 'info');
    mockGet(routes({
      [`/orgs/org-1/org-chart/path/${NASSER_ID}`]: { data: { employeeId: NASSER_ID, placement: 'unassigned', ancestorIds: [] } },
      [`/orgs/org-1/employees/${NASSER_ID}`]: { data: { ...emp(NASSER_ID, 'Nasser Al-Kindi', { employeeNumber: 'N-nasser' }), currentHistory: null } },
    }));
    const first = renderWithProviders(<OrgChartPage />, { route: `/employees/org-chart?focus=${NASSER_ID}` });
    const panel = await screen.findByRole('complementary', { name: /Unassigned/ });
    await waitFor(() => expect(within(panel).getByRole('searchbox')).toHaveValue('N-nasser'));
    await waitFor(() => expect(orgChartCalls()).toContainEqual(expect.objectContaining({ view: 'unassigned', search: 'N-nasser' })));
    expect(await within(panel).findByTestId(`unassigned-row-${NASSER_ID}`)).toBeInTheDocument();
    expect(within(panel).queryByText('Laila Al-Farsi')).not.toBeInTheDocument();
    first.unmount();

    // a person who left (or is filtered out): the path is a 404
    renderWithProviders(<OrgChartPage />, { route: `/employees/org-chart?focus=${GONE_ID}` });
    await waitFor(() => expect(info).toHaveBeenCalledWith('This person is not on the chart: they left, or they are outside the branch or department shown.'));
  });

  it('shows no editing controls to a viewer without employee.update', async () => {
    grant('employee.view');
    mockGet(routes());
    renderWithProviders(<OrgChartPage />, { route: '/employees/org-chart' });
    const ceo = await screen.findByTestId('org-card-ceo');
    expect(within(ceo).queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
    expect(ceo).not.toHaveAttribute('draggable');
    expect(screen.queryByText(/Drag a card/)).not.toBeInTheDocument();
    // the team still opens
    await expand('ceo');
    expect(within(await screen.findByTestId('org-card-cto')).queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Unassigned/ }));
    const panel = await screen.findByRole('complementary', { name: /Unassigned/ });
    await within(panel).findByText('Nasser Al-Kindi');
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Assign manager/ })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
    expect(within(panel).getByTestId(`unassigned-row-${NASSER_ID}`)).not.toHaveAttribute('draggable');
  });

  it('drag-and-drop: a card dropped on another asks to confirm the new manager; a drop on the person\'s own team is refused', async () => {
    const error = vi.spyOn(toast, 'error');
    mockGet(routes());
    renderWithProviders(<OrgChartPage />, { route: '/employees/org-chart' });
    await expand('ceo');
    await expand('cto');
    const dev = await screen.findByTestId(`org-card-${DEV_ID}`);
    const cfo = screen.getByTestId('org-card-cfo');
    expect(dev).toHaveAttribute('draggable', 'true');

    fireEvent.dragStart(dev);
    fireEvent.dragEnter(cfo);
    fireEvent.dragOver(cfo);
    fireEvent.drop(cfo);
    const dialog = await screen.findByRole('dialog', { name: 'Change manager?' });
    expect(dialog).toHaveTextContent('Make Aisha Al-Hinai report to Omar Al-Rawahi.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change manager' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/employees/bulk', { action: 'assign_manager', employeeIds: [DEV_ID], managerEmployeeId: 'cfo', line: 'primary', effectiveFrom: expect.any(String) }, expect.anything()));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // Salim onto Aisha (who is in his own team): refused before asking the server
    const ceo = screen.getByTestId('org-card-ceo');
    fireEvent.dragStart(ceo);
    fireEvent.dragEnter(screen.getByTestId(`org-card-${DEV_ID}`));
    fireEvent.drop(screen.getByTestId(`org-card-${DEV_ID}`));
    expect(error).toHaveBeenCalledWith("Aisha Al-Hinai is in Salim Al-Busaidi's own team, so Salim Al-Busaidi cannot report to them. Pick someone outside that team.");
    // and onto themself
    fireEvent.dragStart(ceo);
    fireEvent.drop(ceo);
    expect(error).toHaveBeenCalledWith('A person cannot report to themselves.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(apiMock.post).toHaveBeenCalledTimes(1);
  });

  it('explains how to build the chart when nobody has a manager yet, and opens Unassigned from there', async () => {
    mockGet(routes({ '/orgs/org-1/org-chart': (q: Query) => (q?.['view'] === 'unassigned' ? page([NASSER, LAILA]) : page([])) }));
    renderWithProviders(<OrgChartPage />, { route: '/employees/org-chart' });
    expect(await screen.findByText('No reporting lines yet')).toBeInTheDocument();
    expect(screen.getByText('2 people have no manager yet. Build the chart in any of these ways:')).toBeInTheDocument();
    expect(screen.getByText(/managerEmployeeNumber/)).toBeInTheDocument();
    expect(screen.getByText('Open Unassigned and use “Add direct reports…” in a person\'s ⋯ menu.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Show unassigned people/ }));
    const panel = await screen.findByRole('complementary', { name: /Unassigned/ });
    // there are no cards yet: the ⋯ menu is on every Unassigned row, so a first team can be built from there
    await openMenu(await within(panel).findByTestId(`unassigned-row-${NASSER_ID}`), 'Nasser Al-Kindi', /Add direct reports/);
    expect(await screen.findByRole('dialog', { name: 'Add direct reports to Nasser Al-Kindi' })).toBeInTheDocument();
  });

  it('speaks of "this view" when the people listed may report to a manager in another branch or department', async () => {
    const LAILA_OUT = { ...LAILA, managerEmployeeId: 'hq-boss' };
    mockGet(routes({ '/orgs/org-1/org-chart': (q: Query) => (q?.['view'] === 'unassigned' ? page([NASSER, LAILA_OUT]) : page([])) }));
    renderWithProviders(<OrgChartPage />, { route: '/employees/org-chart' });
    expect(await screen.findByText('No reporting lines in this view')).toBeInTheDocument();
    expect(screen.getByText('2 people in this view have no manager inside it; some may report to someone in another branch or department. To build the chart here:')).toBeInTheDocument();
    expect(screen.queryByText(/have no manager yet/)).not.toBeInTheDocument();
  });

  it('shows an empty chart when the organisation has nobody, and the error state with a retry', async () => {
    mockGet(routes({ '/orgs/org-1/org-chart': page([]) }));
    const first = renderWithProviders(<OrgChartPage />, { route: '/employees/org-chart' });
    expect(await screen.findByText('Nobody on the chart yet')).toBeInTheDocument();
    first.unmount();
    resetApiMock();
    mockGet(routes({ '/orgs/org-1/org-chart': () => Promise.reject(new Error('boom')) }));
    renderWithProviders(<OrgChartPage />, { route: '/employees/org-chart' });
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('takes only an employee id from ?focus=: a crafted value never reaches another API route', async () => {
    mockGet(routes());
    renderWithProviders(<OrgChartPage />, { route: '/employees/org-chart?focus=..%2F..%2F..%2Fleave-balances%2Fexport%3Fyear%3D2026' });
    await screen.findByTestId('org-card-ceo');
    await waitFor(() => expect(screen.getByRole('button', { name: /Unassigned/ })).toHaveTextContent('2'));
    const paths = apiMock.get.mock.calls.map(([path]) => String(path));
    expect(paths.filter((path) => path.includes('/org-chart/path') || path.includes('leave-balances') || path.startsWith('/orgs/org-1/employees/'))).toEqual([]);

    // an id that goes into a path is one segment whatever it holds: no `/`, `?`, and never a `.` / `..` step up
    expect(idSegment('../../leave-balances/export?year=2026')).toBe('..%2F..%2Fleave-balances%2Fexport%3Fyear%3D2026');
    expect(() => idSegment('..')).toThrow();
    expect(() => idSegment('.')).toThrow();
    await expect(orgChartPathQuery('org-1', '..', {}).queryFn()).rejects.toMatchObject({ status: 404 });
    apiMock.get.mockResolvedValue({ data: { employeeId: 'x', placement: 'tree', ancestorIds: [] } });
    await orgChartPathQuery('org-1', '../../x', {}).queryFn();
    expect(apiMock.get).toHaveBeenLastCalledWith('/orgs/org-1/org-chart/path/..%2F..%2Fx', {});
  });

  it('drag-and-drop judges a drop by the teams on screen, not by a collapsed team cached before a change', async () => {
    const error = vi.spyOn(toast, 'error');
    error.mockClear();
    let moved = false;
    const AISHA_MOVED = { ...DEV, managerEmployeeId: 'ceo' };
    mockGet(routes({
      '/orgs/org-1/org-chart': (q: Query) => {
        if (q?.['managerId'] === 'ceo') return page(moved ? [{ ...CTO, directReportCount: 0 }, CFO, AISHA_MOVED] : [CTO, CFO]);
        if (q?.['managerId'] === 'cto') return page(moved ? [] : [DEV]);
        if (!q?.['view'] || q['view'] === 'top') return page([{ ...CEO, directReportCount: moved ? 3 : 2 }]);
        return levels(q);
      },
    }));
    apiMock.post.mockImplementation(async () => { moved = true; return { data: { updated: 1, employeeIds: [DEV_ID] } }; });
    const { client } = renderWithProviders(<OrgChartPage />, { route: '/employees/org-chart' });
    // like the app: a level nobody shows any more stays in the cache for minutes
    client.setDefaultOptions({ queries: { retry: false, staleTime: 0, gcTime: 5 * 60_000 } });
    await expand('ceo');
    await expand('cto');
    await screen.findByTestId(`org-card-${DEV_ID}`);
    // collapse Huda's team: her level leaves the screen but stays cached with Aisha → Huda
    fireEvent.click(within(screen.getByTestId('org-card-cto')).getByRole('button', { name: /report$/ }));
    expect(screen.queryByTestId(`org-card-${DEV_ID}`)).not.toBeInTheDocument();

    // Aisha moves under Salim (his menu); his open team refreshes, Huda's collapsed level does not
    await openMenu(screen.getByTestId('org-card-ceo'), 'Salim Al-Busaidi', /Add direct reports/);
    const dialog = await screen.findByRole('dialog', { name: 'Add direct reports to Salim Al-Busaidi' });
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: /Aisha Al-Hinai/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to team (1)' }));
    const aisha = await screen.findByTestId(`org-card-${DEV_ID}`);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // Huda onto Aisha: allowed now — no red outline, no "own team" refusal, the confirmation names the line it replaces
    const huda = screen.getByTestId('org-card-cto');
    fireEvent.dragStart(huda);
    fireEvent.dragEnter(aisha);
    expect(aisha.className).not.toMatch(/border-destructive/);
    fireEvent.drop(aisha);
    expect(error).not.toHaveBeenCalled();
    const move = await screen.findByRole('dialog', { name: 'Change manager?' });
    expect(move).toHaveTextContent('Make Huda Al-Lawati report to Aisha Al-Hinai.');
    expect(move).toHaveTextContent('Currently reports to Salim Al-Busaidi.');
  });

  it('lands on a focused person once: reopening their manager\'s team keeps the keyboard where the reader is; a new find lands again', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    scroll.mockClear();
    const landings = () => scroll.mock.contexts.filter((el) => (el as Element).getAttribute?.('data-testid') === `org-card-${DEV_ID}`).length;
    mockGet(routes({ [`/orgs/org-1/org-chart/path/${DEV_ID}`]: { data: { employeeId: DEV_ID, placement: 'tree', ancestorIds: ['ceo', 'cto'] } } }));
    renderWithProviders(<OrgChartPage />, { route: `/employees/org-chart?focus=${DEV_ID}` });
    const dev = await screen.findByTestId(`org-card-${DEV_ID}`);
    await waitFor(() => expect(within(dev).getByRole('link', { name: 'Aisha Al-Hinai' })).toHaveFocus());
    expect(landings()).toBe(1);
    // the landing glow plays once; after it ended, a remount does not replay it
    const glow = dev.querySelector('[class*="fade-out"]');
    expect(glow).not.toBeNull();
    fireEvent.animationEnd(glow!);
    expect(dev.querySelector('[class*="fade-out"]')).toBeNull();

    // collapse and reopen Huda's team from her toggle: Aisha's card mounts again, the keyboard stays on the toggle
    const toggle = within(screen.getByTestId('org-card-cto')).getByRole('button', { name: /report$/ });
    toggle.focus();
    fireEvent.click(toggle);
    expect(screen.queryByTestId(`org-card-${DEV_ID}`)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    const again = await screen.findByTestId(`org-card-${DEV_ID}`);
    expect(again).toHaveAttribute('data-focused', 'true');
    expect(toggle).toHaveFocus();
    expect(landings()).toBe(1);
    expect(again.querySelector('[class*="fade-out"]')).toBeNull();

    // clearing the search and finding her again is a new request: it lands again
    fireEvent.click(within(screen.getByRole('combobox', { name: 'Find a person' })).getByLabelText('Clear'));
    expect(screen.getByTestId(`org-card-${DEV_ID}`)).not.toHaveAttribute('data-focused');
    fireEvent.click(screen.getByRole('combobox', { name: 'Find a person' }));
    fireEvent.click(await screen.findByRole('option', { name: /Aisha Al-Hinai/ }));
    await waitFor(() => expect(within(screen.getByTestId(`org-card-${DEV_ID}`)).getByRole('link', { name: 'Aisha Al-Hinai' })).toHaveFocus());
    expect(landings()).toBe(2);
    scroll.mockRestore();
  });

  it('focusing an unassigned person whose number matches more than one page loads on until their row is there', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    scroll.mockClear();
    const focusRoutes = (pages: (q: Query) => unknown) => routes({
      '/orgs/org-1/org-chart': (q: Query) => (q?.['view'] === 'unassigned' && q['search'] === 'N-nasser' ? pages(q) : levels(q)),
      [`/orgs/org-1/org-chart/path/${NASSER_ID}`]: { data: { employeeId: NASSER_ID, placement: 'unassigned', ancestorIds: [] } },
      [`/orgs/org-1/employees/${NASSER_ID}`]: { data: { ...emp(NASSER_ID, 'Nasser Al-Kindi', { employeeNumber: 'N-nasser' }), currentHistory: null } },
    });
    // the search matches two people, one per page; Nasser is on the second
    mockGet(focusRoutes((q) => (q?.['page'] === 2 ? page([NASSER], 2, 2, 1) : page([LAILA], 2, 1, 1))));
    const first = renderWithProviders(<OrgChartPage />, { route: `/employees/org-chart?focus=${NASSER_ID}` });
    const panel = await screen.findByRole('complementary', { name: /Unassigned/ });
    const row = await within(panel).findByTestId(`unassigned-row-${NASSER_ID}`);
    expect(orgChartCalls()).toContainEqual(expect.objectContaining({ view: 'unassigned', search: 'N-nasser', page: 2 }));
    await waitFor(() => expect(scroll.mock.contexts).toContain(row));
    expect(within(panel).queryByText(/not in this list/)).not.toBeInTheDocument();
    first.unmount();

    // not there at all (they got a manager meanwhile): the panel says so instead of failing silently
    resetApiMock();
    mockGet(focusRoutes(() => page([LAILA], 1, 1, 1)));
    renderWithProviders(<OrgChartPage />, { route: `/employees/org-chart?focus=${NASSER_ID}` });
    const second = await screen.findByRole('complementary', { name: /Unassigned/ });
    expect(await within(second).findByText('The person you looked for is not in this list any more: they may have been given a manager meanwhile.')).toBeInTheDocument();
    scroll.mockRestore();
  });

  it('marks unassigned people whose manager is outside this view, leaves them out of Select all and warns before replacing that line', async () => {
    const LAILA_OUT = { ...LAILA, managerEmployeeId: 'hq-boss' };
    mockGet(routes({ '/orgs/org-1/org-chart': (q: Query) => (q?.['view'] === 'unassigned' ? page([NASSER, LAILA_OUT]) : levels(q)) }));
    renderWithProviders(<OrgChartPage />, { route: '/employees/org-chart' });
    await screen.findByTestId('org-card-ceo');
    fireEvent.click(screen.getByRole('button', { name: /Unassigned/ }));
    const panel = await screen.findByRole('complementary', { name: /Unassigned/ });
    const laila = await within(panel).findByTestId('unassigned-row-laila');
    expect(within(laila).getByText('Reports to someone outside this view')).toBeInTheDocument();
    expect(within(panel).getByTestId(`unassigned-row-${NASSER_ID}`)).not.toHaveTextContent('Reports to someone outside this view');
    expect(within(panel).getByText('No manager in this view of the chart and no direct reports. Drag a person onto their manager, or select people and assign a manager.')).toBeInTheDocument();

    // "Select all" takes the people with no manager at all; Laila is ticked on purpose
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Select all shown who have no manager' }));
    expect(within(panel).getByRole('button', { name: 'Assign manager to selected (1)' })).toBeEnabled();
    fireEvent.click(within(laila).getByRole('checkbox', { name: 'Select Laila Al-Farsi' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Assign manager to selected (2)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Assign manager (2)' });
    expect(dialog).toHaveTextContent('1 person reports to a manager outside this view of the org chart (another branch or department); that reporting line will be replaced.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // so does "Change manager…" in her row's ⋯ menu
    await openMenu(laila, 'Laila Al-Farsi', /Change manager/);
    const one = await screen.findByRole('dialog', { name: 'Change the manager of Laila Al-Farsi' });
    expect(one).toHaveTextContent('1 person reports to a manager outside this view of the org chart (another branch or department); that reporting line will be replaced.');
    fireEvent.click(within(one).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // dragging her onto a card says the same before anything changes
    const ceo = screen.getByTestId('org-card-ceo');
    fireEvent.dragStart(laila);
    fireEvent.dragEnter(ceo);
    fireEvent.drop(ceo);
    const move = await screen.findByRole('dialog', { name: 'Change manager?' });
    expect(move).toHaveTextContent('Laila Al-Farsi currently reports to a manager outside this view of the org chart (another branch or department); that reporting line will be replaced.');
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('names the selected people the manager already reports to when the API refuses a reporting loop', async () => {
    const error = vi.spyOn(toast, 'error');
    error.mockClear();
    const serverMessage = 'The manager already reports to some of the selected employees (directly or through other managers), so the reporting line would go round in a circle. Remove them from the selection.';
    mockGet(routes());
    apiMock.post.mockRejectedValue(new ApiError(400, 'VALIDATION_ERROR', serverMessage, 'req-1', { issues: [{ path: 'managerEmployeeId', message: 'Reporting cycle' }], employeeIds: [NASSER_ID, 'laila'] }));
    renderWithProviders(<OrgChartPage />, { route: '/employees/org-chart' });
    await screen.findByTestId('org-card-ceo');
    fireEvent.click(screen.getByRole('button', { name: /Unassigned/ }));
    const panel = await screen.findByRole('complementary', { name: /Unassigned/ });
    await within(panel).findByText('Nasser Al-Kindi');
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Select all shown' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Assign manager to selected (2)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Assign manager (2)' });
    await pick(dialog, /New line manager/, /Huda Al-Lawati/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply to 2' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith('That would make a reporting loop', {
      description: 'The chosen manager already reports to Nasser Al-Kindi and Laila Al-Farsi, directly or through other managers. Remove them from the selection, or pick another manager.',
    }));
    expect(error).not.toHaveBeenCalledWith(serverMessage, expect.anything());
    // the dialog stays open, so the selection can be corrected
    expect(screen.getByRole('dialog', { name: 'Assign manager (2)' })).toBeInTheDocument();
  });

  it('does not call an effective date before a joining date a reporting loop, although that refusal also names employees', async () => {
    const error = vi.spyOn(toast, 'error');
    error.mockClear();
    // the API's answer for a future joiner (assertBulkEffectiveFrom): the same code and `details.employeeIds` as a cycle, the issue on effectiveFrom
    const serverMessage = 'The change date 2026-10-12 is before the joining date or the current employment record of 1 selected employee: N-nasser (from 2026-11-01). Choose 2026-11-01 or later, or leave them out of the selection.';
    mockGet(routes());
    apiMock.post.mockRejectedValue(new ApiError(400, 'VALIDATION_ERROR', serverMessage, 'req-2', {
      issues: [{ path: 'effectiveFrom', message: 'Must be on/after 2026-11-01' }], employeeIds: [NASSER_ID], earliestEffectiveFrom: { [NASSER_ID]: '2026-11-01' },
    }));
    renderWithProviders(<OrgChartPage />, { route: '/employees/org-chart' });
    await screen.findByTestId('org-card-ceo');
    fireEvent.click(screen.getByRole('button', { name: /Unassigned/ }));
    const panel = await screen.findByRole('complementary', { name: /Unassigned/ });
    await within(panel).findByText('Nasser Al-Kindi');
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Select all shown' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Assign manager to selected (2)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Assign manager (2)' });
    await pick(dialog, /New line manager/, /Huda Al-Lawati/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply to 2' }));
    // the server's message names the employee numbers and the first date that works
    await waitFor(() => expect(error).toHaveBeenCalledWith(serverMessage, { description: 'Request req-2' }));
    expect(error).not.toHaveBeenCalledWith('That would make a reporting loop', expect.anything());
    expect(screen.getByRole('dialog', { name: 'Assign manager (2)' })).toBeInTheDocument();
  });

  it('says why nothing changed on a removal, and why some were left as before on the dotted line', async () => {
    const info = vi.spyOn(toast, 'info');
    const success = vi.spyOn(toast, 'success');
    info.mockClear();
    success.mockClear();
    mockGet(routes());
    apiMock.post.mockResolvedValueOnce({ data: { updated: 0, employeeIds: [] } }).mockResolvedValueOnce({ data: { updated: 1, employeeIds: ['laila'] } });
    renderWithProviders(<OrgChartPage />, { route: '/employees/org-chart' });
    await screen.findByTestId('org-card-ceo');
    fireEvent.click(screen.getByRole('button', { name: /Unassigned/ }));
    const panel = await screen.findByRole('complementary', { name: /Unassigned/ });
    await within(panel).findByText('Nasser Al-Kindi');

    // removing the manager of people who have none
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Select all shown' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Assign manager to selected (2)' }));
    let dialog = await screen.findByRole('dialog', { name: 'Assign manager (2)' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Remove the manager instead' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove manager' }));
    await waitFor(() => expect(info).toHaveBeenCalledWith('Nothing changed.', { description: 'They have no line manager.' }));
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('already report'), expect.anything());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // a dotted line to somebody who already is the line manager of one of them: that one is left as before, and the toast says why
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Select all shown' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Assign manager to selected (2)' }));
    dialog = await screen.findByRole('dialog', { name: 'Assign manager (2)' });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Secondary \(dotted-line\) manager/ }));
    await pick(dialog, /New secondary manager/, /Huda Al-Lawati/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply to 2' }));
    await waitFor(() => expect(success).toHaveBeenCalledWith('1 employees updated', {
      description: '1 employee was left as before. This person is already their line manager or secondary manager.',
    }));
  });
});
