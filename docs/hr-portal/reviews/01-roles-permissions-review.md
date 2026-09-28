# Prompt 1 review — Roles & permissions per global standard; manager semantics

Reviewed at `0749045` (`a09fd74`, `b09ef6f`, `0749045` on `claude/modest-fermi-fnwqq7`) in an isolated worktree; nothing tracked was modified (`git status` clean at the end; the throwaway API probe file was deleted). Databases used: `flowza_rev1` (seeded), `flowza_rev1_rls`, `flowza_rev1_ci2` (left in place; `flowza`, `flowza_p3`, `flowza_p9` untouched). Probe artefacts: `scratchpad/rev1/probes.sql` (SQL) — the API probe file lived at `apps/api/src/test/zz-rev1-probes.test.ts` and its output is quoted below.

## 1. Gates (all re-run from scratch in the worktree)

| Gate | Result |
|---|---|
| `pnpm install --frozen-lockfile && pnpm build:packages` | PASS |
| `pnpm lint` (`eslint . --max-warnings 0`) | PASS |
| `pnpm -r --filter "./apps/*" run typecheck` | PASS (api, web, worker) |
| `pnpm test:unit` | PASS — shared 4, domain 194, device-providers 140, database 20 (23 files, 358 tests) |
| `pnpm --filter @flowza/web run test` | PASS — 48 files, 179 tests |
| `PGDATABASE=flowza_rev1_rls flock … run-rls-tests.sh` | PASS — `rls_isolation.sql` + `rls_system_context.sql`, 93 assertions |
| `flock … pnpm test:db` | PASS — 2 files, 11 tests |
| `pnpm --filter @flowza/api run test` (under the lock) | PASS — 17 files, 171 tests |
| `pnpm --filter @flowza/worker run test` (under the lock) | PASS — 10 files, 104 passed, 1 skipped (pre-existing) |
| `pnpm -r --filter "./apps/*" run build` | PASS |
| `PGDATABASE=flowza_rev1 bash scripts/db-reset-local.sh --seed` | PASS — 500 employees, 23,071 punches/events, 14,915 daily records, 10 logins (incl. `manager@` / `auditor@albahja.example`) |
| `PGDATABASE=flowza_rev1_ci2 bash scripts/db-reset-local.sh` (second fresh apply) | PASS |
| Re-apply `20260928000100` on the seeded `flowza_rev1` (idempotency) | PASS — exit 0; `pg_policies` counts identical before/after on all 74 tables; exactly one signature each for `apply_tenant_policies`, `apply_readonly_tenant_policies`, `team_employee_ids`, `team_employee_ids_deep`, `org_ids_with_any_permission`, `principal_snapshot`; role grants 17/14; 59 permission keys; self-service policies (`leave_records_self_request/_self_cancel`, `attendance_corrections_self_request`, `leave_types_self_service_select`) and `*_platform_ctx` policies all still present |
| `DATABASE_URL_ADMIN=…/flowza_rev1 pnpm db:types && git diff --exit-code -- packages/database/src/generated/db.ts` | PASS (in sync; file restored) |
| Demo tenant seed `02_people.sql` twice (idempotency) | PASS with a widened local shim — the seed writes the hosted `auth.users` shape (`instance_id`, `aud`, …) and `auth.identities`, which the local shim lacks, so out of the box it fails at line 277 (pre-existing shim gap, not Prompt 1). With those columns added on `flowza_rev1_ci2`: run 1 = run 2 = 10 memberships (owner…manager, auditor), 5 secondary managers exactly as documented (`MG-1011/1012/1013 → MG-1009`, `MG-2002/2003 → MG-1019`), `manager@` = MG-1010 Arun Menon with 3 reports, `auditor@` = MG-1007 |
| Throwaway API probe file (10 probes) | 10/10 ran; findings below |

Not run: Playwright e2e (not in the requested gate list).

## 2. Defects

1. **P1 (functional) — a `manager`-role user cannot request a correction on their OWN record (403).** `apps/api/src/services/features/attendance.service.ts:366-370` (`correctionGrant` returns `selfService:false` for any `attendance.correct` holder, so the `attendance.request_correction` branch is never reached) + `:379` (`if (!selfService) requireTeamOrPermission(actor.principal, orgId, input.employeeId, 'attendance.view')`), and `apps/api/src/lib/authorize.ts:24-26` (`isTeamMember` reads `teamEmployeeIds`, which never contains the caller's own record). Repro (API probe P3.4b): `POST /orgs/:orgId/attendance/corrections {employeeId: <manager's own e4>}` as `manager` → `403 FORBIDDEN "Missing permission: attendance.view — and the employee is not one of your direct reports."`. Before Prompt 1 any `attendance.correct` holder could file for anyone including themselves; the system role ships both keys and its own record is now the one employee it cannot touch. Fix: exempt the caller's own record — e.g. `if (!selfService && input.employeeId !== grant.employeeId) requireTeamOrPermission(…)` (or let `requireTeamOrPermission` pass when `m.employeeId === employeeId`), and prefer routing an own-record request through the self-service branch (check `request_correction` + `employeeId === grant.employeeId` before `attendance.correct`) so it is not auto-approved (see #3). Add the case to `team.test.ts`.

2. **P1 (security/functional) — B-75 is not implemented: termination/offboarding leaves the linked login active.** `apps/api/src/services/employees.service.ts` `updateEmployee` (296-341) and `deleteEmployee` (345-353) never touch `org_memberships` (the only membership reference in the file is the `unlinked` filter at :53). Repro (P3.7): `PATCH /employees/:e1 {employmentStatus:'terminated', exitDate}` → 200; the membership stays `{status:'active', employeeId:e1}`; `/me` → 200 with the membership; `/orgs/:orgId/me/overview` → 200. SQL probe (m): the manager's own record archived + terminated with the membership left active still yields `team_employee_ids()` = 21 and reads a report's 30 daily rows. The pack maps B-75 to Prompt 1 explicitly ("on `employment_status` → terminated/resigned suspend the linked membership") and the phase report does not mention it. Fix: on status → terminated/resigned (update, bulk set-status) and on archive, suspend memberships whose `employee_id` = the employee (system scope), audit it and revoke sessions (AGENTS.md: suspension → revoke sessions); additionally make `app.team_employee_ids()` / `team_employee_ids_deep()` / `principal_snapshot` ignore a caller whose own record is `deleted_at is not null` (join the membership's employee row) so an archived manager loses the team even if the login is missed.

3. **P2 (design/security) — a line manager's correction for a report is applied with no review.** `attendance.service.ts:415`: with no workflow configured, a requester holding `attendance.approve` is auto-approved; the `manager` role carries `attendance.correct` + `attendance.approve` per the matrix. Repro (P3.4c): manager files `ADD_PUNCH` for direct report e5 → `201 approval=AUTO_APPROVED` (applied by the worker, no second pair of eyes). Finance §5.4 lets the mapped manager review notes/regularisation but keeps add/edit/bulk of records to HR `manage`. Recommend: exclude callers who pass only through the team branch (no org-wide `attendance.view`) from the auto-approve shortcut (create PENDING, hr_admin step) until Prompt 2 routes manager corrections through the engine.

4. **P2 (data integrity) — no cycle guard on the reporting line.** `PATCH /employees/:e4 {managerEmployeeId: e5}` while `e5.manager = e4` → 200 (P3.6f); at the DB level `manager = self` and `C1↔C2` cycles are accepted (SQL probe k; the primary-manager FK is the pre-existing plain `references employees(id)`). `team_employee_ids_deep()` is depth-bounded so it terminates (probe i), but Prompt 2's manager-chain would resolve back onto the subject/report. Fix: in `assertReferences`/`updateEmployee` walk the proposed manager's primary chain (≤ 10) and refuse when it reaches `selfId` (name the field), optionally a trigger.

5. **P2 (information disclosure) — `GET /employees?unlinked=true` is served to any `employee.view` holder and computed in system scope** (`employees.service.ts:52-58`, `:93`), so `auditor` and `manager` learn which employees hold a login or a pending invitation although `/members` is 403 for them. Repro (P3.8): auditor `GET /employees` → 9 rows, `?unlinked=true` → 4 rows ⇒ 5 linked ids inferred; `GET /members` → 403. Fix: `if (q.unlinked) requirePermission(actor.principal, orgId, 'user.view')` (the invite/member dialogs already sit behind user management).

6. **P2 (RLS defence-in-depth) — the write side is not team-scoped and the status column is unconstrained.** SQL probe (w): as `manager`, `INSERT INTO attendance_corrections (… employee_id = <non-report> …, status = 'APPROVED')` → 1 row under RLS (`attendance_corrections_insert` = `attendance.correct AND branch`). Recorded as decision 5; the API is the only guard and it is the layer carrying #1. Recommend: `AND (org has attendance.view OR employee_id = any(team))` on the INSERT/UPDATE policies of the team tables, or at minimum require `status = 'PENDING'` for `authenticated` inserts as the self-request policy already does.

7. **P2 (spec deviation, recorded) — the `manager` role reads the whole employee directory.** Probes b/e: 500 rows incl. archived, non-report rows visible; Prompt 1 §2 says "employee.view (team via RLS)" and Finance §5.3 gives a mapped manager own + direct reports. The `employees` team predicate itself works (probe l: a custom team-only role sees exactly own + 30 reports and no other department), but the system role carries the org-wide key. Options: an `employee.view_team` key held by `manager` instead of `employee.view` (`/team` and `?teamOf=` only need the team predicate; `RequirePermission` on `/employees/:id` would need the same treatment).

8. **P2 (UX / B-109) — `/team` renders "You have no direct reports" while `/me` is loading.** `apps/web/src/features/team/pages/team-page.tsx:25` gates on `useActiveMembership()?.isManager`, which is `null → false` before data (`use-me.ts:24-29`); the route has no guard wrapper (`team/routes.tsx`, deliberate). Same flash as `RequirePermission` (pre-existing pattern, no loader). Also the "My team" nav item appears for relationship-only managers (e.g. the `employee` role) who then see only a count and a hint to ask for `employee.view` while RLS hides every team row from them (decision 1) — inconsistent messaging. No data leak: the list query is `enabled` only with `employee.view`.

9. **P3 (migration hygiene)** — (a) the header says the post-verify "fails the migration rather than leaving a half-applied state", but `scripts/db-reset-local.sh` applies files with `psql -f` in autocommit (no `-1`/`begin`), so locally a failing post-verify would not roll anything back (idempotency makes a re-run safe; hosted `apply_migration` is transactional). (b) `invitations_org_employee_idx` is partial on `accepted_at is null`, so the FK's `on delete set null` lookup cannot use it for accepted invitations (small table; cosmetic). (c) the new `employees` index is not `CONCURRENTLY` — consistent with every other migration in the repo (none uses it) but contrary to AGENTS.md's hot-table rule.

10. **P3** — `createRole` now refuses keys `manager`/`auditor` (409, P3.10) while a tenant that already has a custom role with one of those keys keeps two same-key roles in the list (system + custom). Cosmetic; the test rename in `core.test.ts` is correct.

## 3. Verified correct (evidence)

- RLS team predicate (SQL probes, `app.uid()`/`current_user` asserted in band each time): manager reads a direct report's daily records (30), leave (2), corrections (1), events (44), raw punches (44), employee row; a non-report's daily/leave/corrections/events/raw all 0; visible daily rows = own + direct reports exactly (660, computed independently); peer manager rows 0; secondary link grants the same reads (probe c); a `manager`-role user with no reports sees only own rows (probe e); `employee` role with a report sees nothing beyond own (suite + probe).
- Auditor: reads all 500 employees, 14,915 daily records, 40 leave records, 23,071 events and raw punches, org/branches/departments/shifts/audit log/period summaries; no `view_sensitive`, no devices; 21 write attempts across 15 tenant tables (employees, leave_records, attendance_corrections, attendance_daily_records, attendance_events, shifts, departments, branches, organizations, org_memberships, leave_types, holidays, roles, organization_settings, invitations) all refused (42501 or 0 rows), incl. self-promotion.
- Cross-tenant (probe g): a cross-org PRIMARY manager pointer is storable (pre-existing plain FK) but never enters the team (`e.organization_id = m.organization_id` in the helper and in `principal_snapshot`); a team key held only in org B plus a relationship in org A reveals nothing in org A; crafted `flowza_system`/`org_id`/`employee_id`/`team` claims under `authenticated` reveal nothing (`app.is_system()` false).
- `team_employee_ids()` empty with no membership, unknown `sub`, no `sub`, suspended membership (probes h, m); archived report leaves the team and its rows disappear (probe m).
- `team_employee_ids_deep()` terminates on 2- and 4-cycles (5 s statement timeout), excludes the caller, reaches depth 5 and not 6, follows the secondary only when the primary is null, and RLS stays direct-reports-only (probe i).
- `app.principal_snapshot(uuid)`: no EXECUTE for `authenticated`, `anon`, `flowza_system`, `flowza_worker`; `flowza_api` keeps it; direct calls raise 42501 (probe j). Team helpers stay executable by `authenticated` (they are policy helpers).
- `invitations.employee_id` composite FK refuses another org's employee (23503); same-org link accepted; `employees_secondary_manager_fkey` refuses cross-org (23503); CHECK refuses secondary = self and secondary = primary (23514) (probe k). API mirrors it with named 400s (P3.6: self, kept-secondary, kept-primary, org-B employee, POST manager = secondary).
- Invitations: already-linked employee → 409; reserved-by-invitation → 409 for a second invite and for a member re-link; accept lands the link on the new membership; when the employee is taken meanwhile the membership is created unlinked (P3.5).
- `/me` `isManager`/`teamSize` correct for manager (2), manager2 (1), relationship-only hr_user (1), employee/auditor/owner (0) (P3.3); `requireTeamOrPermission` refuses an org-B employee for a manager (403) while HR gets the service's 400 "Employee not found" (P3.2); non-report correction → 403 (P3.4).
- Migration: `drop procedure` signatures match the originals in `20260905000500` exactly (no stale overload); `lock_timeout`/`statement_timeout` set; `on conflict` shapes match reference data; escalation trigger allows the `postgres` session for system roles; policy generators keep the self-service and platform-context policies (names differ from the generator's five).
- Web: every key used by `team-page.tsx`, the sidebar section/item, the profile "Reports to" line, the form hints, the portal profile row and the two new matrix categories exists in `en` and `ar`; `team.json` en/ar key parity (plural forms normalised); DB `permissions.category` values = locale `categories.*` keys (16/16 in both languages); matrix groups by the DB category; mock backend `ALL_PERMISSIONS` = the 59 contract keys; `/team` never issues the list query without `employee.view`.

## 4. Acceptance list

| Item | Status |
|---|---|
| ATT-70 own + direct reports unless view_all | PASS for attendance/leave/corrections/events/raw; PARTIAL for the employee directory (defect #7) |
| ATT-71 select scoped; insert manage-or-own; update/delete manage | PASS for select/update/delete; insert for `attendance.correct` is org-wide, status unconstrained (defect #6) |
| ATT-72 punch visibility follows the wall; punch writes manage-only | PASS (raw + events team-scoped; writes `flowza_system` only) |
| ATT-113 catalogue in the role editor; templates | PASS (13 keys, 2 roles, groups en/ar) |
| B-72 accept preserves role, links employee, releases stale links | PASS |
| B-73 per-org employee role | PASS by design (global system role) |
| B-75 termination revokes access | **FAIL** (defect #2) |
| B-77 visibility wall on attendance rows | PASS |
| B-78 leave visible to employee/managers/view_all | PASS (approvers/delegates = Prompt 2) |
| B-79 own leave edits only while undecided | PASS (pre-existing policies intact) |
| B-80 notes read-only | n/a (Prompt 4) |
| B-106 permissions from `role_id`; global templates | PASS |
| B-107 roles editor cannot grant beyond own; system roles immutable | PASS (trigger + service; new keys 409) |
| B-108 impersonation read-only | n/a |
| B-109 loader then Access Denied | PARTIAL (no loader on `/team` nor on the pre-existing guard; defect #8) |

Fix #1 and #2 inside this phase (both are one-file service changes plus tests); #3–#6 are small and worth taking now because Prompt 5 will build the team workspace on exactly these seams.
