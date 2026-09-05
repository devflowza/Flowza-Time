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
```
The API's pool connects as `flowza_api` (may SET ROLE authenticated / flowza_system); the worker's pool as `flowza_worker`.

## Attendance engine contract (packages/domain/src/attendance/types.ts)
`calculateDailyRecord(input: DailyCalculationInput): DailyCalculationResult` — pure, deterministic, fully traced.
Attendance date attribution uses the shift punch window (see docs/blueprint.md §G.3).

## Provider contract (packages/device-providers/src/types.ts)
Implement `DeviceProvider`; register in the `ProviderRegistry`; keep `device_providers` reference data
(supabase/migrations/*_reference_data.sql) in sync with `definition`.
