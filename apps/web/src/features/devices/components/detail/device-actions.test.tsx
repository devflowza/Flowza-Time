import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { DeviceCapabilities } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { grant, grantAll, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/devices.json';
import ar from '@/locales/ar/devices.json';
import type { DeviceDetail } from '../../api';
import { DeviceActions } from './device-actions';

registerNamespace('devices', en, ar);

const caps = (over: Partial<DeviceCapabilities> = {}): DeviceCapabilities => ({
  attendancePull: false, attendancePush: false, employeePush: false, employeePull: false, employeeDelete: false, fingerprint: false, face: false, card: false, pin: false, deviceStatus: false, remoteRestart: false, webhooks: false, devicePush: false, biometricTemplatePush: false, ...over,
});
const device = (over: Partial<DeviceDetail> = {}): DeviceDetail => ({
  id: 'd1', organizationId: 'org-1', branchId: 'b1', branchName: 'Muscat', code: 'GATE-A', name: 'Gate A', providerKey: 'mock', providerName: 'Mock', modelId: null, manufacturer: 'Mock', modelName: null, serialNumber: 'SN1', timezone: 'Asia/Muscat',
  integrationType: 'ON_PREM_SERVER_API', endpointUrl: 'https://device.local', config: {}, capabilities: caps(), status: 'active', connectionStatus: 'online', lastHeartbeatAt: null, lastAttendanceSyncAt: null, lastEmployeeSyncAt: null, lastSuccessfulCommunicationAt: null,
  lastErrorCode: null, lastError: null, firmwareVersion: null, offlineThresholdMinutes: 15, autoSyncEnabled: true, syncIntervalMinutes: 15, employeeCount: 0, tags: [], createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
  hasPushToken: false, generation: 1, notes: null, consecutiveFailures: 0, pushProtocolKey: null, groupIds: [], ...over,
});

describe('DeviceActions', () => {
  beforeEach(() => { resetApiMock(); grantAll(); });

  it('renders only the actions the device capabilities support', async () => {
    const onAction = vi.fn();
    renderWithProviders(<DeviceActions device={device({ capabilities: caps({ employeePush: true, remoteRestart: true }) })} onAction={onAction} />);
    expect(screen.queryByRole('button', { name: /Sync attendance/ })).not.toBeInTheDocument(); // no attendancePull
    expect(screen.getByRole('button', { name: /Sync employees/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Health check/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Test connection/ })).toBeInTheDocument(); // pull-style integration can be tested
    expect(screen.getByRole('button', { name: /Restart/ })).toBeDisabled(); // declared by the provider, not exposed by the API
    fireEvent.click(screen.getByRole('button', { name: /Sync employees/ }));
    expect(onAction).toHaveBeenCalledWith('sync-employees');

    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'ArrowDown' });
    expect(await screen.findByRole('menuitem', { name: /Edit/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Disable/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Decommission/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Rotate push token/ })).not.toBeInTheDocument(); // not a push / webhook device
  });

  it('offers token rotation for push devices, hides Test connection, and hides everything for view-only users', async () => {
    const push = device({ integrationType: 'DEVICE_PUSH', hasPushToken: true, capabilities: caps({ attendancePush: true, employeePush: true }) });
    const first = renderWithProviders(<DeviceActions device={push} onAction={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Test connection/ })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'ArrowDown' });
    expect(await screen.findByRole('menuitem', { name: /Rotate push token/ })).toBeInTheDocument();
    first.unmount();

    grant('device.view');
    renderWithProviders(<DeviceActions device={device({ capabilities: caps({ attendancePull: true, employeePush: true }) })} onAction={vi.fn()} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('disables sync actions while the device is not active', () => {
    renderWithProviders(<DeviceActions device={device({ status: 'disabled', capabilities: caps({ attendancePull: true }) })} onAction={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Sync attendance/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Health check/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More actions' })).toBeInTheDocument();
  });
});
