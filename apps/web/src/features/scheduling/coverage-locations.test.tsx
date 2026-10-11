import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import type { ShiftCoverageDto, ShiftCoverageReportDto } from '@flowza/contracts';
import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { qk } from '@/lib/query-keys';
import './i18n';
import { CoverageDialog } from './components/coverage-dialog';
import { CoverageGrid, CoverageTab } from './components/coverage-tab';
import { coverageColumns } from './model';
import { BR1, BR2, BRANCHES, BRANCH_ONLY_LEVELS, BRANCH_ONLY_NODES, N_F2, N_SA, N_SB, locationRoutes } from './test-locations';

const MORNING = 'a1000000-0000-4000-8000-0000000000e1';
const NIGHT = 'a1000000-0000-4000-8000-0000000000e2';
const shift = (id: string, code: string, name: string, startTime: string, endTime: string) => ({ id, code, name, nameAr: null, type: 'FIXED', startTime, endTime, status: 'active' });
const SHIFTS = [shift(MORNING, 'MOR', 'Morning', '06:00', '14:00'), shift(NIGHT, 'NGT', 'Night', '22:00', '06:00')];
const target = (id: string, extra: Partial<ShiftCoverageDto>): ShiftCoverageDto => ({ id, branchId: BR1, shiftId: MORNING, shiftName: 'Morning', weekdays: [0, 1, 2, 3, 4], minHeadcount: 2, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', locationId: null, locationName: null, ...extra });

/** Morning has a branch-wide target and targets on Floor 2 (Site A) and on Site B; Night only a branch-wide one. */
const REPORT: ShiftCoverageReportDto = {
  branchId: BR1, from: '2026-10-11', to: '2026-10-12',
  shifts: [{ id: MORNING, code: 'MOR', name: 'Morning', startTime: '06:00', endTime: '14:00' }, { id: NIGHT, code: 'NGT', name: 'Night', startTime: '22:00', endTime: '06:00' }],
  days: [
    { date: '2026-10-11', cells: [
      { shiftId: MORNING, locationId: null, required: 4, scheduled: 4, gap: 0 },
      { shiftId: MORNING, locationId: N_SB, required: 1, scheduled: 1, gap: 0 },
      { shiftId: MORNING, locationId: N_F2, required: 2, scheduled: 1, gap: 1 },
      { shiftId: NIGHT, locationId: null, required: 2, scheduled: 2, gap: 0 },
    ] },
    { date: '2026-10-12', cells: [
      { shiftId: MORNING, locationId: null, required: 4, scheduled: 3, gap: 1 },
      { shiftId: MORNING, locationId: N_SB, required: 1, scheduled: 1, gap: 0 },
      { shiftId: MORNING, locationId: N_F2, required: 2, scheduled: 2, gap: 0 },
      { shiftId: NIGHT, locationId: null, required: 2, scheduled: 2, gap: 0 },
    ] },
  ],
};

const pick = async (combobox: HTMLElement, option: RegExp) => {
  fireEvent.click(combobox);
  fireEvent.click(await screen.findByRole('option', { name: option }));
};

describe('coverage targets per location (docs/locations.md)', () => {
  beforeEach(() => {
    resetApiMock(); grantAll();
    mockGet({ ...locationRoutes(), '/orgs/org-1/branches': page(BRANCHES), '/orgs/org-1/shifts': page(SHIFTS) });
    apiMock.post.mockResolvedValue({ data: target('t-new', { locationId: N_F2, locationName: 'Site A › Floor 2' }) });
  });

  it('the dialog offers the places of the chosen branch and sends the place', async () => {
    renderWithProviders(<CoverageDialog open onOpenChange={vi.fn()} target={null} />);
    const location = await screen.findByRole('combobox', { name: /^Location/ });
    expect(location).toHaveTextContent('Whole branch');
    await pick(screen.getByRole('combobox', { name: /^Branch/ }), /^Branch 1/);
    await pick(screen.getByRole('combobox', { name: /^Shift/ }), /^Morning/);
    fireEvent.click(location);
    // only Branch 1's places, indented under their parents
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getAllByRole('option').map((o) => o.textContent)).toEqual(['Site ASite', 'Floor 2Floor', 'Site BSite']);
    fireEvent.click(within(listbox).getByRole('option', { name: /^Floor 2/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/shift-coverage', expect.objectContaining({ branchId: BR1, shiftId: MORNING, locationId: N_F2, minHeadcount: 1 })));
  });

  it('another branch clears the place: the target then covers the whole branch', async () => {
    renderWithProviders(<CoverageDialog open onOpenChange={vi.fn()} target={null} />);
    const location = await screen.findByRole('combobox', { name: /^Location/ });
    await pick(screen.getByRole('combobox', { name: /^Branch/ }), /^Branch 1/);
    await pick(location, /^Site A/);
    expect(location).toHaveTextContent('Site A');
    await pick(screen.getByRole('combobox', { name: /^Branch/ }), /^Branch 2/);
    expect(location).toHaveTextContent('Whole branch');
    await pick(screen.getByRole('combobox', { name: /^Shift/ }), /^Night/);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/shift-coverage', expect.objectContaining({ branchId: BR2, shiftId: NIGHT, locationId: null })));
  });

  it('editing keeps the place read-only (the target is named by branch, shift and place)', async () => {
    apiMock.patch.mockResolvedValue({ data: target('t1', {}) });
    renderWithProviders(<CoverageDialog open onOpenChange={vi.fn()} target={target('t1', { locationId: N_SA, locationName: 'Site A' })} />);
    const location = await screen.findByRole('combobox', { name: /^Location/ });
    await waitFor(() => expect(location).toHaveTextContent('Site A'));
    expect(location).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/orgs/org-1/shift-coverage/t1', { weekdays: [0, 1, 2, 3, 4], minHeadcount: 2 }));
  });

  it('an organisation without place levels has no Location field', async () => {
    mockGet({ ...locationRoutes(BRANCH_ONLY_LEVELS, BRANCH_ONLY_NODES), '/orgs/org-1/branches': page(BRANCHES), '/orgs/org-1/shifts': page(SHIFTS) });
    const { client } = renderWithProviders(<CoverageDialog open onOpenChange={vi.fn()} target={null} />);
    await waitFor(() => expect(client.getQueryData(qk.list('org-1', 'location-levels'))).toBeDefined());
    expect(screen.queryByRole('combobox', { name: /^Location/ })).toBeNull();
  });

  it('the targets list names the place; the report has a column per (shift, place)', async () => {
    mockGet({
      ...locationRoutes(), '/orgs/org-1/branches': page(BRANCHES), '/orgs/org-1/shifts': page(SHIFTS),
      '/orgs/org-1/shift-coverage': { data: [target('t-branch', { minHeadcount: 4 }), target('t-floor', { locationId: N_F2, locationName: 'Site A › Floor 2' })] },
      '/orgs/org-1/shift-coverage/report': { data: REPORT },
    });
    renderWithProviders(<CoverageTab />);
    const list = await screen.findByTestId('coverage-targets');
    const rows = within(list).getAllByRole('listitem');
    expect(within(rows[0]!).queryByTestId('coverage-target-location')).toBeNull();
    expect(within(rows[1]!).getByTestId('coverage-target-location')).toHaveTextContent('Site A › Floor 2');
    expect(await screen.findByTestId(`cell-2026-10-11-${MORNING}-${N_F2}`)).toHaveTextContent('1 / 2');
  });
});

describe('the coverage grid by place', () => {
  beforeEach(() => { resetApiMock(); grantAll(); mockGet(locationRoutes()); });

  it('keeps one plain column per shift for branch-wide targets and adds a named column per place', async () => {
    renderWithProviders(<CoverageGrid report={REPORT} />);
    const headers = () => screen.getAllByRole('columnheader').slice(1).map((h) => h.textContent);
    await waitFor(() => expect(headers()).toEqual([
      'Morning06:00–14:00Whole branch',
      'Morning06:00–14:00Location: Site A › Floor 2',
      'Morning06:00–14:00Location: Site B',
      'Night22:00–06:00',
    ]));
    // branch-wide cells keep their id and look; a place's cell carries the place
    expect(screen.getByTestId(`cell-2026-10-11-${MORNING}`)).toHaveTextContent('4 / 4');
    expect(screen.getByTestId(`cell-2026-10-12-${MORNING}`)).toHaveTextContent('short by 1');
    const floor = screen.getByTestId(`cell-2026-10-11-${MORNING}-${N_F2}`);
    expect(floor).toHaveTextContent('1 / 2');
    expect(floor).toHaveTextContent('short by 1');
    expect(floor.className).toContain('bg-chart-absent');
    expect(screen.getByTestId(`cell-2026-10-12-${MORNING}-${N_F2}`).className).toContain('bg-chart-present');
    expect(screen.getByTestId(`cell-2026-10-11-${NIGHT}`)).toHaveTextContent('2 / 2');
    expect(screen.getByTestId('coverage-gaps')).toHaveTextContent('Shifts short of people: 2');
  });

  it('orders the columns by shift, the whole branch first, then the places by path; a shift without cells keeps its column', () => {
    const label = (id: string) => ({ [N_F2]: 'Site A › Floor 2', [N_SB]: 'Site B' })[id] ?? id;
    const cols = coverageColumns({ ...REPORT, days: [{ date: '2026-10-11', cells: REPORT.days[0]!.cells.filter((c) => c.shiftId === MORNING) }] }, label);
    expect(cols.map((c) => [c.shiftId === MORNING ? 'M' : 'N', c.locationId ? label(c.locationId) : 'branch', c.besidePlaces])).toEqual([
      ['M', 'branch', true], ['M', 'Site A › Floor 2', false], ['M', 'Site B', false], ['N', 'branch', false],
    ]);
  });
});
