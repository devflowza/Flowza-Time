import { expect, test, type Page } from '@playwright/test';
import { installMockBackend, OWNER } from './support/mock-backend';

/**
 * Password reset, end to end in the production bundle: the e-mail link opens /auth/reset, a new password is required before
 * the app opens, and a link Supabase refused (used before — often by a mail scanner — or expired) says so.
 */
const NEW_PASSWORD = 'N3w!Password-2026';

async function choosePassword(page: Page, password = NEW_PASSWORD) {
  await page.getByLabel('New password').fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Set new password' }).click();
}

test.describe('password reset', () => {
  test('requesting a reset asks for a link that opens the reset page', async ({ page }) => {
    const backend = await installMockBackend(page);
    await page.goto('/auth/sign-in');
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await page.getByLabel('Work email').fill(OWNER.email);
    await page.getByRole('button', { name: 'Reset password' }).click();
    await expect(page.getByText(`If an account exists for ${OWNER.email}, a reset link has been sent.`)).toBeVisible();
    expect(backend.auth.recoverRequests).toEqual([{ email: OWNER.email, redirectTo: `${new URL(page.url()).origin}/auth/reset` }]);
  });

  test('the link sets a new password, and only then opens the app', async ({ page }) => {
    const backend = await installMockBackend(page);
    await page.goto('/auth/reset?token_hash=pkce_e2e1&type=recovery');
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    // opening the link (as a mail scanner does) verifies nothing
    expect(backend.auth.verified).toEqual([]);

    await choosePassword(page);
    await expect(page.getByText('Password changed')).toBeVisible();
    expect(backend.auth.verified).toEqual(['pkce_e2e1']);
    expect(backend.auth.passwords).toEqual([NEW_PASSWORD]);
    expect(backend.auth.logoutScopes).toEqual(['others']);
    await expect(page).toHaveURL(/\/auth\/reset$/); // the spent token left the address bar

    await page.getByRole('link', { name: 'Continue' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('button', { name: 'Switch organisation' })).toContainText('Al Bahja Trading');
  });

  test('a link built on the bare Site URL is forwarded to the reset page', async ({ page }) => {
    const backend = await installMockBackend(page);
    await page.goto('/?token_hash=pkce_e2e3&type=recovery');
    await expect(page).toHaveURL(/\/auth\/reset\?token_hash=pkce_e2e3&type=recovery$/);
    await choosePassword(page);
    await expect(page.getByText('Password changed')).toBeVisible();
    expect(backend.auth.verified).toEqual(['pkce_e2e3']);
  });

  test('a session opened by the link cannot use the app until the password is set — not by typing another address, not after a reload', async ({ page }) => {
    const backend = await installMockBackend(page, { refusePasswordOnce: 'weak_password' });
    await page.goto('/auth/reset?token_hash=pkce_e2e2&type=recovery');
    await choosePassword(page);
    // the link is verified (a recovery session exists now) but the server refused the password
    await expect(page.getByText('This password is too easy to guess.', { exact: false })).toBeVisible();
    expect(backend.auth.verified).toEqual(['pkce_e2e2']);

    for (const path of ['/my', '/employees', '/']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/auth\/reset$/);
      await expect(page.getByText(`You opened a password-reset link for ${OWNER.email}. Choose a new password to continue.`)).toBeVisible();
    }

    await choosePassword(page, 'An0ther!Password-2026');
    await expect(page.getByText('Password changed')).toBeVisible();
    expect(backend.auth.verified).toEqual(['pkce_e2e2']); // spent once, not verified again
    await page.goto('/employees');
    await expect(page).toHaveURL(/\/employees$/);
  });

  test('a link already used — e.g. opened first by a mail scanner — says so and offers a new one', async ({ page }) => {
    const backend = await installMockBackend(page, { spentResetTokens: ['pkce_spent'] });
    await page.goto('/auth/reset?token_hash=pkce_spent&type=recovery');
    await choosePassword(page);
    await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible();
    expect(backend.auth.passwords).toEqual([]);
    await page.getByRole('link', { name: 'Request a new link' }).click();
    await expect(page).toHaveURL(/\/auth\/forgot$/);
  });

  test("Supabase's error redirect to the Site URL is explained instead of silently landing on the sign-in page", async ({ page }) => {
    await installMockBackend(page);
    await page.goto('/?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    await expect(page).toHaveURL(/\/auth\/sign-in$/);
    await expect(page.getByText('That e-mail link has expired or was already used')).toBeVisible();
    await page.getByRole('button', { name: 'Request a new link' }).click();
    await expect(page).toHaveURL(/\/auth\/forgot$/);
  });

  test('signing in after such a redirect lands on a clean address', async ({ page }) => {
    await installMockBackend(page);
    await page.goto('/?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    await expect(page).toHaveURL(/\/auth\/sign-in$/);
    await page.getByLabel('Work email').fill(OWNER.email);
    await page.getByLabel('Password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('button', { name: 'Switch organisation' })).toContainText('Al Bahja Trading');
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe('/');
  });
});
