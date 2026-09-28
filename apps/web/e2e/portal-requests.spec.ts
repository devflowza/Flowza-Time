import { expect, test } from '@playwright/test';
import { ORG_ID, PORTAL_EMPLOYEE_ID, REGULARISATION_ID, installMockBackend, meFixture, portalRequestsHandlers, signInDirectly } from './support/mock-backend';

/**
 * Portal requests (HR portal Prompt 4, Prompt 11 UI suite): an employee asks for a regularisation of a missed check-out from
 * My requests (the times are entered in the organisation's timezone and sent as UTC), finds it under Regularisations waiting at
 * level 1 of 2, and withdraws it — only after confirming.
 */
const EMPLOYEE_PERMISSIONS = ['attendance.view_own', 'attendance.checkin', 'attendance.note', 'attendance.request_correction', 'leave.request', 'shift.view', 'shift.request_swap', 'holiday.view'] as const;

test.describe('employee portal — requests', () => {
  test.beforeEach(async ({ page }) => { await signInDirectly(page); });

  test('request a regularisation → listed at level 1 of 2 → withdrawn after confirming', async ({ page }) => {
    const requests = portalRequestsHandlers();
    const backend = await installMockBackend(page, { me: meFixture({ employeeId: PORTAL_EMPLOYEE_ID, roleKey: 'employee', roleName: 'Employee', permissions: [...EMPLOYEE_PERMISSIONS] }), get: requests.get, post: requests.post });
    await page.goto('/my/requests?tab=regularisations');
    await expect(page.getByRole('heading', { name: 'My requests' })).toBeVisible();

    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await page.getByRole('button', { name: 'Request regularisation' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Request a regularisation' })).toBeVisible();
    // a missed punch needs its time; the reason needs a few words — both are checked before anything is sent
    await dialog.getByRole('button', { name: 'Send request' }).click();
    await expect(dialog.getByText('Choose the day.')).toBeVisible();
    await expect(dialog.getByText('Give the check-in and / or check-out time.')).toBeVisible();
    await expect(dialog.getByText('Write at least 3 characters.')).toBeVisible();
    expect(requests.created).toHaveLength(0);

    await dialog.getByLabel('Day').fill(yesterday);
    await dialog.getByLabel(/Check-out time/).fill('17:40');
    await dialog.getByLabel('Reason').fill('Left through the side gate, the reader was off');
    await dialog.getByRole('button', { name: 'Send request' }).click();
    await expect(page.getByText('Regularisation requested. Your approvers have been notified.')).toBeVisible();
    // 17:40 in Asia/Muscat (UTC+4) is 13:40 UTC
    expect(requests.created).toEqual([{ date: yesterday, type: 'missed_punch', reason: 'Left through the side gate, the reader was off', proposedOutAt: `${yesterday}T13:40:00.000Z` }]);

    const row = page.getByTestId('regularisation-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('I missed a punch');
    await expect(row).toContainText('Awaiting approval');
    await expect(row).toContainText('level 1 of 2');

    // withdrawing asks first; cancelling sends nothing
    await row.getByRole('button', { name: 'Withdraw' }).click();
    await expect(page.getByRole('dialog').getByText('Withdraw this regularisation request?')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    expect(backend.calls.filter((c) => c.path === `/orgs/${ORG_ID}/me/regularisations/${REGULARISATION_ID}/cancel`)).toHaveLength(0);
    await row.getByRole('button', { name: 'Withdraw' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Withdraw' }).click();
    await expect(page.getByText('Regularisation request withdrawn')).toBeVisible();
    expect(backend.calls.filter((c) => c.path === `/orgs/${ORG_ID}/me/regularisations/${REGULARISATION_ID}/cancel`)).toHaveLength(1);
    await expect(row).toContainText('Withdrawn');
    await expect(row.getByRole('button', { name: 'Withdraw' })).toHaveCount(0);
  });
});
