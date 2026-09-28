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

## 9. Review fixes (adversarial review: `docs/hr-portal/reviews/06a-hr-attendance-workspace-review.md`)

Branch `worktree-agent-a567d09336fc75c27` (base `2b82b16`). One migration, `20260928000820_hr_workspace_review_fixes.sql`: idempotent
(`drop policy if exists` / `create`, `on conflict do nothing`, the status CHECK re-created), additive apart from the replaced
policies, `lock_timeout 5s` / `statement_timeout 120s`, no enum value, safe as one transaction (proven by the single-transaction
replay). `20260928000600` is untouched. Every regression test is named after its defect (`6a-D3 …`, `6a-M12 …`) and sits in the
layer where the bug lived.

### 9.1 Defect → fix → test

| # | Defect | Fix | Regression tests |
|---|---|---|---|
| D1 [P0] | Any `report.view` holder could list and download every report file of the organisation straight from Storage, past `report.export`, branch / team scope, per-recipient scope and download ownership. | `flowza_objects_read`: the `reports` bucket is readable by the organisation's **system context only** (own folder); people download through the API (report.export + ownership, 5-minute signed URL). Every bucket audited for the same class (org-wide key granting objects whose API access is narrower): **employee-photos** now readable exactly when the caller can read `<org>/<employee id>/…`'s employee record (the employees RLS: branch scope, own record, direct reports); **documents** also need the employee inside the caller's branches; writes of both need `employee.update` **and** the employee in branch scope (`organization.manage` keeps only org-logos and imports); the system context writes only its own organisation's folder. Unchanged on purpose: org-logos (every member sees the logo), imports (`employee.import`, as the import jobs). Helper `app.path_uuid(name, part)`. | `rls_hr_workspace.sql` `6a-D1` (manager, branch manager, employee, auditor and both owners read 0 report objects, a user session cannot place or delete one; a line manager reads only their report's photo, a branch manager only their branch's photos and writes only there, an employee only their own photo; identity documents need `employee.view_sensitive`; org logos stay readable; owner B reads nothing of A) · evidence: the reviewer's `storage-probe.sql` re-run after the fix (0 report objects for manager / branch manager / employee / owner B). The local shim grants `flowza_system` nothing on `storage.objects` (the worker uses the service role there), so the system-context clause is proven by the policy text, not a probe |
| D2 [P0] | A branch-scoped HR admin could preview and edit (record edits, bulk, the Corrections page) the days an employee spent in ANOTHER branch before moving into theirs: only the employee's current branch was checked. | `apps/api/src/services/attendance/correction-guards.ts`: `dayOwningBranchIds` = the stored record's branch + the employment history's effective branch on that date (the rule `loadDailyInputs` uses); `requireDayBranchAccess` in `planDay` (preview, record edits) and in **`preValidateCorrection`, called on the first line of `createCorrection`** (bulk status, the Corrections page, every door). The caller's own record keeps the self-service door. | `hr-attendance.test.ts` `6a-D2 …` ×3 (preview 403, record-edit 403, `POST /attendance/corrections` 403 and nothing written; bulk: branch-B item FORBIDDEN, branch-A item applied; same-branch day and an unrestricted HR admin still work) · mutation-checked (removing the guard turns 4 tests red) |
| D3 [P0] | A branch-scoped `report.schedule` holder could re-point, run and delete organisation-wide schedules through the API and PostgREST, rewind `next_run_at` to get a run on every tick past the quota, and read the whole delivery trail. | **API** (`report-schedules.service.ts`): update / delete / run-now read the STORED row in the organisation's system scope and refuse (403) one outside the caller's branches (org-wide = unrestricted only), then check the new specification too; writes go through the service's system step with an optimistic lock (`updated_at`; a concurrent edit is 409). **DB**: no client write policy and no client write privilege on `report_schedules` (a PostgREST write raises); `report_schedules_system_write` for the service / worker; `next_run_at`, `last_*`, `created_by` are server-computed; SELECT for a branch-restricted holder = their branches' schedules only (org-wide rows need an unrestricted membership); `report_deliveries_select` = the recipient, an unrestricted scheduler, or a branch-restricted one for what they sent and their branches' schedules (`listDeliveries` applies the same rule). | `report-schedules.test.ts` `6a-D3 …` ×4 (the reviewer's probe B: re-point 403, run-now 403, delete 403, stored row byte-identical, no job queued; another branch's schedule 403; own branch-B schedule still renamed / run; list = own branch only; a direct user-context UPDATE / DELETE / INSERT → permission denied; the branch scheduler's delivery trail and the direct RLS read agree) · `rls_hr_workspace.sql` `6a-D3` (direct write refused, org-wide rows hidden, deliveries narrowed) · worker `deliveries.test.ts` `6a-D3 nextRunAbuse` (the probe's rewind raises; three ticks admit nothing) · mutation-checked |
| D4 [P1] | Assign on a Flowza Finance connector group wrote a `device_employee_states` mapping the normaliser never reads (it resolves connector rows by employee number) and reported success. | `UNMATCHED_ASSIGN_BLOCKED_PROVIDERS` / `unmatchedAssignBlockedReason` (contracts): `flowza_finance` → `CONNECTOR_RESOLVES_BY_EMPLOYEE_NUMBER`, `self_service` → `SELF_SERVICE_RESOLVES_BY_MEMBERSHIP` (Prompt 4's virtual device, on the integrated branch). `assignUnmatched` refuses with **409 `INVALID_STATE`**, `details.reason` + a message naming the fix; groups carry `assignBlockedReason` and no suggestions; the docstring now says what the normaliser actually reads; Ignore / Restore stay available. Web: no Assign on such a group, the guidance + a link to Raw transactions (where the punches are re-queued after the number is fixed). | `hr-attendance.test.ts` `6a-D4 …` ×2 (group reason + no suggestions; 409 with `details.reason`, no mapping row, rows still `unmatched`, Ignore / Restore work) · `packages/contracts/src/reports.test.ts` `6a-D4` · web `workspace-pages.test.tsx` `6a-D4` · mutation-checked |
| D5 [P1] | Clicking a summary row sent a line manager to `/attendance`, which needs `attendance.view`, so the guard landed them on their own attendance. | A row opens the register calendar for `attendance.view` holders and the employee's **statement view** (`/attendance/print?employeeId&month`, reachable with `attendance.view_team`) for a line manager. | web `6a-D5` (both callers) |
| D6 [P1] | SET_STATUS / punch corrections were accepted for future dates, dates before joining and after exit, and counted in summaries. | `requireDateInEmployment` in `preValidateCorrection` (top of `createCorrection`): ADD_PUNCH / EDIT_PUNCH / SET_STATUS refused (VALIDATION_ERROR) after **today in the organisation's timezone**, before the joining date, after the exit date (exit day inclusive; REMOVE_PUNCH stays allowed — it only takes a punch away). Bulk reports it per item. | `hr-attendance.test.ts` `6a-D6 …` ×2 (bulk: tomorrow in Asia/Muscat, before joining, after exit → per-item VALIDATION_ERROR with the reason; exit day and today accepted; record edit and `POST /attendance/corrections` refuse a future date; nothing written) · mutation-checked |
| M7 | The summary table had no Unexcused column. | Column (+ card line). | web `6a-M7` |
| M8 | The profile month strip (register totals: a half day = ½ present only) disagreed with the summary and the print view under the same labels. | ONE definition: `packages/database/src/attendance/summary.ts` (`attendanceSummaryRows` / `attendanceSummaryTotals` / `attendanceSummaryCount`) feeds the summary page, the print statement (through the summary endpoint), the profile strip and the worker's `monthly_summary`. The summary endpoint also answers an `attendance.view_own` caller with their own row only (the strip); the calendar stays closed to them. | API `6a-D8` (own row = HR's row for the same employee; another employee → empty; calendar 403) · web `6a-M8` (strip shows absent 3.5 / leave 1.5 from the summary, not the register's 3 / 1) |
| M9 | Every summary page aggregated the whole filtered set in Node and sliced it. | The employee set is paged in SQL (`order by display_name, id limit/offset`) before the figures are aggregated; the totals are one aggregate over the whole filtered set. | API `6a-D9` (pages of 1 = the full list in order; every page carries the same total and totals) |
| M10 | The summary CSV was built synchronously in the request. | Routed through the report pipeline (AGENTS.md rule 5): new report type **`monthly_summary`** (CSV / XLSX / PDF, total row in printed layouts, finalised figures only for `payroll.view`); `POST /attendance/summary/export` (idempotent) → **202 `{ reportId, jobId, status: QUEUED, rowCount }`**, report.view + report.export, 30 / organisation / hour, audited `attendance.summary_export_requested`; the caller's scope (branches — days included —, a line manager's team, the page's search) travels in the parameters because the worker runs in the organisation's system context. Download from Reports (report.export + ownership, `report.exported` with the row count). The synchronous `GET …/summary/export` (new in 6a, never released) is removed. The report type is also requestable, shareable and schedulable like any other. | API `6a-D10` ×2 (request row, job, audit, parameters incl. branch scope for a branch manager and the team for a line manager; 403 without report.export; old GET 404) · worker `6a-D10` ×3 (file = the shared figures row by row; scope from branches / employees / search; finalised counts only with `finalizedFigures`) · web `6a-D10` (POST, format, queued toast → Reports, no browser file) |
| M11 | The print view (browser print → PDF) was an export path open to `view_team` holders. | The Print button and the print links (summary rows, employee profile) need `report.export`; without it the page is a screen view (the D5 destination) and its print stylesheet replaces the sheet with a notice. | web `6a-M11` ×3 |
| M12 | `/report-recipients` handed the member directory (name, email, role) to any scheduler, across all branches. | Scoped to the members whose access reaches the caller's branches (all-branch members, a listed branch, or a linked employee in one); role counts over that set; **emails only with `user.view`** (names otherwise; a missing name falls back to a masked address); Send now / schedules refuse an out-of-scope user like an unknown one. | API `6a-M12` (payroll: no emails; branch-B scheduler never sees a branch-A-only member; share to one → 400) |
| M13 | `month_to_date` on whole-month report types covered the whole month. | `periodParameters` passes `{ month, from, to }` when the period is part of a month (`isWholeMonth`); `monthly_attendance` and `monthly_summary` clip to it (`definitions/month-period.ts`: never widened). | domain `schedule.test.ts` `6a-M13` · worker `6a-M13` (days 1–5 only; summary counts the 1st only) |
| M14 | A recipient cancelling their queued copy left the delivery `queued` forever. | `report_deliveries.status` gains **`cancelled`** (CHECK re-created); `cancelReport` settles it at once (system step) and the worker's SKIPPED path does too (`settleCancelledDelivery`); web label "Cancelled by the recipient". | API `6a-M14` · worker `6a-M14` · `rls_hr_workspace.sql` `6a-M14` |
| 15a | No sidebar item was active on `/attendance/print`. | `end` only when a nested item matches the current path: Attendance stays active on its own sub-pages, Attendance summary / Unmatched punches win on theirs. | web `sidebar.test.tsx` `6a-M15a` |
| 15b | The scheduler counted a deduplicated enqueue as `enqueued`. | An occurrence whose job is pending or running is counted `alreadyQueued` and not enqueued again (the queue's dedupe covers pending jobs only; a running one used to be re-enqueued). | worker `6a-M15b` (a running occurrence: `alreadyQueued: 1`, still one job) + the scheduler test's second tick (`{ due: 1, enqueued: 0, alreadyQueued: 1 }`) |
| 15c | ATT-102…105 not mentioned. | §9.3. | — |
| ATT-21 | The register's range as one file. | The Daily Report takes an optional `to`: each day of a range of **at most 62 days** (`DAILY_REPORT_MAX_DAYS`), the date heading each day's departments (a Date column in spreadsheets). One rule, `dailyReportRangeTooLong` (contracts), in `POST /reports`, Send now / schedules, the worker and the form (one day by default, "To" optional). | API `6a-ATT21` · worker `6a-ATT21` · contracts `6a-ATT21` · web `6a-ATT21` |
| Permissions | — | `report.schedule` granted to the system role **hr_admin** (migration; the escalation trigger only lets migrations write system roles); payroll keeps it; not hr_user, branch_manager, attendance_admin, auditor, manager, employee. `01-roles-permissions.md` updated. | `rls_hr_workspace.sql` `6a-P` · API `6a-P` (holders = owner, org_admin, hr_admin, payroll; hr_admin creates / shares / opens the picker) |

### 9.2 Decisions (review round)

- **R1 (D2)** A correction needs access to **every** branch that owned the day (record + employment history) **and**, unchanged, to the employee's current branch — never widened; a branch HR team does not edit the history an employee brought from elsewhere. The check runs where every door passes: first line of `createCorrection` (the only change inside that shared function).
- **R2 (D3)** A change of a schedule outside the caller's branches answers **403** (the row is read in the organisation's system scope only after `report.view` + `report.schedule` are established); a GET of it stays 404 (RLS hides it). Writes are service-only with an optimistic lock, so a concurrent edit is a 409, never a silent overwrite.
- **R3 (D4)** Refuse rather than write an alias the finance resolver would have to learn: the connector's identity is the employee number, so the fix is the number. The `self_service` entry anticipates Prompt 4's virtual device (present on the integrated branch).
- **R4 (D6)** Today is allowed (a day in progress can be set); the exit day is inclusive; REMOVE_PUNCH is not date-limited.
- **R5 (M8)** The summary endpoint opens to `attendance.view_own` for the caller's own row only — the strip needs the same figures; nothing else changes for them.
- **R6 (M10)** Routed through GENERATE_REPORT rather than recorded as an exception. The total row prints in PDF (the spreadsheet renderers drop total rows for every report: a spreadsheet sums itself). Finalised period counts only for `payroll.view` holders — the page's RLS rule, re-applied explicitly because the worker runs in system context. The synchronous GET is removed (new in 6a, never released to production).
- **R7 (M11)** Printing is an export: button and links gated on `report.export`; the statement stays viewable on screen (the D5 destination), and the print stylesheet is a UX guard, not a boundary.
- **R8 (M12)** The picker shows unrestricted members to a branch-restricted scheduler (their access covers the branch; they would receive branch reports anyway) and never a member confined to other branches.
- **R9 (M13)** Explicit from/to rather than refusing MTD: a month-to-date monthly schedule is useful; a whole month still sends `{ month }` only.
- **R10 (M14)** `cancelled`, not `skipped` + reason: the recipient cancelled it; nothing was skipped.
- **R11 (Storage / Prompt 4 selfies)** Selfie photos live in `employee-photos` under `checkins/<org>/<employee>/<selfie id>.<ext>` (migration `20260928000500` on the integrated branch). Requirements this migration keeps and Prompt 4 must keep: (1) the RESTRICTIVE policy `flowza_selfie_photos_deny_client` (anon, authenticated, flowza_system; `checkins/%`) stays — this migration replaces only the permissive `flowza_objects_*` policies and never touches it; (2) every permissive clause stays keyed on `app.path_org_id(name)` (NULL for `checkins/…`) — the new employee-photos clause additionally needs `<org>/<employee>/…`, so no clause can match a selfie path; (3) only the API's service client uploads / signs (60-second URL per permitted viewer, each audited) and the worker's service role purges; (4) no `checkins/` clause is ever added to a permissive policy.
- **R12** `hr_admin` holds `report.schedule` (the review's least-privilege recommendation: HR manages the reports it already views and exports; the picker is now scoped).

### 9.3 ATT table — rows changed by the review

| Item | | How |
|---|---|---|
| ATT-21 CSV of the range | ✅ | the Daily Report over a range (≤ 62 days, one file, CSV / XLSX / PDF) + the monthly summary report |
| ATT-26 monthly summary | ✅ | + Unexcused column; rows open the register (view) or the statement (view_team); paged in SQL |
| ATT-27 summary export gated + logged | ✅ (changed) | queued `monthly_summary` report (CSV / XLSX / PDF), `report.export`, 30 / hour, audited at request (`attendance.summary_export_requested`) and download (`report.exported`, row count) |
| ATT-56 PIN → employee | ✅ (+) | Assign refused (409, `details.reason`) with guidance on the Flowza Finance connector / self-service device |
| ATT-102…ATT-105 holidays / shifts admin | → Prompt 6b | not in 6a's scope (the prompt pack lists them under P6; 6a is the HR attendance workspace); the portal shift view (ATT-104…106) is Prompt 4 / 5 |
| ATT-108 monthly schedules | ✅ (+) | month to date on monthly types covers exactly the days to date; hr_admin may schedule |
| ATT-110 CRUD by manage, logged | ✅ (+) | writes through the API only (no client write privilege), stored-row branch scope, optimistic lock |
| ATT-112 employee tab + print | ✅ (+) | the strip shows the summary's figures; print for `report.export` holders |

### 9.4 Shared files changed (for the integrator's merge)

- `apps/api/src/services/features/attendance.service.ts` — **3 lines**: the import of `preValidateCorrection` and its call on the first line of `createCorrection` (+ a comment). Nothing else inside the function.
- `supabase/migrations/20260928000820_hr_workspace_review_fixes.sql` — replaces the storage policies `flowza_objects_read|write|update|delete` (keeps Prompt 4's restrictive `flowza_selfie_photos_deny_client` untouched), `report_schedules_*`, `report_deliveries_select`; grants `report.schedule` to hr_admin. Sorts after `…000800_approval_engine_v2_review_fixes` and `…000500_portal_attendance_self_service`.
- `supabase/tests/rls_hr_workspace.sql` (6a's own suite; the runner `run-rls-tests.sh` is unchanged, `rls_approvals.sql` stays last).
- Locales (only 6a entries): `en|ar/attendance-workspace.json`, `en|ar/report-schedules.json` (`deliveryStatus.cancelled`), `en|ar/reports.json` (`types.monthly_summary`, the daily description, `request.dailyRangeHint|dailyRangeTooLong`).
- `apps/web/src/components/layout/sidebar.tsx` (+ test) — the `end` rule only.
- `apps/web/e2e/support/mock-backend.ts` (one POST handler) + `e2e/hr-attendance.spec.ts`.
- Contracts / domain registries: `REPORT_TYPES` (+`monthly_summary`), `REPORT_TYPE_DEFINITIONS` (+ entry; daily `to`), `DAILY_REPORT_MAX_DAYS` / `inclusiveDayCount` / `dailyReportRangeTooLong`, `reportParametersSchema.search`, `REPORT_DELIVERY_STATUSES` (+`cancelled`), recipient `email: string | null`, hr-workspace DTOs; domain `reports/labels.ts` (+ keys), `reports/schedule.ts` (`isWholeMonth`, `periodParameters`, `scopeReportForRecipient` finalised flag).
- `packages/database/src/attendance/index.ts` (+ `summary.js` export); worker `definitions/index.ts` (+ `monthly_summary`), `generate.ts` / `deliveries.ts` (cancelled settlement), `tasks/reports.ts` (`alreadyQueued`); API `reports.service.ts` (daily range, finalised flag, cancel settles the delivery).
- Docs: `docs/hr-portal/reports/01-roles-permissions.md` (matrix row), `docs/reports.md` (monthly_summary, daily range).
- **Overlap with the integrated branch** (checked against `claude/modest-fermi-fnwqq7` after the approval-engine, portal-attendance and Leave v2 merges): `attendance.service.ts` (the approval fixes also change `createCorrection` — keep both, the pre-check stays the first line), `sidebar.tsx` (new nav items there; this branch changes only the `end` rule and adds `useLocation`), `e2e/support/mock-backend.ts` (both add handlers), `packages/database/src/attendance/index.ts` (both append one export line). None of the later migrations (`…000500`, `…000690`, `…000700`, `…000800`) touches the storage policies replaced here, `report_schedules`, `report_deliveries` or the helpers this migration calls.

### 9.5 Verification (review round; local Postgres @ 127.0.0.1:54329; shared DB suites under `flock /tmp/flowza-dbtests.lock`)

| Gate | Result |
|---|---|
| `pnpm build:packages` | ✅ |
| `pnpm lint` (max-warnings 0) | ✅ |
| `pnpm -r --filter "./apps/*" run typecheck` | ✅ api, web, worker |
| `pnpm test:unit` | ✅ shared 4 · contracts 8 (new `reports.test.ts`) · domain 256 · device-providers 286 · database 20 |
| `pnpm --filter @flowza/web run test` | ✅ 64 files / 270 tests |
| RLS suite (`PGDATABASE=flowza_p6f_rls … run-rls-tests.sh`) | ✅ "RLS tests passed" (`rls_hr_workspace.sql` with the 6a-D1 / 6a-D3 / 6a-M14 / 6a-P assertions; `rls_approvals.sql` still last) |
| `pnpm test:db` | ✅ 2 files / 11 tests |
| `pnpm --filter @flowza/api run test` | ✅ 24 files / 290 tests |
| worker vitest | ✅ 15 files / 161 passed, 1 skipped |
| `pnpm -r --filter "./apps/*" run build` | ✅ |
| `PGDATABASE=flowza_p6f_ci2 bash scripts/db-reset-local.sh` | ✅ (every migration incl. `20260928000820`) |
| single-transaction replay (`… flowza_p6f_tx`) | ✅ "single-transaction replay OK" (`20260928000820` applied with `psql -1`) |
| `pnpm db:types` against `flowza_p6f` (reset `--seed`) | ✅ no diff to the committed `db.ts` |
| `build:e2e` + `test:e2e` (`/opt/pw-browsers/chromium`) | ✅ 36 passed (chromium + tablet; `hr-attendance.spec.ts` now queues the summary export) |
| Mutation checks (API) | removing the stored-row scope check fails `6a-D3 … probe B`; disabling `preValidateCorrection` + the `planDay` day-branch check fails the four `6a-D2` / `6a-D6` tests; letting Assign through fails `6a-D4` |

### 9.6 Known limits (review round)
- The picker's scope is membership-based (all-branch members + members of the caller's branches); it does not model teams.
- `Assign` refusal covers `flowza_finance` and `self_service`; a future system device must be added to `UNMATCHED_ASSIGN_BLOCKED_PROVIDERS` if it resolves by anything but the device mapping.
- §8's "hr_admin does not hold report.schedule" follow-up is closed by R12.
