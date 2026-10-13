"""Voice every narration line with Kokoro (offline). The recording paces the app to these clips, then places each clip at
the moment its line started on screen.

usage: python -I tts.py <model_dir> <script.json> <out_dir>
Writes <out_dir>/beats/<scene>-<n>.wav (24 kHz mono, silence trimmed) and <out_dir>/beats.json ({scene: [seconds, ...]}).
Clips are cached by text, voice and speed, so a re-run only voices edited lines.
"""
import json, sys, os, hashlib, shutil
import numpy as np, soundfile as sf
from kokoro_onnx import Kokoro

model_dir, script_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out + "/beats", exist_ok=True)
os.makedirs(out + "/cache", exist_ok=True)
spec = json.load(open(script_path))
voice, speed, lang = spec.get("voice", "af_heart"), spec.get("speed", 1.0), spec.get("lang", "en-us")
k = Kokoro(model_dir + "/kokoro-v1.0.onnx", model_dir + "/voices-v1.0.bin")
SR = 24000

def spoken(text):
    for a, b in spec.get("say", {}).items():
        text = text.replace(a, b)
    return text

durations = {}
for sc in spec["scenes"]:
    durations[sc["id"]] = []
    for i, text in enumerate(sc["beats"]):
        say = spoken(text)
        key = hashlib.sha1(f"{voice}|{speed}|{lang}|{say}".encode()).hexdigest()[:16]
        cached = f"{out}/cache/{key}.wav"
        if not os.path.exists(cached):
            s, sr = k.create(say, voice=voice, speed=speed, lang=lang)
            assert sr == SR
            # trim leading/trailing near-silence so a clip starts on its first syllable
            idx = np.where(np.abs(s) > 0.01)[0]
            if len(idx):
                s = s[max(0, idx[0] - 240): idx[-1] + 2400]
            sf.write(cached, s, SR)
        shutil.copyfile(cached, f"{out}/beats/{sc['id']}-{i}.wav")
        durations[sc["id"]].append(round(sf.info(cached).duration, 3))
    print(f"{sc['id']:<10} {sum(durations[sc['id']]):6.1f}s  {len(sc['beats'])} lines")
json.dump(durations, open(out + "/beats.json", "w"), indent=1)
print(f"speech total {sum(sum(v) for v in durations.values()):.1f}s")
