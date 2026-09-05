# FlowZa Time — Engineering Guide (read before changing code)

FlowZa Time is a multi-tenant cloud attendance SaaS (Oman → GCC). Blueprint: `docs/blueprint.md`; decisions: `docs/adr/`.
Priorities, in order: **Security > Reliability > Data Integrity > Scalability > Maintainability > Performance > UX**.

## Repository layout
```
apps/web              React 19 + Vite + TS (features/<domain>/…), Tailwind v4 + Radix, TanStack Query, RHF + Zod, i18next (en/ar, RTL)
apps/api              Hono (Node 22) REST API /api/v1 — routes → services → repositories; RLS-scoped DB access per request
apps/worker           Node worker: scheduler (leader-elected), queue consumers, sync handlers, attendance processing, reports, outbox relay
packages/shared       AppError/errors, pino logger (redaction), env loading, time helpers (Luxon), ids, Result utils
packages/contracts    Zod schemas + enums + DTO types shared by api/web/worker (single source of truth for API shapes)
packages/domain       PURE domain logic (no IO): attendance engine, shift resolution, retry policy, authorization types
packages/device-providers  DeviceProvider interface, registry, mock provider, push-protocol handlers, vendor placeholders
packages/database     Kysely client, generated types (src/generated/db.ts), withContext() RLS impersonation, PgJobQueue, secrets, audit, outbox
supabase/migrations   THE schema (72 tables). supabase/tests: local Supabase shim + RLS SQL tests. scripts/: local Postgres helpers
```

## Non-negotiable rules
1. **Tenant isolation.** Every tenant row has `organization_id`. All DB access from api/worker goes through
   `withContext(db, ctx, trx => …)` from `@flowza/database` (user context or system-for-org context). Never use a
   superuser/service-role connection in application code. Never accept `organizationId` from a request body — it comes
   from the route (`/orgs/:orgId/…`) and is checked against the caller's memberships.
2. **Authorization twice.** Services check permissions explicitly (`requirePermission(principal, orgId, 'employee.update')`)
   and RLS enforces them again. Permissions come from the DB (`@flowza/contracts` `PERMISSIONS`), never from the JWT.
3. **Immutability.** Raw transactions, events, audit logs and history tables are append-only (DB triggers enforce it).
   Corrections void + add events; recomputation creates a history snapshot.
4. **No vendor code outside `packages/device-providers`.** The engine/API/UI only see `RawTransaction`, `DeviceEmployee`,
   capabilities and `ProviderError`. Placeholder providers must throw `ProviderError('NOT_IMPLEMENTED')` — never fake success.
5. **Async by default.** Anything touching devices, generating reports or importing files returns a job id
   (`{ jobId, status: 'QUEUED' }`) and runs in the worker through `JobQueue.enqueue(...)` (same transaction as the state change).
6. **Secrets.** Device credentials only via `DeviceCredentialsStore` (system context). Never log/return them; UI gets `masked`.
7. **Errors.** Throw `AppError` (`@flowza/shared`) with a stable code; the API maps it to `{ code, message, requestId }`.
   Never leak stack traces or SQL.
8. **Logs.** `createLogger()` from `@flowza/shared`, structured `event()` fields, always include `requestId`/`jobId`/`organizationId`.
9. **Validation.** Zod schemas from `@flowza/contracts` at the API boundary; DB constraints as the last line.
10. **No new dependencies** without a note in your final report (they must be added to the right package.json and installed
    once by the integrator). Prefer what is already installed (see package.json files).

## Working in this repo
```bash
pnpm install                       # already done in this environment; do NOT re-run with new deps concurrently
pnpm build:packages                # build packages/* in dependency order (workspace deps resolve via dist/)
pnpm --filter @flowza/<pkg> run test      # vitest unit tests for a package
pnpm --filter @flowza/database run test:db  # DB integration tests (needs local Postgres, see below)
pnpm lint && pnpm typecheck
bash scripts/local-pg.sh start     # local Postgres 16 on 127.0.0.1:54329 (already running here)
bash scripts/db-reset-local.sh     # recreate `flowza` DB: shim + all migrations (+ --seed)
bash supabase/tests/run-rls-tests.sh  # SQL RLS isolation suites
```
- Workspace packages are consumed through their `dist/` output: after changing a package, run its `build` before
  typechecking dependants.
- TypeScript is strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`). Use `import type` for types. ESM only (`.js`
  suffixes in relative imports inside packages/apps).
- Tests: vitest. Unit tests next to code (`*.test.ts`); DB tests `*.db.test.ts` (database package) use `createTestDatabase()`.
- Time: store UTC; convert with Luxon using the branch/device IANA zone; never hand-compute offsets.
- i18n: every user-facing string in `apps/web` goes through `t('key')`; add keys to both `en` and `ar` resource files.
- Commit style: `feat(scope): …`, `fix(scope): …`, `docs: …`. Do not commit secrets. `.env.example` documents config.

## Execution contexts (packages/database/src/context.ts)
```ts
await withContext(db, { kind: 'user', userId, requestId }, async (trx) => { /* RLS as the user */ });
await withContext(db, { kind: 'system', organizationId, jobId }, async (trx) => { /* RLS scoped to one org */ });
await withContext(db, { kind: 'platform', jobId }, async (trx) => { /* cross-tenant maintenance: whitelisted tables only (migration 2000) */ });
```
`platform` is for outbox relay, metering, partition upkeep and scheduler scans. It cannot read employees' personal data beyond
counts, cannot write tenant business tables, and every use must be in apps/worker. Tenant work always uses `system` with one org.
The API's pool connects as `flowza_api` (may SET ROLE authenticated / flowza_system); the worker's pool as `flowza_worker`.

## Attendance engine contract (packages/domain/src/attendance/types.ts)
`calculateDailyRecord(input: DailyCalculationInput): DailyCalculationResult` — pure, deterministic, fully traced.
Attendance date attribution uses the shift punch window (see docs/blueprint.md §G.3).

## Provider contract (packages/device-providers/src/types.ts)
Implement `DeviceProvider`; register in the `ProviderRegistry`; keep `device_providers` reference data
(supabase/migrations/*_reference_data.sql) in sync with `definition`.

## Service-level rules added after the security/SRE review (apply when implementing the API/worker)
- **Device credentials are scoped**: `DeviceCredentialsStore.put/get(trx, { organizationId, deviceId }, …)`. Changing a device's
  `endpoint_url`/host/port/protocol must **invalidate stored credentials** (delete + audit) and require re-entry; `testConnection`
  may only use credentials supplied in the same request or the stored ones for the *unchanged* endpoint. Outbound provider calls go
  through one egress helper that blocks private IP ranges and cross-host redirects.
- **Push devices** authenticate with serial + per-device push token (hash in `devices.push_token_hash`, rotate via
  `push_token_rotated_at`); unknown serials → `pending_devices`; per-serial rate limits; raw rows from push carry `source='DEVICE_PUSH'`.
- **Dedupe hash** = sha256(`device_id|device_generation|device_employee_id|punched_at|verification|direction`); bump `devices.generation`
  when a device is factory-reset / re-registered (invalidates cursors → reconciliation job).
- **Timestamps**: raw rows store `device_local_time` (verbatim), `assumed_timezone`, `clock_skew_seconds`; punches with skew beyond
  the org threshold or in the future → `processing_status='quarantined'`; punches inside a locked period → `'held'` (HR decides).
- **Cursors** are validated by the provider; unparseable cursor → reset to a safe time-based cursor, `invalid_since` set, alert emitted;
  operator rewind stores `previous_cursor`, `rewound_by`, `rewind_reason`.
- **Circuit breaker** per (org, provider, account) in `provider_circuit_states`; open circuit → devices show `vendor_degraded`, not `offline`.
- **Invitations**: token ≥ 128 bits random, only the sha256 hash stored, 7-day expiry, single use, bound to the lower-cased email;
  compare with `timingSafeEqual`. Suspension / role downgrade → revoke the user's sessions through the Supabase Auth admin API.
- **MFA**: when `organization_settings.security.mfaRequired` is true (or the caller is a platform admin), require `aal2` in the JWT →
  otherwise `403 FORBIDDEN` with code detail `MFA_REQUIRED`.
- **Roles**: actors can only grant permissions they hold (DB trigger `role_permissions_no_escalation` + service check); system roles are
  immutable; the last active owner cannot be demoted; ownership transfer is two-step.
- **Platform grants**: default 8 h, max 72 h; write grants need `approved_by` (second platform admin); org owners can list grants on their org.
- **Exports**: sensitive columns (national id, passport, DOB, phone, address) masked unless `employee.view_sensitive`; escape cells
  starting with `= + - @ \t \r` (formula injection); every export audited with row count; per-org quotas via `usage_quotas`.
- **Raw payloads**: providers declare an allowlist; binary/template/photo fields are stripped and replaced by a sha256; size cap 16 KB.
- **Termination** (`employment_status → terminated/resigned`) enqueues `DELETE_EMPLOYEE` for every device the employee is enrolled on.
- **Realtime** carries invalidation signals only (ids + event type), coalesced per org channel (≤ 1 message / 5 s); UI refetches via API
  and always has polling as baseline (kill switch flag `realtime_progress`).
- **Notifications** dedupe by (device, state) within 15 min and use hysteresis (N consecutive failures) before "offline".
- **Retention**: platform floors per data class (raw ≥ 365 d, daily records ≥ 730 d) and `organizations.legal_hold` block purges;
  purge = partition detach + archive export, delayed 7 days, cancellable, audited.
- **Migrations**: every migration sets `lock_timeout = '5s'`/`statement_timeout` for DDL on hot tables; indexes on hot tables use
  `CONCURRENTLY` (non-transactional file); expand → backfill (worker job) → contract.
- **Connection budget**: API pool ≤ 10 per instance, worker ≤ 10 per process (+1 scheduler session connection); sum below the Supabase
  tier limit with 30% headroom; transaction pooler for API, session pooler/direct for the worker.

## Zod 4 pitfalls (found in review — apply everywhere)
- `.partial()` of a schema that carries `.default(...)` **re-applies the defaults** on PATCH: a single-field update resets every
  defaulted field. Build update schemas without defaults (e.g. `schema.omit(...).partial()` only when no defaults remain, or
  define explicit update schemas with `.optional()` fields) and write a test that PATCHes one field and asserts nothing else changed.
- `z.coerce.boolean()` treats the string `'false'` as `true`. Use the shared `booleanQuerySchema` from `@flowza/contracts`
  (`'true' | 'false' | '1' | '0'`) for query parameters.
