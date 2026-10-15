"""FlowZa Time · portal videos · narration voice. Reads narration.json ({video: [{id, text}]}) and writes one WAV per line with
Kokoro (offline neural TTS, voice af_heart at 1.06x) plus a manifest {id: {file, text, duration}} per video under
$WORK/voice/<video>/. Lines whose text did not change are not voiced again (cache keyed by the text).
Usage: $TOOLS/venv/bin/python -I tts.py <narration.json> [video ...]"""
import hashlib
import json
import os
import sys

import soundfile as sf
from kokoro_onnx import Kokoro

TOOLS = os.environ.get('TOOLS', os.path.expanduser('~/flowza-media-tools'))
WORK = os.environ.get('WORK', os.path.expanduser('~/.cache/flowza-portal-videos'))
VOICE = os.environ.get('VOICE', 'af_heart')
SPEED = float(os.environ.get('SPEED', '1.06'))


def main() -> None:
    narration = json.load(open(sys.argv[1], encoding='utf-8'))
    only = set(sys.argv[2:])
    kokoro = Kokoro(os.path.join(TOOLS, 'model/kokoro-v1.0.onnx'), os.path.join(TOOLS, 'model/voices-v1.0.bin'))
    for video, lines in narration.items():
        if only and video not in only:
            continue
        out = os.path.join(WORK, 'voice', video)
        os.makedirs(out, exist_ok=True)
        manifest = {}
        for line in lines:
            text = line['text']
            key = hashlib.sha1(f'{VOICE}|{SPEED}|{text}'.encode()).hexdigest()[:12]
            path = os.path.join(out, f"{line['id']}-{key}.wav")
            if not os.path.exists(path):
                samples, rate = kokoro.create(line.get('say', text), voice=VOICE, speed=SPEED, lang='en-us')
                sf.write(path, samples, rate)
            info = sf.info(path)
            manifest[line['id']] = {'file': path, 'text': text, 'duration': round(info.frames / info.samplerate, 3)}
            print(f"{video}/{line['id']}: {manifest[line['id']]['duration']:.1f}s")
        json.dump(manifest, open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8'), indent=2)


if __name__ == '__main__':
    main()
