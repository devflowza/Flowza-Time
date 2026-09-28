# Prompt 6a (HR attendance workspace parity): adversarial review, rev6

I tested the integrated head `2b82b16`, which merges 6a (`f678ac4`, the workspace, and `bd01368`, report sharing and schedules), in worktree `agent-a2460c47d30ce6fc2`.

- **Databases:** `flowza_rev6`, `flowza_rev6_rls`, `flowza_rev6_ci2` and `flowza_rev6_tx`. The API and worker test harnesses also create their own per-process databases and drop them afterwards; I checked that none were left behind.
- **Probes:** these were throwaway tests and scripts. The ones inside the repo are deleted, and `git status --short` is empty (only gitignored build output remains).

**Verdict:**
- **Passing:** every gate. The engine, preview, bulk status, summary figures, per-recipient report scope and schedule timing across timezones are correct.
- **Defects:** 3 P0 security defects, 3 P1 and 9 P2.
- **Blockers:** each P0 bypasses branch scope, team scope or `report.export` for a real role. They should block shipping the "per-recipient scope" and "download ownership" claims.
- **"hr_admin lacks report.schedule":** CONFIRMED.

## 1. Gates (re-run from scratch)

| Gate | Result |
|---|---|
| `pnpm lint` (max-warnings 0) | pass (49 s) |
| typecheck api / web / worker | pass |
| `pnpm test:unit` | pass: shared 4, contracts 5, domain 255 (19 files), device-providers 286 (9 files), database 20 (2 files) |
| web vitest | pass: 64 files / 260 tests |
| RLS suite on `flowza_rev6_rls` | pass ("RLS tests passed") |
| `pnpm test:db` (under flock) | pass: 2 files / 11 tests |
| API vitest | pass: 24 files / 273 tests |
| worker vitest (under flock) | pass: 15 files, 153 passed + 1 skipped |
| apps build | pass (web only warns about chunks > 700 kB) |
| fresh replay on `flowza_rev6_ci2` | pass |
| reset `--seed` on `flowza_rev6` | pass |
| `20260928000600` applied twice on the seeded DB | pass ("reapply-ok") |
| single-transaction replay on `flowza_rev6_tx` | pass ("single-transaction replay OK") |
| `pnpm db:types` | no diff (87 tables); file restored |
| `build:e2e` + Playwright (CI=1, `/opt/pw-browsers/chromium`) | 36 passed |

Several counts are higher than in the 06a report (API 227 → 273, web 237 → 260). The integrated head also carries the Finance-connector fixes and other merged work.

## 2. Defects

### P0: security

**1 [P0]. Any `report.view` holder can list and download every report file of the organisation directly from Supabase Storage.**
This bypasses `report.export`, branch and team scope, per-recipient scope and download ownership.

- **Where:** `supabase/migrations/20260905001500_storage_realtime.sql:26`.
  - The `flowza_objects_read` policy grants `bucket_id = 'reports' and app.path_org_id(name) = any(org_ids_with_permission('report.view'))`.
  - The policy predates 6a. But 6a now stores organisation-wide scheduled copies in this bucket, and its guarantees (each copy under the recipient's own access; download only by the owner or report.manage) are enforced only in the API: `reports.service.ts:120-125` checks, then signs a 300 s URL.
  - Storage is enabled (`supabase/config.toml:38-39`) and the browser holds the user's JWT.
- **Probe:** `rev6/storage-probe.sql`, run inside a transaction and rolled back.
  - Setup: an org-wide copy for the owner and a HQ-branch copy, stored at `reports/<org>/<request>.csv`. Queries then run as `authenticated`.
  - manager-a (system `manager` role: report.view, **no report.export**, team scope) lists and reads both objects (`…07a1.csv`, `…07a2.csv`). RLS on `report_requests` shows it 0 of the owner's requests.
  - bm-a (branch_manager restricted to branch A-2) also sees both objects.
  - emp-a (no report.view) sees 0; owner-b (another org) sees 0.
- **Fix:** remove the `reports` branch from the `authenticated` SELECT policy, so downloads go only through the API's signed URL after `downloadReport`. If direct reads are ever needed, require `report.export` and ownership (`report_requests.requested_by = app.uid()`, or report.manage plus branch). Add an RLS test.

**2 [P0]. Preview and record edit authorise against the employee's current branch, not the branch that owns the day.**
A branch-scoped HR admin can read, and overwrite, another branch's attendance day for a transferred employee.

- **Where:** `apps/api/src/services/attendance/hr-workspace.service.ts:140-141`.
  - The code calls `requireBranchAccess(grant, emp.branchId)`, then loads the day with `loadDailyInputs` under `withSystemScope`.
  - The write half is the pre-existing `createCorrection`, which has the same current-branch check. The new record-edit and bulk surfaces now reach it.
- **Probe:** API probe F.
  - Setup: E5 was in branch B until 2026-08-15 and in branch A afterwards. The 2026-08-10 record carries `branch_id = B`. The caller is an hr_admin restricted to branch A.
  - `POST /attendance/preview` returns 200 with the whole day: IN 03:40Z, OUT 12:45Z, 485 minutes worked, EARLY_DEPARTURE.
  - Everywhere else, RLS hides the same day from the same caller: the calendar day is not visible, the timeline shows 0 events with recordId null, and the summary recordCount is 0.
  - `POST /attendance/record-edits {status: ABSENT}` returns 201. The SET_STATUS is AUTO_APPROVED and applied to the branch-B day.
- **Fix:**
  - In `planDay`, right after loading, call `requireBranchAccess(grant, loaded.branchId)`. `LoadedDailyInputs.branchId` is the effective branch on that date.
  - Apply the same day-branch check in `createCorrection` and the bulk path.

**3 [P0]. A branch-scoped `report.schedule` holder can take over, run and delete organisation-wide schedules (through the API and through PostgREST), and can read the organisation's whole delivery trail.**

- **Where:**
  - **API.** `apps/api/src/services/report-schedules.service.ts:209-238`. Update validates only the NEW spec, and delete checks no scope at all. Run-now (:241-255) does re-validate the stored spec, so it only works once the schedule has been re-pointed.
  - **Schedule RLS.** `supabase/migrations/20260928000600_hr_attendance_workspace.sql:77` calls `apply_tenant_policies(..., 'branch_id')`. That produces the generic predicate `… or branch_id is null or branch_id = any(allowed_branch_ids())` (`20260905001400_rls_policies.sql:208`). So `branch_id IS NULL` rows, the org-wide schedules, are writable by branch-restricted holders.
  - **Delivery RLS.** `report_deliveries_select` (`…000600.sql:124-126`) shows every delivery in the org to any report.schedule holder.
  - **Scope.** The checks depend only on the permission and `grant.allBranches`, so the same path applies to any branch-restricted membership that holds report.schedule. That includes the default `payroll` role.
- **API probe (probe B).** The caller has a custom role (report.view + report.schedule) restricted to branch A.
  - The list shows the owner's org-wide schedule.
  - `PATCH {name}` returns 403 ("Branch-scoped users must choose one of their branches.").
  - `PATCH {filters:{branchId: A}, recipients:{userIds:[self]}}` returns **200**. The schedule becomes branch A with the scheduler as its only recipient, `createdBy` stays the owner, and the org's recipients silently stop receiving their report.
  - `POST …/run-now` on the now branch-A schedule returns 202.
  - `DELETE` on a second, still org-wide schedule ("Org-wide absences", created by the owner) returns **204** and the row is gone.
  - Only creating an org-wide schedule is refused (403).
- **RLS probe.** `rev6/rls-probe.sql` runs as `authenticated` (equivalent to PostgREST) with a scheduler restricted to branch A-2.
  - The scheduler sees 2 schedules: the org-wide one (1) and none of HQ's (0).
  - UPDATE, DELETE and INSERT of org-wide rows each affect 1 row.
  - `report_deliveries` shows 3 of 3 rows, all 3 addressed to other people.
- **Quota and validation bypass.** Direct table writes skip `validateSpec`, recipient validation and the share quota.
  - Worker probe `nextRunAbuse`: before each tick, a direct UPDATE (the kind of write the RLS probe shows a scheduler may make) set `next_run_at` to one minute before "now", and then the handler ran.
  - Result: a new full run on every tick (05:10, 05:15, 05:20), 2 reports queued per run, each with a distinct run key `schedule:<id>:<occurrence>`.
- **Fix:**
  - (a) In update and delete, for callers without `grant.allBranches`, refuse when the stored `row.branchId` is null or outside `grant.branchIds`. Check the stored row as well as the new spec.
  - (b) On `report_schedules`, write predicates must allow `branch_id is null` only for unrestricted holders. Alternatively, revoke insert, update and delete from `authenticated` and write through a system step after the service checks, as `report_deliveries` already does. Either way, keep `next_run_at` server-computed.
  - (c) Narrow `report_deliveries_select` for branch-restricted schedulers to rows they sent, rows they received, or schedules they can see. `listDeliveries` already narrows this in the API; RLS does not.

### P1: functional

**4 [P1]. Assigning an unmatched punch on a Flowza Finance connector device does nothing and writes a spurious device mapping.**

- **Where:**
  - `hr-workspace.service.ts:594-702`: triage lists connector devices and lets you assign on them. `assignUnmatched` inserts a `device_employee_states` row with desired=true and IN_SYNC at :685.
  - The normaliser resolves connector rows only by employee number (`apps/worker/src/handlers/attendance/normalize.ts:129-132`, review fix D7), so it never reads that mapping.
  - The docstring at :664-667 is stale: it says "for Flowza Finance connectors right after the connector's own resolver".
- **Probe:** API probe E.
  - The groups are listed as `flowza_finance:FIN-777` and `flowza_finance:pin:SN9:55`.
  - Assign returns 200 with `{rows: 2, jobId: "16"}` for the first and `{rows: 1}` for the second.
  - Both calls create states `{desired: true, syncStatus: IN_SYNC}` on the connector.
  - `normalizeBatch` then reports fetched 3, normalized 0, unmatched 3, and all 3 rows go back to `unmatched`.
  - The API reports success (rows re-queued, a job id), but nothing is ever attributed.
- **Fix:** for connector and system devices, refuse Assign (and hide the action and its suggestions) with guidance to fix the employee number. Alternatively, add an alias that the finance resolver actually reads. Correct the docstring.

**5 [P1]. Clicking a row on the summary page is broken for line managers, who are the page's only non-HR audience.**

- **Where:**
  - `apps/web/src/features/attendance/pages/summary-page.tsx:109` navigates to `/attendance?tab=calendar&employeeId=…`.
  - `/attendance` requires `attendance.view` and sends everyone else to `selfServiceTo="/my/attendance"` (`features/attendance/routes.tsx:13`).
  - The summary page itself allows view_team (`routes.tsx:15`).
- **Probe:** web probe as a manager with view_team, view_own and report.view.
  - Clicking a team member's row goes to `/attendance?tab=calendar&employeeId=…&month=2026-08`.
  - The route guard then lands on `/my/attendance`: registerShown=false, ownShown=true.
  - The manager sees their own attendance instead of the team member's.
- **Fix:** for view_team callers, open a destination they can reach (the print/statement view or a team calendar). Or let the `/attendance` calendar tab accept view_team: the calendar API already scopes managers to their team (probe D_manager).

**6 [P1]. Setting a status (SET_STATUS) is accepted for future dates and for dates before the employee joined.**
The resulting PRESENT records count in summaries.

- **Where:** bulk-status and record-edits (`hr-workspace.service.ts:248-307`) call `createCorrection`, and `planDay` guards only punch times.
- **Probe:** API probe C_edge_dates.
  - Bulk PRESENT on 2027-03-01 (in the future) is accepted, AUTO_APPROVED, and stored as PRESENT.
  - Bulk PRESENT on 2023-06-01 (the employee joined 2024-01-01) is accepted and stored as PRESENT.
  - record-edits on a 2027 date returns 201 and is applied.
- **Fix:** reject dates after today in the org's timezone, and dates outside the joining and exit dates. Return VALIDATION_ERROR per item in bulk; preferably enforce this in `createCorrection`.

### P2: minor

**7. The summary table has no "Unexcused" column,** although the API and the CSV both carry `unexcusedDays` (`summary-page.tsx:62-77`). The rendered headers are:
Employee, Present, Late, Half days, Leave, Absent, Missing punch, Holidays, Weekly off, Days worked, Worked, Avg / day, Overtime, Loss of pay, Source.

**8. The profile month strip disagrees with the summary and print view under the same labels.**
- The strip reads the `/attendance/monthly` totals. Those count a HALF_DAY only as ½ present (`apps/api/src/services/features/attendance.service.ts:119`).
- The summary assigns the other half of the day to leave or absent.
- Probe G, same employee and month: the strip shows absent 3 and leave 1; the summary shows absent 3.5 and leave 1.5.
- Fix: feed the strip from the summary endpoint or from `summarisePeriod`.

**9. Summary pagination happens in Node memory.**
- Every page fetches the whole filtered set and then slices it (`hr-workspace.service.ts:475-476`), while Decision 11 says "paginated for the page".
- The results are correct, but each page costs as much as the whole organisation.
- Fix: paginate in SQL and compute the totals with an aggregate query.

**10. The summary CSV is built synchronously inside the request** (`hr-workspace.service.ts:508-527`, up to `ATTENDANCE_SUMMARY_EXPORT_MAX_ROWS` = 10,000 employees).
- AGENTS.md rule 5 says anything that generates a report returns a job id.
- The exception appears only in a code comment, not among the 06a Decisions.
- Fix: record the exception as a Decision, or route the export through GENERATE_REPORT.

**11. The print view is an export path that is not gated by report.export.**
- `print-page.tsx:52` (Print / Save as PDF through `window.print`) is open to view_team holders.
- As a result, a manager without report.export can produce team statements as PDF.
- Fix: gate the button, and the print link on summary rows (:77), on report.export, or document it as a screen print.

**12. `/report-recipients` hands the member directory (name, email, role, manager flag) to any report.schedule holder, across all branches.**
- Where: `report-schedules.service.ts:312-331` reads it in system scope. This includes `payroll`, which does not hold `user.view`.
- Probe: a scheduler restricted to branch A receives 10 members with emails, from every branch.
- Why P2 and not P0: the exposure is gated by report.schedule and contains no attendance data.
- Fix: scope it to the caller's branches, and require user.view for emails.

**13. `month_to_date` is accepted for whole-month report types, and those reports then cover the whole month.**
- Where:
  - The contract allows it (`packages/contracts/src/dto-features/report-schedules.ts:87-89`).
  - `periodParameters` sends `month` for these types (`packages/domain/src/reports/schedule.ts:136`).
- Probe: `rev6/mtd-probe.mjs`, a schedule running on day 15.
  - The month-to-date period is 2026-10-01 to 2026-10-14.
  - `monthly_attendance` nevertheless receives `{month: "2026-10"}`, which covers the whole of October, including today and future days.
- This contradicts Decision 9 ("a scheduled report never contains a half-computed day").
- Fix: allow only previous_month for month-parameter types, or pass explicit from/to dates.

**14. If a recipient cancels a queued delivered copy, the delivery stays `queued` forever.**
- Where: `cancelReport` (`apps/api/src/services/features/reports.service.ts:131-139`) marks the request CANCELLED and cancels its job. If the generator runs anyway, it returns SKIPPED without calling `settleDelivery` (`apps/worker/src/handlers/reports/generate.ts:53-57`). Neither path settles the delivery.
- Worker probe: generate returned SKIPPED; the delivery stayed `{status: queued, deliveredAt: null}`.
- Fix: settle the delivery as skipped (for example with reason `cancelled`).

**15. Small items:**
- (a) No sidebar item is active on `/attendance/print`; at ba825d2, Attendance was highlighted there (sidebar probe).
- (b) The scheduler counts a deduplicated enqueue as `enqueued: 1` (`apps/worker/src/tasks/reports.ts:36`). Two ticks reported `{due: 1, enqueued: 1}` each, but only 1 job exists.
- (c) The 06a report does not mention ATT-102…105 (holidays and shifts admin), which `docs/hr-portal/prompt-pack.md:228` maps to P6.

## 3. Verified correct

**Preview, edit and bulk status**
- **Preview matches the recompute on 11 day types:** normal late, short day (HALF_DAY), holiday work, leave, weekly-off work, weekly off, absent, missing out, half-day leave, a night shift across midnight, and the day after a night shift.
  - Status, flags, worked, late, early, overtime, first-in and last-out are identical.
  - Preview writes nothing: corrections, events, records, history, jobs, audit, domain_events, usage_quotas and approval_requests are all unchanged.
- **Edit, apply and recompute equal `preview.preview` exactly,** including MANUAL_CORRECTION:
  - a normal day with 2 × EDIT_PUNCH (515 minutes);
  - a night shift with a next-day check-out (505 minutes, CROSS_MIDNIGHT).
- **Bulk status for a branch-A hr_admin handles each item on its own:**
  - Valid items are applied.
  - A locked day returns PERIOD_LOCKED.
  - Branch-B and other-org employees return VALIDATION_ERROR ("Employee not found.").
  - The caller's own record returns FORBIDDEN.
  - A repeated employee and date returns DUPLICATE_ITEM.
  - 201 items returns 400.
  - 200 items returns 200 with all succeeded (about 6 s locally).
- **After apply, every view agrees:** the stored status (ABSENT), `manual-statuses` and the calendar all show "ABSENT/MANUAL", and an untouched day shows "PRESENT/AUTO".

**Summary, calendar and timeline**
- **The summary equals the sum of the daily records.**
  - E1: worked 1365, 11 records, 5 days worked, present 3, absent 3.5, leave 1.5, holiday 1, weekly off 2.
  - Night-shift employee: 505 minutes over 2 records.
- **Scoping holds:**
  - A manager's summary and calendar show the team plus self; a crafted employeeId or branchId returns 0 rows.
  - branch_manager B sees branch B only; hr_admin A sees branch A only.
- **Calendar "today" follows the org's timezone.** At UTC 2026-09-28T00:48Z it shows 2026-09-27 in Pago Pago and 2026-09-28 in Kiritimati.
- **The timeline shows** voided device punches (role IGNORED), correction events with no device marked "via correction", device names, and neighbouring days' punches labelled OUT_OF_WINDOW.

**Unmatched triage (normal devices)**
- Assign re-queues only that device user's unmatched rows; other rows, including another org's, are untouched.
- A second assign to a different employee returns 409.
- A device from another org returns 404; an employee from another org returns 400.

**Report sharing and schedules**
- **Per-recipient scope holds for all 11 schedulable types** (worker probe, file contents checked):
  - Owner and auditor get the whole org.
  - hr_user restricted to branch B, and branch_manager B, get branch B only.
  - A custom team lead gets exactly their team, including a member in another branch.
  - hr_user restricted to branch A gets branch A.
- **Recipients are skipped with the right reason:**
  - employee: `missing_permission:report.view`.
  - manager: `missing_permission:report.export`.
  - The detail report for a recipient who cannot see all the chosen employees: `outside_scope:employees`.
  - The audit report for recipients without audit.view: `missing_permission:audit.view`.
- **Schedule runs:**
  - A branch-A-filtered schedule skips branch-B recipients with `outside_scope:branch`.
  - `next_run_at` advances (to 2026-10-10T05:00Z); a second handler run returns `not_due`.
  - Two scheduler ticks produce one job.
  - run-now with the same Idempotency-Key is replayed; without a key it creates 2 runs with 2 run keys.
- **There is no bearer link.** The notification link is `/reports?download=<id>`, and a download needs a session, report.export and ownership:
  - own copy: 200
  - another hr_user: 404
  - org-wide hr_admin (report.manage): 200
  - branch-A hr_admin on a TEAM copy (branch_id null): 404
  - another org: 404
- **Validation:**
  - Returns 400 for runDay 29 or 31, weekly + previous_month, foreign-org user ids (on schedule and on share) and unknown roles.
  - hr_admin share returns 403 ("Missing permission: report.schedule.").
  - A one-field PATCH keeps every other field.
- **Timing** (`rev6/sched-probe.mjs`):
  - Kiritimati monthly on the 28th at 07:00: 2026-09-27T17:00Z, then 2026-10-27T17:00Z.
  - Pago Pago monthly on the 1st at 07:00: 2026-10-01T18:00Z.
  - London across the DST change: 06:00Z, then 07:00Z.
  - New York DST gap: 02:30 becomes 03:30 local.
  - previous_month at 2026-09-30T11:00Z is September in Kiritimati (August in UTC).
  - Month-to-date ends yesterday (Pago Pago: Sep 1–29).
  - previous_week honours the first day of the week (Saturday start: Sep 19–25; Sunday start: Sep 20–26).
  - Custom 26 → 25: on the 26th it covers Aug 26–Sep 25; on the 25th it covers Jul 26–Aug 25. 28 → 27 across February is correct.
  - Missed occurrences are counted (3), not replayed.

**Exports**
- report.export is enforced on:
  - the summary CSV (`hr-workspace.service.ts:510`; formula-escaped, quota, audited with row count);
  - report downloads (`reports.service.ts:120`);
  - the employee export (`employees.service.ts:450`);
  - the approvals history CSV (`approvals/queries.ts:96`).

**Neighbour regression**
- **The daily-inputs loader** has one implementation, in `packages/database`. The worker re-exports it and the API imports it, and the moved helpers are byte-identical to the originals.
- **The outbox `channels` change is safe:** no existing event payload carries `channels`, so every existing notification still goes to both channels.
- **The sidebar was compared with ba825d2** for all 10 system roles × 3 variants (no linked employee, a linked employee, a linked employee with 2 reports):
  - Nothing was removed.
  - `/attendance/summary` was added for every role except employee.
  - `/attendance/unmatched` was added for the view_raw roles: owner, org_admin, hr_admin, attendance_admin and auditor.
  - The employee role is unchanged.

**Web**
- **Translations:**
  - en and ar have the same keys, and no static keys are missing. The scanner's 10 hits were namespace false positives; each key is present in both locales.
  - Dynamic keys resolve (the report-schedules enums are complete) or carry a `defaultValue`.
  - 6a files use no physical-direction classes. The only hard-coded string is the pre-existing sidebar aria-label "Primary".
- **The Recalculations tab** shows `#<jobId>` as plain text (no `/sync/<id>` link) and highlights `?request=`.
- **The passing suites cover:**
  - calendar (legend, manual marker, add/edit gating);
  - record-edit dialog (preview, check-out before check-in, locked period);
  - bulk bar, timeline and raw-row gating;
  - summary CSV gating;
  - unmatched page (assign / ignore / restore, read-only without device.sync);
  - print;
  - schedule and share dialogs;
  - the Reports page (report.export and `?download=`; Send now and schedules gated by `can('report.schedule')` at `reports-page.tsx:48`).

## 4. ATT items not satisfied or partial

| Item | Status | Detail |
|---|---|---|
| ATT-16 "Use auto status" | Not met | Acknowledged in 06a §8. |
| ATT-111 HR calendar feed | Not met | Acknowledged; the pack marks it "optional". |
| ATT-05 ten status chips | Documented deviation | Status + flags are used instead. |
| ATT-06 load sequence | Documented deviation | The engine materialises days asynchronously; "Sync punches" recomputes on demand. |
| ATT-21 CSV of the filtered range | Partial | The register views have no export. `daily_attendance` covers one day and `employee_attendance` requires explicit `employeeIds` (`packages/contracts/src/dto-features/reports.ts:37,39`). |
| ATT-10, 23, 24, 25 | Deferred to Prompt 4 | |
| ATT-56 PIN → employee mapping | Partial | Assign does not work on Flowza Finance connector devices (defect 4). |
| ATT-107, 108, 109 | Differ by design | No WhatsApp, no external addresses, a per-recipient file instead of an HTML summary, a 5-minute scheduler. |
| ATT-110 schedule CRUD restricted to manage | Not met as claimed | Scope is not enforced (defect 3). |
| ATT-112 employee tab + print | Partial | Print is not export-gated (defect 11); the strip's figures disagree with the summary (defect 8). |
| ATT-102…105 holidays / shifts admin | Not addressed | The 06a report is silent (defect 15c). |

## 5. "hr_admin lacks report.schedule": CONFIRMED

- **Role matrix in the DB:** hr_admin has report.view, report.export and report.manage, but not report.schedule. The holders of report.schedule are owner, org_admin and payroll.
- **API:** hr_admin `POST /report-shares` returns 403 ("Missing permission: report.schedule.").
- **Web:** the Reports page hides Send now and schedules for hr_admin (`reports-page.tsx:48`).

## 6. Least-privilege recommendation

**`report.schedule`.** This permission sends report copies to other people, reads the member directory and reads the delivery trail.
- Grant it to owner, org_admin and **hr_admin**. hr_admin is the HR "manage" role and already holds report.manage, so this is an addition.
- payroll should keep it only once defect 12 is fixed: today it receives every member's email through `/report-recipients` without holding user.view. Otherwise remove it.
- Do not grant it to hr_user, branch_manager, attendance_admin, auditor, manager or employee.
- Do not grant it to branch-restricted memberships until defect 3 is fixed.

**`report.export`.**
- Keep the current set: owner, org_admin, hr_admin, hr_user, payroll, auditor, attendance_admin and branch_manager.
- Do not grant it to manager or employee. Team leads read on screen, and scheduled copies addressed to them are skipped by design.
- Close the two bypasses: Storage (defect 1) and the print view (defect 11).

## 7. Evidence (scratchpad `rev6/`)

- **Gates:** `gate-*.log` and `gates.status`.
- **API probe output:** `probe-a-out.json` (sections A–H) and `probe-b-out.json`.
- **Worker probe output:** `probe-w-out.json` (scope, schedule, cancel, nextRunAbuse).
- **Web probes:** `probe-web-nav.json`, `probe-sidebar.json` and `probe-sidebar-active.json`.
- **SQL:** `rls-probe.sql` / `rls-probe.out`, `storage-probe.sql` / `storage-probe.out` and `storage-policies.sql`.
- **Domain scripts:** `sched-probe.mjs` and `mtd-probe.mjs`.
- **Permissions:** `role-perms.json`.
- The in-repo probe files are deleted and `git status --short` is empty.
