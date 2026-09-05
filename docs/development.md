# Development

## Prerequisites
Node 22, pnpm 10 (`corepack enable`), PostgreSQL 16 client tools (`psql`). Docker + Supabase CLI are optional
(`npx supabase start` gives the full local stack incl. Auth/Storage/Realtime); without Docker, use the native
Postgres helpers below and point the web app at a hosted Supabase dev project for Auth.

## First run
```bash
pnpm install
cp .env.example .env                       # API/worker config (see comments in the file)
cp apps/web/.env.example apps/web/.env.local
bash scripts/local-pg.sh start             # Postgres 16 on 127.0.0.1:54329
bash scripts/db-reset-local.sh --seed      # shim + migrations + deterministic seed
pnpm build:packages
pnpm dev:api                               # http://localhost:4000/api/health
pnpm dev:worker
pnpm dev:web                               # http://localhost:5173
```
Generate a master key for device credential encryption:
`node -e "console.log('k1:'+require('crypto').randomBytes(32).toString('base64'))"`.

## Everyday commands
| Command | What it does |
|---|---|
| `pnpm build:packages` | Build `packages/*` in dependency order (apps consume `dist/`) |
| `pnpm typecheck` | Build packages, then `tsc --noEmit` on apps |
| `pnpm lint` / `pnpm format` | ESLint (flat config) / Prettier |
| `pnpm test:unit` | Vitest across packages (pure domain tests run in ms) |
| `pnpm test:db` | Kysely + RLS integration tests on the local Postgres |
| `bash supabase/tests/run-rls-tests.sh` | SQL RLS suites on a fresh database |
| `pnpm db:types` | Regenerate `packages/database/src/generated/db.ts` |
| `pnpm verify` | Everything CI runs, locally |

## Project layout
See `AGENTS.md` for the layout, coding rules and the two execution contexts (`user`, `system-for-org`).

## Adding a migration
1. Create `supabase/migrations/<timestamp>_<name>.sql` (ordered by filename).
2. Apply locally: `bash scripts/db-reset-local.sh` (from scratch) and run the RLS suites.
3. If you add a tenant table: give it `organization_id`, indexes starting with it, and call
   `app.apply_tenant_policies(...)` (or the read-only variant) in a new policies migration. The safety net in
   `1400_rls_policies.sql` pattern (every table must have RLS) should be repeated at the end of your migration.
4. Regenerate types: `pnpm db:types`; update `packages/contracts/src/enums.ts` if you added enums.

## Migration safety policy (hot tables)
- Begin DDL migrations on hot tables with `set lock_timeout = '5s'; set statement_timeout = '60s';` and retry on failure instead of
  waiting behind long transactions.
- Create indexes on hot tables with `CONCURRENTLY` in a dedicated, non-transactional migration file (the Supabase CLI runs each
  file in its own transaction unless the file contains `-- supabase: no-transaction`… verify for your CLI version; locally the
  tool `packages/database/src/tools/migrate.ts` wraps files in transactions — split such statements into their own file and mark it).
- Expand → backfill (as a worker job in batches) → contract; never rewrite partitioned tables in place.
- Enum values are added with `alter type … add value if not exists` and used only in later files.

## Adding a device provider
See `docs/device-integrations.md` → "Adding a vendor".

## Environments
`development` (local), `staging`, `production` — separate Supabase projects, separate database roles/passwords,
separate master keys and provider credentials. Never point local tooling at production (`DATABASE_URL_*`).
