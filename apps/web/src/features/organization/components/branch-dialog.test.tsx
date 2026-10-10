import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { BranchDto, LocationLevelRole } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { BranchDialog } from './branch-dialog';

/** Waits that need the levels and the locations to load (slower when the whole suite runs in parallel). */
const SLOW = { timeout: 5_000 };

const T = '2026-10-10T00:00:00Z';
const HQ = '10000000-0000-4000-8000-000000000001';
const NORTH = '10000000-0000-4000-8000-000000000002';
const level = (id: string, position: number, role: LocationLevelRole, name: string) => ({ id, organizationId: 'org-1', position, role, name, nameAr: null, icon: 'other', locationCount: 1, createdAt: T, updatedAt: T });
const node = (id: string, parentId: string | null, levelId: string, role: LocationLevelRole, name: string, branchId: string | null = null) => ({
  id, organizationId: 'org-1', levelId, role, parentId, branchId, code: name.toUpperCase().replace(/\W+/g, '-'), name, nameAr: null, latitude: null, longitude: null,
  path: [], depth: 1, status: 'active', employeeCount: 0, deviceCount: 0, childCount: 0, createdAt: T, updatedAt: T,
});
/** Headquarters → Region → Branch: branches can sit under Muscat HQ or the Northern Region. */
const HIERARCHY = {
  '/orgs/org-1/location-levels': { data: [level('l-hq', 1, 'group', 'Headquarters'), level('l-rg', 2, 'group', 'Region'), level('l-br', 3, 'branch', 'Branch')] },
  '/orgs/org-1/locations': { data: [node(HQ, null, 'l-hq', 'group', 'Muscat HQ'), node(NORTH, HQ, 'l-rg', 'group', 'Northern Region'), node('n-b1', NORTH, 'l-br', 'branch', 'Sohar', 'b1')] },
};
const SOHAR: BranchDto = {
  id: 'b1', organizationId: 'org-1', code: 'SOH', name: 'Sohar', nameAr: null, countryCode: 'OM', city: null, address: {}, timezone: 'Asia/Muscat', latitude: null, longitude: null,
  geofenceRadiusM: null, contact: {}, weeklyOffDays: null, holidayCalendarId: null, status: 'active', locationId: 'n-b1', parentLocationId: NORTH, createdAt: T, updatedAt: T,
};
const items = () => [...document.querySelectorAll('[cmdk-item]')].map((el) => el.textContent ?? '');

describe('BranchDialog — place in the location hierarchy', () => {
  beforeEach(() => { resetApiMock(); grantAll(); mockGet(HIERARCHY); });
  afterEach(() => { testState.allBranches = true; testState.branchIds = []; });

  it('places a new branch under a group location', async () => {
    apiMock.post.mockResolvedValue({ data: { ...SOHAR } });
    renderWithProviders(<BranchDialog open onOpenChange={() => {}} branch={null} orgTimezone="Asia/Muscat" />);
    const partOf = await screen.findByLabelText('Part of', {}, SLOW);
    expect(partOf).toHaveTextContent('Top level');
    fireEvent.click(partOf);
    await waitFor(() => expect(items()).toEqual(['Muscat HQHeadquarters', 'Northern RegionRegion'])); // group locations only
    fireEvent.click(screen.getByRole('option', { name: /Northern Region/ }));
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: 'SOH' } });
    fireEvent.change(screen.getByLabelText(/^Name\*?$/), { target: { value: 'Sohar' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/branches', expect.objectContaining({ code: 'SOH', parentLocationId: NORTH })));
  });

  it('creates a branch at the top level with an explicit null, or under the preset group', async () => {
    apiMock.post.mockResolvedValue({ data: { ...SOHAR } });
    const first = renderWithProviders(<BranchDialog open onOpenChange={() => {}} branch={null} orgTimezone="Asia/Muscat" />);
    await screen.findByLabelText('Part of', {}, SLOW);
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: 'MCT' } });
    fireEvent.change(screen.getByLabelText(/^Name\*?$/), { target: { value: 'Muscat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/branches', expect.objectContaining({ code: 'MCT', parentLocationId: null })));
    first.unmount();

    apiMock.post.mockClear();
    renderWithProviders(<BranchDialog open onOpenChange={() => {}} branch={null} orgTimezone="Asia/Muscat" defaultParentLocationId={HQ} />);
    await waitFor(() => expect(screen.getByLabelText('Part of')).toHaveTextContent('Muscat HQ'), SLOW);
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: 'SUR' } });
    fireEvent.change(screen.getByLabelText(/^Name\*?$/), { target: { value: 'Sur' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/branches', expect.objectContaining({ code: 'SUR', parentLocationId: HQ })));
  });

  it('sends the placement on update only when it changed (null = moved to the top level)', async () => {
    apiMock.patch.mockResolvedValue({ data: { ...SOHAR } });
    const first = renderWithProviders(<BranchDialog open onOpenChange={() => {}} branch={SOHAR} orgTimezone="Asia/Muscat" />);
    await waitFor(() => expect(screen.getByLabelText('Part of')).toHaveTextContent('Northern Region'), SLOW);
    fireEvent.change(screen.getByLabelText(/^Name\*?$/), { target: { value: 'Sohar Port' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    const [path, untouched] = apiMock.patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/orgs/org-1/branches/b1');
    expect(untouched).toMatchObject({ name: 'Sohar Port' });
    expect(untouched).not.toHaveProperty('parentLocationId');
    first.unmount();

    apiMock.patch.mockClear();
    renderWithProviders(<BranchDialog open onOpenChange={() => {}} branch={SOHAR} orgTimezone="Asia/Muscat" />);
    await waitFor(() => expect(screen.getByLabelText('Part of')).toHaveTextContent('Northern Region'), SLOW);
    fireEvent.click(screen.getByLabelText('Clear'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/orgs/org-1/branches/b1', expect.objectContaining({ parentLocationId: null })));
  });

  it('shows a branch-scoped member the placement read-only and never sends it', async () => {
    testState.allBranches = false; testState.branchIds = ['b1'];
    apiMock.patch.mockResolvedValue({ data: { ...SOHAR } });
    renderWithProviders(<BranchDialog open onOpenChange={() => {}} branch={SOHAR} orgTimezone="Asia/Muscat" />);
    const partOf = await screen.findByLabelText('Part of', {}, SLOW);
    expect(partOf).toBeDisabled();
    expect(screen.getByText('Only members with access to every branch can change where a branch sits.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    expect((apiMock.patch.mock.calls[0] as [string, Record<string, unknown>])[1]).not.toHaveProperty('parentLocationId');
  });

  it('has no placement field while the organisation has no level above its branches', async () => {
    mockGet({ '/orgs/org-1/location-levels': { data: [level('l-br', 1, 'branch', 'Branch')] }, '/orgs/org-1/locations': { data: [] } });
    apiMock.post.mockResolvedValue({ data: { ...SOHAR } });
    renderWithProviders(<BranchDialog open onOpenChange={() => {}} branch={null} orgTimezone="Asia/Muscat" />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/location-levels'));
    expect(screen.queryByLabelText('Part of')).toBeNull();
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: 'MCT' } });
    fireEvent.change(screen.getByLabelText(/^Name\*?$/), { target: { value: 'Muscat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect((apiMock.post.mock.calls[0] as [string, Record<string, unknown>])[1]).not.toHaveProperty('parentLocationId');
  });
});

describe('BranchDialog', () => {
  beforeEach(() => { resetApiMock(); grantAll(); mockGet({}); });

  it('validates with branchInputSchema and posts numeric coordinates + inherited weekly-off days', async () => {
    apiMock.post.mockResolvedValue({ data: { id: 'b1' } });
    const onOpenChange = vi.fn();
    renderWithProviders(<BranchDialog open onOpenChange={onOpenChange} branch={null} orgTimezone="Asia/Muscat" />);

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(2)); // code + name required
    expect(apiMock.post).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: 'MCT' } });
    fireEvent.change(screen.getByLabelText(/^Name\*?$/), { target: { value: 'Muscat HQ' } });
    fireEvent.change(screen.getByLabelText(/Latitude/), { target: { value: '23.588' } });
    fireEvent.change(screen.getByLabelText(/Longitude/), { target: { value: '58.3829' } });
    fireEvent.change(screen.getByLabelText(/Geofence/), { target: { value: '5' } }); // below the 10 m minimum
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText(/>=10/);
    expect(apiMock.post).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Geofence/), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [path, body] = apiMock.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/orgs/org-1/branches');
    expect(body).toMatchObject({ code: 'MCT', name: 'Muscat HQ', timezone: 'Asia/Muscat', countryCode: 'OM', latitude: 23.588, longitude: 58.3829, geofenceRadiusM: 150, weeklyOffDays: null, status: 'active' });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('lets a branch override the weekly off days', async () => {
    apiMock.post.mockResolvedValue({ data: { id: 'b1' } });
    renderWithProviders(<BranchDialog open onOpenChange={() => {}} branch={null} orgTimezone="Asia/Dubai" />);
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: 'DXB' } });
    fireEvent.change(screen.getByLabelText(/^Name\*?$/), { target: { value: 'Dubai' } });
    fireEvent.click(screen.getByRole('switch', { name: /Use organisation weekly off days/ }));
    const group = await screen.findByRole('group', { name: 'Weekly off days' });
    expect(group).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sun' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Fri' })); // untoggle default Fri
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalled());
    expect((apiMock.post.mock.calls[0] as [string, { weeklyOffDays: number[]; timezone: string }])[1]).toMatchObject({ weeklyOffDays: [0, 6], timezone: 'Asia/Dubai' });
  });
});
