# Phase 7 — Leave v2 (Finance parity)

**Prompt:** `docs/hr-portal/prompt-pack.md` §Prompt 7 (+ the implementing brief and the coordinator addenda: single-transaction migration, backward compatibility, the five leave-path items of the Prompt 2 review, and the integration notes of 2026-09-28).
**Branch:** worktree branch `worktree-agent-a17f99cea31c0cf63` (from `claude/modest-fermi-fnwqq7` @ `ba825d2`), commits `a1e7f6f` … `5dd9913` + this report · **Migrations:** `supabase/migrations/20260928000690_leave_v2_enum.sql`, `supabase/migrations/20260928000700_leave_v2.sql` · **Date:** 2026-09-28.
**Status:** every gate green on the branch (§7). The branch is **not** merged with the integrated branch (`claude/modest-fermi-fnwqq7` @ `7b47fe4`): by the integrator's instruction the integrator merges it; §8 lists every shared file and how to resolve it. Nothing applied to the hosted project (Prompt 12).

## 1. What shipped

### Database (two additive, idempotent migrations; `lock_timeout 5s`, bounded statement timeouts, post-verify blocks)
- **`20260928000690_leave_v2_enum.sql`** — `leave_status` += `INFO_REQUESTED`. Its own file: a new enum value cannot be *used* in the transaction that adds it, and the hosted apply wraps each file in one transaction (the single-transaction replay of the whole chain passes, §7).
- **`20260928000700_leave_v2.sql`**
  - `leave_types` += `requires_approval` (true), `count_mode` `working|calendar` ('working'), `max_consecutive_days` (null, 1–366), `advance_notice_days` (0, 0–365), `applicable_gender` `all|male|female` ('all'), `accrual` `none|monthly` ('none'), `carry_forward_max_days numeric(5,1)` (0), `carry_forward_expiry_months` (null), `is_special` (false), `allow_half_day` (true), `portal_visible` (true), `system_key` (`COMP_OFF` marks the organisation's comp-off type; at most one per organisation). Every existing type keeps today's behaviour (the defaults are the pre-v2 rules).
  - `leave_records` += `days numeric(5,1)` (server-computed at submit / edit; null on older rows — computed on read), `withdrawn_at`, `edited_at`.
  - **`leave_allocations`** — one row per (organisation, employee, type, year): `allocated_days`, `carried_forward_days` + `carried_forward_expires_on`, `opening_balance_days`, `adjustment_days`, `notes`, audit columns. **No stored counters** — taken / pending / available are always computed.
  - **`leave_request_comments`** — the append-only thread (`comment | info_request | reply | system`, body ≤ 2000; trigger `app.reject_modification`). Readable wherever the leave row is readable **or** a LEAVE approval request about it is (so an approver seated only by assignment reads the thread); a client may add only a plain `comment` in its own name; questions, replies and system lines are written by the engine hooks in the system context.
  - **`comp_off_credits`** (`pending_approval → approved → partially_used / used / expired`; `rejected`; `cancelled` when the request is withdrawn; one active credit per employee and worked day; `worked_on_type weekly_off|holiday`, `days_earned ∈ {0.5, 1.0}`, location ≤ 200, summary ≤ 1000) and **`comp_off_usages`** (which credit paid for which comp-off leave; written when that leave is approved, released when it is cancelled, re-booked when HR corrects it).
  - **Overlap protection** — GiST exclusion `leave_records_no_overlap` over (employee, half-day slot range) for PENDING / APPROVED / INFO_REQUESTED: every date is two slots, so a FIRST_HALF and a SECOND_HALF on one date coexist at the database level while a full day conflicts with both. Existing overlapping active rows (none expected) are resolved *before* the constraint is added: the weaker one (PENDING < INFO_REQUESTED < APPROVED, then the newer) is CANCELLED with a decision note, its pending approval request cancelled with a timeline line, and a cancelled APPROVED row queues the recompute of its past days; the migration reports the count.
  - **Self-service RLS** — the employee's insert policy (`leave_records_self_request`) now requires `days is null` and no v2 stamps (the API stores `days` in the system context right after the insert); the self-service update policy + guard trigger allow **only a withdrawal** (PENDING / INFO_REQUESTED → CANCELLED + the withdrawal stamp). Editing one's own request is validated, recomputed and resubmitted by the API and written in the system context — a direct write could otherwise move the dates or forge `days` without the approvers seeing a new request.
  - RLS on every new table through `app.apply_tenant_policies`: own rows, team (`leave.view_team`), organisation (`leave.view` read / `leave.manage` write, branch-scoped), auditor read-only, cross-tenant nothing. Usages and engine-written comments are system-only writes.
  - `organization_settings.leave` (jsonb group: `compOffExpiryDays`, default 90).
  - The comp-off leave type per organisation (code `CO`, or `COFF` when an inactive CO exists; an active type coded CO is adopted): paid, `is_special`, `portal_visible = false`, `system_key = COMP_OFF`.

### Domain / contracts / database package
- **`packages/domain/src/leave/balances.ts` — the one balance function** (`computeLeaveBalances`, pure): entitlement = allocation row (allocated + counted carry-forward + opening + adjustment), or the type's `annual_allowance_days` prorated from the joining date in the joining year when there is no row; taken = APPROVED days in the year by the type's count mode through the working calendar (clipped to the year); pending = PENDING + INFO_REQUESTED; accrued-to-date (monthly accrual: spread over the service months, earned by elapsed days, floored to half days, plus carry-forward / opening / adjustment at once); available = (accrual ? accrued : entitlement) − taken; `availableAfterPending`. Carry-forward counts in full until its expiry; after it only the part used before the expiry stays. The comp-off type is balanced from credits (approved, unexpired − used). Every screen, the API (portal, HR balances, apply warnings, approval context), the unexcused-day charger and the year-close job read balances through it.
- `packages/domain/src/leave/rules.ts` — the validation matrix (applicability by gender, half day allowed, notice, consecutive cap, comp-off balance, over-balance warning); `days.ts` gains `countLeaveDaysByMode` (working / calendar).
- `packages/database/src/leave/` — `loadLeaveTypePolicies`, `loadLeaveBalances` (allocations, records, credits and working calendars around the pure function), comp-off consumption (earliest expiry first) / release, job types + dedupe keys.
- `packages/database/src/attendance/pay-effect.ts` (Prompt 3's charger) — balances through `loadLeaveBalances`; never charges `is_special` types nor the comp-off type (in addition to `excludeLeaveTypeCodes`); stores `days` on the charged leave; a PENDING / INFO_REQUESTED request covering the day is an open explanation (the day is not charged under it — it would also clash with the exclusion constraint).
- Contracts: `dto-features/leave.ts` (schemas + DTOs), `enums.ts` (`INFO_REQUESTED`, active / undecided lists, policy vocabularies, comp-off statuses), `organizations.ts` (`leaveSettingsSchema`, settings group `leave`), `shifts.ts` (leave-type v2 fields, all optional on input), `dto/self-service.ts` (supersets), approvals context `COMP_OFF`, `DOMAIN_EVENT_TYPES` (+3, appended).

### API (`apps/api/src/services/leave/*`; `schedule.service.ts` and `self-service.service.ts` delegate to it)
- `common.ts` (employee / type loading, `evaluateLeaveRequest`, overlap check, period-lock check), `lifecycle.ts` (recompute, resubmit, the caller's seat), `hr-leave.service.ts` (types v2, HR record / change / decide / cancel), `self-leave.service.ts` (portal), `comments.service.ts`, `hr-balances.service.ts` (allocations, balances + CSV, year close, team calendar), `comp-off.service.ts`.
- Approval engine: `submit` gains `notRequired` (a type with `requires_approval = false` records an APPROVED request whatever the workflows say; the hook sees `notRequired`, so no approver is stamped); hooks gain `onInfoRequested` / `onInfoAnswered` (leave → INFO_REQUESTED + an `info_request` comment / back to PENDING + a `reply` comment) and a per-entity withdrawal rule; `managePermission: 'leave.manage'` is declared on the leave and comp-off hooks. New hook `COMP_OFF` (approval → `approved` with `expires_on = worked_on + compOffExpiryDays`; rejection; withdrawal → `cancelled`; inbox context with the day's recorded minutes as evidence). The LEAVE hook books / releases comp-off credits and recomputes the past days.
- Every leave change that moves an approved day (record, decide, correct, cancel, withdraw, auto-approval) enqueues the attendance recompute for the affected days.

### Worker
- `LEAVE_YEAR_CLOSE` (`leave.year-close`): carries `min(available, carry_forward_max_days)` of each employee × type into next year's rows with `carried_forward_expires_on = 1 Jan + carry_forward_expiry_months`; idempotent (a second run changes nothing); leavers skipped; `leave.year_closed` to the `leave.manage` holders (and the HR user who queued it). Scheduled on 1 January at 02:00 organisation-local, deduped per organisation and year; HR can queue it on demand (202 + queue job id).
- `LEAVE_COMP_OFF_EXPIRY` (daily, organisation-local day): marks usable credits past `expires_on` as expired, once; `leave.comp_off_expired` to the employee.
- Outbox `ROUTING` (+3, appended): `leave.comment_added` (targeted: the other side of the thread), `leave.year_closed`, `leave.comp_off_expired`.

### Web
- **HR Leave page** (`/leave`): tabs **Requests** (engine status + level + waiting-for, the request detail with the approval levels / timeline and the comment thread; decisions name the level the user saw), **Team calendar** (month grid, approved + pending, branch / department filters), **Balances** (employee × type: entitlement / accrued / taken / pending / available; filters; CSV only for `report.export`), **Allocations** (year selector, generate for the year, inline row edit, year close with confirmation → queued-job toast), **Types** (the v2 policy fields; the comp-off type edits only name / Arabic name / colour).
- **Portal `/my/leave`**: five tiles (entitlement, used, pending, available, accrued to date) + a card per type (carry-forward and accrual lines), the apply dialog (live day count by the type's count mode, balance after, warnings; notice / consecutive cap / half day / comp-off balance / overlap with the employee's own active leave refused before sending), my requests with status badges (approved emerald, rejected red, pending amber, cancelled slate, info requested indigo), the engine timeline, the thread with reply & resubmit, edit / withdraw where the API allows them, and the comp-off card (request a credit with the day's preview, my credits, use comp-off).
- **`/my` home**: *Team upcoming leave* for managers with `leave.view_team` (approved or pending, ending today or later, max 20). **Approvals inbox**: the COMP_OFF context. **Settings → Leave**: comp-off expiry days. en + ar for everything.

### Seeds
- `supabase/seeds/demo-tenant/03b_employee_portal.sql` — gender-specific ML / PTL, AL notice + carry-forward policy, the comp-off type, Priya's 2026 allocation rows (a 2025 carry-forward that expired in March) and an approved comp-off credit. Local seed (`packages/database/src/seed`) — the comp-off type and non-overlapping random leave.

## 2. Endpoints (all under `/api/v1/orgs/:orgId`)

| Method & path | Who | What |
|---|---|---|
| `GET /me/leave?year` | `leave.request` | types (portal-visible, applicable), balances (v2 fields + pre-v2 ones), records (engine status, days, `canEdit` / `canWithdraw` / `canReply`), calendar |
| `POST /me/leave` | `leave.request` | apply: validation matrix, `days` stored, engine submit (`units` = days); `warnings[]` never block |
| `PATCH /me/leave/:id` | own filing, undecided | edit: re-validated, days recomputed, the pending request invalidated and a new one submitted (an open question counts as answered) |
| `POST /me/leave/:id/withdraw` `{reason}` | own filing, undecided | → CANCELLED + engine cancel with the reason; approved leave → "contact HR" |
| `POST /me/leave/:id/cancel` | own filing | pre-v2 alias of withdraw (default reason) |
| `POST /me/leave/:id/reply` `{body}` | the person the leave is about | `reply` comment, engine `answerInfo`, back to PENDING |
| `GET /me/team/leave` | `leave.view_team` + direct reports | team upcoming leave |
| `GET /me/comp-off`, `GET /me/comp-off/preview?workedOn`, `POST /me/comp-off` | `leave.request` | credits + balance + rules; preview of a worked day; request a credit (engine COMP_OFF) |
| `GET/POST /leave-records/:id/comments` | readers of the leave (requester, managers, the request's actors / delegates, `leave.view` / `leave.manage`) | the thread; a post tells the other participants |
| `GET /leave-balances` · `GET /leave-balances/export` | `leave.view` · + `report.export` | computed balances (paginated) · CSV (formula-escaped, BOM, audited, capped) |
| `GET /leave-allocations` · `PUT /leave-allocations` · `POST /leave-allocations/generate` | `leave.view` · `leave.manage` · `leave.manage` | list · bulk upsert (audited) · rows from allowances, prorated for joiners, only missing ones |
| `POST /leave-allocations/year-close {fromYear}` | `leave.manage` | 202 + queue job id |
| `GET /leave-calendar?month&branchId&departmentId&includePending` | `leave.view` (branch scope) or `leave.view_team` (team) | month grid |
| existing `GET/POST/PATCH/DELETE /leave-types…`, `GET/POST/PATCH/DELETE /leave-records…` | as before | v2 fields added, pre-v2 bodies and fields kept (§6) |

## 3. Decisions (priority order Security > Reliability > Data Integrity > Scalability > Maintainability > Performance > UX)

1. **No stored counters** (brief over the prompt pack's `used_days` trigger): one pure balance function, read everywhere, so a screen, the charger and the year close can never disagree.
2. **One leave per date at the API** (`ALLOW_HALF_DAY_PAIRS = false` in `leave/common.ts`), although the database exclusion admits a FIRST_HALF + SECOND_HALF pair as specified. The attendance day loader charges **one** leave per date, so a pair would leave the other half "to be worked" and hand it to the unexcused-day sweep — wrong pay effect (Data Integrity over UX). The employee edits the half-day request into a full day instead. Enabling pairs = combine both halves in the loader (now `packages/database/src/attendance/load-inputs.ts` on the integrated branch), then flip the switch and the test.
3. **Self-service writes are API-validated**: `days` cannot come from a client insert, and a client update can only withdraw (§1). **Edit and withdraw belong to whoever filed the request**: a request HR filed for the employee is HR's to change or withdraw (the portal says so) — the integrated engine's own withdrawal rule.
4. **Withdrawal rule for LEAVE / COMP_OFF = the integrated engine's `canCancel`**: the requester; the owner or `approval.manage`; or `leave.manage` **with** the organisation-wide `leave.view` (branch scope applies). A merely seated approver cannot withdraw; the subject of a request they did not file cannot either (the owner excepted).
5. **No workflow for LEAVE** → an employee's application is PENDING for the `leave.approve` holders in reach (prompt pack: "none ⇒ auto-approved if `requires_approval=false`, else pending for `leave.approve` holders"); HR recording leave for somebody else without a workflow keeps the pre-v2 direct approval; HR recording **their own** leave is routed to the other approvers (never auto-approved). `requires_approval = false` ⇒ an APPROVED request at once with no approver stamped.
6. **Notice and the consecutive cap refuse the employee but only warn HR** (HR records leave after the fact); the balance only ever warns (B-46); the comp-off balance refuses (a credit is a hard quantity, B-60).
7. **Locked periods** block everyone except `attendance.lock_period` holders, whose change is audited with the reason (B-54 per the brief; Finance's "manage holders" is expressed by FlowZa Time's lock key).
8. **Post-decision changes are corrections** (`leave.manage` only, audited `leave.corrected`, days recomputed, past days recomputed — B-53); content and a decision are never mixed in one call (P1-3); an engine decision is never flipped by a status PATCH (P1-4).
9. **INFO_REQUESTED is set by the engine only** (approver's question → leave INFO_REQUESTED + `info_request` comment; reply or edit → PENDING); it counts as pending in balances and holds its dates.
10. **Comp-off**: earned in minutes (the portal takes hours in 0.25 steps), days by `attendance.stats.fullDayHours` (≥ full → 1, ≥ half → 0.5, below → refused); the worked day must be the employee's weekly off or a holiday by the working calendar and not in the future; the daily record's minutes pre-fill the claim and are shown to the approver as evidence. Redemption is ordinary leave of the comp-off type (the apply refuses more than the credits still free after pending comp-off requests); credits are consumed earliest-expiry-first when that leave is approved, released when it is cancelled and re-booked when HR corrects it. `comp_off_usages` (an extra table over the brief) makes that reversible and auditable.
11. **The comp-off type is system-managed**: always active, no allowance / accrual / carry-forward, hidden from the ordinary apply form and from allocation generation; only name / Arabic name / colour are editable.
12. **Balances CSV** reuses `report.export` (the same check the integrated exports enforce), formula-escaped cells, UTF-8 BOM, audited, capped at `LEAVE_BALANCE_EXPORT_MAX_EMPLOYEES`.
13. **`reason` stays required on apply** (pre-v2 contract, `min(3)`), and the withdrawal reason is required on the v2 route (Finance B-98) with a default only on the pre-v2 `/cancel` alias; a reply needs text (a question deserves an answer; resubmitting without one is the edit).
14. **The leave RLS suite is self-contained** (its approval-assignee case builds its own request inside a rolled-back transaction) and runs **before** `rls_approvals.sql`, which stays the last suite.

## 4. Finance parity — Appendix B leave items B-41…B-60 (+ ATT-44)

| Id | | How |
|---|---|---|
| B-41 | ◐ | active + `portal_visible` + gender applicability; comp-off excluded from the ordinary form. Not built: applicability by **employee type**, and Finance's "automatic" visibility tri-state (a boolean, default visible) |
| B-42 | ✓ | the one balance function (allocation or type default, unexpired carry-forward, opening, adjustment; pending incl. INFO_REQUESTED; accrued to date) |
| B-43 | ✓ | five tiles (entitlement, used, pending, available, accrued) |
| B-44 | ✓ | per type (`count_mode`): calendar inclusive or working days by the working calendar (weekly offs employee → branch → organisation, holidays) |
| B-45 | ✓ | type, from, to (≥ from), reason; live day count and balance after |
| B-46 | ✓ | `OVER_BALANCE` warning, never blocks (server `warnings[]`, client shows it) |
| B-47 | ✓ | client-side (own pending / info-requested / approved leave) + exclusion constraint (+ friendly 409 before it) |
| B-48 | ✓ | `days` recomputed and stored server-side (a client cannot set it); end before start refused |
| B-49 | ✓ | through the engine (LEAVE, units = days); no policy ⇒ pending for `leave.approve` holders, auto-approved only for `requires_approval = false` (prompt pack rule, decision 5) |
| B-50 | ◐ | no "set your reporting manager" error: the engine's manager chain falls back (secondary manager → HR), so the request is routed instead of refused (Prompt 2 design) |
| B-51 | ✓ | own pending / info-requested: overlap re-checked, prior request invalidated, resubmitted |
| B-52 | ✓ | withdraw → CANCELLED + engine cancel with the reason |
| B-53 | ✓ | decided leave: `leave.manage` only, audited `leave.corrected` |
| B-54 | ✓ | locked periods: `attendance.lock_period` holders only, audited |
| B-55 | ✓ | badge colours as listed; the rejection note is shown |
| B-56 | ✓ | the engine timeline (submitted, level approved / advanced, approved, rejected, info requested / answered, cancelled, skipped, with notes) |
| B-57 | ◐ | question required → INFO_REQUESTED; the reply requires text (decision 13); resubmitting without a comment is the edit |
| B-58 | ✓ | append-only thread; requester, managers, approvers (incl. delegates / assignment), HR read and post within RLS; author + timestamp |
| B-59 | ◐ | date ≤ today, worked-on type, location ≤ 200, summary ≤ 1000, preview from the organisation's thresholds; hours in **0.25** steps (0–24) rather than 0.5 |
| B-60 | ✓ | half day only on a single date, within the credit balance and the consecutive cap, earliest expiry first |
| ATT-44 | ✓ | comp-off redeem (a leave of the comp-off type consuming credits) |

## 5. Review fixes (assigned from Prompt 2 review)

| Item | Fix | Regression tests |
|---|---|---|
| **P1-2** a decision without `stepNo` re-targets the current level | the HR Leave page sends the level the user saw (`stepNo` = the request's current step while it is pending); the API's legacy PATCH without `stepNo` settles only a seat the caller holds (403 otherwise), a stale level is 409 | API `P1-2: a Leave-page decision names its level; without it only a seat the caller holds is settled`; web `P1-2: a decision sends the level the user saw (stepNo); P2-9: the toast says only the level moved` |
| **P1-3** content + decision in one PATCH skips invalidation | refused with `DECIDE_SEPARATELY`; the edit alone invalidates and resubmits, a decision afterwards approves what the leave now says | API `P1-3: content and a decision in one call are refused — the edit is saved (and resubmitted) first` |
| **P1-4** HR can overturn an engine rejection | a leave decided through the engine keeps agreeing with its request: flipping is 409 ("that decision stands"), cancelling stays possible | API `P1-4: an engine rejection is not overturned by a status PATCH — the leave agrees with its request` |
| **P2-4** approvers withdraw others' leave, reason optional | the withdrawal rule of decision 4 (engine route and portal), a reason on the v2 route; HR-filed requests are HR's | API `P2-4: withdrawal belongs to the requester or leave.manage — never to an approver merely seated`, `own filings (review P2-4, B-98)` (2 tests) |
| **P2-9** "Leave approved" after a level approval | the toast reports what happened: approved / rejected, or "Level N approved — waiting for …" / decision recorded | web `P2-9: says "approved" only when the leave is, "level N approved" when only the level moved` (model), `P2-9: "Leave approved" only when the leave itself is approved` (page) |

## 6. Backward compatibility

Every pre-v2 call the current web and any older client make keeps working; each has an API test:

| Id | Call | Test |
|---|---|---|
| BC-1 | HR `PATCH /leave-records/:id {status, decisionNote}` | still decides through the engine for a seated HR user (one-seat levels close as before); the pre-v2 response shape is kept |
| BC-2 | `GET /me/leave` | every pre-v2 field of types, balances, records and calendar kept (v2 fields added) |
| BC-3 | `POST /me/leave` with the pre-v2 body | applies (PENDING, days stored) |
| BC-4 | `POST /me/leave/:id/cancel` without a body | still withdraws (default reason "Withdrawn by the requester") |
| BC-5 | `GET /leave-records` | pre-v2 fields kept, v2 ones added (`days`, `withdrawnAt`, `editedAt`, approval status / level / waiting-for, `commentCount`) |

Also kept: leave-type create / update accept pre-v2 bodies (v2 fields optional with the pre-v2 defaults); existing types behave as before; existing leave rows get `days` on read; `leave.requested` / `leave.approved` / `leave.rejected` unchanged. **Deliberate changes:** an employee can no longer edit a request through a direct table write (withdraw only), can no longer edit or withdraw a request HR filed for them, and the pre-v2 web portal's withdraw moved to the v2 route with a reason (`portal.test.tsx` updated).

## 7. Verification (local Postgres 16 @ 127.0.0.1:54329; DB-sharing suites under `flock /tmp/flowza-dbtests.lock`; all on the final branch state)

| Gate | Result |
|---|---|
| `pnpm build:packages` | pass |
| `pnpm lint` (`--max-warnings 0`) | pass |
| `pnpm -r --filter "./apps/*" run typecheck` | pass (api, web, worker) |
| `pnpm test:unit` | pass — shared 4, contracts 5, domain 261 (new `leave/balances.test.ts` 16, `leave/rules.test.ts` 11; `days.test.ts` 6), device-providers 165, database 20 |
| `pnpm --filter @flowza/web run test` | pass — 60 files, 247 tests (new: `leave/model.test.ts` 6, `leave/pages/leave-page-v2.test.tsx` 10, `portal/leave-v2.test.tsx` 11, `settings/sections/leave-section.test.tsx` 3; `portal.test.tsx` withdraw updated) |
| `PGDATABASE=flowza_p7_rls bash supabase/tests/run-rls-tests.sh` | pass — 289 assertions, 71 of them in the new `rls_leave.sql` (employee own rows only, cannot allocate / decide / forge days / edit directly, withdraws own pending; manager team only; approval assignee reads and comments on the thread of the leave routed to them only; owner org-wide; branch manager branch scope; auditor read-only; owner B cross-tenant nothing; anon denied; exclusion constraint half-day slots) |
| `pnpm test:db` | pass — 2 files, 11 tests |
| `pnpm --filter @flowza/api run test` | pass — 22 files, 266 tests (new `leave-v2.test.ts`, 42 tests: types v2, validation matrix, edit / withdraw / info loop, review fixes, separation of duties, own filings, corrections + locks, allocations / balances / CSV / year close, comp-off earn / approve / redeem / reject / expiry setting, thread + team + calendar, BC-1…BC-5; `review.test.ts` B-54 now checks both sides) |
| `pnpm --filter @flowza/worker exec vitest run` | pass — 14 files, 135 tests (1 skipped, pre-existing Chromium PDF); new `leave/leave.test.ts` 5 (year close carry / cap / expiry / leavers, idempotency, comp-off expiry once + notice, both schedulers deduped in local time) |
| `pnpm -r --filter "./apps/*" run build` | pass |
| `PGDATABASE=flowza_p7_ci2 bash scripts/db-reset-local.sh` | pass (all migrations on a fresh DB) |
| `PGDATABASE=flowza_p7 … --seed` + `pnpm db:types` | pass; `db.ts` in sync (committed, no diff) |
| single-transaction replay (`replay-single-tx.sh … flowza_p7_tx`) | pass (000690 + 000700 in one transaction with the whole chain) |
| demo-tenant seeds `01`…`05` incl. `03b_employee_portal.sql` | pass on a scratch database with the local auth shim (67 demo leave rows, 3 allocation rows, the comp-off type) |
| `pnpm --filter @flowza/web run build:e2e && … test:e2e` (`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`, `CI=1`) | pass — 36 tests; new `e2e/leave.spec.ts`: an employee applies with a live day count ("This request uses 5 working days.", "25 days of Annual Leave left after this request.") and finds it under My requests as Pending, 5 days. The mock backend serves every leave endpoint the portal and HR pages call |

## 8. Merge notes for the integrator (`claude/modest-fermi-fnwqq7` @ `7b47fe4`)

Files changed on **both** sides since `ba825d2`, and how to resolve them:

| File | Resolution |
|---|---|
| `apps/api/src/services/approvals/engine.ts` | take the integrated engine and re-apply three leave additions: (1) `SubmitInput.notRequired` and its branch in `submit` (`input.notRequired \|\| (!row && AUTO_APPROVE)`, `workflowId`/`decidedBy` null when `notRequired`, event reason, `notRequired` in the hook context); (2) `await hookFor(req.entityType)?.onInfoRequested?.(…)` after the `info_requested` event in `requestInfo`, and `onInfoAnswered?.(…)` after the `info_answered` event in `answerInfo`; (3) **drop** my two-line `mayCancel` short-circuit at the top of `canCancel` — the integrated `canCancel` is the same rule |
| `apps/api/src/services/approvals/hooks/index.ts` | take the integrated interface; keep my `HookContext.notRequired`, `EntityHook.onInfoRequested` / `onInfoAnswered`, the `compOffHook` import and `COMP_OFF: compOffHook` registration; `managePermission` exists on both sides (same meaning); **drop** `mayCancel` (+ the `MembershipGrant` import if unused) and remove `mayCancel: mayWithdrawLeave` from `hooks/leave.ts` and `hooks/comp-off.ts` (then `mayWithdrawLeave` can go; the integrated `familyKeys` already gives LEAVE / COMP_OFF the leave keys) |
| `packages/contracts/src/dto-features/approvals.ts` | union: my `COMP_OFF` member of `ApprovalContextDto` + their `ApprovalDecideVia` / abilities additions |
| `packages/contracts/src/organizations.ts` | union: my `leaveSettingsSchema` / `resolveLeaveSettings`, `leave` group and `SETTINGS_GROUPS += 'leave'` + their `meDtoSchema.approvals` |
| `packages/contracts/src/sync.ts` (`DOMAIN_EVENT_TYPES`) | union: `report.scheduled_delivery` + `leave.comment_added`, `leave.year_closed`, `leave.comp_off_expired` |
| `packages/contracts/src/dto-features/index.ts` | union of the export lines (`hr-workspace`, `report-schedules`, `leave`) |
| `apps/worker/src/handlers/notifications/outbox.ts` (`ROUTING`) | union: their finance / report routes + my three leave routes (my entries use `recipients: 'users'` / `'user'` and no `channels`; `channelsOf` applies to them unchanged) |
| `apps/worker/src/tasks/index.ts` | union: `...reportTasks, ...leaveTasks` |
| `apps/api/src/routes/v1/features/index.ts` | union: `registerHrAttendanceRoutes`, `registerReportScheduleRoutes`, `registerLeaveRoutes` |
| `apps/api/src/services/me.service.ts` | union (theirs: the `/me` approvals summary; mine: `leave` added to the settings columns `/me` reads) |
| `apps/web/src/features/approvals/api.ts` | union: their `meQueryKey` / required `stepNo` / `reason` / `items` + my `DOCUMENTS` additions (`leave-comments`, `leave-balances`, `leave-calendar`). My web code never calls the approval `decide` / `cancel` / `bulkDecide` mutations, so their stricter signatures need no change on my side |
| `apps/web/src/locales/{en,ar}/settings.json` | union: their integration keys + my `nav.leave` |
| `apps/web/e2e/support/mock-backend.ts` | union: keep their routes and my `leaveRoute` + fixtures |
| `supabase/tests/run-rls-tests.sh` | isolation → system_context → `rls_hr_workspace.sql` → `rls_leave.sql` → `rls_approvals.sql` (**last**). `rls_leave.sql` needs only the isolation fixtures |
| `packages/database/src/generated/db.ts` | regenerate from a fresh `--seed` reset (never hand-merge) |

Also for the merge:
- **Migrations** sort `…000600` (theirs) → `…000690` / `…000700` (mine) → `…000800` (their engine review fixes). `000800` rewrites the approval read policies (member-only, assignment); my comment-thread policy reads through `approval_requests` RLS and needs no change. Run the single-transaction replay on the merged chain.
- **Loader**: I made **no** change to the attendance day loader (so nothing to port into `packages/database/src/attendance/load-inputs.ts`). My only attendance-side change is the charger `packages/database/src/attendance/pay-effect.ts` (not touched on the integrated side).
- **Engine calls from leave code**: `submit`, `decideWithin` (always with an explicit `stepNo` — the caller's seated level or the one the page saw), `cancelForEntity`, `invalidateForEntity`, `answerInfo` — all signature-compatible with the integrated engine. `self-leave.service.ts` defines its own `DEFAULT_WITHDRAW_REASON` with the same text as the engine's export; it can import the engine's instead.
- **Tests that pin behaviour the integrated engine also changes**: every HTTP `/approvals/:id/decide` call in `leave-v2.test.ts` names `stepNo`, every `/cancel` carries a reason ≥ 3 characters. The integrated `answerInfo` refuses an answer with no open question — the leave reply path only answers after a question (INFO_REQUESTED), and the edit path invalidates instead of answering.
- **Shared registries I appended to** (no other edits): `DOMAIN_EVENT_TYPES`, outbox `ROUTING`, scheduler tasks, worker handler registry, `SETTINGS_GROUPS`, the settings nav / routes / lazy pages, the approvals context union, the locale files.

## 9. Known limits / follow-ups
- **Half-day pairs** are refused at the API until the day loader combines FIRST_HALF + SECOND_HALF (decision 2).
- **Day-close sweep** (Prompt 3, `apps/worker/src/handlers/attendance/day-close.ts`) still treats only APPROVED leave as an explanation: a day covered by a PENDING / INFO_REQUESTED request can be marked UNEXCUSED (the charger will not charge it — decision in §1). The owner of the sweep should treat undecided leave as a pending explanation.
- **Direct PostgREST self-service writes** remain possible within the tightened policies (an own PENDING insert without `days`; an own withdrawal): a direct withdrawal leaves the engine request pending, a direct insert has no request (HR decides it on the direct path). Both are narrower than before v2 and cannot forge balances; making these writes API-only needs the base self-service RLS assertions in `rls_isolation.sql` changed (Prompt 10).
- **Balances CSV** has no hourly quota (the integrated summary export's `consumeQuota` is module-private; wire one after the merge).
- **B-41** employee-type applicability and the "automatic" visibility tri-state; **B-50** no reporting-manager error (routed instead); **B-57** reply needs text; **B-59** 0.25-hour steps.
- `accrual` has no `yearly` value (the brief's vocabulary; yearly = `none` with an allocation). Demo leave rows keep `days` null (computed on read).
- Leave notification templates beyond the three new routes (e.g. `leave.info_requested`) are Prompt 8.

## 10. Files
- Migrations: `supabase/migrations/20260928000690_leave_v2_enum.sql`, `supabase/migrations/20260928000700_leave_v2.sql`; RLS: `supabase/tests/rls_leave.sql`, `supabase/tests/run-rls-tests.sh`; seed: `supabase/seeds/demo-tenant/03b_employee_portal.sql`.
- Domain: `packages/domain/src/leave/{balances,rules,days}.ts` (+ tests), `packages/domain/src/index.ts`.
- Contracts: `packages/contracts/src/{enums,organizations,shifts,sync}.ts`, `dto/self-service.ts`, `dto-features/{leave,approvals,schedule,index}.ts`.
- Database: `packages/database/src/leave/{balances,comp-off,index}.ts`, `attendance/pay-effect.ts`, `generated/db.ts`, `seed/index.ts`, `index.ts`.
- API: `apps/api/src/services/leave/*`, `services/approvals/{engine.ts,hooks/index.ts,hooks/leave.ts,hooks/comp-off.ts}`, `services/features/{schedule.service,leave-defaults}.ts`, `services/{self-service,me}.service.ts`, `lib/settings.ts`, `routes/v1/features/{leave,index}.ts`; tests `routes/v1/features/{leave-v2,review,self-service}.test.ts`.
- Worker: `apps/worker/src/handlers/leave/{index,year-close,comp-off-expiry,leave.test}.ts`, `handlers/index.ts`, `handlers/notifications/outbox.ts`, `tasks/index.ts`.
- Web: `apps/web/src/features/leave/**` (api, model, types, components, pages + tests), `features/portal/{leave-api.ts, components/{apply-leave-dialog,comp-off,leave-parts,parts}.tsx, pages/{leave-page,home-page}.tsx, leave-v2.test.tsx, portal.test.tsx}`, `features/approvals/{api.ts,components/parts.tsx}`, `features/settings/{nav.ts,routes.tsx,pages/lazy.tsx,sections/leave-section(.test).tsx}`, `locales/{en,ar}/{leave,settings}.json`, `e2e/{leave.spec.ts,support/mock-backend.ts}`.
