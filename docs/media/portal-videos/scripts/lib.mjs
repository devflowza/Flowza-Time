// FlowZa Time · portal videos · recording toolkit. Real screen recordings of the running product (Playwright + Chromium):
// a visible cursor that glides to what it clicks, a caption bar with the narration line, title / end cards, and per-scene
// timing synced to the narration clips (tts.py writes `$WORK/voice/<video>/manifest.json`). Each video script calls
// `const v = await startVideo('employee')`, then `await v.scene('id', async () => { … })`, then `await v.finish()`.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(path.resolve(process.env.REPO ?? process.cwd(), 'apps/web/package.json'));
const { chromium } = require('@playwright/test');

export const WEB = process.env.WEB_URL ?? 'http://localhost:4173';
export const WORK = process.env.WORK ?? path.join(process.env.HOME ?? '/tmp', '.cache/flowza-portal-videos');
export const PASSWORD = 'FlowZa-Demo-2026!';
const VIEWPORT = { width: 1440, height: 900 };
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const OVERLAY = `
(() => {
  const css = '#__fz_cursor{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transition:transform 40ms linear}' +
    '#__fz_cursor svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}' +
    '.__fz_ripple{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid rgba(16,185,129,.9);z-index:2147483646;pointer-events:none;animation:__fz_r .55s ease-out forwards}' +
    '@keyframes __fz_r{from{transform:scale(.35);opacity:1}to{transform:scale(1.5);opacity:0}}' +
    '#__fz_caption{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);max-width:1100px;padding:12px 22px;border-radius:14px;background:rgba(10,24,20,.86);color:#fff;' +
    'font:500 19px/1.45 Inter,system-ui,sans-serif;letter-spacing:.1px;text-align:center;z-index:2147483645;pointer-events:none;box-shadow:0 8px 30px rgba(0,0,0,.25);transition:opacity .25s}' +
    '#__fz_caption:empty{opacity:0}' +
    '#__fz_chip{position:fixed;left:50%;top:16px;transform:translateX(-50%);padding:6px 12px;border-radius:999px;background:#0f766e;color:#fff;font:600 13px Inter,system-ui,sans-serif;z-index:2147483645;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.18)}' +
    '#__fz_chip:empty{display:none}';
  const ensure = () => {
    if (!document.body || document.getElementById('__fz_cursor')) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const c = document.createElement('div'); c.id = '__fz_cursor';
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.4-3.4-6.9L4 19z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const p = window.__fz_pos || { x: -40, y: -40 }; c.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px)';
    document.body.appendChild(c);
    const cap = document.createElement('div'); cap.id = '__fz_caption'; cap.textContent = window.__fz_caption || ''; document.body.appendChild(cap);
    const chip = document.createElement('div'); chip.id = '__fz_chip'; chip.textContent = window.__fz_chip || ''; document.body.appendChild(chip);
  };
  document.addEventListener('mousemove', (e) => { window.__fz_pos = { x: e.clientX, y: e.clientY }; const c = document.getElementById('__fz_cursor'); if (c) c.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)'; }, true);
  document.addEventListener('mousedown', (e) => { const r = document.createElement('div'); r.className = '__fz_ripple'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; document.body.appendChild(r); setTimeout(() => r.remove(), 700); }, true);
  window.__fz_set = (cap, chip) => { window.__fz_caption = cap; window.__fz_chip = chip; ensure(); const a = document.getElementById('__fz_caption'); if (a) a.textContent = cap || ''; const b = document.getElementById('__fz_chip'); if (b) b.textContent = chip || ''; };
  new MutationObserver(ensure).observe(document, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', ensure);
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The element's box once it stops moving (the app's scroll container scrolls smoothly). */
async function settledBox(loc) {
  let prev = await loc.boundingBox();
  for (let i = 0; i < 15; i += 1) {
    await sleep(70);
    const next = await loc.boundingBox();
    if (prev && next && Math.abs(prev.x - next.x) < 0.5 && Math.abs(prev.y - next.y) < 0.5) return next;
    prev = next;
  }
  return prev;
}

function manifestOf(video) {
  const file = path.join(WORK, 'voice', video, 'manifest.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

/** Card markup: product mark, title, subtitle, bullet points (title / end cards between the app scenes). */
export function card({ eyebrow, title, subtitle, points = [], footer = 'FlowZa Time · People on time, business on track' }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;font-family:Inter,system-ui,sans-serif;background:radial-gradient(1200px 700px at 15% 0%,#14532d 0%,#0b1f19 55%,#07130f 100%);color:#ecfdf5}
  .wrap{height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 120px}
  .mark{display:flex;align-items:center;gap:14px;font-weight:700;font-size:26px;letter-spacing:.2px}
  .logo{width:46px;height:46px;border-radius:12px;background:#10b981;display:grid;place-items:center;color:#052e1f;font-weight:800;font-size:26px}
  .eyebrow{margin-top:54px;text-transform:uppercase;letter-spacing:3px;font-size:16px;color:#6ee7b7;font-weight:700}
  h1{margin:14px 0 10px;font-size:62px;line-height:1.05;letter-spacing:-1px;font-weight:800;max-width:1100px}
  .sub{font-size:24px;color:#a7f3d0;max-width:1050px;line-height:1.4}
  ul{margin:38px 0 0;padding:0;list-style:none;display:grid;grid-template-columns:1fr 1fr;gap:12px 48px;max-width:1150px}
  li{font-size:21px;color:#d1fae5;display:flex;gap:12px;align-items:flex-start}
  li:before{content:'';flex:none;width:9px;height:9px;margin-top:10px;border-radius:50%;background:#34d399}
  .foot{position:absolute;left:120px;bottom:48px;font-size:16px;color:#6ee7b7;opacity:.85}
  </style></head><body><div class="wrap"><div class="mark"><div class="logo">F</div>FlowZa Time</div>
  ${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ''}<h1>${title}</h1>${subtitle ? `<div class="sub">${subtitle}</div>` : ''}
  ${points.length ? `<ul>${points.map((p) => `<li>${p}</li>`).join('')}</ul>` : ''}</div><div class="foot">${footer}</div></body></html>`;
}

export async function startVideo(name, opts = {}) {
  const manifest = manifestOf(name);
  const outDir = path.join(WORK, 'raw', name);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const viewport = opts.viewport ?? VIEWPORT;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, recordVideo: { dir: outDir, size: viewport }, locale: 'en-GB', timezoneId: 'Asia/Muscat', colorScheme: 'light' });
  await ctx.addInitScript(OVERLAY);
  const page = await ctx.newPage();
  const t0 = Date.now();
  const timeline = [];
  let caption = ''; let chip = '';
  const apply = async () => { try { await page.evaluate(([c, h]) => window.__fz_set?.(c, h), [caption, chip]); } catch { /* navigating */ } };
  page.on('domcontentloaded', () => { void apply(); });

  const v = {
    page, ctx, manifest,
    /** Move the visible cursor smoothly to an element's centre (or a point) and click it. */
    async click(target, o = {}) {
      const loc = typeof target === 'string' ? page.locator(target).first() : target;
      await loc.waitFor({ state: 'visible', timeout: o.timeout ?? 15_000 });
      if (o.center) await loc.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
      else await loc.scrollIntoViewIfNeeded().catch(() => {});
      let box = await settledBox(loc);
      if (!box) throw new Error(`no box for ${target}`);
      let x = box.x + (o.dx ?? box.width / 2); let y = box.y + (o.dy ?? box.height / 2);
      await page.mouse.move(x, y, { steps: o.steps ?? 22 });
      await sleep(o.before ?? 180);
      // the layout may have moved under the cursor (a dialog re-centring as its content loads): aim again
      box = await settledBox(loc);
      if (box && (Math.abs(box.x + (o.dx ?? box.width / 2) - x) > 3 || Math.abs(box.y + (o.dy ?? box.height / 2) - y) > 3)) {
        x = box.x + (o.dx ?? box.width / 2); y = box.y + (o.dy ?? box.height / 2);
        await page.mouse.move(x, y, { steps: 10 });
        await sleep(150);
      }
      await page.mouse.down(); await sleep(70); await page.mouse.up();
      await sleep(o.after ?? 450);
    },
    async hover(target, o = {}) {
      const loc = typeof target === 'string' ? page.locator(target).first() : target;
      await loc.waitFor({ state: 'visible', timeout: 15_000 });
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      const box = await settledBox(loc);
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: o.steps ?? 22 });
      await sleep(o.after ?? 300);
    },
    async move(x, y, steps = 22) { await page.mouse.move(x, y, { steps }); },
    /** Click a field and type at a human pace. */
    async type(target, text, o = {}) {
      await v.click(target, { after: 150 });
      if (o.clear !== false) { await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.press('Backspace'); }
      await page.keyboard.type(text, { delay: o.delay ?? 38 });
      await sleep(o.after ?? 250);
    },
    async scroll(dy, steps = 8) {
      for (let i = 0; i < steps; i += 1) { await page.mouse.wheel(0, dy / steps); await sleep(45); }
      await sleep(350);
    },
    async goto(url) { await page.goto(url.startsWith('http') ? url : `${WEB}${url}`, { waitUntil: 'domcontentloaded' }); await v.settle(); },
    /** Wait for the SPA to finish its requests and skeletons. */
    async settle(ms = 600) {
      await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
      await page.waitForFunction(() => document.querySelectorAll('[data-slot="skeleton"], .animate-pulse').length === 0, null, { timeout: 8_000 }).catch(() => {});
      await sleep(ms);
    },
    hold: sleep,
    /** Close an open dialog / popover (scenes leave theirs open while the narration runs). */
    async closeOverlays() {
      for (let i = 0; i < 2; i += 1) {
        if (!(await page.locator('[role=dialog], [role=alertdialog], [role=listbox], [role=menu]').count())) return;
        await page.keyboard.press('Escape'); await sleep(350);
      }
    },
    /** A full-screen card (title / chapter / end) shown for at least its narration. */
    async card(id, html, o = {}) {
      await v.scene(id, async () => { await page.setContent(html, { waitUntil: 'load' }); await sleep(o.min ?? 1500); }, { caption: '', chip: '', pad: o.pad ?? 700 });
    },
    /**
     * One narrated scene: shows the caption, runs the actions, and lasts at least as long as the narration clip (+ pad). The
     * scene's start (ms from the first frame) goes into the timeline the muxer places the clip at.
     */
    async scene(id, fn, o = {}) {
      const clip = manifest[id];
      const start = Date.now() - t0;
      caption = o.caption ?? clip?.text ?? '';
      chip = o.chip ?? chip;
      await apply();
      timeline.push({ id, start, text: clip?.text ?? '', duration: clip?.duration ?? 0 });
      try { await fn(); } catch (err) {
        await page.screenshot({ path: path.join(outDir, `failed-${id}.png`) }).catch(() => {});
        console.error(`scene ${id} failed at ${page.url()} — screenshot ${path.join(outDir, `failed-${id}.png`)}`);
        throw err;
      }
      const needed = (clip ? clip.duration * 1000 : 0) + (o.pad ?? 500);
      const spent = Date.now() - t0 - start;
      if (spent < needed) await sleep(needed - spent);
    },
    setChip(text) { chip = text; return apply(); },
    async signIn(email, o = {}) {
      await v.goto('/auth/sign-in');
      await v.type('input[type=email]', email, { delay: o.delay ?? 28 });
      await v.type('input[type=password]', PASSWORD, { delay: 18 });
      await v.click(page.getByRole('button', { name: /sign in/i }));
      await page.waitForURL((u) => !u.pathname.startsWith('/auth/'), { timeout: 20_000 });
      await v.settle(800);
    },
    async finish() {
      const total = Date.now() - t0;
      const video = page.video();
      await ctx.close();
      await browser.close();
      const src = await video.path();
      const dest = path.join(outDir, `${name}.webm`);
      fs.renameSync(src, dest);
      fs.writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify({ name, total, scenes: timeline }, null, 2));
      console.log(`recorded ${name}: ${(total / 1000).toFixed(1)} s, ${timeline.length} scenes → ${dest}`);
    },
  };
  return v;
}
