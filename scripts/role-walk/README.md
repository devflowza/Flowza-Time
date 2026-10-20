# Role walk

`run.mjs` signs in as **every role** and opens **every tenant page** of the web app — clicking through each page's tabs —
against the real API, and reports what a member must never see because of their role:

- a request the page made that the API refused with **403** (a page, tab, card or picker the role's keys do not read);
- an error state carrying the API's wording (`Missing permission: …`, `Please try again … request id …`);
- a **menu entry that leads to "Permission denied"** (the menu offers only what the role can open);
- an uncaught page error.

A role without access to a page sees the "Permission denied" page; a record outside its scope reads "Not found". Neither is a
finding. Exit code: `0` nothing found, `1` findings (listed, and written to `scripts/role-walk/results/<run>.json`, gitignored),
`100` bad invocation. Node 22; Playwright is the one `apps/web` already has.

## Logins

`walk-users.sql` (applied by `--setup`, idempotent) adds to the local seed (Al Bahja Trading):

| Login | Role |
|---|---|
| `walk.<role>@albahja.example` | each system role (`owner`, `org_admin`, `hr_admin`, `hr_user`, `branch_manager` — Sohar only, `attendance_admin`, `payroll`, `employee`, `manager`, `auditor`), linked to an employee record |
| `walk.<role>.nolink@albahja.example` | the same roles without an employee link |
| `walk.none`, `walk.none.nolink` | a custom role with no permission at all |
| `walk.c_<module>@albahja.example` | custom roles holding one key each: `dashboard.view`, `report.view`, `employee.view`, `device.view`, `attendance.view`, `leave.view` |

`walk.hr_user` and `walk.employee` manage two employees each, `walk.manager` four (line managers holding a non-manager role
take other paths). Every module is switched on for the organisation.

## Running it

Postgres with the migrations and the seed, the API, and the web dev server pointed at that API:

```sh
export PGHOST=127.0.0.1 PGPORT=54329 PGUSER=postgres
PGDATABASE=flowza_walk bash scripts/db-reset-local.sh --seed

# the API on 4310 with a JWT secret of your own (the same environment scripts/e2e-hosted/run.mjs gives its local servers)
export E2E_JWT_SECRET=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")
(cd apps/api && NODE_ENV=development SUPABASE_URL=http://127.0.0.1:54399 SUPABASE_ANON_KEY=local SUPABASE_JWT_SECRET=$E2E_JWT_SECRET \
  DATABASE_URL_API=postgres://flowza_api:flowza_api@127.0.0.1:54329/flowza_walk DATABASE_URL_WORKER=postgres://flowza_worker:flowza_worker@127.0.0.1:54329/flowza_walk \
  FLOWZA_CREDENTIALS_MASTER_KEYS=k1:$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))") FLOWZA_DEVICE_PUSH_SECRET=local-walk-push-secret \
  API_PORT=4310 WEB_ORIGINS=http://localhost:5173 RATE_LIMIT_MAX=1000000 node --import tsx src/index.ts) &

# the web app against it
(cd apps/web && VITE_SUPABASE_URL=http://127.0.0.1:54399 VITE_SUPABASE_ANON_KEY=local VITE_API_URL=http://127.0.0.1:4310 pnpm exec vite --port 5173) &

node scripts/role-walk/run.mjs --setup --db=flowza_walk
```

| Option | Default | Meaning |
|---|---|---|
| `--setup` | off | apply `walk-users.sql` first |
| `--db` | `flowza_walk` (or `PGDATABASE`) | the database the API runs on (local hosts only) |
| `--api` | `http://127.0.0.1:4310/api/v1` | the API under test |
| `--web` | `http://localhost:5173` | the web app under test |
| `--supabase-url` | `http://127.0.0.1:54399` | the API's `SUPABASE_URL` (token issuer; nothing has to listen there) |
| `--users` | all | comma-separated roles (`hr_user`, `employee.nolink`, `c_leave`) or e-mails |
| `--routes` | all | comma-separated paths |
| `--concurrency` | 6 | logins walked in parallel |

`PLAYWRIGHT_CHROMIUM_EXECUTABLE` (or `--chromium=`) points at a Chromium already on the machine. The walk navigates the way
the menu does (no reload between pages), so a full run of the 28 logins takes about fifteen minutes on a dev server.
