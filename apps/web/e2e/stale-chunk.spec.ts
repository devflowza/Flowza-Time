import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { installMockBackend, signInDirectly } from './support/mock-backend';

/**
 * A tab opened before a deploy still runs the old entry chunk. The next lazy page it opens asks for a chunk the deploy has
 * removed, and Cloudflare Pages answers that with the SPA's index.html (200, text/html) — the browser then throws "Failed
 * to fetch dynamically imported module". These tests serve the page chunk exactly like that and check the app recovers.
 */
const PAGE_CHUNK = /\/assets\/employee-new-page-[\w-]+\.js$/;

async function serveChunkAsHtml(page: Page, times: number) {
  const indexHtml = await readFile(path.resolve(import.meta.dirname, '../dist-e2e/index.html'), 'utf8');
  let served = 0;
  await page.route(PAGE_CHUNK, async (route) => {
    if (served >= times) return route.continue();
    served += 1;
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: indexHtml });
  });
}

async function openNewEmployeeFromList(page: Page) {
  await page.goto('/employees');
  await page.getByRole('button', { name: 'Add employee' }).first().click();
}

test.describe('a page chunk replaced by a deploy', () => {
  test.beforeEach(async ({ page }) => { await signInDirectly(page); });

  test('reloads once by itself and opens the page from the new build', async ({ page }) => {
    await installMockBackend(page);
    await serveChunkAsHtml(page, 1);
    let loads = 0;
    page.on('load', () => { loads += 1; });
    await openNewEmployeeFromList(page);
    await expect(page).toHaveURL(/\/employees\/new$/);
    await expect(page.getByRole('button', { name: 'Create employee' })).toBeVisible();
    await expect(page.getByText(/Unexpected Application Error|Hey developer/)).toHaveCount(0);
    expect(loads).toBe(2); // the list, then the one automatic reload
  });

  test('does not loop when the chunk is still missing after the reload, and offers a button instead', async ({ page }) => {
    await installMockBackend(page);
    await serveChunkAsHtml(page, Number.POSITIVE_INFINITY);
    let loads = 0;
    page.on('load', () => { loads += 1; });
    await openNewEmployeeFromList(page);
    await expect(page.getByText('Reload the page to continue with the latest version.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reload page' })).toBeVisible();
    // the shell stays usable around the failed page
    await expect(page.getByRole('link', { name: 'Employees' }).first()).toBeVisible();
    expect(loads).toBe(2);
  });
});
