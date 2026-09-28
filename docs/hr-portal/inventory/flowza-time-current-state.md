# Flowza Time: current-state inventory for the HR attendance suite upgrade

Root: `/home/user/Flowza-Time`. I read AGENTS.md first. Everything below comes from the code, migrations, seeds and docs as of HEAD `1dc82a9` ("feat(portal): employee self-service portal (/my)…"). Nothing was modified. Local Postgres 16 on 127.0.0.1:54329 is accepting connections; the hosted database is Postgres 17.

---

## 1. Database

There are 25 migration files in `/home/user/Flowza-Time/supabase/migrations/`, creating 78 base tables: 75 in `public`, plus `jobs.queue`, `jobs.queue_archive` and `audit.logs`. AGENTS.md says 72, which is stale.

- **Schemas:** `public`, `app` (RLS helpers and the local migration ledger), `jobs`, `audit`, `secrets`, `extensions`.
- **Database roles:**
  - `flowza_system` (nologin) is the execution role for system-for-org work.
  - `flowza_api` (login) may `SET ROLE authenticated` or `flowza_system`.
  - `flowza_worker` (login) may `SET ROLE flowza_system`.

### 1.1 Tenancy and access — `20260905000300_tenancy_and_access.sql` (plus `membership_branches` from 0400)

**Enums**
- `org_status`: trial, active, suspended, closed
- `membership_status`: invited, active, suspended
- `platform_admin_level`: support, admin, owner
- `grant_access_level`: read, write
- `login_event`: success, failed, logout, mfa_challenge, password_reset

**`organizations`**
- Columns: id, company_code (citext, unique, `^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$`), legal_name, display_name, country_code ('OM'), timezone ('Asia/Muscat', validated by trigger), currency_code ('OMR'), locale, logo_path, contact jsonb, address jsonb, status, region_cell, created_by, timestamps.
- `weekly_off_days smallint[]`, default `{5,6}`, where 0 = Sunday … 6 = Saturday.
- Migration 1900 added legal_hold, legal_hold_reason and security_contact_email.

**`organization_settings`** has one jsonb column per settings group: general, attendance, sync, notifications, security, integrations, reports (from 20260909000100) and dashboard (from 20260909000200). The Zod shape is in `/home/user/Flowza-Time/packages/contracts/src/organizations.ts`:
- `attendance`: defaultShiftId, processingDelaySeconds, payrollPeriod (`calendar_month` | `custom_cutoff`), payrollCutoffDay, allowSelfServiceCorrections
- `security`: mfaRequired, sessionIdleMinutes, allowedEmailDomains, exportRequiresReason
- `notifications`: deviceOffline, syncFailed, approvalPending, reportReady, dailyDigest

**Users and platform staff**
- `user_profiles`: id = auth.users.id, email (citext, unique), full_name, avatar_path, locale, status (CHECK active/disabled), mfa_enrolled, last_login_at.
- `platform_admins`.
- `platform_access_grants`: reason must be at least 10 characters; the window is at most 72 hours (migration 1900); a write grant requires `approved_by`.
- `login_history` (append-only).

**`permissions`**: key (CHECK `^[a-z_]+\.[a-z_]+$`), category, description, sort_order.

**`roles`**
- `organization_id` NULL means a system role.
- key matches `^[a-z][a-z0-9_]{1,63}$`; also name, description, is_system.
- Unique on `(coalesce(org, zero-uuid), key)`.

**`role_permissions`**: primary key (role_id, permission_key). Trigger `role_permissions_no_escalation` (1900) blocks granting a permission you do not hold, and makes system roles immutable.

**`org_memberships`** (important for the upgrade)
- Columns: id, organization_id, user_id, **role_id NOT NULL — exactly one role per member per org**, status, **all_branches bool (default true)**, **employee_id → employees (ON DELETE SET NULL)**, invited_by, joined_at, timestamps.
- UNIQUE(organization_id, user_id).
- `employee_id` here is the live user↔employee link used by RLS and the API.

**`membership_branches`** (membership_id, branch_id): the branch list used when `all_branches = false`.

**`invitations`**: id, organization_id, email, role_id, all_branches, branch_ids uuid[], token_hash (unique), invited_by, expires_at, accepted_at, accepted_by. It has **no employee_id column** (see the defects list).

### 1.2 Org structure — 0400

- `branches`: code, name, name_ar, country_code, city, address, timezone, **latitude / longitude numeric(9,6), geofence_radius_m (10..5000)** (captured in the UI, never used), contact, weekly_off_days override, **holiday_calendar_id**, status.
- `record_status` enum: active, inactive, archived.
- `departments`: branch_id (nullable), **parent_id (hierarchy)**, code, name, name_ar, **manager_employee_id**, status.
- `designations`: code, name, name_ar, level.
- `teams`: branch_id, code, name, **lead_employee_id**.
- `team_members`: team_id, employee_id, organization_id.

Department managers and team leads are display-only. No authorization or approval logic uses them.

### 1.3 Employees — `20260905000600_employees.sql`

**Enums**
- `gender`: male, female, other, unspecified
- `employment_status`: active, on_leave, suspended, terminated, resigned
- `employment_type`: full_time, part_time, contract, intern, temporary
- `identity_document_type`: civil_id, passport, labour_card, residence_card, visa, other
- `device_employee_sync_status`: PENDING, IN_SYNC, OUT_OF_SYNC, FAILED, OFFLINE, UNSUPPORTED, REMOVING, REMOVED

**`employees`**
- Identity and profile: employee_number (citext), first/middle/last_name, display_name, display_name_ar, photo_path, gender, date_of_birth, nationality_code, email, phone.
- Employment: joining_date, exit_date (CHECK ≥ joining), employment_status, employment_type, branch_id (NOT NULL), department_id, designation_id.
- **`manager_employee_id`**: self-FK, ON DELETE SET NULL, indexed on (org, manager_employee_id). This is the only line-manager link.
- **`user_id` → user_profiles**: indexed, but not used by any app code or RLS. The demo seed fills it.
- Device identity: device_user_id (`^[A-Za-z0-9_-]{1,32}$`, unique per org), card_number, pin_hash, fingerprint_enrolled, face_enrolled.
- Also: weekly_off_days override, custom_fields jsonb (for example `ramadanEligible`), generated `search` tsvector, deleted_at, created_by/updated_by.

**Related tables**
- `employment_history`: effective-dated `[effective_from, effective_to)` with a GiST no-overlap constraint. Carries branch_id, department_id, designation_id, manager_employee_id, employment_type, employment_status, reason.
- `employee_identity_documents`.
- `employee_provider_identities`: (provider_key, device_user_id) is unique per org.

### 1.4 Shifts, rules, holidays, leave — `20260905001000_shifts_rules_holidays_leave.sql`

**Enums**
- `shift_type`: FIXED, FLEXIBLE
- `assignment_target`: ORGANIZATION, BRANCH, DEPARTMENT, TEAM, EMPLOYEE
- `punch_interpretation`: FIRST_LAST, PAIRED, DIRECTIONAL
- `rounding_mode`: NONE, NEAREST, UP, DOWN
- `missing_punch_behavior`: FLAG_ONLY, ASSUME_SHIFT_END, TREAT_AS_ABSENT, TREAT_AS_HALF_DAY
- `holiday_type`: PUBLIC, RELIGIOUS, COMPANY, REGIONAL
- `leave_status`: PENDING, APPROVED, REJECTED, CANCELLED
- `leave_source`: INTERNAL, EXTERNAL
- `half_day_part`: FIRST_HALF, SECOND_HALF

**`shifts`**
- code, name, name_ar, type.
- FIXED: start_time, end_time; `crosses_midnight` is generated as `end_time <= start_time`.
- FLEXIBLE: required_minutes (0..1440), core_start, core_end, day_boundary (default '04:00').
- breaks jsonb: `[{start,end,paid}]` or `[{minutes,paid}]`.
- punch_in_window_before_minutes (default 240, 0..720), punch_out_window_after_minutes (default 360, 0..720).
- grace_in_minutes / grace_out_minutes (nullable, 0..240; override the rule set).
- color, status.
- CHECKs: a FIXED shift must have times; a FLEXIBLE shift must have required_minutes.

**`shift_patterns`**: code, name, cycle_length_days (1..366), sequence jsonb (`[{day, shiftId}|{day, off:true}]`), anchor_date, status.

**`shift_assignments`**
- target_type, target_id (no FK), branch_id (denormalised for RLS), shift_id XOR shift_pattern_id, effective_from, effective_to, created_by.
- GiST no-overlap per (target_type, target_id, daterange).

**`attendance_rule_sets`**
- Scoping: branch_id (NULL = organisation default), name, effective_from, effective_to, version, created_by. GiST no-overlap per (org, coalesce(branch)).
- Rule columns (default, allowed range):

| Column | Default | Allowed |
|---|---|---|
| grace_in_minutes | 10 | 0..240 |
| grace_out_minutes | 0 | 0..240 |
| late_threshold_minutes | 0 | 0..480 |
| early_departure_threshold_minutes | 0 | 0..480 |
| min_full_day_minutes | 420 | 0..1440 |
| half_day_threshold_minutes | 240 | 0..1440 |
| overtime_enabled | true | |
| overtime_start_after_minutes | 30 | 0..480 |
| overtime_min_block_minutes | 30 | 0..480 |
| overtime_rounding_minutes | 15 | 0/5/10/15/30/60 |
| overtime_max_minutes_per_day | null | 0..1440 |
| count_early_in_as_overtime | false | |
| punch_rounding_minutes | 0 | 0/5/10/15/30 |
| punch_rounding_mode | NONE | rounding_mode |
| worked_rounding_minutes | 0 | 0/5/10/15/30 |
| worked_rounding_mode | NONE | rounding_mode |
| punch_interpretation | FIRST_LAST | |
| duplicate_punch_window_seconds | 60 | 0..3600 |
| missing_punch_behavior | FLAG_ONLY | |
| auto_absent_without_punches | true | |
| weekly_off_work_counts_as_overtime | true | |
| holiday_work_counts_as_overtime | true | |
| ramadan_mode jsonb | `{}` | `{enabled, from, to, scheduledMinutes 60..600, appliesTo: all \| flagged_employees}` |
| extra jsonb | `{}` | unused |

**Holidays**
- `holiday_calendars`: name, country_code, is_default (at most one per org).
- `holidays`: calendar_id, name, name_ar, date, end_date, is_half_day, type, **branch_ids uuid[] (NULL = every branch on the calendar)**, is_tentative.
- A branch picks its calendar through `branches.holiday_calendar_id`, falling back to the org default. So **per-branch holiday calendars already exist**.

**Leave**
- `leave_types`: code, name, name_ar, is_paid, color, status, `treat_as_present` (0909), `annual_allowance_days numeric(5,1)` 0..366 (0927).
- `leave_records`:
  - Columns: employee_id, branch_id, leave_type_id, start_date, end_date, is_half_day, half_day_part, **status (default 'APPROVED')**, source, external_ref, reason, approved_by, approved_at, created_by, **decision_note (≤ 1000, from 0927)**.
  - CHECKs: `end_date >= start_date`; a half day must be a single date and have a part.
- There are no entitlements, accruals or carry-over.

### 1.5 Attendance — `20260905001100_attendance.sql`

**Enums**
- `verification_method`: fingerprint, face, card, pin, password, palm, iris, mobile, manual, unknown
- `punch_direction`: in, out, break_out, break_in, overtime_in, overtime_out, unknown
- `raw_source`: POLL, WEBHOOK, DEVICE_PUSH, IMPORT, MANUAL
- `raw_processing_status`: pending, normalized, unmatched, ignored, error, plus quarantined and held (added in 1900)
- `event_source`: DEVICE, MANUAL, CORRECTION, IMPORT, MOBILE (MOBILE is never produced)
- `attendance_event_type`: PUNCH, PUNCH_IN, PUNCH_OUT, BREAK_START, BREAK_END
- **`attendance_status`**: PRESENT, ABSENT, LEAVE, HOLIDAY, WEEKLY_OFF, HALF_DAY, MISSING_PUNCH, NOT_JOINED, EXITED, PENDING
- `record_history_reason`: INITIAL, NEW_EVENT, CORRECTION, RULE_CHANGE, SHIFT_CHANGE, HOLIDAY_CHANGE, LEAVE_CHANGE, RECALCULATION, MANUAL_OVERRIDE, UNLOCK
- `correction_type`: ADD_PUNCH, EDIT_PUNCH, REMOVE_PUNCH, SET_STATUS
- `correction_status`: PENDING, APPROVED, REJECTED, CANCELLED, APPLIED
- **`approval_entity`**: ATTENDANCE_CORRECTION, OVERTIME, MISSING_PUNCH, SHIFT_CHANGE, MANUAL_ATTENDANCE, LEAVE
- `approval_status`: PENDING, APPROVED, REJECTED, CANCELLED
- **`approver_type`**: MANAGER, ROLE, USER
- `recalculation_status`: QUEUED, RUNNING, COMPLETED, FAILED, CANCELLED
- `period_summary_status`: draft, finalized

**`attendance_raw_transactions`** (partitioned by month on punched_at; append-only by trigger; only bookkeeping columns may change)
- Columns: id bigint, organization_id, **device_id NOT NULL**, branch_id, provider_key, provider_transaction_id, device_employee_id, employee_id, punched_at, device_local_time, verification_method, direction, raw_payload, received_at, source, sync_job_id, dedupe_hash, processing_status, processing_error, processed_at.
- Migration 1900 added assumed_timezone, clock_skew_seconds, device_generation.
- Unique indexes: (org, device, dedupe_hash, punched_at) and (org, device, provider_transaction_id, punched_at).

**`attendance_events`** (partitioned; immutable by trigger)
- id, employee_id, branch_id, device_id, raw_transaction_id, source, event_type, punched_at, verification_method, correction_id, **note**, voided_at, voided_by_correction_id, created_by.

**`attendance_daily_records`** (unique on org, employee_id, attendance_date)
- Context: attendance_date, branch_id, department_id, shift_id, shift_assignment_id, rule_set_id, timezone.
- Schedule: expected_start_at, expected_end_at, scheduled_minutes.
- Actuals: first_in_at, last_out_at, worked_minutes, break_minutes, late_minutes, early_departure_minutes, overtime_minutes.
- `overtime_category` text: REGULAR, WEEKLY_OFF or HOLIDAY. NIGHT appears only in a comment.
- Outcome: **status**, **flags text[]**, punch_count, has_correction.
- Provenance: calculation_version, engine_version, trace jsonb, computed_at, locked_at.
- Trigger `attendance_daily_records_period_lock` enforces period locks; it is bypassed only when `flowza.bypass_period_lock=on`.
- There is **no notes or comment column**.

**`attendance_daily_record_history`**: append-only snapshot with reason and calculation_version.

**`approval_workflows`**
- entity_type, name, branch_id, **steps jsonb (array of 1..5 items)** shaped like `[{order, approverType, roleId?, userId?}]`, is_default, status.
- Unique default per (org, entity_type, coalesce(branch)).

**`approval_requests`**: workflow_id (nullable), entity_type, entity_id, branch_id, employee_id, **current_step**, status, requested_by, completed_at. Indexed on (entity_type, entity_id); not unique.

**`approval_steps`**: request_id, step_no (unique per request), approver_type, approver_role_id, approver_user_id, status, acted_by, acted_at, comment.

**`attendance_corrections`**
- Columns: employee_id, branch_id, attendance_date, type, original_event_id, original_punched_at, proposed_punched_at, proposed_event_type, proposed_status, reason (≥ 3 chars), **attachment_path (never used)**, requested_by, status, approval_request_id, applied_event_id, applied_at, applied_by, rejection_reason.
- The `attendance_corrections_shape` CHECK enforces which fields each type needs.

**Other tables**
- `attendance_recalculation_requests`: range at most 366 days.
- `attendance_period_locks`: branch_id NULL = whole org; GiST no-overlap while unlocked; `app.is_period_locked(org, branch, date)`.
- `attendance_period_summaries`: working_days, present/absent/leave/paid_leave days (numeric), holiday/weekly_off/half/missing_punch/late days, regular_minutes, overtime_minutes, overtime_weekly_off_minutes, overtime_holiday_minutes, late_minutes, early_departure_minutes, status, version, record_versions, finalized_by, finalized_at.

### 1.6 Reports, notifications, audit — 1200

- `report_requests`: report_type, parameters, branch_id, format (csv/xlsx/pdf), status (QUEUED, RUNNING, COMPLETED, FAILED, EXPIRED, CANCELLED), file_path, file_size_bytes, row_count, error, queue_job_id, requested_by, expires_at.
- `import_jobs`: type is only `'EMPLOYEES'`. `import_job_rows`.
- **`notifications`**: organization_id, user_id, category (`notification_category`: DEVICE, ATTENDANCE, APPROVAL, SYSTEM, SUBSCRIPTION), type text, title, body, data, link, read_at.
- **`notification_preferences`**: primary key (user_id, organization_id, category, channel), enabled. `notification_channel`: IN_APP, EMAIL, SMS, WHATSAPP, PUSH.
- `notification_deliveries`: channel, status (pending, sent, failed, skipped), provider, provider_message_id, error, attempts.
- `audit.logs`: append-only. `audit.actor_type` is USER, SYSTEM, PLATFORM_ADMIN, API_KEY or DEVICE; API_KEY is never used.

### 1.7 Plans, flags, API keys, outbox — 1300

- `plans`, `subscriptions`, `entitlements`, `usage_records`, `feature_flags`, `organization_feature_flags`, `data_retention_policies`, and `usage_quotas` (1900).
- **`api_keys`**: name, key_prefix, key_hash (unique), scopes text[] with no defined vocabulary, branch_ids, last_used_at, expires_at, revoked_at, created_by.
- **`domain_events`** (outbox): id bigint, organization_id, event_type (`^[a-z_]+\.[a-z_]+$`), aggregate_type, aggregate_id, payload, actor_user_id, request_id, occurred_at, published_at, publish_attempts, publish_error.
- **`outbound_webhook_subscriptions`**: url, **secret_hash**, events text[], status.

### 1.8 Authorization functions and the policy generator — `20260905000500_authorization_functions.sql`

**Claims and context helpers**
- `app.claims()` and `app.uid()`.
- `app.is_system()` requires both claim role `flowza_system` and the session's current role `flowza_system`.
- `app.system_org_id()` and `app.is_platform_admin()`.

**Set-returning helpers**
- `app.org_ids_with_permission(perm)` unions: the system org; the user's active memberships whose role holds `perm`; and active platform grants (write grants, or `.view`/`.export` permissions for read grants).
- `app.unrestricted_org_ids()` returns orgs where the user's membership has `all_branches = true`.
- `app.allowed_branch_ids()` returns `membership_branches` rows for restricted memberships.
- **`app.own_employee_ids()`** returns `org_memberships.employee_id` for the user's active memberships. This is the self-service link.
- `app.member_org_ids()`, `app.has_permission`, `app.can_access_branch`, `app.is_org_member`.

**`app.apply_tenant_policies(table, view_perm, write_perm, branch_col, self_col, delete_perm)`** generates `<t>_select/insert/update/delete` policies for the `authenticated` and `flowza_system` roles:
- Branch predicate: `org ∈ unrestricted_org_ids() OR branch_col IS NULL OR branch_col ∈ allowed_branch_ids()`.
- Self predicate: `self_col ∈ own_employee_ids()`.
- select: `(org ∈ org_ids_with_permission(view) AND branch) OR self`.
- insert/update: `org ∈ org_ids_with_permission(write) AND branch`.
- delete: the same with `delete_perm`, defaulting to `write_perm`.

**`app.apply_readonly_tenant_policies(table, view_perm, branch_col, self_col)`** generates the same select policy, plus an ALL policy for `flowza_system` limited to `system_org_id()`.

**`app.principal_snapshot(user)`** (`20260909000300_principal_snapshot.sql`, executable by `flowza_api` only) returns `{profile, isPlatformAdmin, memberships[{membershipId, organizationId, roleId, roleKey, allBranches, employeeId, permissions[], branchIds[]}], grants[], allPermissions, mfaRequiredOrgIds}`.

Migration 2000 (`platform_context`) adds `app.is_platform_context()` with read-only and whitelisted policies for the outbox relay, metering, scheduler scans and partitions.

### 1.9 How permissions map to RLS — `20260905001400_rls_policies.sql`

In the policy column, "view/write" lists the view permission and the write permission.

| Table | Policy (view / write) | Branch col | Self col | Notes |
|---|---|---|---|---|
| branches | branch.view / branch.manage | id | – | |
| departments, teams | department.view / department.manage | branch_id | – | designations and team_members use the same permissions, without a branch column |
| employees | employee.view / employee.update | branch_id | id | delete = employee.delete; insert overridden to employee.create + branch |
| employment_history | employee.view / employee.update | branch_id | employee_id | |
| employee_identity_documents | employee.view_sensitive / employee.update | branch_id | employee_id | |
| shifts, shift_patterns | shift.view / shift.manage | – | – | |
| shift_assignments | shift.view / shift.assign | branch_id | – | |
| attendance_rule_sets | attendance.view / attendance.manage_rules | branch_id | – | |
| holiday_calendars, holidays | holiday.view / holiday.manage | – | – | |
| leave_types | leave.view / leave.manage | – | – | plus a self-service select (below) |
| leave_records | leave.view / leave.manage | branch_id | employee_id | plus self insert/cancel (below) |
| attendance_raw_transactions | read-only, attendance.view_raw | branch_id | – | |
| attendance_events, attendance_daily_records, attendance_daily_record_history | read-only, attendance.view | branch_id | employee_id | |
| attendance_corrections | attendance.view / attendance.correct | branch_id | employee_id | plus self insert (below) |
| **approval_workflows** | attendance.view / **organization.manage** | branch_id | – | |
| **approval_requests** | attendance.view / **attendance.approve** | branch_id | employee_id | |
| **approval_steps** | attendance.view / attendance.approve | – | – | plus `approval_steps_assignee`: select where approver_user_id = uid |
| attendance_recalculation_requests | attendance.view / attendance.recalculate | branch_id | – | |
| attendance_period_locks | attendance.view / attendance.lock_period | branch_id | – | |
| attendance_period_summaries | read-only, payroll.view | branch_id | employee_id | |
| report_requests | report.view | branch_id | – | select = own requests OR report.manage |
| notifications | – | – | – | own rows select/update; system does everything |
| notification_preferences | – | – | – | own rows only |
| api_keys, outbound_webhook_subscriptions, data_retention_policies | organization.manage / organization.manage | – | – | |
| domain_events | – | – | – | system only; authenticated may insert for member orgs |
| org_memberships | user.view / user.manage | – | – | members can always read their own row |
| roles, role_permissions | read: system roles or member; write: role.manage | – | – | non-system roles only |
| organization_settings | read: members; write: organization.manage | – | – | |

### 1.10 Permission vocabulary and system roles

`/home/user/Flowza-Time/packages/contracts/src/permissions.ts` defines 46 keys: 44 from `20260905001600_reference_data.sql` plus `leave.request` and `attendance.request_correction` from 0927.

- **dashboard:** dashboard.view
- **organization:** organization.view, organization.manage
- **users:** user.view, user.manage, role.manage
- **structure:** branch.view, branch.manage, department.view, department.manage
- **employees:** employee.view, employee.view_sensitive, employee.create, employee.update, employee.delete, employee.import, employee.export
- **devices:** device.view, device.create, device.update, device.manage, device.sync
- **shifts / calendar / leave:** shift.view, shift.manage, shift.assign, holiday.view, holiday.manage, leave.view, leave.manage, leave.request
- **attendance:** attendance.view, attendance.view_own, attendance.view_raw, attendance.correct, attendance.approve, attendance.manage_rules, attendance.recalculate, attendance.lock_period, attendance.request_correction
- **payroll:** payroll.view, payroll.finalize
- **reports:** report.view, report.manage, report.export
- **audit / notifications:** audit.view, notification.manage

`notification.manage` and `report.export` are not enforced anywhere in API or worker code. `organization.view` is only checked in the web UI.

System roles have fixed ids `10000000-…-0001` to `…-0008`: owner, org_admin, hr_admin, hr_user, branch_manager, attendance_admin, payroll, employee. Columns below are Own, OrgA, HRA, HRU, BrM, AttA, Pay, Emp; x means granted.

| Permission | Own | OrgA | HRA | HRU | BrM | AttA | Pay | Emp |
|---|---|---|---|---|---|---|---|---|
| dashboard.view, organization.view, branch.view, department.view, employee.view, shift.view, report.view | x | x | x | x | x | x | x | – |
| holiday.view, leave.request, attendance.request_correction | x | x | x | x | x | x | x | x |
| organization.manage, user.manage, role.manage, branch.manage, notification.manage | x | x | – | – | – | – | – | – |
| user.view, department.manage, employee.view_sensitive, employee.delete, employee.export, attendance.lock_period, report.manage | x | x | x | – | – | – | – | – |
| employee.create, employee.import | x | x | x | x | – | – | – | – |
| employee.update, device.view, device.sync, shift.assign, attendance.correct | x | x | x | x | x | x | – | – |
| device.create, device.update, device.manage | x | x | – | – | – | x | – | – |
| shift.manage, holiday.manage, attendance.view_raw, attendance.manage_rules, attendance.recalculate, audit.view | x | x | x | – | – | x | – | – |
| leave.view | x | x | x | x | x | – | x | – |
| leave.manage | x | x | x | x | x | – | – | – |
| attendance.view, report.export | x | x | x | x | x | x | x | – |
| attendance.view_own | x | x | – | – | – | – | – | x |
| attendance.approve | x | x | x | – | x | x | – | – |
| payroll.view | x | x | x | – | – | – | x | – |
| payroll.finalize | x | – | – | – | – | – | x | – |

- `branch_manager` gets its branch scope from `org_memberships.all_branches=false` plus `membership_branches`.
- `employee` holds exactly four permissions: attendance.view_own, holiday.view, leave.request, attendance.request_correction.

**Feature flags**
- `employee_self_service`, `mobile_attendance` and `customer_webhooks` all default to false and are labelled "(future)". The portal is **not** gated by `employee_self_service`.
- Plan features include `api_access` and `customer_webhooks` (enterprise).

### 1.11 What the self-service migration added — `20260927000100_employee_self_service.sql`

- **No new tables.**
- Permissions `leave.request` (sort 77) and `attendance.request_correction` (88), granted to **every system role**. Custom roles are untouched.
- Columns `leave_types.annual_allowance_days numeric(5,1)` (0..366) and `leave_records.decision_note text` (≤ 1000).
- Policies:
  - `leave_types_self_service_select`: active types, for holders of leave.request.
  - `leave_records_self_request` (INSERT): own employee, status PENDING, source INTERNAL, approved_* null, decision_note null, `created_by = uid`, branch must equal the employee's branch.
  - `leave_records_self_cancel` (UPDATE): PENDING → CANCELLED.
  - `attendance_corrections_self_request` (INSERT): own employee, PENDING, `requested_by = uid`, `approval_request_id` null, branch matches.
- Function and trigger `app.leave_records_self_service_guard`: a `current_user = 'authenticated'` session without leave.manage may only change status PENDING → CANCELLED.
- The employee↔user link is **unchanged**. It stays `org_memberships.employee_id`, read through `app.own_employee_ids()`.

### 1.12 Shared enum vocabularies — `/home/user/Flowza-Time/packages/contracts/src/enums.ts`

These mirror the database enums above.

- **ATTENDANCE_FLAGS** (stored as text[]): LATE, EARLY_DEPARTURE, OVERTIME, MISSING_IN, MISSING_OUT, MANUAL_CORRECTION, OUT_OF_WINDOW, WORKED_ON_HOLIDAY, WORKED_ON_WEEKLY_OFF, HALF_DAY_LEAVE, DUPLICATE_PUNCHES_COLLAPSED, RAMADAN_HOURS, CROSS_MIDNIGHT, NO_SHIFT, UNDER_HOURS.
- **REPORT_TYPES**: 18 types (see section 5).
- **QUEUE_NAMES**: sync, processing, reports, notifications, maintenance.
- **DOMAIN_EVENT_TYPES** live in `/home/user/Flowza-Time/packages/contracts/src/sync.ts` (listed in section 7).

---

## 2. The approval model as implemented

**Where the code is**
- Service: `/home/user/Flowza-Time/apps/api/src/services/features/attendance.service.ts`, lines 315–606.
- Routes: `/home/user/Flowza-Time/apps/api/src/routes/v1/features/attendance.ts`.
- Contracts: `/home/user/Flowza-Time/packages/contracts/src/dto-features/attendance.ts`.

### 2.1 Endpoints

| Method and path | Permission | Behaviour |
|---|---|---|
| `GET /orgs/:orgId/approvals/inbox` | membership | Pending steps where `step_no = request.current_step` and the approver is `user_id = me`, or `approver_role_id = my roleId`, or I am owner (sees every ROLE step). Branch-filtered for restricted members. Adds correction detail and requester name. |
| `POST /orgs/:orgId/approvals/:requestId/approve` | membership | `approvalDecisionSchema {comment?}` |
| `POST /orgs/:orgId/approvals/:requestId/reject` | membership | comment is required |
| `GET /orgs/:orgId/approval-workflows` | attendance.view | |
| `POST`, `PATCH /:id`, `DELETE /:id` on approval-workflows | organization.manage | |
| Corrections: `POST/GET /orgs/:orgId/attendance/corrections`, `POST …/corrections/:id/cancel` | see 2.2 | |

There is **no GET for a single approval request** or its step history, and no "my submitted requests" endpoint.

### 2.2 Routing at submission — `createCorrection`

1. **Permission.** `attendance.correct` covers any employee in scope. `attendance.request_correction` covers only the caller's own `employeeId`, only for ADD/EDIT/REMOVE_PUNCH (not SET_STATUS), and only when `settings.attendance.allowSelfServiceCorrections === true`.
2. **Checks.** The branch must be accessible, the period unlocked, the original event must exist and not be voided, and no duplicate PENDING/APPROVED correction may exist.
3. **Insert and emit.** The correction is inserted as PENDING, audited as `attendance.correction_submitted`, and a domain event is emitted.
4. **Pick a workflow** (in a system step). Only `entity_type='ATTENDANCE_CORRECTION'`, `status='active'`, `is_default=true` workflows qualify. A branch-specific workflow wins over the org-wide one.
   - **No workflow, and the requester holds attendance.approve (not self-service):** the correction is **auto-approved**.
   - **No workflow otherwise:** a single step `{ROLE, hr_admin role id}` is used.
5. **Resolve each step now, and snapshot it into `approval_steps`:**
   - `USER` → approver_user_id.
   - `ROLE` → approver_role_id.
   - **`MANAGER`** → the subject employee's `employees.manager_employee_id`, then the active `org_memberships` row whose `employee_id` is that manager, then its `user_id`. If the manager has no active login, it falls back to `ROLE hr_admin`.
6. **Create the request** as `approval_requests(current_step=1)` and emit `approval.pending` with payload `{entityType, entityId, employeeId, steps}`.

### 2.3 Deciding — `decide`

The whole decision runs as a system step with `SELECT … FOR UPDATE` on the request.

**Pre-checks**
- The request must be PENDING and the caller must be in its branch scope.
- `canAct` rules:
  - A step with a user id: only that user may act.
  - A step with a role id: `grant.roleId === step.approver_role_id` (exact role match), or an owner who holds attendance.approve.
- Separation of duties: the requester may never decide on their own request.

**Outcomes**
- **Reject:** the current step becomes REJECTED and the remaining steps CANCELLED; the request becomes REJECTED; the correction becomes REJECTED with a rejection_reason; the requester is notified via `attendance.correction_rejected`.
- **Approve, more steps remain:** the step becomes APPROVED and `current_step` moves to the next pending step. No event is emitted.
- **Approve, last step:** the request becomes APPROVED, the correction APPROVED, an `APPLY_CORRECTION` job is queued (priority 7), and `attendance.correction_approved` is emitted.
- Audit actions: `approval.approved`, `approval.step_approved`, `approval.rejected`.

**After approval:** the worker job (`/home/user/Flowza-Time/apps/worker/src/handlers/attendance/corrections.ts`) marks the correction APPLIED, voids and/or adds a CORRECTION event (verification 'manual', note = reason), and triggers an immediate RECOMPUTE_DAILY. A SET_STATUS correction is applied as an override during recompute (`recompute.ts applyCorrections`).

**Cancel:** the requester or any attendance.approve holder may cancel while PENDING. The request and its pending steps become CANCELLED.

### 2.4 How multilevel it really is

- It is **sequential and single-track**, 1 to 5 steps.
- Each step has exactly one approver target: one user, one role, or the direct manager.
- There is **no** parallel or any-of/all-of step, no conditional routing (thresholds, type, duration), no skip-level manager, no delegation or out-of-office, no SLA, escalation or auto-approve timer, and no re-routing after a manager changes (steps are snapshotted at submit).
- A ROLE step is matched on role **id**, not permission. A custom role that holds attendance.approve cannot act on an `hr_admin` step.

### 2.5 Which entities go through approval

- **Only ATTENDANCE_CORRECTION.**
- **Leave does not use the approval engine.** A self-service request is a PENDING `leave_records` row, and HR decides it with `PATCH /orgs/:orgId/leave-records/:id {status: APPROVED|REJECTED, decisionNote}`, which requires leave.manage and branch access. Separation of duties blocks deciding your own leave. HR-created leave (`POST /leave-records`) is APPROVED immediately.
- OVERTIME, MISSING_PUNCH, SHIFT_CHANGE, MANUAL_ATTENDANCE and LEAVE exist only in the enum and in the workflow-editor dropdown. Nothing routes them. The dashboard ApprovalsCard has a `LEAVE` icon branch that never fires.

### 2.6 How "manager" is determined

- **Approvals:** only `employees.manager_employee_id`, one level, and only through the `org_memberships.employee_id` link.
- **Data scope:** only branch scope (`all_branches` + `membership_branches`, for example the branch_manager role).
- Teams (`lead_employee_id`), departments (`manager_employee_id`, `parent_id`) and `employment_history.manager_employee_id` are display data only. There is no "my team" scope, no `app.managed_employee_ids()`, and no recursive hierarchy.
- Each user has one role per org, so someone who is both manager and HR needs a custom role.

### 2.7 Web approvals feature — `/home/user/Flowza-Time/apps/web/src/features/approvals/`

**`/approvals`** (`pages/approvals-page.tsx`, gated `attendance.approve`; the sidebar link needs the same permission)
- **Pending tab** (the inbox): columns employee, date, type, change, reason, requester/created, "Step N · approverType", and Approve/Reject buttons. Own requests show "cancel instead" in place of the buttons.
- **Decided tab:** lists **corrections** (not approval requests), filtered by status APPROVED/APPLIED/REJECTED/CANCELLED, with columns employee, date, type, change, status + rejection reason, decidedAt.
- `components/decision-dialog.tsx`: comment is required to reject.

**`/approvals/workflows`** (`pages/workflows-page.tsx`, gated `attendance.view`; editing needs organization.manage)
- `components/workflow-dialog.tsx` edits name, entityType (every APPROVAL_ENTITIES value), branch scope, status, the isDefault switch, and an ordered steps builder of 1–5 steps (MANAGER / ROLE via role combobox / USER via member combobox) with move up, move down and remove.

**Visibility gap for managers.** The API test (`attendance.test.ts:161`) has a manager with the `hr_user` role acting through the API. The web UI does not let that manager in:
- The web route requires attendance.approve, which `hr_user` lacks.
- The inbox query joins `approval_requests`, and RLS needs `attendance.view` on that table. A manager with only the `employee` role would most likely see an empty inbox (inferred from the policies; not tested).
- The `approval.pending` notification goes to **every attendance.approve holder**, not to the resolved step approver, and nothing is emitted when a request moves to step 2.

---

## 3. Employee portal (`/my`)

### 3.1 Web — `/home/user/Flowza-Time/apps/web/src/features/portal/`

**Routes and gating (`routes.tsx`)**
- Routes: `/my`, `/my/attendance`, `/my/leave`, `/my/profile`, wrapped in `RequireEmployeeLink` (the active membership must have an `employeeId`).
- The sidebar shows the "My workspace" section whenever `employeeId` is set.
- `/` redirects to `/my` when the user has no dashboard.view but has an employee link (`/home/user/Flowza-Time/apps/web/src/routes.tsx`).
- `/attendance` and `/leave` redirect to their `/my/*` counterparts through `RequirePermission selfServiceTo`.

**`pages/home-page.tsx`**
- Greeting, "View attendance" and "Apply leave" buttons, pending badges.
- A Today card: shift and expected times from the daily record, first in, last out, worked, late.
- This-month stat cards: attendance rate, present, late, worked, overtime, leave.
- Leave balances, upcoming leave, upcoming holidays, and the last 7 days.

**`pages/attendance-page.tsx`**
- Month navigation and stat cards.
- Tabs: `calendar` (`components/month-calendar.tsx`), `log`, `activity` (reuses the employee ActivityTab: in-office vs field time), and `corrections` (own list, withdraw while PENDING).
- The day dialog reuses the HR `RecordDialog` (trace, events, history, corrections).
- A "Request correction" button appears only when `allowSelfServiceCorrections` is on.

**`components/self-correction-dialog.tsx`**
- Types: ADD_PUNCH, EDIT_PUNCH, REMOVE_PUNCH.
- The time is entered in branch local time and sent as UTC; direction is PUNCH_IN, PUNCH_OUT or PUNCH; picks existing events for edit/remove; reason is required.
- Posts to `/orgs/:orgId/attendance/corrections`.

**`pages/leave-page.tsx`** has a year selector, a requests table (type, range, half-day part, days, reason, decision note, decided by, status) with withdraw while PENDING, and balance bars (used and pending against the allowance).

**`components/apply-leave-dialog.tsx`**
- Fields: type (showing remaining balance), start, end, half day plus part, reason (min 3).
- A live preview of working days charged uses `model.ts previewLeaveDays`, which mirrors the domain's `countLeaveDays`. It warns when the request goes over the balance but never blocks.

**`pages/profile-page.tsx`** is read-only: employment details (designation, department, manager, teams, joined) and personal data. `photoUrl` is always null.

**`model.ts`** holds pure helpers: previewLeaveDays, monthWeeks, weekdayOrder, shiftMonth, validMonth, balanceShares, tenure, fmtDays.

### 3.2 API

- Routes: `/home/user/Flowza-Time/apps/api/src/routes/v1/self-service.ts`.
- Service: `/home/user/Flowza-Time/apps/api/src/services/self-service.service.ts`.
- DTOs: `/home/user/Flowza-Time/packages/contracts/src/dto/self-service.ts`.
- The employee is always the membership's `employeeId`; no endpoint accepts an employee id.

| Endpoint | Needs | Returns |
|---|---|---|
| `GET /orgs/:orgId/me/profile` | an employee link | `SelfProfileDto` (branch, department, designation, manager, teams, weeklyOffDays, roleName) |
| `GET /orgs/:orgId/me/overview` | an employee link | `SelfOverviewDto` (today, month totals, recent, balances, upcomingLeave, pendingLeave, pendingCorrections, upcomingHolidays) |
| `GET /orgs/:orgId/me/attendance?month=yyyy-MM` | attendance.view_own or attendance.view | `SelfAttendanceMonthDto` (days, totals, leaveByDate, holidaysByDate) |
| `GET /orgs/:orgId/me/leave?year=` | leave.request or leave.view | `SelfLeaveDto` (types, balances, records, calendar) |
| `POST /orgs/:orgId/me/leave` (idempotent) | leave.request | Creates a PENDING request (below) |
| `POST /orgs/:orgId/me/leave/:id/cancel` | leave.request | PENDING → CANCELLED only |

**Checks on `POST /me/leave`**
- The dates must fall between joining date and exit date, and the leave type must be active.
- The range must contain at least one working day, fall outside any locked period, and not overlap existing PENDING or APPROVED leave.
- It writes audit `leave.requested` and emits the `leave.requested` event.

**HR endpoints the portal reuses, scoped to own records through `attendance.view_own`:** `GET /attendance/records/:id`, `/attendance/events`, `/attendance/activity`, `/attendance/corrections`, plus `POST /attendance/corrections` and `/corrections/:id/cancel`. `PATCH /me` changes fullName and locale only.

**Domain logic:** `/home/user/Flowza-Time/packages/domain/src/leave/days.ts` provides countLeaveDays (weekly offs and holidays excluded; half day = 0.5), holidayDates, and leaveBalances (per calendar year: APPROVED = used, PENDING = pending, remaining can go negative).

### 3.3 Seed — `/home/user/Flowza-Time/supabase/seeds/demo-tenant/03b_employee_portal.sql`

- Targets the hosted demo tenant `27bfe270-5dea-4587-aec3-0f5c23113261`, Priya Sharma, MG-1012, `employee@flowza.ai`, password `Test@1234` (from the seeds README).
- Sets yearly allowances: AL 30, CL 6, EL 6, PTL 7, HJ 15, ML 98.
- Gives Priya leave in every state: two HR decision notes, CANCELLED, REJECTED, APPROVED on 2026-10-01, and two PENDING requests.
- Creates the default workflow "Line manager → HR" (MANAGER, then ROLE hr_admin) and three ADD_PUNCH corrections (PENDING, REJECTED, CANCELLED). Priya's manager MG-1010 has no login, so step 1 falls back to the hr_admin role.
- Adds notifications for Priya and for HR, plus audit rows.
- The seeds README lists 8 logins: owner, orgadmin, hradmin, hruser, payroll, attadmin, brmanager (Sohar only), employee.

### 3.4 What an employee can do today

- See today, the month, a calendar, a daily log, the activity timeline and the full record detail with trace.
- Apply for leave, including half days; withdraw a pending leave request; see balances and decisions.
- Request punch corrections (only if the org enables it) and withdraw them.
- See upcoming holidays, a read-only profile and in-app notifications.

### 3.5 What is missing

- No check-in/punch (web, mobile or PWA; `mobile_attendance` flag and `event_source MOBILE` unused).
- No geofence; the branch lat/long/radius is stored but not used.
- No selfie or photo capture, and no device or IP binding.
- No shift or roster view for upcoming days; `/shifts/resolve` needs shift.view.
- No regularisation or notes on a day beyond correction reasons, and no attachments (`attachment_path` unused).
- No overtime, permission/short-leave, WFH/on-duty or shift-swap requests.
- No manager team view, and no approvals for managers who hold only the employee role.
- No leave accruals, carry-over or per-employee entitlements.
- No payslips, documents or profile editing; no notification-preference UI; no MFA self-enrolment for employees (security settings are behind organization.view).

---

## 4. Roles and permissions in the web app

**Principal (`GET /me`, `meDtoSchema` in `/home/user/Flowza-Time/packages/contracts/src/organizations.ts`)**
- `user {id, email, fullName, avatarUrl, locale, mfaEnrolled, isPlatformAdmin}`.
- `memberships[] {membershipId, organization (OrganizationDto), roleId, roleKey, roleName, permissions[], allBranches, branchIds[], employeeId|null, featureFlags, settings (full OrganizationSettings)}`.
- The server-side equivalent is `Principal`/`MembershipGrant` in `/home/user/Flowza-Time/packages/domain/src/authorization/types.ts`, loaded per request by `/home/user/Flowza-Time/apps/api/src/lib/principal.ts` from the database, never from the JWT.

**Web hooks — `/home/user/Flowza-Time/apps/web/src/features/me/use-me.ts`**
- `useMe` (cached in localStorage, 60 s staleTime), `useActiveMembership` (reads `activeOrgId` from the zustand ui-store), `useCan(...perms)` (all of the listed permissions), `useEmployeeId`, `useOrgTimezone`, `useFeatureFlag`.

**Route gating — `/home/user/Flowza-Time/apps/web/src/components/layout/protected-route.tsx`**
- `RequireAuth` requires a Supabase session.
- `RequirePermission({permissions, selfServiceTo})` shows an empty "permission denied" state, or redirects linked employees.
- Per-feature `routes.tsx` gating:

| Route | Required permission |
|---|---|
| employees | employee.view |
| employees/new | employee.create |
| employees/import | employee.import |
| attendance | attendance.view (redirects to /my/attendance) |
| corrections | attendance.view |
| approvals | attendance.approve |
| approvals/workflows | attendance.view |
| leave | leave.view (redirects to /my/leave) |
| shifts | shift.view |
| holidays | holiday.view |
| reports | report.view |
| payroll | payroll.view |
| organization | branch.view |
| users, users/roles/:id | user.view |
| settings/* | organization.view |
| audit | audit.view |
| devices | device.view |
| devices/new | device.create |
| sync | device.view |
| reconciliation | device.sync |
| platform | platform admin only |

**Sidebar — `/home/user/Flowza-Time/apps/web/src/components/layout/sidebar.tsx`**
- Same permission filter per item.
- Sections: Dashboard; My workspace (needs an employee link); Workforce (employees, attendance, corrections, approvals, leave); Devices; Time (shifts, holidays, reports, payroll); Admin (structure, users, settings, audit); Platform.

**Users feature — `/home/user/Flowza-Time/apps/web/src/features/users/`**
- `pages/users-page.tsx` has tabs members, invitations, roles.
- `components/member-dialog.tsx` edits role, status, all-branches or a branch checklist, and the **employee link** combobox.
- `components/invite-dialog.tsx` covers email, role, branches, employee.
- `components/roles-tab.tsx` lists system and custom roles, permission count and member count.
- `pages/role-editor-page.tsx`: system roles are read-only; custom roles need role.manage.
- `components/permission-matrix.tsx` groups permissions by category with group toggles; permissions you do not hold are locked.

**API side**
- Endpoints: `GET /permissions`, `GET/POST/PATCH/DELETE /orgs/:orgId/roles`.
- Rules: the escalation trigger, immutable system roles, and last-owner protection (`members.service.ts assertNotLastOwner`).

**MFA**
- `/home/user/Flowza-Time/apps/api/src/middleware/auth.ts`: platform admins always need `aal2`.
- `/home/user/Flowza-Time/apps/api/src/middleware/mfa.ts orgMfaGate` is mounted on `/orgs/:orgId/*`. It returns 403 FORBIDDEN with `details.reason='MFA_REQUIRED'` when `security.mfaRequired` is on and the session is not `aal2`.
- Web: `AppShell` renders `/home/user/Flowza-Time/apps/web/src/features/auth/mfa-required-gate.tsx` (Supabase TOTP enrol/verify) on that error. `/auth/mfa` provides the same outside the shell.

---

## 5. HR attendance pages

**`/attendance`** (`/home/user/Flowza-Time/apps/web/src/features/attendance/`)
- Tabs: `daily`, `monthly`, `raw` (needs attendance.view_raw), `recalc`, `periods`. Header actions: Recalculate (attendance.recalculate) and Request correction (attendance.correct).
- **Daily** (`components/daily-view.tsx`, `GET /attendance/daily`):
  - Stat cards: PRESENT, ABSENT, LEAVE, HALF_DAY, MISSING_PUNCH (click to filter).
  - Filters: search, branch, department, shift, status (every ATTENDANCE_STATUSES value), flag (every ATTENDANCE_FLAGS value).
  - Columns: employee, shift, first in, last out, worked, late, early, overtime, status, flags. Sortable by firstInAt, lateMinutes, workedMinutes, status and name.
- **Monthly** (`monthly-view.tsx` + `monthly-grid.tsx`, `GET /attendance/monthly`): an employees × days grid of status letters (late, missing and OT markers), month navigation, filters search/employee/branch/department, a legend, and totals per employee.
- **Record dialog** (`record-dialog.tsx`, `GET /attendance/records/:id`): tabs trace (`trace-view.tsx`: inputs, punch timeline with roles, steps table), events (voided, attributed or other-day), history (versions and reasons), corrections. A Request correction button is disabled when the day is locked.
- **Raw** (`raw-transactions-tab.tsx`, cursor-paginated `GET /attendance/raw`): filters device, branch, processingStatus, deviceEmployeeId, from/to. Requeue for unmatched, quarantined, held or error rows (`POST /attendance/raw/:id/requeue`).
- **Recalculations** (`recalculations-tab.tsx`, `recalculate-dialog.tsx`): range, scope, reason, status and record counts, requester, job link.
- **Periods** (`period-locks-tab.tsx`): lock a period (start, end, branch, reason) or unlock it (reason ≥ 3 chars); include-unlocked toggle; locking is refused while PENDING or APPROVED corrections exist in the range.

**`/corrections`** (`/home/user/Flowza-Time/apps/web/src/features/corrections/`)
- List filters: status, employee, branch, date range.
- Columns: employee, date, type, change, reason, status + rejection reason, createdAt, cancel (requester or approver, PENDING only).
- `correction-dialog.tsx` supports every CORRECTION_TYPES value, including SET_STATUS with a status picker.

**`/leave`** (`/home/user/Flowza-Time/apps/web/src/features/leave/pages/leave-page.tsx`)
- **Records tab:** filters employee, branch, type, status, date range; columns employee, type, range/half-day, reason + decision note, status, source, created. Approve or Reject a PENDING request with a note; edit or cancel a record.
- **Types tab:** code, name, paid, allowance, status; seed GCC default types (AL, CL, SL, EL, SPL, ML, NP, SD — `DEFAULT_LEAVE_TYPES`); `leave-type-dialog.tsx` covers isPaid, treatAsPresent, color, annualAllowanceDays.

**`/shifts`** (`/home/user/Flowza-Time/apps/web/src/features/schedule/pages/shifts-page.tsx`)
- Tabs: shifts, patterns, assignments, rules.
- **Shifts:** columns code, name, type, hours (with +1 for overnight), breaks, windows, assignment count, status. The shift dialog includes a breaks editor.
- **Patterns:** `pattern-dialog.tsx`.
- **Assignments:** target and type, shift or pattern, branch, effective range with an active badge; actions end-date or delete. `resolve-shift-card.tsx` calls `GET /shifts/resolve`.
- **Rules:** `rule-set-dialog.tsx` exposes every rule field from section 1.4, including the Ramadan block. The branch of a rule set is immutable. Creating or changing a rule set triggers a recalculation when the range is in the past.
- **`/holidays`** (`holidays-page.tsx`): calendars on the left (default star, holiday count) and the selected calendar's holidays by month (half day, type, branchIds, tentative).

**`/reports`** (`/home/user/Flowza-Time/apps/web/src/features/reports/`)
- The catalogue comes from `GET /report-types` (`REPORT_TYPE_DEFINITIONS` in `/home/user/Flowza-Time/packages/contracts/src/dto-features/reports.ts`).
- **Available (12):** daily_attendance, monthly_attendance, employee_attendance, late_report, absence_report, missing_punch_report, audit_report, leave_report, attendance_summary, weekly_attendance, weekly_in_out, employee_directory.
- **Planned, refused by the API (6):** branch_attendance, department_attendance, overtime_report, device_sync_report, device_health_report, payroll_summary.
- Formats csv, xlsx, pdf; generated asynchronously by the `GENERATE_REPORT` job on the `reports` queue (PDF through Chromium on the reports machine).
- **No scheduling and no email delivery of reports.**

**`/payroll`** (`/home/user/Flowza-Time/apps/web/src/features/payroll/pages/payroll-page.tsx`)
- Periods come from `settings.attendance.payrollPeriod` and `payrollCutoffDay`.
- Actions: Build (`POST /payroll/periods/build` → `BUILD_PERIOD_SUMMARY`), Lock, Finalize (needs payroll.finalize and an active lock; fails if any day is PENDING).
- Summaries table: working, present, absent, leave (paid), holiday, late (minutes), missing, regular, OT (with weekly-off and holiday breakdown), status, version.
- **No export file and no payroll integration.**

**Settings** (`/home/user/Flowza-Time/apps/web/src/features/settings/`)
- Sections: general, dashboard, regional, attendance, sync, reports, notifications, security, subscription.
- The **attendance section** has: default shift (stored but **unused by the engine**), processing delay (used), payroll period and cut-off day (used), and self-service corrections (used).

**Dashboard** (`/home/user/Flowza-Time/apps/web/src/features/dashboard/`)
- Endpoints: `/dashboard/summary`, `/dashboard/trends`, `/dashboard/branches`.
- Layouts: overview, operations, executive. Themes: emerald, midnight, classic, desert, ocean, graphite, crimson.
- Widgets: TrendCard, TodayCard, BranchesCard, ApprovalsCard (attendance.approve; the count is org-wide PENDING approval_requests), HolidaysCard, ActivityCard/RecentAttendanceCard, DevicesCard, SyncCard, HighlightCard, QuoteCard.

**Employee profile tabs:** overview, history, devices, attendance, activity, documents, danger. The manager is editable in `employee-form-fields.tsx`.

---

## 6. Attendance engine — `/home/user/Flowza-Time/packages/domain/src/attendance/`

**Contract**
- `calculateDailyRecord(DailyCalculationInput) → DailyCalculationResult` in `calculate.ts`, with types in `types.ts`.
- `ENGINE_VERSION = 'attendance-engine/1.0.0'`. The engine is pure and writes a full trace (inputs, every punch with its role, and steps).
- Inputs are built by the worker in `/home/user/Flowza-Time/apps/worker/src/handlers/attendance/load-inputs.ts`:
  - Branch and department come from employment_history as of the date.
  - Shift comes from `resolveShift` (EMPLOYEE > TEAM > DEPARTMENT > BRANCH > ORGANIZATION; latest effective_from wins).
  - Rule set comes from `resolveRuleSet` (branch-specific beats org default).
  - Holidays come from the branch calendar, else the org default, filtered by `branch_ids`.
  - Leave is **APPROVED** leave only (full day preferred over half day).
  - Weekly off is employee, else branch, else org; a pattern `{off:true}` day is added.
  - Events are the non-voided events in `[D−1 00:00, D+2 00:00)` local.
  - `ramadanEligible` comes from `custom_fields.ramadanEligible`.

**Status precedence:** NOT_JOINED / EXITED, then HOLIDAY (full day), then WEEKLY_OFF, then LEAVE (full day), then working-day logic.

**Punch windows and cross-midnight (`window.ts`, `attribute.ts`)**
- FIXED window: `[start − punchInWindowBefore, end + punchOutWindowAfter]`. When `end ≤ start` the end falls on the next day and the CROSS_MIDNIGHT flag is set.
- FLEXIBLE: the day runs from `dayBoundary` to the next `dayBoundary` (default 04:00).
- No shift: the calendar day, flagged NO_SHIFT.
- Punches are attributed across the D−1, D and D+1 windows; overlapping windows go to the nearest scheduled start (ties to the earlier date). Punches outside every window get OUT_OF_WINDOW.

**Interpretation (`interpret.ts`)**
- Duplicates within `duplicatePunchWindowSeconds` collapse (flag DUPLICATE_PUNCHES_COLLAPSED).
- FIRST_LAST: first punch = IN, last = OUT, middle punches ignored.
- PAIRED: alternating IN/OUT; gaps are breaks.
- DIRECTIONAL: a state machine over PUNCH_IN, PUNCH_OUT, BREAK_START, BREAK_END. It falls back to PAIRED when no punch carries a direction.
- Raw direction maps as in→PUNCH_IN, out→PUNCH_OUT, break_out→BREAK_START, break_in→BREAK_END, anything else→PUNCH (`normalize.ts`).

**Schedule and breaks**
- FIXED scheduled minutes = span − unpaid fixed breaks. FLEXIBLE scheduled minutes = requiredMinutes; core hours give the expected start and end.
- Measured breaks win over shift breaks; unpaid time is deducted.
- Ramadan mode (from–to, scheduledMinutes, appliesTo) reduces scheduled minutes and moves the expected end (flag RAMADAN_HOURS).
- Half-day leave or a half-day holiday halves expectations and moves expected start/end to the midpoint (flag HALF_DAY_LEAVE).

**Rounding (`rounding.ts`)**
- Punch rounding (interval 0/5/10/15/30, mode NONE/NEAREST/UP/DOWN) applies to firstIn and lastOut on the local wall clock.
- Worked rounding applies to worked minutes.
- Overtime is always rounded DOWN.

**Late and early**
- late = max(0, firstIn − (expectedStart + graceIn)); flagged LATE only if > lateThresholdMinutes.
- early = max(0, (expectedEnd − graceOut) − lastOut); flagged EARLY_DEPARTURE if > earlyDepartureThresholdMinutes.
- Shift grace values override the rule set.

**Overtime**
- FIXED: `min(worked − scheduled, minutesAfterEnd + [earlyIn if countEarlyInAsOvertime]) − overtimeStartAfter`, rounded DOWN to overtimeRounding, floored to whole minBlocks, capped at maxPerDay. Category REGULAR.
- FLEXIBLE: `worked − required − startAfter`, then the same finalisation.
- Weekly off or holiday: all worked minutes are overtime when the rule allows it, **cap only (no rounding or blocks)**. Category WEEKLY_OFF or HOLIDAY; flags WORKED_ON_*.
- Work on a leave day earns no overtime. No overtime is counted on an assumed punch.

**Absent and pending**
- A working day with no punches is PENDING while the window is open.
- After the window closes it becomes ABSENT if autoAbsentWithoutPunches, otherwise PENDING.
- An open IN during the window is PENDING.

**Half day and under-hours:** worked < minFullDay × ratio sets UNDER_HOURS; worked < halfDayThreshold × ratio gives HALF_DAY; any half-day leave or holiday gives HALF_DAY.

**Missing punch** (after window close; flags MISSING_IN / MISSING_OUT)

| missingPunchBehavior | Outcome |
|---|---|
| FLAG_ONLY | PRESENT (or HALF_DAY), worked = 0 |
| TREAT_AS_ABSENT | ABSENT |
| TREAT_AS_HALF_DAY | HALF_DAY |
| ASSUME_SHIFT_END | Assumes the expected end (FIXED) or firstIn + required (FLEXIBLE), then classifies by worked minutes |

**The engine never emits `MISSING_PUNCH` status.** It can only appear through a SET_STATUS correction or seed data.

**Corrections at recompute:** any APPLIED correction on the date sets has_correction and MANUAL_CORRECTION. The latest SET_STATUS overrides the status (`/home/user/Flowza-Time/apps/worker/src/handlers/attendance/recompute.ts`).

**Recompute (`recompute.ts`)**
- Idempotent: an unchanged result writes nothing. A change bumps `calculation_version`, writes a history snapshot and emits `attendance.created` or `attendance.updated`.
- Locked periods are skipped unless the job sets bypassLock.

**Period summaries — `period.ts summarisePeriod`**
- workingDays = every day except HOLIDAY, WEEKLY_OFF, NOT_JOINED, EXITED.
- HALF_DAY counts 0.5 present plus 0.5 leave (with HALF_DAY_LEAVE) or 0.5 absent.
- regular = worked − OT; OT is split by category; pendingDays must be 0 to finalise.
- The worker's BUILD_PERIOD_SUMMARY with `finalize` also requires an active lock covering the period.

**Worker jobs:** NORMALIZE_RAW, RECOMPUTE_DAILY, RECALCULATE_RANGE, BUILD_PERIOD_SUMMARY, APPLY_CORRECTION (`/home/user/Flowza-Time/apps/worker/src/handlers/attendance/index.ts`).

---

## 7. Punch ingress and outbound integration (for designing a sync)

### 7.1 Inbound routes

Defined in `/home/user/Flowza-Time/apps/api/src/routes/inbound/index.ts`; mounted outside `/api/v1` behind the edge gate and a 1200/min per-IP limit.

**`ANY /device-push/:protocolKey/*`** — protocol keys `mock` and `iclock` (ZKTeco, eSSL, FingerTec)
- **Device identification:** the protocol handler reads the serial number.
- **Authentication:** a per-device push token, taken from the path `~<token>`, the `x-device-token` header, `?token=` or `Authorization: Bearer`. It is compared timing-safe against `sha256(token)` in `devices.push_token_hash`.
- **Unknown serial:** recorded in `pending_devices`. Handshakes and heartbeats get OK; data uploads get 401.
- **Limits:** 60/min per serial (in memory, per instance); body up to 2 MB.
- **Replay protection:** `provider_webhook_events` unique on (provider_key, payload_hash).
- **Processing:** ingests inline in the org's system context with source `DEVICE_PUSH`, then queues NORMALIZE_RAW (dedupe key `normalize:<org>`). The response carries pending device commands.
- Service: `/home/user/Flowza-Time/apps/api/src/services/features/inbound.service.ts`.

**`POST /webhooks/providers/:providerKey/:deviceId/:token`**
- The device must be active and match the provider; the token is the device push token.
- `provider.handleWebhook(req, secrets)` verifies the vendor signature over the raw body once.
- The normalised result `{vendorDeviceId, eventType, transactions: RawTransaction[], rawBodySha256, …}` is stored in `provider_webhook_events` (status queued; unique on event_id and on payload_hash).
- A `WEBHOOK_EVENT` job (sync queue) ingests the rows with source `WEBHOOK` (`/home/user/Flowza-Time/apps/worker/src/handlers/sync/device.ts webhookEvent`).
- **Mock webhook** (`/home/user/Flowza-Time/packages/device-providers/src/providers/mock/webhook.ts`):
  - Body: `{eventId, deviceSerial, transactions:[{id?, deviceUserId, punchedAt(ISO with offset), method?, direction?}]}`, at most 5000 transactions.
  - Signature: header `x-mock-signature = sha256hex(secret + rawBody)`, or an inline `signature` over the canonical JSON.
  - The secret is `webhookSecret` from the device's encrypted credentials.
- URLs come from `devices.service.ts pushUrls`; tokens are rotated with `POST /orgs/:orgId/devices/:id/push-token/rotate`.

### 7.2 Raw transaction shape and ingestion

- **RawTransaction** (`/home/user/Flowza-Time/packages/contracts/src/devices.ts`): `{providerTransactionId: string|null (≤200), deviceEmployeeId (1..64), punchedAt ISO-with-offset, deviceLocalTime?, verificationMethod (default 'unknown'), direction (default 'unknown'), rawPayload object}`.
- `raw_source` values: POLL, WEBHOOK, DEVICE_PUSH, IMPORT, MANUAL.
- **Dedupe hash** (`/home/user/Flowza-Time/packages/database/src/ingest-hash.ts`, shared by the API and the worker): `sha256(deviceId|generation|deviceEmployeeId|punchedAt as canonical UTC without ms|verificationMethod??'unknown'|direction??'unknown')`. Unique per (org, device, hash, punched_at); a provider_transaction_id is also unique per device.
- **Ingest rules** (`/home/user/Flowza-Time/apps/api/src/services/features/ingest.ts`, `/home/user/Flowza-Time/apps/worker/src/handlers/sync/ingest.ts`):
  - Punches more than 10 minutes in the future are quarantined. The worker also quarantines when device clock skew exceeds `sync.maxClockSkewMinutes`.
  - Punches inside a locked period are held.
  - Payloads over 16 KB are replaced by their sha256.
- **Identity resolution** in NORMALIZE_RAW: device_employee_states (device, user id), then employee_provider_identities, then `employees.device_user_id`; anything else is unmatched.

### 7.3 Public API and outbound delivery

- **There is no public API or API-key authentication.** `/home/user/Flowza-Time/apps/api/src/middleware/auth.ts` accepts only a Supabase Bearer JWT (JWKS, or HS256 when `SUPABASE_JWT_SECRET` is set) and loads the principal from the database. `api_keys` has no code path.
- `ingestRawBatchSchema` exists but no endpoint uses it, and `import_jobs` handles EMPLOYEES only. Every raw row needs a `device_id`, so any external source today has to be modelled as a device with a provider.
- **Outbox relay** (`/home/user/Flowza-Time/apps/worker/src/handlers/notifications/outbox.ts`):
  - `RELAY_OUTBOX` runs every 5 s from the leader-elected scheduler (`/home/user/Flowza-Time/apps/worker/src/tasks/maintenance.ts`) in platform context.
  - It reads up to 200 rows `where published_at is null order by id … for update skip locked`, creates in-app notifications (ROUTING table) plus pending EMAIL deliveries, publishes coalesced Supabase Realtime invalidations to `org:<id>:sync|devices|attendance` (inert without `SUPABASE_SERVICE_ROLE_KEY`), and sets `published_at`.
  - Published events are **never pruned**.
- **No outbound webhook delivery.** `outbound_webhook_subscriptions` is unused, and it stores only `secret_hash`, which cannot sign payloads; a signing secret would need encrypted storage like device credentials.

**Domain event types and payloads** (`DOMAIN_EVENT_TYPES`):

| Event | Payload |
|---|---|
| employee.created | {employeeNumber, branchId, deviceUserId} |
| employee.updated | {changed[], transition, branchId} |
| employee.deleted | {employeeNumber, branchId, exitDate} |
| employee.imported | |
| device.created, device.updated, device.credentials_changed | |
| device.online, device.offline | |
| sync.queued, sync.completed, sync.failed | |
| sync.item_failed | declared, never emitted |
| **attendance.created** | {employeeId, date, status, flags, branchId}; aggregate `attendance_daily_record` |
| **attendance.updated** | the same plus previousStatus, version, reason |
| attendance.correction_submitted | {employeeId, attendanceDate, type} |
| attendance.correction_approved | {approvedBy, comment, employeeId, attendanceDate, userId?} |
| attendance.correction_rejected | {rejectedBy, reason, employeeId, attendanceDate, userId?} |
| approval.pending | {entityType, entityId, employeeId, steps} |
| report.ready, report.failed | |
| subscription.limit_reached | declared, never emitted |
| leave.requested | {employeeId, employeeName, leaveTypeName, startDate, endDate} |
| leave.approved, leave.rejected | {userId, employeeId, leaveTypeName, startDate, endDate, decisionNote} |

No events are emitted for HR-created leave, shift or assignment changes, rule-set changes, period locks or payroll finalisation.

---

## 8. Notifications

**In-app**
- The relay's ROUTING table decides recipients: by default every active member whose role holds the listed permission, plus `payload.userId`. Duplicates are skipped for the same user, type and aggregate within 15 minutes.

| Event | Recipients |
|---|---|
| device.offline, device.online | device.view holders |
| sync.failed | device.sync holders |
| sync.completed | device.sync holders, manual non-health syncs only |
| approval.pending | attendance.approve holders |
| attendance.correction_approved, attendance.correction_rejected | attendance.correct holders, plus the requester |
| leave.requested | leave.manage holders |
| leave.approved, leave.rejected | the requester only |
| report.ready, report.failed | the requester only |
| employee.imported | employee.import holders |
| subscription.limit_reached | organization.manage holders |

- Routing ignores branch scope. The seed also contains a `system.welcome` type.
- API: `GET /me/notifications`, `/me/notifications/unread-count`, `POST /me/notifications/read-all`, `POST /me/notifications/:id/read`. The web bell polls every 60 s (`/home/user/Flowza-Time/apps/web/src/features/notifications/`).

**Email**
- `DELIVER_NOTIFICATIONS` runs every 15 s, 100 per batch. `createMailer` in `/home/user/Flowza-Time/apps/worker/src/lib/platform.ts` supports `EMAIL_PROVIDER=console|resend` (`RESEND_API_KEY`, `EMAIL_FROM`).
- The email is a plain title/body/link template; delivery is retried up to 5 attempts, then marked failed.

**Preferences and channels**
- `notification_preferences` rows turn a channel off per (user, org, category, channel); no row means on.
- **No API or UI writes preferences**; only the seed does.
- The org-level Settings → Notifications toggles (deviceOffline, syncFailed, approvalPending, reportReady, dailyDigest) are stored but **ignored by the relay**, and there is no digest job.
- SMS, WhatsApp and Push exist only as enum values. The app sends no invitation emails; admins copy the invitation link.

---

## 9. Testing and tooling

| What | Command | Needs |
|---|---|---|
| Build packages (required first) | `pnpm build:packages` | – |
| Unit tests (packages) | `pnpm test:unit`, or `pnpm --filter @flowza/<pkg> run test` | none; database `*.db.test.ts` files excluded |
| Database integration | `pnpm test:db` (`/home/user/Flowza-Time/packages/database/vitest.db.config.ts`: `src/**/*.db.test.ts`, no file parallelism, 60 s/120 s timeouts) | Postgres on `TEST_PG_URL`, default `postgres://postgres@127.0.0.1:54329/postgres` |
| API | `pnpm --filter @flowza/api run test` | Postgres; built packages |
| Worker | `pnpm --filter @flowza/worker run test` (no file parallelism) | Postgres; `CHROMIUM_PATH` for the PDF test, otherwise skipped |
| Web components | `pnpm --filter @flowza/web run test` (vitest + jsdom, `src/test/setup.ts`, stubbed `VITE_*`; 48 test files) | none |
| End-to-end | `pnpm --filter @flowza/web run build:e2e && pnpm --filter @flowza/web run test:e2e` | Chromium (`PLAYWRIGHT_CHROMIUM_EXECUTABLE` optional) |
| RLS SQL suites | `bash /home/user/Flowza-Time/supabase/tests/run-rls-tests.sh` | Postgres |
| Local Postgres | `bash scripts/local-pg.sh start\|stop\|reset\|status` (PG 16 cluster in `~/.flowza-pg`, port 54329, database `flowza`) | – |
| Reset local database | `bash /home/user/Flowza-Time/scripts/db-reset-local.sh [--seed]` | – |
| Regenerate types | `pnpm db:types` (kysely-codegen into `packages/database/src/generated/db.ts`) | a migrated database |

- **`createTestDatabase()`** (`/home/user/Flowza-Time/packages/database/src/testing/index.ts`) creates an isolated database, applies the shim plus migrations through the ledger, sets local role passwords, and returns admin, api and worker clients.
- **API test harness** (`/home/user/Flowza-Time/apps/api/src/test/harness.ts`, `features-harness.ts`): one database per file (`createApiHarness(name)`), the real Hono app, a fake token verifier (`Bearer user:<uuid>`), in-memory realtime and storage doubles, and fixture helpers (seedOrg, seedEmployee with managerEmployeeId, seedMembership).
- **Worker test harness** (`/home/user/Flowza-Time/apps/worker/src/test/harness.ts createHarness(name, providers)`) uses the mock provider.
- **E2E suite:** Playwright against `vite preview :4173` of `dist-e2e`, with Supabase GoTrue and the API faked by `page.route` in `/home/user/Flowza-Time/apps/web/e2e/support/mock-backend.ts`. Projects: desktop Chrome and iPad Mini. Specs `auth`, `sign-up`, `workspace` — **nothing for the portal, approvals or leave**.
- **`db-reset-local.sh`** drops and recreates the database (`PGDATABASE`, default `flowza`), applies `supabase/tests/00_local_supabase_shim.sql` and every migration with psql (no ledger), sets passwords `flowza_api` / `flowza_worker`, and with `--seed` runs the TypeScript seed (Al Bahja, 500 employees).
- **`run-rls-tests.sh`** resets `flowza_test`, runs `rls_isolation.sql` as postgres and `rls_system_context.sql` as `flowza_worker`.
- **No test needs Supabase Auth or the Supabase CLI.** The shim fakes the auth schema, roles, storage and realtime tables.
- **CI** (`/home/user/Flowza-Time/.github/workflows/ci.yml`):
  - `quality`: install, build:packages, lint, apps typecheck, test:unit, web tests, apps build.
  - `database` (postgres:16 service on 54329): RLS suites; re-apply migrations to `flowza_ci2`; `db:types` plus a `git diff --exit-code` on the generated types; test:db; API tests; Chromium for the PDF test; worker tests.
  - `e2e`, `security` (pnpm audit, gitleaks) and `images` (docker builds of API and worker, no push).

---

## 10. Deployment

**Fly.io apps** (all region `sin`)

| App | Config | Setup | Notes |
|---|---|---|---|
| `flowza-time-api` | `/home/user/Flowza-Time/fly.api.toml` | 1 machine, shared-cpu-1x, 512 MB, min 1 running, health check `/api/health` | Env: `API_PUBLIC_URL=https://time-api.flowza.ai`, `WEB_ORIGINS=https://time.flowza.ai`, `SUPABASE_URL=https://liyilmbklsextsggflbb.supabase.co`, publishable key, `DATABASE_POOL_MAX=10`, `TRUST_PROXY`, `CLIENT_IP_HEADER=cf-connecting-ip`, `TRUSTED_PROXY_HOPS=2`. Secrets: `DATABASE_URL_API`, `FLOWZA_CREDENTIALS_MASTER_KEYS`, `FLOWZA_DEVICE_PUSH_SECRET`, `EDGE_SHARED_SECRET`, optional `SUPABASE_SERVICE_ROLE_KEY`. Must stay a single machine: rate limiting and idempotency are in memory. |
| `flowza-time-worker` | `/home/user/Flowza-Time/fly.worker.toml` | 1 machine, 512 MB | `WORKER_QUEUES=sync,processing,notifications,maintenance`, scheduler on, `EMAIL_PROVIDER=resend`, `EMAIL_FROM=no-reply@time.flowza.ai`. Secrets: `DATABASE_URL_WORKER` (session pooler 5432, needed for the advisory-lock leader election), master keys, `RESEND_API_KEY`. |
| `flowza-time-reports` | `/home/user/Flowza-Time/fly.reports.toml` | 1 GB, built with `WITH_CHROMIUM=1` | Queue `reports` only, scheduler off. |

**Web and deploy pipeline**
- **Cloudflare Pages:** `/home/user/Flowza-Time/wrangler.toml` sets project `flowza-time-prd` and `pages_build_output_dir = "apps/web/dist"`; the build command (`pnpm build:web`) is set in the dashboard.
- **`/home/user/Flowza-Time/apps/web/.env.production`:** `VITE_SUPABASE_URL=https://liyilmbklsextsggflbb.supabase.co`, `VITE_SUPABASE_ANON_KEY=sb_publishable_…`, `VITE_API_URL=https://time-api.flowza.ai`.
- **`/home/user/Flowza-Time/.github/workflows/deploy.yml`** is manual only (target both, api, worker or reports). It runs flyctl deploy and a readiness probe against `https://time-api.flowza.ai/api/ready`. **It does not run migrations.** There is no staging environment.

**`/home/user/Flowza-Time/docs/go-live.md`**
- At the time it was written: database `liyilmbklsextsggflbb` (ap-south-1 Mumbai, Postgres 17) provisioned and migrated; web live at `time.flowza.ai`; API and worker not yet deployed; role passwords unset; no users or orgs.
- The runbook: secrets, role passwords, deploy the API, lock the origin with `EDGE_SHARED_SECRET`, deploy the worker, deploy the reports worker, point the web app at the API, auth URLs plus the password-verification hook, custom SMTP through Resend, platform admin `dev@flowza.ai`, first organisation.
- Its "still not done" list: hardware-unproven providers; zero-touch device claiming trusts the serial number; worker email left on console until the key is set; no invitation email; realtime and signed URLs inert without the service key; no monitoring. The suggested `time-push.flowza.ai` (plain-HTTP device ingress) is not built.
- The demo-tenant seeds README implies the hosted org `27bfe270-…` with 8 logins is now in use.

**Migrations to the hosted database**
- `/home/user/Flowza-Time/packages/database/src/tools/migrate.ts` (`pnpm db:migrate:local`, `DATABASE_URL_ADMIN`, flags `--shim/--local/--reset`) keeps its own ledger in **`app.migrations(name, applied_at)`** and wraps each file in one transaction. It is meant for local, CI and tests.
- The docs (`docs/database.md`, `docs/deployment.md`, `docs/blueprint.md`) say hosted projects use **`supabase db push`** (with `supabase/config.toml`, which tracks its own history table), "from CI". No workflow does this, and the repo does not record how production was migrated. Whether `20260927000100_employee_self_service.sql` is live is not verifiable from the repo; checking the hosted migration history is the way to confirm.
- Because every file runs inside one transaction, `CREATE INDEX CONCURRENTLY` (an AGENTS.md rule for hot tables) cannot go through `migrate.ts` as written.
- `supabase/config.toml` sets the local pooler port to 54329, which clashes with the `local-pg.sh` port if `supabase start` is ever used.

---

## Defects and inconsistencies noticed along the way

- **Dead missing-punch counters.** The dashboard (`/home/user/Flowza-Time/apps/api/src/services/dashboard.service.ts`, about lines 31/55/113) and the daily view's MISSING_PUNCH card count `status = 'MISSING_PUNCH'`, which the engine never emits (it emits MISSING_IN/MISSING_OUT flags). They read 0 in practice.
- **Default shift is ignored.** `settings.attendance.defaultShiftId` is saved but never read by `load-inputs.ts`.
- **Notification settings are ignored.** Settings → Notifications toggles are never read.
- **Wrong job link.** `/home/user/Flowza-Time/apps/web/src/features/attendance/components/recalculations-tab.tsx:40` links `/sync/<queue job id>`, the pitfall AGENTS.md warns about.
- **Employee link lost on invitation.** For an invitee with no account yet, `employeeId` is dropped: `invitations` has no employee_id and `acceptInvitation` does not set one (`/home/user/Flowza-Time/apps/api/src/services/members.service.ts:128-137,189`). HR has to link the employee afterwards through member edit.
- **Manager approvers are poorly served:**
  - The `/approvals` route and sidebar require attendance.approve.
  - The inbox needs attendance.view under RLS.
  - Notifications go to attendance.approve holders, not the resolved approver.
  - Nothing is emitted when a request moves to the next step.
- **Two parallel user↔employee links.** `employees.user_id` and `org_memberships.employee_id` both exist; only the latter is used.
- **Unused workflow entity types.** The editor lets you save workflows for OVERTIME, MISSING_PUNCH, SHIFT_CHANGE, MANUAL_ATTENDANCE and LEAVE, but nothing consumes them.
- **Unenforced permissions.** `notification.manage` and `report.export` are not checked anywhere.
- **Portal not behind its flag.** The `employee_self_service` flag is unused, so the portal is always available.
- **Unused attachment column.** `attendance_corrections.attachment_path` is never read or written.
- **Outbox never pruned.** `domain_events` grows forever.

---

## Gap list against a full HR attendance suite

- **Manager hierarchy:** only a direct `manager_employee_id`. No hierarchy traversal, no skip-level, no "my team" data scope (RLS scopes by branch only), no team/department-manager semantics, no manager portal or team dashboard.
- **Approval engine:**
  - Corrections only; leave uses a separate one-step HR PATCH.
  - Sequential only, at most 5 steps, one approver per step, role matched by id.
  - No parallel or quorum steps, conditions or thresholds, delegation or out-of-office, escalation, SLA or reminders, or re-routing after org changes.
  - No request detail or history endpoint, no "my requests" view.
  - Approval notifications are not targeted.
- **No other request types:** overtime pre/post approval, missing-punch regularisation, shift change or swap, manual attendance, WFH/on-duty/field work, permission or short leave, comp-off.
- **Employee check-in:** no web/mobile punch, geofencing (branch coordinates and radius unused), selfie or face capture, device/IP binding, or offline PWA.
- **Day notes:** no per-day comments or regularisation on daily records, and no attachments on corrections or leave.
- **Leave management:** no accruals, carry-over, per-employee entitlements, blackout dates, team-overlap checks, attachments (for example medical notes), or leave encashment. Balances are advisory only.
- **Scheduling:** no roster or rota planner, employee shift view, shift swaps, or split shifts. `defaultShiftId` is not applied. There is no night-shift overtime category or night differential.
- **Roles:** one role per membership. There is no built-in "manager" role distinct from branch_manager, and new permissions are not granted to custom roles automatically.
- **Integration:** no public API or API-key authentication, no generic punch-ingest endpoint (every source must be a "device"), no outbound webhooks (and the stored secret is only a hash), and no HRMS/payroll export or connector (the payroll_summary report is only planned). The outbox is the natural hook for outbound sync.
- **Reports:** no scheduling, emailed delivery or recurring distribution. Six report types are planned but not implemented (overtime, branch, department, payroll summary, device sync, device health).
- **Notifications:** no preferences UI or API; org toggles are ignored; no digest; no SMS, WhatsApp or push; no invitation emails; no approval reminders.
- **Payroll:** summaries and finalisation work, but there is no export file or integration and no pay-code mapping beyond the report codes.
- **Test coverage:** no e2e tests for portal, approvals or leave flows, and no full-stack e2e against Supabase.
- **Operations:** single API machine (in-memory rate limiting and idempotency), no staging environment, migrations not wired into CI/CD, no monitoring.
