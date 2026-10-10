// usage: node render.mjs <video.html> <timings.json> <out.mp4> [fps=30] [workers=3] [only=sceneId]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
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
const [html, timingsPath, out, fpsArg, wArg, only] = process.argv.slice(2);
const fps = +(fpsArg || 30),
  W = +(wArg || 3);
const timings = JSON.parse(fs.readFileSync(timingsPath, 'utf8'));
let t0 = 0,
  t1 = timings.total;
if (only) {
  const s = timings.scenes.find((s) => s.id === only);
  t0 = s.start;
  t1 = s.start + s.dur;
}
const frames = Math.round((t1 - t0) * fps);
const per = Math.ceil(frames / W);
const dir = path.dirname(out);
const browser = await chromium.launch({
  args: ['--font-render-hinting=none', '--disable-lcd-text'],
});
const segs = [];
const started = Date.now();
await Promise.all(
  Array.from({ length: W }, async (_, w) => {
    const a = w * per,
      b = Math.min(frames, a + per);
    if (a >= b) return;
    const seg = path.join(dir, `seg_${w}.mp4`);
    segs[w] = seg;
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });
    page.on('pageerror', (e) => {
      console.error('pageerror', e);
      process.exit(1);
    });
    await page.goto('file://' + path.resolve(html));
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate((t) => window.__init(t), timings);
    const cdp = await page.context().newCDPSession(page);
    const ff = spawn(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'image2pipe',
        '-framerate',
        String(fps),
        '-c:v',
        'mjpeg',
        '-i',
        '-',
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        '19',
        '-pix_fmt',
        'yuv420p',
        '-r',
        String(fps),
        seg,
      ],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    );
    for (let i = a; i < b; i++) {
      await page.evaluate(
        (t) =>
          new Promise((r) => {
            window.seek(t);
            requestAnimationFrame(() => r());
          }),
        t0 + i / fps,
      );
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 94,
        optimizeForSpeed: true,
      });
      if (!ff.stdin.write(Buffer.from(data, 'base64')))
        await new Promise((r) => ff.stdin.once('drain', r));
      if (w === 0 && i % (fps * 10) === 0)
        console.log(
          `  w0 ${i - a}/${b - a} frames, ${((Date.now() - started) / 1000).toFixed(0)}s`,
        );
    }
    ff.stdin.end();
    await new Promise((r, j) =>
      ff.on('close', (c) => (c === 0 ? r() : j(new Error('ffmpeg ' + c)))),
    );
    await page.close();
  }),
);
await browser.close();
const list = path.join(dir, 'segs.txt');
fs.writeFileSync(
  list,
  segs
    .filter(Boolean)
    .map((s) => `file '${path.resolve(s)}'`)
    .join('\n'),
);
await new Promise((r, j) =>
  spawn(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out],
    { stdio: 'inherit' },
  ).on('close', (c) => (c === 0 ? r() : j(new Error('concat ' + c)))),
);
console.log(
  `rendered ${frames} frames in ${((Date.now() - started) / 1000).toFixed(0)}s -> ${out}`,
);
