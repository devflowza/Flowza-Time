#!/usr/bin/env node
// Role walk: signs in as every walk login (scripts/role-walk/walk-users.sql — each system role with and without an employee
// link, a role with no permission, single-key custom roles) and opens every tenant page of the web app, clicking through
// each page's tabs, against the REAL API. It reports what a member must never see because of their role:
//   - a request the page made that the API refused with 403 (a page, tab, card or picker the role's keys do not read);
//   - an error state with the API's wording ("Missing permission: …", "Please try again … request id …");
//   - a menu entry that leads to "Permission denied";
//   - an uncaught page error.
// Exit code 0 = nothing found, 1 = findings (listed, and written to scripts/role-walk/results/<run>.json), 100 = bad invocation.
// Node 22, no dependency of its own: Playwright comes from apps/web. See scripts/role-walk/README.md.
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true]; }));
const fail = (m) => { console.error(m); process.exit(100); };

const cfg = {
  db: typeof args.db === 'string' ? args.db : process.env.PGDATABASE || 'flowza_walk',
  pg: { host: process.env.PGHOST || '127.0.0.1', port: process.env.PGPORT || '54329', user: process.env.PGUSER || 'postgres' },
  api: String(args.api ?? 'http://127.0.0.1:4310/api/v1').replace(/\/$/, ''),
  web: String(args.web ?? 'http://localhost:5173').replace(/\/$/, ''),
  // the issuer the API verifies and the key supabase-js stores the session under; nothing has to listen there
  supabaseUrl: String(args['supabase-url'] ?? 'http://127.0.0.1:54399').replace(/\/$/, ''),
  secret: process.env.E2E_JWT_SECRET,
  concurrency: Number(args.concurrency ?? 6),
  chromium: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (typeof args.chromium === 'string' ? args.chromium : undefined),
};
if (!cfg.secret) fail('E2E_JWT_SECRET must be the SUPABASE_JWT_SECRET of the API under test (local mode mints HS256 tokens).');
if (!['127.0.0.1', 'localhost', '::1'].includes(cfg.pg.host)) fail(`the role walk writes logins into the database: local hosts only (PGHOST=${cfg.pg.host}).`);

const psql = (sql) => execFileSync('psql', ['-h', cfg.pg.host, '-p', cfg.pg.port, '-U', cfg.pg.user, '-d', cfg.db, '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-c', sql], { encoding: 'utf8' }).trim();
if (args.setup) execFileSync('psql', ['-h', cfg.pg.host, '-p', cfg.pg.port, '-U', cfg.pg.user, '-d', cfg.db, '-q', '-f', path.join(ROOT, 'scripts/role-walk/walk-users.sql')], { stdio: 'inherit' });

const ORG = '00000000-0000-4000-a000-000000000001';
const one = (sql) => psql(sql).split('\n')[0] || null;
const IDS = {
  // somebody nobody logs in as: a stranger to every walk login (another branch for the branch manager, not a report of any manager)
  employee: one(`select e.id from public.employees e join public.branches b on b.id = e.branch_id where e.organization_id = '${ORG}' and b.code = 'MCT-HQ' and e.deleted_at is null and not exists (select 1 from public.org_memberships m where m.employee_id = e.id) and not exists (select 1 from public.org_memberships m join public.user_profiles u on u.id = m.user_id where m.employee_id in (e.manager_employee_id, e.secondary_manager_employee_id) and u.email like 'walk.%') order by e.employee_number limit 1`),
  device: one(`select d.id from public.devices d join public.branches b on b.id = d.branch_id where d.organization_id = '${ORG}' and b.code = 'MCT-HQ' order by d.name limit 1`),
  syncJob: one(`select j.id from public.sync_jobs j join public.branches b on b.id = j.branch_id where j.organization_id = '${ORG}' and b.code = 'MCT-HQ' order by j.created_at desc limit 1`),
  approval: one(`select id from public.approval_requests where organization_id = '${ORG}' order by created_at desc limit 1`),
  role: '10000000-0000-0000-0000-000000000001',
};
const ROUTES = [
  '/', '/notifications', '/account/notifications', '/search?q=al',
  '/employees', '/employees/new', '/employees/import', '/employees/org-chart', IDS.employee && `/employees/${IDS.employee}`, '/employees/{self}',
  '/organization', '/users', `/users/roles/${IDS.role}`,
  '/settings/general', '/settings/dashboard', '/settings/regional', '/settings/attendance', '/settings/sync', '/settings/integrations',
  '/settings/reports', '/settings/notifications', '/settings/security', '/settings/subscription', '/settings/leave',
  '/audit', '/email-log',
  '/devices', '/devices/new', '/devices/groups', '/devices/pin-mapping', '/devices/unmapped-punches', '/devices/punch-log', IDS.device && `/devices/${IDS.device}`,
  '/sync', IDS.syncJob && `/sync/${IDS.syncJob}`, '/reconciliation',
  '/attendance', '/attendance/summary', '/attendance/unmatched', '/attendance/print', '/corrections',
  '/approvals', '/approvals/workflows', '/approvals/delegations', IDS.approval && `/approvals/requests/${IDS.approval}`,
  '/shifts', '/holidays', '/reports', '/payroll', '/leave',
  '/my', '/my/attendance', '/my/leave', '/my/profile', '/my/checkin', '/my/requests', '/my/shift', '/my/reports',
  '/team', '/attendance/notes', '/attendance/geofences', '/attendance/regularisations', '/attendance/policies', '/deployments', '/attendance/muster',
].filter(Boolean);
/** The API's own wording, or the generic error's — never on a screen because of a role. */
const RAW = /Missing permission|contact support with request id|Please try again|You do not have permission to perform|not a member of this organisation|outside your access scope|direct reports\./i;

const users = psql(`select u.id, u.email from public.user_profiles u join public.org_memberships m on m.user_id = u.id where m.organization_id = '${ORG}' and u.email like 'walk.%@albahja.example' order by u.email`)
  .split('\n').filter(Boolean).map((l) => { const [id, email] = l.split('\t'); return { id, email }; })
  .filter((u) => typeof args.users !== 'string' || args.users.split(',').some((x) => u.email === x || u.email.startsWith(`walk.${x}@`) || u.email.startsWith(`walk.${x}.`)));
if (users.length === 0) fail(`no walk logins in ${cfg.db}: run with --setup on a seeded local database (scripts/db-reset-local.sh --seed).`);
const routes = typeof args.routes === 'string' ? args.routes.split(',') : ROUTES;

const b64 = (v) => Buffer.from(v).toString('base64url');
function session(u) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64(JSON.stringify({ iss: `${cfg.supabaseUrl}/auth/v1`, aud: 'authenticated', sub: u.id, email: u.email, role: 'authenticated', aal: 'aal1', session_id: randomUUID(), iat: now, exp: now + 4 * 3600 }));
  const token = `${h}.${p}.${createHmac('sha256', cfg.secret).update(`${h}.${p}`).digest('base64url')}`;
  return { access_token: token, token_type: 'bearer', expires_in: 4 * 3600, expires_at: now + 4 * 3600, refresh_token: 'role-walk',
    user: { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [], created_at: '', updated_at: '' } };
}

// Playwright as apps/web has it; resolved from there, its CommonJS entry arrives as the default export of the import
const require = createRequire(path.join(ROOT, 'apps/web/package.json'));
const playwright = await import(pathToFileURL(require.resolve('@playwright/test')).href);
const { chromium } = playwright.chromium ? playwright : playwright.default;

async function settle(page, inflight, quietMs, maxMs) {
  const start = Date.now();
  let quietSince = Date.now();
  for (;;) {
    await page.waitForTimeout(100);
    if (inflight.size > 0) quietSince = Date.now();
    if (Date.now() - quietSince >= quietMs || Date.now() - start > maxMs) return;
  }
}

const snapshot = (page) => page.evaluate((rawSource) => {
  const raw = new RegExp(rawSource, 'i');
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const text = document.body.innerText;
  return {
    path: location.pathname + location.search,
    denied: /Permission denied/.test(text),
    rawText: [...new Set(text.split('\n').filter((line) => raw.test(line)).map((line) => line.trim().slice(0, 200)))],
    alerts: [...document.querySelectorAll('[role="alert"]')].filter(visible).map((el) => el.innerText.trim().replace(/\s+/g, ' ').slice(0, 200)).filter(Boolean),
  };
}, RAW.source);

async function walk(browser, u, results) {
  const s = session(u);
  const context = await browser.newContext({ locale: 'en-GB', timezoneId: 'Asia/Muscat', viewport: { width: 1366, height: 900 } });
  await context.addInitScript(([k, v]) => { localStorage.setItem(k, v); localStorage.setItem('flowza.locale', 'en'); }, [`sb-${new URL(cfg.supabaseUrl).hostname.split('.')[0]}-auth-token`, JSON.stringify(s)]);
  await context.route(`${cfg.supabaseUrl}/**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  const page = await context.newPage();
  const inflight = new Set();
  let refused = [];
  let pageErrors = [];
  // a page is settled when neither its data (API) nor its code (lazy page chunks from the web server) is still on the way
  page.on('request', (r) => { if (r.url().startsWith(cfg.api) || r.url().startsWith(cfg.web)) inflight.add(r); });
  page.on('requestfinished', (r) => inflight.delete(r));
  page.on('requestfailed', (r) => inflight.delete(r));
  page.on('response', async (res) => {
    if (!res.url().startsWith(cfg.api) || res.status() !== 403) return;
    let body = {};
    try { body = await res.json(); } catch { /* not JSON */ }
    refused.push(`${res.request().method()} ${res.url().replace(cfg.api, '').replace(/\/orgs\/[0-9a-f-]{36}/, '/orgs/:org')} → ${body.code ?? 403}: ${body.message ?? ''}`);
  });
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
  const me = await (await fetch(`${cfg.api}/me`, { headers: { authorization: `Bearer ${s.access_token}` } })).json().catch(() => ({}));
  const self = me.data?.memberships?.find((m) => m.organization.id === ORG)?.employeeId ?? null;
  let sidebar = [];
  let booted = false;
  for (const route of routes) {
    if (route.includes('{self}') && !self) continue;
    const target = route.replace('{self}', self ?? '');
    refused = []; pageErrors = [];
    const visit = { user: u.email, route, views: [] };
    try {
      if (!booted) {
        await page.goto(`${cfg.web}${target}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
        await page.waitForSelector('aside[aria-label="Primary"] a[href]', { timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(500);
        sidebar = await page.$$eval('aside[aria-label="Primary"] a[href]', (links) => links.map((a) => a.getAttribute('href')));
        booted = true;
      } else {
        // the way the menu navigates: no reload, the router reads the new location
        await page.evaluate((p) => { window.history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate', { state: {} })); }, target);
      }
      await page.waitForTimeout(150);
      await settle(page, inflight, 600, 20_000);
      visit.views.push({ view: 'page', ...(await snapshot(page)), refused, pageErrors });
      const labels = [];
      for (const tab of await page.locator('[role="tab"]').all()) if (await tab.isVisible().catch(() => false)) labels.push((await tab.innerText()).trim());
      for (const label of [...new Set(labels)].slice(0, 14)) {
        refused = []; pageErrors = [];
        const tab = page.locator('[role="tab"]', { hasText: label }).first();
        if (!(await tab.isVisible().catch(() => false))) continue;
        await tab.click({ timeout: 3_000 }).catch(() => {});
        await settle(page, inflight, 500, 12_000);
        visit.views.push({ view: `tab "${label}"`, ...(await snapshot(page)), refused, pageErrors });
      }
    } catch (e) { visit.error = String(e.message).slice(0, 200); }
    visit.inMenu = sidebar.includes(route.split('?')[0]);
    results.push(visit);
    process.stdout.write('.');
  }
  await context.close();
}

const browser = await chromium.launch({ headless: true, ...(cfg.chromium ? { executablePath: cfg.chromium } : {}) });
const results = [];
const queue = [...users];
await Promise.all(Array.from({ length: Math.min(cfg.concurrency, queue.length) }, async () => { for (let u = queue.shift(); u; u = queue.shift()) await walk(browser, u, results); }));
await browser.close();

const findings = [];
for (const v of results) {
  const who = v.user.replace('@albahja.example', '');
  if (v.error) findings.push(`${who} ${v.route}: the walk could not open the page (${v.error})`);
  for (const view of v.views) {
    for (const r of view.refused) findings.push(`${who} ${v.route} ${view.view}: the API refused ${r}`);
    for (const t of view.rawText) findings.push(`${who} ${v.route} ${view.view}: shows "${t}"`);
    for (const e of view.pageErrors) findings.push(`${who} ${v.route} ${view.view}: page error ${e}`);
  }
  if (v.inMenu && v.views[0]?.denied) findings.push(`${who} ${v.route}: the menu offers a page that answers "Permission denied"`);
}
const runId = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
mkdirSync(path.join(ROOT, 'scripts/role-walk/results'), { recursive: true });
const out = path.join(ROOT, 'scripts/role-walk/results', `${runId}.json`);
writeFileSync(out, JSON.stringify({ ids: IDS, users: users.map((u) => u.email), findings, results }, null, 1));
console.log(`\n${users.length} logins × ${routes.length} pages: ${results.length} visits, ${results.reduce((n, v) => n + v.views.length, 0)} views (pages and tabs), ${findings.length} finding(s) — ${path.relative(ROOT, out)}`);
for (const f of findings) console.log(`- ${f}`);
process.exit(findings.length ? 1 : 0);
