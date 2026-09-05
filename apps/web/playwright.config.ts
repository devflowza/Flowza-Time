import { defineConfig, devices } from '@playwright/test';

/**
 * UI end-to-end tests against the production bundle served by `vite preview`, with the backend (Supabase Auth + FlowZa
 * API) answered by Playwright route handlers (see e2e/support/mock-backend.ts). The bundle is built with same-origin
 * backend URLs (`pnpm run build:e2e`) so no CORS is involved and every request the SPA makes is interceptable.
 *
 * Full-stack E2E against a seeded Supabase stack is a separate, planned suite (docs/testing.md).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    locale: 'en-GB',
    timezoneId: 'Asia/Muscat',
    // CI runs `playwright install chromium`; a workstation or container that already ships a Chromium build can point at it
    // with PLAYWRIGHT_CHROMIUM_EXECUTABLE (e.g. /opt/pw-browsers/chromium) instead of downloading a second copy.
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } } : {}),
  },
  webServer: {
    command: 'pnpm exec vite preview --outDir dist-e2e --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // narrow viewport: the DataTable card fallback and the mobile navigation
    { name: 'tablet', use: { ...devices['iPad Mini'], browserName: 'chromium' } },
  ],
});
