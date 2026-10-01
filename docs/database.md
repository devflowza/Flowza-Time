# Database

Postgres 16/17 on Supabase. Schema is defined exclusively by `supabase/migrations/*.sql` (applied in filename order).
Local development and CI run the same files on a plain Postgres after `supabase/tests/00_local_supabase_shim.sql`
recreates the Supabase-provided pieces (auth/storage/realtime schemas, roles). Never edit a hosted schema by hand.

## Schemas

| Schema | Purpose |
|---|---|
| `public` | Tenant and platform data (72 tables) |
| `app` | Authorization helpers used by RLS, utilities, partition maintenance, migration ledger (`app.migrations`, local/CI only) |
| `jobs` | Background job queue (`jobs.queue`, `jobs.queue_archive`, dequeue/complete/fail functions) |
| `audit` | Append-only audit log (`audit.logs`) |
| `secrets` | Controlled access functions for encrypted device credentials |

## Migrations

| File | Contents |
|---|---|
| `0100_extensions_schemas_roles` | pgcrypto/citext/pg_trgm/btree_gist, schemas, roles `flowza_system` (nologin), `flowza_api`, `flowza_worker` (login), trigger helpers |
| `0300_tenancy_and_access` | organizations, organization_settings, user_profiles, platform_admins, platform_access_grants, permissions, roles, role_permissions, org_memberships, invitations, login_history |
| `0400_org_structure` | branches, membership_branches, departments, designations, teams |
| `0500_authorization_functions` | `app.*` helpers and the policy generators `app.apply_tenant_policies` / `app.apply_readonly_tenant_policies` |
| `0600_employees` | employees, team_members, employment_history (effective-dated, exclusion constraint), employee_identity_documents, employee_provider_identities |
| `0700_devices` | device_providers, device_models, devices, device_credentials, pending_devices, device_groups(+members), device_employee_states, device_commands, device_logs (partitioned), `app.ensure_month_partitions` |
| `0800_sync_engine` | sync_jobs, sync_job_items, sync_attempts, sync_cursors, sync_logs (partitioned), provider_webhook_events |
| `0900_jobs_queue` | `jobs.queue`, archive, `enqueue`, fair `dequeue`, `complete`, `fail` (backoff/dead-letter), `cancel`, `reap_stale`, `stats` (lock heartbeat and owned outcomes: `20260929000700`) |
| `1000_shifts_rules_holidays_leave` | shifts, shift_patterns, shift_assignments, attendance_rule_sets, holiday_calendars, holidays, leave_types, leave_records |
| `1100_attendance` | attendance_raw_transactions (partitioned, immutable), attendance_events (partitioned, void-only), attendance_daily_records, history, approval_workflows/requests/steps, attendance_corrections, recalculation_requests, period_locks (+ trigger), period_summaries |
| `1200_reports_imports_notifications_audit` | report_requests, import_jobs(+rows), notifications(+preferences, deliveries), `audit.logs` |
| `1300_subscriptions_flags_events_retention` | plans, subscriptions, entitlements, usage_records, feature_flags, organization_feature_flags, api_keys, domain_events (outbox), outbound_webhook_subscriptions, data_retention_policies |
| `1400_rls_policies` | grants, RLS on every table, generated + bespoke policies, safety net that fails if any table lacks RLS |
| `1500_storage_realtime` | buckets, storage.objects policies by path prefix, realtime.messages channel authorisation |
| `1600_reference_data` | permissions vocabulary, system roles + permission matrix, device providers/models, plans, feature flags |
| `1700_secrets_functions` | `secrets.get/put/delete/masked_device_credentials` |
| `1800_auth_hooks` | Supabase Auth password-verification hook → login_history |
| `20260909000100_reports_settings_leave_present` | `organization_settings.reports` group; `leave_types.treat_as_present` |
| `20260909000200_dashboard_settings` | `organization_settings.dashboard` group (tenant dashboard style, layout and options) |
| `20260909000300_principal_snapshot` | `app.principal_snapshot(user_id)`: the request principal in one round trip (see *Request principal*) |
| `20260927000100_employee_self_service` | Employee portal (`/my`): `leave.request` and `attendance.request_correction` for every system role |
| `20260928000100_roles_manager_and_permissions` | HR portal P1: 13 permission keys (self-service check-in / notes / shift swaps, team visibility, HR oversight, geofences, overtime, leave approval split from `leave.manage`, approval configuration + delegation, report schedules, integrations); system roles `manager` (Line Manager) and `auditor` (read-only); `employees.secondary_manager_employee_id`; team-scoped RLS |
| `20260928000150_p1_review_fixes` | P1 review: `employee.view_team` (own record + direct reports) and consistent role supersets |
| `20260928000200_approval_engine_v2` | P2: approver types SECONDARY_MANAGER / MANAGER_CHAIN / HR_ADMIN / DEPARTMENT_HEAD / BRANCH_MANAGER, new approval entities, INVALIDATED / SKIPPED; approval_step_actors, approval_delegations, approval_request_events (timeline), approval_email_tokens, approval_digest_runs |
| `20260928000300_attendance_policy_parity` | P3: `attendance_day_marks` (UNEXCUSED / EXCUSED / LOP / PAY_EFFECT, revoked never deleted); `lop_days` and related columns on `attendance_period_summaries`; nested attendance policy groups in `organization_settings.attendance` |
| `20260928000400_finance_connector` | P9: `flowza_finance` provider (pull from Finance `attendance-export`, push to `attendance-ingest`) and `finance_sync_state` |
| `20260928000450_finance_connector_fixes` | P9 review: `syncFrom`; `finance_pushed_events` push ledger |
| `20260928000500_portal_attendance_self_service` | P4: raw source SELF_SERVICE on a per-organisation virtual device; geofences (+ assignments), attendance_notes (late / absence reasons), attendance_regularisation_requests, selfie_checkins, shift_swap_requests, employee_attendance_grants |
| `20260928000600_hr_attendance_workspace` | P6a: report_schedules and report_deliveries |
| `20260928000690_leave_v2_enum` | P7, part 1: leave status INFO_REQUESTED (its own transaction; a new enum value cannot be used where it is added) |
| `20260928000700_leave_v2` | P7, part 2: leave-type policy (approval, count mode, notice, gender, accrual, carry-forward, half day, portal visibility, `system_key` COMP_OFF); leave_allocations, comp_off_credits, comp_off_usages, leave_request_comments |
| `20260928000800_approval_engine_v2_review_fixes` | P2 review: organisation-local dates (`app.org_date_at`, `app.org_today`) shared by RLS, the inbox and the engine |
| `20260928000820_hr_workspace_review_fixes` | P6a review: report files readable only within the reader's report scope (storage policies) |
| `20260928000840_portal_attendance_review_fixes` | P4 review: branch-scoped writes of geofences and their assignments |
| `20260928000850_leave_v2_review_fixes` | P7 review: nobody writes their own leave, comp-off or allocation rows from a client session; `leave_types.applicable_employment_types`; leave_year_closes |
| `20260928000900_manager_workspace` | P5 + P6b: invitations gain soft revocation, the resend chain and hashed e-mailed tokens |
| `20260928000950_manager_workspace_review_fixes` | P5 review: one definition of "waiting for you" (`app.approval_actionable_request_ids`) |
| `20260928001000_notifications_v2` | P8: notification categories LEAVE / REPORTS, `notifications.in_app`, delivery back-off, retention indexes, missing_punch_reminders, own-row preferences |
| `20260928001050_notifications_review_fixes` | P8 review: the outbox (`domain_events`) is written by the services only |
| `20260928001100_security_gate` | P10: partitions locked; `flowza_client` role; `_no_data_api` restrictive policies (no table access through PostgREST); FORCE RLS on tenant tables; immutable `organization_id`; explicit denials on system-written tables. Pinned by `supabase/tests/rls_invariants.sql` |
| `20260928001110_security_gate_queue_indexes` | P10: indexes for the queue reads measured at a year of volume |
| `20260928001120_platform_grant_approval` | P10: a platform write access grant starts only when its named second approver approves it |
| `20260929000100_hikvision_push_provider` | Hikvision ISAPI event push provider (`hikvision_push`, real-time punches over HTTP Listening) and MinMoe model rows |
| `20260929000200_device_provider_adapters` | Seven placeholder providers become real adapters (`beta`): provider and model rows mirroring `packages/device-providers` |
| `20260929000300_invitation_delivery_status` | Invitation e-mail delivery status, retries and manual retry |
| `20260929000400_super_admin_portal` | `/adm` portal: platform-only tenant accounts and notes, fleet counts and memberships read models, platform admins' own audit entries |
| `20260929000500_device_pin_mappings` | Device PIN mappings a person made survive device syncs (`device_employee_states` marked as manual) |
| `20260929000600_modules_plans_billing` | Modules, plans & pricing, billing (`/adm` parity): module catalogue, per-plan modules and users, per-tenant module overrides and the one enabled-module rule, subscription cycle and seats, billing invoices and payments, platform settings — see `docs/pricing.md` |
| `20260929000700_job_lock_heartbeat` | Job queue: `heartbeat`, `complete_owned` / `fail_owned` / `release_owned` (outcomes only while the worker still holds the same attempt), `reap_stale` dead-letters a job whose attempts are spent, dedupe-safe requeueing, EXECUTE revoked from PUBLIC and a fixed `search_path` on every queue function |
| `20261001000300_user_limit` | User limit: `app.org_user_limits(uuid[])` — licensed users in use (active employees) and the effective limit (`entitlements` override › `subscriptions.seats` › plan `limits.employees`), counts only, for platform admins and the organisation's own system context — see `docs/pricing.md` |

Hosted project `liyilmbklsextsggflbb`: every migration above is applied (PR #65's 21 on 2026-09-29,
each verified against its file by md5, see `docs/hr-portal/reports/12-ship.md` §1, which also records the later ones and the
ones missing from `app.migrations`); `20260929000700` was applied on 2026-09-30, byte-identical to its file.

## Conventions

- `uuid` PKs (`gen_random_uuid()`), `timestamptz` (UTC) everywhere, `created_at`/`updated_at` via `app.set_updated_at()`.
- `organization_id` is present (and indexed first) on every tenant table, even when derivable via a parent.
- Composite FKs carry `organization_id` (`(branch_id, organization_id) → branches(id, organization_id)`) so a buggy
  service cannot link rows across tenants.
- Effective-dated tables (`employment_history`, `shift_assignments`, `attendance_rule_sets`, `attendance_period_locks`)
  use GiST exclusion constraints to forbid overlaps.
- Closed vocabularies are Postgres enums mirrored in `@flowza/contracts` (`packages/contracts/src/enums.ts`).
- Partitioned tables (`attendance_raw_transactions`, `attendance_events`, `device_logs`, `sync_logs`) are monthly range
  partitions with a `_default` partition; `app.ensure_month_partitions(table, from, months)` is called by the worker's
  maintenance task. Privileges are granted on the parent only, so partitions cannot be read directly.
- Append-only protection triggers: `attendance_raw_transactions` (source columns immutable), `attendance_events`
  (void-only), `audit.logs`, `attendance_daily_record_history`, `login_history`.
- Period lock trigger: `attendance_daily_records` inside a locked period reject changes unless the session set
  `flowza.bypass_period_lock = on` (only the unlock/recalculation jobs do).

## Request principal

`app.principal_snapshot(user_id)` (migration 20260909000300) returns the caller's profile, memberships, permissions,
branch scope, platform grants and MFA-required organisations as one jsonb document. The API calls it once per
request, outside any transaction, instead of assembling the same data with up to ten statements under RLS — each of
which is a round trip between the API's region and the database's. It is SECURITY DEFINER and executable only by
`flowza_api`; the argument is always the subject of a verified JWT.

## Job queue (`jobs` schema)

`jobs.dequeue(worker, queues[], limit, per_org_cap)` selects pending jobs ordered by *running jobs of that organisation
(asc)*, priority (desc), run_at (asc) with `FOR UPDATE SKIP LOCKED`, skipping organisations at the cap. `jobs.fail`
re-schedules with exponential backoff (30s·2^attempt, ±20% jitter, max 30 min) or dead-letters after `max_attempts`
(or immediately when `retry_after_seconds = -1`). Completed/dead/cancelled rows move to `jobs.queue_archive`.

## Generated types

`packages/database/src/generated/db.ts` is produced by `pnpm db:types` (kysely-codegen against a migrated database) and
checked in; CI fails if it is stale.

## Local workflow

```bash
bash scripts/local-pg.sh start          # native Postgres 16 on :54329 (no Docker needed)
bash scripts/db-reset-local.sh          # shim + all migrations into database `flowza`
bash supabase/tests/run-rls-tests.sh    # RLS suites (fresh database flowza_test)
pnpm test:db                            # Kysely integration tests
supabase start && supabase db reset     # full Supabase stack when Docker is available
DATABASE_URL_ADMIN=… bash scripts/db-migrate-hosted.sh --check   # what production lacks (the Deploy workflow applies it)
```
