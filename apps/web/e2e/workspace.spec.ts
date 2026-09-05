import { expect, test, type Page } from '@playwright/test';
import { installMockBackend, meFixture, signInDirectly } from './support/mock-backend';

/**
 * DataTable renders a table *and* a card fallback, one of which the responsive CSS hides. Cell values therefore exist twice
 * in the DOM, so assertions target the copy that is actually on screen for this viewport.
 */
const onScreen = (page: Page, text: string | RegExp) => page.getByText(text).locator('visible=true').first();

test.describe('authenticated workspace', () => {
  test.beforeEach(async ({ page }) => { await signInDirectly(page); });

  test('dashboard shows the organisation KPIs from the API', async ({ page }) => {
    await installMockBackend(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText('Present today')).toBeVisible();
    await expect(page.getByText('431', { exact: true })).toBeVisible();
    await expect(page.getByText('Pending approvals')).toBeVisible();
  });

  test('employees list renders server rows, filters through the URL and links to the profile', async ({ page }) => {
    const backend = await installMockBackend(page);
    await page.goto('/employees');
    await expect(onScreen(page, 'Salim Al Harthy')).toBeVisible();
    await expect(onScreen(page, 'Khalid Al Balushi')).toBeVisible();

    await page.getByRole('searchbox').fill('maryam');
    await expect(page).toHaveURL(/search=maryam/);
    await expect(onScreen(page, 'Maryam Al Lawati')).toBeVisible();
    await expect(page.getByText('Salim Al Harthy')).toHaveCount(0);
    // the search reached the API as a query parameter (no client-side filtering of paginated data)
    expect(backend.calls.some((c) => c.path === `/orgs/11111111-1111-4111-8111-111111111111/employees`)).toBe(true);
  });

  test('devices list shows connection status for each device', async ({ page }) => {
    await installMockBackend(page);
    await page.goto('/devices');
    await expect(onScreen(page, 'Main gate')).toBeVisible();
    await expect(onScreen(page, 'Plant entrance')).toBeVisible();
    await expect(onScreen(page, /online/i)).toBeVisible();
    await expect(onScreen(page, /offline/i)).toBeVisible();
  });

  test('global search opens with Ctrl+K and navigates to a result', async ({ page }) => {
    await installMockBackend(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox').fill('khalid');
    await expect(dialog.getByText('Khalid Al Balushi')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/employees\/77777777-7777-4777-8777-000000000003/);
  });

  test('switching to Arabic flips the document direction and translates the navigation', async ({ page }) => {
    await installMockBackend(page);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await page.getByRole('button', { name: 'Language' }).click();
    await page.getByRole('menuitem', { name: 'العربية' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.getByRole('link', { name: 'الموظفون' })).toBeVisible();
    // and back
    await page.getByRole('button', { name: 'اللغة' }).click();
    await page.getByRole('menuitem', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });

  test('a signed-in user without any organisation membership sees the honest empty state', async ({ page }) => {
    const me = meFixture(); me.memberships = [];
    await installMockBackend(page, { me });
    await page.goto('/');
    await expect(page.getByText(/not a member of any organisation/)).toBeVisible();
  });
});
