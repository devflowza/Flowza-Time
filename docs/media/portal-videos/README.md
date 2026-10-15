# FlowZa Time — portal videos and deck

Five short, narrated screen recordings of the **running product** (not mock-ups), one per audience, and the deck that embeds
them with the delivery plan.

| File | Audience | What it shows |
|---|---|---|
| `FlowZa-Time-1-Employee-Portal.mp4` | Employees | Overview, attendance calendar and day detail, the Activity bar graph (on site vs time away by kind), **Step out / I'm back**, planned time away and the monthly permission allowance, leave balances and apply leave, shift swap request |
| `FlowZa-Time-2-Manager-Portal.mp4` | Line managers | Team › Today (who is in, late, absent, on leave), the morning roll call (the Daily Report delivered every working morning), the approvals inbox (time away, leave, swap) with context, the month grid, and managers of managers (indirect reports) |
| `FlowZa-Time-3-HR.mp4` | HR | Dashboard, daily attendance by department, the Time away report, the morning roll call schedule, organisation and org chart, holidays (add / remove), leave, meeting attendance |
| `FlowZa-Time-4-Admin.mp4` | Administrators | Settings (incl. manager team scope), users and roles, terminals by punch role, registering a terminal, locations, audit log |
| `FlowZa-Time-5-Between-Check-In-And-Out.mp4` | Everyone | The two site layouts (two-way terminals; entry terminal + portal step-out), terminal roles, the time-away policy, how each gap is classified, meeting-room readers, the HR report |
| `FlowZa-Time-Portals.pptx` | Management | Plan in detail and status, with the five videos embedded |
| `*.srt` | — | Caption sidecars (the captions are also burned into the frames) |

The design behind the new features is `docs/time-away.md`.

## How they are made

The scripts in `scripts/` drive the real web app against the real API, worker and Postgres, with the local demo data:

1. **Stack.** Local Postgres + migrations + the Al Bahja seed (`scripts/db-reset-local.sh --seed`), then `scripts/demo-seed.sql`
   (time-away policy, terminal roles, meeting rooms, the cast and four weeks of punches). The worker normalises and computes
   every day with the real engine. `scripts/local-auth.mjs` stands in for Supabase Auth locally (HS256 tokens the API verifies);
   `scripts/seed-requests.mjs` files the pending requests through the API, as the portal does, and has HR schedule the
   "Morning roll call" (the Daily Report, daily Sun–Thu, to the managers) and run it once. The web app is built for the local
   URLs (`apps/web/.env.production.local`, which wins over the committed `.env.production`) and served by `vite preview`.
   Every recording starts from the same database snapshot (the stack after seeding, kept as a template database), because
   the videos file requests, approve them and add a holiday.
2. **Voice.** `scripts/tts.py` voices `scripts/narration.json` offline (Kokoro, `af_heart`, 1.06×).
3. **Recording.** `scripts/record-*.mjs` drive Chromium with Playwright (`scripts/lib.mjs`: a visible cursor, the caption bar,
   title cards, scenes that last as long as their narration).
4. **Mux.** `scripts/mux.mjs` places each narration clip at its scene's start, loudness-normalises (−16 LUFS) and encodes
   H.264/AAC, plus the `.srt`.
5. **Deck.** `scripts/deck.mjs` (pptxgenjs) builds the deck and embeds the videos with a poster frame.

```bash
export TOOLS=~/flowza-media-tools WORK=~/.cache/flowza-portal-videos
# one-time tools (outside the repository; nothing here is a workspace dependency)
npm --prefix "$TOOLS" install pptxgenjs@3.12.0 sharp@0.34.3 react@18.3.1 react-dom@18.3.1 react-icons@5.5.0
python3 -m venv "$TOOLS/venv" && "$TOOLS/venv/bin/pip" install kokoro-onnx soundfile
curl -L -o "$TOOLS/model/kokoro-v1.0.onnx" https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -L -o "$TOOLS/model/voices-v1.0.bin" https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
# the stack (see scripts/make.sh for the environment), then:
bash docs/media/portal-videos/scripts/make.sh            # voice, record, mux, deck
bash docs/media/portal-videos/scripts/make.sh employee   # one video
```

People, numbers and the organisation (Al Bahja Trading) are demo data. The demo data is anchored on 15 October 2026, the day
the videos were recorded ("today" in the recordings); shift its dates in `demo-seed.sql` to record on another day.
