import { expect, test } from '@playwright/test';
import type { SelfProfileDto } from '@flowza/contracts';
import { ORG_ID, PORTAL_EMPLOYEE_ID, installMockBackend, meFixture, signInDirectly } from './support/mock-backend';

/**
 * Notification preferences (HR portal Prompt 8): an employee switches off the e-mails of one category on their profile; the
 * switch saves at once (PUT /me/notification-preferences for the active organisation) and stays off after a reload. A member
 * with neither Settings (organization.view) nor an employee link manages theirs at /account/notifications — where their
 * e-mails' footer points (notifications review 8-P1-4).
 */
const profile: SelfProfileDto = {
  employeeId: PORTAL_EMPLOYEE_ID, employeeNumber: 'E-002', displayName: 'Sara Al-Balushi', displayNameAr: null, firstName: 'Sara', lastName: 'Al-Balushi',
  email: 'sara@albahja.example', phone: null, gender: null, dateOfBirth: null, nationality: 'OM', joiningDate: '2024-02-01', employmentStatus: 'active', employmentType: 'full_time',
  photoUrl: null, branch: { id: '22222222-2222-4222-8222-222222222222', name: 'Muscat HQ', timezone: 'Asia/Muscat' }, department: null, designation: null, manager: null, secondaryManager: null,
  teams: [], weeklyOffDays: [5, 6], roleName: 'Employee',
};

test.describe('notification preferences', () => {
  test.beforeEach(async ({ page }) => { await signInDirectly(page); });

  test('an employee switches off leave e-mails on their profile → saved', async ({ page }) => {
    const backend = await installMockBackend(page, { me: meFixture({ employeeId: PORTAL_EMPLOYEE_ID }), get: { [`/orgs/${ORG_ID}/me/profile`]: { data: profile } } });
    await page.goto('/my/profile');
    const card = page.getByTestId('notification-preferences');
    await expect(card.getByRole('heading', { name: 'Notifications' })).toBeVisible();
    const leaveEmail = card.getByRole('switch', { name: 'Leave: E-mail' });
    await expect(leaveEmail).toBeChecked();
    // system and subscription notices are locked on
    await expect(card.getByRole('switch', { name: 'System: E-mail' })).toBeDisabled();

    await leaveEmail.click();
    await expect(page.getByText('Notification preferences saved')).toBeVisible();
    await expect(leaveEmail).not.toBeChecked();
    await expect(card.getByRole('switch', { name: 'Leave: In-app' })).toBeChecked();
    const put = backend.calls.find((c) => c.method === 'PUT' && c.path === '/me/notification-preferences');
    expect(put?.body).toEqual({ preferences: [{ category: 'LEAVE', channel: 'EMAIL', enabled: false }] });
    expect(backend.notificationPreferences).toEqual({ 'LEAVE:EMAIL': false });

    await page.reload();
    await expect(page.getByTestId('notification-preferences').getByRole('switch', { name: 'Leave: E-mail' })).not.toBeChecked();
  });

  test('8-P1-4 a member with neither organization.view nor an employee link reaches their preferences at /account/notifications', async ({ page }) => {
    const backend = await installMockBackend(page, { me: meFixture({ roleKey: 'device_technician', roleName: 'Device technician', permissions: ['device.view', 'device.sync'], employeeId: null }) });
    // Settings → Notifications is not theirs (organization.view), and neither is /my (no employee link)
    await page.goto('/settings/notifications');
    await expect(page.getByText('You do not have permission to view this page.')).toBeVisible();
    await expect(page.getByTestId('notification-preferences')).toHaveCount(0);
    // the page their e-mails' footer links to
    await page.goto('/account/notifications');
    await expect(page.getByRole('heading', { level: 1, name: 'Notification settings' })).toBeVisible();
    const card = page.getByTestId('notification-preferences');
    const deviceEmail = card.getByRole('switch', { name: 'Devices and sync: E-mail' });
    await expect(deviceEmail).toBeChecked();
    await deviceEmail.click();
    await expect(page.getByText('Notification preferences saved')).toBeVisible();
    await expect(deviceEmail).not.toBeChecked();
    expect(backend.notificationPreferences).toEqual({ 'DEVICE:EMAIL': false });
    // and from the account menu anywhere in the app
    await page.goto('/notifications');
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Notification settings' }).click();
    await expect(page).toHaveURL(/\/account\/notifications$/);
    await expect(page.getByTestId('notification-preferences').getByRole('switch', { name: 'Devices and sync: E-mail' })).not.toBeChecked();
  });
});
