import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { APPRECIATION_DEFAULT_MESSAGE_AR, APPRECIATION_DEFAULT_MESSAGE_EN, DEFAULT_NOTIFICATION_SETTINGS } from '@flowza/contracts';
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

  describe('attendance alerts', () => {
    const region = (name: string) => within(screen.getByRole('region', { name }));

    it('shows every alert with its defaults, previews the thank-you message and saves the whole group', async () => {
      apiMock.put.mockImplementation((path: string, body: unknown) => Promise.resolve({ data: path.startsWith('/orgs/') ? body : prefs }));
      renderWithProviders(<NotificationsSection />);
      await screen.findByRole('switch', { name: 'Late arrival alerts' });
      const late = region('Late arrivals');
      expect(late.getByRole('switch', { name: 'Late arrival alerts' })).toBeChecked();
      expect(late.getByRole('switch', { name: 'Tell the employee' })).toBeChecked();
      expect(late.getByRole('switch', { name: 'Tell their direct manager' })).toBeChecked();
      expect(late.getByLabelText('From (minutes late)')).toHaveValue(1);
      expect(region('Early departures').getByRole('switch', { name: 'Early departure alerts' })).toBeChecked();
      expect(region('Absences').getByRole('switch', { name: 'Reminder before the deadline' })).toBeChecked();
      const checkIn = region('Missing check-in');
      expect(checkIn.getByRole('switch', { name: 'Missing check-in reminder' })).not.toBeChecked();
      expect(checkIn.getByLabelText('Remind after (minutes)')).toHaveValue(30);
      const thanks = region('Weekly appreciation');
      expect(thanks.getByRole('switch', { name: 'Weekly thank-you messages' })).not.toBeChecked();
      expect(thanks.getByRole('combobox', { name: 'Day' })).toHaveTextContent('Thursday');
      expect(thanks.getByRole('combobox', { name: 'Time' })).toHaveTextContent('14:00');
      const preview = screen.getByTestId('appreciation-preview');
      expect(preview).toHaveTextContent(APPRECIATION_DEFAULT_MESSAGE_EN);
      expect(preview).toHaveTextContent(APPRECIATION_DEFAULT_MESSAGE_AR);

      fireEvent.click(late.getByRole('switch', { name: 'Tell their direct manager' }));
      fireEvent.change(late.getByLabelText('From (minutes late)'), { target: { value: '10' } });
      fireEvent.click(checkIn.getByRole('switch', { name: 'Missing check-in reminder' }));
      fireEvent.click(thanks.getByRole('switch', { name: 'Weekly thank-you messages' }));
      fireEvent.keyDown(thanks.getByRole('combobox', { name: 'Day' }), { key: 'ArrowDown' });
      fireEvent.click(await screen.findByRole('option', { name: 'Sunday' }));
      fireEvent.click(thanks.getByRole('checkbox', { name: 'A late arrival' }));
      fireEvent.change(thanks.getByLabelText('Message in English'), { target: { value: 'Great work this week, team!' } });
      expect(screen.getByTestId('appreciation-preview')).toHaveTextContent('Great work this week, team!');
      // unsaved changes: "Send now" waits for the save
      expect(thanks.getByRole('button', { name: 'Send now for last week' })).toBeDisabled();
      expect(thanks.getByText('Save your changes first.')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(apiMock.put).toHaveBeenCalledWith('/orgs/org-1/settings/notifications', expect.anything()));
      const saved = apiMock.put.mock.calls.find((c) => c[0] === '/orgs/org-1/settings/notifications')![1] as typeof DEFAULT_NOTIFICATION_SETTINGS;
      expect(saved).toEqual({
        ...DEFAULT_NOTIFICATION_SETTINGS,
        lateArrivalAlert: { ...DEFAULT_NOTIFICATION_SETTINGS.lateArrivalAlert, notifyManager: false, minMinutes: 10 },
        missingCheckInReminder: true,
        appreciation: { ...DEFAULT_NOTIFICATION_SETTINGS.appreciation, enabled: true, weekday: 0, messageEn: 'Great work this week, team!', criteria: { ...DEFAULT_NOTIFICATION_SETTINGS.appreciation.criteria, noLate: false } },
      });
    });

    it('refuses out-of-range minutes and an empty message before saving', async () => {
      renderWithProviders(<NotificationsSection />);
      const minutes = await screen.findByLabelText('Remind after (minutes)');
      fireEvent.change(minutes, { target: { value: '5' } });
      fireEvent.change(screen.getByLabelText('Message in Arabic'), { target: { value: '   ' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(minutes).toHaveAttribute('aria-invalid', 'true'));
      expect(screen.getByLabelText('Message in Arabic')).toHaveAttribute('aria-invalid', 'true');
      expect(apiMock.put).not.toHaveBeenCalledWith('/orgs/org-1/settings/notifications', expect.anything());
    });

    it('"Send now for last week" queues the run once the appreciation is switched on and saved', async () => {
      mockGet({ '/orgs/org-1/settings/notifications': { data: { ...DEFAULT_NOTIFICATION_SETTINGS, appreciation: { ...DEFAULT_NOTIFICATION_SETTINGS.appreciation, enabled: true } } }, '/me/notification-preferences': { data: prefs } });
      apiMock.post.mockResolvedValue({ data: { jobId: '42', status: 'QUEUED' } });
      renderWithProviders(<NotificationsSection />);
      const send = await screen.findByRole('button', { name: 'Send now for last week' });
      expect(send).toBeEnabled();
      fireEvent.click(send);
      await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/notifications/appreciation/send'));
    });

    it('"Send now" is unavailable while the appreciation is off, and absent without notification.manage', async () => {
      renderWithProviders(<NotificationsSection />);
      expect(await screen.findByRole('button', { name: 'Send now for last week' })).toBeDisabled();
      expect(screen.getByText('Switch weekly thank-you messages on and save first.')).toBeInTheDocument();
    });

    it('read-only without notification.manage: every alert control is disabled and nothing can be sent', async () => {
      grant('organization.view', 'organization.manage');
      renderWithProviders(<NotificationsSection />);
      expect(await screen.findByRole('switch', { name: 'Late arrival alerts' })).toBeDisabled();
      expect(screen.getByLabelText('From (minutes early)')).toBeDisabled();
      expect(screen.getByRole('checkbox', { name: 'An absence' })).toBeDisabled();
      expect(screen.getByLabelText('Message in English')).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Send now for last week' })).not.toBeInTheDocument();
    });
  });
});
