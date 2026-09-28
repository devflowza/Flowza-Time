import { expect, test } from '@playwright/test';
import { EMPLOYEE_ID, installMockBackend, LEAVE_TYPE_AL, meFixture, ORG_ID, signInDirectly } from './support/mock-backend';

/** A Sunday → Thursday range (five working days: Friday and Saturday are the weekly off) three weeks ahead. */
function nextWorkingWeek(): { from: string; to: string } {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 21 + ((7 - d.getUTCDay()) % 7));
  const from = d.toISOString().slice(0, 10);
  d.setUTCDate(d.getUTCDate() + 4);
  return { from, to: d.toISOString().slice(0, 10) };
}

test.describe('leave v2 — employee portal', () => {
  test.beforeEach(async ({ page }) => { await signInDirectly(page); });

  test('an employee applies for leave with a live day count and finds it under Requests', async ({ page }) => {
    const me = meFixture({ roleKey: 'employee', roleName: 'Employee', employeeId: EMPLOYEE_ID, permissions: ['leave.request', 'attendance.view_own', 'attendance.request_correction'] });
    const backend = await installMockBackend(page, { me });
    const { from, to } = nextWorkingWeek();
    // the year the request falls in (late December: next year's page)
    await page.goto(`/my/leave?year=${from.slice(0, 4)}`);
    await expect(page.getByRole('heading', { name: 'My leave' })).toBeVisible();
    // the five totals and a card per type
    await expect(page.getByRole('region', { name: 'Leave totals' })).toContainText('Entitlement');
    await expect(page.getByTestId('leave-type-card').first()).toContainText('Annual Leave');

    await page.getByRole('button', { name: 'Apply for leave' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Apply for leave' });
    await dialog.getByRole('combobox', { name: 'Leave type' }).click();
    await page.getByRole('option', { name: /Annual Leave/ }).click();
    await dialog.getByLabel('From').fill(from);
    await dialog.getByRole('textbox', { name: 'To', exact: true }).fill(to);
    // live day count: five working days, and the balance left after it
    await expect(dialog.getByTestId('leave-preview')).toContainText('This request uses 5 working days.');
    await expect(dialog.getByTestId('leave-preview')).toContainText('25 days of Annual Leave left after this request.');
    await dialog.getByLabel('Reason').fill('Family wedding in Nizwa');
    await dialog.getByRole('button', { name: 'Send request' }).click();
    await expect(dialog).toBeHidden();

    // the request is listed (re-fetched from the API) as pending, with its five days
    const row = page.getByRole('row', { name: /Family wedding in Nizwa/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Pending');
    await expect(row.getByRole('cell').nth(2)).toHaveText('5');
    const post = backend.calls.find((c) => c.method === 'POST' && c.path === `/orgs/${ORG_ID}/me/leave`);
    expect(post?.body).toMatchObject({ leaveTypeId: LEAVE_TYPE_AL, startDate: from, endDate: to, isHalfDay: false, reason: 'Family wedding in Nizwa' });
  });
});
