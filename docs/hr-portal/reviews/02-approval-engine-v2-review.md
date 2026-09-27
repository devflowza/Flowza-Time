# Prompt 2 review — Approval engine v2 (adversarial test agent)

Head reviewed: `b86809a` (commits `d398f7a..b86809a` on `0749045`), worktree reset from `1dc82a9`, tree left clean.
Databases used: `flowza_rev2` (seeded), `flowza_rev2_rls` (RLS suite), `flowza_rev2_ci2` (fresh replay, then a v1-shaped DB).
API/worker probes were throwaway vitest files inside the repo (deleted; `git status` clean) plus SQL scripts in the scratchpad.

**Verdict: not closable.** 4 P0 (security), 7 P1 (functional), 13 P2. Every gate is green; the defects are behaviours the
suites do not exercise.

## 1. Gates (re-run from scratch)

| Gate | Result |
|---|---|
| `pnpm install --frozen-lockfile` + `pnpm build:packages` | pass |
| `pnpm lint` (`--max-warnings 0`) | pass |
| typecheck api / web / worker | pass |
| `pnpm test:unit` | pass: shared 4, domain 220 (17 files), device-providers 140 (6), database 20 (2) |
| `pnpm --filter @flowza/web run test` | pass: 51 files, 197 tests |
| RLS (`PGDATABASE=flowza_rev2_rls`, locked) | pass: 137 `ok:` assertions, 44 of them in `rls_approvals.sql`, 0 failed |
| `pnpm test:db` (locked) | pass: 2 files, 11 tests |
| API `vitest` | pass: 18 files, 195 tests |
| worker `vitest` (locked) | pass: 11 files, 110 passed, 1 skipped (pre-existing) |
| apps build | pass (the web chunk-size warning predates this phase) |
| Fresh replay of every migration on `flowza_rev2_ci2`, plus a second apply of `20260928000200` | pass, pass |
| Second apply of `20260928000200` on the seeded `flowza_rev2` | pass, with no data drift (the md5 of request id/status/step matches, and the 30 actors are unchanged) |
| `pnpm db:types` against the fresh replay, then `git diff --exit-code` | in sync: 82 tables, diff rc 0 |
| Playwright (`build:e2e` + `test:e2e`, `/opt/pw-browsers/chromium`) | pass: 34 passed. No scenario covers `/approvals*`; only the dashboard card is touched |

## 2. Defects

### P0: security

**P0-1: A line manager can decide levels they are not seated on, which includes closing the HR level of their own report's request.**
- **Where:**
  - `apps/api/src/services/approvals/engine.ts:50` sets `permHolder = approve key && (org-wide view key || isTeamMember(...))`.
  - Line 51 turns that into `via='permission'`.
  - Line 272 sets `override=true`.
  - Line 278 then settles the whole level.
  - The DTO (`dto.ts` abilities) sets `canDecide=true` for this case.
- **Probe:** Workflow LEAVE `[MANAGER, HR_ADMIN]`. staff5 (employee e5, whose manager is e4) applies for leave. `lineManager` holds only the `manager` role.
  - L1 decide: 200, PENDING, `currentStep` 2.
  - GET as `lineManager` at L2: `abilities.canDecide: true`.
  - L2 decide by `lineManager`: **200 APPROVED**. The leave is APPROVED with approvedBy `lineManager`.
  - Timeline: `submitted, step_approved, advanced, override, step_approved, approved`.
  - L2 actors: lineManager APPROVED (path `override`); hrAdmin, hrLinked and hrAdmin3 SKIPPED.
- **Same for ATTENDANCE_CORRECTION** filed by HR for e5 with `[MANAGER, HR_ADMIN]`: correction APPROVED, 1 `APPLY_CORRECTION` job.
- **Impact:** A two-level "manager → HR" workflow gives no HR control. This violates the review item "a manager reads and decides exactly their assigned steps".
- **Fix:**
  - Team-scoped approve holders never override. Drop `|| isTeamMember(...)` from the decide/override path; a line manager acts only where seated or delegated.
  - Require an explicit, matching `stepNo` for every override.
  - Add an API test: "manager cannot decide the HR level".

**P0-2: Suspended or removed members keep RLS read access to approval data.**
- **Where:** Migration `20260928000200`.
  - Line 332: `id = any(app.approval_assigned_request_ids())`.
  - Line 334: `requested_by = app.uid()`.
  - Neither branch checks membership. The SECURITY DEFINER function at line 305 does not check it either.
  - `approval_delegations_select` (line 380, either side of the delegation) has the same gap.
- **Probe (SQL, seeded DB):** Actor `b483e561…` is the HR admin seated on all 15 seeded requests.
  - Membership set to `suspended`:
    - `app.member_org_ids()` returns 0.
    - `employees` returns 0 rows.
    - `approval_requests` returns **15**, `approval_steps` **30**, `approval_step_actors` **30**, `approval_request_events` **51**.
  - Requester `ac728b5c…` suspended: requests **15**, events **51**.
  - Membership row **deleted**: requests 15, events 51, actor rows with comments 3.
  - A suspended delegator still reads the org's delegation row, including its reason ("medical leave").
  - Control: an outsider who was never a member sees 0 everywhere, and `anon` gets permission denied.
- **Impact:** An ex-employee (for example, a former HR admin) with a fresh JWT can read the org's approval metadata, free-text comments and reasons through PostgREST. This is a pre-existing narrow gap (`approval_steps_assignee` in `20260905001400:181`) that v2 widened to requests, actors and events.
- **Fix:**
  - AND the assignee, requester and delegation branches with `organization_id = any((select app.member_org_ids())::uuid[])` (active memberships).
  - Make `approval_assigned_request_ids()` join active memberships.
  - Add RLS cases for a suspended assignee, a suspended requester and a removed member.

**P0-3: The workflow switch `allowSelfApproval` lets an approval.manage holder approve their own request.**
- **Where:**
  - `packages/contracts/src/dto-features/approvals.ts:60` exposes the switch.
  - `packages/domain/src/approvals/resolve.ts:105` lifts segregation of duties entirely.
  - `engine.ts:54` does the same at decide time; `escalate()` honours it too.
- **Probe:**
  - hrLinked (hr_admin, employee e6) POSTs a LEAVE workflow `[HR_ADMIN]` with `allowSelfApproval: true`: 201.
  - They record their own leave: PENDING, and they are seated.
  - They decide APPROVE on it: **200 APPROVED**. The leave shows approvedBy hrLinked.
  - Timeline: `submitted, step_approved, approved`. There is no `sod_owner_bypass` or other bypass event; the only audit row is `approval.approved`.
- **Impact:** The pack says the subject can never approve their own request even as HR, and its step schema carries `allowSelfApproval: false`. Here a non-owner turns SoD off for themselves.
- **Fix:** Remove the switch. If it must stay, make it owner-only, never let it cover the decider's own record unless the decider is the owner, and log a bypass event on the timeline and in the audit trail.

**P0-4: Segregation of duties keys on a submit-time snapshot only.**
- **Where:** `engine.ts:191` stores `subject_user_id` once; `engine.ts:55` compares against that snapshot only.
- **Probe:**
  - Employee e20 has no login.
  - HR records leave for e20 with workflow `[HR_ADMIN]`. `subject_user_id` is null.
  - The org then links hr20 (hr_admin, already seated) to e20.
  - hr20 decides APPROVE: **200 APPROVED**. Timeline `submitted, step_approved, approved`; no refusal.
- **Also affected:** `bypassRequest` and `canCancel` use the same snapshot. Invitation acceptance links logins to employees (Prompt 1), so this sequence is realistic.
- **Fix:** Also refuse when `grant.employeeId === req.employeeId`, except for the owner, who is logged. Apply this to decide, bypass, reassign-target and request-info.

### P1: functional

**P1-1: Reassigning a QUORUM level turns the next approval into a terminal rejection.**
- **Where:** `engine.ts:413-415` skips every pending seat and seats one person while keeping `required_count`. `packages/domain/src/approvals/evaluate.ts:20` then treats `approved+pending < required` as rejected.
- **Probe:**
  - Workflow CORRECTION `[HR_ADMIN, QUORUM 2]` with 3 seats.
  - The owner reassigns the level to payroll.
  - payroll decides **APPROVE** with comment "Looks right": 200, **status REJECTED, terminal true**.
  - The correction is REJECTED with `rejectionReason = "Looks right"`.
  - Timeline: `submitted, reassigned, step_rejected, rejected`.
- **Fix:** On reassign, lower `required_count` to what can still be satisfied (or seat the reassignee as the level's sole decider). Never let an APPROVE produce a rejection.

**P1-2: A decision without `stepNo` re-targets to whatever level is current, so one approval closes two levels.**
- **Where:**
  - `engine.ts:246` defaults the step: `stepNo = input.stepNo ?? req.currentStep`.
  - These callers never send the step the user saw:
    - `bulkDecide` (`engine.ts:317`, i.e. the inbox "Approve selected");
    - the HR Leave page (`schedule.service.ts:555`);
    - the `/approve` and `/reject` aliases (`approvals.ts:46-47`).
- **Probes:**
  - **I4:** Workflow `[HR_ADMIN, USER owner]`. hrAdmin approves L1 (stepNo 1), and the owner is notified. hrLinked then sends bulk-decide on the same id: ok, **APPROVED**. The L2 row shows hrLinked `override`, and the owner is SKIPPED.
  - **I1:** 3 HR admins approve L1 concurrently. Result `[200 PENDING, 409, 200 APPROVED]`: the late L1 click approved the owner's level.
  - **O4:** hr_user clicks Approve twice on the HR Leave page against `[MANAGER, USER owner]`. The first click closes L1; the second closes the owner's L2.
- **Note:** The inbox decision dialog does send `stepNo`, so that path is safe.
- **Fix:** Require the step the caller saw on bulk (per item), on the Leave page and on the aliases. Refuse an override that does not name the current step.

**P1-3: An HR PATCH that edits leave content and records a decision in one call skips invalidation (B-96).**
- **Where:** `schedule.service.ts:551` writes the content first, then 553-555 decides. The invalidate branch only runs when no decision is being made.
- **Probe:**
  - The manager approves L1 of a 1-day leave with the comment "one day is fine".
  - hrAdmin PATCHes `{status: APPROVED, endDate: +4 days}`: 200.
  - The leave ends APPROVED for **2027-07-11 → 2027-07-15** on the same request.
  - Timeline: `submitted, step_approved, advanced, step_approved, approved`. L1 approved a different leave from the one that was granted.
- **Fix:** When the content changed and a request is pending, invalidate and resubmit (or refuse and ask to save the edit first). Never decide in the same call.

**P1-4: HR can overturn an engine rejection.**
- **Where:** `schedule.service.ts:562-564`.
- **Probe:**
  - LEAVE `[MANAGER]`. The manager rejects with "No cover".
  - hr_user, who is not an approver, PATCHes `{status: APPROVED}`: 200.
  - The leave is APPROVED (approvedBy hr_user), while the request **stays REJECTED**.
- **Impact:** The History view and the document disagree, and no approver was involved.
- **Fix:** Treat REJECTED → APPROVED as a new submission, or refuse it. At minimum, supersede the old request and log the override.

**P1-5: The RLS helper scans every tenant's approval data on every approvals read.**
- **Where:** Migration lines 305-318 plus the request policy. `approval_steps`, `approval_step_actors` and `approval_request_events` inherit the cost through EXISTS.
- **Probe:** Seeded DB plus a synthetic tenant with 100k requests, 200k steps and 400k actors.

  | Read | Before | After |
  |---|---|---|
  | Seeded HR admin, `count(approval_requests)` (15 visible) | 7 ms | **752 ms** |
  | Seeded HR admin, steps | 3.8 ms | **1,158 ms** |
  | Employee with 1 visible request | 5.6 ms | **644 ms** |
  | Heavy approver (100k assignments), `count` | — | **22.3 s** |
  | Heavy approver, one request by id | — | **510 ms** |

  EXPLAIN for the HR admin read shows the InitPlan `approval_assigned_request_ids()` at 651 ms / 407,098 buffers, plus a seq scan that removes 100k rows.
- **Impact:** Every approvals read costs O(size of the global table), and the function returns an array of every historical assignment.
- **Fix:** Use correlated EXISTS (or UNION branches) keyed on indexes: `approval_step_actors(user_id, step_id)`, `approval_steps(request_id)` and `(approver_user_id)`, scoped to the caller's active organisations. Do not return arrays.

**P1-6 (web): Approvers who hold no approve key cannot reach the inbox.**
- **Where:** `apps/web/src/features/approvals/api.ts:138` sets `inbox = approver || manager`; `route-guards.tsx:17-19` guards `/approvals` on it; `sidebar.tsx:67` hides the nav item on the same rule.
- **Who is affected:** Delegates, USER-step approvers and escalated actors who hold no approve key.
- **Probe:** A throwaway component test rendered `InboxRoute` for an employee-role member (no reports) whose API inbox returns a decidable row: **"You do not have permission to view this page."** is shown and the row is not rendered.
- **API side:** The same delegate reads and decides the request (existing `approvals.test` delegation case; probes H and H2b).
- **Impact:** Such a person can act only through notification deep links; the delegation feature is half-usable.
- **Fix:** Open `/approvals` to every member (the API scopes it), or expose an assignee/delegate signal from `/me` for the nav item and the dashboard card.

**P1-7: The owner of a single-admin organisation cannot file their own leave or correction.**
- **Where:** `resolve.ts:107` drops the subject at every rung, including the owner rung (141). `engine.ts:204` then returns 400, so the documented owner SoD bypass (`engine.ts:55`) is unreachable.
- **Probe:** An org with one owner linked to an employee and no HR admin.
  - `POST /me/leave`: **400**.
  - `POST /leave-records` for their own record: **400**.
  - Their own correction: **400**.
  - Each 400 reads "Approval workflow level 1 has no eligible approver (subject excluded; segregation of duties left nobody; no HR admin or owner available)".
- **Regression:** Before v2, HR-recorded leave was inserted APPROVED, so this worked.
- **Fix:** At the owner rung, when the subject is the only owner, seat them or auto-approve, and record `sod_owner_bypass`.

### P2: minor

1. **Delegation windows use two different "today"s.** The engine uses the org date (`orgToday`). RLS (migration line 316) and the inbox `mine` query (`queries.ts:29`) use `current_date` (UTC). Probes with the org on Pacific/Kiritimati (org date 2026-09-28, DB date 2026-09-27):
   - Window = DB date only (**H2**): the delegate sees the item in their inbox and gets GET 200, but `canDecide` is false and decide returns 403.
   - Window = org date only (**H2b**): the delegate cannot see it (inbox missing, GET 404) yet decide returns **200 APPROVED**.

   For Muscat this mismatch is a 4-hour window at each boundary.
2. **Reassign problems** (`engine.ts:411-415`):
   - **C2:** A reassign can seat the requester, who then approves their own filing (200 APPROVED).
   - **C3:** Reassigning to someone who already rejected resets their actor row from REJECTED to PENDING, erasing the decision.
3. **Info-request gaps:**
   - **D2:** The subject can ask for information on their own request: 200, `canRequestInfo` true (`engine.ts:480` ignores `sodBlocked`).
   - **M:** An answer with no outstanding question is accepted (200, `engine.ts:497`).
4. **Withdrawal rights and reason (B-98).** `canCancel` (`engine.ts:376-381`) plus the optional reason (`approvals.ts:115`) let an approver withdraw somebody else's leave with no reason. Probe: the line manager cancels staff5's leave: 200, and the leave becomes CANCELLED. In Finance, leave withdrawal belongs to the requester and needs a reason.
5. **Misleading resolution reason (E2).** A suspended manager is reported as "primary manager: no linked login". `context.ts:37` maps active memberships only, and `resolve.ts:33` reports that as "no linked login". The path taken (`secondary`) is correct.
6. **E-mail action has no dedicated brute-force limit.** Probe J3: 60 random tokens all returned 404, with no 429 and no audit of the failures; only the generic 600/min/user limit applies. Tokens are 256-bit and bound to the signed-in user, so the risk is low. Finance uses per-IP limits (POST 20).
7. **QUORUM on single-seat approver types saves, then every submission fails.** `workflows.ts:26` does not validate it.
   - Probe: MANAGER with QUORUM 2 saves (201); every leave application then gets 400 "requires 2 approvals but only 1 approver(s) resolved". USER with QUORUM 2 behaves the same.
8. **The workflow uniqueness index is bypassable** (migration line 114, `md5(applies_to::text)`). Probe G:
   - `appliesTo.branchIds [A,B]` and `[B,A]`: both 201.
   - An identical copy: 409.
9. **HR Leave page toast is wrong for a level approval.** It says "Leave approved" (`leave-page.tsx:46`) when only one level was approved; the API returned PENDING in O4 and K2.
10. **The migration leaves closed requests with PENDING steps.** On the v1-shaped DB, r105 (REJECTED) and r108 (superseded, now CANCELLED) keep PENDING steps, and `activated_at` is set on them (migration line 183). History renders "Pending" levels on closed requests.
11. **Pending-count badge.**
    - No sidebar/topbar pending badge exists (Prompt 2 §6).
    - The dashboard badge (`dashboard.service.ts:72`) counts every RLS-visible pending request, while the card lists only "mine".
12. **Playwright** does not cover `/approvals`, `/approvals/delegations`, the workflow editor or the e-mail page. The mock backend stubs only the dashboard's calls.
13. **Design risk (Finance B-91 extended).** An organisation-wide approve holder settles a whole ALL, QUORUM or named-USER level in one call.
    - **A4:** hr_user closes an HR_ADMIN ALL level.
    - **O4:** hr_user closes the owner's USER level.

    Finance approves one row per call. Consider requiring `approval.manage` (bypass, with a reason) for levels that name somebody else.

## 3. Verified correct (with evidence)

**Level evaluation and concurrency**
- ALL, ANY and QUORUM behave as specified, and a rejection is terminal only when the level can no longer be satisfied (existing API and domain tests pass).
- ALL-level race of approve and reject: one REJECTED, the other two 409 (I3).
- A repeated decision is a no-op; a non-current `stepNo` returns 409 (existing tests).
- Concurrent decisions on the last level: exactly 1 winner, 1 `APPLY_CORRECTION` job, 1 `approved` event and 1 `correction_approved` event (I2).
- Level advance notifies only the level-2 actors (N1).

**Segregation of duties**
- The subject is refused even as HR.
- A subject who is also the manager's delegate is not seated and gets a 403 "about you" (O3).
- The owner bypass is logged as `sod_owner_bypass` (existing test).
- Requester last resort works: the owner is the only resolvable approver, the path is `owner`, the reason reads "requester kept: only resolvable approver", and the owner decides (L3).

**Approver resolution**
- Absence ladder:
  - no login → secondary (E1);
  - suspended → secondary (E2);
  - active delegation → manager plus delegate, and the delegator can still act (E3);
  - on leave with a delegate → the delegate replaces the manager (E4);
  - on leave with no secondary → HR admins (E5);
  - SECONDARY_MANAGER type with none set → HR (E6).
- MANAGER_CHAIN: level 1 resolves to `primary`, level 2 to `chain_step_2`, and level 3 on a 2-rung chain to `chain_top` with a reason.
- DEPARTMENT_HEAD resolves; when the department head is the subject it falls back to HR. BRANCH_MANAGER is scoped to the subject's branch.
- ROLE steps:
  - by permission, the step seats a custom-role holder (F2);
  - by role id, it does not seat them.

**Delegation**
- A one-day window in org time works at submit and at decide time (H).
- The entity-type filter is honoured: 403 for a correction under a leave-only delegation (H3).

**Workflow selection**
- Tiers: 1 day falls below every tier and uses the permission fallback; 3 days uses the `min 2` workflow; 5 days uses the `min 4` workflow (G).
- appliesTo: a matching department selects the workflow; a branch mismatch falls back.

**No workflow**
- An APPROVED request row always exists and the hook runs once:
  - HR-recorded leave produces `auto_approved`;
  - an owner correction is AUTO_APPROVED with 1 `APPLY_CORRECTION` job (L1, J4).

**Bypass and bulk**
- Bypass without a reason returns 400; hr_user and a manager get 403; the waiting approvers are notified (existing test).
- Bulk decisions authorise each item: the in-team item is approved and the other is refused FORBIDDEN and stays PENDING (J2).

**Access control**
- Crafted ids:
  - other team → read 404, decide/cancel/request-info 403;
  - another org through our route → 404;
  - another org's route → 403;
  - bulk on another org's id → NOT_FOUND, and it stays PENDING (J1).
- A suspended approver gets 403 (J5).

**E-mail tokens**
- Single use, and the sibling token is spent with it.
- Expiry is enforced.
- A token is useless to another user (404).
- GET never acts: 400, and the request stays PENDING.
- An org-B token on the org-A route returns 404; a non-member gets 403; the right route returns 200 (O1).
- Only the hash is stored.

**RLS**
- Tokens and digest runs are not readable by clients (permission denied).
- Client UPDATE and DELETE affect 0 rows, and a delegation INSERT violates RLS.
- An outsider sees 0 rows; `anon` is denied.
- `rls_approvals.sql` passes 44 assertions.

**Corrections hardening**
- HR's own correction is PENDING and routed without them.
- An own SET_STATUS correction is refused with 403.
- A manager's correction for a report is PENDING; for a non-report it is 403; the manager cannot decide their own filing.
- A client INSERT of an APPROVED correction is refused, and UPDATE/DELETE affect 0 rows (RLS suite).

**History CSV**
- Requires `report.export`, escapes formula injection, and is audited (existing test).

**Worker (injected clock)**
- Digest goes out at the first run at or after 08:00 local, once per local day:
  - LA (UTC-7): 07:30 no, 08:05 yes; 23:30 and 00:30 (UTC date already changed) no; 08:00 the next day yes.
  - Kiritimati (UTC+14): 18:00Z the previous UTC day → digest dated for the local day.
- Reminders fire once per level, including a level activated later (at +25 h after its activation).
- Escalation happens exactly once; "nobody else to escalate to" is recorded (HR none, owner = subject) and not retried (W3).

**v1 in-flight backfill (v1-shaped database)**
- Named user seated.
- A named user who is the requester or the subject falls back to the owner.
- Role members honour branch scope and exclude the subject.
- A suspended named user or a member-less role falls back to the owner.
- Closed requests are untouched and duplicates are retired.
- `subject_user_id` is back-filled.
- Idempotent: 10 actors after the second apply.

**Web**
- en/ar parity holds (approvals 283 en / 295 ar, the extra keys being Arabic plural forms); every static `t()` key exists.
- The dynamic key families (entity, approverType, timeline, status, path, scope, view) are complete.
- The All scope chip is hidden without an org-wide key.
- Reject requires a comment.
- The decision dialog sends `stepNo`.
- The e-mail page acts only on click.
- The sidebar shows Approvals to managers.

## 4. B-81…B-105 not (fully) satisfied

| Id | Status | Why |
|---|---|---|
| B-81 | ◐ | Reordered `appliesTo` duplicates (P2-8) |
| B-83 | ◐ | Quorum not validated against resolvable seats (P2-7) |
| B-87, B-92 | ✗ | P0-3, P0-4; requester can be re-seated by reassign (P2-2) |
| B-91 | ✗ | Line managers decide unassigned levels (P0-1) |
| B-93, B-94 | ◐ | Reassign + QUORUM (P1-1) |
| B-95 | ◐ | 409 by design, but unguarded re-targeting (P1-2) |
| B-96 | ◐ | P1-3, P1-4 |
| B-98 | ◐ | Reason optional; approvers withdraw others' leave (P2-4) |
| B-101 | ◐ | No dedicated limiter, failures not audited (P2-6) |
| B-104 | ◐ | P1-1, P2-2 |
| B-105 | ◐ | Inbox unreachable for key-less approvers (P1-6); no pending badge (P2-11) |

Everything else in B-81…B-105 behaves as the phase report claims.
