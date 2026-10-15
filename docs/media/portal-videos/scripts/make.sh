#!/usr/bin/env bash
# FlowZa Time · portal videos · voice → record → mux → deck. Expects the local stack running (see README.md):
#   Postgres 127.0.0.1:54329 (db `flowza`, Al Bahja seed + demo-seed.sql), local-auth.mjs on :54321, the API on :4000, the
#   worker, and the web app built for these URLs and served by `vite preview` on :4173 (WEB_URL).
# Usage: make.sh [employee|manager|hr|admin|timeaway|deck]...   (no argument = everything)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
HERE="$ROOT/docs/media/portal-videos"
export TOOLS="${TOOLS:-$HOME/flowza-media-tools}" WORK="${WORK:-$HOME/.cache/flowza-portal-videos}" REPO="$ROOT"
declare -A OUT=([employee]="FlowZa-Time-1-Employee-Portal" [manager]="FlowZa-Time-2-Manager-Portal" [hr]="FlowZa-Time-3-HR" [admin]="FlowZa-Time-4-Admin" [timeaway]="FlowZa-Time-5-Between-Check-In-And-Out")
targets=("$@"); [ ${#targets[@]} -eq 0 ] && targets=(employee manager hr admin timeaway deck)
for t in "${targets[@]}"; do
  if [ "$t" = deck ]; then
    # ES modules resolve packages from the script's own folder upwards: run a copy of the deck next to the tools
    SRC="$WORK/src"; rm -rf "$SRC" && mkdir -p "$SRC" && cp "$HERE/scripts/deck.mjs" "$SRC/" && ln -s "$TOOLS/node_modules" "$SRC/node_modules"
    node "$SRC/deck.mjs" "$HERE/FlowZa-Time-Portals.pptx" "$HERE"
    continue
  fi
  "$TOOLS/venv/bin/python" -I "$HERE/scripts/tts.py" "$HERE/scripts/narration.json" "$t"
  node "$HERE/scripts/record-$t.mjs"
  node "$HERE/scripts/mux.mjs" "$t" "$HERE/${OUT[$t]}.mp4"
done
