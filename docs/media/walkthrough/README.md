# FlowZa Time Enterprise — walkthrough video and deck

| File | What it is |
|---|---|
| `FlowZa-Time-Enterprise-Walkthrough.mp4` | 3 min 41 s narrated product walkthrough, 1920×1080, H.264/AAC, −16 LUFS, English caption track embedded |
| `captions.en.srt` | The same captions as a sidecar file (for YouTube, LinkedIn, LMS uploads) |
| `FlowZa-Time-Enterprise.pptx` | 5-slide overview deck (16:9) with speaker notes; its only web reference is flowza.com |
| `narration.md` | The voice-over script, by scene, with timestamps |
| `scripts/` | Everything needed to regenerate the three files above |

## What the video covers

| Time | Scene |
|---|---|
| 0:00 | Introduction and agenda |
| 0:12 | 1. Configure devices — Register device, providers, branch timezone, push URL/token, connection test, automatic sync |
| 0:34 | 2. Branches and sites — code, city, timezone, weekly off days, holiday calendar; branch timezone sets the attendance date; geofences |
| 0:51 | 3. Employees, departments and shifts — add or import from CSV, line manager, fixed/flexible shifts, breaks, grace, punch windows, assignment precedence |
| 1:16 | 4. Changing shifts — effective dates, bulk assign, employee shift-change requests, automatic recalculation |
| 1:32 | 5. Working at another branch — branch deployment Muscat HQ → Sohar: enrolled on the host terminals, removed after the last day, attendance/holidays/payroll stay with the home branch |
| 2:02 | 6. Leave management — leave types, accrual and carry forward, apply with balance, team calendar, leave instead of absence |
| 2:20 | 7. Line-manager approvals — reporting line, one inbox, approve/reject/ask/reassign, bulk and e-mail decisions, multi-level workflows with escalation |
| 2:46 | 8. Shift swap request — day and colleague, manager approval, applies to that day only |
| 2:59 | 9. Settings and dashboard — settings groups, roles and branch scope, 7 styles × 3 layouts, KPIs, trend, branches, devices, approvals, reports |
| 3:32 | Close — flowza.com |

The screens are animated recreations of the web app, built from its real English labels (`apps/web/src/locales/en`), its
navigation and its FlowZa Green theme (`apps/web/src/styles/globals.css`); they are not screen recordings. People, numbers and
the organisation ("Majan Gulf Trading", the demo tenant from `supabase/seeds/demo-tenant`) are demo data. Branch deployments,
shift-change requests and shift swaps are Enterprise modules (`docs/pricing.md`). Overtime approval is deliberately not shown:
it is not built yet.

## Regenerating

Edit `scripts/script.json` (narration; each string is one voiced line that the animation syncs to) or a scene in
`scripts/s1.mjs` – `s3.mjs` (scene markup and timing, written as `bN+seconds` = seconds after line N of that scene starts), then
run `scripts/make.sh`. A full run takes about 6 minutes on 4 cores; `--deck-only` rebuilds just the deck (`scripts/deck.mjs`).

One-time setup of a tools folder (nothing here is a workspace dependency):

```bash
TOOLS=~/flowza-media-tools && mkdir -p $TOOLS/model && cd $TOOLS
npm init -y >/dev/null && npm install pptxgenjs react react-dom react-icons sharp   # deck + icons
python3 -m venv venv && venv/bin/pip install kokoro-onnx soundfile                  # offline neural voice
curl -L -o model/kokoro-v1.0.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -L -o model/voices-v1.0.bin  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
```

Also needed on the machine: Node 22 with Playwright's Chromium, `ffmpeg`, Python 3, and the Inter font (the scenes are set in
Inter). Then:

```bash
TOOLS=~/flowza-media-tools bash docs/media/walkthrough/scripts/make.sh
```

Voice: Kokoro `af_heart` at 1.06× speed. Music: a soft synthesised pad (`scripts/music.py`) ducked under the voice.
To check a frame without rendering the video, build the page and grab stills:
`node scripts/build.mjs /tmp/v.html && node scripts/still.mjs /tmp/v.html <work>/timings.json /tmp/shots deploy@b2+5`.
