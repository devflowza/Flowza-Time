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
| `0900_jobs_queue` | `jobs.queue`, archive, `enqueue`, fair `dequeue`, `complete`, `fail` (backoff/dead-letter), `cancel`, `reap_stale`, `stats` |
| `1000_shifts_rules_holidays_leave` | shifts, shift_patterns, shift_assignments, attendance_rule_sets, holiday_calendars, holidays, leave_types, leave_records |
| `1100_attendance` | attendance_raw_transactions (partitioned, immutable), attendance_events (partitioned, void-only), attendance_daily_records, history, approval_workflows/requests/steps, attendance_corrections, recalculation_requests, period_locks (+ trigger), period_summaries |
| `1200_reports_imports_notifications_audit` | report_requests, import_jobs(+rows), notifications(+preferences, deliveries), `audit.logs` |
| `1300_subscriptions_flags_events_retention` | plans, subscriptions, entitlements, usage_records, feature_flags, organization_feature_flags, api_keys, domain_events (outbox), outbound_webhook_subscriptions, data_retention_policies |
| `1400_rls_policies` | grants, RLS on every table, generated + bespoke policies, safety net that fails if any table lacks RLS |
| `1500_storage_realtime` | buckets, storage.objects policies by path prefix, realtime.messages channel authorisation |
| `1600_reference_data` | permissions vocabulary, system roles + permission matrix, device providers/models, plans, feature flags |
| `1700_secrets_functions` | `secrets.get/put/delete/masked_device_credentials` |
| `1800_auth_hooks` | Supabase Auth password-verification hook → login_history |

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
supabase db push                        # apply to a linked hosted project (CI, never by hand in production)
```
