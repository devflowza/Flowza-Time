import { expect, test } from '@playwright/test';
import { FINANCE_GOOD_TOKEN, ORG_ID, financeIntegrationHandlers, installMockBackend, signInDirectly } from './support/mock-backend';

/**
 * Settings → Integrations → Flowza Finance (HR portal Prompt 11): the owner tests the connection with the values typed so far (a
 * wrong token is reported, never saved), enables and saves the connector (the token comes back masked), tests again with the
 * stored credentials, and disconnects — only after confirming, and a cancelled confirmation sends nothing.
 */
test.describe('Settings → Integrations → Flowza Finance', () => {
  test.beforeEach(async ({ page }) => { await signInDirectly(page); });

  test('enable, test connection, save, test with the stored token, disconnect with confirmation', async ({ page }) => {
    const finance = financeIntegrationHandlers();
    const backend = await installMockBackend(page, { get: finance.get, post: finance.post, put: finance.put, del: finance.del });
    const path = `/orgs/${ORG_ID}/integrations/finance`;
    await page.goto('/settings/integrations');

    await expect(page.getByRole('heading', { name: 'Flowza Finance' })).toBeVisible();
    // a connector that was never configured: enabled by default, no status card yet, the token is asked for
    await expect(page.getByRole('switch', { name: 'Enable the connector' })).toBeChecked();
    await expect(page.getByRole('region', { name: 'Sync status' })).toHaveCount(0);
    await page.getByLabel('Finance device serial').fill('FLOWZA-TIME-E2E');
    await page.getByLabel('Finance push token').fill('not-the-right-token');

    // test connection with the typed (unsaved) values: a refused credential is reported with its translated reason
    await page.getByRole('button', { name: 'Test connection' }).click();
    const result = page.getByRole('status').filter({ hasText: 'Connection failed' });
    await expect(result).toBeVisible();
    await expect(result.getByText('Credential rejected')).toBeVisible();
    expect(backend.calls.filter((c) => c.method === 'PUT' && c.path === path)).toHaveLength(0);

    await page.getByLabel('Finance push token').fill(FINANCE_GOOD_TOKEN);
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Connected to Flowza Finance' })).toBeVisible();
    const tests = backend.calls.filter((c) => c.method === 'POST' && c.path === `${path}/test`);
    expect(tests.at(-1)?.body).toMatchObject({ deviceSerial: 'FLOWZA-TIME-E2E', token: FINANCE_GOOD_TOKEN });

    // save: the connector is enabled, the token is sent once and comes back masked
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Settings saved')).toBeVisible();
    const put = backend.calls.find((c) => c.method === 'PUT' && c.path === path);
    expect(put?.body).toMatchObject({ enabled: true, deviceSerial: 'FLOWZA-TIME-E2E', token: FINANCE_GOOD_TOKEN, direction: 'both', pinKey: 'employee_number' });
    await expect(page.getByText(`Stored token ****${FINANCE_GOOD_TOKEN.slice(-4)}`)).toBeVisible();
    await expect(page.getByLabel('Finance push token')).toHaveCount(0);
    const status = page.getByRole('region', { name: 'Sync status' });
    await expect(status).toBeVisible();

    // test again: nothing typed, so the stored token is used (and never sent back by the page)
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Used the stored token' })).toBeVisible();
    const stored = backend.calls.filter((c) => c.method === 'POST' && c.path === `${path}/test`).at(-1);
    expect(stored?.body).not.toHaveProperty('token');

    // disconnect asks first; cancelling sends nothing
    await status.getByRole('button', { name: 'Disconnect' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Disconnect Flowza Finance?')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(backend.calls.filter((c) => c.method === 'DELETE' && c.path === path)).toHaveLength(0);

    await status.getByRole('button', { name: 'Disconnect' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.getByText('Flowza Finance disconnected')).toBeVisible();
    expect(backend.calls.filter((c) => c.method === 'DELETE' && c.path === path)).toHaveLength(1);
    // disconnected: disabled, the token is gone (a new one is asked for), nothing left to disconnect
    await expect(page.getByRole('region', { name: 'Sync status' }).getByText('Disabled')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Sync status' }).getByRole('button', { name: 'Disconnect' })).toHaveCount(0);
    await expect(page.getByLabel('Finance push token')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Enable the connector' })).not.toBeChecked();
    expect(finance.state.token).toBeNull();

    // reconnect: a new token and the connector switched back on
    await page.getByLabel('Finance push token').fill(FINANCE_GOOD_TOKEN);
    await page.getByRole('switch', { name: 'Enable the connector' }).click();
    await expect(page.getByRole('switch', { name: 'Enable the connector' })).toBeChecked();
    await page.getByRole('button', { name: 'Save' }).click();
    // the first save's toast may still be on screen: wait for the second PUT itself
    await expect.poll(() => backend.calls.filter((c) => c.method === 'PUT' && c.path === path).length).toBe(2);
    expect(backend.calls.filter((c) => c.method === 'PUT' && c.path === path).at(-1)?.body).toMatchObject({ enabled: true, token: FINANCE_GOOD_TOKEN });
    await expect(page.getByText(`Stored token ****${FINANCE_GOOD_TOKEN.slice(-4)}`)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Sync status' }).getByText('Disabled')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Sync status' }).getByRole('button', { name: 'Disconnect' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Sync status' }).getByRole('button', { name: 'Sync now' })).toBeEnabled();
  });
});
