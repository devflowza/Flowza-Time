import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { PinMappingDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { ApiError, apiMock, grant, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/devices.json';
import ar from '@/locales/ar/devices.json';
import enAttendance from '@/locales/en/attendance.json';
import arAttendance from '@/locales/ar/attendance.json';
import DevicesListPage from '../pages/devices-list-page';
import type { RawTransactionDto } from '@/features/attendance/types';

registerNamespace('devices', en, ar);
registerNamespace('attendance', enAttendance, arAttendance);

const E1 = '11111111-1111-4111-8111-111111111111';
const DEV = '22222222-2222-4222-8222-222222222222';
const devices = page([{ id: DEV, name: 'Main gate', code: 'GATE-1', serialNumber: 'GN6733356', providerKey: 'hikvision_push', status: 'active', branchId: 'b1', branchName: 'Muscat', connectionStatus: 'online', tags: [] }]);
const employees = page([{ id: E1, displayName: 'James Bond', employeeNumber: 'EMP0099' }]);
const mapping = (over: Partial<PinMappingDto> = {}): PinMappingDto => ({
  id: `device:s1`, scope: 'device', stateId: 's1', deviceUserId: '2', deviceId: DEV, deviceName: 'Main gate', deviceCode: 'GATE-1', deviceSerial: 'GN6733356', providerKey: 'hikvision_push',
  employeeId: E1, employeeName: 'James Bond', employeeNumber: 'EMP0099', employmentStatus: 'active', branchId: 'b1', syncStatus: 'IN_SYNC', desired: true, manual: true, mappedAt: '2026-09-29T10:00:00Z', updatedAt: '2026-09-29T10:00:00Z', ...over,
});
const punch = (over: Partial<RawTransactionDto> = {}): RawTransactionDto => ({
  id: '901', deviceId: DEV, deviceName: 'Main gate', deviceCode: 'GATE-1', deviceSerial: 'GN6733356', deviceTimezone: 'Asia/Muscat', providerKey: 'hikvision_push', providerTransactionId: null, deviceEmployeeId: '2',
  employeeId: null, employeeName: null, employeeNumber: null, punchedAt: '2026-09-29T14:54:02.000Z', deviceLocalTime: '2026-09-29 18:54:02', assumedTimezone: 'Asia/Muscat', clockSkewSeconds: null, verificationMethod: 'password',
  direction: 'out', source: 'DEVICE_PUSH', processingStatus: 'unmatched', processingError: 'no employee for device user id', processedAt: null, receivedAt: '2026-09-29T14:54:03.294Z', syncJobId: null, deviceGeneration: 1,
  dedupeHash: 'c09bdf9aa2bd95f9a17f5b852858ba0a', rawPayload: { table: 'ATTLOG', line: '4\t2026-09-29 18:54:02\t0\t1' }, ...over,
});

const open = async (label: RegExp | string, root: HTMLElement = document.body) => { fireEvent.click(within(root).getByRole('combobox', { name: label })); };

describe('Devices & punches — PIN mapping', () => {
  beforeEach(() => {
    resetApiMock(); testState.orgId = 'org-1'; testState.timezone = 'Asia/Muscat';
    mockGet({
      '/orgs/org-1/pin-mappings': page([mapping(), mapping({ id: `default:${E1}`, scope: 'default', stateId: null, deviceUserId: '1099', deviceId: null, deviceName: null, deviceCode: null, deviceSerial: null, providerKey: null, syncStatus: null, desired: null, manual: false, mappedAt: null })]),
      '/orgs/org-1/devices': devices, '/orgs/org-1/employees': employees, '/orgs/org-1/branches': page([]), '/orgs/org-1/attendance/unmatched': page([], 3),
    });
  });

  it('shows the hub tabs and every mapping: device PINs and default IDs', async () => {
    grantAll();
    renderWithProviders(<DevicesListPage tab="pins" />, { route: '/devices/pin-mapping' });
    expect(screen.getByRole('heading', { name: 'Devices & punches' })).toBeInTheDocument();
    for (const tab of ['Devices', 'PIN mapping', 'Unmapped punches', 'Punch log']) expect(screen.getByRole('tab', { name: new RegExp(tab) })).toBeInTheDocument();
    expect(await screen.findByLabelText('3 device users with unmapped punches')).toBeInTheDocument();
    const table = (await screen.findAllByRole('table'))[0]!;
    const rows = await within(table).findAllByRole('row');
    const device = rows.find((r) => r.textContent?.includes('GN6733356'))!;
    expect(device).toHaveTextContent('James Bond');
    expect(device).toHaveTextContent('Mapped manually');
    expect(within(device).getByRole('button', { name: 'Remove mapping' })).toBeInTheDocument();
    const fallback = rows.find((r) => r.textContent?.includes('1099'))!;
    expect(fallback).toHaveTextContent('All devices');
    expect(within(fallback).queryByRole('button', { name: 'Remove mapping' })).toBeNull();
  });

  it('maps a PIN on a device, and replaces a taken PIN after confirmation', async () => {
    grantAll();
    apiMock.post.mockRejectedValueOnce(new ApiError(409, 'CONFLICT', 'taken', 'r1', { reason: 'PIN_TAKEN', employeeId: 'someone', deviceUserId: '2' }))
      .mockResolvedValueOnce({ data: { scope: 'device', employeeId: E1, deviceId: DEV, deviceUserId: '2', changed: true, previousDeviceUserId: null, rowsRequeued: 5, jobId: '7' } });
    renderWithProviders(<DevicesListPage tab="pins" />, { route: '/devices/pin-mapping' });
    fireEvent.click(await screen.findByRole('button', { name: /Map PIN/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('combobox', { name: /Employee/ }));
    fireEvent.click(await screen.findByRole('option', { name: /James Bond/ }));
    fireEvent.click(within(dialog).getByRole('combobox', { name: /Device/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Main gate/ }));
    fireEvent.change(within(dialog).getByLabelText(/PIN on the device/), { target: { value: ' 2 ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Save mapping/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/pin-mappings', { employeeId: E1, deviceUserId: '2', deviceId: DEV }, expect.anything()));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('PIN 2 is already mapped to another employee on this device.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenLastCalledWith('/orgs/org-1/pin-mappings', { employeeId: E1, deviceUserId: '2', deviceId: DEV, replace: true }, expect.anything()));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('sets a default device ID for all devices and validates its format', async () => {
    grantAll();
    apiMock.post.mockResolvedValue({ data: { scope: 'default', employeeId: E1, deviceId: null, deviceUserId: '2', changed: true, previousDeviceUserId: '1099', rowsRequeued: 0, jobId: null } });
    renderWithProviders(<DevicesListPage tab="pins" />, { route: '/devices/pin-mapping' });
    fireEvent.click(await screen.findByRole('button', { name: /Map PIN/ }));
    const dialog = await screen.findByRole('dialog');
    await open(/Employee/, dialog);
    fireEvent.click(await screen.findByRole('option', { name: /James Bond/ }));
    await open(/Device/, dialog);
    fireEvent.click(await screen.findByRole('option', { name: /All devices \(default ID\)/ }));
    fireEvent.change(within(dialog).getByLabelText(/PIN on the device/), { target: { value: '2 3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Save mapping/ }));
    expect(await within(dialog).findByText(/A default device ID is 1–32 letters/)).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(/PIN on the device/), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Save mapping/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/pin-mappings', { employeeId: E1, deviceUserId: '2', deviceId: null }, expect.anything()));
  });

  it('hides the tabs the member cannot open and the map action without device.sync / employee.update', async () => {
    grant('device.view', 'employee.view');
    renderWithProviders(<DevicesListPage tab="pins" />, { route: '/devices/pin-mapping' });
    expect(await screen.findAllByText('GN6733356')).not.toHaveLength(0);
    expect(screen.queryByRole('tab', { name: /Punch log/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Map PIN/ })).toBeNull();
  });
});

describe('Devices & punches — Punch log', () => {
  beforeEach(() => {
    resetApiMock(); testState.orgId = 'org-1'; testState.timezone = 'Asia/Muscat';
    mockGet({
      '/orgs/org-1/attendance/raw': { data: [punch(), punch({ id: '900', deviceEmployeeId: '4', employeeId: E1, employeeName: 'James Bond', employeeNumber: 'EMP0099', processingStatus: 'normalized', processingError: null })], meta: { nextCursor: null, limit: 50 } },
      '/orgs/org-1/devices': devices, '/orgs/org-1/employees': employees, '/orgs/org-1/branches': page([]), '/orgs/org-1/attendance/unmatched': page([]),
    });
  });

  it('lists punches of the last two weeks with the device-local time, and filters by mapping', async () => {
    grantAll();
    renderWithProviders(<DevicesListPage tab="punches" />, { route: '/devices/punch-log' });
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('29 Sep 2026, 18:54:02');
    expect(rows[1]).toHaveTextContent('Unmapped');
    expect(rows[2]).toHaveTextContent('James Bond (EMP0099)');
    const first = apiMock.get.mock.calls.find(([path]) => path === '/orgs/org-1/attendance/raw')![1] as Record<string, string>;
    expect(first['from']).toBeTruthy();
    expect(first['to']).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Mapping' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Unmapped' }));
    await waitFor(() => expect(apiMock.get).toHaveBeenLastCalledWith('/orgs/org-1/attendance/raw', expect.objectContaining({ mapping: 'unmapped' })));
  });

  it('opens the raw punch with every stored fact and copies it as JSON', async () => {
    grantAll();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithProviders(<DevicesListPage tab="punches" />, { route: '/devices/punch-log' });
    fireEvent.click(await screen.findByRole('button', { name: 'Open raw punch 901' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('2026-09-29T14:54:02.000Z');
    expect(dialog).toHaveTextContent('GN6733356');
    expect(dialog).toHaveTextContent('Asia/Muscat');
    expect(dialog).toHaveTextContent('Password');
    expect(dialog).toHaveTextContent('Check out');
    expect(dialog).toHaveTextContent('c09bdf9aa2bd95f9a17f5b852858ba0a');
    expect(dialog).toHaveTextContent('"table": "ATTLOG"');
    fireEvent.click(within(dialog).getByRole('button', { name: /Copy JSON/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(JSON.parse(writeText.mock.calls[0]![0] as string)).toMatchObject({ id: '901', deviceEmployeeId: '2', dedupeHash: 'c09bdf9aa2bd95f9a17f5b852858ba0a' });
  });

  it('maps the PIN of an unmapped punch from its row (device and PIN prefilled)', async () => {
    grantAll();
    apiMock.post.mockResolvedValue({ data: { scope: 'device', employeeId: E1, deviceId: DEV, deviceUserId: '2', changed: true, previousDeviceUserId: null, rowsRequeued: 12, jobId: '7' } });
    renderWithProviders(<DevicesListPage tab="punches" />, { route: '/devices/punch-log' });
    fireEvent.click(await screen.findByRole('button', { name: /Map PIN/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/PIN on the device/)).toHaveValue('2');
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: /Device/ })).toHaveTextContent('Main gate'));
    await open(/Employee/, dialog);
    fireEvent.click(await screen.findByRole('option', { name: /James Bond/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: /Save mapping/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/pin-mappings', { employeeId: E1, deviceUserId: '2', deviceId: DEV }, expect.anything()));
  });
});
