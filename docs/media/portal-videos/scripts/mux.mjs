// FlowZa Time · portal videos · mux: the recorded frames + the narration clips placed at their scene starts → MP4 (H.264 /
// AAC, loudness-normalised, captions track) and an .srt sidecar. Usage: node mux.mjs <video> <out.mp4>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const WORK = process.env.WORK ?? path.join(process.env.HOME ?? '/tmp', '.cache/flowza-portal-videos');
const [name, out] = process.argv.slice(2);
const dir = path.join(WORK, 'raw', name);
const { scenes, total } = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(WORK, 'voice', name, 'manifest.json'), 'utf8'));
// the recorder's first frame lands a little after t0: trim the head so the clips line up with what is on screen
const LEAD = Number(process.env.LEAD_MS ?? 120);
const clips = scenes.filter((s) => manifest[s.id]).map((s) => ({ ...s, file: manifest[s.id].file, duration: manifest[s.id].duration }));

const srtTime = (ms) => { const h = Math.floor(ms / 3.6e6); const m = Math.floor(ms / 6e4) % 60; const s = Math.floor(ms / 1000) % 60; const f = Math.floor(ms % 1000); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(f).padStart(3, '0')}`; };
const srt = clips.map((c, i) => `${i + 1}\n${srtTime(c.start + 250)} --> ${srtTime(c.start + 250 + c.duration * 1000)}\n${c.text}\n`).join('\n');
const srtFile = out.replace(/\.mp4$/, '.srt');
fs.writeFileSync(srtFile, srt);

const args = ['-y', '-v', 'error', '-ss', (LEAD / 1000).toFixed(3), '-i', path.join(dir, `${name}.webm`)];
for (const c of clips) args.push('-i', c.file);
const delays = clips.map((c, i) => `[${i + 1}:a]aresample=48000,adelay=${Math.max(0, Math.round(c.start + 250 - LEAD))}:all=1[a${i}]`);
const mix = `${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,apad,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]`;
args.push('-filter_complex', [...delays, mix].join(';'), '-map', '0:v', '-map', '[aout]',
  '-t', ((total - LEAD) / 1000).toFixed(3),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', process.env.CRF ?? '24', '-pix_fmt', 'yuv420p', '-r', '25', '-movflags', '+faststart',
  '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', out);
execFileSync('ffmpeg', args, { stdio: 'inherit' });
console.log(`muxed ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB) + ${path.basename(srtFile)}`);
