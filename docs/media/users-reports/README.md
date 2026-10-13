# FlowZa Time — users and reports, how-to video

| File | What it is |
|---|---|
| `FlowZa-Time-Users-and-Reports.mp4` | __DURATION__ narrated how-to, 1920×1080, H.264/AAC, −16 LUFS, English caption track embedded |
| `captions.en.srt` | The same captions as a sidecar file (for YouTube, LinkedIn, LMS uploads) |
| `sample-monthly-attendance-detailed-2026-09.pdf` | The Monthly Attendance Report (Detailed layout) the video walks through |
| `sample-detail-report-2025.pdf` | The yearly Detail Report (1 Jan – 31 Dec 2025) the video walks through |
| `scripts/` | Everything needed to regenerate the files above |

## What the video covers

| Time | Chapter |
|---|---|
__CHAPTERS__

## The report columns

Both reports print the same identity block per employee and one row per day. The examples are the figures in the sample
PDFs (Arun Menon, September 2026; Salim Al Hinai, 2025).

| Column | Meaning | Example |
|---|---|---|
| Employee, Dept, Card No, Shift, Designation | Who the page is about: employee number and name, department, card number, shift (as at the end of the period), designation | MG-1010 Arun Menon · Information Technology · Office Hours 08:00–17:00 |
| Days (monthly) | Days per attendance code in the month (plus LOP days when there are any) | PR 19 · AB 1 · OF 8 · SL 1 · MP 1 |
| Date | The day, with its weekday | 01-Sep-26 Tue |
| Att Code | The day's attendance code: PR present, AB absent, OF weekly off, HL holiday, HDP / HDL half day present / on leave, MP missed punch, or the leave type's own code (AL annual, SL sick…). The legend at the end of each report lists the codes in use | 14-Sep-26 AB, 07-Sep-26 MP |
| IN Time / OUT Time | First check-in and last check-out recorded by the device | 7:52 am / 5:06 pm |
| Wrk Hrs (monthly) / Work Hrs (Detail Report) | Time from IN to OUT, in hours:minutes | 9:14 |
| Tot Hrs | Time actually worked, without unpaid breaks (the lunch hour) | 8.14 |
| Base Hrs | Hours the shift requires that day; none on a weekly off or holiday | 8.00 |
| OT1 | Overtime on a working day, under the organisation's overtime rules | 03-Sep-26: out at 7:18 pm → 1.30 |
| OT2 | Overtime on a weekly off or a holiday | 05-Sep-26 (Saturday) → 3.56 |
| UT | Under time: Base Hrs not worked. A missed punch counts the whole base until it is corrected | 02-Sep-26 → 0.15; 07-Sep-26 (MP) → 8.00 |
| Remarks (Detail Report) | The reason recorded with an approved attendance correction | 14-Jan-25: Forgot to punch out |
| Total row | The period's sums: Tot Hrs, Base Hrs (monthly), OT1, OT2, UT | 2025: 1870.16 · 20.30 · 11.45 · 38.20 |

Hours are printed as hours.minutes (`8.14` is 8 h 14 min, not a decimal); a tenant can switch to `hh:mm` under
Settings → Reports. Report layouts, codes and the notation are documented in `docs/reports.md`.

## Points the video relies on

- Each active employee is one user of the subscription; the user limit is set by the platform (55 in the demo). At the limit
  the Employees page shows "Maximum users reached" and Add employee is disabled; archiving an employee (Danger zone →
  Archive employee) frees the user. Archiving marks the employee terminated, removes them from every device, suspends a
  linked sign-in (`apps/api/src/services/offboarding.ts`) and keeps the attendance history.
- Signing in is separate from being an employee: Users & roles → Invite member (role, branch scope, linked employee).
  Inviting needs `user.manage` (Organisation Admin or Owner; HR Admin can add and archive employees but not invite), so the
  video is recorded as the demo tenant's Organisation Admin.
- "Monthly detailed" is the Monthly Attendance Report with Layout = Detailed. "Yearly detailed" is the Detail Report with
  From = 1 January and To = 31 December; it covers at most one year. For one line per employee over a year, the Summary
  Report takes the same dates.

## How it was made

- **The screens are the real web app**: the production bundle (`pnpm --filter @flowza/web run build:e2e`) driven by
  Playwright, with its backend answered by the e2e backend double (`apps/web/e2e/support/mock-backend.ts`) and the
  "Majan Gulf" demo tenant of `supabase/seeds/demo-tenant` (`scripts/world.ts`, `scripts/people.json`). The cursor, the
  captions, the chapter cards and the highlight boxes are an overlay drawn for the recording (`scripts/overlay.js`).
- **The reports are real output**: `scripts/gen-reports.ts` seeds the Majan Gulf IT team into a local Postgres with every
  migration applied, feeds 21 months of raw device punches through the worker's own NORMALIZE_RAW and RECOMPUTE_DAILY
  (the attendance engine, with the demo tenant's "Company standard" rule set and Oman holidays), applies one correction,
  and runs GENERATE_REPORT with the Chromium PDF renderer. A few days are pinned so the pages show every code and every
  hours column; the rest is generated.
- **The report viewer is a stand-in**: headless Chromium has no PDF viewer, so the report's signed URL serves
  `scripts/viewer.html`, which shows the PDF's own pages (rendered by `pdftoppm`) and places highlights from the PDF's word
  positions (`pdftotext -bbox`). In a normal browser the same link opens the browser's PDF viewer.
- People, numbers and the organisation are demo data. Voice: Kokoro `af_heart` (offline). Music: the soft pad of
  `docs/media/walkthrough/scripts/music.py`, ducked under the voice.

## Regenerating

Edit `scripts/script.json` (narration: one voiced line per string; the recording waits for each line to finish) or
`scripts/record.spec.ts` (what happens on screen during each line), then run `scripts/make.sh`. A full run takes about
20 minutes, most of it the real-time recording.

One-time setup of a tools folder outside the repository:

```bash
export TOOLS=~/flowza-media-tools && mkdir -p "$TOOLS/model"
python3 -m venv "$TOOLS/venv" && "$TOOLS/venv/bin/pip" install kokoro-onnx soundfile   # offline neural voice
curl -L -o "$TOOLS/model/kokoro-v1.0.onnx" https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -L -o "$TOOLS/model/voices-v1.0.bin" https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
```

Also needed: `pnpm install` and `pnpm build:packages`, the local Postgres of `scripts/local-pg.sh` (running), a Chromium
binary, `ffmpeg`, `poppler-utils` (`pdftoppm`, `pdftotext`) and the Inter font. Then, from the repository root:

```bash
TOOLS=~/flowza-media-tools CHROMIUM_PATH=/path/to/chrome bash docs/media/users-reports/scripts/make.sh
```

Work files go to `$WORK` (default `~/.cache/flowza-users-reports`); keep it between runs and only edited narration lines are
voiced again. The scripts that import app code are copied into `apps/worker/.media-gen/` and `apps/web/.media-gen/` for the
run and removed afterwards.
