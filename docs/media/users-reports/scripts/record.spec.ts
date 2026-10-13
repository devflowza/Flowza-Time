/**
 * Records the how-to video from the real web app (the production bundle, `pnpm run build:e2e`) driven by Playwright, with the
 * backend answered by the Majan Gulf demo world (world.ts) and the reports made by gen-reports.ts.
 *
 * Every narration line (script.json, voiced by tts.py) is a `line()`: its caption is shown, its actions run, and the line lasts
 * at least as long as its voice clip. Frames come from the CDP screencast with their capture times; the line start times are
 * logged, so make.sh can place each clip exactly where its line started on screen.
 *
 * Run by make.sh from apps/web/.media-gen/: WORK=<work dir> playwright test -c .media-gen/playwright.config.ts record
 */
import { test, type BrowserContext, type CDPSession, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORT_TYPE_DEFINITIONS } from '@flowza/contracts';
import { BRANCH_A, ORG_ID, installMockBackend, signInDirectly } from '../e2e/support/mock-backend';
import { BRANCHES, NOW, TODAY, createWorld, empId } from './world';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = process.env.WORK!;
const MEDIA = path.join(WORK, 'media');
const FRAMES = path.join(WORK, 'frames');
const SCRIPT = JSON.parse(fs.readFileSync(path.join(HERE, 'script.json'), 'utf8')) as { scenes: Array<{ id: string; title?: string; chapter?: string; beats: string[] }> };
const VOICE = JSON.parse(fs.readFileSync(path.join(WORK, 'beats.json'), 'utf8')) as Record<string, number[]>;
const GAP = 450; // ms of quiet after each line
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;

// ---------------------------------------------------------------------------------------------------------------- capture
class Screencast {
  frames: Array<{ t: number; wall: number; file: string }> = [];
  private session: CDPSession | null = null;
  private n = 0;
  page!: Page;
  async attach(page: Page) {
    if (this.session) { await this.session.send('Page.stopScreencast').catch(() => undefined); await this.session.detach().catch(() => undefined); }
    this.page = page;
    const s = await page.context().newCDPSession(page);
    this.session = s;
    s.on('Page.screencastFrame', (f) => {
      const file = path.join(FRAMES, `f${String(this.n++).padStart(6, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
      this.frames.push({ t: f.metadata.timestamp ?? now(), wall: now(), file });
      s.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
    });
    await s.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  }
  async stop() { await this.session?.send('Page.stopScreencast').catch(() => undefined); }
}

// ---------------------------------------------------------------------------------------------------------------- the stage
const cast = new Screencast();
let appPage: Page;
const lines: Array<{ scene: string; i: number; t: number; dur: number; text: string; wide: boolean }> = [];
const mouse = new Map<Page, { x: number; y: number }>();
const pg = () => cast.page;
const rec = (fn: string, ...args: unknown[]) => pg().evaluate(([f, a]) => (window as unknown as { __rec: Record<string, (...x: unknown[]) => void> }).__rec?.[f as string]?.(...(a as unknown[])), [fn, args] as const);
const caption = (text: string | null, wide = false) => rec('caption', text, wide);
const card = (spec: Record<string, unknown> | null) => rec('card', spec);

/** Bring an element into view by scrolling its own scroll container (the page scrolls inside #app-scroll, never the window). */
async function ensureVisible(target: Locator, smooth = true, upper = false) {
  await target.waitFor();
  const moved = await target.evaluate((el, [sm, up]) => {
    const r = el.getBoundingClientRect();
    let p = el.parentElement;
    while (p && !(/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight)) p = p.parentElement;
    if (!p) return false;
    const pr = p.getBoundingClientRect();
    // `upper`: a field that opens a list (or is typed into) sits in the upper half, clear of the caption at the bottom
    const bottom = up ? pr.top + pr.height * 0.5 : pr.bottom - 70;
    if (r.top >= pr.top + 70 && r.bottom <= bottom) return false;
    const want = up ? pr.height * 0.3 : (pr.height - r.height) / 2;
    p.scrollTo({ top: p.scrollTop + (r.top - pr.top) - want, behavior: sm ? 'smooth' : 'auto' });
    return true;
  }, [smooth, upper] as const);
  if (moved) await sleep(smooth ? 800 : 60);
  await pg().evaluate(() => { const d = document.scrollingElement; if (d && (d.scrollTop || d.scrollLeft)) { d.scrollTop = 0; d.scrollLeft = 0; } });
}
async function moveTo(target: Locator | { x: number; y: number }, ms = 650) {
  const p = pg();
  let to: { x: number; y: number };
  if ('x' in target) to = target;
  else {
    await ensureVisible(target);
    const b = (await target.boundingBox())!;
    to = { x: b.x + Math.min(b.width / 2, 60), y: b.y + b.height / 2 };
  }
  const from = mouse.get(p) ?? { x: 720, y: 460 };
  const steps = Math.max(8, Math.round(ms / 22));
  for (let i = 1; i <= steps; i += 1) {
    const k = i / steps;
    const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
    const x = from.x + (to.x - from.x) * e;
    const y = from.y + (to.y - from.y) * e;
    await p.mouse.move(x, y);
    await rec('cursor', x, y);
  }
  mouse.set(p, to);
}
async function click(target: Locator | { x: number; y: number }, ms?: number) {
  await moveTo(target, ms);
  await sleep(140);
  await rec('ripple');
  await pg().mouse.down();
  await sleep(70);
  await pg().mouse.up();
  await sleep(220);
}
async function type(target: Locator, text: string, delay = 55) {
  await ensureVisible(target, true, true);
  await click(target);
  await target.pressSequentially(text, { delay });
  await sleep(180);
}
async function pick(trigger: Locator, option: string | RegExp, search?: string, pace: 'normal' | 'fast' = 'normal') {
  const fast = pace === 'fast';
  await ensureVisible(trigger, true, true);
  await click(trigger, fast ? 420 : undefined);
  if (search) { await sleep(fast ? 150 : 250); await pg().keyboard.type(search, { delay: fast ? 35 : 60 }); await sleep(fast ? 350 : 450); }
  const opt = pg().getByRole('option', { name: option }).first();
  await opt.waitFor();
  await click(opt, fast ? 320 : 420);
}
async function spot(target: Locator | null, tag?: string) {
  if (!target) return rec('spot', null);
  const b = (await target.boundingBox())!;
  return rec('spot', { x: b.x, y: b.y, width: b.width, height: b.height }, tag);
}
async function scrollTo(target: Locator) {
  await ensureVisible(target);
}

/** One narration line: caption on, actions run, and it lasts at least as long as its voice clip (+ a short pause). */
type Cue = (phrase: string, after?: string) => Promise<void>;
async function line(scene: string, i: number, act?: (cue: Cue, at: (s: number) => Promise<void>) => Promise<unknown>, opts: { wide?: boolean } = {}) {
  const text = SCRIPT.scenes.find((s) => s.id === scene)!.beats[i]!;
  const dur = VOICE[scene]![i]!;
  const t = now();
  // in the report tab (no sidebar) the caption sits centred, under the area the camera frames
  const wide = !!opts.wide || cast.page !== appPage;
  lines.push({ scene, i, t, dur, text, wide });
  await caption(text, wide);
  const at = async (s: number) => { const wait = t + s - now(); if (wait > 0) await sleep(wait * 1000); };
  // when the voice reaches a phrase: speech runs at an even pace, so its share of the text is its share of the clip
  const cue: Cue = (phrase, after) => {
    const k = text.indexOf(phrase, after ? text.indexOf(after) : 0);
    if (k < 0) throw new Error(`cue "${phrase}" is not in ${scene} ${i}`);
    return at(Math.max(0, dur * (k / text.length) - 0.15));
  };
  if (act) await act(cue, at);
  await at(dur + GAP / 1000);
}
async function chapter(scene: string, under?: () => Promise<unknown>) {
  const s = SCRIPT.scenes.find((x) => x.id === scene)!;
  await caption(null);
  await spot(null);
  const [kicker, title] = s.chapter!.split(' · ');
  await card({ kicker: `Part ${kicker}`, title });
  await sleep(600);
  if (under) await under();
  await sleep(1300);
  await card(null);
  await sleep(700);
}

// ---------------------------------------------------------------------------------------------------------------- report viewer
type Word = { p: number; x: number; y: number; w: number; h: number; t: string };
type Rect = { x: number; y: number; w: number; h: number };
const union = (rs: Rect[]): Rect => { const x0 = Math.min(...rs.map((r) => r.x)); const y0 = Math.min(...rs.map((r) => r.y)); const x1 = Math.max(...rs.map((r) => r.x + r.w)); const y1 = Math.max(...rs.map((r) => r.y + r.h)); return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; };
class Layout {
  words: Word[];
  constructor(key: string) { this.words = JSON.parse(fs.readFileSync(path.join(MEDIA, `${key}.words.json`), 'utf8')); }
  /** the last place a word is printed (its page varies with the font and the data) */
  last(t: string) { const w = this.words.filter((x) => x.t === t).at(-1); if (!w) throw new Error(`no word ${t}`); return w; }
  get pages() { return Math.max(...this.words.map((w) => w.p)) + 1; }
  word(p: number, t: string, after = 0) { const w = this.words.find((x) => x.p === p && x.t === t && x.y >= after); if (!w) throw new Error(`no word ${t} on page ${p}`); return w; }
  /** header labels of the day table on page p → their rects */
  header(p: number, labels: string[]) {
    const date = this.words.find((w) => w.p === p && w.t === 'Date' && this.words.some((x) => x.p === p && x.t === 'UT' && Math.abs(x.y - w.y) < 2))!;
    const line = this.words.filter((w) => w.p === p && Math.abs(w.y - date.y) < 2).sort((a, b) => a.x - b.x);
    const out = new Map<string, Rect>();
    let i = 0;
    for (const label of labels) {
      const parts = label.split(' ');
      while (i < line.length && line[i]!.t !== parts[0]) i += 1;
      out.set(label, union(line.slice(i, i + parts.length)));
      i += parts.length;
    }
    return { y: date.y, h: date.h, labels: out, right: Math.max(...line.map((w) => w.x + w.w)), left: date.x };
  }
  /** each body word on page p (between y0 and y1) goes to the nearest header label; a column is its label plus its words */
  columns(p: number, labels: string[], y1: number) {
    const hd = this.header(p, labels);
    const cols = new Map<string, Rect[]>([...hd.labels].map(([k, r]) => [k, [r]]));
    for (const w of this.words.filter((x) => x.p === p && x.y > hd.y + 2 && x.y <= y1)) {
      // the weekday after each date belongs to the Date column
      if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.test(w.t) && hd.labels.has('Date')) { cols.get('Date')!.push(w); continue; }
      const cx = w.x + w.w / 2;
      let best = ''; let bestD = Infinity;
      for (const [k, r] of hd.labels) { const d = cx < r.x ? r.x - cx : cx > r.x + r.w ? cx - r.x - r.w : 0; if (d < bestD) { bestD = d; best = k; } }
      cols.get(best)!.push(w);
    }
    return { hd, col: (k: string) => union(cols.get(k)!) };
  }
  row(p: number, t: string, left: number, right: number) { const w = this.word(p, t.split(' ')[0]!); return { x: left, y: w.y - 1.2, w: right - left, h: w.h + 2.4 }; }
}
const cell = (col: Rect, row: Rect): Rect => ({ x: col.x, y: row.y, w: col.w, h: row.h });
const pad = (r: Rect, px: number, py = px): Rect => ({ x: r.x - px, y: r.y - py, w: r.w + 2 * px, h: r.h + 2 * py });
const viewer = (page: Page) => ({
  focus: (p: number, r: Rect, o: Record<string, unknown> = {}) => page.evaluate(([p, r, o]) => (window as never as { viewer: { focus: (...a: unknown[]) => void } }).viewer.focus(p, r, o), [p, r, o] as const),
  mark: (p: number, rs: Rect[], o: Record<string, unknown> = {}) => page.evaluate(([p, rs, o]) => (window as never as { viewer: { mark: (...a: unknown[]) => void } }).viewer.mark(p, rs, o), [p, rs, o] as const),
  clear: () => page.evaluate(() => (window as never as { viewer: { clear: () => void } }).viewer.clear()),
});

async function openReportTab(context: BrowserContext) {
  const p = pg();
  const frame = p.frameLocator('[data-testid="report-frame"]');
  await frame.locator('.page img').first().waitFor();
  const link = p.getByRole('link', { name: 'Open in a new tab' });
  const popupP = context.waitForEvent('page');
  await click(link);
  const tab = await popupP;
  await tab.waitForFunction(() => (window as never as { viewer?: { loaded?: boolean } }).viewer?.loaded === true);
  await cast.attach(tab);
  return tab;
}

// ---------------------------------------------------------------------------------------------------------------- data
const JOINERS = [
  { num: 'MG-2009', first: 'Hilal', last: 'Al Mamari', branch: 'SOH', dept: 'OPS', desig: 'TECH', joined: '2026-09-06' },
  { num: 'MG-6006', first: 'Sultan', last: 'Al Wahaibi', branch: 'DQM', dept: 'OPS', desig: 'TECH', joined: '2026-09-20' },
  { num: 'MG-3007', first: 'Noor', last: 'Al Shanfari', branch: 'SLL', dept: 'SALES', desig: 'SEX', joined: '2026-10-04' },
].map((j, i) => ({ ...j, gender: 'unspecified', nat: 'OM', email: `${j.first.toLowerCase()}.${j.last.toLowerCase().replace(/\s/g, '')}@majangulf.om`, phone: '', exit: null, status: 'active', type: 'full_time', manager: null, pin: String(9001 + i), card: `01000090${String(i + 1).padStart(2, '0')}` }));

function dashboard() {
  const summary = { date: TODAY, employees: 51, presentToday: 44, absent: 1, late: 3, onLeave: 4, earlyDeparture: 1, overtimeMinutes: 465, missingPunch: 2, devicesOnline: 9, devicesOffline: 0, devicesUnknown: 1, syncFailures24h: 0, pendingApprovals: 3 };
  const per = [[26, 23, 1, 1, 2, 1], [8, 7, 0, 1, 1, 0], [6, 5, 0, 0, 1, 0], [4, 3, 0, 1, 0, 0], [4, 3, 0, 0, 0, 1], [3, 3, 0, 0, 0, 0]];
  const branches = BRANCHES.map((b, i) => ({ branchId: b.id, branchCode: b.code, branchName: b.name, employees: per[i]![0], present: per[i]![1], absent: per[i]![2], late: per[i]![3], onLeave: per[i]![4], missingPunch: per[i]![5], devicesOnline: i === 0 ? 4 : 1, devicesOffline: 0 }));
  const trends = (url: URL) => {
    const out = [];
    for (let d = new Date(`${url.searchParams.get('from') ?? TODAY}T00:00:00Z`); d.toISOString().slice(0, 10) <= (url.searchParams.get('to') ?? TODAY); d.setUTCDate(d.getUTCDate() + 1)) {
      const dow = d.getUTCDay(); const off = dow === 5 || dow === 6; const n = d.getUTCDate();
      out.push({ date: d.toISOString().slice(0, 10), present: off ? 2 : 42 + (n % 5), absent: off ? 0 : n % 3 === 0 ? 2 : 1, late: off ? 0 : 2 + (n % 4), onLeave: off ? 0 : 3 + (n % 2), missingPunch: off ? 0 : n % 3, overtimeMinutes: off ? 240 : 300 + (n % 7) * 30 });
    }
    return { data: out };
  };
  return { [`/orgs/${ORG_ID}/dashboard/summary`]: { data: summary }, [`/orgs/${ORG_ID}/dashboard/branches`]: { data: branches }, [`/orgs/${ORG_ID}/dashboard/trends`]: trends };
}

// ---------------------------------------------------------------------------------------------------------------- the video
test('record the users and reports how-to', async ({ page, context }) => {
  test.setTimeout(45 * 60_000);
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  void BRANCH_A;

  const world = createWorld({ limit: 55 });
  const opts = world.options;
  Object.assign(opts.get!, dashboard(), {
    '/report-types': { data: REPORT_TYPE_DEFINITIONS.filter((d) => d.status === 'available').map((d) => ({ ...d, allowed: true })) },
  });
  // Majan Gulf's subscription without the Scheduled reports add-on: My reports sits right under the request panel
  opts.me!.memberships[0]!.modules = { report_schedules: false } as never;
  world.nextReport.push(
    { reportType: 'monthly_attendance', fileName: 'monthly_attendance-2026-10-13.pdf', viewer: 'monthly', rowCount: 150, bytes: fs.statSync(path.join(WORK, 'reports', 'monthly-attendance-detailed-2026-09.pdf')).size },
    { reportType: 'employee_attendance', fileName: 'employee_attendance-2026-10-13.pdf', viewer: 'yearly', rowCount: 365, bytes: fs.statSync(path.join(WORK, 'reports', 'detail-report-2025.pdf')).size },
  );

  await context.addInitScript({ path: path.join(HERE, 'overlay.js') });
  await page.clock.install({ time: NOW });
  await installMockBackend(page, opts);
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fallback();
    const url = new URL(req.url());
    let body: unknown; try { body = req.postDataJSON(); } catch { body = undefined; }
    const r = world.extra(req.method(), url.pathname.replace(/^.*\/api\/v1/, ''), url, body);
    if (!r) return route.fallback();
    return route.fulfill({ status: r.status ?? 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(r.body) });
  });
  await context.route('**/__media/**', (route) => route.fulfill({ path: path.join(MEDIA, path.basename(new URL(route.request().url()).pathname)) }));
  await context.route('**/storage/v1/object/sign/**', (route) => route.fulfill({ path: path.join(HERE, 'viewer.html'), contentType: 'text/html' }));
  await signInDirectly(page);
  cast.page = page;
  appPage = page;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await page.getByText('Majan Gulf').first().waitFor();
  await sleep(1500);
  const intro = SCRIPT.scenes.find((s) => s.id === 'intro')!;
  await card({ kicker: 'How-to guide', title: intro.title, items: ['Add a user', 'Remove a user and add a new one', 'Monthly Attendance Report (Detailed)', 'Detail Report for a whole year'] });
  await sleep(700);
  await cast.attach(page);
  await sleep(900);

  const nav = (name: string) => page.locator('nav').getByRole('link', { name, exact: true }).first();
  const users = process.env.START !== 'monthly';
  if (users) {
  // ---- intro
  await line('intro', 0, undefined, { wide: true });
  await card(null);
  await caption(null);
  await sleep(900);

  // ---- 1 · add a user
  await chapter('add');
  await line('add', 0, async () => { await sleep(1800); await moveTo(nav('Employees'), 900); });
  await line('add', 1, async (cue) => {
    await click(nav('Employees'));
    await page.getByRole('button', { name: 'Add employee' }).waitFor();
    await sleep(500);
    await spot(page.getByTestId('user-limit-banner'));
    await cue('choose Add employee');
    await spot(null);
    await click(page.getByRole('button', { name: 'Add employee' }));
    await page.locator('#emp-number').waitFor();
  });
  await line('add', 2, async () => {
    await type(page.locator('#emp-number'), 'MG-1027');
    await type(page.locator('#emp-first'), 'Rahma');
    await type(page.locator('#emp-last'), 'Al Jabri');
    await scrollTo(page.locator('#emp-email'));
    await type(page.locator('#emp-email'), 'rahma.aljabri@majangulf.om', 35);
  });
  await line('add', 3, async () => {
    await scrollTo(page.locator('#emp-joining'));
    await spot(page.locator('#emp-joining'));
    await sleep(1100);
    await spot(null);
    await pick(page.locator('#emp-branch'), /Head Office/);
    await pick(page.locator('#emp-dept'), 'Information Technology', 'Inform');
    await pick(page.locator('#emp-desig'), 'Software Engineer', 'Software');
    await pick(page.locator('#emp-manager'), /Arun Menon/, 'Arun');
  });
  await line('add', 4, async () => {
    await scrollTo(page.locator('#emp-card'));
    await spot(page.locator('#emp-device-id'));
    await sleep(2600);
    await spot(null);
    await type(page.locator('#emp-card'), '0100000027');
  });
  await line('add', 5, async () => {
    await click(page.getByRole('button', { name: 'Create employee' }));
    await page.getByRole('heading', { name: 'Rahma Al Jabri' }).waitFor();
  });

  // ---- 2 · remove a user and add a new one
  await chapter('replace', async () => {
    world.hire(JOINERS as never);
    await page.goto('/employees');
    await page.getByTestId('user-limit-banner').waitFor();
    mouse.set(page, { x: 980, y: 420 });
    await rec('cursor', 980, 420);
  });
  await line('replace', 0, async (cue) => {
    await sleep(400);
    await spot(page.getByTestId('user-limit-banner'));
    await cue('and Add employee');
    await spot(page.getByRole('button', { name: 'Add employee' }));
    await moveTo(page.getByRole('button', { name: 'Add employee' }), 800);
  });
  await spot(null);
  await line('replace', 1, async () => {
    await type(page.getByPlaceholder('Search number, name, email, device id…'), 'Deepa', 90);
    const row = page.locator('tr').filter({ hasText: 'Deepa Kumar' }).first();
    await row.waitFor();
    await sleep(500);
    await click(row.getByText('Deepa Kumar'));
    await page.getByRole('tab', { name: 'Danger zone' }).waitFor();
    await sleep(600);
    await click(page.getByRole('tab', { name: 'Danger zone' }));
  });
  await line('replace', 2, async () => {
    await click(page.getByRole('button', { name: 'Archive employee' }));
    const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog')).first();
    await dialog.waitFor();
    await sleep(400);
    await spot(page.locator('#dz-exit'));
    await sleep(1000);
    await spot(null);
    await type(page.locator('#dz-reason'), 'Resigned', 70);
    await click(dialog.getByRole('button', { name: 'Archive employee' }));
  });
  await line('replace', 3, async (cue) => {
    await page.getByRole('button', { name: 'Add employee' }).waitFor();
    await sleep(900);
    await cue('one user is free');
    await spot(page.getByTestId('user-limit-meter').first());
  });
  await spot(null);
  await line('replace', 4, async () => {
    await click(page.getByRole('button', { name: 'Add employee' }));
    await page.locator('#emp-number').waitFor();
    await type(page.locator('#emp-number'), 'MG-1028', 25);
    await type(page.locator('#emp-first'), 'Yousuf', 25);
    await type(page.locator('#emp-last'), 'Al Hashmi', 25);
    await type(page.locator('#emp-email'), 'yousuf.alhashmi@majangulf.om', 14);
  });
  await line('replace', 5, async () => {
    await pick(page.locator('#emp-branch'), /Head Office/, undefined, 'fast');
    await pick(page.locator('#emp-dept'), 'Customer Support', 'Custom', 'fast');
    await pick(page.locator('#emp-desig'), 'Customer Support Executive', 'Custom', 'fast');
    await pick(page.locator('#emp-manager'), /Faisal Al Rawahi/, 'Faisal', 'fast');
    await type(page.locator('#emp-card'), '0100000028', 20);
  });
  await line('replace', 6, async () => {
    await click(page.getByRole('button', { name: 'Create employee' }));
    await page.getByRole('heading', { name: 'Yousuf Al Hashmi' }).waitFor();
  });
  await line('replace', 7, async () => {
    await click(nav('Users & roles'));
    await page.getByRole('button', { name: 'Invite member' }).waitFor();
    await sleep(300);
    await click(page.getByRole('button', { name: 'Invite member' }));
    await page.locator('#inv-email').waitFor();
    await type(page.locator('#inv-email'), 'yousuf.alhashmi@majangulf.om', 14);
    await pick(page.locator('#inv-role'), /^Employee$/, undefined, 'fast');
    await pick(page.locator('#inv-emp'), /Yousuf Al Hashmi/, 'Yousuf', 'fast');
    await click(page.getByRole('button', { name: 'Create invitation' }));
    await page.getByText('Invitation created').waitFor();
    await sleep(1500);
    await click(page.getByRole('dialog').getByRole('button', { name: 'Close' }).last());
  });
  await line('replace', 8, async (cue) => {
    // the search puts Deepa Kumar's row at the top, clear of the caption
    const search = page.getByPlaceholder('Search name or email…');
    await type(search, 'Deepa', 70);
    const deepa = page.locator('tbody tr').filter({ hasText: 'Deepa Kumar' }).first();
    await deepa.waitFor();
    await sleep(500);
    await spot(deepa);
    await cue('To end another');
    await spot(null);
    await search.fill('');
    await page.locator('tbody tr').filter({ hasText: 'Aisha Al Rawahi' }).first().waitFor();
    await sleep(400);
    const aisha = page.locator('tbody tr').filter({ hasText: 'Aisha Al Rawahi' }).first();
    await click(aisha.getByRole('button').last());
    const suspend = page.getByRole('menuitem', { name: 'Suspend' });
    await suspend.waitFor();
    await moveTo(suspend, 450);
    await sleep(1500);
    await page.keyboard.press('Escape');
  });

  } else { await card(null); }

  // ---- 3 · monthly detailed report
  await chapter('monthly', async () => { await page.locator('#app-scroll').evaluate((el) => el.scrollTo(0, 0)).catch(() => undefined); });
  await line('monthly', 0, async () => {
    await click(nav('Reports'));
    const radio = page.getByRole('radio').filter({ hasText: 'Monthly Attendance Report' });
    await radio.waitFor();
    await sleep(600);
    await click(radio);
  });
  await line('monthly', 1, async () => {
    await scrollTo(page.locator('#rp-month'));
    await click(page.locator('#rp-month'));
    await page.locator('#rp-month').fill('2026-09');
    await page.keyboard.press('Tab');
    await sleep(500);
    await pick(page.locator('#rp-layout'), /^Detailed/);
  });
  await line('monthly', 2, async () => {
    await pick(page.locator('#rp-dept'), 'Information Technology', 'Inform');
    await spot(page.locator('#rp-format'));
    await sleep(1400);
    await spot(null);
    await click(page.getByRole('button', { name: 'Queue report' }));
  });
  await line('monthly', 3, async () => {
    const view = page.locator('tbody tr').first().getByRole('button', { name: 'View' });
    await scrollTo(page.getByRole('heading', { name: 'My reports' }));
    await view.waitFor({ timeout: 30_000 });
    await sleep(700);
    await click(view);
  });
  const monthlyTab = await (async () => {
    let tab!: Page;
    await line('monthly', 4, async (cue) => { await cue("Let's open"); tab = await openReportTab(context); });
    return tab;
  })();

  // ---- reading the monthly report (in the new tab)
  const m = new Layout('monthly');
  const MCOLS = ['Date', 'Att Code', 'IN Time', 'OUT Time', 'Wrk Hrs', 'Tot Hrs', 'Base Hrs', 'OT1', 'OT2', 'UT'];
  const totalW = m.word(0, 'Total', 140);
  const { hd: mh, col: mc } = m.columns(0, MCOLS, totalW.y + totalW.h);
  const L = mh.left, R = mh.right;
  const mrow = (d: string) => m.row(0, d, L, R);
  const v = viewer(monthlyTab);
  await sleep(600);
  const ident = union([m.word(0, 'Employee:'), m.word(0, 'Designation:'), m.word(0, 'Technology'), m.word(0, 'Days:')]);
  const identR = { x: L, y: ident.y, w: R - L, h: ident.h };
  const days = union(m.words.filter((w) => w.p === 0 && Math.abs(w.y - m.word(0, 'Days:').y) < 1 && w.x > m.word(0, 'Days:').x + 20));
  const top = { x: L, y: mh.y - 4, w: R - L, h: mrow('10-Sep-26 Thu').y + 12 - mh.y };
  await line('columns', 0, async () => { await v.focus(0, pad(identR, 6), { fill: 0.92 }); await sleep(1100); await v.mark(0, [union([m.word(0, 'Employee:'), m.word(0, 'Designation:'), m.word(0, 'Lead')]), union([m.word(0, 'Dept:'), m.word(0, 'Shift:'), m.word(0, '08:00–17:00'), m.word(0, 'Technology')])]); });
  await line('columns', 1, async () => { await v.mark(0, [days], { tag: 'Days', dim: true }); });
  await line('columns', 2, async () => { await v.focus(0, pad(top, 4), { fill: 0.95 }); await sleep(900); await v.mark(0, [mc('Date')], { tag: 'Date', dim: true }); });
  await line('columns', 3, async (cue) => {
    await v.mark(0, [mc('Att Code')], { tag: 'Att Code', dim: true });
    const code = (d: string) => cell(mc('Att Code'), mrow(d));
    await cue('PR present'); await v.mark(0, [code('01-Sep-26 Tue'), code('02-Sep-26 Wed'), code('03-Sep-26 Thu')], { tag: 'PR' });
    await cue('AB absent'); await v.focus(0, pad({ x: L, y: mh.y - 4, w: R - L, h: mrow('14-Sep-26 Mon').y + 12 - mh.y }, 4), { fill: 0.95 }); await v.mark(0, [code('14-Sep-26 Mon')], { tag: 'AB' });
    await cue('OF weekly'); await v.mark(0, [code('04-Sep-26 Fri'), code('05-Sep-26 Sat'), code('11-Sep-26 Fri'), code('12-Sep-26 Sat')], { tag: 'OF' });
    await cue('MP missed'); await v.mark(0, [code('07-Sep-26 Mon')], { tag: 'MP' });
    await cue('SL for'); await v.focus(0, pad({ x: L, y: mrow('11-Sep-26 Fri').y - 4, w: R - L, h: mrow('26-Sep-26 Sat').y - mrow('11-Sep-26 Fri').y + 14 }, 4), { fill: 0.95 }); await v.mark(0, [code('22-Sep-26 Tue')], { tag: 'SL' });
  });
  await line('columns', 4, async () => { await v.focus(0, pad(top, 4), { fill: 0.95 }); await v.mark(0, [mc('IN Time'), mc('OUT Time')], { tag: 'IN Time · OUT Time' }); });
  const r1 = mrow('01-Sep-26 Tue');
  await line('columns', 5, async (cue) => { await v.mark(0, [mc('Wrk Hrs')], { tag: 'Wrk Hrs', dim: true }); await cue('On the first'); await v.mark(0, [cell(union([mc('IN Time'), mc('OUT Time')]), r1), cell(mc('Wrk Hrs'), r1)], { tag: '7:52 am → 5:06 pm = 9:14' }); });
  await line('columns', 6, async (cue) => { await v.mark(0, [mc('Tot Hrs')], { tag: 'Tot Hrs', dim: true }); await cue('eight hours fourteen'); await v.mark(0, [cell(mc('Tot Hrs'), r1)], { tag: '8.14 = 8 h 14 min' }); });
  await line('columns', 7, async (cue) => { await v.mark(0, [mc('Base Hrs')], { tag: 'Base Hrs', dim: true }); await cue('Absences'); await v.mark(0, ['04-Sep-26 Fri', '05-Sep-26 Sat', '14-Sep-26 Mon'].map((d) => cell(mc('Base Hrs'), mrow(d))), { tag: 'none' }); });
  await line('columns', 8, async (cue) => { await v.mark(0, [mc('OT1')], { tag: 'OT1', dim: true }); await cue('leaving at seven'); const r3 = mrow('03-Sep-26 Thu'); await v.mark(0, [cell(mc('OUT Time'), r3), cell(mc('OT1'), r3)], { tag: 'out 7:18 pm → OT1 1.30' }); });
  await line('columns', 9, async (cue) => { await v.mark(0, [mc('OT2')], { tag: 'OT2', dim: true }); await cue('Saturday the fifth'); const r5 = mrow('05-Sep-26 Sat'); await v.mark(0, [cell(mc('Att Code'), r5), cell(mc('OT2'), r5)], { tag: 'OT2 3.56' }); });
  await line('columns', 10, async (cue) => {
    await v.mark(0, [mc('UT')], { tag: 'UT', dim: true });
    await cue('A late start'); const r2 = mrow('02-Sep-26 Wed'); await v.mark(0, [cell(mc('IN Time'), r2), cell(mc('Tot Hrs'), r2), cell(mc('UT'), r2)], { tag: '8.00 − 7.45 = UT 0.15' });
    await cue('the missed punch'); const r7 = mrow('07-Sep-26 Mon'); await v.mark(0, [cell(mc('Att Code'), r7), cell(mc('UT'), r7)], { tag: 'MP: UT 8.00' });
  });
  await line('columns', 11, async (cue) => {
    const tot = m.row(0, 'Total', L, R);
    await v.focus(0, pad({ x: L, y: mrow('20-Sep-26 Sun').y - 4, w: R - L, h: tot.y + tot.h - mrow('20-Sep-26 Sun').y + 8 }, 4), { fill: 0.95 });
    await sleep(900);
    await v.mark(0, [tot], { tag: 'Total', dim: true });
    await cue('The legend');
    const note = m.last('NOTE');
    const legend = union(m.words.filter((w) => w.p === note.p && w.y >= note.y - 1 && w.y < note.y + 30));
    await v.focus(note.p, pad(legend, 10), { fill: 0.9, ms: 1400 });
    await sleep(1300);
    await v.mark(note.p, [legend], { tag: 'Legend' });
  });
  await caption(null);
  await v.clear();
  await sleep(500);

  // ---- 4 · yearly detailed report (back in the app)
  await monthlyTab.close();
  await cast.attach(page);
  await chapter('yearly', async () => {
    await page.keyboard.press('Escape');
    await sleep(400);
    await ensureVisible(page.getByRole('radio').first(), false);
  });
  await line('yearly', 0, async () => {
    const radio = page.getByRole('radio', { name: /^Detail Report/ });
    await click(radio);
  });
  await line('yearly', 1, async () => {
    await scrollTo(page.locator('#rp-from'));
    await click(page.locator('#rp-from'));
    await page.locator('#rp-from').fill('2025-01-01');
    await sleep(700);
    await click(page.locator('#rp-to'));
    await page.locator('#rp-to').fill('2025-12-31');
    await sleep(700);
    await pick(page.locator('#rp-emps'), /Salim Al Hinai/, 'Salim');
  });
  await line('yearly', 2, async () => {
    await click(page.getByRole('button', { name: 'Queue report' }));
    // the new report is the first row of My reports; View appears once it is completed
    const view = page.locator('tbody tr').first().getByRole('button', { name: 'View' });
    await scrollTo(page.getByRole('heading', { name: 'My reports' }));
    await page.locator('tbody tr').first().getByText('Detail Report').waitFor();
    await view.waitFor({ timeout: 30_000 });
    await sleep(500);
    await click(view);
  });
  const y = new Layout('yearly');
  const YCOLS = ['Date', 'Att Code', 'IN Time', 'OUT Time', 'Base Hrs', 'Work Hrs', 'Tot Hrs', 'OT1', 'OT2', 'UT', 'Remarks'];
  const yLast = y.last('1870.16');
  // the table ends at the last date printed on the page (the page footer is not part of any column)
  const lastRow = Math.max(...y.words.filter((w) => w.p === 0 && /^\d\d-[A-Z][a-z]{2}-\d\d$/.test(w.t)).map((w) => w.y + w.h));
  const { hd: yh, col: yc } = y.columns(0, YCOLS, lastRow);
  const YR = 559;
  const yrow = (d: string) => y.row(0, d, yh.left, YR);
  let yearlyTab!: Page;
  await line('yearly', 3, async (cue) => {
    yearlyTab = await openReportTab(context);
    const yv = viewer(yearlyTab);
    await sleep(500);
    await cue('one row for every day');
    // the year at a glance: down through the pages, then back to January
    await yearlyTab.evaluate((p) => (window as never as { viewer: { focus: (...a: unknown[]) => void } }).viewer.focus(p, { x: 0, y: 0, w: 595, h: 842 }, { fill: 0.98, maxScale: 0.32, minScale: 0.15, ms: 1500 }), Math.floor((y.pages - 1) / 2));
    await sleep(2300);
    await yv.focus(0, pad({ x: yh.left, y: yh.y - 60, w: YR - yh.left, h: yrow('16-Jan-25 Thu').y - yh.y + 72 }, 4), { fill: 0.95, ms: 1300 });
  });
  const yv = viewer(yearlyTab);
  await line('yearly', 4, async (cue) => {
    for (const k of YCOLS.slice(0, 10)) { await cue(k === 'Date' ? 'Date,' : k === 'UT' ? 'and UT' : k, 'in this order'); await yv.mark(0, [yc(k)], { tag: k }); }
  });
  await line('yearly', 5, async (cue) => {
    await yv.mark(0, [yc('Work Hrs')], { tag: 'Work Hrs', dim: true });
    await cue('Public holidays');
    await yv.mark(0, [cell(yc('Att Code'), yrow('01-Jan-25 Wed'))], { tag: 'HL' });
  });
  await line('yearly', 6, async (cue) => {
    await yv.mark(0, [yc('Remarks')], { tag: 'Remarks', dim: true });
    await cue('like this forgotten');
    const r14 = yrow('14-Jan-25 Tue');
    await yv.mark(0, [r14], { tag: 'Forgot to punch out' });
  });
  await line('yearly', 7, async (cue) => {
    const tot = { x: yh.left, y: yLast.y - 1.5, w: YR - yh.left, h: yLast.h + 3 };
    await yv.focus(yLast.p, pad({ x: yh.left, y: tot.y - 40, w: YR - yh.left, h: 120 }, 4), { fill: 0.95, ms: 1500 });
    await sleep(1600);
    await yv.mark(yLast.p, [tot], { tag: 'Total for 2025', dim: true });
    void cue;
  });
  await caption(null);
  await yv.clear();

  // ---- outro
  await card({ kicker: 'Recap', title: 'Users and reports', items: ['Employees → Add employee', 'Danger zone → Archive employee', 'Monthly Attendance Report → Detailed', 'Detail Report → 1 Jan to 31 Dec'] });
  await sleep(900);
  await line('outro', 0, undefined, { wide: true });
  await caption(null);
  await sleep(1800);
  await cast.stop();

  fs.writeFileSync(path.join(WORK, 'recording.json'), JSON.stringify({ frames: cast.frames, lines, errors }, null, 1));
  if (errors.length) console.log('page errors:', errors);
  void empId;
});
