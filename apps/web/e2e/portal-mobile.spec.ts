import { expect, test } from '@playwright/test';
import { HQ_FENCE, ORG_ID, PORTAL_EMPLOYEE_ID, installMockBackend, meFixture, signInDirectly } from './support/mock-backend';

/**
 * HR portal Prompt 4 review, P2-15: the employee portal pages — and the global top bar every page carries — fit a 390 px phone in
 * English and in Arabic (RTL): the page never scrolls sideways and every top-bar control stays on screen. The shift tab gets the
 * worst case the review measured (a long shift name, a pending swap with a long colleague name: 961 px before the fix).
 */
const me = `/orgs/${ORG_ID}/me`;
const today = new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const shiftSummary = { id: 's1', code: 'MORN', name: 'Morning shift (Muscat HQ reception and visitor desk)', type: 'FIXED', startTime: '08:00', endTime: '16:00', requiredMinutes: 480, graceInMinutes: 10, crossesMidnight: false, color: null, breakMinutes: 60 };
const day = (i: number) => ({
  date: addDays(today, i), shift: shiftSummary, source: 'ASSIGNMENT', isOff: false, holidayName: null, onLeave: false,
  swap: i === 3 ? { id: 'sw1', status: 'pending', withEmployeeName: 'Maryam bint Abdullah Al Lawati Al Balushi' } : null,
});
const PAGES = ['/my/shift', '/my/checkin', '/my/requests', '/attendance/notes', '/attendance/geofences', '/'];

for (const lang of ['en', 'ar'] as const) {
  test.describe(`4-P2-15 portal at 390 px (${lang})`, () => {
    test.use({ viewport: { width: 390, height: 844 }, geolocation: { latitude: HQ_FENCE.latitude, longitude: HQ_FENCE.longitude, accuracy: 15 }, permissions: ['geolocation'] });

    test(`4-P2-15 /my/shift and the global top bar never scroll sideways at 390 × 844 (${lang})`, async ({ page }) => {
      await page.addInitScript((l) => { window.localStorage.setItem('flowza.locale', l as string); }, lang);
      await signInDirectly(page);
      await installMockBackend(page, {
        me: meFixture({ employeeId: PORTAL_EMPLOYEE_ID }),
        get: {
          [`${me}/shift`]: { data: { date: today, timezone: 'Asia/Muscat', today: day(0), upcoming: Array.from({ length: 14 }, (_, i) => day(i + 1)), history: [{ id: 'a1', targetType: 'EMPLOYEE', shiftName: shiftSummary.name, patternName: null, effectiveFrom: '2026-01-01', effectiveTo: null, isSwap: false }] } },
          [`${me}/shift-swaps`]: { data: [] },
          [`${me}/regularisations`]: { data: [] },
          [`${me}/selfie-checkins`]: { data: [] },
        },
      });
      for (const path of PAGES) {
        await page.goto(path);
        await expect(page.locator('h1').first()).toBeVisible();
        await page.waitForLoadState('networkidle');
        const m = await page.evaluate(() => {
          const doc = document.documentElement;
          const header = document.querySelector('header');
          const offscreen = header ? Array.from(header.querySelectorAll('button, a')).map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && (r.right > doc.clientWidth + 1 || r.left < -1)).length : -1;
          return { dir: doc.dir, scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, offscreen };
        });
        expect(m.dir, path).toBe(lang === 'ar' ? 'rtl' : 'ltr');
        expect(m.scrollWidth, `${path} scrolls sideways`).toBeLessThanOrEqual(m.clientWidth);
        expect(m.offscreen, `${path}: top-bar controls off screen`).toBe(0);
        if (path === '/my/shift') {
          // the long names are truncated or wrapped inside the rows, never cut off by the viewport
          const rows = page.getByTestId('shift-day');
          await expect(rows.first()).toBeVisible();
          const widest = await rows.evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().right)));
          expect(widest).toBeLessThanOrEqual(390);
        }
      }
    });
  });
}
