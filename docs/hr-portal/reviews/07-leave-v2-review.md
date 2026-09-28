# Prompt 7 — Leave v2 (Finance parity): adversarial review (rev7)

**Head reviewed:** `08ce01c` (integrated branch: Prompts 1, 2, 3, 4, 6a, 7, 9 and the review fixes of 1, 2 and 9). The worktree was reset to it and is **clean** at the end (`git status` empty). No tracked file was modified and nothing was committed.
**Databases used:** `flowza_rev7` (seeded), `flowza_rev7_rls`, `flowza_rev7_ci2` (fresh replay, then the demo seeds), `flowza_rev7_tx` (single-transaction replay).
**Scratch files:** all under `scratchpad/rev7/` and named `rev7-…`. Each probe logs `[rev7] <id> …` and asserts the correct or secure behaviour, so a failing assertion is a finding. The four throwaway test files were copied into the repo only to run and were deleted afterwards.

---

## 1. Gates (all green)

| Gate | Result |
|---|---|
| `pnpm install --frozen-lockfile`, `pnpm build:packages` | pass |
| `pnpm lint` | pass (exit 0, 70 s) |
| typecheck (api, web, worker) | pass |
| unit | shared 4 (1 file); contracts 5 (1); domain **308** (23 files); device-providers 286 (9); database 20 (2) |
| web | **71 files, 338 tests** |
| RLS (`flowza_rev7_rls`, under flock) | **385** `ok` assertions: isolation 170, system_context 18, hr_workspace 37, **leave 71**, approvals 89. "rls_leave: all assertions passed", "RLS tests passed" |
| `pnpm test:db` (flock) | 3 files, 15 tests |
| API | **29 files, 377 tests**. The known flaky "P2-13 QUORUM" test passed this run |
| worker (flock) | 17 files, 164 passed, 1 skipped (the Chromium PDF skip predates this work) |
| build (apps) | pass. The >700 kB chunk warning predates this work |
| fresh replay on `flowza_rev7_ci2` | pass (000690, 000700, 000800 in order) |
| single-transaction replay on `flowza_rev7_tx` | pass |
| seeded `flowza_rev7` | pass |
| second apply of 000690 + 000700 (each `-1`) on the seeded DB | fingerprint of types, records, allocations, comments, credits, policies, constraints and enum **identical** before and after. 000690 prints `INFO_REQUESTED already exists, skipping` |
| `pnpm db:types` + `git diff --exit-code` on `db.ts` | 98 tables introspected, **no diff** |
| Playwright (`build:e2e`, `test:e2e`, `CI=1`) | **50/50 passed** |
| en/ar parity | 24 locale files, 0 missing keys. Every literal and dynamic leave key resolves |
| demo-tenant seeds `01…05` incl. `03b` on `flowza_rev7_ci2` | Run with an auth stand-in (`rev7-seed-prep.sql`: widened `auth.users`, `auth.identities`, `uuid-ossp` in `extensions`, the pre-existing tenant and owner). **Every file exits 0, twice (idempotent).** Result: 67 leave rows, 3 allocations, the comp-off type `CO` (`system_key=COMP_OFF`, `portal_visible=false`), 1 approved credit, 10 memberships, 14 998 punches. **All 67 leave rows have `days` NULL** (see D-P2-8) |

---

## 2. Defects

### P0 — security

**P0-1: HR corrects their OWN approved leave (SoD bypass through a "correction").**
- **Where:** `apps/api/src/services/leave/hr-leave.service.ts:344-368`. The edit/correction branch of `updateLeaveRecord` never compares the caller with the subject. The own-leave checks exist only for decisions (`:317`, `:318`).
- **Probe SOD-1** (`rev7-probes-full.log`):
  - An hr_user linked to their own employee records a leave: 201, PENDING.
  - Another HR approves it for 1 day.
  - The subject then sends `PATCH /leave-records/:id {endDate: +4}` → `{"http":200,"leaveStatus":"APPROVED","start":"2026-11-15","end":"2026-11-19","days":"5.0","audit":{"action":"leave.corrected","reason":"post-decision correction of approved leave"}}`.
  - Four extra days are granted to themselves with no second person.
  - For comparison, SOD-2/3/4 show every decision path refusing self-approval with 403.
- **Fix:** refuse a content change, or any status other than CANCELLED, on a decided leave whose subject is the caller.
  - Use the engine's live-link rule (`isRequestSubject`: current membership `employeeId`, or `subject_user_id`).
  - Keep the owner bypass, audited as `sod_owner_bypass`.
  - Add a regression test.

**P0-2: A `leave.manage` holder writes their own leave decision, comp-off credits and allocations straight through RLS (PostgREST-style, own JWT).**
- **Where:**
  - `supabase/migrations/20260928000700_leave_v2.sql:318`: `leave_records_self_service_guard` returns early for any `leave.manage` holder.
  - `:125`: `leave_allocations`, tenant write = `leave.manage`.
  - `:190`: `comp_off_credits`, tenant write = `leave.manage`.
  - Nothing ties those writes to the separation-of-duties rule.
- **Probe `rev7-rls-probes.sql`** on `flowza_rev7_rls`, rolled back. The actor is a branch_manager (holds `leave.manage`) linked to employee e2, acting as `authenticated` with their own `sub`:
  - **RLS-1:** own leave PENDING → APPROVED: **1 row**.
  - **RLS-2:** own comp-off credit `pending_approval → approved`, `expires_on 2099-12-31`, `days_earned` raised from 0.5 to **1.0**: **1 row**.
  - **RLS-3:** INSERT of an APPROVED credit for themselves: **1 row**.
  - **RLS-4:** allocation of 366 + 366 days to themselves: **1 row**.
- **Controls:** the same writes by a plain employee are refused (5a, 5b, 5d → 42501). `rls_leave.sql` has no case for a manage holder acting on themselves.
- **Fix:** add a database subject guard (BEFORE INSERT/UPDATE triggers) on `leave_records`, `comp_off_credits` and `leave_allocations`:
  - It applies when `current_user = 'authenticated'` and the row's `employee_id ∈ app.own_employee_ids()`.
  - It refuses decision columns (status → APPROVED/REJECTED, `approved_by/at`, `days`, dates of a decided row), any credit status, expiry or days change, and any allocation write.
  - Where the API legitimately needs these writes, perform them in the system scope.
  - Add RLS assertions for hr_user, branch_manager and org_admin acting on themselves.
  - Longer term, make the leave decision columns system-only for `authenticated`. Today any in-scope manage holder can also desynchronise a colleague's leave from its engine request, because the guard exempts `leave.manage` outright at `:318`.

### P1 — functional

**P1-1: Leave day counting ignores rotation-pattern off days, which attendance treats as weekly offs.**
- **Where:** `packages/database/src/leave/balances.ts:70-96`. `loadWorkingCalendars` uses employee → branch → org weekly offs only. Compare `packages/database/src/attendance/load-inputs.ts:218`, which adds `isPatternOff` days.
- **Probe CAL-1:** a Sun–Wed-on / Thu–Sat-off rotation.
  - `{"attendanceWeeklyOffOnThursday":[5,6,4],"leaveDaysSunToThu":5,"compOffPreviewThursday":{"eligible":false,"reason":"working_day"}}`
  - The rostered-off Thursday is charged as leave (5, should be 4).
  - The same day is refused as a comp-off day.
- **Fix:** one working-calendar resolver shared by attendance, leave counting, the balance function and the comp-off preview. It should include the resolved shift-pattern off days for each date.

**P1-2: The leave calendar uses the employee's CURRENT branch, not the branch at each date. A transfer silently recounts the year.**
- **Where:** `balances.ts:74` reads `employees.branch_id` and `branches.weekly_off_days`. The engine resolves placement per date from `employment_history` (`load-inputs.ts:150-155`).
- **Probe CAL-2:** a transfer from A (Fri/Sat off) to B (Thu/Fri off) from 1 July. HR records Sun 3 – Thu 7 May: `{"attendanceWeeklyOffOnThu20260507":[5,6],"leaveSunToThu":[201,4,"APPROVED"]}`. Attendance treats the Thursday as a working day of branch A, but leave charges 4 days.
- **Probe CAL-3:** a leave stored as 5 days and taken in branch A. After the transfer, `{"beforeTransfer":{"taken":5,"available":15},"afterTransferToThuFriOffBranch":{"taken":4,"available":16},"storedDays":5}`. The employee regains a day, and stored `days` no longer equals the balance.
- **Fix:** resolve the weekly offs and the holiday calendar per date from `employment_history`, the same way the attendance engine does.

**P1-3: The unexcused-day charger ignores gender applicability.**
- **Where:** `packages/database/src/attendance/pay-effect.ts:81-82`. `chargeableLeaveTypes` filters `isPaid && !isSpecial && !COMP_OFF && !excluded` but never checks `leaveTypeApplies`.
- **Probe BAL-4:** a female employee whose other types are at 0, with MO a paid, male-only type.
  - `{"chargedTo":"MO","outcome":"charged_leave","chargedLeave":{"status":"APPROVED","type":"MO"},"hrRecordingMoForHer":[400,["NOT_APPLICABLE"]]}`
  - The HR balances list for her does not even show MO.
  - An unexcused day becomes paid leave of a type she can never have, so the pay effect is defeated.
- **Fix:** filter candidates with `leaveTypeApplies(type.applicableGender, employee.gender)`, with the same rule as the portal and the API.

### P2 — minor

**P2-1: Year close carries forward types that do not apply, and carries for leavers with no exit date.**
- **Where:** `apps/worker/src/handlers/leave/year-close.ts:36-37` filters `exitDate` only, with no `employmentStatus`. `:47-68` has no applicability filter.
- **Probe W3:** `rows2027: woman/MO (male only) allocated 5.0 carried 5.0; terminated (no exit date)/MO 5.0/5.0; …/AL 20.0/5.0` (summary: employees 2, created 4, totalDays 20).
- Allocation generation already excludes terminated employees (ALLOC-1 `terminated: null`), so the two paths disagree.
- **Fix:** add `employmentStatus = 'active'` (as generate does) and `leaveTypeApplies`.

**P2-2: Year close has no catch-up if the local 02:00 hour on 1 January is missed.**
- **Where:** `apps/worker/src/handlers/leave/index.ts:38` enqueues only when `month==1 && day==1 && hour==2`.
- **Probe W2** (Muscat): ticks at 01:59:59, 03:00:05 and the next day → `enqueued 0, 0, 0; muscatJobs []`. A worker restart or deploy across that hour skips the close for the year. A manual close queued earlier in the year may also be stale.
- **Fix:** enqueue on any tick from local 1 January 02:00 until a close for (org, fromYear) has completed, for example by keying on a completion audit or marker row. The dedupe key only covers pending jobs (`jobs_queue_dedupe_idx … where status='pending'`).

**P2-3: A level approved while a question is open leaves the leave INFO_REQUESTED at the next level.**
- **Where:** `apps/api/src/services/approvals/engine.ts:278`. `activateStep` sets `currentStep` but never clears `infoRequestedAt`, and the LEAVE hook has no transition back to PENDING on advance.
- **Probe REQ-4:** workflow [MANAGER, HR_ADMIN]. The manager asks "Who covers?" and then approves level 1.
  - `{"requestStatus":"PENDING","currentStep":2,"infoRequestedAt":"…","leaveStatus":"INFO_REQUESTED","portal":{"canReply":true,"infoRequest":"Who covers?"}}`
  - HR at level 2 sees "Info requested", and the employee is asked a question nobody is waiting on.
- **Fix:** on advance, clear `infoRequestedAt` and move the leave to PENDING through the hook, or refuse a decision while a question is open.

**P2-4: A comp-off credit pays for leave dated AFTER the credit expires.**
- **Where:**
  - `packages/database/src/leave/comp-off.ts:36`: `expiresOn >= asOf`, where `asOf` is the approval date (`hooks/leave.ts:44`).
  - The apply-time balance (`packages/domain/src/leave/balances.ts`, comp-off branch) compares with today.
- **Probe CO-1:** `{"creditExpires":"2026-10-08","leaveOn":"2027-02-14","apply":201,"approve":[200,"APPROVED"],"credit":{"status":"used","usedDays":"1.0"}}`. The existing test calls it "usable for 90 days", but this leave falls 139 days after the worked day.
- **Fix:** count and consume only credits with `expires_on >=` the leave's end date (or start date, per the product rule), in both the balance and the consumer.

**P2-5: The comp-off type is editable far beyond name, Arabic name and colour (decision 11).**
- **Where:** `hr-leave.service.ts:97-106`. `assertCompOffTypeInvariant` checks status, allowance, accrual, carry-forward, `portalVisible===true` and `isSpecial===false` only.
- **Probe CO-3:** PATCH → 200 with `{"code":"XCO","requiresApproval":false,"isPaid":false,"allowHalfDay":false,"applicableGender":"female","countMode":"calendar"}` (plus maxConsecutive 1 and notice 30).
  - `requiresApproval=false` auto-approves comp-off redemption.
  - `isPaid=false` makes it unpaid.
- **Fix:** whitelist `name`, `nameAr` and `color` for the COMP_OFF type.

**P2-6: The year-close toast's "View" opens `/sync/<processing-queue job id>`.**
- **Where:** `apps/web/src/features/leave/pages/allocations-tab.tsx:90` calls `toastJobQueued(r.jobId, …)` without `{ to }`. `apps/web/src/features/employees/job-toast.ts:16` defaults to `/sync/${jobId}`.
- **Probes:**
  - **YC-1:** the API returns `jobId "1"`, a `LEAVE_YEAR_CLOSE` job in the `processing` queue, with **no** `sync_jobs` row.
  - **T2** (Playwright): View → `/sync/12121212-…`, which is a dead page for this job. This is AGENTS.md frontend pitfall #1.
- **Fix:** pass `{ to: null }` (toast without a link) or point to a page that shows processing-queue jobs.

**P2-7: The `/my` team upcoming-leave card is shown when empty; B-62 and the brief say "hidden when empty".**
- **Where:** `apps/web/src/features/leave/components/team-upcoming-leave.tsx:41` renders `<EmptyState title={t('team.empty')}>`.
- **Probes:**
  - **T1′** (jsdom): `{"headingShown":true,"emptyStateShown":true,"text":"Team leaveNo upcoming leave in your team"}`.
  - **T6** (Playwright, `/my`, manager, empty team list): en `teamCardShown:true, emptyStateShown:true`; ar `إجازات الفريق` / `لا إجازات قادمة في فريقك` shown.
- **Fix:** return `null` when the loaded list is empty. Keep the card while loading or on error.

**P2-8: Leave stored before v2 (`days` NULL) shows no days in the team calendar and team card, and the calendar total is not clipped to the month.**
- **Where:**
  - `apps/api/src/services/leave/hr-balances.service.ts:277` and `self-leave.service.ts:368` pass stored `days` through (null), unlike `/leave-records` and `/me/leave`, which compute on read.
  - `apps/web/src/features/leave/pages/calendar-tab.tsx:91`: `total = Σ (e.days ?? 0)` over entries that merely overlap the month.
- **Probe CALN-1:** `{"stored":null,"calendar":[null],"teamLeave":[null],"leaveRecords":[3],"portal":[3]}`.
- **Probe T5:** September with Sep 27–Oct 8 (10 working days, 4 of them in September) and a 2-day null row. The shown total is **10**; the correct total is 6.
- The demo seed has 67/67 rows with null days and the local seed 40/40, so on seeded tenants every calendar total reads 0 or wrong.
- **Fix:** compute `days` on read (as `toLeaveDtos` does) and sum only the dates inside the month.

**P2-9: The apply dialog checks a request dated in another year against the displayed year's balance (and holidays).**
- **Where:** `apps/web/src/features/portal/components/apply-leave-dialog.tsx:60-66` uses `data.balances` and `data.calendar` of the year on screen. The API checks the **start year** (`services/leave/common.ts:77-80`).
- **Probe BAL-5** (API): 2026 availableAfterPending **1**. Applying Jan 3–5 2027 → `201, 3 days, warnings []`; 2027 has 17 after pending.
- **Probe T4** (jsdom, same numbers): the dialog says "This is more than your remaining Annual Leave balance (1 days). HR may decline it or record the extra days as unpaid."
- **Fix:** load the start year's balance and calendar in the dialog when the dates leave the displayed year, or drop the balance line in that case.

**P2-10: The documented self-service direct-insert residual bypasses more than `days`: the half-day-pair refusal, gender applicability and locked periods.**
- **Where:** migration 000700:301-310. The self-insert policy's WITH CHECK is the only insert-side control; the guard is UPDATE-only.
- **Probe `rev7-rls-probes2.sql`** (rolled back):
  - **HALF-1:** the employee inserts a SECOND_HALF next to their FIRST_HALF → 1 row. Two active rows on one date, `request=none`. This is exactly the state decision 2 refuses at the API (the day loader charges one leave per date).
  - **HALF-2:** a full day on that date → 23P01. The exclusion works.
  - **HALF-3:** a male-only type for a female employee, inside a locked November period → 1 row accepted.
- **Fix:** before Prompt 10 makes inserts API-only, add an insert guard for `authenticated` self-inserts: applicability, locks, no pair. At minimum, list every bypassed rule in the report's residual note, which currently says only that they "cannot forge balances".

**P2-11: Two identical parallel applications give the loser the generic "concurrent change, retry" 409, not the overlap message.**
- **Where:** `apps/api/src/middleware/error-handler.ts:46`. That text is emitted only for 40001/40P01, so the loser died on a serialisation failure or deadlock rather than on 23P01.
- **Probe REQ-1:** `{"statuses":[201,409],"messages":[null,"The operation conflicted with a concurrent change. Please retry."],"activeRows":1,"requests":1}` in 1065 ms, consistent with a 1 s deadlock timeout. Integrity holds (exactly one row and one request).
- **Fix:** take a per-employee advisory lock before the overlap check and insert, so the loser gets the friendly 409.

**P2-12: Withdrawing an already-cancelled request says "Ask HR to change approved leave".**
- **Where:** `apps/api/src/services/leave/self-leave.service.ts:295`.
- **Probe REQ-6:** `[409,"Only a pending request can be withdrawn (current: CANCELLED). Ask HR to change approved leave."]`
- **Fix:** word the message per status.

**Notes (not defects):**
- `leaveUnits` (`hooks/leave.ts:20-23`) is exported but unused.
- Allocations "inline row edit" is actually a per-row dialog (`allocations-tab.tsx:53`); it works, but the wording differs from the report.
- At 390 px every page, leave or not, overflows by 74 px (en) / 63 px (ar) because of the existing top bar (T3, T6; `/dashboard` and `/employees` identical). The leave screens add nothing.
- "(1 days)" in `portal.overBalance` predates this work (present at `1dc82a9`).

---

## 3. Verified correct (evidence)

**Separation of duties on decision paths**
- **SOD-2:** own leave via bulk decide → item `FORBIDDEN "Self-approval is not permitted: this request is about you."`; `/decide` → 403; the leave stays PENDING.
- **SOD-3:** a login linked to the subject after routing → Leave page 403, engine 403. Editing one's own PENDING leave is allowed and resubmitted (200, PENDING).
- **SOD-4:** a delegation to the subject → decide 403.

**Original Prompt-2 review probes, re-run on the leave path (`rev7-probes-rv2.log`)**
- **I1/I4 (P1-2):**
  - Three HR admins approve level 1 at once → `[200 PENDING, 409, 409]`.
  - A stale bulk item (stepNo 1) → `ok:false "Step 1 is not the current step (2)"`.
  - Bulk without a step → 400; the `/approve` alias without a step → 400.
  - The owner's L2 stays PENDING.
- **O4 (P1-2):** hr_user on the Leave page, without stepNo → `[403, 403]`; with the level seen → `[200 (now step 2), 409]`; the owner's level is still PENDING.
- **P1-3:**
  - The manager approves L1 ("one day is fine"). HR sends `{APPROVED, endDate+4}` → **400 DECIDE_SEPARATELY**, and the leave stays 1 day, PENDING at step 2.
  - The edit alone makes the old request INVALIDATED and a **new** request PENDING at **step 1**, with 5.0 days.
- **P1-4:** after a manager rejection, hr_user `{APPROVED}` → **409** "…that decision stands"; the leave and the request are both REJECTED.
- **P2-4:** the line manager withdraws → engine 403, portal 404. The requester without a reason → 400.
- **P2-9:** covered by the passing web tests named in report §5.

**Balances: one source of truth**
- **BAL-1:** one scenario (allocation 20 + carry-forward 4 expired 31 Mar, 3 used before expiry, opening 2, adjustment −1, pending 2 + 1 of which INFO_REQUESTED).
  - Portal = HR list = CSV = entitlement 24 / cf 3 / expired 1 / taken 3 / pending 3 / available 21 / after pending 18.
  - The approval context shows 20 (other pending only).
- **BAL-2:** monthly accrual, joined 16 Mar → entitlement 9.5, accrued 6.
- **BAL-3:** the charger reads allocation rows and skips an expired carry-forward → charged AO.
- **Carry-forward boundary** (`rev7-domain-cf.log`, the built domain): cf 4 counted in full on 30 and 31 Mar. On 1 Apr only the 1 day used before expiry stays (expired 3, available 22 → 19).
- **Year close** reads `loadLeaveBalances` (`year-close.ts:42`); **the charger** reads it too (`pay-effect.ts:85`).
- The legacy domain `leaveBalances` has no production caller.

**Requests**
- **REQ-2:** advance notice uses the org date at the day boundary. Kiritimati: late 400 `ADVANCE_NOTICE`, ok 201. Los Angeles: ok 201, late 400.
- **REQ-3:** the consecutive cap counts charged days: 7 calendar / 5 working accepted; 8 / 6 → `MAX_CONSECUTIVE`.
- **REQ-5:** thread access. Requester, line manager, USER-step assignee and HR: read 200, post 201. Colleague 404 / 404. Other tenant 403 / 403.
- **REQ-6:** withdraw reason < 3 characters → 400; a colleague → 404; the requester → 200; the request becomes CANCELLED.
- **RLS-5:** employee forging `days`, inserting APPROVED or editing `days` → refused (42501).
- **HALF-2:** a full day overlapping a half day → 23P01.
- **TIER-1:** tiers by days. A LEAVE tier at `minUnits 3`:
  - 1 day → base workflow (1 level); 3 working days → tier (2 levels).
  - A calendar-mode Thu–Mon → 5 days → tier.
  - Editing 1 → 4 days → resubmitted on the tier (2 levels).

**Allocations and year close**
- **ALLOC-1:**
  - Employee 403. Branch manager B creates rows for branch B only.
  - First run 8 created, re-run 0; a mid-year joiner gets 6.0 of 12.
  - Terminated employees and last-year leavers are excluded.
- **ALLOC-2:** duplicate, comp-off type, 1.25, expiry without days, out of branch and 501 rows → all 400; employee 403.
- **YC-1:** employee 403, a future year 400, hr_user 202 with a queue job id.
- **W1:** the year close is enqueued per org at local 02:00 on 1 January (Kiritimati at 12:30Z on Dec 31, Los Angeles at 10:30Z on Jan 1).
- The passing worker test covers comp-off expiry marking exactly `approved` / `partially_used` credits past their date, once.

**Comp-off**
- **CO-2:** a double-redeem race → one APPROVED, the other 409; one active usage; a second apply → `COMP_OFF_BALANCE`.
- **CO-4:** below half a day `BELOW_HALF_DAY`, a working day `WORKING_DAY`; the approver sees 480 claimed vs 300 recorded; self-approval 403.

**Security**
- **SEC-1:** a line manager's crafted balances request → 403; the branch-B calendar → 0 employees; team leave shows only the report.
- **SEC-2:** the CSV without `report.export` → 403; formula cells prefixed `'`; export audited (`rowCount`, `capped`).
- `rls_leave.sql` covers the comment append-only rule (UPDATE/DELETE → 0 rows, even for the owner).

**Web**
- T3 (390 px, en + ar): no raw i18n keys on any leave screen; `dir=rtl` in Arabic.
- B-55 badge colours: `LEAVE_STATUS_TONE` plus the indigo override through `twMerge`; the dot is `bg-current`.
- The passing web tests cover the five tiles, per-type cards, reply and resubmit, edit/withdraw visibility, comp-off, the Balances CSV behind `report.export`, allocations, calendar filters and the Types fields.

**Backward compatibility**
- BC-1…5 pass.
- The pre-v2 web at `1dc82a9` uses `GET /me/leave?year`, `POST /me/leave` and `POST /me/leave/:id/cancel`. Every field of its `SelfLeaveDto` / `SelfLeaveRecordDto` is still served, and `days` is computed for null rows (CALN-1 portal = 3).
- An `INFO_REQUESTED` row renders in the old web as a neutral badge (defaultValue) with no Withdraw button.

**Seeds and migrations:** see the gate table.

---

## 4. Finance parity B-41…B-60: items not (fully) satisfied

| Id | Status | Verdict |
|---|---|---|
| B-41 | ◐ | No **employee-type** applicability and no "automatic" visibility. Also, the charger (P1-3) and the year close (P2-1) ignore gender applicability. **Build** the charger and year-close filters now. Employee-type applicability is a small addition and should be built before claiming parity. The visibility tri-state is acceptable as a boolean. |
| B-44 | ✗ in part | The per-type count mode works, but the working calendar is not the employee's real calendar (P1-1 rotation, P1-2 transfers). **Must fix.** |
| B-49 | deviation | No workflow → pending for `leave.approve` holders (Finance auto-approves). Follows the prompt pack (decision 5). **Acceptable.** |
| B-50 | ◐ | Routed via the manager fallback instead of erroring. **Acceptable** (better behaviour). |
| B-53 | ✗ | Corrections are `leave.manage`-only and audited, but a holder can correct their own decided leave (P0-1) and write their own rows via RLS (P0-2). **Must fix.** |
| B-54 | ◐ | Enforced at the API (existing test) and on engine approval (`assertApprovalUnlocked`). A direct self-insert ignores locks (P2-10). Fix with P2-10. |
| B-57 | ◐ | Reply text required (decision 13): **acceptable**. The stale INFO_REQUESTED (P2-3) should be fixed. |
| B-59 | ◐ | 0.25-hour steps instead of 0.5: **acceptable** (finer, same thresholds). |
| B-60 | ◐ | Earliest-expiry consumption ✓ and the race is safe ✓, but expired-by-leave-date credits are consumed (P2-4). **Fix.** |
| B-62 (listed under P5, but shipped by P7) | ✗ | The card shows when empty (P2-7). Max 20 ✓ (`self-leave.service.ts` `.limit(20)`). |

Satisfied with evidence: B-42, B-43, B-45, B-46, B-47, B-48, B-51, B-52, B-55, B-56, B-58.
- B-45 and B-46 carry the next-year caveat P2-9.
- B-56 rests on the passing web and API timeline tests.

**Verdict on the report's "parity gaps":** B-50, B-57 (the text requirement) and B-59 are acceptable, and so is the B-41 visibility tri-state. The following must be built or fixed: B-41 applicability in the charger and year close, B-44 (the calendar) and B-53 (SoD). B-41 employee-type applicability should also be built before claiming full parity.
