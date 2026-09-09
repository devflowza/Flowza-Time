import { expect, test, type Page } from '@playwright/test';
import { installMockBackend, meFixture, organization, USER_ID } from './support/mock-backend';

const NEW_USER = { company: 'Al Bahja Trading', email: 'new.owner@albahja.example', password: 'FlowZa-New-2026!' };
const memberless = () => ({ user: { id: USER_ID, email: NEW_USER.email, fullName: '', avatarUrl: null, locale: 'en', mfaEnrolled: false, isPlatformAdmin: false }, memberships: [] });

async function fillSignUp(page: Page, company = NEW_USER.company) {
  await page.getByLabel('Company name').fill(company);
  await page.getByLabel('Work email').fill(NEW_USER.email);
  await page.getByLabel('Password', { exact: true }).fill(NEW_USER.password);
  await page.getByLabel('Confirm password').fill(NEW_USER.password);
  await page.getByRole('button', { name: 'Create account' }).click();
}

/** `/me` answers member-less until POST /orgs has been called, then with the owner membership — as the real API does. */
function orgBackend(page: Page, extra: Parameters<typeof installMockBackend>[1] = {}) {
  let created = false;
  return installMockBackend(page, {
    ...extra,
    get: { '/me': () => ({ data: created ? meFixture() : memberless() }), ...extra.get },
    post: { '/orgs': () => { created = true; return { status: 201, body: { data: { organization, membershipId: '66666666-6666-4666-8666-666666666666' } } }; }, ...extra.post },
  });
}

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
    await page.getByLabel('Company name').fill('A');
    await page.getByLabel('Work email').fill('not-an-email');
    await page.getByLabel('Password', { exact: true }).fill('short');
    await page.getByLabel('Confirm password').fill('different');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Enter your company name (at least 2 characters).')).toBeVisible();
    await expect(page.getByText('Enter a valid email address.')).toBeVisible();
    await expect(page.getByText('Use at least 12 characters.')).toBeVisible();
    await expect(page.getByText('Passwords do not match.')).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/sign-up$/);
    expect(backend.calls).toHaveLength(0);
  });

  test('a confirmed sign-up creates the organisation and lands its new owner on the dashboard', async ({ page }) => {
    const backend = await orgBackend(page);
    await page.goto('/auth/sign-up');
    await fillSignUp(page);

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('button', { name: 'Switch organisation' })).toContainText('Al Bahja Trading');
    const create = backend.calls.find((c) => c.method === 'POST' && c.path === '/orgs');
    expect(create?.body).toMatchObject({ displayName: NEW_USER.company, timezone: 'Asia/Muscat' });
    // never a create-organisation screen in between: the page waited for the organisation before leaving
    await expect(page.getByRole('heading', { name: 'Create your organisation' })).toHaveCount(0);
  });

  test('a project that requires email confirmation parks the company and finishes after the first sign-in', async ({ page }) => {
    const backend = await orgBackend(page, { confirmEmailOnSignUp: true });
    await page.goto('/auth/sign-up');
    await fillSignUp(page);

    await expect(page.getByRole('heading', { name: 'Confirm your email' })).toBeVisible();
    await expect(page.getByText(NEW_USER.email)).toBeVisible();
    expect(backend.calls).toHaveLength(0);

    // ...the user confirms, comes back and signs in: no membership yet, so the shell offers the parked company
    await page.getByRole('link', { name: 'Sign in' }).click();
    await page.getByLabel('Work email').fill(NEW_USER.email);
    await page.getByLabel('Password').fill(NEW_USER.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Create your organisation' })).toBeVisible();
    await expect(page.getByLabel('Company name')).toHaveValue(NEW_USER.company);
    await page.getByRole('button', { name: 'Create organisation' }).click();
    await expect(page.getByRole('button', { name: 'Switch organisation' })).toContainText('Al Bahja Trading');
    expect(backend.calls.filter((c) => c.method === 'POST' && c.path === '/orgs')).toHaveLength(1);
  });

  test('a member-less user whose organisation call is refused sees the reason and can sign out', async ({ page }) => {
    await installMockBackend(page, { me: memberless(), post: { '/orgs': () => ({ status: 409, body: { code: 'INVALID_STATE', message: 'Self-service sign-up is not available right now.', requestId: 'e2e' } }) } });
    await page.goto('/auth/sign-in');
    await page.getByLabel('Work email').fill(NEW_USER.email);
    await page.getByLabel('Password').fill(NEW_USER.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Create your organisation' })).toBeVisible();
    await page.getByLabel('Company name').fill(NEW_USER.company);
    await page.getByRole('button', { name: 'Create organisation' }).click();
    await expect(page.getByRole('alert')).toContainText('not available right now');
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('an address that is already registered shows the Supabase reason', async ({ page }) => {
    await installMockBackend(page, { rejectSignUp: true });
    await page.goto('/auth/sign-up');
    await fillSignUp(page);
    await expect(page.getByRole('alert')).toContainText('User already registered');
    await expect(page).toHaveURL(/\/auth\/sign-up$/);
  });
});
