import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { LocationLevelIcon, LocationLevelRole } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import i18n from '@/lib/i18n';
import { ApiError, apiMock, grant, grantAll, mockGet, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { LocationsTab } from './locations-tab';

/** Waits that need the levels and the locations to load (slower when the whole suite runs in parallel). */
const SLOW = { timeout: 5_000 };

const T = '2026-10-10T00:00:00Z';
const level = (id: string, position: number, role: LocationLevelRole, name: string, nameAr: string, icon: LocationLevelIcon, locationCount: number) =>
  ({ id, organizationId: 'org-1', position, role, name, nameAr, icon, locationCount, createdAt: T, updatedAt: T });
const node = (id: string, parentId: string | null, levelId: string, role: LocationLevelRole, name: string, extra: Record<string, unknown> = {}) => ({
  id, organizationId: 'org-1', levelId, role, parentId, branchId: null, code: name.toUpperCase().replace(/\W+/g, '-'), name, nameAr: null, latitude: null, longitude: null,
  path: [], depth: 1, status: 'active', employeeCount: 0, deviceCount: 0, childCount: 0, createdAt: T, updatedAt: T, ...extra,
});

// Headquarters → Branch → Site → Floor → Zone, as the customer described it
const LEVELS = [
  level('l-hq', 1, 'group', 'Headquarters', 'المقر الرئيسي', 'headquarters', 1),
  level('l-br', 2, 'branch', 'Branch', 'فرع', 'branch', 2),
  level('l-site', 3, 'place', 'Site', 'موقع', 'site', 2),
  level('l-floor', 4, 'place', 'Floor', 'طابق', 'floor', 1),
  level('l-zone', 5, 'place', 'Zone', 'منطقة', 'zone', 0),
];
const NODES = [
  node('n-hq', null, 'l-hq', 'group', 'Muscat HQ', { nameAr: 'المقر في مسقط', employeeCount: 12, deviceCount: 3 }),
  node('n-b1', 'n-hq', 'l-br', 'branch', 'Branch 1', { branchId: 'b1', employeeCount: 8, deviceCount: 2 }),
  node('n-b2', 'n-hq', 'l-br', 'branch', 'Branch 2', { branchId: 'b2', employeeCount: 4, deviceCount: 1 }),
  node('n-sa', 'n-b1', 'l-site', 'place', 'Site A', { branchId: 'b1', nameAr: 'الموقع أ', employeeCount: 5, deviceCount: 1 }),
  node('n-f2', 'n-sa', 'l-floor', 'place', 'Floor 2', { branchId: 'b1', employeeCount: 2 }),
  node('n-sx', 'n-b2', 'l-site', 'place', 'Site X', { branchId: 'b2' }),
];
const ARCHIVED = node('n-old', 'n-b2', 'l-site', 'place', 'Old Site', { branchId: 'b2', status: 'archived' });
/** A tenant on its first day of the hierarchy: the branch level only, the branches at the top. */
const SIMPLE_LEVELS = [level('l-br', 1, 'branch', 'Branch', 'فرع', 'branch', 2)];
const SIMPLE_NODES = [node('n-b1', null, 'l-br', 'branch', 'Branch 1', { branchId: 'b1' }), node('n-b2', null, 'l-br', 'branch', 'Branch 2', { branchId: 'b2' })];

function serve(levels: unknown[] = LEVELS, nodes: unknown[] = NODES) {
  mockGet({
    '/orgs/org-1/location-levels': { data: levels },
    '/orgs/org-1/locations': (q: Record<string, unknown> | undefined) => ({ data: q?.['includeArchived'] ? [...nodes, ARCHIVED] : nodes }),
    '/orgs/org-1/holiday-calendars': { data: [] },
    '/orgs/org-1/branches/b1': { data: { id: 'b1', organizationId: 'org-1', code: 'B1', name: 'Branch 1', nameAr: null, countryCode: 'OM', city: null, address: {}, timezone: 'Asia/Muscat', latitude: null, longitude: null, geofenceRadiusM: null, contact: {}, weeklyOffDays: null, holidayCalendarId: null, status: 'active', locationId: 'n-b1', parentLocationId: 'n-hq', createdAt: T, updatedAt: T } },
  });
}
const openMenu = (name: string) => fireEvent.keyDown(screen.getByRole('button', { name }), { key: 'ArrowDown' });
const chain = () => screen.getByRole('list', { name: 'Levels, from the top down' });
const cmdkItems = () => [...document.querySelectorAll('[cmdk-item]')].map((el) => el.textContent ?? '');
/** What a screen reader gets from an element: its text without the aria-hidden parts. */
const spoken = (el: Element) => { const copy = el.cloneNode(true) as Element; copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove()); return copy.textContent ?? ''; };
/** The role captions shown above the first level of each kind. */
const captions = (items: HTMLElement[]) => items.map((li) => li.firstElementChild?.textContent ?? '');

describe('Organisation → Locations', () => {
  beforeEach(() => { resetApiMock(); grantAll(); serve(); });
  afterEach(() => { testState.allBranches = true; testState.branchIds = []; });

  it('shows the levels top first with their role and count, and the tree with rolled-up counts', async () => {
    renderWithProviders(<LocationsTab />);
    await screen.findByText('Muscat HQ', {}, SLOW);
    const items = within(chain()).getAllByRole('listitem');
    expect(items.map(spoken)).toEqual([
      'HeadquartersGrouping · 1 location', 'BranchOperating unit · 2 branches', 'SitePlace in a branch · 2 locations', 'FloorPlace in a branch · 1 location', 'ZonePlace in a branch · 0 locations',
    ]);
    expect(captions(items)).toEqual(['Grouping', 'Operating unit', 'Place in a branch', '', '']);
    const hq = screen.getByTestId('loc-node-n-hq');
    expect(within(hq).getByRole('img', { name: '12 employees' })).toBeInTheDocument();
    expect(within(hq).getByRole('img', { name: '3 devices' })).toBeInTheDocument();
    // the whole (small) tree opens expanded, depth-first
    expect(screen.getByText('Floor 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse Muscat HQ' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Site A' }));
    expect(screen.queryByText('Floor 2')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryByText('Branch 1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByText('Floor 2')).toBeInTheDocument();
  });

  it('inserts a level above another at that level\'s position, saying which role it will get', async () => {
    apiMock.post.mockResolvedValue({ data: LEVELS });
    renderWithProviders(<LocationsTab />);
    await screen.findByText('Muscat HQ', {}, SLOW);

    openMenu('Actions for the Site level');
    fireEvent.click(await screen.findByRole('menuitem', { name: /Add a level above/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a level' });
    expect(within(dialog).getByRole('combobox', { name: /Position/ })).toHaveTextContent('Between Branch and Site');
    expect(within(dialog).getByTestId('level-role-note')).toHaveTextContent('Place in a branch. It sits below Branch');

    // moving the insertion point above the branch level makes it a grouping level
    fireEvent.keyDown(within(dialog).getByRole('combobox', { name: /Position/ }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Between Headquarters and Branch' }));
    expect(within(dialog).getByTestId('level-role-note')).toHaveTextContent('Grouping. It sits above Branch');
    fireEvent.keyDown(within(dialog).getByRole('combobox', { name: /Position/ }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Between Branch and Site' }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Add a level' }));
    expect(await within(dialog).findByText('Enter a name.')).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText(/Name \(English\)/), { target: { value: 'Building' } });
    fireEvent.change(within(dialog).getByLabelText(/Name \(Arabic\)/), { target: { value: 'مبنى' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Building' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add a level' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/location-levels', { name: 'Building', nameAr: 'مبنى', icon: 'building', position: 3 }));
  });

  it('adds a level below the branch level at the next position, as a place level', async () => {
    apiMock.post.mockResolvedValue({ data: LEVELS });
    renderWithProviders(<LocationsTab />);
    await screen.findByText('Muscat HQ', {}, SLOW);
    openMenu('Actions for the Branch level');
    fireEvent.click(await screen.findByRole('menuitem', { name: /Add a level below/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a level' });
    expect(within(dialog).getByTestId('level-role-note')).toHaveTextContent('Place in a branch');
    fireEvent.change(within(dialog).getByLabelText(/Name \(English\)/), { target: { value: 'Campus' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add a level' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/location-levels', expect.objectContaining({ name: 'Campus', position: 3 })));
    expect(apiMock.post.mock.calls[0]![1]).not.toHaveProperty('nameAr');
  });

  it('renames a level and refuses to delete the branch level or a level in use, with the reason', async () => {
    apiMock.patch.mockResolvedValue({ data: LEVELS[2] });
    apiMock.delete.mockResolvedValue({ data: LEVELS.slice(0, 4) });
    renderWithProviders(<LocationsTab />);
    await screen.findByText('Muscat HQ', {}, SLOW);

    openMenu('Actions for the Branch level');
    const keep = await screen.findByRole('menuitem', { name: /Delete level/ });
    expect(keep).toHaveAttribute('aria-disabled', 'true');
    expect(keep).toHaveAccessibleDescription('Branch is your operating unit: it can be renamed, not deleted.');
    fireEvent.click(keep);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(keep, { key: 'Escape' });

    openMenu('Actions for the Site level');
    expect(await screen.findByRole('menuitem', { name: /Delete level/ })).toHaveAccessibleDescription(/2 locations use this level/);
    fireEvent.click(screen.getByRole('menuitem', { name: /Rename/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename the Site level' });
    expect(within(dialog).queryByRole('combobox', { name: /Position/ })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(/Name \(English\)/), { target: { value: 'Compound' } });
    fireEvent.change(within(dialog).getByLabelText(/Name \(Arabic\)/), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/orgs/org-1/location-levels/l-site', { name: 'Compound', nameAr: null, icon: 'site' }));

    openMenu('Actions for the Zone level');
    fireEvent.click(await screen.findByRole('menuitem', { name: /Delete level/ }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete the Zone level?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete level' }));
    await waitFor(() => expect(apiMock.delete).toHaveBeenCalledWith('/orgs/org-1/location-levels/l-zone'));
  });

  it('explains a flat organisation and applies a template by its key', async () => {
    serve(SIMPLE_LEVELS, SIMPLE_NODES);
    apiMock.post.mockResolvedValue({ data: LEVELS });
    renderWithProviders(<LocationsTab />);
    const simple = await screen.findByTestId('locations-simple', {}, SLOW);
    expect(simple).toHaveTextContent('One level for now: Branch');
    expect(simple).toHaveTextContent('Headquarters → Branch → Site → Floor → Zone');
    // the branches still show in the tree
    expect(await screen.findByText('Branch 2', {}, SLOW)).toBeInTheDocument();

    fireEvent.click(within(simple).getByRole('button', { name: 'Use a template' }));
    const dialog = await screen.findByRole('dialog', { name: 'Use a template' });
    expect(within(dialog).queryByTestId('template-blocked')).toBeNull();
    const simpleCard = within(dialog).getByRole('radio', { name: /^Simple/ });
    expect(simpleCard.closest('label')).toHaveTextContent('Current');
    const facilities = within(dialog).getByRole('radio', { name: /^Facilities/ }).closest('label')!;
    expect(facilities).toHaveTextContent('SiteBuildingFloorZone'); // the template's chain, top first
    expect(facilities).toHaveTextContent('ISO 16739 (IFC)');
    const apply = within(dialog).getByRole('button', { name: 'Apply template' });
    expect(apply).toBeDisabled(); // nothing chosen yet

    fireEvent.click(within(dialog).getByRole('radio', { name: /^Corporate/ }));
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/location-levels/apply-template', { template: 'CORPORATE' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Use a template' })).toBeNull());
  });

  it('refuses a template up front while group or place locations exist', async () => {
    renderWithProviders(<LocationsTab />);
    await screen.findByText('Muscat HQ', {}, SLOW);
    fireEvent.click(screen.getByRole('button', { name: 'Use a template' }));
    const dialog = await screen.findByRole('dialog', { name: 'Use a template' });
    expect(within(dialog).getByTestId('template-blocked')).toHaveTextContent('only be applied while there is no group or place location');
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Retail/ }));
    expect(within(dialog).getByRole('button', { name: 'Apply template' })).toBeDisabled();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('explains a template the server refuses because a location appeared meanwhile (409)', async () => {
    serve(SIMPLE_LEVELS, SIMPLE_NODES);
    apiMock.post.mockRejectedValue(new ApiError(409, 'CONFLICT', 'Group or place locations exist.'));
    renderWithProviders(<LocationsTab />);
    fireEvent.click(within(await screen.findByTestId('locations-simple', {}, SLOW)).getByRole('button', { name: 'Use a template' }));
    const dialog = await screen.findByRole('dialog', { name: 'Use a template' });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Regional/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply template' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The template was not applied: the organisation now has group or place locations.');
    expect(screen.getByRole('dialog', { name: 'Use a template' })).toBeInTheDocument(); // stays open
  });

  it('adds a place under a branch with only the levels a child may use', async () => {
    apiMock.post.mockResolvedValue({ data: node('n-new', 'n-b1', 'l-floor', 'place', 'Floor 1', { branchId: 'b1' }) });
    renderWithProviders(<LocationsTab />);
    await screen.findByText('Muscat HQ', {}, SLOW);

    openMenu('Actions for Branch 1');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add a location inside' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a location to Branch 1' });
    expect(dialog).toHaveTextContent('Inside: Muscat HQ › Branch 1');
    const levelSelect = within(dialog).getByRole('combobox', { name: /Level/ });
    fireEvent.keyDown(levelSelect, { key: 'ArrowDown' });
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Site', 'Floor', 'Zone']);
    fireEvent.click(screen.getByRole('option', { name: 'Floor' }));

    fireEvent.change(within(dialog).getByLabelText(/Name \(English\)/), { target: { value: 'Floor 1' } });
    fireEvent.change(within(dialog).getByLabelText(/Name \(Arabic\)/), { target: { value: 'الطابق الأول' } });
    fireEvent.change(within(dialog).getByLabelText(/Latitude/), { target: { value: '23.5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('Give both the latitude and the longitude, or neither.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Longitude/), { target: { value: '58.4' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/locations', { levelId: 'l-floor', parentId: 'n-b1', name: 'Floor 1', nameAr: 'الطابق الأول', latitude: 23.5, longitude: 58.4 }));
  });

  it('offers a place only the deeper place levels, and a new top-level location only the group levels', async () => {
    renderWithProviders(<LocationsTab />);
    await screen.findByText('Muscat HQ', {}, SLOW);
    openMenu('Actions for Site A');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add a location inside' }));
    let dialog = await screen.findByRole('dialog', { name: 'Add a location to Site A' });
    fireEvent.keyDown(within(dialog).getByRole('combobox', { name: /Level/ }), { key: 'ArrowDown' });
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Floor', 'Zone']);
    fireEvent.keyDown(screen.getAllByRole('option')[0]!, { key: 'Escape' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Add Headquarters' }));
    dialog = await screen.findByRole('dialog', { name: 'Add a top-level location' });
    expect(within(dialog).getByRole('combobox', { name: /Level/ })).toHaveTextContent('Headquarters');
    expect(within(dialog).getByRole('combobox', { name: /Level/ })).toBeDisabled(); // the only group level
  });

  it('edits a place: re-levels among the valid levels and sends only what changed', async () => {
    apiMock.patch.mockResolvedValue({ data: NODES[4] });
    renderWithProviders(<LocationsTab />);
    await screen.findByText('Muscat HQ', {}, SLOW);
    openMenu('Actions for Floor 2');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Floor 2' });
    expect(within(dialog).getByLabelText(/^Code/)).toHaveValue('FLOOR-2');
    fireEvent.keyDown(within(dialog).getByRole('combobox', { name: /Level/ }), { key: 'ArrowDown' });
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Floor', 'Zone']);
    fireEvent.click(screen.getByRole('option', { name: 'Zone' }));
    fireEvent.change(within(dialog).getByLabelText(/Name \(Arabic\)/), { target: { value: 'المنطقة 2' } });
    fireEvent.change(within(dialog).getByLabelText(/^Code/), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Enter a code.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/^Code/), { target: { value: 'Z-2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/orgs/org-1/locations/n-f2', { levelId: 'l-zone', code: 'Z-2', nameAr: 'المنطقة 2' }));
  });

  it('archives a location and says what still uses it when the server refuses', async () => {
    apiMock.delete.mockRejectedValue(new ApiError(409, 'CONFLICT', 'The location is in use.', 'req-1', { children: 1, devices: 2, employees: 3 }));
    renderWithProviders(<LocationsTab />);
    await screen.findByText('Muscat HQ', {}, SLOW);
    openMenu('Actions for Site A');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive Site A?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(apiMock.delete).toHaveBeenCalledWith('/orgs/org-1/locations/n-sa'));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Site A is still in use: 1 active location inside it, 3 employees, and 2 devices. Move or archive them first.');
  });

  it('moves a place under a valid parent only, and explains a refused move to another branch', async () => {
    apiMock.patch.mockRejectedValue(new ApiError(409, 'CONFLICT', 'The place is referenced.'));
    renderWithProviders(<LocationsTab />);
    await screen.findByText('Muscat HQ', {}, SLOW);
    openMenu('Actions for Floor 2');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move Floor 2' });
    expect(dialog).toHaveTextContent('Now inside: Muscat HQ › Branch 1 › Site A');
    const move = within(dialog).getByRole('button', { name: 'Move' });
    expect(move).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('combobox'));
    await waitFor(() => expect(cmdkItems()).toEqual(['Branch 1Branch', 'Site ASite', 'Branch 2Branch', 'Site XSite']));
    fireEvent.click(screen.getByRole('option', { name: /Site X/ }));
    expect(await within(dialog).findByTestId('move-cross-branch')).toHaveTextContent('This puts it in another branch');
    fireEvent.click(move);
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/orgs/org-1/locations/n-f2', { parentId: 'n-sx' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The move was refused');
  });

  it('places a branch under a group, or at the top, and opens the branch dialog for its record', async () => {
    apiMock.patch.mockResolvedValue({ data: NODES[2] });
    renderWithProviders(<LocationsTab />);
    await screen.findByText('Muscat HQ', {}, SLOW);
    openMenu('Actions for Branch 2');
    expect(await screen.findByRole('menuitem', { name: 'Edit branch' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull(); // a branch node follows its branch
    fireEvent.click(screen.getByRole('menuitem', { name: 'Place under…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Place Branch 2 under…' });
    fireEvent.click(within(dialog).getByRole('combobox'));
    await waitFor(() => expect(cmdkItems()).toEqual(['Muscat HQHeadquarters']));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.click(within(dialog).getByLabelText('Clear'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/orgs/org-1/locations/n-b2', { parentId: null }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    openMenu('Actions for Branch 1');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit branch' }));
    // the node carries the branch id only: the record is loaded, then the branch dialog opens on it
    await waitFor(() => expect(screen.getByLabelText(/^Code/)).toHaveValue('B1'), SLOW);
    expect(screen.getByRole('dialog', { name: 'Edit branch' })).toBeInTheDocument();
  });

  it('shows archived locations on request and restores them', async () => {
    apiMock.patch.mockResolvedValue({ data: { ...ARCHIVED, status: 'active' } });
    renderWithProviders(<LocationsTab />);
    await screen.findByText('Muscat HQ', {}, SLOW);
    expect(screen.queryByText('Old Site')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Show archived' }));
    const row = await screen.findByTestId('loc-node-n-old', {}, SLOW);
    expect(row).toHaveTextContent('Archived');
    openMenu('Actions for Old Site');
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Restore' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/orgs/org-1/locations/n-old', { status: 'active' }));
  });

  it('filters the tree to the matches and their ancestors', async () => {
    renderWithProviders(<LocationsTab />);
    await screen.findByText('Muscat HQ', {}, SLOW);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search locations' }), { target: { value: 'floor' } });
    await waitFor(() => expect(screen.queryByText('Branch 2')).toBeNull());
    for (const name of ['Muscat HQ', 'Branch 1', 'Site A', 'Floor 2']) expect(screen.getByText(name)).toBeInTheDocument();
    expect(screen.queryByText('Site X')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search locations' }), { target: { value: 'nowhere' } });
    expect(await screen.findByText('No location matches “nowhere”.')).toBeInTheDocument();
  });

  it('gives a branch-scoped manager the places of their branches and nothing of the structure', async () => {
    grant('branch.view', 'branch.manage');
    testState.allBranches = false; testState.branchIds = ['b1'];
    renderWithProviders(<LocationsTab />);
    await screen.findByText('Muscat HQ', {}, SLOW);
    expect(screen.getByText(/Only members with access to every branch can change the levels/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use a template' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a level' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Actions for the .* level$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add Headquarters' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions for Muscat HQ' })).toBeNull(); // a group node
    expect(screen.queryByRole('button', { name: 'Actions for Branch 2' })).toBeNull(); // not their branch
    expect(screen.queryByRole('button', { name: 'Actions for Site X' })).toBeNull();

    openMenu('Actions for Branch 1');
    expect(await screen.findByRole('menuitem', { name: 'Add a location inside' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Edit branch' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Place under…' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Edit branch' }), { key: 'Escape' });
    openMenu('Actions for Site A');
    expect(await screen.findByRole('menuitem', { name: 'Archive' })).toBeInTheDocument();
  });

  it('a member who may only view sees the levels and the tree without any action', async () => {
    grant('branch.view');
    renderWithProviders(<LocationsTab />);
    await screen.findByText('Muscat HQ', {}, SLOW);
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    expect(screen.queryByText(/Only members with access to every branch/)).toBeNull();
  });

  it('shows the organisation\'s Arabic names in the Arabic UI', async () => {
    await i18n.changeLanguage('ar');
    try {
      renderWithProviders(<LocationsTab />);
      expect(await screen.findByText('المقر في مسقط', {}, SLOW)).toBeInTheDocument();
      expect(screen.getByText('الموقع أ')).toBeInTheDocument();
      expect(screen.getByText('Branch 1')).toBeInTheDocument(); // no Arabic name: the name
      const levels = screen.getByRole('list', { name: 'المستويات من الأعلى إلى الأسفل' });
      expect(within(levels).getAllByRole('listitem').map(spoken)).toEqual([
        'المقر الرئيسيتجميع · موقع واحد', 'فرعوحدة تشغيلية · فرعان', 'موقعمكان داخل الفرع · موقعان', 'طابقمكان داخل الفرع · موقع واحد', 'منطقةمكان داخل الفرع · لا مواقع',
      ]);
      expect(within(screen.getByTestId('loc-node-n-hq')).getByRole('img', { name: '12 موظفًا' })).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
