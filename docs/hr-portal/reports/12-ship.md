# Prompt 12 — Ship: hosted migrations, deploy, seeds, hosted verification

**Date:** 2026-09-29. **Hosted project:** Supabase `liyilmbklsextsggflbb` (PostgreSQL 17.6). **API:** `https://time-api.flowza.ai`
(Fly.io). **Web:** `https://time.flowza.ai` (Cloudflare Pages). **Code:** `main` @ `afe719c` (PR #65, squash-merged).

**Status:** migrations, API, worker, web and demo data are live and verified; the hosted end-to-end matrix passes every flow
it runs except the report-schedule step of flow 6. That step needs the one open action (§8): deploy the `reports` worker.
Also for the owner: switch on leaked-password protection; the Finance-side branch matters only once the Finance
connector is switched on.

## 1. Migrations

The 21 migrations of PR #65 (`20260928000100` … `20260928001120`) were applied to the hosted project with the Supabase MCP
`apply_migration`, one call per file, in file order, each named after its file without the timestamp and `.sql`.

- **Byte parity.** For every file, `md5(statements[1])` in `supabase_migrations.schema_migrations` equals the md5 of the repo
  file (trailing newlines removed): 21 of 21. The repo stays the replay truth.
- **Ledger.** `app.migrations` (the ledger of `packages/database/src/tools/migrate.ts`) was brought up to date, so it now lists
  the same 46 files as `supabase/migrations/`.
- **Catalogue checks** (the Prompt 10 runbook, `10-security-gate.md` §9): the `flowza_client` role and its members, the
  `_no_data_api` restrictive policies (nothing reachable through PostgREST), FORCE RLS on tenant tables, the
  `organization_id` immutability triggers, every partition locked (RLS on, no client privileges — 148 of 148), the explicit
  denials on system-written tables, and the `domain_events` insert policy that only admits the API and worker sessions: all
  present. `public` holds 97 tables, all with RLS.
- **Order of events.** The owner's Deploy #6 (10:38–10:42 UTC) put the new API and worker on the old schema a few minutes
  before the migrations were applied (10:42–10:53 UTC). The Postgres logs show no errors in that window or after it.

## 2. Demo tenant data (Majan Gulf Trading)

The seed steps that changed since the last hosted load were run on the admin connection: `02_people.sql`,
`03b_employee_portal.sql` and — because it must follow 3b and brings 3b's requests into the approval-engine-v2 shape —
`04_attendance.sql`. Each file was executed **verbatim**, inside a `DO` block that refuses to run unless the md5 of the text
equals the repo file's; seed 04 additionally rolled itself back if it would add a single punch on or before the last punch
already stored.

| Step | md5 of the file | Result |
|---|---|---|
| `02_people.sql` | `b0e2641bfdbc06f88068a2242b068614` | 53 employees; 10 active memberships; the new `manager@` (Arun Menon, Line Manager) and `auditor@` (Suresh Pillai, Auditor) logins; 5 secondary managers |
| `03b_employee_portal.sql` | `84bb3055302e582607c96d4c337a69c6` | Priya (MG-1012): 7 leave records (2 pending, 3 approved, 1 rejected, 1 withdrawn), 3 allocations for 2026, 1 comp-off credit; ML female-only, PTL male-only; the comp-off leave type |
| `04_attendance.sql` | `dd5744eb5487e8c6fc2d5ad43dfb25f8` | 218 new punches (27 Sep 09:43 → 29 Sep 14:02 Muscat), **0** on days already seeded; 9 approval requests in the engine-v2 shape (14 step actors, 26 timeline events); jobs: normalise (done within two minutes), recalculate 1 Mar → 29 Sep, apply the 3 approved corrections (idempotent), rebuild the six monthly summaries |

Why re-running 04 is safe: its punch generation is unchanged since the first version of the seed (only the end date moved
to "now"), so days already loaded regenerate byte-identical rows that the dedupe index ignores; the changes in 02 since the
last load are logins, two e-mail addresses and the secondary managers, none of which feeds punch generation. Nobody had
used the demo tenant since 27 Sep (only system jobs in the audit log), so the 03b upserts reset nothing a person had done.

The full recalculation of the six months runs in the background (the previous one took five hours on this database); the
monthly summaries it feeds are rebuilt once it finishes (§8).

## 3. API and worker

- **Deploy #6** (`deploy.yml`, dispatched by the owner on `main` @ `afe719c`): API and worker deployed, API readiness verified.
  The **reports worker step was skipped** (target `both`) — see §8. This session could not dispatch the workflow itself: the
  GitHub integration answers `403 Resource not accessible by integration` on workflow dispatch.
- `GET /api/ready` → 200 `{"status":"ready","checks":{"database":{"ok":true},"queue":{"ok":true,"dead":0},"providers":12}}`.
- The worker picked the seed's jobs up at once: the 218 new punches were normalised within two minutes.
- `/api/v1/me` and the `/api/v1/orgs/:orgId/me/*` routes (404 before this deploy), read-only probe as three logins:

  | Route | employee@ | manager@ | auditor@ |
  |---|---|---|---|
  | `/me` | 200 | 200 | 200 |
  | `…/me/profile`, `/overview`, `/attendance`, `/leave`, `/shift`, `/stats`, `/comp-off`, `/shift-swaps` | 200 | 200 | 200 |
  | `…/me/punch/status`, `/regularisations`, `/attendance/notes`, `/selfie-checkins` | 200 | 200 | 403 (read-only role) |
  | `…/me/team/leave` | 403 (no team) | 200 | 200 |

## 4. Web

Cloudflare Pages project `flowza-time-prd` builds every push (PR #65's head had its own preview check). Its production
alias `flowza-time-prd.pages.dev` serves `assets/index-D02KIbtU.js`, which contains `On behalf of {{name}}` — a string that
exists nowhere in the PR #64 tree and was added by PR #65. **Cloudflare deploys `main` to production, and the web half went
live when PR #65 was merged.** `time.flowza.ai` answers non-browser clients with Cloudflare's managed challenge
(`403`, `cf-mitigated: challenge`), which is why the bundle was checked on the Pages alias.

## 5. Flowza Finance connector

- **FlowZa Time side:** built and deployed with the API and worker; **disabled** — the hosted project has no
  `flowza_finance` connector device, and no Finance tenant has been designated for Majan Gulf.
- **Finance side:** `attendance-export` **is deployed** to the Finance project (`ucjtxdmklhhhvayirwqe`, v1, 2026-09-27
  17:05 UTC, from commit `9dbf75f`, 2.5 minutes after that commit). Both Finance commits of this work — `9dbf75f`
  (`attendance-export`) and `3863dc8` (automatic PIN → employee-number mapping in `attendance-ingest`) — live only on the
  Finance branch `claude/modest-fermi-fnwqq7`, with no pull request into Finance `main`. Production `attendance-ingest`
  (v35, deployed by Finance CI on 2026-09-27 22:04 UTC) does **not** carry `3863dc8`.
- Nothing was registered or switched on: the prompt's default (integration disabled in production) holds.

## 6. Hosted end-to-end matrix

`scripts/e2e-hosted/run.mjs --mode=hosted` against the production API as owner, HR admin, line manager, employee, auditor,
Sohar branch manager and delegate (payroll), every login signed in through Supabase Auth. Run `20260929112453-b172`
(11:24–11:40 UTC) ran every flow hosted mode supports; run `20260929114230-7eda` re-ran flow 1 after the runner fix below.

| Flow | Result | Notes |
|---|---|---|
| 0 — setup: logins, fixtures, temporary settings | PASS | all seven logins resolve their memberships and keys |
| 1 — check-in inside / outside a geofence, status, stats | **FAIL → fixed, PASS** (67 s) | see below |
| 2 — late / absence reason, manager queue, HR oversight, half-day pay effect, re-submit, approve | PASS (62 s) | |
| 3 — regularisation through manager → HR, applied, day recomputed | PASS (36 s) | |
| 4 — leave: apply, edit, ask for information, reply, self-approval refused, approve, balance, withdraw | PASS (88 s) | |
| 5 — shift swap approved, assignments swapped | PASS (72 s) | |
| 6 — HR bulk half-day, sync punches, monthly summary, report schedule run now | **FAIL** (410 s) | every step passes up to "run now"; the delivery never appears — the `reports` worker still runs pre-PR #65 code (§8) |
| 7 — delegation: the request routes to the delegate, decided "for" the manager | PASS (61 s) | |
| 8 — escalation after an hour | SKIP | local mode only (needs the worker's clock hook) |
| 9 — auditor refused every write; Sohar branch manager cannot reach head office | PASS (58 s) | |
| 10 — Flowza Finance connector | SKIP | integration disabled (§5) |
| abuse — foreign ids, replay, client time, double decision, approved reason, batch limits | PASS (141 s) | |

Every cleanup passed (fences deleted, workflow archived, leave requests cancelled, report schedule deleted, the two
half-days set back to PRESENT, delegation revoked) and the temporary attendance settings were restored after both runs.

- **Flow 1 — a defect of the runner, not of the product.** On hosted, seed 04 now runs up to the current time, so at
  15:25 Muscat the employee already had today's terminal check-in (09:11). The runner previewed a check-in before closing an
  open one, and the API rightly answered `ALREADY_CHECKED_IN`. The runner now reads the status first and closes an open
  check-in inside the fence before it previews (`scripts/e2e-hosted/run.mjs`); the re-run passes every step, including the
  refused punch 5.4 km outside the fence, the worker normalising both punches and the engine recomputing the day
  (PRESENT, 5 → 7 punches).
- **Flow 6 — a missing deploy.** "Run now" queues `RUN_REPORT_SCHEDULE` on the `reports` queue. The reports worker
  (`flowza-time-reports`) took it within two seconds and dead-lettered it: `NO_HANDLER — no handler registered for
  RUN_REPORT_SCHEDULE`. Deploy #6 skipped that app (§3), so it lacks everything PR #65 added to reports: schedule runs and
  deliveries, the monthly summary report and the updated daily / monthly / summary definitions.
- **Latency.** Self-service calls took 2.6–3.7 s each on hosted during these runs, and `/api/ready` measured 0.5–1.1 s for
  its database check, while the six-month recalculation was running. To be measured again once it has finished.

What the runs leave in the demo tenant, all tagged `e2e:<runId>`: the employee's web punches of today (the abuse pass and
flow 1), the approved absence reason (flow 2), the applied regularisation (flow 3), the approved shift swap and its
one-day assignments (flow 5), cancelled leave requests, and their audit trail. Punches and audit rows are append-only by
design.

## 7. Advisors

- **Security:** no ERROR-level finding. The 148 INFO findings on partitions are by design (locked partitions: RLS on and no
  policy, so nothing reads or writes them except through the parent). 30 WARN `function_search_path_mutable` on
  security-invoker functions, mostly older than this work. `rls_auto_enable` is an event-trigger function (not callable).
  **Leaked-password protection is off** in Supabase Auth — recommended on (§8).
- **Performance:** no ERROR-level finding. 47 INFO `unindexed_foreign_keys` (45 are column-order false positives — an
  index covers the key's columns, in a different order — and 2 are on small catalogue tables); 84 WARN
  `multiple_permissive_policies` (the generated tenant policies plus bespoke ones, by design); 366 INFO `unused_index`
  (a young database).

## 8. Owner actions

1. **Deploy the reports worker** (needed now): GitHub → Actions → **Deploy** → Run workflow on `main` with target
   **`reports`**. Until then, report schedules and "run now" fail, and reports come from the old definitions. Afterwards,
   re-run flow 6: `node scripts/e2e-hosted/run.mjs --mode=hosted --i-understand-this-writes-to-the-demo-tenant --flows=6`
   (environment as in `scripts/e2e-hosted/README.md`).
2. **Switch on leaked-password protection** in Supabase Auth for `liyilmbklsextsggflbb` (Dashboard → Authentication →
   password security).
3. **Before the Finance connector is switched on** (not needed today): take the Finance branch `claude/modest-fermi-fnwqq7`
   (`9dbf75f`, `3863dc8`) through Finance's own review and approval into Finance `main`; deploy `attendance-ingest` from it
   so that pushed punches map PINs to employee numbers; designate the Finance tenant; then register the connector in
   FlowZa Time (Settings → Integrations) and run "Test connection".
4. **Monthly summaries**: the six-month recalculation queued by seed 04 was expected to finish around 16:15 UTC. The six
   monthly summaries it feeds are rebuilt once it has finished, so they reflect every recomputed day.
