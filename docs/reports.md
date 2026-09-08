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

Failure policy: a non-retryable error (bad parameters, unknown type, no Chromium on this worker) sets FAILED with the
user-safe message and emits `report.failed`; a retryable one (storage/renderer hiccup) puts the row back to QUEUED and
lets the queue's backoff run, so a request is never left at RUNNING. `report.ready`/`report.failed` notify the
requester only (`payload.userId`), not every holder of `report.view`.

`EXPORT_EMPLOYEES` (the employee list's bulk export) creates its own `report_requests` row of type
`employee_directory` and then runs the same pipeline, which is what gives it a download in "My reports".

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
- **Attendance codes** — statuses map to `PR AB OF HL HDP HDL`; a LEAVE day prints the tenant's `leave_types.code`
  (AL, SL, CL, …). `leave_types.treat_as_present` (Site Duty) counts with present days; unpaid leave (`is_paid=false`,
  No-Pay) counts with absences. `settings.reports.codeOverrides` renames the status codes per tenant. The legend under
  each report is generated from the effective set.
- **OT1 / OT2 / UT** — OT1 = REGULAR overtime, OT2 = overtime worked on a weekly off or holiday, UT = base − worked
  when positive (a single punch is short by the whole base). Values come from the engine under the tenant's rule set;
  the legacy vendor's own rounding is *not* emulated (decision #4 of the plan).
- **Rows per day** — one per IN/OUT pair from the record's trace: PAIRED interpretation prints several rows for one
  employee as the samples do; FIRST_LAST prints one.
- **Grouping and order** — department name (alphabetical; employees without one under "N/A"), then employee number in
  natural order (`2001 < 2010 < 2076`, `334 < 1171 < OM190`), then time.
- **Header/footer** — company `display_name`, title, period wording per report (`Wednesday, 1 November, 2017`,
  `From 01-Nov-2017 To 30-Nov-2017`, …); footer with generation stamp and `Page X of Y`; landscape for Summary,
  Monthly and Weekly.
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

Types not in the sample set (`branch_attendance`, `department_attendance`, `overtime_report`, `device_sync_report`,
`device_health_report`, `payroll_summary`) are `planned`: hidden from `/report-types`, refused by `POST /reports`, and
each becomes a one-file follow-up on this engine.

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
- [ ] Phase 5 — hardening (streaming, cell cap), golden renders in CI, reports worker deployed, docs and go-live
