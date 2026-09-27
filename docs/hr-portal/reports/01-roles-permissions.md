# Phase 1 — Roles & permissions per global standard; manager semantics

**Prompt:** `docs/hr-portal/prompt-pack.md` §Prompt 1 (+ the coordinator addendum: helpers on the membership link only; fix the dropped employee link on invitations).
**Branch:** `claude/modest-fermi-fnwqq7` · **Migration:** `supabase/migrations/20260928000100_roles_manager_and_permissions.sql` · **Date:** 2026-09-27.
**Status:** every gate green (see §4); nothing applied to the hosted project (Prompt 12).

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

`manager` (17): dashboard.view, employee.view, attendance.view_team, attendance.view_own, attendance.checkin, attendance.note, attendance.approve, attendance.correct, attendance.request_correction, leave.view_team, leave.approve, leave.request, shift.view, shift.request_swap, holiday.view, report.view, approval.delegate.
`auditor` (14): dashboard.view, organization.view, branch.view, department.view, employee.view, attendance.view, attendance.view_raw, leave.view, shift.view, holiday.view, report.view, report.export, audit.view, payroll.view.

## 2. Decisions (priority order Security > Reliability > Data Integrity > … > UX)

1. **The team predicate is key-gated, not relationship-only.** A row is readable through the team branch only when the caller holds a team key for the organisation *and* the row's employee is a direct report. A manager relationship alone opens nothing (RLS case "a manager relationship without attendance.view_team reveals no attendance" proves it); assigning the system role `manager` is what turns it on. This is the "authorization twice" rule and keeps exposure under the tenant's control through roles (pack decision 6). The pack's decision 1 ("the relationship grants team visibility") is honoured in that the *scope* is the relationship; the *grant* stays a permission.
2. **`employees` team key = either team key.** The prompt lists `employee.view` as the team key for employees, but `employee.view` is also that table's organisation-wide key, so it cannot distinguish "team" from "everyone". Whoever may see a report's attendance or leave may see who that report is (`attendance.view_team` / `leave.view_team`). Consequence, recorded deliberately: the `manager` role holds `employee.view` as the matrix requires, so a line manager can read the **employee directory organisation-wide** (identity documents stay behind `employee.view_sensitive`; DOB/phone are masked without it). The matrix was followed to the letter rather than inventing an `employee.view_team` key that the prompt does not define.
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

- **Line-manager directory scope** (decision 2): `manager` sees the whole employee directory because the matrix grants `employee.view`. If team-only directory reads are wanted, the vocabulary needs an `employee.view_team` key (not in this prompt).
- **Team reads reach the API only where a service asks for them.** The HR attendance/leave list endpoints still answer a `manager`-role caller with their own rows (`attendance.view_own`) — the team queue and the `/team/*` endpoints are Prompt 5; the team predicate in RLS is ready for them. `leave.approve` and the other new keys are seeded and grantable but enforced by no endpoint yet (Prompts 2, 3, 4, 6, 7, 9).
- **Approval routing** (`resolveStep` MANAGER) still reads the primary manager only; secondary-as-fallback and `team_employee_ids_deep()` consumers are Prompt 2.
- **No unique index on `org_memberships(organization_id, employee_id)`** (decision 7) — add once the hosted data is verified duplicate-free.
- **Matrix gaps left as specified**: `attendance_admin` has no `attendance.manage_geofences` / `manage_overtime`; `hr_admin` has no `shift.request_swap`; `payroll` / `attendance_admin` cannot `attendance.checkin`. Tenants can clone roles; revisit when Prompts 3/4/6 ship the surfaces.
- The hosted migration + seed re-run happen in Prompt 12 (nothing was applied to `liyilmbklsextsggflbb`).
- No new dependencies.
