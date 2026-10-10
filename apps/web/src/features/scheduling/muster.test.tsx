import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { MUSTER_STATES, type LocationMusterDto, type LocationMusterEntryDto, type MusterState } from '@flowza/contracts';
import { apiMock, grant, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { Sidebar } from '@/components/layout/sidebar';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/scheduling.json';
import ar from '@/locales/ar/scheduling.json';
import { indexLocations } from '@/features/locations/tree';
import MusterPage from './pages/muster-page';
import { schedulingRoutes } from './routes';
import { filterMusterEntries, musterLocation, sortMusterEntries } from './muster';
import { BR1, BRANCHES, LEVELS, NODES, N_B1, N_B2, N_F2, N_HQ, N_SA, N_SB, locationRoutes } from './test-locations';

registerNamespace('scheduling', en, ar);

const DATE = '2026-10-10';
const REMEMBERED = 'flowza.muster.location.org-1.u1';
const totals = (on_site: number, on_break: number, left: number, seen: number) => ({ on_site, on_break, left, seen });
const entry = (employeeId: string, displayName: string, employeeNumber: string, state: MusterState, punchedAt: string, locationId: string, locationName: string, deviceName: string): LocationMusterEntryDto => ({
  employeeId, displayName, employeeNumber, branchId: BR1, state, eventType: { on_site: 'PUNCH_IN', on_break: 'BREAK_START', left: 'PUNCH_OUT', seen: 'PUNCH' }[state], punchedAt, deviceId: `dev-${deviceName}`, deviceName, locationId, locationName,
});
// Branch 1 runs on Riyadh time (UTC+3), the organisation on Muscat time (UTC+4): 04:05Z is 07:05 at the branch, not 08:05
const AISHA = entry('e1', 'Aisha Al Balushi', 'E-001', 'on_site', '2026-10-10T04:05:00Z', N_F2, 'Site A › Floor 2', 'Gate A');
const RAHUL = entry('e2', 'Rahul Nair', 'E-002', 'on_break', '2026-10-10T08:30:00Z', N_SA, 'Site A', 'Canteen');
const FATMA = entry('e3', 'Fatma Said', 'E-003', 'on_site', '2026-10-10T09:00:00Z', N_SA, 'Site A', 'Canteen');
const OMAR = entry('e4', 'Omar Khalid', 'E-004', 'left', '2026-10-10T12:00:00Z', N_SB, 'Site B', 'Gate B');
const MUSTER: Record<string, LocationMusterDto> = {
  [N_B1]: {
    locationId: N_B1, date: DATE, totals: totals(2, 1, 1, 0), deviceCount: 3, entries: [OMAR, RAHUL, AISHA, FATMA],
    children: [{ locationId: N_SA, name: 'Site A', nameAr: 'الموقع أ', totals: totals(2, 1, 0, 0) }, { locationId: N_SB, name: 'Site B', nameAr: null, totals: totals(0, 0, 1, 0) }],
  },
  [N_SA]: { locationId: N_SA, date: DATE, totals: totals(2, 1, 0, 0), deviceCount: 2, entries: [RAHUL, AISHA, FATMA], children: [{ locationId: N_F2, name: 'Floor 2', nameAr: null, totals: totals(1, 0, 0, 0) }] },
  [N_B2]: { locationId: N_B2, date: DATE, totals: totals(0, 0, 0, 0), deviceCount: 0, entries: [], children: [] },
};
const musterPath = (id: string) => `/orgs/org-1/locations/${id}/muster`;
const musterCalls = () => apiMock.get.mock.calls.filter(([p]) => String(p).endsWith('/muster')) as Array<[string, Record<string, unknown> | undefined]>;

describe('muster list — on site now (docs/locations.md §4)', () => {
  beforeEach(() => {
    resetApiMock(); grantAll(); window.localStorage.clear();
    mockGet({
      ...locationRoutes(), '/orgs/org-1/branches': page(BRANCHES),
      ...Object.fromEntries(Object.entries(MUSTER).map(([id, dto]) => [musterPath(id), () => ({ data: dto })])),
    });
  });
  afterEach(() => { testState.disabledModules = new Set(); vi.restoreAllMocks(); });

  it('opens on the first branch: totals as tiles, the child locations and the people with their last punch in the branch\'s time', async () => {
    renderWithProviders(<MusterPage />, { route: '/attendance/muster' });
    const onSite = await screen.findByTestId('muster-total-on_site');
    expect(within(onSite).getByText('2')).toBeInTheDocument();
    expect(within(screen.getByTestId('muster-total-on_break')).getByText('1')).toBeInTheDocument();
    expect(within(screen.getByTestId('muster-total-left')).getByText('1')).toBeInTheDocument();
    expect(within(screen.getByTestId('muster-total-seen')).getByText('0')).toBeInTheDocument();
    expect(musterCalls()[0]).toEqual([musterPath(N_B1), undefined]);
    expect(screen.getByRole('combobox', { name: 'Location' })).toHaveTextContent('Branch 1');
    expect(screen.getByTestId('muster-path')).toHaveTextContent('Muscat HQ');
    // the children with their totals (on site, on break, left, seen) and their level
    const siteA = screen.getByTestId(`muster-child-${N_SA}`);
    expect([...siteA.querySelectorAll('td')].map((c) => c.textContent)).toEqual(['Site ASite', '2', '1', '0', '0']);
    // the people: DataTable renders a table and a card fallback, so each value exists twice
    expect(screen.getAllByText('Aisha Al Balushi').length).toBeGreaterThan(0);
    expect(screen.getAllByText('07:05').length).toBeGreaterThan(0);
    expect(screen.queryByText('08:05')).toBeNull();
    expect(screen.getAllByText('Gate A').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Site A › Floor 2').length).toBeGreaterThan(0);
    // on site first (then by name), on break, left
    const names = within(screen.getAllByRole('table').at(-1)!).getAllByRole('row').slice(1).map((r) => r.querySelector('td p')?.textContent);
    expect(names).toEqual(['Aisha Al Balushi', 'Fatma Said', 'Rahul Nair', 'Omar Khalid']);
    expect(screen.getByText(/Web and mobile check-ins carry no terminal/)).toBeInTheDocument();
  });

  it('drills down into a child, remembers it, and climbs back up through the path', async () => {
    renderWithProviders(<MusterPage />, { route: '/attendance/muster' });
    const siteA = await screen.findByTestId(`muster-child-${N_SA}`);
    fireEvent.click(within(siteA).getByRole('button', { name: /Site A/ }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/attendance/muster?location=${N_SA}`));
    await waitFor(() => expect(musterCalls().some(([p]) => p === musterPath(N_SA))).toBe(true));
    expect(window.localStorage.getItem(REMEMBERED)).toBe(N_SA);
    expect(await screen.findByTestId(`muster-child-${N_F2}`)).toBeInTheDocument();
    expect(screen.queryAllByText('Omar Khalid')).toHaveLength(0);
    const path = screen.getByTestId('muster-path');
    expect(path).toHaveTextContent('Muscat HQ');
    expect(path).toHaveTextContent('Branch 1');
    expect(path).toHaveTextContent('Site A');
    fireEvent.click(within(path).getByRole('button', { name: 'Branch 1' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/attendance/muster?location=${N_B1}`));
    expect(await screen.findByTestId(`muster-child-${N_SB}`)).toBeInTheDocument();
  });

  it('opens on the location this viewer looked at last', async () => {
    window.localStorage.setItem(REMEMBERED, N_SA);
    renderWithProviders(<MusterPage />, { route: '/attendance/muster' });
    expect(await screen.findByTestId(`muster-child-${N_F2}`)).toBeInTheDocument();
    expect(musterCalls().map(([p]) => p)).toEqual([musterPath(N_SA)]);
  });

  it('a location without terminals explains how to place one', async () => {
    renderWithProviders(<MusterPage />, { route: `/attendance/muster?location=${N_B2}` });
    expect(await screen.findByText('No terminal is placed in this location yet')).toBeInTheDocument();
    expect(screen.getByText(/Set a device's location in Devices/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Devices' })).toHaveAttribute('href', '/devices');
    expect(screen.queryByTestId('muster-total-on_site')).toBeNull();
    expect(screen.getByTestId('muster-print')).toBeDisabled();
  });

  it('filters the people by a state tile and by name or number', async () => {
    renderWithProviders(<MusterPage />, { route: '/attendance/muster' });
    const onBreak = await screen.findByTestId('muster-total-on_break');
    fireEvent.click(onBreak);
    expect(onBreak).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByText('Rahul Nair').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('Aisha Al Balushi')).toHaveLength(0);
    fireEvent.click(onBreak);
    expect(screen.getAllByText('Aisha Al Balushi').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search name or number' }), { target: { value: 'e-004' } });
    expect(screen.getAllByText('Omar Khalid').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('Rahul Nair')).toHaveLength(0);
  });

  it('another day is asked for explicitly; "Today" goes back to the location\'s today; it refreshes every minute and on focus', async () => {
    const { client } = renderWithProviders(<MusterPage />, { route: '/attendance/muster' });
    const date = await screen.findByLabelText('Date');
    await waitFor(() => expect(date).toHaveValue(DATE));
    fireEvent.change(date, { target: { value: '2026-10-09' } });
    await waitFor(() => expect(musterCalls().some(([p, q]) => p === musterPath(N_B1) && q?.date === '2026-10-09')).toBe(true));
    expect(screen.getByTestId('location')).toHaveTextContent('date=2026-10-09');
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(screen.getByTestId('location')).not.toHaveTextContent('date='));
    const query = client.getQueryCache().findAll({ queryKey: ['org', 'org-1', 'location-muster'] })[0]!;
    expect(query.options).toMatchObject({ refetchInterval: 60_000, refetchOnWindowFocus: true, refetchIntervalInBackground: false });
  });

  it('prints a roll call with everyone, on site first (report.export)', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    renderWithProviders(<MusterPage />, { route: '/attendance/muster' });
    await screen.findByTestId('muster-total-on_site');
    fireEvent.click(screen.getByTestId('muster-print'));
    expect(print).toHaveBeenCalledTimes(1);
    const sheet = screen.getByTestId('muster-roll-call');
    expect(sheet).toHaveTextContent('Roll call');
    expect(sheet).toHaveTextContent('Muscat HQ › Branch 1');
    expect(within(sheet).getAllByRole('row').slice(1).map((r) => r.querySelectorAll('td')[1]?.textContent)).toEqual(['Aisha Al Balushi', 'Fatma Said', 'Rahul Nair', 'Omar Khalid']);
    act(() => { window.dispatchEvent(new Event('afterprint')); });
    expect(screen.queryByTestId('muster-roll-call')).toBeNull();
  });

  it('without report.export there is nothing to print', async () => {
    grant('attendance.view', 'branch.view');
    renderWithProviders(<MusterPage />, { route: '/attendance/muster' });
    await screen.findByTestId('muster-total-on_site');
    expect(screen.queryByTestId('muster-print')).toBeNull();
  });

  it('the route needs advanced_scheduling and attendance.view, and the sidebar lists it next to the deployments', async () => {
    const route = schedulingRoutes.find((r) => r.path === 'attendance/muster')!;
    testState.disabledModules = new Set(['advanced_scheduling']);
    const off = renderWithProviders(<>{route.element}</>);
    expect(await screen.findByText(/is not part of your subscription/)).toBeInTheDocument();
    expect(musterCalls()).toHaveLength(0);
    off.unmount();
    const sidebarOff = renderWithProviders(<Sidebar />);
    expect(screen.queryByRole('link', { name: 'On site now' })).toBeNull();
    sidebarOff.unmount();
    testState.disabledModules = new Set();
    grant('shift.view');
    const denied = renderWithProviders(<>{route.element}</>);
    expect(await screen.findByText('You do not have permission to view this page.')).toBeInTheDocument();
    denied.unmount();
    grantAll();
    renderWithProviders(<Sidebar />);
    expect(screen.getByRole('link', { name: 'On site now' })).toHaveAttribute('href', '/attendance/muster');
  });

  it('has every muster string in English and Arabic, and a label for every state', () => {
    for (const s of MUSTER_STATES) {
      expect(en.muster.states[s]).toBeTruthy(); expect(ar.muster.states[s]).toBeTruthy();
      expect(en.muster.stateHints[s]).toBeTruthy(); expect(ar.muster.stateHints[s]).toBeTruthy();
    }
  });
});

describe('muster helpers', () => {
  it('orders by state then name, filters by state and text, and picks the location to open', () => {
    expect(sortMusterEntries([OMAR, RAHUL, FATMA, AISHA], 'state', 'asc').map((e) => e.employeeId)).toEqual(['e1', 'e3', 'e2', 'e4']);
    expect(sortMusterEntries([OMAR, RAHUL, FATMA, AISHA], 'time', 'desc').map((e) => e.employeeId)).toEqual(['e4', 'e3', 'e2', 'e1']);
    expect(filterMusterEntries([OMAR, RAHUL, FATMA, AISHA], 'on_site', 'fat').map((e) => e.employeeId)).toEqual(['e3']);
    const index = indexLocations(NODES, LEVELS);
    expect(musterLocation(index, null, null)).toBe(N_B1);
    expect(musterLocation(index, null, N_SA)).toBe(N_SA);
    expect(musterLocation(index, null, 'c0000000-0000-4000-8000-00000000dead')).toBe(N_B1);
    expect(musterLocation(index, N_HQ, N_SA)).toBe(N_HQ);
    expect(musterLocation(index, 'not-a-location', null)).toBe(N_B1);
    expect(musterLocation(indexLocations([], []), null, null)).toBeNull();
  });
});
