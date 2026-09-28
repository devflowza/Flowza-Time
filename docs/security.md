# Security Model

Priorities: Security > Reliability > Data Integrity. This document describes the controls as implemented. The security &
quality gate (HR portal Prompt 10, `docs/hr-portal/reports/10-security-gate.md`) turned most of them into catalogue- and
route-driven tests that also cover tables and routes added later — see [Testing the model](#testing-the-model).

## Identity

- Supabase Auth issues JWTs (email/password; TOTP MFA enrolment supported; SSO later). Sign-up is disabled — users
  join by invitation. Password policy: ≥12 chars, mixed classes (`supabase/config.toml`).
- The API verifies tokens with the project's JWKS (asymmetric) and falls back to HS256 with the legacy JWT secret.
  Only `role = authenticated` tokens are accepted by the API.
- Login attempts are recorded in `login_history` by the Auth **password verification hook**
  (`app.on_password_verification_attempt`).
- MFA: when `organization_settings.security.mfaRequired` is true, or for a platform administrator, `aal2` is required
  (`403 FORBIDDEN`, detail `MFA_REQUIRED`).

## Authorization (ADR-002)

- Permissions (`permissions` table, 60 keys) → roles (system + custom) → memberships (`org_memberships`) with optional
  branch scope (`membership_branches`). Nothing authorisation-relevant is stored in the JWT; the API loads the principal
  from the database on every request (`app.principal_snapshot`, `apps/api/src/lib/principal.ts`), so suspensions and role
  changes are immediate.
- Two layers on every request:
  1. **API** — the organisation access gate (`apps/api/src/middleware/org-access.ts`) answers 403 to a non-member on every
     `/orgs/:orgId/*` route before any body is read, and the platform access gate does the same for `/platform/*`; then
     the service checks the precise key and scope (`requireMembership`, `requirePermission`, `requireBranchAccess`,
     `apps/api/src/lib/authorize.ts`).
  2. **Row Level Security** — `withContext()` sets `SET LOCAL ROLE authenticated` + `request.jwt.claims` for the user, or
     `SET LOCAL ROLE flowza_system` + `{"role":"flowza_system","org_id":…}` for one organisation (a job, a webhook, a
     step the API performs after its own checks). See [Row-level security model](#row-level-security-model).
- `app.is_system()` requires both the claim and `current_setting('role') = 'flowza_system'`; only `flowza_api` and
  `flowza_worker` are members of that role, so a forged claim from a user session or PostgREST can never become system.
- Escalation guards: nobody grants a permission they do not hold (`role_permissions_no_escalation`); a membership,
  membership branch or invitation cannot carry a role, an owner or an all-branches scope its writer does not hold, nobody
  creates or deletes their own membership, and nobody but an owner re-links their own login to an employee record
  (`app.guard_membership_write`, `app.guard_membership_branch_write`, `app.guard_invitation_write` — the services apply
  the same rules first).
- Platform administrators (`platform_admins`) see organisation metadata but no tenant data unless an active, time-boxed
  (≤ 72 h, default 8 h), reason-bearing `platform_access_grants` row exists. A **write** grant starts only when the second
  platform administrator named on it approves it in their own session (`POST /platform/access-grants/:id/approve`); until
  then its window is closed, and the database refuses an active unapproved write grant. Grants are audited, revocable and
  visible to the organisation's owners.

### System roles × permissions

`x` = granted to the system role. Custom roles are subsets of their creator's keys.

| Area | Key | owner | org_admin | hr_admin | attendance_admin | branch_manager | hr_user | manager | payroll | auditor | employee |
|---|---|---|---|---|---|---|---|---|---|---|---|
| approval | approval.delegate | x | x | x | | | | x | | | |
| approval | approval.manage | x | x | x | | | | | | | |
| attendance | attendance.approve | x | x | x | x | x | | x | | | |
| attendance | attendance.checkin | x | x | x | | | | x | | | x |
| attendance | attendance.correct | x | x | x | x | x | x | x | | | |
| attendance | attendance.lock_period | x | x | x | | | | | | | |
| attendance | attendance.manage_geofences | x | x | x | | | | | | | |
| attendance | attendance.manage_overtime | x | x | x | | | | | | | |
| attendance | attendance.manage_rules | x | x | x | x | | | | | | |
| attendance | attendance.note | x | x | x | | | | x | | | x |
| attendance | attendance.recalculate | x | x | x | x | | | | | | |
| attendance | attendance.request_correction | x | x | x | x | x | x | x | x | | x |
| attendance | attendance.review_notes | x | x | x | | | x | | | | |
| attendance | attendance.view | x | x | x | x | x | x | | x | x | |
| attendance | attendance.view_own | x | x | | | | | x | | | x |
| attendance | attendance.view_raw | x | x | x | x | | | | | x | |
| attendance | attendance.view_team | x | x | x | | x | | x | | | |
| audit | audit.view | x | x | x | x | | | | | x | |
| branch | branch.manage | x | x | | | | | | | | |
| branch | branch.view | x | x | x | x | x | x | | x | x | |
| dashboard | dashboard.view | x | x | x | x | x | x | x | x | x | |
| department | department.manage | x | x | x | | | | | | | |
| department | department.view | x | x | x | x | x | x | | x | x | |
| device | device.create | x | x | | x | | | | | | |
| device | device.manage | x | x | | x | | | | | | |
| device | device.sync | x | x | x | x | x | x | | | | |
| device | device.update | x | x | | x | | | | | | |
| device | device.view | x | x | x | x | x | x | | | | |
| employee | employee.create | x | x | x | | | x | | | | |
| employee | employee.delete | x | x | x | | | | | | | |
| employee | employee.export | x | x | x | | | | | | | |
| employee | employee.import | x | x | x | | | x | | | | |
| employee | employee.update | x | x | x | x | x | x | | | | |
| employee | employee.view | x | x | x | x | x | x | | x | x | |
| employee | employee.view_sensitive | x | x | x | | | | | | | |
| employee | employee.view_team | x | x | x | | x | x | x | | | |
| holiday | holiday.manage | x | x | x | x | | | | | | |
| holiday | holiday.view | x | x | x | x | x | x | x | x | x | x |
| integration | integration.manage | x | x | | | | | | | | |
| leave | leave.approve | x | x | x | | x | x | x | | | |
| leave | leave.manage | x | x | x | | x | x | | | | |
| leave | leave.request | x | x | x | x | x | x | x | x | | x |
| leave | leave.view | x | x | x | | x | x | | x | x | |
| leave | leave.view_team | x | x | x | | | | x | | | |
| notification | notification.manage | x | x | | | | | | | | |
| organization | organization.manage | x | x | | | | | | | | |
| organization | organization.view | x | x | x | x | x | x | | x | x | |
| payroll | payroll.finalize | x | | | | | | | x | | |
| payroll | payroll.view | x | x | x | | | | | x | x | |
| report | report.export | x | x | x | x | x | x | | x | x | |
| report | report.manage | x | x | x | | | | | | | |
| report | report.schedule | x | x | x | | | | | x | | |
| report | report.view | x | x | x | x | x | x | x | x | x | |
| role | role.manage | x | x | | | | | | | | |
| shift | shift.assign | x | x | x | x | x | x | | | | |
| shift | shift.manage | x | x | x | x | | | | | | |
| shift | shift.request_swap | x | x | | | x | | x | | | x |
| shift | shift.view | x | x | x | x | x | x | x | x | x | |
| user | user.manage | x | x | | | | | | | | |
| user | user.view | x | x | x | | | | | | | |

A handful of routes answer every member because they are scoped to the member's own data (the approval inbox, one's own
delegations, the organisation's display settings and role catalogue, …); each is listed with its reason in
`MEMBERSHIP_ONLY` of `apps/api/src/test/route-authz.test.ts`, and every other route refuses a member without its key.

## Row-level security model

- **Every table has RLS**, and it is forced wherever the owner could bypass it. Every tenant table (every table of
  `public` / `audit` with `organization_id`) is created through `app.apply_tenant_policies()` /
  `app.apply_readonly_tenant_policies()`, which also apply the three rules below.
- **Predicates.** A row is visible to a user through one of four doors, combined per table by the generators:
  *organisation* (a key that is organisation-wide: `app.org_ids_with_permission(key)`), *branch* (the key, limited to the
  membership's branches: `app.allowed_branch_ids()`, or all of them: `app.unrestricted_org_ids()`), *team* (the caller's
  direct reports: `app.team_employee_ids()`), *self* (the caller's own employee record or rows addressed to their user id —
  and those only while the caller is still a member of the row's organisation). The helpers are uncorrelated arrays,
  evaluated once per statement.
- **System context** (`flowza_system`) reaches the rows of its own organisation only (`app.system_org_id()`); the
  cross-tenant `platform` context (outbox relay, metering, scheduler scans) is limited to an explicit table whitelist.
- **Tenant key immutable.** `organization_id_immutable` (BEFORE UPDATE) on every tenant table refuses any change of
  `organization_id` (a row cannot be moved to another tenant); a row with no organisation may be adopted once (device claim).
- **RPC-only (system-write-only) tables.** Tables written by an engine or a state machine — approval requests / steps /
  actors / events / delegations / e-mail tokens, leave records / allocations / comp-off credits, day marks, daily records,
  reasons, regularisations, selfies, swaps, geofences, notification and report deliveries, device commands / logs /
  credentials, sync state, quotas, platform access grants (42 in all, listed in `supabase/tests/rls_invariants.sql`) — hold
  no INSERT / UPDATE / DELETE privilege for `authenticated` / `anon` and carry explicit restrictive denials: the API writes
  them in the system step after its own checks (segregation of duties, state machine, branch scope). A client session
  cannot approve, move or withdraw a leave, excuse a day or edit an approval trail around the engine.
- **No data API.** PostgREST / pg_graphql log in as `authenticator`; a restrictive `<table>_no_data_api` policy (through the
  `flowza_client` group role, inherited by `authenticated` and `anon`) refuses every row to that login on every table. The
  web talks to `/api/v1` only; Supabase is used for Auth, Realtime broadcast and Storage, which evaluate policies under their
  own logins.
- **Partitions** (monthly / default partitions of events, raw transactions, device and sync logs) have RLS forced and no
  client privilege: they are reached through their parent only; `app.ensure_month_partitions` locks the partitions it creates.
- **SECURITY DEFINER** functions pin `search_path` and are not executable by PUBLIC / anon.
- Append-only tables (raw transactions, events, audit logs, history, decisions) refuse UPDATE / DELETE by trigger.

## Approvals: segregation of duties

- Nobody decides a request they filed or that is about them — as HR, as a manager holding the approving role, through a
  delegation (a delegation to oneself is refused; a delegation to the requester never seats them on their own request) or
  in a bulk decision (per-line refusal). `allow_self_approval` cannot be switched on (`approval_workflows_no_self_approval`).
  Segregation follows the CURRENT membership link, so a login linked to the subject after submission is refused too.
- A decision names the level the caller saw: a level that is not current cannot be decided; a repeated decision is a no-op.
- The single owner of an organisation may decide their own requests; that bypass is recorded.
- One-click e-mail links: a random token stored as a hash, bound to its recipient and action, single-use (its sibling
  is spent with it), expiring (7 days), limited to 20 attempts / minute per IP and user, and never acting on a GET — the
  landing page asks for confirmation and POSTs.

## Tenant isolation guarantees

1. RLS on every table; tenant tables through the generators; `rls_invariants.sql` fails CI for any table that is not.
2. Composite foreign keys carry `organization_id`; `organization_id` is immutable.
3. `organization_id` never comes from a request body: a self-service request cannot name the tenant, the employee or the
   acting user at all (`schema-traps.test.ts`), and unknown keys are dropped (or refused by the few strict schemas).
4. Storage object policies derive the tenant from the first path segment and reuse the same helpers.
5. Realtime private channels `org:<uuid>:*` / `user:<uuid>:*` are authorised via RLS on `realtime.messages`; clients cannot
   publish.
6. Tests: `supabase/tests/rls_*.sql` (incl. the generated cross-tenant probe of `rls_invariants.sql`),
   `packages/database/src/queue.db.test.ts`, `apps/api/src/test/route-authz.test.ts`.

## Storage

Five private buckets; the organisation is the first path segment.

| Bucket | Content | Read | Write |
|---|---|---|---|
| `org-logos` | organisation logo | members | `organization.manage` |
| `employee-photos` | employee photos | who may see the employee (employee RLS) | `employee.update` in branch scope |
| `employee-photos` · `checkins/…` | selfie check-ins, `checkins/<org>/<employee>/<id>.<ext>` | **no client access** (restrictive policy): served by the API only, re-validated, as a 60-second data URL, to the employee, their line managers and the attendance reviewers in scope | the API only, after the check-in rules |
| `documents` | identity documents | `employee.view_sensitive` in branch scope | `employee.update` in branch scope |
| `imports` | uploaded import files | `employee.import` | `employee.import` |
| `reports` | generated report files | system context; users download through a short-lived signed URL after a `report.view` + `report.export` check | system context |

Selfies are sniffed (JPEG / PNG / WebP by structure; HTML / SVG / polyglots refused), ≤ 2 MB, and stored under a path the
server builds from the caller's own organisation and employee — never from the upload's name or form fields.

## Secrets (ADR-003)

- Device credentials are encrypted in the application with AES-256-GCM under master keys from
  `FLOWZA_CREDENTIALS_MASTER_KEYS` (`key_id:base64`, first key encrypts, all decrypt → rotation by re-encrypt job).
  The device id is bound as AAD so ciphertext cannot be moved between devices.
- Stored in `device_credentials` — no `authenticated` grant, no client policy; only `secrets.*` SECURITY DEFINER
  functions in system context can read/write. UI receives `masked` values (`****abcd`) and a version.
- Webhook secrets / device push tokens / invitation and e-mail tokens are hashed when equality is all that is needed.
- Logs redact `password|token|secret|apiKey|credentials|template|pin|nationalId` paths (`@flowza/shared` logger).
- Audit payloads pass through `redactForAudit()`.
- The browser bundle carries public values only (`VITE_SUPABASE_URL`, the publishable anon key, `VITE_API_URL`):
  `apps/web/src/test/secret-hygiene.test.ts` fails on a service-role key, a secret key, a private key, a password literal or
  a secret value in a committed env file.

## API hardening

- Standard error envelope without stack traces; Zod validation on every input; CORS allow-list; secure headers; request ids.
- Every request field is bounded (arrays `maxItems`, text `maxLength`, maps bounded keys / values); a PATCH carries only
  the fields sent (no schema default re-applied); batch endpoints refuse one item over their cap (400) before acting.
- Body limit 25 MB (selfie photos 2 MB, imports read only after `employee.import` is checked).
- Per-IP and per-user rate limits (in-memory per instance — put an edge limiter in front for multi-instance deployments);
  the inbound router's own limiter applies to `/device-push/*` and `/webhooks/*` only.
- Punch integrity: the punch time is the server's clock (a queued / client time is kept for information only); a replayed
  idempotency key stores one raw row; a mocked location is refused under the `block` geofence policy, flagged under
  `flag`, and recorded as a mock in the raw payload in every case.
- Exports need `report.export`, escape cells starting with `= + - @ \t \r`, are audited with their row count and are
  quota-bound per organisation.
- Idempotency keys on job-creating endpoints.

## Inbound device/webhook endpoints

- Vendor webhooks: signature validation per provider, replay protection by `(provider_key, event_id)` and payload hash,
  fast 2xx, processing in the worker.
- Device push protocols: device identified by serial; unknown serials land in `pending_devices` (quarantine) until an
  admin claims them; strict parsing (`ProtocolError`), size limits and rate limiting (per IP and per serial).

## Privacy

No biometric templates are stored centrally (feature-flagged and encrypted if a vendor requires it). Identity documents
live in a separate table gated by `employee.view_sensitive`. Retention policies default to *keep*; deletion is a
scheduled, audited job. See `docs/risks.md` for GCC regulatory notes (Oman PDPL, UAE/KSA PDPL).

## Testing the model

| Suite | What it proves |
|---|---|
| `supabase/tests/rls_invariants.sql` | Catalogue-driven, for every table present and future: RLS on (forced where needed), owners, anon never bound, org-leading + FK indexes, the tenant-key trigger (and that it refuses a move), the data-API denial, locked partitions, RPC-only tables without privilege or permissive write policy, privilege ⇒ policy, SECURITY DEFINER hygiene, schema USAGE; plus a **generated cross-tenant probe**: organisation A's rows are cloned into B and C, and a member of A holding every permission reads 0 rows of B, cannot update / delete / insert them (blind statements, with positive controls on A), and cannot read rows of C addressed to them. |
| `supabase/tests/rls_data_api.sql` | As `authenticator`: every table reads 0 rows, blind writes affect 0 rows, inserts are refused. |
| `apps/api/src/test/route-authz.test.ts` | Every `/orgs/:orgId` route: 401 without a session, 403 for another organisation's member and a platform admin without a grant, 403 / 404 for a member without the key (behind validation too), never 5xx; every `/platform` route: 401 / 403. |
| `apps/api/src/test/schema-traps.test.ts` | Every route's body / query schema: PATCH / PUT `{}` → `{}`, one-field PATCH carries one field, unknown keys dropped or refused (never passed through), everything bounded, no identity field in a self-service request. |
| `apps/api/src/test/abuse.test.ts` | Client-supplied identifiers, replayed punches, client times, mocked locations, self-approval, locked approvals, batch caps, exports, selfie uploads, e-mail links. |
| `apps/api/src/test/middleware-scope.test.ts` | The inbound router's middlewares apply to its own paths only. |
| `apps/web/src/test/secret-hygiene.test.ts` | Secrets in the bundle and in committed env files. |

## Operational

- Separate database roles/passwords per environment; the Supabase service-role key is used only for Realtime broadcast
  and Storage signing, never for data access.
- Dependency audit (`pnpm audit --prod`) + secret scanning in CI (`.github/workflows/ci.yml`), Dependabot weekly.
- Backups: Supabase daily backups + PITR on paid plans; see `docs/deployment.md` for RPO/RTO.
