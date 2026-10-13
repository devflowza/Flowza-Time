import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  timeout: 60 * 60_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173', locale: 'en-GB', timezoneId: 'Asia/Muscat',
    // 1440 × 810 CSS px on a 4/3 pixel-ratio screen: the screencast then delivers 1920 × 1080 frames (deviceScaleFactor
    // emulation would not — the screencast captures CSS pixels)
    viewport: { width: 1440, height: 810 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--font-render-hinting=none', '--force-device-scale-factor=1.3333333', '--lang=en-GB'] },
  },
  webServer: { command: 'pnpm exec vite preview --outDir dist-e2e --port 4173 --strictPort', cwd: '..', url: 'http://localhost:4173', reuseExistingServer: true, timeout: 60_000 },
});
