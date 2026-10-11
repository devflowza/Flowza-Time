// usage: node still.mjs <video.html> <timings.json> <outdir> scene@t [scene@t ...]   (t in scene-local seconds or bN+x)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return createRequire(execSync('npm root -g').toString().trim() + '/')('playwright');
  }
})();
const [html, tp, outdir, ...shots] = process.argv.slice(2);
const timings = JSON.parse(fs.readFileSync(tp, 'utf8'));
fs.mkdirSync(outdir, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', (e) => console.error('pageerror', e.message));
await p.goto('file://' + path.resolve(html));
await p.evaluate(() => document.fonts.ready);
await p.evaluate((t) => window.__init(t), timings);
for (const s of shots) {
  const [id, expr] = s.split('@');
  const sc = timings.scenes.find((x) => x.id === id);
  const m = expr.match(/^b(\d+)([+-][\d.]+)?$/);
  const lt = m
    ? sc.beats[+m[1]].at + (m[2] ? parseFloat(m[2]) : 0)
    : expr === 'end'
      ? sc.dur - 0.05
      : parseFloat(expr);
  await p.evaluate((t) => window.seek(t), sc.start + lt);
  const f = path.join(outdir, `${id}_${expr.replace(/[^\w.]/g, '_')}.jpg`);
  await p.screenshot({ path: f, type: 'jpeg', quality: 80 });
  console.log(f);
}
await b.close();
