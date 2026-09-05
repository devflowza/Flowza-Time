import { expect, test } from '@playwright/test';
import { installMockBackend, OWNER } from './support/mock-backend';

test.describe('authentication', () => {
  test('an anonymous visitor is sent to the sign-in page and returned to the requested route after signing in', async ({ page }) => {
    const backend = await installMockBackend(page);
    await page.goto('/employees');
    await expect(page).toHaveURL(/\/auth\/sign-in$/);
    await expect(page.getByRole('heading', { name: 'Sign in to FlowZa Time' })).toBeVisible();

    await page.getByLabel('Work email').fill(OWNER.email);
    await page.getByLabel('Password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // back on the route the visitor asked for, inside the authenticated shell of the active organisation
    await expect(page).toHaveURL(/\/employees$/);
    await expect(page.getByRole('button', { name: 'Switch organisation' })).toContainText('Al Bahja Trading');
    // the API only ever saw bearer-authenticated calls (the mock rejects anything else with 401)
    expect(backend.calls.some((c) => c.path === '/me')).toBe(true);
  });

  test('wrong credentials show the generic error and never reach the API', async ({ page }) => {
    const backend = await installMockBackend(page, { rejectSignIn: true });
    await page.goto('/auth/sign-in');
    await page.getByLabel('Work email').fill(OWNER.email);
    await page.getByLabel('Password').fill('nope');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Invalid email or password.')).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/sign-in$/);
    expect(backend.calls).toHaveLength(0);
  });

  test('client-side validation blocks an empty form before any network call', async ({ page }) => {
    const backend = await installMockBackend(page);
    await page.goto('/auth/sign-in');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert').first()).toBeVisible();
    expect(backend.calls).toHaveLength(0);
  });
});
