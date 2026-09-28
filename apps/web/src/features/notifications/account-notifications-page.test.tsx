import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import type { NotificationPreferencesDto } from '@flowza/contracts';
import { apiMock, grant, mockGet, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import AccountNotificationsPage from './account-notifications-page';

const cell = (channel: 'IN_APP' | 'EMAIL') => ({ channel, enabled: true, configurable: true, alwaysOn: [] as string[] });
const matrix: NotificationPreferencesDto = {
  organizationId: 'org-1', locale: 'en',
  categories: [
    { category: 'DEVICE', relevant: true, channels: [cell('IN_APP'), cell('EMAIL')] },
    { category: 'APPROVAL', relevant: true, channels: [cell('IN_APP'), cell('EMAIL')] },
  ],
};

describe('/account/notifications (notifications review 8-P1-4)', () => {
  beforeEach(() => { resetApiMock(); testState.orgId = 'org-1'; testState.employeeId = null; mockGet({ '/me/notification-preferences': { data: matrix } }); });

  it('8-P1-4 a member with neither organization.view nor an employee link reaches their own preferences', async () => {
    grant('device.view', 'device.sync'); // a device technician: no Settings, no /my
    renderWithProviders(<AccountNotificationsPage />, { route: '/account/notifications' });
    expect(await screen.findByRole('heading', { name: 'Notification settings' })).toBeInTheDocument();
    expect(await screen.findByTestId('notification-preferences')).toBeInTheDocument();
    expect(await screen.findByRole('switch', { name: 'Devices and sync: E-mail' })).toBeChecked();
    expect(apiMock.get).toHaveBeenCalledWith('/me/notification-preferences', { organizationId: 'org-1' });
  });

  it('without an organisation the page says so (a platform admin before selecting one)', async () => {
    testState.orgId = null;
    try {
      renderWithProviders(<AccountNotificationsPage />, { route: '/account/notifications' });
      expect(await screen.findByText(/belong to an organisation/)).toBeInTheDocument();
      expect(apiMock.get).not.toHaveBeenCalled();
    } finally {
      testState.orgId = 'org-1';
    }
  });
});
