# FlowZa Time — Product + Architecture Blueprint

**Product:** FlowZa Time (F & Z Capital) — cloud Employee Attendance & Workforce Time Management SaaS
**Launch market:** Oman · **Expansion:** UAE, Saudi Arabia, Qatar, Kuwait, Bahrain, wider Middle East
**Status:** Blueprint v1 (pre-implementation). ADRs live in `docs/adr/`. Detailed module docs live in `docs/*.md`.

This document is the analysis requested in §131 of the master requirements: sections A–N. It records
the decisions, the alternatives that were rejected, and the reasons. Where the requirements themselves
created technical debt, the blueprint says so and proposes a different path (see §N and the ADRs).

---

## A. Product Blueprint

### A.1 What the product is

FlowZa Time turns punches from many kinds of attendance machines into explainable, payroll-ready
attendance for multi-branch organisations in the GCC. It is sold to HR/Admin teams, not to device
technicians. The hard problems it solves for the customer are:

1. **Devices are heterogeneous and unreliable.** A customer has ZKTeco at HQ, Hikvision at a site, an
   eSSL unit in a warehouse. FlowZa presents one device inventory, one sync engine, one health view.
2. **Employees must exist on devices.** HR creates an employee once; FlowZa pushes them to the right
   devices and shows exactly which devices succeeded, failed or were offline.
3. **Attendance must be explainable.** Every final number (late minutes, overtime) can be traced back to
   raw device punches, the shift that applied, the rule set in force that day, and any correction with
   who/why/approved-by.
4. **Payroll needs a clean feed.** A locked, versioned period summary per employee is the product's
   output boundary. FlowZa is not payroll and does not become payroll.

### A.2 Modules

| Module | Purpose | MVP? |
|---|---|---|
| **Platform Admin** | Organisations, subscriptions/plans, providers & compatibility matrix, feature flags, platform health, reason-based privileged access | Partial (org/subscription/flags/providers) |
| **Organisation & Tenancy** | Org profile, regional settings (country, timezone, currency, locale, calendar), settings groups, status | Yes |
| **Identity & Access** | Supabase Auth, invitations, memberships, roles/permissions, branch scoping, login history, MFA-ready | Yes |
| **Org Structure** | Branches (timezone, GPS, holidays, weekly off), departments (tree), designations, teams | Yes |
| **Employee Master** | Employees, effective-dated employment history, identity documents (restricted), photos, import/export, bulk actions | Yes |
| **Device Management** | Providers, models, devices, credentials (encrypted), groups/tags, health, logs, capability-aware actions, device-push endpoints | Yes |
| **Sync Engine** | Jobs, items, attempts, cursors, logs; scheduler; fair queue; webhooks ingestion; employee↔device state; reconciliation | Yes |
| **Attendance** | Raw transactions → events → daily records; rules (effective-dated); shifts (fixed/flexible/overnight/rotational); holidays; leave boundary; corrections; approvals; recalculation; period lock; payroll summaries | Yes |
| **Reporting** | Async report generation to Storage; CSV/XLSX/PDF; audited exports | Yes (core reports) |
| **Notifications** | In-app centre + email; preferences; domain-event driven | Yes (in-app + email) |
| **Audit** | Append-only audit log for all sensitive actions; viewer; export | Yes |
| **Subscription & Usage** | Plans, subscriptions, entitlements, usage metering, limit enforcement | Yes (enforcement), billing integration later |
| **Public API / Customer Webhooks** | API keys with scopes; outbound event subscriptions | Later (outbox designed now) |
| **Employee Self-Service / Mobile** | Own attendance, correction requests, PWA/mobile punches, geofencing | Later (data model ready) |
| **Payroll/HRMS/ERP Integrations** | Period summaries API, leave ingestion from HRMS | Later (boundary designed now) |

### A.3 Primary personas

- **HR Admin / HR User** — employees, shifts, corrections, reports.
- **Attendance Admin** — devices, sync, reconciliation, rules.
- **Branch Manager** — one or more branches only; approves corrections; views branch dashboard.
- **Organisation Owner/Admin** — users, roles, settings, subscription.
- **Payroll/Finance** — period summaries, exports; read-only on attendance.
- **Employee** (later) — own records.
- **Platform Super Admin** — tenants, plans, providers; no silent access to customer data.

### A.4 The golden path (§138) as user-visible steps

1. HR creates employee → assigned to branch → gets a device identity (auto-numbered per vendor if not supplied).
2. HR clicks **Sync to Devices** → API creates one `sync_job` with one `sync_job_item` per (employee, device) for the branch's devices → returns `jobId` immediately.
3. Workers execute items with per-org fairness and per-provider throttling → each item records SUCCESS/FAILED/OFFLINE/UNSUPPORTED with attempts → UI shows live progress via Realtime broadcast (fallback: polling).
4. Attendance arrives (vendor cloud poll, vendor webhook, or device-push protocol) → stored **unchanged** in `attendance_raw_transactions` (idempotent) → normalised into `attendance_events` (employee resolved through device identity mapping; unmatched punches are kept and flagged) → engine computes `attendance_daily_records` with a calculation trace.
5. Manager/HR see attendance, submit corrections → approval workflow → approved corrections become new events (originals never modified) → record recomputed, previous version snapshotted.
6. Month closes → period lock → `attendance_period_summaries` finalised → payroll export/API.

---

## B. Technical Architecture

### B.1 Shape: modular monolith + workers on Supabase

```
                       ┌──────────────────────────────────────────────┐
  Browser (React/Vite) │  apps/web  (Vercel / Cloudflare Pages)        │
        │ HTTPS        └──────────────────────────────────────────────┘
        ▼
  ┌──────────────────────────────┐      ┌──────────────────────────────┐
  │ apps/api  (Hono, Node 22)    │      │ apps/worker (Node 22)        │
  │ /api/v1/*  REST              │      │ scheduler (leader-elected)   │
  │ /api/health /api/ready       │      │ job consumers (N processes)  │
  │ /webhooks/providers/*        │      │ outbox relay, retention      │
  │ /device-push/<protocol>/*    │      │ report + import processors   │
  └──────────────┬───────────────┘      └──────────────┬───────────────┘
                 │ packages/domain, packages/device-providers,          │
                 │ packages/database (Kysely), packages/contracts (Zod) │
                 ▼                                                     ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ SUPABASE                                                             │
  │  Postgres (RLS on every tenant table; jobs schema = queue;           │
  │            partitioned attendance tables)                            │
  │  Auth (JWT, MFA-ready, hooks → login history)                        │
  │  Storage (tenant-scoped buckets: logos, photos, reports, imports)    │
  │  Realtime Broadcast (private per-org channels for progress/health)   │
  │  Edge Functions (auth hooks, storage/webhook glue only)              │
  └──────────────────────────────────────────────────────────────────────┘
                 ▲                                    ▲
   Vendor clouds / device APIs (pull, webhooks)       Devices posting directly
   via provider adapters in the worker                (push protocols) to apps/api
```

**Why this shape (ADR-001, ADR-006).** The requirements demand long-running, retried, throttled,
tenant-fair background work against third-party APIs, plus a versioned REST API with server-side
authorisation. Supabase Edge Functions have wall-clock limits and no durable worker model; PostgREST
exposes tables, which §49 forbids as the public contract. A small Node monolith (API) plus a worker
process, both importing the same domain packages, is the simplest architecture that satisfies §127/§128.
Supabase remains the system of record and provides Auth, RLS, Storage and Realtime — we use it for what
it is excellent at rather than fighting it.

### B.2 Layering (inside `apps/api` and `apps/worker`)

```
HTTP / Job handler  →  Application services (use-cases, authorization, transactions, audit, events)
                    →  Domain (pure TypeScript: attendance engine, sync policies, capability rules)
                    →  Infrastructure ports (repositories via Kysely, JobQueue, ProviderRegistry,
                       SecretsCipher, Mailer, RealtimePublisher, Storage)
```

- **Domain is pure** (no IO): `packages/domain`. This is where attendance rules, shift resolution,
  cross-midnight attribution, rounding, and sync retry policy live — unit-tested exhaustively.
- **Providers are plugins**: `packages/device-providers` exposes `DeviceProvider` and a registry. The
  attendance engine never imports a provider.
- **Contracts are shared**: `packages/contracts` holds Zod schemas and DTO types used by web + api.
- **Database access is typed and RLS-aware**: `packages/database` wraps Kysely and gives every unit of
  work an *execution context* (user, system-for-org, or platform-admin-with-grant) that is applied to
  the Postgres session so RLS is enforced even inside the API and worker (defence in depth, §67).

### B.3 Request lifecycle (API)

1. `requestId` assigned (or honoured from `x-request-id`), structured logger bound.
2. Bearer JWT verified against Supabase JWKS (`jose`); `sub` extracted. API keys (later) resolve to a
   principal the same way.
3. Route handler validates body/query with the shared Zod schema → application service.
4. Service opens a DB transaction, sets `role authenticated` + `request.jwt.claims` for the user, so all
   queries are RLS-filtered; the service *additionally* checks permissions explicitly (fail fast with
   `FORBIDDEN` instead of a silent empty result), records audit rows and domain events in the same
   transaction.
5. Standardised response `{ data, meta }` or error `{ code, message, requestId, details? }`.

### B.4 Job lifecycle (worker)

1. Scheduler (single leader via advisory lock) enqueues due work: attendance polls, health checks,
   reconciliation, retention, partition maintenance, outbox relay.
2. Consumers call `jobs.dequeue()` — fair across organisations (per-org running cap, least-running-first),
   priority and `run_at` ordered, `FOR UPDATE SKIP LOCKED`.
3. Handler runs with a *system-for-org* execution context (RLS-scoped to that org), uses provider adapter
   through a per-provider throttle, writes results, emits domain events.
4. Failure → exponential backoff with jitter, `max_attempts`, then **dead-letter** with reason; success →
   archived to `jobs.queue_archive`.

---

## C. Supabase Architecture

| Capability | How FlowZa uses it | Not used for |
|---|---|---|
| **Postgres** | System of record. Schemas: `public` (tenant + platform data), `app` (authorization helpers), `jobs` (queue), `audit` (append-only), `secrets` (encrypted credentials). Declarative partitioning for `attendance_raw_transactions`, `attendance_events`, `device_logs`, `sync_logs`. | Business logic in triggers (only integrity/immutability triggers). |
| **Auth** | Email/password, email verification, reset, TOTP MFA-ready. `user_profiles` mirrors `auth.users`. **Password Verification Hook** → `login_history`. Custom Access Token Hook adds a `flowza` claim with `platform_admin: bool` only (never permissions — they must not go stale in a JWT). SSO (SAML/OIDC) later via Supabase SSO. | Storing roles/permissions in JWT. |
| **RLS** | Every tenant table. One policy pattern generated by `app.apply_tenant_policies()` (§H). Roles: `authenticated` (users), `flowza_system` (worker, org-scoped by claim), `platform admin` (needs active grant). | `service_role` in application code (only migrations/ops). |
| **Storage** | Buckets `org-logos`, `employee-photos`, `reports`, `imports`, `documents`; object path prefix `organization_id/…`; policies call the same `app.*` helpers; signed URLs, short TTL. | Public buckets. |
| **Realtime** | **Broadcast** on private channels `org:{id}:sync`, `org:{id}:devices`, `user:{id}:notifications`; authorised through RLS on `realtime.messages`. Publisher = API/worker via REST. | Postgres Changes on large tables (per-row RLS cost, no fan-out control). |
| **Edge Functions** | Auth hooks (login history), optional lightweight glue (storage cleanup). Deployed with `supabase functions deploy`. | Long-running sync, provider calls, report generation (time limits). |
| **Cron (pg_cron)** | Optional production alternative to the worker's scheduler tick; not required (worker scheduler is the default so local dev needs only Postgres). | — |
| **Migrations** | `supabase/migrations/*.sql` via Supabase CLI; applied to local Postgres in tests and to hosted projects via CI (`supabase db push`). Every schema change is a migration; never manual. | — |
| **Vault** | Considered for device credentials; rejected for MVP because decryptability lives inside the database. We use app-side envelope encryption with a key outside the DB (ADR-003 §secrets). Vault remains an option for low-sensitivity config. | — |

Database roles created by migrations: `flowza_api` (login; may `SET ROLE authenticated`) and
`flowza_worker` (login; may `SET ROLE flowza_system`). Passwords are set out-of-band (never in migrations).

---

## D. Database Design

Conventions: `uuid` primary keys (`gen_random_uuid()`), `timestamptz` everywhere (UTC), `created_at`/
`updated_at` (trigger-maintained), soft-delete only where the row is referenced by history
(`employees.deleted_at`), `organization_id` **denormalised on every tenant table** (even when reachable
via a parent) so RLS never needs joins and indexes stay tenant-leading. Enumerations are Postgres enums
where the set is closed by the product (statuses), `text` + check constraint where customers extend
(codes). Every tenant table has a composite index that starts with `organization_id`.

### D.1 Domain map

```
organizations ─┬─ organization_settings (1:1, typed JSON groups)
               ├─ subscriptions ── plans            entitlements, usage_records
               ├─ organization_feature_flags        feature_flags (platform)
               ├─ org_memberships ── roles ── role_permissions ── permissions
               │        └─ membership_branches                      invitations, login_history
               ├─ branches ─┬─ departments (tree) · designations · teams/team_members
               │            └─ holiday_calendars/holidays
               ├─ employees ─┬─ employment_history (effective-dated)
               │             ├─ employee_identity_documents (restricted)
               │             ├─ employee_provider_identities (vendor numbering)
               │             └─ device_employee_states (per device: mapping + sync state)
               ├─ devices ─┬─ device_credentials (encrypted, no client access)
               │           ├─ device_group_members ── device_groups
               │           ├─ device_commands (push-protocol outbound queue)
               │           └─ device_logs (partitioned)
               ├─ sync_jobs ── sync_job_items ── sync_attempts     sync_cursors, sync_logs
               ├─ provider_webhook_events (replay protection)
               ├─ attendance_raw_transactions (partitioned, immutable)
               │      └─ attendance_events (partitioned) ── attendance_daily_records
               │                                              ├─ attendance_daily_record_history
               │                                              └─ attendance_period_summaries
               ├─ attendance_rule_sets (effective-dated) · shifts · shift_patterns · shift_assignments
               ├─ leave_types · leave_records                (integration boundary)
               ├─ attendance_corrections ── approval_requests ── approval_steps ── approval_workflows
               ├─ attendance_recalculation_requests · attendance_period_locks
               ├─ report_requests · import_jobs ── import_job_rows
               ├─ notifications · notification_preferences · notification_deliveries
               ├─ domain_events (outbox) · api_keys · outbound_webhook_subscriptions (later)
               └─ data_retention_policies
platform: user_profiles, platform_admins, platform_access_grants, device_providers, device_models,
          plans, feature_flags, permissions, audit.logs (org-scoped + platform), jobs.queue
```

### D.2 Tables (key columns, constraints)

**Tenancy & access**
- `organizations` — `company_code citext unique`, `legal_name`, `display_name`, `country_code char(2)`,
  `timezone` (IANA, checked against `pg_timezone_names`), `currency_code char(3)`, `locale`,
  `logo_path`, `contact jsonb`, `address jsonb`, `status org_status` (trial|active|suspended|closed),
  `weekly_off_days smallint[]` (0=Sun…6=Sat; Oman default `{5,6}`), `region_cell text` (residency).
- `organization_settings` — `organization_id pk`, typed JSON groups `general`, `attendance`, `sync`,
  `notifications`, `security`, `integrations` (validated by Zod in the service layer; DB `check (jsonb_typeof = 'object')`).
- `user_profiles` — `id = auth.users.id`, `email citext`, `full_name`, `avatar_path`, `locale`,
  `status`, `last_login_at`, `mfa_enrolled`.
- `platform_admins` — `user_id pk`, `level` (support|admin|owner), `status`.
- `platform_access_grants` — `platform_admin_user_id`, `organization_id`, `reason`, `access_level`
  (read|write), `granted_by`, `starts_at`, `expires_at`, `revoked_at`. Reason is mandatory.
- `roles` — `organization_id null` for system roles, `key`, `name`, `is_system`; unique `(organization_id, key)`.
- `permissions` — `key pk` (`employee.view` …), `category`, `description`. Seeded reference data.
- `role_permissions` — `(role_id, permission_key) pk`.
- `org_memberships` — `(organization_id, user_id) unique`, `role_id`, `status` (invited|active|suspended),
  `all_branches bool default true`, `employee_id null` (self-service link), `invited_by`, `joined_at`.
- `membership_branches` — `(membership_id, branch_id) pk` — scope when `all_branches=false`.
- `invitations` — `organization_id`, `email citext`, `role_id`, `token_hash`, `expires_at`, `accepted_at`.
- `login_history` — `user_id`, `event` (success|failed|logout|mfa_challenge), `ip inet`, `user_agent`, `at`.

**Org structure**
- `branches` — `code citext`, unique `(organization_id, code)`; `timezone`, `country_code`, `city`,
  `address jsonb`, `latitude/longitude numeric(9,6)`, `geofence_radius_m`, `contact jsonb`, `status`,
  `weekly_off_days smallint[] null` (override), `holiday_calendar_id null`.
- `departments` — `parent_id` self-FK, `branch_id null` (org-wide when null), `code`, unique
  `(organization_id, code)`, `manager_employee_id`.
- `designations`, `teams` (`branch_id null`, `lead_employee_id`), `team_members` (`(team_id, employee_id)`).

**Employees**
- `employees` — `employee_number citext`, unique `(organization_id, employee_number)`; names,
  `display_name`, `photo_path`, `gender`, `date_of_birth`, `nationality_code`, `email citext`, `phone`,
  `joining_date`, `exit_date`, `employment_status` (active|on_leave|suspended|terminated|resigned),
  `employment_type`, current `branch_id`, `department_id`, `designation_id`, `manager_employee_id`,
  `user_id null` (self-service), `device_user_id text` (default vendor-neutral identity, unique per org),
  `card_number`, `pin_hash`, `fingerprint_enrolled`, `face_enrolled`, `weekly_off_days null`,
  `custom_fields jsonb`, `search tsvector generated`, `deleted_at`. Check: `exit_date >= joining_date`.
- `employment_history` — effective-dated snapshot of branch/department/designation/manager/type/status:
  `effective_from date`, `effective_to date null`, exclusion constraint
  `EXCLUDE USING gist (employee_id WITH =, daterange(effective_from, effective_to, '[)') WITH &&)`.
  The service writes the current row **and** closes/opens history in one transaction.
- `employee_identity_documents` — `type` (civil_id|passport|labour_card|visa|other), `number`,
  `issued_at`, `expires_at`, `file_path`; separate table so `employee.view_sensitive` can gate it.
- `employee_provider_identities` — `(organization_id, employee_id, provider_key)` unique,
  `device_user_id`, `card_number`; also unique `(organization_id, provider_key, device_user_id)` so two
  employees can never share a vendor user id.
- `device_employee_states` — `(device_id, employee_id)` unique and `(device_id, device_user_id)` unique;
  `cloud_hash`, `device_hash`, `sync_status` (PENDING|IN_SYNC|OUT_OF_SYNC|FAILED|OFFLINE|UNSUPPORTED|
  REMOVING|REMOVED), `last_sync_at`, `last_success_at`, `last_error`, `fingerprint_count`, `face_enrolled`.

**Devices**
- `device_providers` — `key pk` (`mock`, `zkteco_push`, `zkteco_biotime`, `hikvision_isapi` …), `vendor`,
  `name`, `integration_type` (VENDOR_CLOUD_PULL|VENDOR_WEBHOOK|DEVICE_PUSH|ON_PREM_SERVER_API|LAN),
  `status` (available|beta|placeholder|deprecated), `capabilities jsonb`, `config_schema jsonb`
  (drives the registration form; marks secret fields), `verification_status`, `docs_url`.
- `device_models` — `provider_key`, `vendor`, `model`, `family`, `capabilities jsonb`,
  `verification` (VERIFIED|REPORTED|UNVERIFIED), `notes`.
- `devices` — `code citext` unique per org, `name`, `branch_id`, `provider_key`, `model_id null`,
  `manufacturer`, `model_name`, `serial_number` (unique per provider when present), `vendor_device_id`,
  `timezone`, `integration_type`, `endpoint_url`, `config jsonb` (non-secret), `capabilities jsonb`
  (effective = provider ∩ model ∩ discovered), `status` (active|disabled|decommissioned),
  `connection_status` (unknown|online|offline|degraded|error), `last_heartbeat_at`,
  `last_attendance_sync_at`, `last_employee_sync_at`, `last_successful_communication_at`, `last_error`,
  `firmware_version`, `offline_threshold_minutes`, `auto_sync_enabled`, `sync_interval_minutes`,
  `next_attendance_sync_at`, `push_token_hash` (device-push auth), `tags text[]`.
- `device_credentials` — `device_id pk`, `ciphertext bytea`, `key_id`, `nonce`, `masked jsonb`,
  `version`, `rotated_at`, `updated_by`. **No RLS policy for `authenticated`** → invisible to clients.
  Read/write only through `secrets.get_device_credentials()` / `secrets.put_device_credentials()`
  (security definer, callable by `flowza_system` and by API in *system* context after explicit
  `device.manage` check). Every change writes `audit.logs` with `action=device.credentials_changed`.
- `device_groups`, `device_group_members`.
- `device_commands` — for push-protocol devices that poll for work: `command_type`, `payload`,
  `status` (pending|sent|acked|failed|expired), `sync_job_item_id`, `sent_at`, `acked_at`, `result`.
- `device_logs` (partitioned monthly by `created_at`) — `level`, `event`, `message`, `details`, `job_id`.

**Sync engine**
- `sync_jobs` — `job_type` (PULL_ATTENDANCE|PULL_EMPLOYEES|PUSH_EMPLOYEE|PUSH_EMPLOYEES|
  DEVICE_HEALTH_CHECK|RECONCILIATION|TEST_CONNECTION), `trigger` (MANUAL|SCHEDULED|WEBHOOK|SYSTEM),
  `scope jsonb` (device_ids/branch_id/employee_ids/all), `status` (PENDING|QUEUED|RUNNING|SUCCESS|
  PARTIAL_SUCCESS|FAILED|RETRYING|CANCELLED), `priority`, counters `items_total/success/failed/pending/
  offline/unsupported`, `requested_by`, `correlation_id`, `parent_job_id`, `started_at`, `finished_at`, `error`.
- `sync_job_items` — `device_id`, `employee_id null`, `operation`, `status`, `attempts`, `next_attempt_at`,
  `last_error_code`, `last_error`, `result jsonb`, `started_at`, `finished_at`.
- `sync_attempts` — `sync_job_item_id`, `attempt_no`, `status`, `error_code`, `error_message`,
  `duration_ms`, `response_meta jsonb`, `started_at`, `finished_at`.
- `sync_cursors` — `(device_id, stream)` unique, `cursor jsonb`, `last_transaction_at`, `updated_at`.
- `sync_logs` (partitioned monthly) — structured log lines tied to `job_id`/`item_id`/`device_id`.
- `provider_webhook_events` — unique `(provider_key, event_id)` and unique `(provider_key, payload_hash)`;
  `signature_valid`, `status` (received|queued|processed|rejected|duplicate), `received_at`.
- `jobs.queue` — generic work queue (see §F): `queue_name`, `job_type`, `organization_id`, `payload`,
  `priority`, `status` (pending|running|completed|failed|dead), `run_at`, `attempts`, `max_attempts`,
  `locked_at`, `locked_by`, `dedupe_key unique (partial, while pending/running)`, `last_error`.
  `jobs.queue_archive` receives completed/dead rows.

**Attendance**
- `attendance_raw_transactions` (**partitioned by month on `punched_at`**, append-only) — `device_id`,
  `provider_key`, `provider_transaction_id text null`, `device_employee_id text`, `punched_at`,
  `device_local_time text` (as sent), `verification_method`, `direction`, `raw_payload jsonb`,
  `received_at`, `source` (POLL|WEBHOOK|DEVICE_PUSH|IMPORT|MANUAL), `sync_job_id`,
  `dedupe_hash text` = sha256(device_id|device_employee_id|punched_at|verification|direction),
  `processing_status` (pending|normalized|unmatched|ignored|error), `employee_id null` (resolved).
  Unique `(organization_id, device_id, provider_transaction_id, punched_at)` where id not null;
  unique `(organization_id, device_id, dedupe_hash, punched_at)` — the fallback when the vendor gives no
  id (§22). `UPDATE`/`DELETE` blocked by trigger except `processing_status`/`employee_id`.
- `attendance_events` (**partitioned by month on `punched_at`**) — `employee_id`, `branch_id`,
  `device_id null`, `raw_transaction_id null`, `source` (DEVICE|MANUAL|CORRECTION|IMPORT|MOBILE),
  `event_type` (PUNCH|PUNCH_IN|PUNCH_OUT|BREAK_START|BREAK_END), `punched_at`, `verification_method`,
  `correction_id null`, `voided_at null`, `voided_by_correction_id null`. Events are never deleted;
  corrections void and add.
- `attendance_daily_records` — unique `(organization_id, employee_id, attendance_date)`; `branch_id`,
  `shift_id`, `shift_assignment_id`, `rule_set_id`, `timezone`, `expected_start_at`, `expected_end_at`,
  `first_in_at`, `last_out_at`, `worked_minutes`, `break_minutes`, `late_minutes`,
  `early_departure_minutes`, `overtime_minutes`, `status` (PRESENT|ABSENT|LEAVE|HOLIDAY|WEEKLY_OFF|
  HALF_DAY|MISSING_PUNCH|NOT_JOINED|EXITED), `flags text[]` (LATE, EARLY_DEPARTURE, OVERTIME,
  MISSING_IN, MISSING_OUT, MANUAL_CORRECTION, OUT_OF_WINDOW…), `punch_count`, `calculation_version`,
  `engine_version`, `trace jsonb`, `computed_at`, `locked_at`.
- `attendance_daily_record_history` — append-only snapshot per recompute with `reason`.
- `attendance_rule_sets` — effective-dated (`effective_from`, `effective_to`, exclusion per org+scope),
  optional `branch_id` scope: grace, late threshold, early threshold, minimum full-day minutes,
  half-day threshold, overtime start offset, minimum overtime block, rounding (in/out/total, interval,
  mode), punch interpretation (FIRST_LAST|PAIRED|DIRECTIONAL), duplicate-punch window, missing-punch
  behaviour, auto-absent, working-hours cap, Ramadan mode overrides.
- `shifts` — `type` (FIXED|FLEXIBLE), `start_time`, `end_time`, `crosses_midnight` (generated),
  `required_minutes`, `core_start`, `core_end`, `breaks jsonb`, `punch_in_window_before_minutes`,
  `punch_out_window_after_minutes`, `grace_in_minutes null`, `grace_out_minutes null`, `color`.
- `shift_patterns` — rotational: `cycle_length_days`, `sequence jsonb` (`[{day:0, shift_id}|{day:3, off:true}]`),
  `anchor_date`.
- `shift_assignments` — `target_type` (ORGANIZATION|BRANCH|DEPARTMENT|TEAM|EMPLOYEE), `target_id`,
  `shift_id` xor `shift_pattern_id`, `effective_from`, `effective_to`, exclusion per target+range.
  Resolution order: EMPLOYEE > TEAM > DEPARTMENT > BRANCH > ORGANIZATION.
- `holiday_calendars`, `holidays` (`date`, `end_date`, `is_half_day`, `type`, `branch_ids uuid[] null`).
- `leave_types`, `leave_records` (`status` APPROVED|PENDING|CANCELLED, `source` INTERNAL|EXTERNAL,
  `external_ref`). The engine reads only approved leave through a `LeaveSource` port.
- `attendance_corrections` — `type` (ADD_PUNCH|EDIT_PUNCH|REMOVE_PUNCH|SET_STATUS), `original_event_id`,
  `proposed_punched_at`, `proposed_event_type`, `proposed_status`, `reason`, `attachment_path`,
  `requested_by`, `status` (PENDING|APPROVED|REJECTED|CANCELLED|APPLIED), `approval_request_id`,
  `applied_event_id`, `applied_at`.
- `approval_workflows` (`entity_type`, `steps jsonb`, `is_default`, `branch_id null`),
  `approval_requests`, `approval_steps` (`approver_type` MANAGER|ROLE|USER, `status`, `acted_by`, `comment`).
- `attendance_recalculation_requests` — range + scope + reason + job + summary.
- `attendance_period_locks` — `(organization_id, branch_id null, period_start, period_end)`; locked
  records refuse recompute/correction unless unlocked with reason (audited).
- `attendance_period_summaries` — payroll output per employee/period, `status` (draft|finalized),
  `version`, `finalized_by/at`.

**Reports, imports, notifications, audit, subscription**
- `report_requests` — `report_type`, `parameters`, `format`, `status`, `file_path`, `row_count`,
  `expires_at`; file in bucket `reports/{org}/{request_id}.{ext}`.
- `import_jobs`, `import_job_rows` (row-level validation results; nothing is imported until confirmed).
- `notifications`, `notification_preferences`, `notification_deliveries`.
- `audit.logs` — `organization_id null` for platform actions, `actor_user_id`, `actor_type`, `action`,
  `entity_type`, `entity_id`, `old_value`, `new_value`, `ip`, `user_agent`, `request_id`, `reason`.
  Insert-only: no UPDATE/DELETE grants; trigger raises on modification.
- `plans`, `subscriptions`, `entitlements`, `usage_records`, `feature_flags`,
  `organization_feature_flags`, `api_keys`, `domain_events` (outbox), `data_retention_policies`.

### D.3 Indexes (query-pattern driven, not exhaustive)

| Table | Index | Query it serves |
|---|---|---|
| employees | `(organization_id, employee_number)` unique; `(organization_id, branch_id, employment_status)`; `(organization_id, department_id)`; GIN `search`; `(organization_id, device_user_id)` unique | list/filter/search; device identity resolution |
| org_memberships | `(user_id, status)`; `(organization_id, user_id)` unique | RLS helper lookups |
| devices | `(organization_id, branch_id)`; `(provider_key, serial_number)` unique partial; `(next_attendance_sync_at) where auto_sync_enabled and status='active'` | scheduler scan |
| device_employee_states | `(device_id, sync_status)`; `(organization_id, employee_id)` | per-device reconciliation, employee sync view |
| sync_jobs | `(organization_id, created_at desc)`; `(organization_id, status)` | job lists |
| sync_job_items | `(sync_job_id, status)`; `(device_id, created_at desc)` | progress counters, device history |
| jobs.queue | `(queue_name, status, run_at, priority desc) where status='pending'`; `(organization_id) where status='running'`; unique `dedupe_key` partial | dequeue, fairness counts, idempotent enqueue |
| attendance_raw_transactions | per-partition: unique keys above; `(organization_id, device_id, punched_at)`; `(organization_id, processing_status) where processing_status <> 'normalized'` | ingestion, normaliser backlog |
| attendance_events | `(organization_id, employee_id, punched_at)`; `(organization_id, branch_id, punched_at)` | engine window queries, branch views |
| attendance_daily_records | unique `(organization_id, employee_id, attendance_date)`; `(organization_id, attendance_date, branch_id)`; `(organization_id, attendance_date) include (status, late_minutes, overtime_minutes)` | daily/monthly views, dashboard aggregates |
| audit.logs | `(organization_id, created_at desc)`; `(organization_id, entity_type, entity_id)` | audit viewer |
| notifications | `(user_id, read_at, created_at desc)` | notification centre |
| shift_assignments | GiST `(target_id, daterange)` via exclusion | resolution per date |

### D.4 Constraints that protect data integrity

- Exclusion constraints for every effective-dated table (no overlapping ranges per scope).
- Uniqueness of vendor identities per provider per org; of `device_user_id` per device.
- Immutability triggers on raw transactions, events (except void columns), audit logs, history tables.
- Period-lock trigger: refuse insert/update of daily records and events inside a locked period unless the
  session is the unlock/recalc job.
- `check` constraints on minutes ≥ 0, `effective_to > effective_from`, timezone validity, enum-like text codes.
- FKs always carry `organization_id`-consistent composite references where cheap
  (e.g. `employees(branch_id, organization_id) → branches(id, organization_id)`), preventing
  cross-tenant links even by a buggy service.

### D.5 RLS strategy (summary; full model in §H)

One generated policy pattern per tenant table, driven by three uncorrelated helper subselects computed
once per statement: *orgs where I hold permission X*, *orgs where I am unrestricted by branch*, *branch
ids I am restricted to*. Self-service tables add *my own employee ids*. Credentials, audit, queue and
outbox tables have **no** client policies at all.
---

## E. Device Integration Architecture

### E.1 Four connectivity modes, one abstraction

The requirements assume "Device → Vendor Cloud → FlowZa". Vendor due diligence (see
`docs/device-integrations.md`) shows the GCC market is more varied: many ZKTeco/eSSL/FingerTec units
speak a **device-to-cloud push protocol** (the device itself HTTP-posts to a server URL configured in its
menu), Hikvision devices speak ISAPI on the LAN and ISUP to a cloud, Suprema is fronted by a BioStar 2
server API, Anviz has a genuine cloud API. So the abstraction supports four modes, chosen per provider:

| Mode | Who initiates | Example | FlowZa component |
|---|---|---|---|
| `VENDOR_CLOUD_PULL` | Worker polls vendor cloud with cursor | Anviz CrossChex Cloud, ZKBio Time API, TimeTec | Worker → provider adapter |
| `VENDOR_WEBHOOK` | Vendor cloud POSTs events | Hik-Partner Pro, CrossChex Cloud events | API `/webhooks/providers/:provider` → queue |
| `DEVICE_PUSH` | Device POSTs to FlowZa; device polls FlowZa for commands | ZKTeco ADMS/PUSH ("iclock"), eSSL/FingerTec derivatives, Hikvision ISUP (later) | API `/device-push/:protocol/*` (protocol handler owned by the provider package) |
| `ON_PREM_SERVER_API` / `LAN` | Worker (or a future optional connector agent) calls a customer-hosted server/device on a reachable address | BioStar 2, Hikvision ISAPI over VPN/public IP | Worker → provider adapter; connector agent later |

The **attendance engine sees none of this.** Every mode ends in the same call:
`ingestRawTransactions(orgId, deviceId, RawTransaction[])`.

### E.2 Provider contract (`packages/device-providers`)

```ts
interface DeviceProvider {
  readonly key: string;                       // 'mock', 'zkteco_push', 'anviz_crosschex_cloud' …
  readonly definition: ProviderDefinition;    // vendor, name, integrationType, capabilities, configSchema, verification
  testConnection(ctx: ProviderContext): Promise<ConnectionResult>;
  getDeviceInfo(ctx: ProviderContext): Promise<DeviceInfo>;
  getCapabilities(ctx: ProviderContext): Promise<DeviceCapabilities>;   // may refine definition.capabilities
  getDeviceStatus(ctx: ProviderContext): Promise<DeviceStatus>;
  pullAttendance(ctx: ProviderContext, cursor: SyncCursor | null): Promise<AttendancePullResult>; // page + nextCursor + hasMore
  listEmployees(ctx: ProviderContext, page?: PageCursor): Promise<DeviceEmployeePage>;
  upsertEmployee(ctx: ProviderContext, employee: DeviceEmployee): Promise<DeviceOperationResult>;
  deleteEmployee(ctx: ProviderContext, deviceUserId: string): Promise<DeviceOperationResult>;
  // optional, capability-gated:
  handleWebhook?(req: WebhookRequest): Promise<WebhookHandlingResult>;        // VENDOR_WEBHOOK
  pushProtocol?: DevicePushProtocolHandler;                                    // DEVICE_PUSH
  restart?(ctx: ProviderContext): Promise<DeviceOperationResult>;
}
```

- `ProviderContext` = `{ organizationId, deviceId, config (non-secret), credentials (decrypted, in-memory
  only), logger, signal (AbortSignal with timeout), rateLimiter }`.
- `ProviderDefinition.capabilities` is the **declared** matrix; `getCapabilities()` can narrow it after
  talking to the device; `devices.capabilities` stores the effective set; the UI renders only actions
  whose capability is true (§12).
- `ProviderDefinition.configSchema` is a JSON-schema-like description (`fields[]` with `secret: true`)
  that drives the registration wizard and tells the API which fields go to `device_credentials`.
- Errors are typed: `ProviderError { code: 'AUTH_FAILED'|'DEVICE_OFFLINE'|'RATE_LIMITED'|'TIMEOUT'|
  'UNSUPPORTED'|'NOT_FOUND'|'INVALID_CONFIG'|'VENDOR_ERROR', retryable, retryAfterMs? }` so the sync
  engine's retry policy is provider-agnostic.
- `DevicePushProtocolHandler` = `{ identifyDevice(req) → serial; parseInbound(req) → { transactions,
  deviceInfo?, ack }; renderCommands(pendingCommands) → body; parseCommandResult(req) }`. The API hosts
  the HTTP routes; the protocol semantics live in the provider package.

### E.3 Providers in scope

| Provider key | Mode | Status at MVP |
|---|---|---|
| `mock` | all four modes simulated | **Implemented** — latency, failures, duplicates, missing employees, offline, pagination, large batches, webhook events, push protocol |
| `zkteco_push` (ADMS/PUSH SDK, "iclock") | DEVICE_PUSH | Implemented as protocol handler **against public protocol descriptions; requires hardware verification** |
| `zkteco_biotime` (ZKBio Time REST) | VENDOR_CLOUD_PULL | Placeholder + documented auth/endpoints from official docs |
| `hikvision_isapi` (ISAPI AccessControl) | ON_PREM_SERVER_API/LAN | Placeholder + documented |
| `hikvision_hpp` (Hik-Partner Pro OpenAPI) | VENDOR_CLOUD_PULL + VENDOR_WEBHOOK | Placeholder; requires partner credentials |
| `suprema_biostar2` | ON_PREM_SERVER_API | Placeholder + documented |
| `anviz_crosschex_cloud` | VENDOR_CLOUD_PULL | Placeholder + documented |
| `essl`, `fingertec_ingress`, `matrix_cosec`, `nitgen` | varies | Placeholder; compatibility documented with verification status |

"Placeholder" means: registered in `device_providers` with `status='placeholder'`, config schema and
documented capabilities, and an adapter that returns `UNSUPPORTED`/`NOT_IMPLEMENTED` errors — never a
fake success (§135).

### E.4 Data flow

```
Vendor Cloud / Device ──▶ Provider Adapter ──▶ Sync Engine (job item) ──▶ ingestRawTransactions()
                                                                            │ idempotent insert
                                                                            ▼
                                                     attendance_raw_transactions (immutable, partitioned)
                                                                            │ normaliser (resolve employee via
                                                                            │ device_employee_states → employee_provider_identities → employees.device_user_id)
                                                                            ▼
                                                              attendance_events (per employee)
                                                                            │ engine (per employee/date, debounced)
                                                                            ▼
                                                              attendance_daily_records (+history, trace)
```

Unmatched punches (unknown device user id) stay in raw with `processing_status='unmatched'` and appear
in the reconciliation screen; when HR maps the identity, the normaliser re-runs for them.

---

## F. Synchronisation Architecture

### F.1 Queue (ADR-006)

**Problem.** Durable, retried, tenant-fair background work; 500 devices per org; no long HTTP requests;
local development must not need extra infrastructure.

**Options.** (1) Supabase Queues/pgmq; (2) Redis + BullMQ; (3) Graphile Worker / pg-boss;
(4) custom Postgres queue table with `SKIP LOCKED` behind a `JobQueue` port.

**Recommendation.** (4) now, behind a port so (2) can replace it if a single Postgres becomes the
bottleneck. **Reason.** Fairness across organisations and per-provider throttling need custom dequeue
logic that pgmq/BullMQ do not provide out of the box; a Postgres queue is transactional with the domain
writes (enqueue in the same transaction as the state change — no lost jobs), needs no extra service, and
is fully testable on plain Postgres. Throughput headroom: a single Postgres handles thousands of
dequeues per second with `SKIP LOCKED`; our worst case (1,000 orgs × 500 devices polled every 5 min)
is ~1,700 jobs/s **only if every device is polled individually** — we avoid that by (a) preferring
push/webhook modes where the vendor supports them, (b) batching polls per vendor account rather than
per device, and (c) adaptive intervals (back off idle devices). **Trade-offs.** Queue rows add write
load to the main database; mitigated by archiving completed jobs and a dedicated `jobs` schema that can
move to its own Postgres/Redis later without touching domain code.

Dequeue algorithm (`jobs.dequeue(worker, queues[], limit, per_org_cap)`):
1. Count running jobs per organisation.
2. Select pending jobs with `run_at <= now()` whose org is under `per_org_cap`, ordered by
   `org_running_count asc, priority desc, run_at asc` (least-served tenant first), `FOR UPDATE SKIP LOCKED`.
3. Mark running with `locked_by`, `locked_at`, `attempts+1`; a reaper requeues jobs whose lock is older
   than the job type's `lock_timeout` (crash safety).

### F.2 Sync job model

`sync_jobs` is the **user-facing** unit ("Sync employees to branch Muscat"); `jobs.queue` rows are the
**execution** unit. One sync job fans out into many job items; each item becomes one queue job (or a
batched queue job for providers that accept bulk operations). Progress counters on `sync_jobs` are
updated atomically per item and broadcast to `org:{id}:sync`.

### F.3 Polling, webhooks, push — hybrid by default

- **Scheduler** (worker leader) scans `devices` where `auto_sync_enabled and next_attendance_sync_at <= now()`
  and enqueues `PULL_ATTENDANCE` with `dedupe_key = pull:{device_id}` (no duplicate polls if one is still
  running). Interval per device/org (1–60 min), adaptive: doubles after N empty polls up to the max,
  resets when data arrives; offline devices are polled at the health-check interval only.
- **Webhooks** validate signature (provider-specific), insert into `provider_webhook_events` (replay
  protection by `event_id` and `payload_hash`), enqueue processing, and return 2xx quickly.
  A **reconciliation poll** still runs at a slow cadence for webhook providers (missed events).
- **Device push** endpoints authenticate the device (serial + push token or registered serial), store
  transactions immediately (idempotent), update heartbeat, and return any pending `device_commands`
  (employee push/delete) in the protocol's format. Unknown serials are recorded as *pending devices* so
  an admin can claim them into a branch (zero-touch onboarding).

### F.4 Retries, idempotency, dead letters

- Retry policy per error code: `DEVICE_OFFLINE`/`TIMEOUT`/`VENDOR_ERROR(5xx)` retryable with exponential
  backoff (base 30 s, factor 2, jitter, cap 30 min, `max_attempts` 6 by default); `RATE_LIMITED` honours
  `retryAfterMs`; `AUTH_FAILED`/`INVALID_CONFIG`/`UNSUPPORTED` are terminal (item FAILED, device flagged).
- Every job carries `dedupe_key`; every write is idempotent (raw transaction unique keys, upserts on
  `device_employee_states`, cursors advanced only after the page is committed).
- After `max_attempts` a queue job is `dead`; the sync item becomes FAILED with reason; a notification
  `sync.failed` is emitted; dead jobs are visible to platform admins and to the org's attendance admin
  (retry button = new job).

### F.5 Employee ↔ device synchronisation

- Desired state = employees (active, assigned to the device's branch or explicitly to the device group)
  ∩ device capability. Each `(device, employee)` has a `device_employee_states` row with `cloud_hash`
  (hash of the fields the device cares about) and `device_hash` (last confirmed on device).
- `PUSH_EMPLOYEE(S)` items compare hashes; only changed employees are pushed; results update state.
- `PULL_EMPLOYEES` lists users on the device and marks `OUT_OF_SYNC` / *exists on device but not in cloud*.
- **Reconciliation** job produces a diff report (cloud-only, device-only, differing, unmatched punches,
  duplicate transactions) stored on the job; UI offers *Repair* (creates push/delete jobs) per row or in bulk.

### F.6 Throttling and fairness

Per-provider limits live in the provider definition (`maxConcurrentPerDevice`, `maxConcurrentPerAccount`,
`requestsPerMinute`). The worker keeps in-process semaphores keyed by `(provider, accountKey)` and a token
bucket per provider; when exhausted it re-schedules the job with a short delay instead of blocking a
worker slot. Org fairness is enforced in `jobs.dequeue()` (§F.1). Manual syncs get higher priority than
scheduled polls; health checks lowest.

---

## G. Attendance Engine

### G.1 Pipeline and separation

1. **Raw** (`attendance_raw_transactions`) — what the device said, never modified.
2. **Events** (`attendance_events`) — one row per accepted raw punch (employee resolved, branch attached,
   type derived from direction if the device gives one, else `PUNCH`) plus manual/correction events.
   Voiding an event (by approved correction) sets `voided_at`; it is never deleted.
3. **Daily records** (`attendance_daily_records`) — computed, versioned, with `trace`.
4. **Corrections/approvals** — proposals that, when approved, create/void events and trigger recompute.
5. **Period summaries** — locked aggregates for payroll.

### G.2 Inputs to a calculation (all effective-dated)

`calculateDailyRecord({ employee, date, timezone, shift, ruleSet, holidays, weeklyOffDays,
approvedLeave, events(window), employmentStatusOnDate })` → `{ record, trace }` — a pure function in
`packages/domain/attendance`. Shift comes from `resolveShift(assignments, patterns, date)`; rule set from
`resolveRuleSet(ruleSets, date, branch)`; timezone = branch timezone on that date (from employment history).

### G.3 Attendance date attribution and cross-midnight (§109)

Each shift defines a **punch window**: `[shiftStart − punchInWindowBefore, shiftEnd + punchOutWindowAfter]`
in the branch timezone; for overnight shifts `shiftEnd` is on the next calendar day. The attendance date
is the date the shift *starts*. Example: shift 22:00–06:00, window 18:00 (D) → 12:00 (D+1); punches
21:57 (D) and 06:08 (D+1) both attribute to date D. When windows of consecutive days overlap (e.g.
flexible shifts), a punch is attributed to the window whose scheduled start is nearest — deterministic
and recorded in the trace. Flexible shifts use a configurable day boundary (default 04:00 local).

### G.4 Interpretation of punches (configurable per rule set)

- `FIRST_LAST`: first punch in window = IN, last = OUT; intermediate punches ignored (counted). Default.
- `PAIRED`: alternate IN/OUT; odd punch count ⇒ `MISSING_OUT` flag; break time = gaps between pairs.
- `DIRECTIONAL`: trust device direction (in/out/break) where the device supplies it; fall back to PAIRED.
- Duplicate-punch window (e.g. 60 s) collapses repeated punches from the same device.

### G.5 Rules applied (all from `attendance_rule_sets`, effective-dated)

Late = `max(0, firstIn − (shiftStart + grace))`; early departure likewise at the end; worked = OUT − IN −
unpaid breaks (fixed break minutes or measured); overtime = worked beyond scheduled minutes past the OT
threshold, in minimum blocks; rounding (none/5/10/15 min; nearest/up/down; applied to IN, OUT and/or
total — raw timestamps stay untouched and the trace shows both); minimum full-day/half-day thresholds;
missing-punch behaviour (flag only / assume shift end / treat as absent); auto-absent when no punches
and no leave/holiday/off; holiday & weekly-off precedence (holiday > weekly off > leave > punches — a
punch on a holiday yields `HOLIDAY` status with `WORKED_ON_HOLIDAY` flag and OT per rule); Ramadan
override (reduced scheduled minutes between configured dates for eligible employees).

### G.6 Traceability (§88)

`trace` records: inputs (shift, rule set id/version, timezone, holiday/leave hits), every punch with
attribution decision, each rule step with intermediate values, and the engine version. Support can
answer "why late?" from the record alone.

### G.7 Recalculation (§115)

Recompute is triggered by: new event, approved correction, rule set / shift assignment / holiday / leave
change (scoped to affected employees and dates), or an explicit recalculation request. Each recompute
writes a history snapshot with `reason`. Records inside a **locked period** are skipped and listed in the
request summary. Nothing is destructive; "recompute from raw" is always possible because raw and events
are immutable.

### G.8 Payroll readiness (§48)

`attendance_period_summaries` is produced from daily records for a period definition (calendar month by
default; configurable cut-off day). Finalisation requires the period lock; the summary carries a version
and the set of record versions it aggregated. Exposed via `/api/v1/payroll/periods/:id/summaries` (read).
---

## H. Security Model

### H.1 Principals and execution contexts

| Context | Who | DB role | Claims applied to session |
|---|---|---|---|
| **User** | Any signed-in person | `authenticated` | `sub` = auth user id |
| **System-for-org** | Worker job, API acting for a tenant-scoped background step | `flowza_system` | `org_id` = the one organisation the job belongs to |
| **Platform admin** | Support/ops staff | `authenticated` + row in `platform_admins` | `sub`; access to tenant rows only where an active `platform_access_grant` exists |
| **Anonymous** | Device push endpoints, webhook receivers | `flowza_system` after device/webhook authentication resolves the org | `org_id` |

No application code path uses Supabase `service_role`. Migrations/ops use it via CI only.

### H.2 Authorization model (RBAC + branch scope) — ADR-002

- `permissions` are the vocabulary (`employee.view`, `attendance.correct`, `device.manage`…).
- System roles (`owner`, `org_admin`, `hr_admin`, `hr_user`, `branch_manager`, `attendance_admin`,
  `payroll`, `employee`) are seeded with permission sets; organisations may clone and customise roles
  (`role.manage`).
- A membership has one role and either `all_branches=true` or an explicit branch list.
- Helper functions (schema `app`, `STABLE`, `SECURITY DEFINER`, `search_path` pinned):
  - `app.uid()`, `app.claims()`, `app.is_system()`, `app.system_org_id()`
  - `app.org_ids_with_permission(perm text) → uuid[]` (memberships ∪ system org ∪ platform grants)
  - `app.unrestricted_org_ids() → uuid[]`, `app.allowed_branch_ids() → uuid[]`
  - `app.own_employee_ids() → uuid[]` (self-service)
  - `app.has_permission(org uuid, perm text) → bool` (used by services and storage policies)
- **Generated policies**: `app.apply_tenant_policies(schema, table, view_perm, write_perm, branch_column, self_column)`
  creates `select/insert/update/delete` policies of this exact shape:

```sql
USING (
  organization_id = ANY ((SELECT app.org_ids_with_permission('employee.view')))
  AND ( organization_id = ANY ((SELECT app.unrestricted_org_ids()))
        OR branch_id IS NULL
        OR branch_id = ANY ((SELECT app.allowed_branch_ids())) )
)
```

  The subselects are uncorrelated → evaluated once per statement (InitPlan) → the planner uses the
  `(organization_id, …)` indexes. A branch manager who edits `branch_id` in a request either fails the
  `WITH CHECK` (write) or gets zero rows (read). Explicit service-layer checks give a clear `FORBIDDEN`.
- Platform admins: `org_ids_with_permission` includes only organisations with an active, unexpired grant
  whose `access_level` covers the permission class; every grant creation/use is audited with the reason.

### H.3 Tenant isolation guarantees

1. RLS on every tenant table (tested: org A user vs org B rows, branch manager vs other branch, system
   context of org A vs org B rows, platform admin without grant).
2. Composite FKs carrying `organization_id` prevent cross-tenant references.
3. Storage policies apply the same helpers on the path prefix.
4. Realtime private channels authorised by RLS on `realtime.messages` (channel name carries the org id).
5. Services never accept `organization_id` from the body — it comes from the route's org context, which is
   validated against the caller's memberships.

### H.4 Secrets (ADR-003)

Device credentials are encrypted **before** they reach Postgres with AES-256-GCM under a per-record data
key wrapped by a master key from the environment/KMS (`FLOWZA_CREDENTIALS_MASTER_KEYS` supports several
key ids for rotation). Stored in `device_credentials` (no client policies). Decrypted only inside the
worker/API process for the duration of a provider call, never logged, never returned; the UI sees `masked`
(`****abcd`). Rotation = re-wrap under the new key id in a background job. Webhook signing secrets and
device push tokens are stored as salted hashes where verification only needs equality, encrypted where
the plaintext must be re-used.

### H.5 Authentication

Supabase Auth: email/password with verification, reset, session refresh; TOTP MFA enrolment exposed in
Security settings (enforced per org via `organization_settings.security.mfa_required` checked at API);
login history from the Password Verification Hook; account status (suspended memberships lose access
immediately because permissions are DB-driven, not JWT-driven). SSO (Entra ID/Google/SAML) later through
Supabase SSO with domain → organisation mapping.

### H.6 API security

JWT verification (JWKS, `aud`, `exp`), permission checks per route, Zod validation, rate limiting
(per IP for auth-adjacent and webhook routes, per user/org for API routes, configurable), pagination caps,
standard error envelope (no stack traces), CORS allow-list, security headers, request size limits,
idempotency keys on mutating job-creating endpoints, audit rows for every sensitive action, structured
logs with redaction of secrets/PII.

### H.7 Privacy

Data minimisation (no biometric templates centrally unless a vendor requires template push — then
encrypted at rest with the same envelope scheme and a feature flag), sensitive identity documents in a
gated table, PII redaction in logs, configurable retention with default *keep*, anonymisation routine for
terminated employees after configurable delay, export audit trail, region cell per organisation for
residency (§K).

---

## I. Frontend Architecture

- **Stack**: React 19 + Vite + TypeScript; TanStack Query (server state), React Hook Form + Zod (forms,
  same schemas as the API via `packages/contracts`), Zustand only for UI shell state (sidebar, active
  org, table preferences), React Router; Tailwind CSS v4 + Radix primitives (shadcn-style components in
  `apps/web/src/components/ui`); TanStack Table (server-driven); Recharts; i18next (en/ar) with
  `dir="rtl"` switching and logical CSS properties; Luxon for timezone display.
- **Structure**: `apps/web/src/features/{auth,dashboard,employees,devices,sync,attendance,shifts,
  holidays,leave,corrections,approvals,reports,users,roles,settings,notifications,audit,platform}` each
  with `api/` (query hooks), `components/`, `pages/`, `schemas` reuse from contracts. Shared:
  `components/ui`, `components/data-table`, `components/layout`, `lib/` (api client, auth, i18n, format).
- **Pages (MVP)**: Sign in / MFA / reset · Organisation switcher · Dashboard · Employees (table, profile
  with tabs: overview, employment history, devices, attendance, documents) · Import wizard · Branches ·
  Departments/Designations · Devices (table, add wizard, detail: status/logs/employees/actions) ·
  Device groups · Sync jobs (list, progress detail) · Reconciliation · Attendance (daily grid, monthly
  view, record detail with trace) · Corrections & Approvals inbox · Shifts & assignments · Holidays ·
  Leave · Reports (request + downloads) · Users & roles · Settings (general, regional, attendance rules,
  sync, notifications, security, subscription) · Notification centre · Audit log · Platform admin
  (orgs, plans, providers, flags, grants).
- **UX rules**: server-side pagination/filter/sort everywhere; skeletons and empty states; optimistic
  updates only for trivial toggles; long operations return job ids and show progress (Realtime + polling
  fallback); capability-aware action menus; confirmation dialogs for destructive/bulk actions;
  keyboard-navigable Radix components; responsive from 13" laptop to 27" monitor and tablet (collapsible
  sidebar, column visibility, card lists under 768px).
- **Auth in the SPA**: Supabase JS handles session; the API client attaches the access token; a
  `/api/v1/me` bootstrap returns memberships, permissions (for UI gating only — never trusted server-side),
  feature flags and org settings.

---

## J. API Architecture

Base `/api/v1`, org-scoped routes carry the organisation in the path (`/api/v1/orgs/:orgId/...`) so
authorisation is explicit and cacheable; the caller's membership in `:orgId` is verified on every request.

| Area | Endpoints (representative) |
|---|---|
| Me | `GET /me` (profile, memberships, permissions, flags) · `PATCH /me` · `GET /me/notifications` · `POST /me/notifications/:id/read` |
| Organisations | `GET/PATCH /orgs/:orgId` · `GET/PUT /orgs/:orgId/settings/:group` · platform: `GET/POST /platform/orgs` |
| Users & roles | `GET /orgs/:orgId/members` · `POST /orgs/:orgId/invitations` · `PATCH /orgs/:orgId/members/:id` · `GET/POST/PATCH /orgs/:orgId/roles` · `GET /permissions` |
| Structure | `…/branches`, `…/departments`, `…/designations`, `…/teams` (CRUD, list with filters) |
| Employees | `GET …/employees?search&branchId&departmentId&status&page&pageSize&sort` · `POST` · `GET/PATCH/DELETE …/employees/:id` · `GET …/employees/:id/history` · `POST …/employees/bulk` (assign branch/department/shift, sync, export → job) · `POST …/employees/imports` (upload) · `POST …/employees/imports/:id/confirm` |
| Devices | `GET /device-providers` · `GET /device-models` · `GET/POST …/devices` · `GET/PATCH/DELETE …/devices/:id` · `POST …/devices/test-connection` · `POST …/devices/:id/credentials` (rotate) · `GET …/devices/:id/logs` · `GET …/devices/:id/employees` · `…/device-groups` · `GET …/devices/pending` (unclaimed push devices) · `POST …/devices/pending/:id/claim` |
| Sync | `POST …/sync/attendance` (device/branch/all) · `POST …/sync/employees` (employee ids/branch/devices) · `POST …/sync/health-check` · `POST …/sync/reconcile` · `GET …/sync/jobs` · `GET …/sync/jobs/:id` (+items) · `POST …/sync/jobs/:id/cancel` · `POST …/sync/jobs/:id/retry-failed` |
| Attendance | `GET …/attendance/daily?date&branchId&departmentId&status` · `GET …/attendance/monthly?month&employeeId` · `GET …/attendance/records/:id` (trace) · `GET …/attendance/events?employeeId&from&to` · `POST …/attendance/corrections` · `GET …/attendance/corrections` · `POST …/attendance/corrections/:id/cancel` · `POST …/attendance/recalculate` · `POST …/attendance/periods/lock` |
| Approvals | `GET …/approvals/inbox` · `POST …/approvals/:id/approve|reject` · `…/approval-workflows` |
| Shifts | `…/shifts`, `…/shift-patterns`, `…/shift-assignments` · `GET …/shifts/resolve?employeeId&date` |
| Holidays/Leave | `…/holiday-calendars`, `…/holidays`, `…/leave-types`, `…/leave-records` |
| Rules | `…/attendance-rule-sets` (effective-dated) |
| Reports | `GET /report-types` · `POST …/reports` (→ job) · `GET …/reports` · `GET …/reports/:id` · `GET …/reports/:id/download` (signed URL) |
| Payroll | `GET …/payroll/periods` · `POST …/payroll/periods/:id/finalize` · `GET …/payroll/periods/:id/summaries` |
| Dashboard | `GET …/dashboard/summary?date&branchId` · `GET …/dashboard/trends?from&to` · `GET …/dashboard/devices` |
| Search | `GET …/search?q=` |
| Audit | `GET …/audit?entityType&entityId&actor&from&to` |
| Subscription | `GET …/subscription` · `GET …/usage` · platform: `…/platform/plans`, `…/platform/subscriptions` |
| Flags/Providers (platform) | `…/platform/feature-flags`, `…/platform/device-providers`, `…/platform/access-grants` |
| Inbound | `POST /webhooks/providers/:providerKey` · `ANY /device-push/:protocol/*` |
| Health | `GET /api/health` (liveness) · `GET /api/ready` (DB, queue depth, storage, provider circuit states) |

Conventions: `{ data, meta: { page, pageSize, total } }`; errors `{ code, message, requestId, details? }`;
cursor pagination for high-volume lists (events, logs), page/size for admin tables; ETag on config
resources; `Idempotency-Key` header on job-creating POSTs; OpenAPI document generated from the Zod
contracts and served at `/api/v1/openapi.json`.

---

## K. Scalability

| Dimension | 1 org / 10 devices | 10 orgs / 100 devices | 100 orgs / 500 devices | 1,000 orgs / 1,000+ devices per large org |
|---|---|---|---|---|
| **Compute** | 1 API + 1 worker container (shared Fly/Railway app), Supabase Micro/Small | 2 API + 2 workers, Small compute | 3+ API, 4–8 workers (horizontal; stateless), Medium/Large compute, read replica for reports | Worker pools per queue (sync / processing / reports), Supabase XL + replicas; `jobs` schema moved to its own Postgres or Redis behind the port |
| **Ingestion** | Polling every 5 min fine | Hybrid; push protocol preferred | Batched per vendor account; adaptive intervals; push/webhook dominant | Partition pruning + monthly partitions keep raw/events tables manageable; ingestion 1,000s/s achievable with `COPY`-style batch inserts |
| **Fairness** | n/a | per-org cap in dequeue | per-org cap + priorities + provider token buckets | per-cell isolation (large tenants may get a dedicated cell) |
| **Engine** | recompute inline | debounced per employee/date | dedicated processing queue; recompute batched per org-day | precomputed dashboard aggregates (materialised per org/day), archive old partitions |
| **Data** | single project | single project | monthly partitions, retention jobs, archive completed queue rows | region cells (GCC residency), tenant → cell mapping in platform DB |

Architecture rules that make the path possible without redesign: stateless API/workers; all
tenant-scoped work keyed by `organization_id`; queue behind a port; providers behind a port; raw/events
partitioned from day one; no cross-tenant joins in hot paths; dashboard aggregates computed by jobs, not
by scanning millions of rows per page view.

---

## L. Device Compatibility — adding a vendor without touching the engine

1. Verify the vendor's official integration path (docs, SDK, partner program) and record it in
   `docs/device-integrations.md` with verification level.
2. Implement `packages/device-providers/src/providers/<vendor>/` exporting a `DeviceProvider`:
   definition (capabilities, config schema, throttling limits, verification status), the required methods,
   and — for push protocols — a `DevicePushProtocolHandler`. Map vendor errors to `ProviderError` codes.
   Map vendor records to `RawTransaction` (`providerTransactionId`, `deviceEmployeeId`, `punchedAt` UTC,
   `verificationMethod`, `direction`, `rawPayload`) and `DeviceEmployee`.
3. Register it in the `ProviderRegistry`; a migration (or the registry sync command) upserts
   `device_providers` and `device_models` with **verified** capabilities only.
4. Write provider tests against recorded fixtures / a vendor simulator; run the shared conformance test
   suite (`describeProviderConformance(provider)`) which asserts idempotency, cursor behaviour, error mapping
   and capability honesty.
5. Nothing in `packages/domain`, the sync engine, the API routes or the UI changes: the wizard renders
   the config schema, the UI gates actions by capabilities, the engine consumes `RawTransaction`.

---

## M. MVP Roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Foundation** (this repository state) | Monorepo, Supabase migrations + RLS + tests, domain packages (engine, providers, sync), API, worker, web shell + core screens, mock provider, seed, CI, docs | `pnpm verify` green; RLS isolation tests pass; golden path works end-to-end with the mock provider |
| **1 — Oman pilot** | ZKTeco push protocol verified on hardware; employee import; reports (daily/monthly/late/absence/OT/missing punch/device sync/health); notifications email; Arabic UI polish; MFA; subscription limits | 2–3 pilot customers live; payroll summaries exported monthly |
| **2 — Multi-vendor** | Hikvision (ISAPI + HPP), Anviz cloud, Suprema BioStar 2 adapters with real credentials; reconciliation repair; device groups bulk ops; adaptive polling | Compatibility matrix with ≥4 vendors VERIFIED |
| **3 — Workforce depth** | Rotational patterns UI, Ramadan mode, split shifts, on-duty/off-site, permissions/short leave, comp-off, overtime approval, payroll cut-offs, HRMS leave ingestion | Feature parity with incumbent on-prem tools for GCC HR teams |
| **4 — Platform** | Public API keys/scopes, customer webhooks, employee self-service, PWA punches with geofencing (separate engine input), SSO, region cells (UAE/KSA), billing integration | Enterprise deals; KSA/UAE residency |

---

## N. Risks and challenged assumptions

Detailed findings from the vendor, platform and compliance research and from three independent critics
are consolidated in `docs/risks.md`. The most consequential:

1. **"Cloud-connected devices" is not one thing.** Most GCC installs expose either a push protocol
   (device → server) or a LAN/on-prem server, not a vendor cloud API. Building only vendor-cloud pull
   would exclude most of the installed base. *Decision:* four connectivity modes (§E.1); push protocol
   first for ZKTeco-class devices; optional connector agent kept as a later mode, not a dependency.
2. **Vendor documentation and partner gating.** Hikvision OpenAPI and ZKTeco cloud APIs need partner
   accounts; several protocols are only informally documented. *Decision:* placeholder adapters that fail
   honestly, a hardware verification checklist, and capability flags marked VERIFIED/REPORTED/UNVERIFIED.
3. **Device clocks and time zones.** Devices drift and are often set to local time without zone info.
   *Decision:* store `device_local_time` as sent, convert with the device's configured timezone, flag
   punches far from server receipt time, expose clock-skew in device health, and never dedupe by timestamp alone.
4. **Vendor transaction IDs reset** after device reset/firmware upgrade → false duplicates or missed
   punches. *Decision:* unique key includes `punched_at`; dedupe hash fallback; reconciliation detects gaps.
5. **RLS performance at scale.** Row-by-row function evaluation kills large scans. *Decision:* uncorrelated
   subselect pattern (§H.2) + tenant-leading indexes + partitioning; benchmarks in tests.
6. **JWT claim staleness.** Roles in tokens outlive role changes. *Decision:* permissions resolved from
   the database on every request; nothing authorisation-relevant in the JWT.
7. **Edge Function/Cron limits.** Long syncs and 500-device fan-outs do not fit serverless time limits.
   *Decision:* Node workers; Edge Functions only for hooks/glue.
8. **Single-database queue contention** at very large scale. *Decision:* `JobQueue` port; batching;
   adaptive polling; documented migration to Redis/BullMQ or a dedicated queue database.
9. **Biometric and personal data regulation** (Oman PDPL and executive regulations; UAE/KSA PDPL).
   *Decision:* no central templates by default, consent/notice fields, retention policies, residency cells,
   Supabase region choice documented; legal review before KSA launch.
10. **Labour-law modelling gaps** (Ramadan hours, weekly rest Friday vs Fri–Sat, OT multipliers, night
    work). *Decision:* rule sets are effective-dated and per branch; OT *minutes* are produced by the
    engine, OT *pay* multipliers stay in payroll (future) — FlowZa exposes categorised minutes
    (regular/weekly-off/holiday/night) so payroll can apply rates.
11. **Month-end integrity.** Payroll disputes need frozen data. *Decision:* period locks and versioned
    summaries from day one.
12. **Operational blind spots.** Silent poll failures cost customers a month of attendance. *Decision:*
    device health thresholds, "no data for N hours" alerts, dead-letter visibility, `/api/ready` with
    queue depth, structured logs with `requestId/jobId/syncId`.

**Assumptions challenged:**
- *"One employee = one device user id across vendors"* → false; per-provider identities + per-device state.
- *"Status is one value"* → daily record has a primary status plus flags; payroll consumes categorised minutes.
- *"Sync every minute"* → per-device intervals are adaptive; per-vendor limits take precedence; push
  protocols make 1-minute polling unnecessary.
- *"Edge Functions/serverless for everything"* → not for workers; keep a real worker process.
- *"Super admin sees everything"* → reason-based, time-boxed, audited grants.
- *"Delete employee"* → soft delete/anonymise; attendance history must survive for payroll and audit.
