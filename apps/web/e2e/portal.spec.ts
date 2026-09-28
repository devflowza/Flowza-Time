import { expect, test } from '@playwright/test';
import { HQ_FENCE, ORG_ID, PORTAL_EMPLOYEE_ID, installMockBackend, meFixture, signInDirectly } from './support/mock-backend';

/**
 * Employee portal attendance (HR portal Prompt 4): the check-in page reads the browser location, shows the server's verdict,
 * punches (the time is the server's), and a reason given for a day shows up in My requests awaiting review.
 */
test.describe('employee portal — check in and explain a day', () => {
  test.use({ geolocation: { latitude: HQ_FENCE.latitude, longitude: HQ_FENCE.longitude, accuracy: 15 }, permissions: ['geolocation'] });
  test.beforeEach(async ({ page }) => { await signInDirectly(page); });

  test('check-in preview → punch → reason → it is listed in My requests', async ({ page }) => {
    const backend = await installMockBackend(page, { me: meFixture({ employeeId: PORTAL_EMPLOYEE_ID }) });
    const me = `/orgs/${ORG_ID}/me`;

    await page.goto('/my/checkin');
    await expect(page.getByRole('heading', { level: 1, name: 'Check in / out' })).toBeVisible();
    // the verdict comes from the server's preview of this location
    const banner = page.getByTestId('verdict-banner');
    await expect(banner).toHaveAttribute('data-verdict', 'allowed');
    await expect(banner).toContainText('Inside Muscat HQ');
    const previewCall = backend.calls.find((c) => c.method === 'POST' && c.path === `${me}/punch/preview`);
    expect(previewCall?.body).toMatchObject({ direction: 'in', channel: 'web', lat: HQ_FENCE.latitude, lng: HQ_FENCE.longitude });

    await page.getByTestId('punch-button').click();
    await expect(page.getByTestId('today-punches')).toContainText('In');
    const punchCall = backend.calls.find((c) => c.method === 'POST' && c.path === `${me}/punch`);
    expect(punchCall?.body).toMatchObject({ direction: 'in', channel: 'web', idempotencyKey: expect.any(String) });
    // after the check-in the page offers the check-out
    await expect(page.getByTestId('punch-button')).toContainText('Check out');

    await page.goto('/my/requests');
    await page.getByRole('button', { name: 'Add a reason' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Day').fill(new Date().toISOString().slice(0, 10));
    await dialog.getByLabel('Details').fill('Visited the client in Sohar before coming in');
    await dialog.getByRole('button', { name: 'Send' }).click();
    await expect(dialog).toBeHidden();
    const row = page.getByTestId('note-row').first();
    await expect(row).toContainText('Visited the client in Sohar before coming in');
    await expect(row).toContainText('Awaiting review');
    expect(backend.portal.notes).toHaveLength(1);
  });
});
