import { expect, test, type Page } from '@playwright/test';
import { devicesFixture, devicesPunchesHandlers, employeesFixture, installMockBackend, ORG_ID, signInDirectly } from './support/mock-backend';

/** DataTable renders a table and a card fallback; assert on the copy that is on screen for this viewport. */
const onScreen = (page: Page, text: string | RegExp) => page.getByText(text).locator('visible=true').first();

/**
 * Devices & punches: a device PIN nobody is mapped to shows up in the punch log as Unmapped; mapping it to an employee (from the
 * punch row, with device and PIN prefilled) re-queues its punches, and the PIN mapping tab lists the manual mapping next to the
 * employees' default device IDs.
 */
test.describe('Devices & punches', () => {
  test.beforeEach(async ({ page }) => { await signInDirectly(page); });

  test('punch log → raw punch → map the PIN → PIN mapping tab', async ({ page }) => {
    const handlers = devicesPunchesHandlers();
    const backend = await installMockBackend(page, { get: handlers.get, post: handlers.post, del: handlers.del });
    const maryam = employeesFixture[1]!;
    await page.goto('/devices/punch-log');
    await expect(page.getByRole('heading', { level: 1, name: 'Devices & punches' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Punch log/ })).toHaveAttribute('data-state', 'active');
    await expect(page.getByRole('tab', { name: /Unmapped punches/ })).toContainText('1');

    // the raw punch: every stored fact, copied as JSON
    await page.getByRole('button', { name: 'Open raw punch 9001' }).click();
    const raw = page.getByRole('dialog');
    await expect(raw.getByRole('heading', { name: 'Raw punch' })).toBeVisible();
    await expect(raw).toContainText('GN6733356');
    await expect(raw).toContainText('Asia/Muscat');
    await expect(raw).toContainText('"employeeNoString": "2"');
    await page.keyboard.press('Escape');

    // map PIN 2 of the Main gate to Maryam from the unmapped punch
    await page.getByRole('button', { name: 'Map PIN' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel(/PIN on the device/)).toHaveValue('2');
    await expect(dialog.getByRole('combobox', { name: /Device/ })).toContainText('Main gate');
    await dialog.getByRole('combobox', { name: /Employee/ }).click();
    await page.getByRole('option', { name: new RegExp(maryam.displayName) }).click();
    await dialog.getByRole('button', { name: 'Save mapping' }).click();
    await expect(page.getByText('PIN mapping saved')).toBeVisible();
    const post = backend.calls.find((c) => c.method === 'POST' && c.path === `/orgs/${ORG_ID}/pin-mappings`);
    expect(post?.body).toEqual({ employeeId: maryam.id, deviceUserId: '2', deviceId: devicesFixture[0]!.id });
    // the punches come back attributed
    await expect(page.getByRole('row', { name: new RegExp(`${maryam.displayName}`) }).first()).toBeVisible();

    // the PIN mapping tab: the manual device mapping and the default IDs
    await page.getByRole('tab', { name: /PIN mapping/ }).click();
    await expect(page).toHaveURL(/\/devices\/pin-mapping$/);
    await expect(onScreen(page, 'Mapped manually')).toBeVisible();
    await expect(onScreen(page, 'GN6733356')).toBeVisible();
  });
});
