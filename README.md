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
| [`docs/adr/`](docs/adr) | Architecture decision records 001–008 |
| [`docs/database.md`](docs/database.md) · [`docs/security.md`](docs/security.md) | Schema/migrations · security model |
| [`docs/device-integrations.md`](docs/device-integrations.md) | Vendor due-diligence, compatibility matrix, adding a provider |
| [`docs/attendance-engine.md`](docs/attendance-engine.md) · [`docs/sync-engine.md`](docs/sync-engine.md) | Calculation rules · synchronisation |
| [`docs/api.md`](docs/api.md) | REST API reference |
| [`docs/pricing.md`](docs/pricing.md) | Plans and pricing (OMR), modules and how they are switched, invoices and payments |
| [`docs/reports.md`](docs/reports.md) | Report generation: pipeline, the fourteen sample layouts, notations and codes, adding a report type |
| [`docs/design.md`](docs/design.md) | Design system: tokens, RTL rules, density, accessibility floor, multi-step flows |
| [`docs/development.md`](docs/development.md) · [`docs/testing.md`](docs/testing.md) · [`docs/deployment.md`](docs/deployment.md) · [`docs/go-live.md`](docs/go-live.md) · [`docs/troubleshooting.md`](docs/troubleshooting.md) | Operate the system |
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
| Database — 52 migrations; 97 tables in `public` (plus 148 monthly partitions), RLS on every one of them and on every partition, no table reachable through the data API (PostgREST), job queue, envelope-encrypted credentials | **Working**, proven by the SQL isolation and invariant suites (`supabase/tests`) and the integration tests |
| Attendance engine, shift/rule resolution, day marks (loss of pay, unexcused / excused), punch windows, day close, period summaries (pure, traced) | **Working** — 347 tests in `@flowza/domain` |
| Device provider framework, registry, conformance suite, deterministic mock provider | **Working** — 286 tests |
| ZKTeco PUSH/ADMS protocol (handshake, ATTLOG, commands, OPERLOG) | **Beta, never run against hardware** — `verification_status = REPORTED`; see the checklist in `docs/device-integrations.md` §6 |
| Hikvision, Suprema, Anviz, eSSL, FingerTec, Matrix, NITGEN | **Placeholders that fail with `NOT_IMPLEMENTED`** — never presented as working |
| API — 302 authenticated `/api/v1` endpoints plus device-push and webhook ingress; route authorisation matrix, request caps, abuse tests across two organisations | **Working** — 489 tests incl. an adversarial security suite |
| Worker — sync, attendance processing, approval reminders and escalation, notifications (e-mail + in-app, missing check-out reminder, retention), report schedules, Flowza Finance sync, maintenance; job locks kept alive by a heartbeat, outcomes recorded only by the attempt that holds the job, unfinished jobs handed back at shutdown | **Working** — 263 tests |
| Web — dashboard (tenant-selectable styles and layouts), employees, organisation, users, settings, audit, search, devices, sync, attendance, corrections, approvals inbox and history, schedule, leave, reports, payroll, platform; the employee portal (`/my`), the manager workspace and the HR attendance workspace (en + ar, RTL) | **Working** — 479 component tests, 74 UI end-to-end runs (desktop + tablet) |
| HR portal (Flowza Finance parity) — roles incl. Line Manager and Auditor, multilevel approvals (any / all / quorum, delegation, escalation, e-mail actions), employee self-service (web check-in with geofences, selfie, late / absence reasons, regularisation, shift swaps, leave, comp-off), leave v2 (allocations, carry-forward, year close), notifications v2 | **Working** — built in `docs/hr-portal/prompt-pack.md` Prompts 1–10; local E2E matrix green (`docs/hr-portal/reports/11-e2e-matrix.md`); hosted run in `docs/hr-portal/reports/12-ship.md` |
| Flowza Finance attendance sync connector (pull / push through Finance `attendance-export` / `attendance-ingest`) | **Built, disabled in production** — no tenant has a connector device; the Finance-side function is not deployed |
| Seed — 1 organisation, 5 branches, 20 departments, 500 employees, 20 devices, 30 days (~22k punches through the real engine) | **Working** (local) |
| Demo tenant seed — Majan Gulf Trading (Oman), 53 employees, 10 logins covering every system role, six months of terminal punches through the real engine (`supabase/seeds/demo-tenant`) | **Loaded on the hosted project** |
| Hosted stack — Supabase project `liyilmbklsextsggflbb` (Auth, Storage, Realtime policies), API and workers on Fly.io (`time-api.flowza.ai`), web on Cloudflare Pages (`time.flowza.ai`, builds `main`) | **Live** — every migration applied (the job-queue fix `20260929000700` on 2026-09-30); see `docs/go-live.md` and `docs/hr-portal/reports/12-ship.md` |
| Super-admin portal (`/adm`, Flowza Finance parity) — own sign-in with MFA, fleet dashboard, tenants (edit details, subscription and trial, members, flags, support access, internal notes, account manager and tags, activity), users directory, admin team, grants, plans, feature flags, platform activity, health | **Working** — migration 20260929000400, API tests in `apps/api/src/test/platform-admin.test.ts` |
| Modules, plans & pricing, billing (Flowza Finance `/adm` parity) — per-tenant and fleet-wide module switches enforced by the API, the worker and the web; plan editor with OMR pricing (reference: Professional, 500 OMR a year for 11 users); invoices, payments, refunds, subscription activation on payment; paid users cap employees; platform settings; the tenant's Settings → Subscription | **Working** — migration 20260929000600, `docs/pricing.md`, API tests in `apps/api/src/test/modules-billing.test.ts`. No payment gateway: payments are recorded by a platform admin |
| Platform-wide feature-flag defaults | **Not implemented** — tracked in `docs/risks.md` and `docs/device-integrations.md` §8 |

Known limits worth stating: rate limiting and idempotency storage are per API instance (multi-instance needs an edge limiter or a shared store), zero-touch device claiming trusts serial knowledge (risk D26), and the web app ships ~188 kB gzipped of application code on top of the vendor chunks (React, Supabase, TanStack Query, i18next, Luxon), all pages beyond the shell being lazy.

## Quality gates
`pnpm verify` runs lint, typecheck, unit tests and builds. `bash supabase/tests/run-rls-tests.sh` and `pnpm test:db`
prove tenant isolation on a real Postgres; `pnpm --filter @flowza/api test` and `pnpm --filter @flowza/worker test` run the
API and worker suites against per-file test databases; `pnpm --filter @flowza/web run build:e2e && pnpm --filter @flowza/web
run test:e2e` runs the Playwright UI suite. To keep GitHub Actions minutes down, CI runs only two checks, and only on pull
requests whose paths can affect them: `.github/workflows/migrations.yml` (migrations, RLS suites, re-apply, generated types)
and `.github/workflows/api-image.yml` (API Docker image build). Everything else, including `pnpm audit` and a gitleaks scan,
is run locally before merging.

## Licence
Proprietary — © F & Z Capital. All rights reserved.
