# FlowZa Time

**Cloud attendance & workforce time management for the GCC** — multi-tenant SaaS by F & Z Capital. Launching in Oman,
designed for UAE, Saudi Arabia, Qatar, Kuwait and Bahrain (English + Arabic, RTL).

FlowZa Time connects attendance machines from many vendors (ZKTeco, Hikvision, Suprema, Anviz, eSSL, FingerTec,
Matrix, NITGEN …) to one cloud: employees are pushed to devices, punches flow back automatically, and an explainable
attendance engine turns them into payroll-ready records — with row-level tenant isolation, audit trails and
asynchronous synchronisation built for 500+ devices and 10,000+ employees per organisation.

```
Device / Vendor cloud  →  Provider adapter  →  Sync engine (fair queue)  →  Raw transactions (immutable)
                                                                          →  Events  →  Daily records (traced)
                                                                          →  Corrections / approvals  →  Period summaries
```

## Documentation
| Doc | Purpose |
|---|---|
| [`docs/blueprint.md`](docs/blueprint.md) | Product + architecture blueprint (modules, Supabase usage, database, integrations, sync, engine, security, frontend, API, scalability, roadmap, risks) |
| [`docs/adr/`](docs/adr) | Architecture decision records 001–007 |
| [`docs/database.md`](docs/database.md) · [`docs/security.md`](docs/security.md) | Schema/migrations · security model |
| [`docs/device-integrations.md`](docs/device-integrations.md) | Vendor due-diligence, compatibility matrix, adding a provider |
| [`docs/attendance-engine.md`](docs/attendance-engine.md) · [`docs/sync-engine.md`](docs/sync-engine.md) | Calculation rules · synchronisation |
| [`docs/api.md`](docs/api.md) | REST API reference |
| [`docs/development.md`](docs/development.md) · [`docs/testing.md`](docs/testing.md) · [`docs/deployment.md`](docs/deployment.md) · [`docs/troubleshooting.md`](docs/troubleshooting.md) | Operate the system |
| [`docs/risks.md`](docs/risks.md) | Risks, compliance notes, challenged assumptions |
| [`AGENTS.md`](AGENTS.md) | Engineering rules for contributors (human or AI) |

## Stack
React 19 + Vite + TypeScript · Hono (Node 22) API · Node worker · **Supabase** (Postgres + RLS, Auth, Storage,
Realtime) · Kysely · Zod · TanStack Query · Tailwind v4 + Radix · Luxon · Vitest · pnpm workspaces.

## Quick start
```bash
pnpm install
cp .env.example .env && cp apps/web/.env.example apps/web/.env.local
bash scripts/local-pg.sh start           # native Postgres 16 (no Docker required)
bash scripts/db-reset-local.sh --seed    # migrations + deterministic demo data (Al Bahja Trading, 500 employees, 20 devices)
pnpm build:packages
pnpm dev:api & pnpm dev:worker & pnpm dev:web
```
Full instructions: [`docs/development.md`](docs/development.md). Demo users (local only): `owner@albahja.example`,
`hr@albahja.example`, `sohar.manager@albahja.example`, `devices@albahja.example`, `payroll@albahja.example`,
`employee@albahja.example` — password `FlowZa-Demo-2026!` (requires the Supabase Auth stack).

## Repository layout
```
apps/web · apps/api · apps/worker
packages/shared · packages/contracts · packages/domain · packages/device-providers · packages/database
supabase/migrations · supabase/tests · supabase/functions · scripts · docs
```

## Implementation status (honest)

| Area | State |
|---|---|
| Database — 21 migrations, 74 base tables, RLS on every tenant table, job queue, partitions, envelope-encrypted credentials | **Working**, proven by the SQL isolation suites and integration tests |
| Attendance engine, shift/rule resolution, period summaries (pure, traced) | **Working** — 156 tests |
| Device provider framework, registry, conformance suite, deterministic mock provider | **Working** — 140 tests |
| ZKTeco PUSH/ADMS protocol (handshake, ATTLOG, commands, OPERLOG) | **Beta, never run against hardware** — `verification_status = REPORTED`; see the checklist in `docs/device-integrations.md` §6 |
| Hikvision, Suprema, Anviz, eSSL, FingerTec, Matrix, NITGEN | **Placeholders that fail with `NOT_IMPLEMENTED`** — never presented as working |
| API — 178 authenticated endpoints plus device-push and webhook ingress | **Working** — 114 tests incl. an adversarial security suite |
| Worker — sync, attendance processing, notifications, maintenance | **Working** — 74 tests |
| Web — 35 routes across employees, organisation, users, settings, audit, search, devices, sync, attendance, corrections, approvals, schedule, leave, reports, payroll, platform (en + ar, RTL) | **Working** — 64 component tests, 18 UI end-to-end tests |
| Seed — 1 organisation, 5 branches, 20 departments, 500 employees, 20 devices, 30 days (~22k punches through the real engine) | **Working** |
| Supabase hosted project, Auth stack, Storage, Realtime authorisation policies | **Not provisioned** — everything runs against local Postgres with a Supabase-compatibility shim (`supabase/tests/00_local_supabase_shim.sql`) |
| Platform-wide feature-flag defaults, full-stack E2E against a seeded Supabase stack | **Not implemented** — tracked in `docs/risks.md` and `docs/device-integrations.md` §8 |

Known limits worth stating: rate limiting and idempotency storage are per API instance (multi-instance needs an edge limiter or a shared store), zero-touch device claiming trusts serial knowledge (risk D26), and the web main chunk is ~245 kB gzipped because every feature registers its translations eagerly.

## Quality gates
`pnpm verify` runs lint, typecheck, unit tests and builds. `bash supabase/tests/run-rls-tests.sh` and `pnpm test:db`
prove tenant isolation on a real Postgres; `pnpm --filter @flowza/api test` and `pnpm --filter @flowza/worker test` run the
API and worker suites against per-file test databases; `pnpm --filter @flowza/web run build:e2e && pnpm --filter @flowza/web
run test:e2e` runs the Playwright UI suite. CI (`.github/workflows/ci.yml`) runs all of them plus dependency audit and
secret scanning.

## Licence
Proprietary — © F & Z Capital. All rights reserved.
