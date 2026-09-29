import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  APPROVAL_ID, EMAIL_TOKEN, HQ_FENCE, PORTAL_EMPLOYEE_ID, approvalsHandlers, devicesPunchesHandlers, financeIntegrationHandlers, hrNotesHandlers, hrWorkspaceHandlers, installMockBackend, meFixture, portalRequestsHandlers,
  signInDirectly, teamHandlers, type MockBackendOptions,
} from './support/mock-backend';
import { walkGetHandlers } from './support/walk-fixtures';

/**
 * Manual-style UI walk (HR portal Prompt 11). Opt-in: E2E_UI_WALK=1 (chromium project only). Every page the HR portal added is
 * opened in English and Arabic at 1280×800 and 390×844, screenshotted into scripts/e2e-hosted/results/screens/ (gitignored),
 * and checked for: the page scrolling sideways (and which elements stick out), raw i18n keys, English UI strings in the Arabic
 * rendering (text equal to an English locale string that has an Arabic translation), buttons whose label is cut off, and — in
 * Arabic — tab strips, selects and menus laid out left to right (a Radix root that fell back to 'ltr').
 * Findings are written to screens/ui-walk.json; the test fails when there is any.
 */
interface WalkPage { slug: string; path: string; handlers?: () => Partial<MockBackendOptions>; ready?: string }
const merge = (...parts: Array<Partial<MockBackendOptions>>): Partial<MockBackendOptions> => ({
  get: Object.assign({}, ...parts.map((p) => p.get ?? {})), post: Object.assign({}, ...parts.map((p) => p.post ?? {})),
  put: Object.assign({}, ...parts.map((p) => p.put ?? {})), del: Object.assign({}, ...parts.map((p) => p.del ?? {})),
});
const PAGES: WalkPage[] = [
  { slug: 'portal-home', path: '/my' },
  { slug: 'portal-attendance', path: '/my/attendance' },
  { slug: 'portal-leave', path: '/my/leave' },
  { slug: 'portal-profile', path: '/my/profile' },
  { slug: 'portal-checkin', path: '/my/checkin' },
  { slug: 'portal-requests', path: '/my/requests', handlers: portalRequestsHandlers },
  { slug: 'portal-requests-regularisations', path: '/my/requests?tab=regularisations', handlers: portalRequestsHandlers },
  { slug: 'portal-shift', path: '/my/shift' },
  { slug: 'team', path: '/team', handlers: teamHandlers },
  { slug: 'hr-calendar', path: '/attendance', handlers: hrWorkspaceHandlers },
  { slug: 'hr-summary', path: '/attendance/summary', handlers: hrWorkspaceHandlers },
  { slug: 'hr-notes', path: '/attendance/notes?scope=all', handlers: hrNotesHandlers },
  { slug: 'hr-notes-selfies', path: '/attendance/notes?tab=selfies' },
  { slug: 'hr-notes-report', path: '/attendance/notes?tab=report' },
  { slug: 'hr-geofences', path: '/attendance/geofences' },
  { slug: 'hr-regularisations', path: '/attendance/regularisations' },
  { slug: 'hr-leave', path: '/leave' },
  { slug: 'approvals-inbox', path: '/approvals', handlers: approvalsHandlers },
  { slug: 'approvals-request', path: `/approvals/requests/${APPROVAL_ID}`, handlers: approvalsHandlers },
  { slug: 'approvals-workflows', path: '/approvals/workflows', handlers: approvalsHandlers },
  { slug: 'approvals-delegations', path: '/approvals/delegations', handlers: approvalsHandlers },
  { slug: 'approvals-email-action', path: `/approvals/email-action?token=${EMAIL_TOKEN}&action=APPROVE`, handlers: approvalsHandlers },
  { slug: 'settings-integrations', path: '/settings/integrations', handlers: financeIntegrationHandlers },
  { slug: 'settings-notifications', path: '/settings/notifications' },
  { slug: 'settings-leave', path: '/settings/leave' },
  { slug: 'settings-reports', path: '/settings/reports' },
  { slug: 'reports', path: '/reports' },
  { slug: 'devices', path: '/devices', handlers: devicesPunchesHandlers },
  { slug: 'devices-pin-mapping', path: '/devices/pin-mapping', handlers: devicesPunchesHandlers },
  { slug: 'devices-unmapped-punches', path: '/devices/unmapped-punches', handlers: devicesPunchesHandlers },
  { slug: 'devices-punch-log', path: '/devices/punch-log', handlers: devicesPunchesHandlers },
  { slug: 'notifications', path: '/notifications' },
];
const VIEWPORTS = [{ width: 1280, height: 800 }, { width: 390, height: 844 }] as const;
const LANGS = ['en', 'ar'] as const;

interface Finding { page: string; lang: string; viewport: string; kind: 'overflow' | 'raw_key' | 'untranslated' | 'clipped_button' | 'ltr_widget' | 'page_error'; detail: string }

/**
 * Names the fixtures give to organisation data (a role, a department) that happen to equal an English UI string: they are the
 * organisation's own words, shown as typed in every language, not untranslated labels.
 */
const FIXTURE_DATA = new Set(['Owner', 'Operations']);

/** English UI strings that have an Arabic translation: seen verbatim on an Arabic page, they were not translated. */
function englishOnlyStrings(localesDir: string): Set<string> {
  const flatten = (o: unknown, out: string[] = []): string[] => {
    if (typeof o === 'string') out.push(o);
    else if (o && typeof o === 'object') for (const v of Object.values(o)) flatten(v, out);
    return out;
  };
  const read = (lang: string) => new Set(readdirSync(path.join(localesDir, lang)).filter((f) => f.endsWith('.json')).flatMap((f) => flatten(JSON.parse(readFileSync(path.join(localesDir, lang, f), 'utf8')))));
  const en = read('en');
  const ar = read('ar');
  // strings with interpolation are matched by their fixed part elsewhere; brand names and codes are the same in both languages
  return new Set([...en].filter((s) => !ar.has(s) && !s.includes('{{') && /[A-Za-z]{3}/.test(s) && s.trim().length >= 4 && !/^(FlowZa|Flowza)/.test(s)));
}

async function inspect(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const vw = doc.clientWidth;
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0; };
    const inScroller = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (['auto', 'scroll', 'hidden', 'clip'].includes(cs.overflowX) && p.getBoundingClientRect().right <= vw + 1) return true;
      }
      return false;
    };
    const label = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.getAttribute('data-testid') ? `[data-testid=${el.getAttribute('data-testid')}]` : ''} "${(el.textContent ?? '').trim().slice(0, 40)}"`;
    const offenders: string[] = [];
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > vw + 1 || r.left < -1) && visible(el) && !inScroller(el)) offenders.push(`${label(el)} ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
    const texts: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = (n.textContent ?? '').trim();
      if (t && n.parentElement && visible(n.parentElement) && !['SCRIPT', 'STYLE'].includes(n.parentElement.tagName)) texts.push(t);
    }
    for (const el of Array.from(document.querySelectorAll('[placeholder], [aria-label], [title]'))) {
      if (!visible(el)) continue;
      for (const a of ['placeholder', 'aria-label', 'title']) { const v = el.getAttribute(a); if (v) texts.push(v.trim()); }
    }
    const clipped: string[] = [];
    for (const el of Array.from(document.querySelectorAll('button, [role="button"], a[class*="btn"]'))) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const cut = el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible';
      const off = (r.right > vw + 1 || r.left < -1) && !inScroller(el);
      if (cut || off) clipped.push(`${label(el)}${cut ? ` content ${el.scrollWidth}>${el.clientWidth}` : ''}${off ? ` at ${Math.round(r.left)}..${Math.round(r.right)}` : ''}`);
    }
    // widgets that lay out by direction (tab strips, selects, menus) whose nearest dir says ltr: a Radix root that fell back to 'ltr'
    const widgets = Array.from(document.querySelectorAll('[role="tablist"], [role="combobox"], [role="menu"], [role="listbox"]')).filter(visible);
    const ltrWidgets = widgets.filter((el) => el.closest('[dir]')?.getAttribute('dir') === 'ltr').map(label);
    return { dir: doc.dir, scrollWidth: doc.scrollWidth, vw, offenders: offenders.slice(0, 8), texts, clipped, ltrWidgets, widgetCount: widgets.length };
  });
}

test.describe('UI walk (E2E_UI_WALK=1)', () => {
  test.skip(!process.env.E2E_UI_WALK, 'opt-in: set E2E_UI_WALK=1');
  test.setTimeout(20 * 60_000);

  test('every new page in en and ar at 1280×800 and 390×844', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'one browser project is enough');
    const screens = path.resolve(testInfo.project.testDir, '../../../scripts/e2e-hosted/results/screens');
    mkdirSync(screens, { recursive: true });
    const englishOnly = englishOnlyStrings(path.resolve(testInfo.project.testDir, '../src/locales'));
    const findings: Finding[] = [];
    const visited: Array<{ page: string; lang: string; viewport: string; file: string; unmatched: string[]; directionWidgets: number }> = [];
    for (const lang of LANGS) {
      for (const vp of VIEWPORTS) {
        for (const p of PAGES) await walkOne(browser, p, lang, vp, screens, englishOnly, findings, visited);
      }
    }
    writeFileSync(path.join(screens, 'ui-walk.json'), JSON.stringify({ at: new Date().toISOString(), pages: visited, findings }, null, 2));
    console.warn(`UI walk: ${visited.length} screenshots in ${screens}; ${findings.length} finding(s)`);
    for (const f of findings) console.warn(`  [${f.kind}] ${f.page} ${f.lang} ${f.viewport}: ${f.detail}`);
    expect(findings, 'UI walk findings (see screens/ui-walk.json)').toEqual([]);
  });
});

async function walkOne(browser: Browser, p: WalkPage, lang: 'en' | 'ar', vp: { width: number; height: number }, screens: string, englishOnly: Set<string>, findings: Finding[], visited: Array<{ page: string; lang: string; viewport: string; file: string; unmatched: string[]; directionWidgets: number }>) {
  const viewport = `${vp.width}x${vp.height}`;
  const context = await browser.newContext({ viewport: vp, locale: 'en-GB', timezoneId: 'Asia/Muscat', geolocation: { latitude: HQ_FENCE.latitude, longitude: HQ_FENCE.longitude, accuracy: 15 }, permissions: ['geolocation'] });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((l) => { window.localStorage.setItem('flowza.locale', l as string); }, lang);
  await signInDirectly(page);
  const extra = p.handlers ? p.handlers() : {};
  const h = merge({ get: walkGetHandlers() }, extra);
  const backend = await installMockBackend(page, { me: meFixture({ employeeId: PORTAL_EMPLOYEE_ID, isManager: true, teamSize: 2 }), get: h.get, post: h.post, put: h.put, del: h.del });
  await page.goto(p.path);
  await page.locator('h1').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(300); // charts and lazy sections settle
  const file = `${lang}-${viewport}-${p.slug}.png`;
  await page.screenshot({ path: path.join(screens, file), fullPage: true });
  const m = await inspect(page);
  const at = { page: p.slug, lang, viewport };
  if (m.dir !== (lang === 'ar' ? 'rtl' : 'ltr')) findings.push({ ...at, kind: 'page_error', detail: `document dir ${m.dir}` });
  if (m.scrollWidth > m.vw + 1) findings.push({ ...at, kind: 'overflow', detail: `page ${m.scrollWidth}px wide in a ${m.vw}px viewport; ${m.offenders.join(' | ')}` });
  const rawKey = /^([a-z][a-zA-Z0-9-]*:)?[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;
  for (const t of new Set(m.texts)) {
    if (rawKey.test(t) && !/^[a-z0-9.-]+\.(com|ai|example|local|invalid|om|io|org|net)$/.test(t)) findings.push({ ...at, kind: 'raw_key', detail: t });
    if (lang === 'ar' && englishOnly.has(t) && !FIXTURE_DATA.has(t)) findings.push({ ...at, kind: 'untranslated', detail: t });
  }
  for (const c of m.clipped) findings.push({ ...at, kind: 'clipped_button', detail: c });
  if (lang === 'ar') for (const w of new Set(m.ltrWidgets)) findings.push({ ...at, kind: 'ltr_widget', detail: w });
  for (const e of errors) findings.push({ ...at, kind: 'page_error', detail: e.slice(0, 200) });
  // directionWidgets: how many tab strips / selects / menus the direction check looked at (a positive control: 0 everywhere
  // would mean the check had nothing to examine)
  visited.push({ ...at, file, unmatched: [...new Set(backend.unmatched)], directionWidgets: m.widgetCount });
  await context.close();
}
