import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { DeviceCapabilities, DeviceDto, DeviceProviderDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { BRANCHES, BRANCH_1, BRANCH_2, LOC, SIMPLE_LEVELS, SIMPLE_NODES, locationRoutes } from '@/features/employees/location-test-fixtures';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/devices.json';
import ar from '@/locales/ar/devices.json';
import enSync from '@/locales/en/sync.json';
import arSync from '@/locales/ar/sync.json';
import type { DeviceDetail } from './api';
import DeviceNewPage from './pages/device-new-page';
import DevicesListPage from './pages/devices-list-page';
import DeviceDetailPage from './pages/device-detail-page';
import { SettingsTab } from './components/detail/settings-tab';

registerNamespace('devices', en, ar);
registerNamespace('sync', enSync, arSync);

/** Where a terminal is installed (docs/locations.md §2): a place of its branch, a list column and filter, the detail header. */

const caps: DeviceCapabilities = {
  attendancePull: true, attendancePush: false, employeePush: true, employeePull: false, employeeDelete: false, fingerprint: true, face: false, card: true, pin: true,
  deviceStatus: true, remoteRestart: false, webhooks: false, devicePush: false, biometricTemplatePush: false,
};
const PROVIDER: DeviceProviderDto = {
  key: 'zkteco', vendor: 'ZKTeco', name: 'ZKTeco push SDK', description: null, integrationType: 'ON_PREM_SERVER_API', status: 'available', capabilities: caps,
  configSchema: { fields: [{ key: 'host', label: 'Host', type: 'text', required: true, secret: false }] }, verificationStatus: 'VERIFIED', docsUrl: null,
};
const device = (over: Partial<DeviceDetail> = {}): DeviceDetail => ({
  id: 'd0000000-0000-4000-8000-000000000001', organizationId: 'org-1', branchId: BRANCH_1, branchName: 'Branch 1', locationId: LOC.floor2, locationName: 'Site A › Floor 2', code: 'GATE-1', name: 'Main gate',
  providerKey: 'zkteco', providerName: 'ZKTeco push SDK', modelId: null, manufacturer: 'ZKTeco', modelName: null, serialNumber: null, timezone: 'Asia/Muscat', integrationType: 'ON_PREM_SERVER_API', endpointUrl: null, config: {},
  capabilities: caps, status: 'active', connectionStatus: 'online', lastHeartbeatAt: null, lastAttendanceSyncAt: null, lastEmployeeSyncAt: null, lastSuccessfulCommunicationAt: null, lastErrorCode: null, lastError: null,
  firmwareVersion: null, offlineThresholdMinutes: 15, autoSyncEnabled: true, syncIntervalMinutes: 15, employeeCount: 3, tags: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  hasPushToken: false, generation: 1, notes: null, consecutiveFailures: 0, pushProtocolKey: null, groupIds: [], ...over,
});

const next = () => fireEvent.click(screen.getByRole('button', { name: /^Next/ }));
/** Open a combobox and pick an option of its list by its label. */
async function pick(combobox: HTMLElement, label: string) {
  fireEvent.click(combobox);
  const listbox = await screen.findByRole('listbox');
  const option = await within(listbox).findByText(label);
  fireEvent.click(option.closest('[cmdk-item]') ?? option);
}
const branchBox = () => screen.getByRole('combobox', { name: /Branch/ });
const locationBox = () => screen.getByRole('combobox', { name: /^Location/ });

describe('device location', () => {
  beforeEach(() => { resetApiMock(); grantAll(); });

  it('offers the places of the chosen branch on registration, clears the choice when the branch changes and sends locationId', async () => {
    mockGet({ '/device-providers': { data: [PROVIDER] }, '/device-models': { data: [] }, '/orgs/org-1/branches': page(BRANCHES), ...locationRoutes() });
    apiMock.post.mockResolvedValue({ data: { device: { id: 'd9', name: 'Main gate' }, pushToken: null, webhookUrl: null, credentialsStored: [], credentialsError: null, testConnectionJobId: null } });
    renderWithProviders(<DeviceNewPage />, { route: '/devices/new', path: '/devices/new' });
    fireEvent.click(await screen.findByRole('radio', { name: /ZKTeco push SDK/ }));
    next();

    fireEvent.change(await screen.findByLabelText(/^Code/), { target: { value: 'GATE-1' } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Main gate' } });
    expect(await screen.findByText('Where the terminal is installed in its branch: a site, floor or zone.')).toBeInTheDocument();
    await pick(branchBox(), 'Branch 1');
    await waitFor(() => expect(branchBox()).toHaveTextContent('Branch 1'));

    // only Branch 1's places, indented under their parents
    fireEvent.click(locationBox());
    const places = within(await screen.findByRole('listbox'));
    expect(await places.findByText('Site A')).toBeInTheDocument();
    expect(places.getByText('Floor 2')).toBeInTheDocument();
    expect(places.queryByText('Site X')).not.toBeInTheDocument();
    fireEvent.click(places.getByText('Floor 2').closest('[cmdk-item]')!);
    await waitFor(() => expect(locationBox()).toHaveTextContent('Floor 2'));

    // another branch: the place no longer belongs to it
    await pick(branchBox(), 'Branch 2');
    await waitFor(() => expect(branchBox()).toHaveTextContent('Branch 2'));
    expect(locationBox()).toHaveTextContent('No specific place');
    await pick(branchBox(), 'Branch 1');
    await waitFor(() => expect(branchBox()).toHaveTextContent('Branch 1'));
    await pick(locationBox(), 'Site A');
    await waitFor(() => expect(locationBox()).toHaveTextContent('Site A'));
    next();

    fireEvent.change(await screen.findByLabelText(/^Host/), { target: { value: 'https://gate.example.test' } });
    next();
    const register = await screen.findByRole('button', { name: /Register device/ });
    expect(screen.getByText('Site A')).toBeInTheDocument(); // the review step names it
    fireEvent.click(register);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalled());
    const [path, body] = apiMock.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/orgs/org-1/devices');
    expect(body).toMatchObject({ branchId: BRANCH_1, locationId: LOC.siteA });
  });

  it('shows no location field to an organisation without place levels', async () => {
    mockGet({ '/device-providers': { data: [PROVIDER] }, '/device-models': { data: [] }, '/orgs/org-1/branches': page(BRANCHES), ...locationRoutes(SIMPLE_LEVELS, SIMPLE_NODES) });
    renderWithProviders(<DeviceNewPage />, { route: '/devices/new', path: '/devices/new' });
    fireEvent.click(await screen.findByRole('radio', { name: /ZKTeco push SDK/ }));
    next();
    await screen.findByLabelText(/^Code/);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/location-levels'));
    expect(screen.queryByRole('combobox', { name: /^Location/ })).not.toBeInTheDocument();
  });

  it('settings: moving the device to another branch clears its place (null on the PATCH); a place of the branch is sent as is', async () => {
    mockGet({ '/device-providers': { data: [PROVIDER] }, '/orgs/org-1/branches': page(BRANCHES), ...locationRoutes() });
    apiMock.patch.mockImplementation(async (_path: string, input: Record<string, unknown>) => ({ data: { ...device(), ...input, credentialsRequired: false } }));
    renderWithProviders(<SettingsTab device={device()} />);
    await waitFor(() => expect(locationBox()).toHaveTextContent('Floor 2'));

    await pick(branchBox(), 'Branch 2');
    await waitFor(() => expect(locationBox()).toHaveTextContent('No specific place'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    expect(apiMock.patch.mock.calls[0]).toEqual([`/orgs/org-1/devices/${device().id}`, { branchId: BRANCH_2, locationId: null }]);

    // the new baseline is Branch 2 without a place: picking Site X sends only the place
    await pick(locationBox(), 'Site X');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(2));
    expect(apiMock.patch.mock.calls[1]![1]).toEqual({ locationId: LOC.siteX });
  });

  it('lists the location and filters the list and its counts by a location (paging restarts)', async () => {
    const rows: DeviceDto[] = [device(), device({ id: 'd0000000-0000-4000-8000-000000000002', code: 'GATE-2', name: 'Side gate', locationId: null, locationName: null })];
    mockGet({
      '/orgs/org-1/devices': page(rows, 60),
      '/orgs/org-1/devices/summary': { data: { total: 2, byConnectionStatus: { online: 2 }, byStatus: { active: 2 }, staleHeartbeats: 0 } },
      '/orgs/org-1/devices/pending': { data: [] }, '/orgs/org-1/branches': page(BRANCHES), '/orgs/org-1/device-groups': { data: [] }, '/device-providers': { data: [] },
      ...locationRoutes(),
    });
    renderWithProviders(<DevicesListPage />, { route: '/devices?page=3', path: '/devices' });
    // the column shows the place below the branch (from the tree, in the UI language); a device without one shows —
    expect((await screen.findAllByText('Site A › Floor 2')).length).toBeGreaterThan(0);
    expect(screen.getByRole('columnheader', { name: 'Location' })).toBeInTheDocument();

    await pick(screen.getByRole('combobox', { name: 'Filter by location' }), 'Muscat HQ');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`locationId=${LOC.hq}`));
    expect(screen.getByTestId('location')).toHaveTextContent('page=1');
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/devices', expect.objectContaining({ locationId: LOC.hq, page: 1 })));
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/devices/summary', expect.objectContaining({ locationId: LOC.hq })));
  });

  it('keeps the device list unchanged for an organisation without a hierarchy', async () => {
    mockGet({
      '/orgs/org-1/devices': page([device({ locationId: null, locationName: null })]),
      '/orgs/org-1/devices/summary': { data: { total: 1, byConnectionStatus: { online: 1 }, byStatus: { active: 1 }, staleHeartbeats: 0 } },
      '/orgs/org-1/devices/pending': { data: [] }, '/orgs/org-1/branches': page(BRANCHES), '/orgs/org-1/device-groups': { data: [] }, '/device-providers': { data: [] },
      ...locationRoutes(SIMPLE_LEVELS, SIMPLE_NODES),
    });
    renderWithProviders(<DevicesListPage />, { route: '/devices', path: '/devices' });
    expect((await screen.findAllByText('Main gate')).length).toBeGreaterThan(0);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/location-levels'));
    expect(screen.queryByRole('columnheader', { name: 'Location' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Filter by location' })).not.toBeInTheDocument();
  });

  it('names the place in the detail header and the overview', async () => {
    mockGet({ [`/orgs/org-1/devices/${device().id}`]: { data: device() }, ...locationRoutes() });
    renderWithProviders(<DeviceDetailPage />, { route: `/devices/${device().id}`, path: '/devices/:id' });
    expect(await screen.findByText('GATE-1 · Branch 1 › Site A › Floor 2 · ZKTeco push SDK')).toBeInTheDocument();
    // the overview's identity card: Branch, then Location
    expect(screen.getByText('Site A › Floor 2')).toBeInTheDocument();
  });
});
