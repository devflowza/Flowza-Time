"""Voice every narration beat with Kokoro and write timings + a single narration track.

usage: python -I tts.py <model_dir> <script.json> <out_dir>
script.json: {"voice": "...", "speed": 1.0, "scenes": [{"id": "...", "lead": 0.6, "tail": 0.8, "gap": 0.35, "beats": ["...", ...]}]}
Writes <out_dir>/narration.wav, <out_dir>/timings.json, <out_dir>/captions.srt
"""
import json, sys, os, hashlib
import numpy as np, soundfile as sf
from kokoro_onnx import Kokoro

model_dir, script_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out + "/beats", exist_ok=True)
spec = json.load(open(script_path))
voice, speed, lang = spec.get("voice", "af_heart"), spec.get("speed", 1.0), spec.get("lang", "en-us")
k = Kokoro(model_dir + "/kokoro-v1.0.onnx", model_dir + "/voices-v1.0.bin")
SR = 24000

def voiced(text):
    # Cache by text+voice so re-runs only re-voice edited lines.
    key = hashlib.sha1(f"{voice}|{speed}|{lang}|{text}".encode()).hexdigest()[:16]
    p = f"{out}/beats/{key}.wav"
    if not os.path.exists(p):
        say = spec.get("say", {})
        spoken = text
        for a, b in say.items():
            spoken = spoken.replace(a, b)
        s, sr = k.create(spoken, voice=voice, speed=speed, lang=lang)
        assert sr == SR
        # trim leading/trailing near-silence so beat starts line up with the first syllable
        idx = np.where(np.abs(s) > 0.01)[0]
        if len(idx):
            s = s[max(0, idx[0] - 240): idx[-1] + 2400]
        sf.write(p, s, SR)
    a, _ = sf.read(p, dtype="float32")
    return a

track, t, timings, srt = [], 0.0, [], []
def silence(sec):
    global t
    n = int(round(sec * SR)); track.append(np.zeros(n, dtype=np.float32)); t += n / SR

def ts(x):
    h, r = divmod(x, 3600); m, s = divmod(r, 60)
    return f"{int(h):02d}:{int(m):02d}:{int(s):02d},{int(round((s - int(s)) * 1000)):03d}"

for sc in spec["scenes"]:
    start = t
    silence(sc.get("lead", 0.6))
    beats = []
    for i, text in enumerate(sc["beats"]):
        if i:
            silence(sc.get("gap", 0.35))
        a = voiced(text)
        b0 = t - start
        track.append(a); t += len(a) / SR
        beats.append({"at": round(b0, 3), "dur": round(len(a) / SR, 3)})
        srt.append((start + b0, t, text))
    silence(sc.get("tail", 0.8))
    timings.append({"id": sc["id"], "start": round(start, 3), "dur": round(t - start, 3), "beats": beats})
    print(f"{sc['id']:<12} {start:7.2f}s  +{t - start:6.2f}s  ({len(beats)} beats)")

audio = np.concatenate(track)
peak = np.max(np.abs(audio)) or 1.0
audio = audio * (0.89 / peak)
sf.write(out + "/narration.wav", audio, SR)
json.dump({"total": round(t, 3), "scenes": timings}, open(out + "/timings.json", "w"), indent=1)
with open(out + "/captions.srt", "w") as f:
    for i, (a, b, text) in enumerate(srt, 1):
        f.write(f"{i}\n{ts(a)} --> {ts(b)}\n{text}\n\n")
print(f"TOTAL {t:.2f}s = {int(t // 60)}:{t % 60:05.2f}")
