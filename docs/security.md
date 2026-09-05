# Security Model

Priorities: Security > Reliability > Data Integrity. This document describes the controls as implemented.

## Identity

- Supabase Auth issues JWTs (email/password; TOTP MFA enrolment supported; SSO later). Sign-up is disabled — users
  join by invitation. Password policy: ≥12 chars, mixed classes (`supabase/config.toml`).
- The API verifies tokens with the project's JWKS (asymmetric) and falls back to HS256 with the legacy JWT secret.
  Only `role = authenticated` tokens are accepted by the API.
- Login attempts are recorded in `login_history` by the Auth **password verification hook**
  (`app.on_password_verification_attempt`).

## Authorization (ADR-002)

- Permissions (`permissions` table, 44 keys) → roles (system + custom) → memberships (`org_memberships`) with optional
  branch scope (`membership_branches`). Nothing authorisation-relevant is stored in the JWT; the API loads the principal
  from the database on every request (`apps/api/src/lib/principal.ts`), so suspensions and role changes are immediate.
- Two layers on every request:
  1. **Service layer** — `requireMembership`, `requirePermission`, `requireBranchAccess` (`apps/api/src/lib/authorize.ts`)
     give clear `FORBIDDEN` errors and route-level tenant checks (`/orgs/:orgId/...`).
  2. **Row Level Security** — `withContext()` sets `SET LOCAL ROLE authenticated` + `request.jwt.claims` for the user, or
     `SET LOCAL ROLE flowza_system` + `{"role":"flowza_system","org_id":…}` for one organisation. Policies are generated
     by `app.apply_tenant_policies()` from three uncorrelated helper arrays (org ids with permission, unrestricted org
     ids, allowed branch ids) so they are evaluated once per statement and remain index-friendly.
- `app.is_system()` requires both the claim and `current_setting('role') = 'flowza_system'`; only `flowza_api` and
  `flowza_worker` are members of that role, so a forged claim from a user session or PostgREST can never become system
  (covered by `supabase/tests/rls_isolation.sql`).
- Platform administrators (`platform_admins`) see organisation metadata but no tenant data unless an active,
  time-boxed (≤30 days), reason-bearing `platform_access_grants` row exists. Grants are auditable and revocable.

## Tenant isolation guarantees

1. RLS enabled on every table (`1400_rls_policies.sql` fails the migration otherwise).
2. Composite foreign keys carry `organization_id`.
3. Storage object policies derive the tenant from the first path segment and reuse the same helpers.
4. Realtime private channels `org:<uuid>:*` / `user:<uuid>:*` are authorised via RLS on `realtime.messages`; clients cannot publish.
5. `organization_id` never comes from a request body.
6. Tests: `supabase/tests/rls_isolation.sql`, `rls_system_context.sql`, `packages/database/src/queue.db.test.ts`.

## Secrets (ADR-003)

- Device credentials are encrypted in the application with AES-256-GCM under master keys from
  `FLOWZA_CREDENTIALS_MASTER_KEYS` (`key_id:base64`, first key encrypts, all decrypt → rotation by re-encrypt job).
  The device id is bound as AAD so ciphertext cannot be moved between devices.
- Stored in `device_credentials` — no `authenticated` grant, no client policy; only `secrets.*` SECURITY DEFINER
  functions in system context can read/write. UI receives `masked` values (`****abcd`) and a version.
- Webhook secrets / device push tokens are hashed when equality is all that is needed.
- Logs redact `password|token|secret|apiKey|credentials|template|pin|nationalId` paths (`@flowza/shared` logger).
- Audit payloads pass through `redactForAudit()`.

## API hardening

Standard error envelope without stack traces; Zod validation on every input; body limit 25 MB; CORS allow-list;
secure headers; per-IP and per-user rate limits (in-memory per instance — put an edge limiter in front for multi-instance
deployments); idempotency keys on job-creating endpoints; request ids on every response and log line.

## Inbound device/webhook endpoints

- Vendor webhooks: signature validation per provider, replay protection by `(provider_key, event_id)` and payload hash,
  fast 2xx, processing in the worker.
- Device push protocols: device identified by serial; unknown serials land in `pending_devices` (quarantine) until an
  admin claims them; strict parsing (`ProtocolError`), size limits and rate limiting.

## Privacy

No biometric templates are stored centrally (feature-flagged and encrypted if a vendor requires it). Identity documents
live in a separate table gated by `employee.view_sensitive`. Retention policies default to *keep*; deletion is a
scheduled, audited job. See `docs/risks.md` for GCC regulatory notes (Oman PDPL, UAE/KSA PDPL).

## Operational

- Separate database roles/passwords per environment; the Supabase service-role key is used only for Realtime broadcast
  and Storage signing, never for data access.
- Dependency audit + secret scanning in CI (`.github/workflows/ci.yml`), Dependabot weekly.
- Backups: Supabase daily backups + PITR on paid plans; see `docs/deployment.md` for RPO/RTO.
