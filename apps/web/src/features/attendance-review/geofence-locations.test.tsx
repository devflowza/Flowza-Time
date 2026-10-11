import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { GeofenceDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { BRANCHES, BRANCH_1, LOC, SIMPLE_LEVELS, SIMPLE_NODES, locationRoutes } from '@/features/employees/location-test-fixtures';
import GeofencesPage from './pages/geofences-page';

/** The place a geofence outlines (docs/locations.md §2): a place of the fence's branch; the list shows and filters it. */

const ORG = 'org-1';
const fence = (over: Partial<GeofenceDto> = {}): GeofenceDto => ({
  id: 'f0000000-0000-4000-8000-000000000001', organizationId: ORG, branchId: null, branchName: null, name: 'HQ', latitude: 23.588, longitude: 58.3829, radiusM: 150, polygon: null,
  enforcement: 'hard_block', accuracyThresholdM: 100, graceM: 0, activeFrom: null, activeTo: null, timeWindows: [], isActive: true, assignments: [], createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z', editable: true, ...over,
});

/** Open a combobox and pick an option of its list by its label. */
async function pick(combobox: HTMLElement, label: string) {
  fireEvent.click(combobox);
  const option = await within(await screen.findByRole('listbox')).findByText(label);
  fireEvent.click(option.closest('[cmdk-item]') ?? option);
}
/** Radix Select: open with the keyboard, pick the option. */
async function choose(trigger: HTMLElement, option: string) {
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

describe('geofence location', () => {
  beforeEach(() => { resetApiMock(); grantAll(); });

  it('asks for a site first, then offers its places and saves the fence with its location', async () => {
    mockGet({ [`/orgs/${ORG}/geofences`]: { data: [] }, [`/orgs/${ORG}/branches`]: page(BRANCHES), ...locationRoutes(), '*': page([]) });
    apiMock.post.mockResolvedValue({ data: fence({ id: 'f2', name: 'Yard' }) });
    renderWithProviders(<GeofencesPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: /New geofence/ }))[0]!);
    const dialog = within(await screen.findByRole('dialog'));

    // organisation-wide: a place belongs to one site, so the field waits for one
    const location = await dialog.findByRole('combobox', { name: /^Location/ });
    expect(location).toBeDisabled();
    expect(dialog.getByText('Choose a site first: a location belongs to one site.')).toBeInTheDocument();

    await choose(dialog.getByRole('combobox', { name: /^Site/ }), 'Branch 1');
    await waitFor(() => expect(dialog.getByRole('combobox', { name: /^Location/ })).toBeEnabled());
    expect(dialog.getByText('The place inside the site this zone outlines, e.g. a building or a yard.')).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('combobox', { name: /^Location/ }));
    const places = within(await screen.findByRole('listbox'));
    expect(await places.findByText('Floor 2')).toBeInTheDocument();
    expect(places.queryByText('Site X')).not.toBeInTheDocument();
    fireEvent.click(places.getByText('Site A').closest('[cmdk-item]')!);
    await waitFor(() => expect(dialog.getByRole('combobox', { name: /^Location/ })).toHaveTextContent('Site A'));

    fireEvent.change(dialog.getByLabelText(/^Name/), { target: { value: 'Yard' } });
    fireEvent.change(dialog.getByLabelText(/^Latitude/), { target: { value: '23.6' } });
    fireEvent.change(dialog.getByLabelText(/^Longitude/), { target: { value: '58.4' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/orgs/${ORG}/geofences`, expect.objectContaining({ name: 'Yard', branchId: BRANCH_1, locationId: LOC.siteA })));
  });

  it('clears the place when the fence becomes organisation-wide (null on the PATCH)', async () => {
    mockGet({ [`/orgs/${ORG}/geofences`]: { data: [fence({ branchId: BRANCH_1, branchName: 'Branch 1', locationId: LOC.siteA, locationName: 'Site A' })] }, [`/orgs/${ORG}/branches`]: page(BRANCHES), ...locationRoutes(), '*': page([]) });
    apiMock.patch.mockResolvedValue({ data: fence() });
    renderWithProviders(<GeofencesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit geofence' }));
    const dialog = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(dialog.getByRole('combobox', { name: /^Location/ })).toHaveTextContent('Site A'));

    await choose(dialog.getByRole('combobox', { name: /^Site/ }), 'Organisation-wide');
    await waitFor(() => expect(dialog.getByRole('combobox', { name: /^Location/ })).toBeDisabled());
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    expect(apiMock.patch.mock.calls[0]![1]).toMatchObject({ branchId: null, locationId: null });
  });

  it('lists the place of each fence and filters the list by a location', async () => {
    mockGet({
      [`/orgs/${ORG}/geofences`]: { data: [fence({ name: 'Yard', branchId: BRANCH_1, branchName: 'Branch 1', locationId: LOC.siteA, locationName: 'Site A' }), fence({ id: 'f0000000-0000-4000-8000-000000000002', name: 'Gate' })] },
      [`/orgs/${ORG}/branches`]: page(BRANCHES), ...locationRoutes(), '*': page([]),
    });
    renderWithProviders(<GeofencesPage />);
    expect(await screen.findByRole('columnheader', { name: 'Location' })).toBeInTheDocument();
    expect(screen.getAllByTestId('geofence-location').map((c) => c.textContent)).toEqual(['Site A', '—']);

    await pick(screen.getByRole('combobox', { name: 'Filter by location' }), 'Muscat HQ');
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith(`/orgs/${ORG}/geofences`, { includeInactive: true, locationId: LOC.hq }));
  });

  it('keeps the dialog and the list unchanged for an organisation without places', async () => {
    mockGet({ [`/orgs/${ORG}/geofences`]: { data: [fence()] }, [`/orgs/${ORG}/branches`]: page(BRANCHES), ...locationRoutes(SIMPLE_LEVELS, SIMPLE_NODES), '*': page([]) });
    apiMock.post.mockResolvedValue({ data: fence({ id: 'f2', name: 'Yard' }) });
    renderWithProviders(<GeofencesPage />);
    await screen.findByTestId('geofence-row');
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith(`/orgs/${ORG}/location-levels`));
    expect(screen.queryByRole('columnheader', { name: 'Location' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Filter by location' })).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: /New geofence/ })[0]!);
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.queryByRole('combobox', { name: /^Location/ })).not.toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText(/^Name/), { target: { value: 'Yard' } });
    fireEvent.change(dialog.getByLabelText(/^Latitude/), { target: { value: '23.6' } });
    fireEvent.change(dialog.getByLabelText(/^Longitude/), { target: { value: '58.4' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect((apiMock.post.mock.calls[0] as [string, Record<string, unknown>])[1]).not.toHaveProperty('locationId');
  });
});
