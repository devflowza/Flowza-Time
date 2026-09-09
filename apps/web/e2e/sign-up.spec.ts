import { expect, test } from '@playwright/test';
import { installMockBackend } from './support/mock-backend';

const NEW_USER = { email: 'new.owner@albahja.example', password: 'FlowZa-New-2026!' };

test.describe('sign up', () => {
  test('the sign-in page links to account creation', async ({ page }) => {
    await installMockBackend(page);
    await page.goto('/auth/sign-in');
    await page.getByRole('link', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/auth\/sign-up$/);
    await expect(page.getByRole('heading', { name: 'Create your FlowZa Time account' })).toBeVisible();
  });

  test('client-side validation blocks a bad form before any network call', async ({ page }) => {
    const backend = await installMockBackend(page);
    await page.goto('/auth/sign-up');
    await page.getByLabel('Work email').fill('not-an-email');
    await page.getByLabel('Password', { exact: true }).fill('short');
    await page.getByLabel('Confirm password').fill('different');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Enter a valid email address.')).toBeVisible();
    await expect(page.getByText('Use at least 12 characters.')).toBeVisible();
    await expect(page.getByText('Passwords do not match.')).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/sign-up$/);
    expect(backend.calls).toHaveLength(0);
  });

  test('a confirmed sign-up lands in the app, where a member-less account is told to wait for an invitation', async ({ page }) => {
    const backend = await installMockBackend(page, { me: { user: { id: '44444444-4444-4444-8444-444444444444', email: NEW_USER.email, fullName: '', avatarUrl: null, locale: 'en', mfaEnrolled: false, isPlatformAdmin: false }, memberships: [] } });
    await page.goto('/auth/sign-up');
    await page.getByLabel('Work email').fill(NEW_USER.email);
    await page.getByLabel('Password', { exact: true }).fill(NEW_USER.password);
    await page.getByLabel('Confirm password').fill(NEW_USER.password);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText('Your account is not a member of any organisation yet.')).toBeVisible();
    // the only API traffic is the authenticated /me lookup; nothing about the account itself went to the API
    expect(backend.calls.every((c) => c.path === '/me')).toBe(true);
  });

  test('a project that requires email confirmation shows the check-your-inbox screen', async ({ page }) => {
    const backend = await installMockBackend(page, { confirmEmailOnSignUp: true });
    await page.goto('/auth/sign-up');
    await page.getByLabel('Work email').fill(NEW_USER.email);
    await page.getByLabel('Password', { exact: true }).fill(NEW_USER.password);
    await page.getByLabel('Confirm password').fill(NEW_USER.password);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByRole('heading', { name: 'Confirm your email' })).toBeVisible();
    await expect(page.getByText(NEW_USER.email)).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/sign-up$/);
    expect(backend.calls).toHaveLength(0);
  });

  test('an address that is already registered shows the Supabase reason', async ({ page }) => {
    await installMockBackend(page, { rejectSignUp: true });
    await page.goto('/auth/sign-up');
    await page.getByLabel('Work email').fill(NEW_USER.email);
    await page.getByLabel('Password', { exact: true }).fill(NEW_USER.password);
    await page.getByLabel('Confirm password').fill(NEW_USER.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('alert')).toContainText('User already registered');
  });
});
