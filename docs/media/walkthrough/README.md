# FlowZa Time Enterprise — walkthrough video and deck

| File | What it is |
|---|---|
| `FlowZa-Time-Enterprise-Walkthrough.mp4` | 3 min 45 s narrated product walkthrough, 1920×1080, H.264/AAC, −16 LUFS, English caption track embedded |
| `captions.en.srt` | The same captions as a sidecar file (for YouTube, LinkedIn, LMS uploads) |
| `FlowZa-Time-Enterprise.pptx` | 5-slide overview deck (16:9) with speaker notes; its only web reference is flowza.com |
| `narration.md` | The voice-over script, by scene, with timestamps |
| `scripts/` | Everything needed to regenerate the three files above |

## What the video covers

| Time | Scene |
|---|---|
| 0:00 | Introduction and agenda |
| 0:12 | 1. Configure devices — Register device wizard, providers, push URL/token and first heartbeat, connection test for cloud/server providers |
| 0:36 | 2. Branches and sites — code, city, timezone, weekly off days, holiday calendar; branch timezone sets the attendance date; geofences |
| 0:53 | 3. Employees, departments and shifts — add or import from CSV, line manager, fixed/flexible shifts, breaks, grace, punch windows, assignment precedence |
| 1:17 | 4. Changing shifts — effective dates, bulk assign, employee shift-change requests, automatic recalculation |
| 1:34 | 5. Working at another branch — branch deployment Muscat HQ → Sohar: added to the host terminals (ID, name, card), removed after the last day; shift, holidays and payroll stay with the home branch |
| 2:06 | 6. Leave management — leave types, allowance, accrual and carry forward, apply with balance, team calendar, days on leave never marked absent |
| 2:24 | 7. Line-manager approvals — reporting line, one inbox, approve/reject/ask for information, bulk and e-mail decisions, HR workflows of up to five levels with escalation |
| 2:51 | 8. Shift swap request — day and colleague, manager approval, applies to that day only |
| 3:03 | 9. Settings and dashboard — settings groups, roles and branch scope, 7 styles × 3 layouts, the Overview dashboard, reports |
| 3:36 | Close — flowza.com |

The screens are animated recreations of the web app, built from its real English labels (`apps/web/src/locales/en`), its
navigation and its FlowZa Green theme (`apps/web/src/styles/globals.css`); they are not screen recordings. People, numbers and
the organisation ("Majan Gulf Trading", the demo tenant from `supabase/seeds/demo-tenant`) are demo data. Branch deployments,
shift-change requests and shift swaps are Enterprise modules (`docs/pricing.md`). Overtime approval is deliberately not shown:
it is not built yet.

## Regenerating

Edit `scripts/script.json` (narration; each string is one voiced line that the animation syncs to) or a scene in
`scripts/s1.mjs` – `s3.mjs` (scene markup and timing, written as `bN+seconds` = seconds after line N of that scene starts),
then run `scripts/make.sh`. A full run takes about 6 minutes on 4 cores.

One-time setup of a tools folder outside the repository (nothing here is a workspace dependency):

```bash
export TOOLS=~/flowza-media-tools && mkdir -p "$TOOLS/model"
npm --prefix "$TOOLS" install pptxgenjs react react-dom react-icons sharp playwright   # deck, icons, frame capture
npx --prefix "$TOOLS" playwright install chromium                                      # skip if Chromium is already set up
python3 -m venv "$TOOLS/venv" && "$TOOLS/venv/bin/pip" install kokoro-onnx soundfile   # offline neural voice
curl -L -o "$TOOLS/model/kokoro-v1.0.onnx" https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -L -o "$TOOLS/model/voices-v1.0.bin" https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
```

Also needed: Node 22, `ffmpeg`, Python 3 and the Inter font (the scenes are set in Inter). Then, from the repository root:

```bash
TOOLS=~/flowza-media-tools bash docs/media/walkthrough/scripts/make.sh                            # deck, video, captions
TOOLS=~/flowza-media-tools bash docs/media/walkthrough/scripts/make.sh deck                       # deck only
TOOLS=~/flowza-media-tools bash docs/media/walkthrough/scripts/make.sh stills deploy@b2+5 dashboard@end   # check frames
```

Work files go to `$WORK` (default `~/.cache/flowza-walkthrough`): keep it between runs and only edited narration lines are
voiced again. Stills land in `$WORK/stills`. Voice: Kokoro `af_heart` at 1.06× speed. Music: a soft synthesised pad
(`scripts/music.py`) ducked under the voice.
