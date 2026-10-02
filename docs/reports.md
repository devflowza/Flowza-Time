# Reports

How a report request becomes a file, how the fourteen sample layouts map onto report types, and how to add one.
Request/quota/download semantics are in `docs/api.md` (Reports & payroll); this document is about generation.

## Pipeline

```
POST /orgs/:orgId/reports ──▶ report_requests (QUEUED) + GENERATE_REPORT job (queue: reports)
                                     │
   apps/worker/src/handlers/reports/generate.ts
                                     │  1. claim: QUEUED → RUNNING                      (short transaction)
                                     │  2. loadReportContext + definition.build(trx)     (short transaction, system context for the org)
                                     │  3. renderDocument(doc, format)                    (no connection held: CSV · XLSX · PDF)
                                     │  4. storage.upload('reports', '<org>/<id>.<ext>')
                                     │  5. finalise: COMPLETED, file_path, row_count, expires_at (+7 d) → domain event report.ready
                                     ▼
  GET …/reports/:id/download → signed URL (300 s) · retention sweep expires files after 7 days
```

Failure policy: a non-retryable error (bad parameters, a type the catalogue does not offer, no Chromium on this worker)
sets FAILED with the user-safe message and emits `report.failed`; a retryable one (storage/renderer hiccup) puts the row
back to QUEUED and lets the queue's backoff run, so a request is never left at RUNNING. `report.ready`/`report.failed`
notify the requester only (`payload.userId`), not every holder of `report.view`.

A report type the worker's build has never heard of (not in its `REPORT_TYPES`) was queued by a newer API: the row goes
back to QUEUED with "being updated" and is retried every 10 minutes until the job's last attempt, like a job type the
worker has no handler for. On 2026-10-01 every Monthly Attendance Summary failed as "This report type is not available
yet." because the 2026-09-29 deploys skipped the reports worker, whose build predated `monthly_summary`. Deploy with the
target `all`, or `reports` straight after `both`, whenever a change adds a report type.

`EXPORT_EMPLOYEES` (the employee list's bulk export) creates its own `report_requests` row of type
`employee_directory` and then runs the same pipeline, which is what gives it a download in "My reports".

## Sharing, schedules and each employee's own copy

`POST /reports/share` ("Send to…"), a schedule's run and "Run now" queue ONE `RUN_REPORT_SCHEDULE` job on the **`processing`**
queue (`REPORT_DELIVERY_QUEUE`, general worker): it only resolves recipients and queues one `GENERATE_REPORT` per copy on the
`reports` queue (the Chromium machine). Until 2026-09-29 the fan-out also sat on `reports`, and the reports worker — deployed
separately and not redeployed since 2026-09-09 — had no handler for it: every share died as `NO_HANDLER` and nothing reached a
recipient. Since then a worker that meets a job type it does not know puts it back for 10 minutes (up to its max attempts)
instead of dead-lettering it, and the Deploy workflow's default target `all` ships the API, the worker and the reports worker
together.

Each recipient's copy is generated under their own access (`scopeReportForRecipient`): the organisation, their branches, their
team — or, for somebody without report access (an employee with `attendance.view_own` and a linked employee record), **the report
about themselves** (scope `SELF`: `employeeIds = [own]`, marker `selfEmployeeId`; attendance report types only — never the
employee directory or the audit trail). This is Flowza Finance's "each employee receives their own attendance report": share a
monthly report with the Employee role and every employee gets theirs, in-app and/or by e-mail. The copy opens in the portal at
`/my/reports` (`GET /me/reports`); `GET /reports/:id/download` admits such a copy to its employee without `report.export`
(everything else still needs `report.view` + `report.export`).

**Viewing.** `GET /reports/:id/download?disposition=inline|attachment` (default `attachment`: the signed URL downloads the file
under the report's name; `inline` lets the browser show it). The web report viewer shows a PDF in place and a CSV as a table
(first 500 rows); Excel files download. Report notices link to `/reports?view=<id>` (or `/my/reports?view=<id>` for an
employee's own copy) — the file is always fetched through the reader's session, never a mailed bearer link.

## Code layout

| Path | Role |
|---|---|
| `packages/domain/src/reports/` | Pure: hours notation (`9.45` = 9 h 45 min), clocks and dates, natural employee-number sort, attendance codes and legend, OT1/OT2/UT derivation, IN/OUT pairing from the trace, en/ar labels |
| `apps/worker/src/handlers/reports/model.ts` | `ReportDocument` — the renderer-neutral document every definition produces |
| `…/context.ts` | Tenant context per report: company, zone, locale, settings (notation, code overrides), leave types, departments, parameter scope |
| `…/data/roster.ts`, `…/data/records.ts` | Employees with the display fields the layouts print; daily records with the leave type joined and the trace punches |
| `…/definitions/*.ts` | One file per report type; `definitions/index.ts` is the registry — it must agree with `status: 'available'` in `REPORT_TYPE_DEFINITIONS` (tested) |
| `…/render/{csv,xlsx,html}.ts` | The three views of one document. CSV/XLSX flatten group headings and header fields into leading columns and escape formula-leading text; PDF is HTML → headless Chromium |
| `apps/worker/src/lib/pdf.ts` | Chromium renderer (playwright-core); refuses non-retryably when `CHROMIUM_PATH` is unset |
| `fly.reports.toml`, `apps/worker/Dockerfile` (`WITH_CHROMIUM=1`) | The dedicated reports worker: `reports` queue only, 1 GB, Chromium + Noto fonts |

## Conventions the samples fix

- **Hours notation** — `settings.reports.hoursNotation`: `h.mm` (default; `9.45` is nine hours forty-five, never a
  decimal) or `hh:mm`. Spans (Wrk Hrs) are always `H:MM`. CSV/XLSX carry minutes as numbers; the notation is for print.
- **Attendance codes** — statuses map to `PR AB OF HL HDP HDL MP`; a LEAVE day prints the tenant's `leave_types.code`
  (AL, SL, CL, …). `leave_types.treat_as_present` (Site Duty) counts with present days; unpaid leave (`is_paid=false`,
  No-Pay) counts with absences. `MP` (engine 1.3.0, 2026-10-02 field report) is a missing-punch day (status
  `MISSING_PUNCH`: a check-in or check-out is missing, hours unknown). It used to print `PR` and count as present with 0 h;
  it now counts on its own — outside T/PR, T/OL, T/AB and the absence counts, in the Summary Report's trailing `MP` column and
  the monthly summary's Missing punch — until the punch is corrected, with a footer note on the Monthly Attendance and
  Summary reports. `settings.reports.codeOverrides` renames the status codes per tenant (a tenant may print `MP` as `PR`,
  but the day still counts as a missing punch). The legend under each report is generated from the effective set.
- **OT1 / OT2 / UT** — OT1 = REGULAR overtime, OT2 = overtime worked on a weekly off or holiday, UT = base − worked
  when positive (a single punch is short by the whole base). Values come from the engine under the tenant's rule set;
  the legacy vendor's own rounding is *not* emulated (decision #4 of the plan).
- **Rows per day** — one per IN/OUT pair from the record's trace: PAIRED interpretation prints several rows for one
  employee as the samples do; FIRST_LAST prints one.
- **Grouping and order** — department name (alphabetical; employees without one under "N/A"), then employee number in
  natural order (`2001 < 2010 < 2076`, `334 < 1171 < OM190`), then time.
- **Header/footer** — company `display_name`, title, period wording per report (`Wednesday, 1 November, 2017`,
  `From 01-Nov-2017 To 30-Nov-2017`, …); footer with generation stamp and `Page X of Y`; landscape for Summary,
  Monthly, Weekly and the Employees Report (its Shift and Policy columns wrap in portrait).
- **Locale** — `parameters.locale` (`en`/`ar`, default the organisation's); Arabic renders RTL with Arabic labels and
  the `name_ar` of departments, designations, shifts and leave types where present.
- **Dates** — tabular dates use `settings.general.dateFormat`; period headers use `dd-MMM-yyyy`; clocks use
  `settings.general.timeFormat` (`8:39 am` / `08:39`); weeks start on `settings.general.firstDayOfWeek`.

## Sample → report type

| # | Sample | Key | Status |
|---|---|---|---|
| 1 | Daily Report | `daily_attendance` | available (Phase 0) |
| 2 | Detail Report | `employee_attendance` | available (Phase 1) |
| 3 | Summary Report | `attendance_summary` | available (Phase 2) |
| 4 | Monthly Attendance Report | `monthly_attendance` | available (Phase 1) |
| 5 | Weekly Report | `weekly_attendance` | available (Phase 2) |
| 6 | Staff Absents Monthly Report | `absence_report` | available (Phase 1) |
| 7, 9 | Staff Casual / Sick Leave Report | `leave_report` (`leaveTypeCode`) | available (Phase 2) |
| 8 | Staff Late Attendance Report | `late_report` | available (Phase 1) |
| 10 | Missed Punch Report | `missing_punch_report` | available (Phase 1) |
| 11, 12 | Employees Report / Inactive employee | `employee_directory` (`employmentStatus`) | available (Phase 0) |
| 13 | Audit Trail Report | `audit_report` (`scope=attendance`) | available (Phase 3) |
| 14 | Weekly In/Out Report | `weekly_in_out` | available (Phase 2) |
| — | Monthly Attendance Summary (the attendance summary page as a file) | `monthly_summary` | available (HR portal Prompt 6a review) |
| — | Monthly Detail Report (the Daily Report's detail for a whole month) | `monthly_detail` | available |
| — | Monthly Timesheet Report (each employee's month, a row per day: check-in/out against the shift's hours) | `monthly_timesheet` | available |

The **Daily Report** takes an optional `to` (HR portal Prompt 6a review, ATT-21): each day of a range of at most
`DAILY_REPORT_MAX_DAYS` (62) days, the date heading each day's departments (a Date column in spreadsheets); the API, the
worker and the form apply the one rule `dailyReportRangeTooLong` (contracts). Whole-month types (`monthly_attendance`,
`monthly_summary`) accept `from`/`to` inside the month: a schedule's *month to date* passes the exact days, so the file stops at
the period's last complete day. **`monthly_summary`** reads `attendanceSummaryRows` (`@flowza/database`), the one definition the
summary page, the profile's month strip and the print statement use; its scope (the requester's branches — days included —, a
line manager's team, the page's search) and `finalizedFigures` (payroll.view) travel in the parameters; the total row prints in
PDF (a spreadsheet recomputes it). `POST /attendance/summary/export` queues it (202 + report id). Days of employment before
the generation date that have no calculated record (a month never recalculated, see the materialisation job in
docs/attendance-engine.md) are in no other column: when there are any, the report adds a **Not calc.** column and a footer
note saying to recalculate the month, instead of letting Present + Absent + Leave + Weekly off fall short of the month.

The **Monthly Attendance Report** has a **Layout** parameter (`layout`, request form, schedules and "Send to…"): `summary`
(default — the sample's codes grid) or `detailed` (`definitions/monthly-detailed.ts`, asked for on 2026-10-01: "as the daily report
shows each person's logs, in the monthly report"). Detailed is the Daily Report's rows for every day of the month, one portrait page
per employee: the identity block (Employee, Dept, Card No, Shift, Designation, Days per code + LOP) above Date | Att Code | IN Time
| OUT Time | Wrk Hrs | Tot Hrs | Base Hrs | OT1 | OT2 | UT — one row per IN/OUT pair with the hours on the day's last row
(`punchRows`, shared with the Daily Report), the code alone on a day without punches, the date alone on a day without a record —
and a Total row (Tot, Base, OT1, OT2, UT; Wrk Hrs has none, since a multi-visit day prints only its last visit's span). Spreadsheets
get the identity block as leading columns and one row per printed row.

The **Monthly Detail Report** (`monthly_detail`) is the Daily Report's detail for a whole month, for every employee the Monthly
Attendance Report lists: one block per employee — the identity block (Employee, Dept, Card No, Shift, Designation, and **Days**:
days per attendance code in the legend's order, plus loss-of-pay days when there are any) above a grid whose columns are the days
of the month (weekday under the day number) and whose rows are Att Code, IN Time (first IN), OUT Time (last OUT), Wrk Hrs (the
IN → OUT span, `h:mm`), Tot Hrs, Base Hrs, OT1, OT2, UT, Late and Early, with a Total column for the hour rows. A zero prints
as an empty cell (spreadsheets keep the 0 for a worked day) so overtime, under time and lateness stand out across the month.
It prints landscape with `density: 'compact'` (7 pt, ruled rows) and `keepTogether` sections, so a block never splits across
pages — two blocks on the first page, three on the next. Spreadsheets get the identity block as leading columns and one row per
grid row (eleven per employee, which is what `row_count` records), so the cell cap allows about 680 employees per file (narrow by branch or department beyond that).

The **Monthly Timesheet Report** (`monthly_timesheet`) answers "did each person do their shift's hours (say 8), and by how much over
or under", for the same roster: one portrait page per employee — the identity block (Employee, Dept, Card No, Designation, and
**Shift Hours Met**: `18 of 22`, the days the shift's hours were met out of the days that could be judged) above one row per day
of the month: Date, Shift (the shift the day was calculated under, so a rotation shows), Att Code, Check In (first IN), Check Out
(last OUT), Shift Hrs (Base Hrs: the shift's span less unpaid breaks, or a flexible shift's required minutes), Worked Hrs (Tot Hrs),
**Hours Met**, Overtime (OT1 + OT2: weekly-off and holiday work included), Under Time, Late and Early, then a Total row (with
`met/judged` under Hours Met). Hours Met is `shiftHoursVerdict` (`packages/domain/src/reports/derive.ts`): **Yes** when Tot Hrs ≥
Base Hrs, **No** when short (the gap is the day's UT), **Missed punch** when the check-in or check-out is missing; blank on a day not
worked (its code says why) and on worked days that required nothing (a weekly off or holiday: all of it is overtime). Spreadsheets
get the identity block as leading columns and one row per day (`row_count` = employees × days; the total rows stay out of the
sheet), so the cell cap allows about 670 employees per file.

Types not in the sample set (`branch_attendance`, `department_attendance`, `overtime_report`, `device_sync_report`,
`device_health_report`, `payroll_summary`) are `planned`: hidden from `/report-types`, refused by `POST /reports`, and
each becomes a one-file follow-up on this engine.

## Limits and operations

- **Size** — one file holds at most `MAX_REPORT_CELLS` (250 000) rows × columns; a larger request fails at build time with
  a message that says to narrow the period or split by branch or department. The queue's per-organisation concurrency
  keeps one tenant's reports from crowding out another's.
- **Timeout** — 15 minutes per job (the runner's default is 5 for device calls).
- **Where PDF runs** — the `flowza-time-reports` app (`fly.reports.toml`, deploy workflow target `reports`), 1 GB, built with
  `WITH_CHROMIUM=1`. The general worker refuses PDF non-retryably. Decision record: `docs/adr/ADR-008-report-rendering.md`.
- **Renderer test** — `apps/worker/src/lib/pdf.test.ts` proves the refusal everywhere and renders a real PDF where
  `CHROMIUM_PATH` points at a Chromium (CI installs one for the worker job).
- **Logs** — `report_generated` (type, format, rows, bytes, ms) and `report_failed` (type, code, retryable).
- **Retention** — files expire 7 days after completion (`expires_at`); the maintenance sweep removes them and marks the row
  EXPIRED.

## Adding a report type

1. Add the key to `REPORT_TYPES` (`packages/contracts/src/enums.ts`) and its entry to `REPORT_TYPE_DEFINITIONS`
   (`dto-features/reports.ts`) with `status: 'available'`, orientation, default format, parameters, permissions.
2. Write `apps/worker/src/handlers/reports/definitions/<key>.ts` exporting a `ReportDefinition` whose `build` loads
   through `data/*` and returns a `ReportDocument`; register it in `definitions/index.ts`.
3. Add labels to `packages/domain/src/reports/labels.ts` (both locales) and the catalogue name/description to
   `apps/web/src/locales/{en,ar}/reports.json`.
4. Tests: a `generate.test.ts` case with a fixture that reproduces the sample's visible values, and a domain test for
   any new derivation. `definitions/index.test.ts` fails until the registry and the catalogue agree.

## Delivery checklist

- [x] Phase 0 — engine, renderers, Chromium worker, `daily_attendance`, `employee_directory`, `EXPORT_EMPLOYEES`, planned types hidden, requester-only notifications
- [x] Phase 1 — `employee_attendance`, `monthly_attendance`, `absence_report`, `late_report`, `missing_punch_report`
- [x] Phase 2 — `attendance_summary`, `weekly_attendance`, `weekly_in_out`, `leave_report`
- [x] Phase 3 — `audit_report` attendance scope + PDF
- [x] Phase 4 — web parameter forms (week, leave type, status, scope), Settings → Reports, leave-type seeding
- [x] Phase 5 — hardening (streaming, cell cap), golden renders in CI, reports worker deployed, docs and go-live
