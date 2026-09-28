import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { DEFAULT_NOTIFICATION_SETTINGS } from '@flowza/contracts';
import { apiMock, grant, grantAll, mockGet, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import NotificationsSection from './notifications-section';

const prefs = { organizationId: 'org-1', locale: 'en', categories: [{ category: 'LEAVE', relevant: true, channels: [{ channel: 'IN_APP', enabled: true, configurable: true, alwaysOn: [] }, { channel: 'EMAIL', enabled: true, configurable: true, alwaysOn: [] }] }] };

describe('Settings → Notifications', () => {
  beforeEach(() => {
    resetApiMock();
    grantAll();
    mockGet({ '/orgs/org-1/settings/notifications': { data: DEFAULT_NOTIFICATION_SETTINGS }, '/me/notification-preferences': { data: prefs } });
  });

  it('shows the member\'s own preferences and every organisation switch, and saves the new ones', async () => {
    apiMock.put.mockImplementation((path: string, body: unknown) => Promise.resolve({ data: path.startsWith('/orgs/') ? body : prefs }));
    renderWithProviders(<NotificationsSection />);
    expect(await screen.findByRole('switch', { name: 'Leave: E-mail' })).toBeInTheDocument(); // the personal card
    for (const label of ['Approval requests', 'Daily approvals digest', 'Leave updates', 'Attendance requests', 'Flagged punches', 'Missing check-out reminder', 'Device offline', 'Sync failed', 'Report ready', 'Shared and scheduled reports']) {
      expect(screen.getByRole('switch', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('switch', { name: 'Daily approvals digest' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Missing check-out reminder' })).toBeChecked();
    const hours = screen.getByLabelText('Remind after (hours)');
    expect(hours).toHaveValue(2);

    fireEvent.click(screen.getByRole('switch', { name: 'Leave updates' }));
    fireEvent.change(hours, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledWith('/orgs/org-1/settings/notifications', expect.objectContaining({ leaveUpdates: false, missingPunchReminderHours: 3, punchFlagged: true, reportScheduledDelivery: true })));
  });

  it('refuses an out-of-range reminder delay before saving', async () => {
    renderWithProviders(<NotificationsSection />);
    const hours = await screen.findByLabelText('Remind after (hours)');
    fireEvent.change(hours, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(hours).toHaveAttribute('aria-invalid', 'true'));
    expect(apiMock.put).not.toHaveBeenCalledWith('/orgs/org-1/settings/notifications', expect.anything());
  });

  it('is read-only without notification.manage — organization.manage alone no longer writes this group', async () => {
    grant('organization.view', 'organization.manage');
    renderWithProviders(<NotificationsSection />);
    expect(await screen.findByRole('switch', { name: 'Leave updates' })).toBeDisabled();
    expect(screen.getByLabelText('Remind after (hours)')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByText(/Only members allowed to manage notifications/)).toBeInTheDocument();
    // the member's own preferences stay editable
    expect(screen.getByRole('switch', { name: 'Leave: E-mail' })).toBeEnabled();
  });

  it('with notification.manage alone the organisation switches are writable', async () => {
    grant('organization.view', 'notification.manage');
    renderWithProviders(<NotificationsSection />);
    expect(await screen.findByRole('switch', { name: 'Leave updates' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});
