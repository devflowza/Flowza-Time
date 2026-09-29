# Prompt 12 — Ship: hosted migrations, deploy, seeds, hosted verification

**Date:** 2026-09-29. **Hosted project:** Supabase `liyilmbklsextsggflbb` (PostgreSQL 17.6). **API:** `https://time-api.flowza.ai`
(Fly.io). **Web:** `https://time.flowza.ai` (Cloudflare Pages). **Code:** `main` @ `afe719c` (PR #65, squash-merged) when this
was shipped; `main` has since moved to `e9645e2` with other work (PRs #66–#75, §3).

**Status:** migrations, API, worker, web and demo data are live and verified; the hosted end-to-end matrix passes every flow
it runs except the report-schedule step of flow 6, which needs the `reports` worker deployed (§8). Following the six-month
recalculation through exposed a defect in the job queue that predates this work: a job that runs longer than its lock
timeout is started again while it is still running; the three six-month recalculations run on the hosted project all show
it. It is fixed in code and in migration `20260929000600` (§9), which waits for approval and a deploy. Also for the owner: switch on
leaked-password protection; the Finance-side branch matters only once the Finance connector is switched on.

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
- **Order of events** (corrected). The 21 migrations were applied between 06:06 and 10:53 UTC. The owner's Deploy #6
  (10:38–10:42 UTC) put the new API and worker live while the last three were still pending (`security_gate` 10:52,
  `security_gate_queue_indexes` 10:52, `platform_grant_approval` 10:53). The Postgres logs show no errors in that window or
  after it.
- **Migrations that reached `main` later the same day** (with PRs #66–#74, not part of this work), all applied:
  `20260929000100_hikvision_push_provider` and `000200_device_provider_adapters` (14:40–14:41 UTC) and
  `000500_device_pin_mappings` (17:12) by other sessions, each as a shortened text (md5 `beff92ec…`, `823308a3…`,
  `9b633c1a…` against the repo files' `af6ac627…`, `95da2fe6…`, `d0b6a20b…`); `000300_invitation_delivery_status` and
  `000400_super_admin_portal` by this session on the owner's instruction (17:13 and 17:15), byte-identical to the repo
  (`3e925eb2…`, `500388cf…`). Another session had applied shortened texts of those two one to three minutes earlier; both
  files are idempotent, and the second application ran the full repo text, post-verify included, without error.
  `app.migrations` lists 000300 and 000400 but not 000100, 000200 or 000500, so the repo migrator run against hosted would
  apply those three again (they are idempotent).

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

**The recalculation** of 1 Mar → 29 Sep (53 employees × 213 days) started at 11:31 UTC; 11,000 employee-days were recomputed,
6 changed, no errors. It ran as six attempts of a three-attempt job: the worker deploys at 11:57 and 13:03 (§3) stopped the
first two, and from 13:32 each attempt's one-hour lock expired while it was still running, so a new attempt started next to it
every hour (§9). Executions finished at 17:20, 18:23 and 19:18 UTC, each marking the request COMPLETED and auditing it again;
the last one ends at about 20:20. Until then the request keeps reading COMPLETED while its progress summary jumps back to
whatever that execution has reached. The monthly summaries were rebuilt after the first completion (six
`BUILD_PERIOD_SUMMARY` jobs, done at 18:49 UTC); September's is of a month still in progress.

## 3. API and worker

- **Deploy #6** (`deploy.yml`, dispatched by the owner on `main` @ `afe719c`): API and worker deployed, API readiness verified.
  The **reports worker step was skipped** (target `both`) — see §8. This session could not dispatch the workflow itself: the
  GitHub integration answers `403 Resource not accessible by integration` on workflow dispatch.
- **Deploy runs 7 and 8** (11:55 on `afe719c`; 12:59 on `77e5314`, the merge of PR #66), also target `both`: the API and
  worker were redeployed and the reports worker skipped again. The API and worker therefore run PR #66. `main` has moved on
  to `e9645e2` — PRs #67 (this report) and #68–#75 (device-provider HTTP client, invitee onboarding fix, CI split, employee
  profile save fix, invitation delivery status, the `/adm` super-admin portal, device PIN mapping and punch log, and a web
  fallback for routes the API does not serve yet). Their migrations are applied (§1); the code of #68–#75 is not deployed
  to the API or worker yet.
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

Because Cloudflare deploys every merge while the API is deployed by hand, the web is now ahead of the API: screens added by
PRs #72–#74 call routes the deployed API does not have. Since PR #75 those screens say "Not available yet" instead of
showing the router's "Route not found."; deploying the API from `main` (§8) makes them work.

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
- **Latency.** Self-service calls took 2.6–3.7 s each during these runs, while the recalculation was running. Measured again
  later with the read-only route probe of §3: the readiness database check held at about 58 ms, one round trip between
  the API (Fly.io `sin`, Singapore — Fly has no region in India) and the database (`ap-south-1`, Mumbai); the self-service
  routes took 1.7 s median, 3.5 s at the 90th percentile and 7.2 s at worst. The time is round trips, not database work:
  `/me/overview` makes about 120 sequential queries, each paying that 58 ms. Reducing the round trips per route, as PR #50
  did for `/me` and the dashboard, is the remedy; not part of this prompt.

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
4. **Deploy the API and worker from `main`** (target `both`): they run PR #66, while `main` carries #67–#75 with their
   migrations already applied (§3, §4). Do it together with item 5 if that is approved first.
5. **Job-queue fix (§9)**: approve migration `20260929000600`, merge the branch `claude/modest-fermi-fnwqq7` into `main`,
   then deploy the worker and the reports worker. Either order of migration and deploy is safe: the new worker falls back to
   the previous queue calls while the migration is missing (the heartbeat then logs a warning), and the previous worker keeps
   working on the migrated queue.
6. **`app.migrations`** lacks 000100, 000200 and 000500 (§1). Harmless while migrations are applied through Supabase; record
   them before anyone runs the repo migrator against hosted, or let it re-apply them (idempotent).

## 9. Job queue: running jobs were started again while they ran

**Found** while following the six-month recalculation (§2). A worker marks a job `running` with `locked_at` / `locked_by`;
`jobs.reap_stale` (every minute) hands back any `running` job whose lock is older than the job's `lock_timeout_seconds`, on
the assumption that its worker died. Nothing refreshed the lock while a handler ran, so any job that ran longer than its lock
timeout was handed out again while it was still running. A recalculation holds a one-hour lock and a six-month range takes
about four hours on the hosted topology, so every such run was started again each hour next to itself:

| Recalculation (queue job) | Attempts (max 3) | Last requeue | Queued → completed (UTC) |
|---|---|---|---|
| 9 Sep (6248) | 3 | `LOCK_EXPIRED` | 00:22 → 05:28 |
| 27 Sep (284064) | 3 | `LOCK_EXPIRED` | 08:03 → 13:11 |
| 29 Sep (316173) | 6 | `LOCK_EXPIRED` | 11:19 → 17:20 first completion (then 18:23, 19:18, one still running) |

On 29 Sep the first two attempts were stopped by the worker deploys and the next four ran side by side. Consequences: the
same work done up to four times at once (load on the database); `jobs.reap_stale` ignored `max_attempts`, so the attempt
count ran past its maximum; a superseded execution could still complete, fail or reschedule the job; and each execution
wrote the request's progress and outcome over the others — the request read COMPLETED with 8,000 of 11,000 days
recomputed, carried three audit entries, and its `finished_at` moved with every execution. Any job type can hit this once it outlives its lock (imports, large reports, day close on a big tenant).

**A second, older defect** turned up in the same code: the dedupe index is unique over *pending* jobs only (a job enqueued
while its twin runs waits as the next run), so moving the running twin back to `pending` — a retry in `jobs.fail`, or a reap
— raised `unique_violation`. For a reap that would fail the whole batch, every minute, so no stale job would be recovered
again. It has not happened on hosted yet (no failed reap in the archive); it reproduced locally at once.

**Fix** (branch `claude/modest-fermi-fnwqq7`, not yet on `main` or hosted):

- Migration `20260929000600_job_lock_heartbeat.sql`: `jobs.heartbeat(worker, ids, attempts)` extends the locks of the
  jobs a worker still runs and returns the ones it still owns; `jobs.complete_owned` / `jobs.fail_owned` record an outcome
  only while the caller holds the same attempt; `jobs.release_owned` hands a job back at shutdown without spending an
  attempt; `jobs.reap_stale` counts a lost lock as an attempt and dead-letters a job whose attempts are spent; requeueing
  drops the dedupe key of a job whose key a pending twin already holds (both runs are kept); `jobs.complete` no longer
  rewrites a job that was already archived; EXECUTE on the queue functions is revoked from PUBLIC and every one of them
  runs with a fixed `search_path` (clearing the queue's 7 `function_search_path_mutable` advisor warnings).
- Worker: the runner heartbeats every `WORKER_HEARTBEAT_INTERVAL_MS` (10 s); when a job turns out not to be its own any more
  it aborts the handler (reason `LOCK_LOST`) and records nothing; it records outcomes through the owned calls; a queue
  error while recording is logged instead of crashing the process; on shutdown (a deploy) it waits
  `WORKER_SHUTDOWN_GRACE_MS` (3 s, under Fly's 5 s kill) and hands the jobs still running back to the queue, so the next
  worker takes them at once instead of an hour later. The recalculation stops between chunks once its lock is lost and
  writes no progress or outcome after that point.
- Tests: queue DB tests for heartbeat ownership, owned completion and failure, release, reaping, dead-lettering and the
  dedupe cases; runner tests for heartbeats, lock loss, a job finishing during a heartbeat, a superseded execution that
  outlives its lock, shutdown release, and queue errors (the three runner guards were mutation-tested: removing any one
  fails its test); a recalculation test for lock loss and for a timeout that must not cut a range short.

Known limits: a job dead-lettered by the reaper (its worker died three times) runs no handler, so a recalculation request in
that state keeps reading RUNNING; deploys no longer cost attempts, so this needs repeated crashes. And a job is now taken
back only when its worker is gone: a handler that hung inside a live worker would keep its job until the worker restarts.
Database statements (120 s) and outbound provider calls carry their own timeouts, which is what bounds that.
