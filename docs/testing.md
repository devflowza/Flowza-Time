# Testing

| Layer | Tool | Location | Runs where |
|---|---|---|---|
| Unit — attendance engine, providers, retry policy, contracts | Vitest | `packages/*/src/**/*.test.ts` | every CI run, milliseconds |
| Database integration — queue semantics, RLS impersonation, secrets, audit | Vitest + Kysely on real Postgres | `packages/database/src/**/*.db.test.ts` (`pnpm test:db`) | CI `database` job, local Postgres |
| RLS isolation suites (SQL) | psql scripts with assertions | `supabase/tests/rls_isolation.sql`, `rls_system_context.sql` (`bash supabase/tests/run-rls-tests.sh`) | CI `database` job |
| API — auth, authorization, validation, error envelope | Vitest + Hono `app.request()` with a test database | `apps/api/src/**/*.test.ts` | CI |
| Worker — handlers with mock provider, scheduler | Vitest + test database | `apps/worker/src/**/*.test.ts` | CI |
| Web — components/hooks | Vitest + Testing Library (jsdom) | `apps/web/src/**/*.test.tsx` | CI |
| E2E — critical flows (sign-in, create employee, register mock device, sync, view attendance, correction/approval) | Playwright against the seeded stack | `e2e/` (planned) | nightly / pre-release |

## Critical test cases (§75) and where they live
| Case | Test |
|---|---|
| Organisation A cannot access Organisation B | `rls_isolation.sql` (owner A/B, filter by other org id), `queue.db.test.ts` (system context) |
| Branch manager cannot access another branch / spoof `branch_id` | `rls_isolation.sql` (branch manager section: reads, `WITH CHECK` on update) |
| Employee self-service sees only own rows | `rls_isolation.sql` |
| Forged system claim from a user session | `rls_isolation.sql` ("forged system claim … sees nothing") |
| Platform admin without/with reason-based grant | `rls_isolation.sql` |
| Credentials never readable by users; decryptable only in system context; bound to device id | `rls_isolation.sql`, `queue.db.test.ts` (DeviceCredentialsStore) |
| Login roles have no direct table access (stray query outside `withContext`) | `queue.db.test.ts` (noinherit) |
| Duplicate attendance transaction (provider id and hash fallback) | unique indexes in `1100_attendance.sql`; ingestion tests in worker |
| Offline provider / timeout / auth failure / rate limit → retry or dead-letter | `packages/domain/src/sync/retry.test.ts`, mock provider scenarios, worker handler tests |
| Fair scheduling across organisations, dedupe, backoff, dead letters, stale lock reaping | `queue.db.test.ts` |
| Overnight shift, late/early/overtime, rounding, missing punch behaviours, holiday, weekly off, leave, Ramadan, flexible shift | `packages/domain/src/attendance/*.test.ts` |
| Rotational pattern and assignment specificity; effective-dated rule sets | `resolve-shift.test.ts` |
| Period lock blocks recomputation | trigger in `1100_attendance.sql`; API test on corrections |
| Migrations apply from scratch and generated types are current | CI `database` job |

## Conventions
- Deterministic tests only: no wall-clock (`now` is an input), seeded PRNG for generated data, fake timers for throttlers.
- Every RLS-relevant table change ships with an assertion in `rls_isolation.sql`.
- DB tests create an isolated database per file (`createTestDatabase()`) and drop it afterwards.
- Provider adapters must pass `describeProviderConformance()` before being marked `beta`/`available`.

## Running locally
```bash
pnpm test:unit
bash scripts/local-pg.sh start && bash supabase/tests/run-rls-tests.sh && pnpm test:db
```
