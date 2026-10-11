// Assembles the walkthrough page (one <section> per scene, in script.json order). usage: node build.mjs <out/video.html>
import fs from 'node:fs';
import * as s1 from './s1.mjs';
import * as s2 from './s2.mjs';
import * as s3 from './s3.mjs';

const here = (f) => new URL(f, import.meta.url);
const out = process.argv[2] || 'video.html';
const scenes = { ...s1, ...s2, ...s3 };
const order = JSON.parse(fs.readFileSync(here('script.json'), 'utf8')).scenes.map((s) => s.id);
const missing = order.filter((id) => !scenes[id]);
if (missing.length) throw new Error('no scene for ' + missing.join(', '));
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>FlowZa Time walkthrough</title><style>${fs.readFileSync(here('base.css'), 'utf8')}</style></head>
<body>${order.map((id) => scenes[id]()).join('\n')}<div id="progress"></div><script>${fs.readFileSync(here('engine.js'), 'utf8')}</script></body></html>`;
fs.writeFileSync(out, html);
console.log(out, (html.length / 1024).toFixed(0) + ' KB');
