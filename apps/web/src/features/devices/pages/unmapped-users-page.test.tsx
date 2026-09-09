import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { UnmappedDeviceUserDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/devices.json';
import ar from '@/locales/ar/devices.json';
import UnmappedUsersPage from './unmapped-users-page';

registerNamespace('devices', en, ar);

const row: UnmappedDeviceUserDto = {
  deviceId: 'dev-1', deviceName: 'Sohar Gate', deviceCode: 'SOH-01', branchId: 'br-1', providerKey: 'zkteco',
  deviceUserId: '7788', deviceUserName: 'Ali on device', enrolledOnDevice: false,
  unmatchedPunches: 12, firstPunchAt: '2026-09-01T04:00:00Z', lastPunchAt: '2026-09-05T13:00:00Z',
};

const mockList = (rows: UnmappedDeviceUserDto[] = [row]) => mockGet({
  '/orgs/org-1/devices/unmapped-users': page(rows),
  '/orgs/org-1/devices': page([{ id: 'dev-1', name: 'Sohar Gate', code: 'SOH-01' }]),
  '/orgs/org-1/branches': page([{ id: 'br-1', name: 'Sohar', code: 'SOH' }]),
  '/orgs/org-1/employees': page([{ id: 'emp-1', displayName: 'Ali Al Hinai', employeeNumber: 'EMP-1' }]),
});

describe('UnmappedUsersPage', () => {
  beforeEach(() => { resetApiMock(); grantAll(); });

  it('shows the PIN, the device that reported it and how many punches are stranded behind it', async () => {
    mockList();
    renderWithProviders(<UnmappedUsersPage />);
    expect(await screen.findAllByText('7788')).not.toHaveLength(0);
    expect(screen.getAllByText('Ali on device').length).toBeGreaterThan(0);
    expect(screen.getAllByText('12 unmatched punches').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/SOH-01/).length).toBeGreaterThan(0);
  });

  /** Linking is the whole point of the screen: the PIN, the chosen employee and the replay flag must reach the API. */
  it('links a PIN to an employee and asks for the collected punches to be replayed', async () => {
    mockList();
    apiMock.post.mockResolvedValue({ data: { deviceId: 'dev-1', deviceUserId: '7788', employeeId: 'emp-1', scope: 'DEVICE', requeued: 12 } });
    renderWithProviders(<UnmappedUsersPage />);

    fireEvent.click((await screen.findAllByRole('button', { name: /Link to employee/ }))[0]!);
    expect(await screen.findByRole('heading', { name: /Link device user 7788/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('combobox', { name: /Employee/ }));
    fireEvent.click(await screen.findByText('Ali Al Hinai'));
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalled());
    const [path, body] = apiMock.post.mock.calls[0]!;
    expect(path).toBe('/orgs/org-1/devices/dev-1/user-links');
    expect(body).toMatchObject({ deviceUserId: '7788', employeeId: 'emp-1', scope: 'DEVICE', requeueUnmatched: true });
  });

  /** Replaying raw punches is the same privilege as a manual re-queue — without it the box is gone and the flag is off. */
  it('hides the replay option from members who cannot read raw transactions', async () => {
    grant('device.view', 'device.sync', 'employee.view');
    mockList();
    apiMock.post.mockResolvedValue({ data: { deviceId: 'dev-1', deviceUserId: '7788', employeeId: 'emp-1', scope: 'DEVICE', requeued: 0 } });
    renderWithProviders(<UnmappedUsersPage />);

    fireEvent.click((await screen.findAllByRole('button', { name: /Link to employee/ }))[0]!);
    expect(screen.queryByLabelText(/Replay the punches/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('combobox', { name: /Employee/ }));
    fireEvent.click(await screen.findByText('Ali Al Hinai'));
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalled());
    expect(apiMock.post.mock.calls[0]![1]).toMatchObject({ requeueUnmatched: false });
  });

  it('tells the operator when nothing is waiting', async () => {
    mockList([]);
    renderWithProviders(<UnmappedUsersPage />);
    expect(await screen.findByText('Every device user is mapped')).toBeInTheDocument();
  });
});
