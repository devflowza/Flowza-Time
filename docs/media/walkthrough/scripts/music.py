"""Soft ambient pad (A major colour) as a quiet bed under the narration. usage: python -I music.py <seconds> <out.wav>"""
import sys, numpy as np, soundfile as sf
dur, out = float(sys.argv[1]), sys.argv[2]
SR = 48000
n = int(dur * SR); t = np.arange(n) / SR
f = lambda m: 440.0 * 2 ** ((m - 69) / 12)  # midi -> Hz
# Amaj9 → F#m9 → Dmaj9 → Esus4, 8 s each
chords = [[45, 57, 61, 64, 68, 71], [42, 54, 57, 61, 64, 68], [38, 50, 57, 61, 66, 69], [40, 52, 57, 59, 64, 71]]
seg = 8.0
pad = np.zeros(n)
for i in range(int(np.ceil(dur / seg)) + 1):
    notes = chords[i % 4]
    a, b = i * seg - 2.0, (i + 1) * seg + 2.0
    m = (t >= a) & (t < b)
    if not m.any():
        continue
    tt = t[m] - a
    L = b - a
    env = np.minimum(1, tt / 2.5) * np.minimum(1, (L - tt) / 2.5)
    env = env * env * (3 - 2 * env)  # smoothstep
    s = np.zeros(m.sum())
    for k, note in enumerate(notes):
        amp = 0.55 if k == 0 else 0.32 / (1 + 0.15 * k)
        for det in (-0.0018, 0.0, 0.0021):
            ph = np.random.default_rng(i * 31 + k).uniform(0, 2 * np.pi)
            s += amp * np.sin(2 * np.pi * f(note) * (1 + det) * tt + ph) * (1 + 0.12 * np.sin(2 * np.pi * 0.17 * tt + k))
    pad[m] += s * env
# gentle one-pole low-pass for warmth
y = np.empty_like(pad); acc = 0.0; alpha = 0.06
for i0 in range(0, n, SR):
    blk = pad[i0:i0 + SR]
    out_blk = np.empty_like(blk)
    for j, v in enumerate(blk):
        acc += alpha * (v - acc); out_blk[j] = acc
    y[i0:i0 + SR] = out_blk
fade = np.minimum(1, t / 3.0) * np.minimum(1, (dur - t) / 4.0)
y = y * fade
y = y / (np.max(np.abs(y)) or 1) * 0.5
sf.write(out, np.stack([y, y], axis=1).astype(np.float32), SR)
print('music', out, f'{dur:.1f}s')
