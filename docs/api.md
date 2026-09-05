# FlowZa Time — REST API reference (`/api/v1`)

Base URL `/api/v1`. Every route below requires `Authorization: Bearer <Supabase access token>` unless stated otherwise.
The caller's memberships, roles and permissions are loaded from the database on every request (never from the JWT),
so role changes and suspensions take effect immediately.

## Conventions

| Topic | Rule |
|---|---|
| Envelope | Success `{ data, meta? }`; lists `{ data: T[], meta: { page, pageSize, total, totalPages } }`; async work `202 { data: { jobId, status: 'QUEUED', message } }`. |
| Errors | `{ code, message, requestId, details? }`. Codes: `VALIDATION_ERROR` 400 (`details.issues[] = { path, message }`), `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` / `INVALID_STATE` / `IDEMPOTENCY_CONFLICT` 409, `RATE_LIMITED` 429, `INTERNAL_ERROR` 500 (never SQL or stack traces). |
| Tenant scope | Org-scoped routes live under `/orgs/:orgId/...`. The service calls `requireMembership` / `requirePermission(...)` (explicit `FORBIDDEN`), then runs all SQL inside `withContext(db, { kind: 'user' })` so Postgres RLS enforces the same rules again. `organizationId` is never accepted from a body. |
| Branch scope | Memberships with `allBranches = false` only see rows of their branches (RLS) and get `FORBIDDEN` when they name another branch explicitly (`branchId` filter, moving an employee, creating a department in another branch…). |
| Pagination | `page` (≥1, default 1), `pageSize` (1–200, default 25), `sort` (allow-listed keys per endpoint; unknown key → 400), `order` (`asc`/`desc`). |
| MFA | Platform administrators must present `aal2` on every request; organisations with `settings.security.mfaRequired = true` require `aal2` on all `/orgs/:orgId/*` routes. Otherwise `403 FORBIDDEN` with `details.reason = 'MFA_REQUIRED'` (`/me` stays reachable so the UI can start enrolment). |
| PATCH semantics | Update bodies (`updateOrganizationSchema`, `updateBranchSchema`, `updateDepartmentSchema`, `updateDesignationSchema`, `updateTeamSchema`, `updateEmployeeSchema`) carry no creation defaults: omitted fields are left untouched. Query booleans use `booleanQuerySchema` (`false`/`0`/`no` are false). |
| Sensitive fields | `dateOfBirth` and `phone` in `EmployeeDto` are `null` for callers without `employee.view_sensitive` (same masking rule as exports); identity documents have their own gated endpoints. |
| Role assignment | Inviting or re-assigning a member to a role is only allowed when the actor holds every permission of that role (owners hold all); the owner role can only be granted by an owner. |
| Idempotency | `Idempotency-Key` header (≤128 chars) on job-creating POSTs (`/employees`, `/employees/bulk`, `/employees/imports`, `/employees/imports/:id/confirm`, `/platform/orgs`). Same key + same body within 10 minutes replays the stored response with `Idempotency-Replayed: true`; same key + different body → 409 `IDEMPOTENCY_CONFLICT`. The store is an in-memory LRU per API instance — back it with Redis for multi-instance deployments. |
| Audit | Every create/update/delete and every sensitive read (identity documents, exports) writes an `audit.logs` row (`action`, `entityType`, `entityId`, redacted `oldValue`/`newValue`, `requestId`, ip, user agent). |
| Domain events | `employee.created` / `employee.updated` / `employee.deleted` / `employee.imported` are written to the `domain_events` outbox in the same transaction. |
| Jobs | Device pushes, exports and imports are queued in the same transaction as the state change through `app.enqueue_job(...)` (SECURITY DEFINER, migration 2100): callable by the `authenticated` role, it only accepts organisations the caller belongs to. The API never switches DB roles for queueing (`apps/api/src/lib/jobs.ts`). |
| Dates | `YYYY-MM-DD` for dates, RFC 3339 UTC for timestamps. "Today" for defaults is computed in the organisation's IANA timezone. |

Schema names refer to `@flowza/contracts` (`packages/contracts/src/**`).

## Me

| Method | Path | Permission | Request | Response |
|---|---|---|---|---|
| GET | `/me` | signed in | — | `MeDto` — `user` (profile; created on first request from the JWT `sub`/email), `memberships[]` with `organization`, `roleKey`/`roleName`, `permissions`, `allBranches`, `branchIds`, `employeeId`, `featureFlags` (platform defaults ⊕ organisation overrides) and `settings` (`organizationSettingsSchema` with defaults). Platform admins with an active access grant get a synthetic membership (`roleKey` `platform_grant_read|write`). |
| PATCH | `/me` | signed in | `updateMeSchema` (`fullName`, `locale`) | `UserProfileDto` |
| GET | `/me/notifications` | signed in | `notificationListQuerySchema` (`unreadOnly`, `category`, `organizationId`, pagination) | paginated `NotificationDto[]` (own rows only) |
| GET | `/me/notifications/unread-count` | signed in | — | `{ unread }` |
| POST | `/me/notifications/:id/read` | signed in | — | `NotificationDto` |
| POST | `/me/notifications/read-all` | signed in | — | `{ updated }` |

## Organisations & settings

| Method | Path | Permission | Request | Response / notes |
|---|---|---|---|---|
| GET | `/orgs/:orgId` | membership | — | `OrganizationDto` |
| PATCH | `/orgs/:orgId` | `organization.manage` | `updateOrganizationSchema` | `OrganizationDto`. Timezone validated (IANA). Audit `organization.updated` (diff). |
| GET | `/orgs/:orgId/settings` | membership | — | `OrganizationSettings` (all groups, defaults applied) |
| GET | `/orgs/:orgId/settings/:group` | membership | group ∈ `SETTINGS_GROUPS` | the group object |
| PUT | `/orgs/:orgId/settings/:group` | `organization.manage` | body validated with `organizationSettingsSchema.shape[group]` (replaces the group) | the stored group. Audit `organization.settings_updated` with old/new. Unknown group → 404. |

## Members, invitations, roles

| Method | Path | Permission | Request | Response / notes |
|---|---|---|---|---|
| GET | `/orgs/:orgId/members` | `user.view` | `memberListQuerySchema` (`status`, `roleId`, `search`, sort: `createdAt|email|fullName|role|status`) | paginated `MemberDto[]` (profile + role + branch names; branch lists batch-loaded) |
| GET | `/orgs/:orgId/members/:id` | `user.view` | — | `MemberDto` |
| PATCH | `/orgs/:orgId/members/:id` | `user.manage` | `updateMemberSchema` (`roleId`, `status`, `allBranches`, `branchIds`, `employeeId`) | `MemberDto`. Only owners may grant/change the owner role; the last active owner cannot be demoted/suspended (`INVALID_STATE`). Audit `member.updated`. |
| DELETE | `/orgs/:orgId/members/:id` | `user.manage` | — | `MemberDto` with `status: suspended` (memberships are suspended, not deleted; access is lost immediately). Audit `member.suspended`. |
| GET | `/orgs/:orgId/invitations` | `user.view` | — | pending `InvitationDto[]` |
| POST | `/orgs/:orgId/invitations` | `user.manage` | `inviteMemberSchema` | `201 InvitationDto` including the plain `token` **once** (`<orgId>.<secret>`; only `sha256(secret)` is stored). If the email already has an account, a membership is created with status `invited` (`membershipId` returned). 7-day expiry. Audit `member.invited`. |
| DELETE | `/orgs/:orgId/invitations/:id` | `user.manage` | — | 204; also removes the pending `invited` membership. Audit `member.invitation_revoked`. |
| POST | `/invitations/accept` | signed in (no org in path) | `acceptInvitationSchema` `{ token }` | `{ membershipId, organizationId }`. Runs in the organisation's system context (the caller is not a member yet); the invitation must be addressed to the caller's email; creates/activates the membership + `membership_branches`, creates the profile if missing. Audit `member.invitation_accepted`. |
| GET | `/permissions` | signed in | — | `PermissionDto[]` |
| GET | `/orgs/:orgId/roles` | membership | — | `RoleDto[]` (system + custom, with permission keys and `memberCount`) |
| POST | `/orgs/:orgId/roles` | `role.manage` | `roleInputSchema` | `201 RoleDto`. Custom roles only; the actor cannot grant permissions they do not hold (also enforced by a DB trigger). Audit `role.created`. |
| PATCH | `/orgs/:orgId/roles/:id` | `role.manage` | `updateRoleSchema` | `RoleDto`; system roles → 409. Audit `role.updated`. |
| DELETE | `/orgs/:orgId/roles/:id` | `role.manage` | — | 204; refused (409 `CONFLICT`) while assigned to members or pending invitations. Audit `role.deleted`. |

## Structure

All lists accept `structureListQuerySchema` (`status`, `search`, `branchId`, pagination, sort). Deletes are **archives** (`status: archived`) because employees, devices and history reference these rows.

| Method | Path | Permission | Request | Notes |
|---|---|---|---|---|
| GET / POST | `/orgs/:orgId/branches` | `branch.view` / `branch.manage` | `branchInputSchema` | `BranchDto` (+`employeeCount`). Timezone validated. Branch-scoped callers only see their branches. |
| GET / PATCH / DELETE | `/orgs/:orgId/branches/:id` | `branch.view` / `branch.manage` | partial `branchInputSchema` | Archive refused (409) while active employees remain. |
| GET / POST | `/orgs/:orgId/departments` | `department.view` / `department.manage` | `departmentInputSchema` | `DepartmentDto` (flat tree via `parentId`; `branchName`, `managerName`, `employeeCount`). Cycles in `parentId` → 400. |
| GET / PATCH / DELETE | `/orgs/:orgId/departments/:id` | `department.view` / `department.manage` | partial `departmentInputSchema` | Archive refused with active children or assigned employees. |
| GET / POST | `/orgs/:orgId/designations` | `department.view` / `department.manage` | `designationInputSchema` | `DesignationDto` |
| PATCH / DELETE | `/orgs/:orgId/designations/:id` | `department.manage` | partial `designationInputSchema` | Archive refused while assigned. |
| GET / POST | `/orgs/:orgId/teams` | `department.view` / `department.manage` | `teamInputSchema` (`memberIds` replaces the member set) | `TeamDto` (+`memberCount`; detail includes `members[]`). |
| GET / PATCH / DELETE | `/orgs/:orgId/teams/:id` | `department.view` / `department.manage` | `updateTeamSchema` | Archive clears members. |

Audit actions: `branch.created|updated|archived`, `department.*`, `designation.*`, `team.*`.

## Employees

| Method | Path | Permission | Request | Response / notes |
|---|---|---|---|---|
| GET | `/orgs/:orgId/employees` | `employee.view` | `employeeListQuerySchema` (`search`, `branchId`, `departmentId`, `designationId`, `employmentStatus`, `employmentType`, `managerEmployeeId`, `includeDeleted`, pagination, sort: `employeeNumber|displayName|firstName|lastName|joiningDate|exitDate|employmentStatus|employmentType|branch|department|designation|deviceUserId|createdAt|updatedAt`) | paginated `EmployeeDto[]` with branch/department/designation/manager names and `deviceSyncSummary` aggregated from `device_employee_states` (one grouped query per page). Search = tsvector prefix query on number/name/email/device id + trigram `ILIKE` fallback. |
| POST | `/orgs/:orgId/employees` | `employee.create` (+ branch access) | `createEmployeeSchema`; supports `Idempotency-Key` | `201 EmployeeDto`. `deviceUserId` auto-assigned (next numeric per org, advisory-locked) when omitted; `pin` stored as scrypt hash only; `employment_history` row from `joiningDate`; audit `employee.created`; outbox `employee.created`; queue job `PUSH_EMPLOYEES` (`sync` queue, payload `{ scope: { employeeIds }, trigger: 'SYSTEM' }`) unless `settings.sync.autoPushNewEmployees === false`. |
| GET | `/orgs/:orgId/employees/:id` | `employee.view` | — | `EmployeeDto & { currentHistory }` |
| PATCH | `/orgs/:orgId/employees/:id` | `employee.update` (+ branch access to old and new branch) | `updateEmployeeSchema` (`effectiveFrom`, `changeReason`) | `EmployeeDto`. When branch/department/designation/manager/type/status change, the current `employment_history` row is closed (`effective_to = effectiveFrom`) and a new one opened in the same transaction; `effectiveFrom` defaults to today (org timezone), must be ≥ joining date and ≥ the current row's start (same day = replace in place). Audit `employee.updated` (diff), outbox `employee.updated`, re-push when device-relevant fields change. |
| DELETE | `/orgs/:orgId/employees/:id` | `employee.delete` + `employee.update` | optional `deleteEmployeeSchema` (`exitDate`, `reason`) | Soft delete: `deleted_at`, `employment_status = terminated`, `exit_date` (default today), terminated history row, device states marked undesired. Audit `employee.deleted`, outbox `employee.deleted`. |
| GET | `/orgs/:orgId/employees/:id/history` | `employee.view` | — | `EmploymentHistoryDto[]` (newest first, with names) |
| GET | `/orgs/:orgId/employees/:id/devices` | `employee.view` (+ `device.view` via RLS) | — | `EmployeeDeviceStateDto[]` |
| POST | `/orgs/:orgId/employees/bulk` | per action | `bulkEmployeeActionSchema`; supports `Idempotency-Key` | `assign_branch` / `assign_department` / `set_status` (`employee.update`): synchronous, one transaction, history rows per employee → `200 { updated, employeeIds }`. `assign_shift` (`shift.assign`): closes open employee assignments and inserts new `shift_assignments`. `sync_devices` (`device.sync`) → `202 { jobId }` (`PUSH_EMPLOYEES`, trigger `MANUAL`). `export` (`employee.export`) → `202 { jobId }` (`EXPORT_EMPLOYEES` on the `reports` queue); audit `employee.exported`. |
| GET | `/orgs/:orgId/employees/:id/documents` | `employee.view_sensitive` | — | `IdentityDocumentDto[]`; every read is audited as `employee.sensitive_viewed`. |
| POST | `/orgs/:orgId/employees/:id/documents` | `employee.update` + `employee.view_sensitive` | `identityDocumentInputSchema` | `201 IdentityDocumentDto`. Audit `employee.document_added` (only the last 4 digits of the number). |
| DELETE | `/orgs/:orgId/employees/:id/documents/:documentId` | `employee.update` + `employee.view_sensitive` | — | 204. Audit `employee.document_deleted`. |

## Employee imports

| Method | Path | Permission | Request | Response / notes |
|---|---|---|---|---|
| GET | `/orgs/:orgId/employees/imports/template` | membership | — | `text/csv` header row = `EMPLOYEE_IMPORT_COLUMNS` |
| POST | `/orgs/:orgId/employees/imports` | `employee.import` | `multipart/form-data` (`file`, optional `options` JSON) **or** JSON `importUploadSchema` `{ fileName, contentBase64, options }`; supports `Idempotency-Key` | `201 ImportJobDto` with `preview` (first 50 rows). CSV only (RFC 4180, `,`/`;`/tab auto-detected, BOM tolerated, ≤ 5000 rows, ≤ 20 MB); XLSX → 400 (worker-side XLSX parsing is planned). Each row is validated with `employeeImportRowSchema`, codes are resolved to ids (branch/department/designation), managers by employee number (in DB or earlier in the file), duplicates detected within the file and against the database (number, device user id, email); branch-scoped callers cannot import into other branches. Rows are stored in `import_job_rows` (`valid`/`invalid` + `errors[]`); job status `VALIDATED`. Audit `employee.import_uploaded`. |
| GET | `/orgs/:orgId/employees/imports` | `employee.import` | `importJobListQuerySchema` | paginated `ImportJobDto[]` |
| GET | `/orgs/:orgId/employees/imports/:id` | `employee.import` | `importJobRowsQuerySchema` (`status`, pagination for rows) | `{ data: ImportJobDto & { rows: ImportJobRowDto[] }, meta }` |
| POST | `/orgs/:orgId/employees/imports/:id/confirm` | `employee.import` + `employee.create` | supports `Idempotency-Key` | `202 { jobId }` — `EXECUTE_IMPORT` on the `processing` queue (dedupe key `import:<id>`), job status `IMPORTING`, audit `employee.import_confirmed`, outbox `employee.imported` (`phase: queued`; the worker emits the final one). Only `VALIDATED` jobs with ≥1 valid row. |
| POST | `/orgs/:orgId/employees/imports/:id/cancel` | `employee.import` | — | `ImportJobDto` (`CANCELLED`). `IMPORTING` jobs can be cancelled only while the queue job is still pending. Audit `employee.import_cancelled`. |

## Search, audit, dashboard

| Method | Path | Permission | Request | Response / notes |
|---|---|---|---|---|
| GET | `/orgs/:orgId/search` | membership (per-type permission: `employee.view`, `device.view`, `branch.view`, `department.view`) | `searchQuerySchema` (`q`, optional `types=employee,device,…`) | `SearchResult` — max 8 items per type; employees by number/name/email/device id, devices by code/name/serial, branches, departments; branch-scoped. |
| GET | `/orgs/:orgId/audit` | `audit.view` | `auditLogQuerySchema` (`entityType`, `entityId`, `actorUserId`, `action` (exact, or prefix like `employee.`), `from`, `to`, `branchId`, pagination, sort `createdAt|action|entityType`, default newest first) | paginated `AuditLogDto[]` with `actorName`. |
| GET | `/orgs/:orgId/dashboard/summary` | `dashboard.view` | `dashboardSummaryQuerySchema` (`date` default today, `branchId`) | `DashboardSummary`: counts from `attendance_daily_records` for the date (present incl. half days, absent, late/early-departure flags, leave, missing punch, overtime minutes), active employees, devices by connection status, `syncFailures24h` from `sync_job_items`, `pendingApprovals` from `approval_requests`. |
| GET | `/orgs/:orgId/dashboard/trends` | `dashboard.view` | `dashboardTrendsQuerySchema` (`from`, `to` ≤ 92 days, `branchId`) | `DashboardTrendPoint[]` one per day (zero-filled). |
| GET | `/orgs/:orgId/dashboard/branches` | `dashboard.view` | `dashboardBranchesQuerySchema` (`date`) | `DashboardBranchRow[]` per visible branch. |

## Platform (platform administrators only)

All routes call `requirePlatformAdmin`. Reads run in the admin's own RLS context (platform read policies); writes run in the system context of the target organisation (or the nil organisation for platform-wide reference data) because a platform admin holds no tenant permissions without an access grant. Actions are audited with `actorType: PLATFORM_ADMIN` on the target organisation (visible to the tenant) or with `organizationId: null`.

| Method | Path | Request | Response / notes |
|---|---|---|---|
| GET | `/platform/orgs` | `platformOrgListQuerySchema` (`status`, `search`, sort `createdAt|displayName|companyCode|status`) | paginated `PlatformOrganizationDto[]` (with subscription/plan) |
| POST | `/platform/orgs` | `createOrganizationSchema`; supports `Idempotency-Key` | `201 CreateOrganizationResult`: organisation + `organization_settings` + subscription on `planKey`; if a profile with `ownerEmail` exists an active owner membership is created (`ownerMembershipId`), otherwise an owner `invitation` (14 days) is returned with its plain token. Audit `organization.created`. |
| GET | `/platform/orgs/:id` | — | `PlatformOrganizationDto` with `counts` (employees, devices, branches, users) |
| PATCH | `/platform/orgs/:id/status` | `updateOrganizationStatusSchema` (`status`, `reason`) | `PlatformOrganizationDto`. Audit `organization.status_changed` with reason. |
| GET / PUT | `/platform/orgs/:id/feature-flags` | `putOrgFeatureFlagsSchema` `{ flags: { key: bool|null } }` (`null` removes the override) | `OrgFeatureFlagDto[]` (`defaultEnabled`, `override`, `effective`). Audit `platform.org_feature_flags_updated`. |
| GET | `/platform/access-grants` | `accessGrantListQuerySchema` (`organizationId`, `activeOnly`) | paginated `AccessGrantDto[]` |
| POST | `/platform/access-grants` | `createAccessGrantSchema` (`organizationId`, `accessLevel`, `reason` ≥ 10 chars, `ticketRef`, `hours` 1–72 (default 8), `approvedBy` required for `write`) | `201 AccessGrantDto`. The grant appears in the caller's next request as a synthetic membership (read grants: `*.view`/`*.export` permissions). Audit `platform.access_granted` on the tenant with the reason. |
| DELETE | `/platform/access-grants/:id` | — | `AccessGrantDto` (revoked). Audit `platform.access_revoked`. |
| GET | `/platform/plans` | — | `PlanDto[]` |
| GET / PUT | `/platform/feature-flags` | `putFeatureFlagsSchema` `{ flags: [{ key, description?, defaultEnabled?, rolloutPercentage? }] }` (upsert) | `FeatureFlagDto[]`. Audit `platform.feature_flag_updated` (organisation null). |
| GET | `/platform/health` | — | `PlatformHealthDto`: queue stats per queue/status, organisations by status, active platform admins, active grants. |

## Not yet implemented in this module set

Devices, device groups, sync, attendance, corrections, approvals, shifts, holidays, leave, rule sets, reports, payroll, subscription/usage and the inbound webhook/device-push routes are documented by their own modules (appended below by the respective owners).
