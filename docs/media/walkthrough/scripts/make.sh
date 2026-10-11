#!/usr/bin/env bash
# Regenerates the walkthrough video, its captions and the deck from the sources in this folder.
# One-time tool setup is described in ../README.md.
#   TOOLS=/path/to/tools bash make.sh                 # deck + video + captions
#   TOOLS=/path/to/tools bash make.sh deck            # deck only
#   TOOLS=/path/to/tools bash make.sh stills deploy@b2+5 dashboard@end ...   # still frames into $WORK/stills
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(cd "$HERE/.." && pwd)"
TOOLS="${TOOLS:?set TOOLS to the folder prepared in README.md (node_modules/, venv/, model/)}"
# Work files (voiced lines are cached here, so keep it between runs) live outside the repository.
WORK="${WORK:-${XDG_CACHE_HOME:-$HOME/.cache}/flowza-walkthrough}"
MODE="${1:-all}"
mkdir -p "$WORK"

# ES modules resolve packages from the script's own folder upwards, so run a copy of the sources next to the tools.
SRC="$WORK/src"
rm -rf "$SRC" && mkdir -p "$SRC" && cp "$HERE"/*.mjs "$HERE"/*.js "$HERE"/*.css "$HERE"/*.json "$HERE"/*.py "$SRC"/
ln -s "$TOOLS/node_modules" "$SRC/node_modules"

node "$SRC/deck.mjs" "$OUT/FlowZa-Time-Enterprise.pptx"
[ "$MODE" = "deck" ] && exit 0

"$TOOLS/venv/bin/python" -I "$SRC/tts.py" "$TOOLS/model" "$SRC/script.json" "$WORK"
node "$SRC/build.mjs" "$WORK/video.html"
if [ "$MODE" = "stills" ]; then
  shift
  node "$SRC/still.mjs" "$WORK/video.html" "$WORK/timings.json" "$WORK/stills" "$@"
  exit 0
fi
node "$SRC/render.mjs" "$WORK/video.html" "$WORK/timings.json" "$WORK/video_noaudio.mp4" 30 3
TOTAL="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['total'])" "$WORK/timings.json")"
"$TOOLS/venv/bin/python" -I "$SRC/music.py" "$TOTAL" "$WORK/music.wav"

# Voice in both channels; the music bed is ducked under the voice, then everything is normalised to -16 LUFS.
ffmpeg -y -loglevel error -i "$WORK/narration.wav" -i "$WORK/music.wav" -filter_complex \
  "[0:a]aresample=48000,pan=stereo|c0=c0|c1=c0,asplit=2[v][vsc];[1:a]volume=0.16[m];[m][vsc]sidechaincompress=threshold=0.03:ratio=5:attack=30:release=600[md];[v][md]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95,loudnorm=I=-16:TP=-1.5:LRA=11[a]" \
  -map "[a]" -ar 48000 -c:a pcm_s16le "$WORK/mix.wav"
ffmpeg -y -loglevel error -i "$WORK/video_noaudio.mp4" -i "$WORK/mix.wav" -i "$WORK/captions.srt" \
  -map 0:v -map 1:a -map 2:s -c:v copy -c:a aac -b:a 160k -c:s mov_text -metadata:s:s:0 language=eng \
  -metadata title="FlowZa Time Enterprise — product walkthrough" -movflags +faststart "$OUT/FlowZa-Time-Enterprise-Walkthrough.mp4"
cp "$WORK/captions.srt" "$OUT/captions.en.srt"
echo "done: $OUT (work files in $WORK)"
