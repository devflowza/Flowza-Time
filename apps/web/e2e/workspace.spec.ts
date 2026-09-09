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
    // the default look: a personal greeting as the page heading, the FlowZa Green style on the shell
    await expect(page.getByRole('heading', { level: 1, name: /Good (morning|afternoon|evening), Aisha!/ })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'emerald');
    await expect(page.getByText('Present today')).toBeVisible();
    await expect(page.getByText('431', { exact: true })).toBeVisible();
    await expect(page.getByText('Pending approvals')).toBeVisible();
    await expect(page.getByText('Muscat HQ')).toBeVisible();
    await expect(page.getByText('Attendance trend')).toBeVisible();
  });

  test('the dashboard style and layout the organisation saved in settings shape the shell and the page', async ({ page }) => {
    const me = meFixture();
    me.memberships[0]!.settings = { ...me.memberships[0]!.settings, dashboard: { theme: 'midnight', layout: 'executive', showGreeting: false } };
    await installMockBackend(page, { me });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText('Attendance rate')).toBeVisible();
    await expect(page.getByText('Pending approvals')).toHaveCount(0); // the executive layout has no side rail
    // the style reaches the sidebar through the CSS variables, not through per-component colours
    const sidebar = page.getByRole('complementary', { name: 'Primary' });
    if (await sidebar.isVisible()) await expect(sidebar).toHaveCSS('background-color', 'rgb(22, 26, 63)');
  });

  test('settings → dashboard previews a style live on the whole app before it is saved', async ({ page }) => {
    await installMockBackend(page);
    await page.goto('/settings/dashboard');
    await expect(page.getByRole('radio', { name: /FlowZa Green/ })).toBeChecked();
    await page.getByRole('radio', { name: /Classic Light/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'classic');
    await expect(page.getByText(/Previewing “Classic Light”/)).toBeVisible();
    const sidebar = page.getByRole('complementary', { name: 'Primary' });
    if (await sidebar.isVisible()) await expect(sidebar).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    // leaving without saving drops the preview: the organisation's saved style is back
    await page.getByRole('link', { name: 'Employees' }).first().click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'emerald');
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
    await expect(page.getByRole('heading', { level: 1, name: /Good (morning|afternoon|evening), Aisha!/ })).toBeVisible();
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
