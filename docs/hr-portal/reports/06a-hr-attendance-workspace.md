# Phase 6a — HR attendance workspace parity

**Prompt:** `docs/hr-portal/prompt-pack.md` §Prompt 6a (+ the implementing brief: calendar register, Add / Edit record with a policy preview, Auto / Manual source, bulk status, punch timeline, Sync punches, monthly summary + CSV, unmatched-punch triage, report sharing and schedules, employee attendance tab, tests).
**Branch:** worktree branch `worktree-agent-ac764ab9705f35c98` (from `215eede`) · **Migration:** `supabase/migrations/20260928000600_hr_attendance_workspace.sql` · **Date:** 2026-09-28.
**Status:** every gate green (§6); nothing applied to the hosted project. Not built here (parallel prompts): approval engine v2 (Prompt 2), attendance notes / regularisation / self check-in / selfie / geofences / shift swaps / grants (Prompt 4), Leave v2 (Prompt 7).

## 1. What shipped

### Register (`/attendance`)
- **Calendar tab** (`?tab=calendar&month=YYYY-MM`, shares the month / branch / department / employee / search filters with the Monthly tab): one month grid per employee (12 per page, week starting on the organisation's `general.firstDayOfWeek`). Each day: status colour (the Monthly grid's palette), status letter, up to four **flag dots** (one per colour family: late, early out, missing IN/OUT, overtime, worked on a non-working day, half-day leave, unexcused / LOP, outside geofence), a pencil **Manual marker** when the status is an applied `SET_STATUS`, and a ring on **today** (the API's organisation-zone today). The native tooltip (also the accessible name) reads status (+ source), in–out, worked, late, early, overtime and the remaining flags. A day with a record opens the record dialog; an **empty past day** inside employment opens HR's **Add record** for that employee and date. Legend + a collapsible **Flowza Finance status mapping** table (§2).
- **Add / Edit record** (header **Add record**, the record dialog's **Edit record**, the timeline's **Edit record**, an empty calendar day). Shown only with `attendance.view` + `attendance.correct` + `attendance.approve`; the API requires the same three. The dialog loads the day as the engine sees it (`POST /attendance/preview` — the pure engine on the real inputs, **nothing written**): the **expected shift** and times, the current outcome, and — debounced — the **policy-derived outcome after the change** (status, flags, in, out, worked, late, early, OT) with the exact **correction plan** it will file (`Add punch` / `Move punch` / `Set status`). Check-out before check-in is refused (client and API; a next-day checkbox covers night shifts); a reason (≥ 3 characters) is required; a locked period disables saving. Only the times the user actually **changed** are sent (the prefill is minute-precise, a device punch may carry seconds — an untouched time never becomes an `EDIT_PUNCH`). `POST /attendance/record-edits` files the plan through the exported `createCorrection` (one call per item, unchanged): auto-approved and applied by the worker for HR unless an approval workflow says otherwise; the response reports `applied`, and a later item's failure after earlier ones were filed (`failed`).
- **Auto vs Manual**: Daily rows show an `Auto` / `Manual` chip (`GET /attendance/manual-statuses` — days whose latest applied `SET_STATUS` overrides the engine; the daily DTO is untouched), the record dialog shows the source (from its applied corrections), the calendar shows the marker.
- **Bulk set status**: Daily-tab row selection (HR edit permissions) → **Set status** → one status + one reason → `POST /attendance/bulk-status` (≤ 200 items, one `SET_STATUS` correction each). Items are independent; per-item results (locked period, out of scope, duplicate …) are listed in the dialog.
- **Punch timeline drawer** (row action on the Daily tab, footer button of the record dialog): `GET /attendance/timeline` — every event of the day's window with the engine's role (IN, OUT, duplicate, ignored, out of window …), voided punches, corrections; for `attendance.view_raw` holders the raw device transactions with the allow-listed self-service facts (channel, geofence verdict + distance, accuracy, mock location, out of window). Without `view_raw` the drawer says why raw rows are absent.
- **Sync punches** (header, `attendance.recalculate`): recomputes exactly what the register shows — the Daily tab's day, else the Monthly / Calendar month up to today, with its branch / department / employee filter — as one `RECALCULATE_RANGE` (existing `POST /attendance/recalculate`). A branch-scoped member must pick a branch or an employee first. The toast's **Follow** goes to `/attendance?tab=recalc&request=<id>` (the Recalculations tab badges that request) — never `/sync/:id`.
- **Recalculations tab fix**: the job column linked `/sync/<queue job id>` (a queue job the sync page cannot show); it now shows the id as text (support) and the status column tracks the job. The Recalculate dialog's toast also points at its request.

### Monthly summary (`/attendance/summary`)
`GET /attendance/summary?month&branchId&departmentId&employeeId&search&page&pageSize` — one SQL pass under the caller's RLS (`attendance.view`, branch scoped; or `attendance.view_team` → direct reports): per employee present (half day = ½), late, half days, leave, absent, missing punch, holidays, weekly offs, days worked, worked, average per worked day, overtime, LOP, unexcused, pending; the month totals over the whole filtered set. A month whose payroll period summary is **finalised** (and the caller holds `payroll.view`) shows the finalised day counts (`source: FINALIZED`). Month navigation, filters, totals cards, row → the employee's calendar, print icon → the print view. **Export CSV** (`GET /attendance/summary/export`) only with **`report.export`** (the button is hidden without it; the API refuses): formula-safe cells (`= + - @ \t \r` prefixed with `'`), UTF-8 BOM, TOTAL row, ≤ 10 000 rows, 30 exports / organisation / hour, audited `attendance.summary_exported` with the row count and filters.

### Unmatched-punch triage (`/attendance/unmatched`, `attendance.view_raw`)
`GET /attendance/unmatched` groups raw punches the normaliser could not attribute by (device, device user id) with count, first / last punch, last received and up to three suggestions (employee whose device user id or employee number equals the id). With **`device.sync`**:
- **Assign** → `POST /attendance/unmatched/assign` writes the mapping the normaliser reads **first** (`device_employee_states`, desired, IN_SYNC) — a device user id already mapped to someone else, or the employee already mapped to another id on that device, is a **409**, never silently re-pointed — then re-queues the group (`unmatched` → `pending`) and enqueues `NORMALIZE_RAW` (deduped per organisation). Audited `attendance.unmatched_assigned`.
- **Ignore** (reason required) → `processing_status = 'ignored'` (the raw rows stay immutable otherwise), audited `attendance.raw_ignored`; the **Ignored** tab (180 days) offers **Restore** (`attendance.raw_restored`).
Without `device.sync` the page is read-only and says so. The reconciliation page's unmatched counter links to the triage for that device.

### Report sharing and schedules (Reports page)
- **Send now** (`report.schedule`): the request form's **Send to…** takes the same validated type / format / parameters → recipients (line managers, whole roles resolved at run time, individual members), channels (in-app, email), optional note → `POST /reports/share` (202; the sender needs the type's permissions and a branch when branch-scoped; ≤ 50 users + 10 roles, ≤ 100 resolved; 10 shares + run-nows / organisation / hour).
- **Schedules** panel (`report.schedule`): monthly (day 1–28) or weekly (weekday) at a local time; period previous month / month to date / previous week / custom cut-off (day *n* of the previous month → an earlier day of the run month); filters of the type (branch, department, employees, leave type, employment status, scope); recipients; channels; active switch; next run + next period, last run + summary (sent / skipped); **Run now**, edit, pause / resume, delete. `report_schedules` CRUD: `GET|POST /report-schedules`, `GET|PATCH|DELETE /report-schedules/:id`, `POST /report-schedules/:id/run-now`.
- **Worker**: scheduled task **`reports.schedules`** every 5 minutes (leader-elected, enqueue-only) scans due schedules in active / trial organisations (platform context, ≤ 200 per tick) and enqueues one `RUN_REPORT_SCHEDULE` per occurrence (dedupe key `report-schedule:<id>:<scheduledFor>`). The handler (`handlers/reports/deliveries.ts`) resolves recipients at run time and, **per recipient**, decides the scope under which that recipient could request the report themselves (`scopeReportForRecipient`, domain): needs `report.view` + `report.export` + the type's permissions — or their `_team` variant, which narrows the report to the recipient's direct reports; a branch-scoped recipient gets their branches. Eligible recipients get their own `report_requests` row (`requested_by` = the recipient) + a `GENERATE_REPORT` job; ineligible ones a `skipped` delivery with the reason. `report_deliveries` is unique per (organisation, run key, recipient), so a retried occurrence is a no-op; `next_run_at` advances idempotently; a late run covers only the latest missed occurrence.
- **Notification**: when a delivered copy completes, `report.scheduled_delivery` (appended to `DOMAIN_EVENT_TYPES` + the outbox ROUTING) notifies exactly that recipient through the chosen channels (in-app off ⇒ the in-app row is created read; email off ⇒ no email). The link is **`/reports?download=<reportId>`**: the Reports page mints a 5-minute signed URL through the recipient's own session (re-checking `report.export`). No bearer link is ever mailed.
- **Delivery log**: `GET /report-deliveries` — a recipient sees their own rows; a scheduler all (branch-scoped schedulers: what they sent, received or can see) — with the scope each copy was generated under or the skip reason.
- **`report.export` everywhere the app exports**: report downloads (API + the Download button), the employee export (API + both Export buttons), the summary CSV.

### Employee profile → Attendance tab
A month strip (present, late, half days, leave, absent, missing punch, worked, overtime) from the monthly row it already loads (no extra request) and a **Print view** link → `/attendance/print?employeeId&month`: a print-friendly monthly statement (every day with status, Manual marker, in, out, worked, late, early, OT, flags; month totals; signature lines; the app chrome is hidden when printing; the browser saves it as PDF).

### Database — one additive, idempotent migration (single-transaction safe; no enum value added)
- **`report_schedules`** (+ `report_schedules_platform_ctx` SELECT for the scheduler, due index on `next_run_at where is_active`): cadence / run day / run time / period rule / custom days CHECKs, recipients shape CHECK, channels CHECK, composite branch FK. RLS via `app.apply_tenant_policies(…, 'report.view', 'report.schedule', 'branch_id')`.
- **`report_deliveries`**: per-recipient trail, unique (organisation, run key, recipient), composite FK to `report_requests` (which gains a unique `(id, organization_id)` index). SELECT: `report.schedule` holders and the recipient; writes: system context only, **and** `insert/update/delete` revoked from `authenticated` (a client write raises).
- Post-verify blocks assert the policies, the revoke and the index; the RLS safety net runs.
- `processing_status = 'ignored'` uses the existing enum value; nothing else in the schema changed.

### Engine inputs, one loader
`loadDailyInputs` (and its helpers) moved from `apps/worker/src/handlers/attendance/load-inputs.ts` to `packages/database/src/attendance/load-inputs.ts`; the worker file is now a re-export, so the recompute and the API's preview run the engine on **the same** loader. See §7 (integration note).

## 2. Flowza Finance statuses → FlowZa (documented in the calendar legend)

| Finance status | FlowZa status | Flags | Note |
|---|---|---|---|
| present | PRESENT | — | present without `LATE` |
| late | PRESENT (or HALF_DAY) | `LATE` | late is a flag, so it combines with a half day |
| half_day | HALF_DAY | (`HALF_DAY_LEAVE`) | half-day leave adds the flag |
| absent | ABSENT | (`UNEXCUSED` / `LOP`) | after the day-close review decides |
| on_leave | LEAVE | (`HALF_DAY_LEAVE`) | a half-day leave shows as HALF_DAY / PRESENT + the flag |
| holiday | HOLIDAY | — | |
| weekend | WEEKLY_OFF | — | |
| incomplete | PRESENT / HALF_DAY / ABSENT | `MISSING_IN`, `MISSING_OUT` | status per the rule set's `missing_punch_behavior` |
| holiday_work | HOLIDAY | `WORKED_ON_HOLIDAY`, `NON_WORKING_DAY_WORK` | |
| weekly_off_work | WEEKLY_OFF | `WORKED_ON_WEEKLY_OFF`, `NON_WORKING_DAY_WORK` | |

## 3. Acceptance items (`finance-hr-attendance-module.md` Appendix A)

| Item | | How |
|---|---|---|
| ATT-01 register guarded by view | ✅ | `/attendance` = `attendance.view` (existing); summary = view or view_team; triage = view_raw |
| ATT-02 "Today" cards | ✅ (existing) | Daily tab cards (present / absent / leave / half day / missing punch) from `meta.byStatus`; late is a flag filter |
| ATT-03 table / calendar toggle, current month | ✅ | Calendar tab next to Daily / Monthly |
| ATT-04 range, employee, search | ✅ | month navigation, employee / branch / department pickers, search (server side) |
| ATT-05 chips for ten statuses | ↔ | FlowZa keeps status + flags (§2): status filter + flag filter; the mapping is documented in the legend |
| ATT-06 recompute → rows → derived rows | ↔ | the engine materialises every day asynchronously; **Sync punches** recomputes the shown range on demand |
| ATT-07 derived rows badge | n/a | no synthetic rows: every day is a stored engine record |
| ATT-08 H:M, short days, OT | ✅ | worked / late / early / OT columns; summary in h:mm |
| ATT-09 per-day punch timeline | ✅ | Punch timeline drawer |
| ATT-10 zone badge | → Prompt 4 | the timeline shows the geofence verdict of a raw punch; the register badge ships with geofences |
| ATT-11 status colour map | ✅ | shared palette; unknown → muted |
| ATT-12 calendar grid | ✅ (per employee) | a month grid per employee (not names per day): today ring, legend, tooltips, click-to-open / click-to-add |
| ATT-13 Add record | ✅ | employee, date, in / out, status (+ hint), reason; hours are the engine's (preview) |
| ATT-14 Edit record | ✅ | in / out / status + reason; hours and overtime stay engine-derived (never typed) |
| ATT-15 live classifier preview, manual on touch | ✅ | `POST /attendance/preview`; choosing a status files `SET_STATUS` (= Manual) |
| ATT-16 "Use auto status" | ✗ | a `SET_STATUS` cannot be withdrawn by a correction today (§8) |
| ATT-17 block out-before-in; night shift | ✅ | client + API; next-day checkbox; non-working days are recorded, not blocked (Prompt 3 decision) |
| ATT-18 bulk set status | ✅ | `POST /attendance/bulk-status`, per-item results |
| ATT-19 friendly errors | ✅ | API `AppError` messages; per-item codes in bulk; period-lock toast |
| ATT-20 one record per employee-day | ✅ (existing) | unique (employee, date) on daily records |
| ATT-21 CSV of the range | ✅ | Reports (Daily / Detail / Summary reports in CSV / XLSX / PDF) + the summary CSV |
| ATT-22 Excel + PDF report, logged | ✅ (existing) + `report.export` | downloads now need `report.export`; `report.exported` audit |
| ATT-23 comments & approvals panel | → Prompt 4 | attendance notes |
| ATT-24 open-attendance grants | → Prompt 4 | |
| ATT-25 selfie review | → Prompt 4 | |
| ATT-26 monthly summary | ✅ | `/attendance/summary` |
| ATT-27 summary CSV gated + logged | ✅ | `report.export`, `attendance.summary_exported` with row count |
| ATT-47 manual Sync recompute | ✅ | Sync punches (`attendance.recalculate`) |
| ATT-56 PIN → employee per device, collisions, backfill | ✅ (one group at a time) | Assign writes `device_employee_states` (409 on collision) and re-queues past punches; no bulk mapping |
| ATT-57 unmapped inbox | ✅ | `/attendance/unmatched` |
| ATT-58 punch log | ✅ (existing) | Raw transactions tab |
| ATT-107 share now | ✅ (differs) | in-app + email; **no WhatsApp**; the copy is generated **per recipient under their own scope**; the link is an in-app deep link (5-minute signed URL on click), **not a 7-day bearer link** |
| ATT-108 monthly schedules | ✅ (+ weekly) | run day 1–28, previous month / MTD / custom cut-off, recipients (managers, roles, members), channels, active, next / last run; **no external email addresses** (members only) |
| ATT-109 scheduler | ✅ (differs) | every 5 min, leader-elected, advances `next_run_at`; sends the report file per recipient, not HTML summaries |
| ATT-110 CRUD by manage, logged | ✅ | `report.schedule` (RLS + API), audited `report_schedule.*` |
| ATT-111 HR calendar feed URL | ✗ | not shipped (§8) |
| ATT-112 employee tab + print | ✅ | month strip + print view |

## 4. Endpoints (all new; no existing route changed)
`POST /orgs/:orgId/attendance/preview` · `POST …/attendance/record-edits` (idempotent) · `POST …/attendance/bulk-status` (idempotent) · `GET …/attendance/manual-statuses` · `GET …/attendance/calendar` · `GET …/attendance/summary` · `GET …/attendance/summary/export` · `GET …/attendance/timeline` · `GET …/attendance/unmatched` · `POST …/attendance/unmatched/assign|ignore|restore` · `GET|POST …/report-schedules` · `GET|PATCH|DELETE …/report-schedules/:id` · `POST …/report-schedules/:id/run-now` (202) · `POST …/reports/share` (202) · `GET …/report-deliveries` · `GET …/report-recipients`.

## 5. Decisions (Security > Reliability > Data Integrity > Scalability > Maintainability > Performance > UX)
1. **Every edit is a correction.** Add / Edit / bulk file `ADD_PUNCH` / `EDIT_PUNCH` / `SET_STATUS` through `createCorrection` (called, never copied); raw stays immutable, the engine recomputes, every change is audited and replayable. Hours and overtime are never typed.
2. **The preview runs the real engine on the real inputs** (the worker's loader, moved to `@flowza/database`) under the caller's RLS for the employee and the system scope for the loader — one code path, so the preview cannot drift from the recompute. It writes nothing.
3. **Only changed times are proposed**, so an untouched punch with seconds is never "moved" by a minute-precise form.
4. **HR edit = `attendance.view` + `attendance.correct` + `attendance.approve`**: correcting and applying in one step is an approver's act; line managers (view_team + correct + approve) keep the Corrections flow.
5. **Bulk items are independent** (one correction each, per-item result) rather than all-or-nothing: a locked day must not block the other 199.
6. **Auto / Manual without changing the daily DTO**: a separate `manual-statuses` read (backward compatibility for the current web bundle).
7. **Shared reports are generated per recipient under the recipient's own access** — never a copy of the sender's data; a recipient without `report.export` + the type's permissions is skipped with a reason. Recipients are members only (no external addresses) and the notification carries an in-app link; the signed URL is minted on click, for 5 minutes, re-checking `report.export`.
8. **Scheduler = enqueue-only** (leader-elected task + deduped jobs); the handler is idempotent per occurrence (unique run key per recipient, stale / not-due / inactive checks, a savepoint around the fan-out). Missed occurrences are not replayed one by one: a late run covers the latest.
9. **Month to date ends yesterday; custom = the last complete cut-off period** — a scheduled report never contains a half-computed day.
10. **Unmatched Assign writes the first identity the normaliser reads** (`device_employee_states`) and refuses collisions (409) instead of re-pointing an existing mapping.
11. **Summary figures mirror `summarisePeriod`** (half day = ½ present), in SQL for the whole filtered set (totals), paginated for the page; finalised period summaries win when visible.
12. **Exports**: `report.export` required, formula escaping, quota, audit with row count (AGENTS.md).
13. **Unmatched `ignored`** uses the existing `raw_processing_status` value: no enum change (single-transaction apply stays safe).

## 6. Verification (local Postgres @ 127.0.0.1:54329; shared DB suites under `flock /tmp/flowza-dbtests.lock`)

| Gate | Result |
|---|---|
| `pnpm build:packages` | ✅ |
| `pnpm lint` (max-warnings 0) | ✅ |
| `pnpm -r --filter "./apps/*" run typecheck` | ✅ api, web, worker |
| `pnpm test:unit` | ✅ shared 4 · contracts 5 · domain 229 (16 files, incl. `reports/schedule.test.ts` 21) · device-providers 165 · database 20 |
| `pnpm --filter @flowza/web run test` | ✅ 61 files / 237 tests (new: calendar, add / edit dialog + validation, bulk bar, timeline drawer, summary + CSV gating, unmatched, print, schedules + share, reports page `report.export` + `?download=`, workspace utils, en/ar parity) |
| RLS suite (`flowza_p6_rls`) | ✅ "RLS tests passed" (new `supabase/tests/rls_hr_workspace.sql`) |
| `pnpm test:db` | ✅ 2 files / 11 tests |
| `pnpm --filter @flowza/api run test` | ✅ 22 files / 227 tests (new `hr-attendance.test.ts` 17, `report-schedules.test.ts` 10) |
| worker vitest | ✅ 13 files / 132 passed, 1 skipped (new `handlers/reports/deliveries.test.ts` 8) |
| `pnpm -r --filter "./apps/*" run build` | ✅ |
| `PGDATABASE=flowza_p6_ci2 bash scripts/db-reset-local.sh` | ✅ |
| `pnpm db:types` against `flowza_p6` (reset `--seed`) | ✅ no diff to the committed `db.ts` |
| single-transaction replay (`replay-single-tx.sh … flowza_p6_tx`) | ✅ "single-transaction replay OK" |
| `build:e2e` + `test:e2e` (CI=1, `/opt/pw-browsers/chromium`) | ✅ 36 passed (chromium + tablet; new `e2e/hr-attendance.spec.ts`: calendar → add a missing day through the preview → summary) |

## 7. Backward compatibility (the current production web keeps working)
- **No existing route, field, status code or meaning changed.** Every endpoint in §4 is new; the daily / monthly / record DTOs are untouched (the Auto / Manual source is a separate read).
- **Intended change — `report.export` is now enforced** on `GET /orgs/:orgId/reports/:id/download` (on top of `report.view`) and on `POST /orgs/:orgId/employees/bulk` `action: export` (on top of `employee.export`). A role without `report.export` gets **403** where it used to succeed. Covered by `hr-attendance.test.ts` › *"report.export is enforced where the app exports (backward compatibility: 403 without it)"* (manager 403 / owner 200 on download; custom exporter role 403 / owner 2xx on employee export).
- **Who loses export** (system roles, live matrix): `report.export` is held by owner, org_admin, hr_admin, hr_user, branch_manager, attendance_admin, payroll, auditor. Every role holding `employee.export` (owner, org_admin, hr_admin) holds `report.export` — **no system role loses the employee export**. **`manager`** holds `report.view` without `report.export` and **loses report downloads** (it cannot request most report types either, which need `attendance.view`). `employee` has neither. **Custom roles** with `report.view` (or `employee.export`) but without `report.export` lose the download (or the export) until an admin grants `report.export`.
- The web hides what the API now refuses (Download, employee Export, summary CSV) and explains it ("Export not allowed").

## 8. Known limits / follow-ups
- **Integration — the engine loader moved.** `apps/worker/src/handlers/attendance/load-inputs.ts` is now a re-export of `packages/database/src/attendance/load-inputs.ts`. A parallel branch that edits the worker file (e.g. Prompt 4 adding inputs) will conflict there: port its change into the database-package file. Shared registries touched by appending only: `DOMAIN_EVENT_TYPES`, outbox ROUTING (+ a channel filter used only by events that carry `channels`), the sidebar (two items + an `end` rule for nested paths + honouring the declared `any` flag), `routes/v1/features/index.ts`, `tasks/index.ts`, `common.json` nav labels; `handlers/reports/generate.ts` hands a finished delivered copy to `settleDelivery`.
- **No "clear manual status"**: `SET_STATUS` needs a status; returning a day to the engine's status needs a correction type the correction service does not have (ATT-16).
- **Assign** is one (device, id) group at a time; a later device push that reports a canonical id can re-point `device_employee_states`.
- A change of the organisation timezone leaves stored `next_run_at` values until each schedule's next edit or run.
- `hr_admin` does not hold `report.schedule` in the Prompt 1 matrix (only owner, org_admin, payroll can share / schedule); grant it if HR should.
- WhatsApp delivery, external recipient addresses, HTML summaries in the mail body and the HR calendar feed (ATT-111) are not shipped.
- Notification titles of `report.scheduled_delivery` are English, like the other server-generated notifications.
