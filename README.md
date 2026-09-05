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

## Quality gates
`pnpm verify` runs lint, typecheck, unit tests and builds; `bash supabase/tests/run-rls-tests.sh` and `pnpm test:db`
prove tenant isolation on a real Postgres. CI (`.github/workflows/ci.yml`) runs all of them plus dependency audit and
secret scanning.

## Licence
Proprietary — © F & Z Capital. All rights reserved.
