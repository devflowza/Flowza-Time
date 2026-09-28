import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import type { NotificationPreferencesDto } from '@flowza/contracts';
import { ApiError, apiMock, grantAll, mockGet, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { NotificationPreferencesCard } from './notification-preferences-card';

const cell = (channel: 'IN_APP' | 'EMAIL', enabled = true, configurable = true, alwaysOn: string[] = []) => ({ channel, enabled, configurable, alwaysOn });
const matrix = (overrides: Partial<Record<string, ReturnType<typeof cell>[]>> = {}): NotificationPreferencesDto => ({
  organizationId: 'org-1',
  locale: 'en',
  categories: [
    { category: 'APPROVAL', relevant: true, channels: overrides['APPROVAL'] ?? [cell('IN_APP', true, true, ['approval.pending']), cell('EMAIL')] },
    { category: 'ATTENDANCE', relevant: true, channels: [cell('IN_APP'), cell('EMAIL')] },
    { category: 'LEAVE', relevant: true, channels: overrides['LEAVE'] ?? [cell('IN_APP'), cell('EMAIL')] },
    { category: 'REPORTS', relevant: false, channels: [cell('IN_APP'), cell('EMAIL')] },
    { category: 'DEVICE', relevant: false, channels: [cell('IN_APP'), cell('EMAIL')] },
    { category: 'SYSTEM', relevant: true, channels: [cell('IN_APP', true, false, ['employee.imported']), cell('EMAIL', true, false, ['employee.imported'])] },
    { category: 'SUBSCRIPTION', relevant: false, channels: [cell('IN_APP', true, false), cell('EMAIL', true, false)] },
  ],
});

describe('NotificationPreferencesCard', () => {
  beforeEach(() => { resetApiMock(); grantAll(); mockGet({ '/me/notification-preferences': { data: matrix() } }); });

  it('lists the categories that concern the member, with locked cells and the note on what cannot be switched off', async () => {
    renderWithProviders(<NotificationPreferencesCard />);
    expect(await screen.findByRole('switch', { name: 'Leave: E-mail' })).toBeChecked();
    expect(apiMock.get).toHaveBeenCalledWith('/me/notification-preferences', { organizationId: 'org-1' });
    expect(screen.getByText('Approvals')).toBeInTheDocument();
    expect(screen.queryByText('Reports')).not.toBeInTheDocument(); // not relevant to this member
    expect(screen.queryByText('Devices and sync')).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'System: E-mail' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'System: In-app' })).toBeChecked();
    expect(screen.getByText(/cannot be switched off/)).toBeInTheDocument();
    expect(screen.getByText(/always appear in your inbox/)).toBeInTheDocument();
  });

  it('saves a switch at once (own preferences of the active organisation)', async () => {
    apiMock.put.mockResolvedValue({ data: matrix({ LEAVE: [cell('IN_APP'), cell('EMAIL', false)] }) });
    renderWithProviders(<NotificationPreferencesCard />);
    const email = await screen.findByRole('switch', { name: 'Leave: E-mail' });
    fireEvent.click(email);
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledTimes(1));
    expect(apiMock.put).toHaveBeenCalledWith('/me/notification-preferences?organizationId=org-1', { preferences: [{ category: 'LEAVE', channel: 'EMAIL', enabled: false }] });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Leave: E-mail' })).not.toBeChecked());
    expect(screen.getByRole('switch', { name: 'Leave: In-app' })).toBeChecked();
  });

  it('rolls the switch back when the API refuses', async () => {
    apiMock.put.mockRejectedValue(new ApiError(400, 'VALIDATION_ERROR', 'These notifications cannot be switched off.'));
    renderWithProviders(<NotificationPreferencesCard />);
    const inApp = await screen.findByRole('switch', { name: 'Attendance: In-app' });
    fireEvent.click(inApp);
    await waitFor(() => expect(apiMock.put).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Attendance: In-app' })).toBeChecked());
  });

  it('changes the language notifications are written in through the profile', async () => {
    apiMock.patch.mockResolvedValue({ data: {} });
    renderWithProviders(<NotificationPreferencesCard />);
    const card = await screen.findByTestId('notification-preferences');
    const trigger = await within(card).findByRole('combobox', { name: 'Language of notifications and e-mails' });
    expect(trigger).toHaveTextContent('English');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'العربية' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/me', { locale: 'ar' }));
  });
});
