# Deployment

## Topology
| Component | Where | Notes |
|---|---|---|
| `apps/web` | Vercel / Cloudflare Pages (static SPA) | `pnpm build:web` → **`apps/web/dist`** (not `dist`); `VITE_*` are inlined at build time — see "Static hosting" below |
| `apps/api` | Container (Fly.io / Railway / Render / Cloud Run) | `apps/api/Dockerfile`; stateless; scale horizontally; `/api/health`, `/api/ready` |
| `apps/worker` | Container (same platform) | `apps/worker/Dockerfile`; run ≥2 instances for HA — the scheduler leader is elected with a Postgres advisory lock |
| Database/Auth/Storage/Realtime | Supabase project per environment | Region closest to customers (see residency) |
| Email | Resend (or console in dev) | `EMAIL_PROVIDER`, `RESEND_API_KEY` |

## Static hosting for `apps/web` (Cloudflare Pages, Netlify, Vercel)

The bundle is built inside a pnpm workspace, so the output is **`apps/web/dist`, not `dist`**. A host left on its
default settings runs the build successfully and then fails with `Output directory "dist" not found`.

| Setting | Value | Where it lives |
|---|---|---|
| Root directory | repository root (the build needs the workspace to resolve `@flowza/contracts`) | host settings |
| Build command | `pnpm build:web` | host settings |
| Output directory | `apps/web/dist` | `wrangler.toml` (`pages_build_output_dir`) on Cloudflare; host settings elsewhere |

The repository-root `wrangler.toml` declares `pages_build_output_dir = "apps/web/dist"`, so a Cloudflare Pages project
picks the right directory up from version control and takes it in preference to the dashboard value. Keep its `name`
in sync with the Pages project (`flowza-time-prd` today); other hosts have no equivalent file, so set the output
directory in their settings.

`pnpm build:web` builds only the packages the web app depends on and then the bundle; the repository-root `build`
script builds the API and worker too, which a static host does not need.

**`VITE_*` variables are read at build time, not at runtime.** Vite inlines them into the bundle, and
`apps/web/src/lib/env.ts` throws on a missing value, so a deployment built without them serves a blank page whose
console reads `Missing VITE_SUPABASE_URL`. Set these as *build* environment variables on the host, per environment:

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable or anon key>
VITE_API_URL=https://<api-host>          # defaults to http://localhost:4000
```

`apps/web/public/_redirects` returns `index.html` for every path so React Router deep links survive a refresh, and
`apps/web/public/_headers` sets `nosniff`, `DENY` framing, a referrer policy and immutable caching for the
content-hashed assets. Both are copied verbatim into `dist` by Vite and are read by Cloudflare Pages and Netlify;
on Vercel express the same rules in `vercel.json`. Neither file sets a Content-Security-Policy, because the allowed
connect sources differ per deployment (Supabase host, API host) — add one at the edge with those values.

## Environments
`development` → local; `staging` → Supabase project + one API + one worker; `production` → Supabase (compute add-on
sized to tenants, PITR enabled) + ≥2 API + ≥2 workers. Each environment has its own database roles/passwords,
`FLOWZA_CREDENTIALS_MASTER_KEYS`, provider credentials and Supabase keys. Secrets live in the platform's secret store,
never in the repo.

## Database roles on Supabase
Migrations create `flowza_api` and `flowza_worker` (login, no password). Set passwords once per environment with the
SQL editor/`psql` as `postgres`: `alter role flowza_api password '…'; alter role flowza_worker password '…';` and use
the **Supavisor transaction pooler** URL (port 6543) in `DATABASE_URL_API` / `DATABASE_URL_WORKER`. The worker's
scheduler holds a session-level advisory lock on a dedicated connection; with transaction pooling that connection must
be a direct (session) connection — set `DATABASE_URL_WORKER` to the session pooler (port 5432) or direct host.

## Release procedure
1. CI green on the PR (lint, typecheck, unit, migrations + RLS suites, DB integration tests, audit, secret scan).
2. `supabase db push` against staging (CI job with `SUPABASE_ACCESS_TOKEN` + `SUPABASE_DB_PASSWORD`), deploy API/worker
   images to staging, run smoke tests (`/api/ready`, sign-in, sync a mock device).
3. Promote the same images + migrations to production. Migrations are forward-only and additive; destructive changes
   ship in two releases (add → backfill → switch → drop).
4. Post-deploy: watch `job_failed` / `unhandled_error` log events, queue depth in `/api/ready`, Supabase advisors.

## Device push ingress (plain HTTP)
Legacy ZKTeco/eSSL/FingerTec push firmware often speaks **plain HTTP** to `/iclock/*` and cannot do TLS. Expose a
dedicated hostname (e.g. `push.flowza.example`) that accepts HTTP on port 80 **only** for `/device-push/*` and
`/iclock/*` paths (platform routing rule / small reverse proxy), rate-limited per source IP and serial, with everything
else redirected to HTTPS. Prefer TLS-capable firmware where the vendor offers it. The API container itself is unchanged.

## Residency (GCC)
An organisation is pinned to a `region_cell`. MVP runs one cell. Adding a cell = a new Supabase project + API/worker
deployment with the same images; the platform admin API routes tenants by cell. Choose Supabase regions with the lowest
latency to Oman (e.g., Mumbai `ap-south-1` or Bahrain when offered by Supabase) and document the choice in the DPA.

## Backups & disaster recovery
| Item | Target |
|---|---|
| RPO | ≤ 5 minutes (Supabase PITR on Pro+; daily backups otherwise → 24 h) |
| RTO | ≤ 4 hours (restore project, redeploy containers, rotate keys if compromised) |
| Storage | Supabase Storage is replicated; report files are regenerable; employee photos/documents exported weekly to object storage in the same region |
| Master keys | Stored in the secret manager; escrow copy offline. Losing them makes device credentials unrecoverable (re-enter per device) — attendance data is unaffected |
| Procedure | `docs/troubleshooting.md` → "Disaster recovery runbook" |

## Observability
Structured JSON logs (pino) with `requestId`, `jobId`, `organizationId`; ship to the platform's log drain (Datadog /
Grafana Loki / Better Stack). `/api/ready` exposes DB latency and queue depth for uptime checks. OpenTelemetry can be
enabled by wrapping the Hono app and Kysely with the OTel SDK; Sentry via `@sentry/node` in `apps/api/src/index.ts`
(both optional and off by default).
