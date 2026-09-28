import { expect, test } from '@playwright/test';
import { installMockBackend, LINE_MANAGER_PERMISSIONS, MANAGER_EMPLOYEE_ID, meFixture, ORG_ID, signInDirectly, teamHandlers } from './support/mock-backend';

/**
 * HR portal Prompt 5 review, P2-4: the manager chip next to the bell adds no horizontal scroll on a 390 px phone, in English
 * and in Arabic (RTL) — with a count and with "99+", the widest it gets — and every top-bar control stays on screen. The
 * Prompt 4 fix made the global top bar fit; this pins that the chip keeps it that way.
 */
for (const lang of ['en', 'ar'] as const) {
  test.describe(`5-P2-4 the pending chip at 390 px (${lang})`, () => {
    test.use({ viewport: { width: 390, height: 844 } });

    for (const [label, counts] of [['a count', { approvals: 2, notes: 1, total: 3 }], ['99+', { approvals: 140, notes: 12, total: 152 }]] as const) {
      test(`5-P2-4 the chip (${label}) adds no horizontal scroll at 390 × 844 (${lang})`, async ({ page }) => {
        await page.addInitScript((l) => { window.localStorage.setItem('flowza.locale', l as string); }, lang);
        await signInDirectly(page);
        const team = teamHandlers();
        const me = meFixture({ roleKey: 'team_lead', roleName: 'Team Lead', permissions: [...LINE_MANAGER_PERMISSIONS], employeeId: MANAGER_EMPLOYEE_ID, isManager: true, teamSize: 2 });
        await installMockBackend(page, { me, get: { ...team.get, [`/orgs/${ORG_ID}/team/pending-counts`]: { data: counts } }, post: team.post });
        for (const path of ['/', '/team']) {
          await page.goto(path);
          await expect(page.locator('h1').first()).toBeVisible();
          const chip = page.getByTestId('pending-chip');
          await expect(chip).toBeVisible();
          await expect(chip).toHaveText(counts.total > 99 ? '99+' : String(counts.total));
          await page.waitForLoadState('networkidle');
          const m = await page.evaluate(() => {
            const doc = document.documentElement;
            const header = document.querySelector('header');
            const controls = header ? Array.from(header.querySelectorAll('button, a')).map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0) : [];
            const chipBox = document.querySelector('[data-testid="pending-chip"]')?.getBoundingClientRect();
            return {
              dir: doc.dir, scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth,
              offscreen: controls.filter((r) => r.right > doc.clientWidth + 1 || r.left < -1).length,
              chip: chipBox ? { left: chipBox.left, right: chipBox.right } : null,
            };
          });
          expect(m.dir, path).toBe(lang === 'ar' ? 'rtl' : 'ltr');
          expect(m.scrollWidth, `${path} scrolls sideways with the chip`).toBeLessThanOrEqual(m.clientWidth);
          expect(m.offscreen, `${path}: top-bar controls off screen`).toBe(0);
          expect(m.chip!.left).toBeGreaterThanOrEqual(0);
          expect(m.chip!.right).toBeLessThanOrEqual(m.clientWidth);
        }
      });
    }
  });
}
