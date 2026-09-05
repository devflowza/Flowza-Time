import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { DeviceDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/sync.json';
import ar from '@/locales/ar/sync.json';
import enDevices from '@/locales/en/devices.json';
import arDevices from '@/locales/ar/devices.json';
import { SyncAttendanceDialog, SyncEmployeesDialog } from './sync-dialogs';

registerNamespace('sync', en, ar);
registerNamespace('devices', enDevices, arDevices);

const device = (id: string, name: string): DeviceDto => ({
  id, organizationId: 'org-1', branchId: 'b1', branchName: 'Muscat', code: id.toUpperCase(), name, providerKey: 'mock', modelId: null, manufacturer: 'Mock', modelName: null, serialNumber: null, timezone: 'Asia/Muscat',
  integrationType: 'ON_PREM_SERVER_API', endpointUrl: null, config: {}, capabilities: { attendancePull: true, attendancePush: false, employeePush: true, employeePull: false, employeeDelete: false, fingerprint: false, face: false, card: false, pin: false, deviceStatus: false, remoteRestart: false, webhooks: false, devicePush: false, biometricTemplatePush: false },
  status: 'active', connectionStatus: 'online', lastHeartbeatAt: null, lastAttendanceSyncAt: null, lastEmployeeSyncAt: null, lastSuccessfulCommunicationAt: null, lastErrorCode: null, lastError: null, firmwareVersion: null,
  offlineThresholdMinutes: 15, autoSyncEnabled: true, syncIntervalMinutes: 15, employeeCount: 0, tags: [], createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
});

describe('Sync dialogs', () => {
  beforeEach(() => {
    resetApiMock(); grantAll();
    mockGet({ '/orgs/org-1/devices': page([device('d1', 'Gate A'), device('d2', 'Gate B')]), '/orgs/org-1/branches': page([]), '/orgs/org-1/employees': page([]) });
    apiMock.post.mockResolvedValue({ data: { jobId: 'job-1', status: 'QUEUED', message: 'ok', itemsTotal: 2, deviceCount: 2 } });
  });

  it('queues an attendance pull for the preselected devices with the full re-sync flag', async () => {
    const onOpenChange = vi.fn();
    renderWithProviders(<SyncAttendanceDialog open onOpenChange={onOpenChange} defaultDeviceIds={['d1']} />);
    expect(await screen.findByRole('radio', { name: /Specific devices/ })).toBeChecked();
    expect(await screen.findByText('Gate A')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Full re-sync' }));
    fireEvent.click(screen.getByRole('button', { name: 'Queue sync' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/sync/attendance', { deviceIds: ['d1'], all: false, fullResync: true }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('switches the target to all devices and sends all=true', async () => {
    renderWithProviders(<SyncAttendanceDialog open onOpenChange={vi.fn()} defaultDeviceIds={['d1']} />);
    fireEvent.click(await screen.findByRole('radio', { name: /All devices/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Queue sync' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/sync/attendance', { all: true, fullResync: false }, expect.anything()));
  });

  it('keeps the employee push disabled until a target is chosen', async () => {
    renderWithProviders(<SyncEmployeesDialog open onOpenChange={vi.fn()} />);
    expect(await screen.findByRole('radio', { name: /Whole branch/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Queue sync' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /All devices/ }));
    fireEvent.click(screen.getByRole('switch', { name: 'Remove stale users' }));
    const queue = screen.getByRole('button', { name: 'Queue sync' });
    expect(queue).toBeEnabled();
    fireEvent.click(queue);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/sync/employees', { all: true, removeStale: true }, expect.anything()));
  });
});
