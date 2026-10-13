"""Turns a recording into its parts for the final mux: the frame list (variable rate, as captured), the narration track with
every voice clip placed where its line started on screen, and the captions.

usage: python -I assemble.py <work_dir>
Reads <work>/recording.json (record.spec.ts) and <work>/beats/<scene>-<n>.wav (tts.py).
Writes <work>/frames.txt (ffmpeg concat list), <work>/narration.wav, <work>/captions.srt and prints the duration.
"""
import json, sys
import numpy as np, soundfile as sf

work = sys.argv[1]
rec = json.load(open(f'{work}/recording.json'))
frames = sorted(rec['frames'], key=lambda f: f['t'])
lines = rec['lines']
# Frames carry the compositor's timestamps, lines the test's wall clock; each frame also records when it arrived, which
# bridges the two clocks (the median ignores the odd late frame).
offset = float(np.median([f['wall'] - f['t'] for f in frames])) if 'wall' in frames[0] else 0.0
t0 = frames[0]['t']
end = frames[-1]['t'] + 0.6
at = lambda wall: wall - offset - t0

with open(f'{work}/frames.txt', 'w') as fh:
    for a, b in zip(frames, frames[1:] + [None]):
        d = (b['t'] if b else end) - a['t']
        fh.write(f"file '{a['file']}'\nduration {max(d, 0.001):.4f}\n")
    fh.write(f"file '{frames[-1]['file']}'\n")

SR = 24000
total = end - t0
track = np.zeros(int(total * SR) + SR, dtype=np.float32)
for ln in lines:
    clip, sr = sf.read(f"{work}/beats/{ln['scene']}-{ln['i']}.wav", dtype='float32')
    assert sr == SR
    s = int(round(at(ln['t']) * SR))
    track[s:s + len(clip)] += clip[: max(0, len(track) - s)]
peak = float(np.max(np.abs(track))) or 1.0
sf.write(f'{work}/narration.wav', track[: int(total * SR)] * (0.89 / peak), SR)

def ts(x):
    h, r = divmod(max(0.0, x), 3600); m, s = divmod(r, 60)
    return f'{int(h):02d}:{int(m):02d}:{int(s):02d},{int(round((s - int(s)) * 1000)) % 1000:03d}'

with open(f'{work}/captions.srt', 'w') as fh:
    for n, ln in enumerate(lines):
        a = at(ln['t'])
        b = a + ln['dur'] + 0.4
        if n + 1 < len(lines):
            b = min(b, at(lines[n + 1]['t']) - 0.05)
        fh.write(f"{n + 1}\n{ts(a)} --> {ts(b)}\n{ln['text']}\n\n")
print(f'{total:.2f}')
