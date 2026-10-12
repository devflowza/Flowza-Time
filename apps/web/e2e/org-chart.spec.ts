import { expect, test, type Page } from '@playwright/test';
import type { OrgChartNodeDto } from '@flowza/contracts';
import { BRANCH_A, installMockBackend, ORG_ID, page as pageOf, signInDirectly } from './support/mock-backend';

/**
 * Org chart (employees/org-chart): the chart opens level by level, mirrors in Arabic, takes a native drag-and-drop from the
 * Unassigned panel onto a card (confirmed, then one `assign_manager`), and `?focus=` opens the way down to a person.
 * Against the API double; the reporting-line rules themselves are covered by the API suite.
 */
const id = (n: number) => `0c0c0c0c-0c0c-4c0c-8c0c-${String(n).padStart(12, '0')}`;
const node = (n: number, name: string, extra: Partial<OrgChartNodeDto> = {}): OrgChartNodeDto => ({
  id: id(n), employeeNumber: String(5000 + n), displayName: name, displayNameAr: null, photoUrl: null, designationName: 'Officer', departmentName: 'Operations', branchId: BRANCH_A, branchName: 'Muscat HQ',
  employmentStatus: 'active', managerEmployeeId: null, secondaryManagerEmployeeId: null, secondaryManagerName: null, directReportCount: 0, ...extra,
});
// Salim ← Maryam (three engineers: a compact stack) · Khalid (Fatma ← Huda; Ahmed: a row) · Zainab (dotted line to Maryam)
const CEO = node(1, 'Salim Al Harthy', { designationName: 'Chief executive', directReportCount: 3 });
const CTO = node(2, 'Maryam Al Lawati', { designationName: 'Chief technology officer', managerEmployeeId: id(1), directReportCount: 3 });
const CFO = node(3, 'Khalid Al Balushi', { designationName: 'Chief financial officer', managerEmployeeId: id(1), directReportCount: 2 });
const HRM = node(4, 'Zainab Al Rashdi', { designationName: 'HR manager', managerEmployeeId: id(1), secondaryManagerEmployeeId: id(2), secondaryManagerName: 'Maryam Al Lawati' });
const ENGINEERS = [node(5, 'Aisha Al Hinai', { managerEmployeeId: id(2) }), node(6, 'Badr Al Saadi', { managerEmployeeId: id(2) }), node(7, 'Rashid Al Amri', { managerEmployeeId: id(2) })];
const ACC = node(8, 'Fatma Al Zadjali', { managerEmployeeId: id(3), directReportCount: 1 });
const AP = node(9, 'Ahmed Al Mahrouqi', { managerEmployeeId: id(3) });
const CLERK = node(10, 'Huda Al Siyabi', { managerEmployeeId: id(8) });
const UNASSIGNED = [node(11, 'Nasser Al Kindi'), node(12, 'Laila Al Farsi')];
const TEAMS: Record<string, OrgChartNodeDto[]> = { [id(1)]: [CTO, CFO, HRM], [id(2)]: ENGINEERS, [id(3)]: [ACC, AP], [id(8)]: [CLERK] };

async function openChart(page: Page, lang: 'en' | 'ar', path = '/employees/org-chart') {
  await page.addInitScript((l) => { window.localStorage.setItem('flowza.locale', l as string); }, lang);
  await signInDirectly(page);
  const posted: unknown[] = [];
  const backend = await installMockBackend(page, {
    get: {
      [`/orgs/${ORG_ID}/org-chart`]: (url: URL) => {
        const managerId = url.searchParams.get('managerId');
        if (managerId) return pageOf(TEAMS[managerId] ?? [], 1, 100);
        return url.searchParams.get('view') === 'unassigned' ? pageOf(UNASSIGNED, 1, 100) : pageOf([CEO], 1, 100);
      },
      [`/orgs/${ORG_ID}/org-chart/path/${CLERK.id}`]: { data: { employeeId: CLERK.id, placement: 'tree', ancestorIds: [id(1), id(3), id(8)] } },
    },
    post: { [`/orgs/${ORG_ID}/employees/bulk`]: (body) => { posted.push(body); return { body: { data: { updated: 1, employeeIds: [id(12)] } } }; } },
  });
  await page.goto(path);
  return { backend, posted };
}
const card = (page: Page, n: number) => page.getByTestId(`org-card-${id(n)}`);
/** The "N reports" toggle of a card (the menu trigger has aria-expanded too, but controls nothing while closed). */
const toggle = (page: Page, n: number) => card(page, n).locator('button[aria-controls^="org-children-"]');
const box = async (page: Page, n: number) => (await card(page, n).boundingBox())!;

for (const lang of ['en', 'ar'] as const) {
  test.describe(`Org chart (${lang})`, () => {
    test(`opens teams level by level, a row or a compact stack, mirrored in ${lang === 'ar' ? 'Arabic' : 'English'}`, async ({ page }) => {
      await openChart(page, lang);
      await expect(card(page, 1)).toBeVisible();
      await toggle(page, 1).click();
      await expect(card(page, 2)).toBeVisible();
      await toggle(page, 2).click();
      await toggle(page, 3).click();
      await expect(card(page, 5)).toBeVisible();
      await expect(card(page, 8)).toBeVisible();

      const [cto, cfo, hrm] = [await box(page, 2), await box(page, 3), await box(page, 4)];
      // a row reads in the language's direction: the first report on the start side
      if (lang === 'ar') expect(cto.x).toBeGreaterThan(cfo.x); else expect(cto.x).toBeLessThan(cfo.x);
      expect(Math.abs(cto.y - cfo.y)).toBeLessThan(2);
      expect(Math.abs(cfo.y - hrm.y)).toBeLessThan(2);
      // Maryam's engineers have no reports of their own: stacked in one column under her, not spread sideways
      const engineers = [await box(page, 5), await box(page, 6), await box(page, 7)];
      expect(Math.abs(engineers[0]!.x - engineers[2]!.x)).toBeLessThan(2);
      expect(engineers[1]!.y).toBeGreaterThan(engineers[0]!.y);
      // Khalid's team has a manager in it (Fatma): a row
      expect(Math.abs((await box(page, 8)).y - (await box(page, 9)).y)).toBeLessThan(2);
      await expect(card(page, 4)).toContainText(lang === 'ar' ? 'يتبع أيضاً لـ Maryam Al Lawati' : 'Also reports to Maryam Al Lawati');
      // the chart scrolls inside its own viewport, never the page sideways
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await expect(page.locator('html')).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
    });
  });
}

test('drag a person from Unassigned onto a card, confirm, and one assign_manager is sent', async ({ page }) => {
  const { posted } = await openChart(page, 'en');
  await expect(card(page, 1)).toBeVisible();
  await toggle(page, 1).click();
  await expect(card(page, 2)).toBeVisible();
  await page.getByRole('button', { name: /Unassigned/ }).click();
  const row = page.getByTestId(`unassigned-row-${id(12)}`);
  await expect(row).toBeVisible();
  await row.dragTo(card(page, 2));
  const dialog = page.getByRole('dialog', { name: 'Change manager?' });
  await expect(dialog).toContainText('Make Laila Al Farsi report to Maryam Al Lawati.');
  await dialog.getByRole('button', { name: 'Change manager' }).click();
  await expect(page.getByText('1 employees updated')).toBeVisible();
  expect(posted).toEqual([{ action: 'assign_manager', employeeIds: [id(12)], managerEmployeeId: id(2), line: 'primary', effectiveFrom: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }]);
});

test('?focus= opens every manager above the person and brings their card into the chart\'s viewport', async ({ page }) => {
  await openChart(page, 'en', `/employees/org-chart?focus=${CLERK.id}`);
  const clerk = card(page, 10);
  await expect(clerk).toBeVisible();
  await expect(clerk).toHaveAttribute('data-focused', 'true');
  await expect(toggle(page, 1)).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle(page, 3)).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle(page, 8)).toHaveAttribute('aria-expanded', 'true');
  await expect(clerk.getByRole('link', { name: 'Huda Al Siyabi' })).toBeFocused();
  const canvas = (await page.getByTestId('org-chart-canvas').boundingBox())!;
  await expect.poll(async () => { const b = (await clerk.boundingBox())!; return b.y >= canvas.y && b.y + b.height <= canvas.y + canvas.height; }).toBe(true);
});
