#!/usr/bin/env bash
# Regenerates the users & reports how-to video, its captions and the two sample reports from the sources in this folder.
# One-time setup is described in ../README.md. Run from the repository root:
#   TOOLS=/path/to/tools bash docs/media/users-reports/scripts/make.sh
# Needs: the local Postgres of scripts/local-pg.sh (running), Chromium (CHROMIUM_PATH), ffmpeg, poppler-utils, Python 3.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
TOOLS="${TOOLS:?set TOOLS to the folder prepared in README.md (venv/, model/)}"
CHROMIUM_PATH="${CHROMIUM_PATH:?set CHROMIUM_PATH to a Chromium binary (e.g. /opt/pw-browsers/chromium-1194/chrome-linux/chrome)}"
# work files (voice clips are cached here, so keep it between runs) live outside the repository
WORK="${WORK:-${XDG_CACHE_HOME:-$HOME/.cache}/flowza-users-reports}"
mkdir -p "$WORK"
PY="$TOOLS/venv/bin/python"
cleanup() { rm -rf "$REPO/apps/worker/.media-gen" "$REPO/apps/web/.media-gen"; }
trap cleanup EXIT

# 1. the reports, made by the worker's own code from seeded demo data (the scripts run from inside the app they import)
mkdir -p "$REPO/apps/worker/.media-gen"
cp "$HERE/gen-reports.ts" "$REPO/apps/worker/.media-gen/"
(cd "$REPO/apps/worker" && CHROMIUM_PATH="$CHROMIUM_PATH" ./node_modules/.bin/tsx .media-gen/gen-reports.ts "$WORK/reports")

# 2. the voice, one clip per narration line
"$PY" -I "$HERE/tts.py" "$TOOLS/model" "$HERE/script.json" "$WORK"

# 3. the report pages and word positions for the viewer
python3 -I "$HERE/prep_media.py" "$WORK/reports" "$WORK/media"

# 4. the recording: the production web bundle against the demo world
[ -d "$REPO/apps/web/dist-e2e" ] || pnpm --dir "$REPO/apps/web" run build:e2e
mkdir -p "$REPO/apps/web/.media-gen"
cp "$HERE"/{playwright.config.ts,record.spec.ts,world.ts,people.json,overlay.js,viewer.html,script.json} "$REPO/apps/web/.media-gen/"
(cd "$REPO/apps/web" && LANGUAGE=en_GB WORK="$WORK" PLAYWRIGHT_CHROMIUM_EXECUTABLE="$CHROMIUM_PATH" pnpm exec playwright test -c .media-gen/playwright.config.ts record)

# 5. picture, voice, music and captions
TOTAL="$("$PY" -I "$HERE/assemble.py" "$WORK")"
ffmpeg -y -loglevel error -f concat -safe 0 -i "$WORK/frames.txt" \
  -vf "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p" -c:v libx264 -preset slow -crf 17 -tune stillimage "$WORK/video_noaudio.mp4"
"$PY" -I "$REPO/docs/media/walkthrough/scripts/music.py" "$TOTAL" "$WORK/music.wav"
# voice in both channels; the music bed is ducked under the voice, then everything is normalised to -16 LUFS
ffmpeg -y -loglevel error -i "$WORK/narration.wav" -i "$WORK/music.wav" -filter_complex \
  "[0:a]aresample=48000,pan=stereo|c0=c0|c1=c0,asplit=2[v][vsc];[1:a]volume=0.13[m];[m][vsc]sidechaincompress=threshold=0.03:ratio=5:attack=30:release=600[md];[v][md]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95,loudnorm=I=-16:TP=-1.5:LRA=11[a]" \
  -map "[a]" -ar 48000 -c:a pcm_s16le "$WORK/mix.wav"
ffmpeg -y -loglevel error -i "$WORK/video_noaudio.mp4" -i "$WORK/mix.wav" -i "$WORK/captions.srt" \
  -map 0:v -map 1:a -map 2:s -c:v copy -c:a aac -b:a 160k -c:s mov_text -metadata:s:s:0 language=eng \
  -metadata title="FlowZa Time — users and reports, how-to" -movflags +faststart "$OUT/FlowZa-Time-Users-and-Reports.mp4"
cp "$WORK/captions.srt" "$OUT/captions.en.srt"
cp "$WORK/reports/monthly-attendance-detailed-2026-09.pdf" "$OUT/sample-monthly-attendance-detailed-2026-09.pdf"
cp "$WORK/reports/detail-report-2025.pdf" "$OUT/sample-detail-report-2025.pdf"
echo "done: $OUT (work files in $WORK)"
