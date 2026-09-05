import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import type { DeviceDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/devices.json';
import ar from '@/locales/ar/devices.json';
import enSync from '@/locales/en/sync.json';
import arSync from '@/locales/ar/sync.json';
import DevicesListPage from './devices-list-page';

registerNamespace('devices', en, ar);
registerNamespace('sync', enSync, arSync);

const device = (id: string, name: string, connectionStatus: DeviceDto['connectionStatus']): DeviceDto => ({
  id, organizationId: 'org-1', branchId: 'b1', branchName: 'Muscat', code: id.toUpperCase(), name, providerKey: 'mock', providerName: 'Mock', modelId: null, manufacturer: 'Mock', modelName: null, serialNumber: null, timezone: 'Asia/Muscat',
  integrationType: 'ON_PREM_SERVER_API', endpointUrl: null, config: {}, capabilities: { attendancePull: true, attendancePush: false, employeePush: true, employeePull: false, employeeDelete: false, fingerprint: false, face: false, card: false, pin: false, deviceStatus: false, remoteRestart: false, webhooks: false, devicePush: false, biometricTemplatePush: false },
  status: 'active', connectionStatus, lastHeartbeatAt: null, lastAttendanceSyncAt: null, lastEmployeeSyncAt: null, lastSuccessfulCommunicationAt: null, lastErrorCode: null, lastError: null, firmwareVersion: null,
  offlineThresholdMinutes: 15, autoSyncEnabled: true, syncIntervalMinutes: 15, employeeCount: 12, tags: ['lobby'], createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
});

describe('DevicesListPage', () => {
  beforeEach(() => {
    resetApiMock(); grantAll();
    mockGet({
      // one page of the list — the header counts must NOT be derived from it
      '/orgs/org-1/devices': page([device('d1', 'Gate A', 'online')], 340),
      // server-side fleet summary (branch-scoped): 340 devices in total, far beyond a page
      '/orgs/org-1/devices/summary': { data: { total: 340, byConnectionStatus: { online: 300, offline: 20, error: 5, degraded: 3, vendor_degraded: 2, unknown: 10 }, byStatus: { active: 340 }, staleHeartbeats: 4 } },
      '/orgs/org-1/devices/pending': { data: [] },
      '/orgs/org-1/branches': page([]),
      '/orgs/org-1/device-groups': { data: [] },
      '/device-providers': { data: [] },
    });
  });

  it('shows fleet counts from GET /devices/summary and the paginated list from GET /devices', async () => {
    renderWithProviders(<DevicesListPage />, { route: '/devices', path: '/devices' });
    expect((await screen.findAllByText('Gate A')).length).toBeGreaterThan(0);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/devices/summary', expect.objectContaining({})));
    // stat cards: online / offline (offline + error) / degraded (degraded + vendor_degraded) / unknown
    const card = (label: string) => screen.getAllByText(label).map((el) => el.closest('[role="button"]')).find((el): el is HTMLElement => el instanceof HTMLElement)!;
    await waitFor(() => expect(card('Online')).toHaveTextContent('300'));
    expect(card('Offline')).toHaveTextContent('25');
    expect(card('Degraded')).toHaveTextContent('5');
    expect(card('Unknown')).toHaveTextContent('10');
    expect(card('Unknown')).toHaveTextContent('4 active devices without a heartbeat');
    expect(screen.getByText('340 devices')).toBeInTheDocument();
  });
});
