# Phase 1 — Roles & permissions per global standard; manager semantics

**Prompt:** `docs/hr-portal/prompt-pack.md` §Prompt 1 (+ the coordinator addendum: helpers on the membership link only; fix the dropped employee link on invitations).
**Branch:** `claude/modest-fermi-fnwqq7` · **Migration:** `supabase/migrations/20260928000100_roles_manager_and_permissions.sql` · **Date:** 2026-09-27.
**Status:** every gate green (see §4); nothing applied to the hosted project (Prompt 12).
**Review fixes:** the adversarial review's findings are resolved or assigned in §6 (migration `20260928000150_p1_review_fixes.sql`); where §1–§5 below describe behaviour those fixes changed, the entry says so.

## 1. What shipped

### Database (one additive, idempotent migration)
- **13 permission keys** in `public.permissions` (`on conflict do update`): `attendance.view_team`, `attendance.checkin`, `attendance.note`, `attendance.review_notes`, `attendance.manage_geofences`, `attendance.manage_overtime`, `leave.approve`, `leave.view_team`, `shift.request_swap`, `approval.manage`, `approval.delegate`, `report.schedule`, `integration.manage`. Two new categories, `approval` and `integrations`.
- **Two system roles**: `manager` (`10000000-0000-0000-0000-000000000009`, "Line Manager") and `auditor` (`…0010`, read-only), with exactly the permission sets of the prompt (17 and 14 keys; the migration's post-verify asserts both counts).
- **Grants to existing system roles** (matrix below). Custom roles are untouched.
- **`employees.secondary_manager_employee_id`** (nullable; composite FK `(id, organization_id)` → employees, `on delete set null`; check `secondary <> id and secondary is distinct from manager`; partial index).
- **`invitations.employee_id`** (nullable; composite FK → employees, `on delete set null`; partial index) — the addendum defect.
- **Helpers** (`security definer`, `search_path = ''`, executable by `authenticated, flowza_system, flowza_api, flowza_worker`):
  - `app.team_employee_ids()` — direct reports of the caller: employees whose primary **or** secondary manager is one of the caller's own employee records, resolved through `org_memberships.employee_id` only (never `employees.user_id`), same organisation, not deleted.
  - `app.team_employee_ids_deep()` — the reporting chain to depth 5 (level 1 = primary or secondary; deeper levels follow the primary manager, the secondary only when no primary is set; the caller's own records are excluded) for the manager-chain approver of Prompt 2.
  - `app.org_ids_with_any_permission(text[])` — `org_ids_with_permission` over a set of keys (same three sources: memberships, system context, platform grants).
- **Policy generators** `app.apply_tenant_policies(…, p_team_col, p_team_perms text[])` and `app.apply_readonly_tenant_policies(…, p_team_col, p_team_perms text[])`: the read policy becomes `(org-wide key AND branch scope) OR self OR (team key AND <col> = any(app.team_employee_ids()))`. Old signatures dropped first (an added defaulted parameter is an overload → ambiguous calls), new ones `create or replace`. Re-applied on `employees` (team keys `attendance.view_team`/`leave.view_team`, `employees_insert` override re-created), `leave_records` (`leave.view_team`), `attendance_raw_transactions`, `attendance_events`, `attendance_daily_records`, `attendance_corrections` (`attendance.view_team`). Self-service (20260927000100) and platform-context (20260905002000) policies keep their names and stay in force.
- **`app.principal_snapshot`** now returns `teamEmployeeIds` per membership (same rule as the helper), so `/me` and every service know the team without another round trip. Still `flowza_api`-only.
- Post-verify block (roles, permission set sizes, one team predicate per table, both columns, snapshot body) fails the migration instead of leaving half a state.

### Contracts / domain / API
- `PERMISSIONS` (+13), `SYSTEM_ROLE_KEYS`/`SYSTEM_ROLE_IDS` (+`manager`, `auditor`), `TEAM_PERMISSIONS`.
- `MembershipGrant.teamEmployeeIds`; `MeDto.memberships[].isManager` / `teamSize` (zod defaults so a cached pre-upgrade `/me` still parses).
- `requireTeamOrPermission(principal, orgId, employeeId, ...permissions)` + `isTeamMember` in `apps/api/src/lib/authorize.ts`: org-wide key ⇒ allowed; else the employee must be a direct report; else `FORBIDDEN`. First consumer: `createCorrection` (a manager files corrections for their reports only; HR/branch managers hold `attendance.view` and are unchanged).
- Employees: `managerEmployeeId` / `secondaryManagerEmployeeId` nullable on create/PATCH (clearing now works), DTO carries `secondaryManagerEmployeeId` / `secondaryManagerName`; the manager pair is validated *after* the patch (self, unknown, primary = secondary); list filters `teamOf=<employeeId>` (primary or secondary) and `unlinked=true` (no membership of any status, no live invitation — computed in the organisation's system scope so it is exact for whoever assigns logins).
- Members: `inviteMember` stores `employeeId` on the invitation and refuses an employee already linked to a membership or reserved by a pending invitation (409); `acceptInvitation` copies the link onto the membership (or, if the employee was taken meanwhile, creates the membership unlinked and records `employeeLinkSkipped` in the audit row rather than stealing the link or failing onboarding); `updateMember` refuses a double link; `listInvitations` returns `employeeId` + `employeeNumber`.
- Self-service profile exposes `secondaryManager`.

### Web
- Roles page lists the two new roles (data-driven); permission matrix gets the `Approvals` / `Integrations` groups (en + ar).
- Employee form: Manager and **Secondary manager** pickers (each excludes the employee and the other picker's choice); profile header shows **Reports to** (+ "also" for the secondary), both linked. Secondary manager is a plain change (not effective-dated).
- Sidebar: **My team → Team overview** (`/team`) for anyone with direct reports, whatever their role. `/team` lists the reports (name, designation, department, branch, "reports to you as" manager / secondary manager) when the caller holds `employee.view`, otherwise the team size only; Prompt 5 fills the queue.
- Invite / member dialogs offer only unlinked employees; portal profile shows the secondary manager.

### Seeds
- Local Al Bahja seed: every employee now reports to their department's manager (about a third also to a deputy as secondary manager; current `employment_history` rows carry the manager); logins `manager@albahja.example` (role `manager`, = the IT department's manager Nasser Al Maskari) and `auditor@albahja.example` (role `auditor`).
- Hosted Majan Gulf seed (`supabase/seeds/demo-tenant/02_people.sql`, README): `manager@flowza.ai` = MG-1010 Arun Menon (Priya's manager), `auditor@flowza.ai` = MG-1007 Suresh Pillai, both `Test@1234`; IT-DEV engineers get the IT Manager (MG-1009) and the Sohar sales executives the Sales Manager (MG-1019) as secondary managers. Step 02 now needs migration 20260928000100.

### Permission matrix shipped

| key | owner | org_admin | hr_admin | hr_user | branch_manager | attendance_admin | payroll | employee | manager | auditor |
|---|---|---|---|---|---|---|---|---|---|---|
| attendance.view_team | ✓ | ✓ | ✓ | | ✓ | | | | ✓ | |
| attendance.checkin | ✓ | ✓ | ✓ | | | | | ✓ | ✓ | |
| attendance.note | ✓ | ✓ | ✓ | | | | | ✓ | ✓ | |
| attendance.review_notes | ✓ | ✓ | ✓ | ✓ | | | | | | |
| attendance.manage_geofences | ✓ | ✓ | ✓ | | | | | | | |
| attendance.manage_overtime | ✓ | ✓ | ✓ | | | | | | | |
| leave.approve | ✓ | ✓ | ✓ | ✓ | ✓ | | | | ✓ | |
| leave.view_team | ✓ | ✓ | ✓ | | | | | | ✓ | |
| shift.request_swap | ✓ | ✓ | | | ✓ | | | ✓ | ✓ | |
| approval.manage | ✓ | ✓ | ✓ | | | | | | | |
| approval.delegate | ✓ | ✓ | ✓ | | | | | | ✓ | |
| report.schedule | ✓ | ✓ | | | | | ✓ | | | |
| integration.manage | ✓ | ✓ | | | | | | | | |
| employee.view_team *(review fix D)* | ✓ | ✓ | ✓ | ✓ | ✓ | | | | ✓ | |

`manager` (17): dashboard.view, employee.view *(replaced by `employee.view_team` in the review fixes, §6)*, attendance.view_team, attendance.view_own, attendance.checkin, attendance.note, attendance.approve, attendance.correct, attendance.request_correction, leave.view_team, leave.approve, leave.request, shift.view, shift.request_swap, holiday.view, report.view, approval.delegate.
`auditor` (14): dashboard.view, organization.view, branch.view, department.view, employee.view, attendance.view, attendance.view_raw, leave.view, shift.view, holiday.view, report.view, report.export, audit.view, payroll.view.

## 2. Decisions (priority order Security > Reliability > Data Integrity > … > UX)

1. **The team predicate is key-gated, not relationship-only.** A row is readable through the team branch only when the caller holds a team key for the organisation *and* the row's employee is a direct report. A manager relationship alone opens nothing (RLS case "a manager relationship without attendance.view_team reveals no attendance" proves it); assigning the system role `manager` is what turns it on. This is the "authorization twice" rule and keeps exposure under the tenant's control through roles (pack decision 6). The pack's decision 1 ("the relationship grants team visibility") is honoured in that the *scope* is the relationship; the *grant* stays a permission.
2. **`employees` team key = either team key.** The prompt lists `employee.view` as the team key for employees, but `employee.view` is also that table's organisation-wide key, so it cannot distinguish "team" from "everyone". Whoever may see a report's attendance or leave may see who that report is (`attendance.view_team` / `leave.view_team`). Consequence, recorded deliberately: the `manager` role holds `employee.view` as the matrix requires, so a line manager can read the **employee directory organisation-wide** (identity documents stay behind `employee.view_sensitive`; DOB/phone are masked without it). The matrix was followed to the letter rather than inventing an `employee.view_team` key that the prompt does not define. *Superseded by review fix D (§6): the key now exists and replaces `employee.view` on the `manager` role.*
3. **Direct reports only, both for RLS and for `/me`.** `team_employee_ids()` never walks the chain; `team_employee_ids_deep()` exists for the approval engine and is not used by any policy. Deleted (archived) employees drop out of both, so a manager loses access to an archived report's rows while HR keeps it.
4. **Team predicate carries no branch scope.** A report in another branch is still the manager's report (`branch_manager` "keeps branch scope and additionally gets team semantics").
5. **Writes are not team-scoped at the RLS level.** The generated write policies still key on the manage/correct/update permission, exactly as for every other role; the team rule for writes lives in the service (`requireTeamOrPermission`) — wired into `createCorrection` now, the remaining surfaces arrive with the team workspace (Prompt 5) and the approval engine (Prompt 2). A custom role holding `attendance.correct` without `attendance.view` and without a team therefore loses the ability to file corrections for arbitrary employees — an odd role shape, accepted.
6. **Literal matrix.** `attendance_admin` received no new keys and `hr_admin` no `shift.request_swap` because the prompt's matrix does not list them; tenants extend custom roles. Flagged as a follow-up (§5).
7. **One login per employee record is enforced in the service, not (yet) by a unique index.** A partial unique index on `org_memberships(organization_id, employee_id)` would be additive but would fail the migration on any tenant that already double-linked an employee, which cannot be verified from here; the service refuses new double links (invite, accept, member update) and the follow-up is recorded.
8. **`acceptInvitation` degrades instead of failing** when the reserved employee was linked to somebody else in the meantime: the membership is created unlinked and the audit row says why. Onboarding never blocks on a data race HR can fix afterwards.
9. **`isManager` / `teamSize` use zod defaults** so a `/me` document cached in the browser before this release still parses; the server always sends them.
10. **`/team` has no permission gate.** It opens for anyone with direct reports; what it can show is decided by the caller's permissions (`employee.view` for the list) and by RLS. Prompt 5 replaces its body.
11. **Sort orders** only order keys inside a category (the matrix groups by category first), so the new keys reuse numbers already taken by other categories instead of renumbering the vocabulary.

## 3. Files

- Migration: `supabase/migrations/20260928000100_roles_manager_and_permissions.sql`
- Contracts: `packages/contracts/src/{permissions,organizations,employees}.ts`, `dto/{members,self-service}.ts`; domain: `packages/domain/src/authorization/types.ts`; generated types: `packages/database/src/generated/db.ts`
- API: `apps/api/src/lib/{principal,authorize}.ts`, `services/{me,employees,members,self-service}.service.ts`, `services/{employees,members}.mappers.ts`, `services/features/attendance.service.ts`
- Web: `apps/web/src/features/team/*` (new), `components/layout/sidebar.tsx`, `features/employees/{api.ts,employee-diff.ts,components/employee-form-fields.tsx,pages/employee-profile-page.tsx,test-mocks.ts}`, `features/users/components/{invite-dialog,member-dialog}.tsx`, `features/portal/pages/profile-page.tsx`, `features/routes.tsx`, locales `en|ar/{common,users,employees,portal,team}.json`, `e2e/support/mock-backend.ts`
- Seeds: `packages/database/src/seed/{data,index}.ts`, `supabase/seeds/demo-tenant/{02_people.sql,README.md}`
- Tests: `supabase/tests/{rls_isolation,rls_system_context}.sql`, `apps/api/src/lib/authorize.test.ts`, `apps/api/src/test/{team,core}.test.ts`, `apps/web/src/features/users/components/permission-matrix.test.tsx`, `apps/web/src/components/layout/sidebar.test.tsx`, `apps/web/src/features/employees/employee-diff.test.ts`
- Docs: `docs/blueprint.md` §H.2, this report.

## 4. Verification (all run locally on Postgres 16 @ 127.0.0.1:54329)

| Gate | Result |
|---|---|
| `pnpm build:packages` | pass |
| `pnpm lint` (`--max-warnings 0`) | pass |
| `pnpm -r --filter "./apps/*" run typecheck` | pass (api, web, worker) |
| `pnpm test:unit` | pass — shared 4, domain 194, device-providers 140, database 20 tests |
| `pnpm --filter @flowza/web run test` | pass — 48 files, 179 tests (incl. new permission-matrix groups, sidebar "My team", employee-diff secondary manager) |
| `bash supabase/tests/run-rls-tests.sh` | pass — `rls_isolation.sql` extended with Line Manager A (direct report visible, non-report and report-of-report invisible, deep chain = 2, no writes), Secondary Manager A (same through the secondary link), Auditor A (reads everything its role allows, 10 write attempts refused/0 rows), employee-with-a-report-but-no-team-key (nothing revealed); `rls_system_context.sql` updated counts |
| `pnpm test:db` | pass — 2 files, 11 tests |
| `pnpm --filter @flowza/api run test` | pass — 17 files, 171 tests (new `team.test.ts` 8 tests: `/me` isManager/teamSize, new roles, RLS agreement, correction for report vs non-report, `teamOf`/`unlinked`, invitation → linked membership, auditor read-only, manager-pair validation; `authorize.test.ts` 5 tests; `core.test.ts` now expects 10 system roles and a non-reserved custom key) |
| `pnpm --filter @flowza/worker run test` | pass — 10 files, 104 tests (1 skipped, pre-existing) |
| `pnpm -r --filter "./apps/*" run build` | pass |
| `PGDATABASE=flowza_ci2 bash scripts/db-reset-local.sh` (second apply on a fresh DB) | pass |
| `pnpm db:types` + `git diff --exit-code -- packages/database/src/generated/db.ts` | in sync (two new columns) |
| `bash scripts/db-reset-local.sh --seed` (Al Bahja, 500 employees, 30 days) | pass — 10 logins, team structure seeded |

## 5. Known limits / follow-ups

- ~~**Line-manager directory scope** (decision 2): `manager` sees the whole employee directory because the matrix grants `employee.view`.~~ Resolved by review fix D (§6).
- **Team reads reach the API only where a service asks for them.** The HR attendance/leave list endpoints still answer a `manager`-role caller with their own rows (`attendance.view_own`) — the team queue and the `/team/*` endpoints are Prompt 5; the team predicate in RLS is ready for them. `leave.approve` and the other new keys are seeded and grantable but enforced by no endpoint yet (Prompts 2, 3, 4, 6, 7, 9).
- **Approval routing** (`resolveStep` MANAGER) still reads the primary manager only; secondary-as-fallback and `team_employee_ids_deep()` consumers are Prompt 2.
- **No unique index on `org_memberships(organization_id, employee_id)`** (decision 7) — add once the hosted data is verified duplicate-free.
- **Matrix gaps left as specified**: `attendance_admin` has no `attendance.manage_geofences` / `manage_overtime`; `hr_admin` has no `shift.request_swap`; `payroll` / `attendance_admin` cannot `attendance.checkin`. Tenants can clone roles; revisit when Prompts 3/4/6 ship the surfaces.
- The hosted migration + seed re-run happen in Prompt 12 (nothing was applied to `liyilmbklsextsggflbb`).
- No new dependencies.

## 6. Review fixes (2026-09-27)

The dedicated test agent's review of `a09fd74`…`0749045` raised ten findings. Four are fixed here (A–D) with migration `supabase/migrations/20260928000150_p1_review_fixes.sql` (additive, idempotent, no backfill); the rest belong to the prompt that owns the surface, or are recorded.

### 6.1 Findings

| # | Finding (review) | Resolution | Tests |
|---|---|---|---|
| 1 | P1 — a `manager` cannot request a correction for their **own** record (403) | **Prompt 2** (owns `attendance.service.ts`: own-record path through the self-service branch, not auto-approved) | — |
| 2 | P1 — **B-75** not implemented: termination/offboarding leaves the linked login active | **Fixed (A)** — see §6.2 | `apps/api/src/test/roles-review.test.ts` §A (7 tests); RLS suite "offboarding" + "session revocation" blocks |
| 3 | P2 — a line manager's correction for a report is auto-approved | **Prompt 2** (approval engine routes manager corrections; auto-approve shortcut) | — |
| 4 | P2 — no cycle guard on the reporting line | **Fixed (B)** — named 400 in the API + trigger `employees_no_manager_cycle` | `roles-review.test.ts` §B (2 tests); RLS suite "reporting-line cycle guard" (9 asserts) |
| 5 | P2 — `GET /employees?unlinked=true` reveals who has a login to any `employee.view` holder | **Fixed (C)** — needs `user.view` (403 otherwise); leavers are no candidates | `roles-review.test.ts` §C (manager 403, auditor 403, org_admin 200) |
| 6 | P2 — write side of the team tables not team-scoped; correction `status` unconstrained for `authenticated` inserts | **Prompt 2** (correction RLS belongs with the engine) | — |
| 7 | P2 — the `manager` role reads the whole employee directory | **Fixed (D)** — key `employee.view_team`, `manager` loses `employee.view` | `roles-review.test.ts` §D (2 tests); RLS suite (manager / secondary manager directory = own row + report); `permission-matrix.test.tsx`, `team-page.test.tsx`, `employee-profile-page.test.tsx`, `sidebar.test.tsx` |
| 8 | P2 — `/team` flashes "no direct reports" while `/me` loads; "My team" shown to relationship-only managers | Flash: **Prompt 5** (rebuilds `/team`). Menu entry: **fixed** — "My team" now needs `employee.view_team` or `employee.view` (a relationship alone opens nothing) | `sidebar.test.tsx` |
| 9 | P3 — migration hygiene: (a) 000100 claims its post-verify rolls back, but `psql -f` is autocommit locally; (b) partial invitations index; (c) no `CONCURRENTLY` | (a) the new migration states it plainly (idempotent, re-apply after a fix); 000100 is not rewritten. (b)(c) recorded, unchanged (consistent with every migration in the repo) | — |
| 10 | P3 — `createRole` refuses keys `manager`/`auditor` while an older custom role may already carry one | Recorded, unchanged (cosmetic) | — |

### 6.2 What shipped

**A. Leaving ends access (B-75).** `apps/api/src/services/offboarding.ts` → `offboardLinkedLogins()` runs inside the employee change's transaction when an employee becomes `terminated`/`resigned` (PATCH `updateEmployee`, bulk `set_status`) and whenever a record is archived (`deleteEmployee`):
- every `org_memberships` row with that `employee_id` (active or invited) → `status = 'suspended'`, the `employee_id` is **kept** (HR can see whose login it was);
- pending invitations carrying the `employee_id` are revoked (deleted), so nobody accepts their way back in;
- the user's sessions end (below); every step is audited as the acting HR user: `member.suspended` (`cause: 'employee_left'`, `source: update|bulk_set_status|delete`, `employmentStatus`, `sessionsRevoked`) and `member.invitation_revoked`;
- the rules of member suspension apply, because this *is* suspending members: an owner's login can only be ended by an owner (403), nobody ends their own (409), the organisation keeps an active owner (409). A refusal rolls the whole employee change back — a termination is never recorded while it would leave a login behind;
- memberships and invitations are read and written in the organisation's **system scope** (HR typically lacks `user.view`/`user.manage`, under which RLS hides them); the actor was authorised for the employee change.
- **Re-activating the employee does NOT re-activate the login** (explicit HR/admin step): `updateMember` refuses to re-activate a login while its employee still counts as left (409), `inviteMember`/`updateMember` refuse to link a login to a leaver (400, `employeeId: 'Employee has left'`), and accepting an invitation whose employee has since left is refused (409).
- DB: `app.team_employee_ids()`, `app.team_employee_ids_deep()` and `app.principal_snapshot` (`teamEmployeeIds`) ignore a caller whose own employee record is archived or terminated/resigned, and drop such records from every team — a manager whose login was missed still has no team. Re-created with the exact grants/owner of 000100 (verified against a database migrated only to 000100: identical ACL, owner, `SECURITY DEFINER`, `search_path`). `app.own_employee_ids()` is unchanged.
- **Session revocation.** `ApiDeps.sessions?: SessionRevoker` (injectable; tests pass a spy) with the default `databaseSessionRevoker` (`apps/api/src/lib/sessions.ts`, wired in `index.ts`), called by the offboarding, by `suspendMember` and by `updateMember` (status leaves `active`, or a **role downgrade** = the new role lacks a key of the old one) — AGENTS.md: "suspension / role downgrade → revoke sessions". It calls `app.revoke_user_sessions(uuid[])` in the same transaction (system scope of the organisation; only `flowza_system` may execute it; it only touches users holding a membership of that organisation) which deletes the users' `auth.sessions` rows — the statement Supabase Auth's own global sign-out runs (refresh tokens go with their session). Returns `-1` when `auth.sessions` is unreachable (local shim, missing privilege) → the API logs `session_revocation_unavailable`; the suspension itself already closed the organisation because every request and every RLS predicate re-read the memberships.

**B. Reporting-line cycle guard.** `employees.service.ts` `assertNoReportingCycle()` walks up from each **changed** manager link (primary and secondary links of every ancestor, depth ≤ 20, system scope so a branch-scoped caller's view cannot hide part of the chain) and answers `400 VALIDATION_ERROR` with `issues: [{ path: 'managerEmployeeId' | 'secondaryManagerEmployeeId', message: 'Reporting cycle' }]`. The database trigger `employees_no_manager_cycle` (`app.employees_no_manager_cycle()`, BEFORE INSERT OR UPDATE OF the two columns, security definer) refuses the same with `check_violation` / constraint `employees_no_manager_cycle` (mapped to 400 by the API), serialises reporting-line changes per organisation (`pg_advisory_xact_lock`) so two concurrent edits cannot close a loop together, and does not re-walk unchanged links (a legacy loop never blocks an unrelated update). The local seed and the demo-tenant seed run with the trigger active (below).

**C. `?unlinked=true` needs `user.view`** (checked before any query); the candidate list also drops employees who left.

**D. Line-manager directory = own record + direct reports.** New key `employee.view_team` ("View the employee records of direct reports (line manager scope)", category `employees`, contracts `PERMISSIONS` + `TEAM_PERMISSIONS`, e2e mock backend). Granted to `manager`, `branch_manager`, `hr_user` — and to `owner`/`org_admin` (they hold every key; the role editor and the DB trigger only let an actor grant keys they hold) and `hr_admin` (it holds every other team key and must stay a superset of `hr_user`, or moving someone from hr_user to hr_admin would read as a role downgrade; it already reads every employee, so nothing new opens). **`manager` loses `employee.view`** (17 keys). The `employees` team predicate accepts `employee.view_team | attendance.view_team | leave.view_team`. API: `requireAnyPermission()` (`lib/authorize.ts`); list/detail/history/devices accept `employee.view` OR `employee.view_team` and RLS decides the rows (a non-report → 404); a team-only caller gets no branch filter, and a branch-scoped `employee.view` holder's list now also shows their own record and direct reports outside their branches — exactly the rows RLS already returned them. Web: `/employees/:id` opens with either key (`RequirePermission any`); "My team" (sidebar) and the team list use `employee.view_team` OR `employee.view`; on a report's profile a team-only viewer sees **Overview only** — History/Devices/Attendance sit behind other keys and would render empty, or for Attendance the viewer's *own* month (`attendance.service` scopes an `attendance.view_own` caller to their own record whatever `employeeId` is asked); on their own profile the tabs RLS fills from self rows show; a hidden tab named in the URL falls back to Overview; the breadcrumb leads to `/team`. The directory list (`/employees`) stays an HR surface (`employee.view`).

### 6.3 Decisions (priority order Security > Reliability > Data Integrity > … > UX)

- **R1 — Session revocation through the database, not the Auth admin HTTP API.** Supabase Auth has no admin endpoint that signs a user out by id (`auth.admin.signOut` needs that user's own access token; banning is global and would also lock the person out of their other organisations). There was no existing helper to reuse (member suspension did not revoke sessions at all — fixed here). Running inside the suspending transaction means a rolled-back change never ends anybody's session and a committed one always does.
- **R2 — Refuse, never skip.** An owner's login, the actor's own login and the last active owner make the termination fail as a whole rather than leave a silently active login behind.
- **R3 — A report who left leaves the team.** The manager loses the report's records at that moment; HR keeps organisation-wide access to them.
- **R4 — The cycle walk follows secondary links too** (the team rule is primary OR secondary), bounded at 20 levels; deeper loops are not detected (no real organisation chart is 20 levels deep).
- **R5 — No backfill.** Logins still linked to employees who already left are not suspended by the migration (it could lock out an owner). They are listed by the query below and handled by an administrator; the team helpers already ignore such callers. Local seed and demo seed: 0 rows.
  ```sql
  select m.organization_id, m.id as membership_id, m.user_id, m.status, e.employee_number, e.employment_status, e.deleted_at
  from public.org_memberships m join public.employees e on e.id = m.employee_id and e.organization_id = m.organization_id
  where m.status <> 'suspended' and (e.deleted_at is not null or e.employment_status in ('terminated', 'resigned'));
  ```

### 6.4 Verification (local Postgres 16 @ 127.0.0.1:54329; databases `flowza_fix1*` only)

| Gate | Result |
|---|---|
| `pnpm build:packages`, `pnpm lint`, `pnpm -r --filter "./apps/*" run typecheck` | pass |
| `pnpm test:unit` | pass — shared 4, domain 194, device-providers 140, database 20 |
| `pnpm --filter @flowza/web run test` | pass — 50 files, 185 tests (was 48 / 179) |
| `PGDATABASE=flowza_fix1_rls … run-rls-tests.sh` | pass — 125 assertions (was 93) |
| `pnpm test:db` | pass — 2 files, 11 tests |
| `pnpm --filter @flowza/api run test` | pass — 18 files, 185 tests (was 17 / 171) |
| `pnpm --filter @flowza/worker run test` | pass — 10 files, 104 passed, 1 skipped (pre-existing) |
| `pnpm -r --filter "./apps/*" run build` | pass |
| `PGDATABASE=flowza_fix1_ci2 bash scripts/db-reset-local.sh` (fresh apply) | pass |
| `PGDATABASE=flowza_fix1 bash scripts/db-reset-local.sh --seed` | pass — 500 employees seeded with the cycle trigger active; 0 reporting loops; `manager@albahja.example` reads 22 employees (own + 21 direct reports) instead of 500 |
| `pnpm db:types` against `flowza_fix1` | in sync (no schema column changed) |
| Re-apply `20260928000150` on the seeded database | identical policies, system-role grants, function ACLs/owners and triggers before/after |
| Demo seed `01_structure.sql` + `02_people.sql` ×2 (scratch database with the auth shim widened to the hosted shape and `uuid-ossp`) | pass, identical counts both runs (53 employees, 10 members); 0 loops; secondaries exactly as documented; `manager@flowza.ai` reads MG-1010 + MG-1011/1012/1013 only |
| Mutation checks | disabling the termination hook → 4 API tests fail; dropping the `unlinked` gate → 1 fails; dropping the API cycle check → 1 fails |

### 6.5 Known limits / follow-ups

- **Hosted session revocation** needs `postgres` to hold DELETE on `auth.sessions` (it does on Supabase today). Prompt 12: after applying, suspend a test member and confirm the log line `sessions_revoked` (not `session_revocation_unavailable`).
- **Other write paths.** The offboarding hook lives in the API service; the worker's employee import (`EXECUTE_IMPORT`) has no handler yet — when it gets one it must call the same offboarding. Direct SQL bypasses it (the query in R5 finds the leftovers).
- A custom role edited to drop keys (`roles.service`) does not end its holders' sessions yet (their access shrinks on the next request regardless).
- Global search (`search.service`) still returns employees only for `employee.view` (a line manager gets none); team attendance on a report's profile — both **Prompt 5**.
- Later migrations that redefine `app.principal_snapshot`, `app.team_employee_ids*` or the `employees` policies (Prompt 2's `20260928000200…`) must keep the leaver filter and the `employee.view_team` team key; the RLS "offboarding" and directory assertions fail otherwise.

**Files (review fixes):** `supabase/migrations/20260928000150_p1_review_fixes.sql`; `apps/api/src/{deps.ts,index.ts,lib/authorize.ts,lib/sessions.ts,services/offboarding.ts,services/employees.service.ts,services/members.service.ts}`; `packages/contracts/src/permissions.ts`; web `components/layout/{protected-route,sidebar}.tsx`, `features/employees/{routes.tsx,pages/employee-profile-page.tsx}`, `features/team/{routes.tsx,pages/team-page.tsx}`, `locales/{en,ar}/team.json`, `e2e/support/mock-backend.ts`; tests `apps/api/src/test/{roles-review,team}.test.ts`, `apps/api/src/lib/authorize.test.ts`, `supabase/tests/rls_isolation.sql`, `apps/web/src/{components/layout/sidebar,features/users/components/permission-matrix,features/team/pages/team-page,features/employees/pages/employee-profile-page}.test.tsx`; docs `docs/blueprint.md` §H.2, this report.
