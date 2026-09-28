# End-to-end test matrix (HR portal Prompt 11)

`run.mjs` drives the **real API** through the HR-portal flows with real tokens: every step asserts the status code **and** the
state it changed (it re-reads the resource), every flow creates its own data tagged `e2e:<runId>` and cleans up what it can
(withdraw / cancel, delete its fence, schedule, workflow and delegation, disconnect the connector). Node 22, no dependencies
(`fetch`, `node:crypto`, `node:http`, `node:child_process`).

It prints a results table (flow, step, expected, actual, PASS / FAIL / KNOWN / SKIP, ms) and writes the same rows as JSON to
`scripts/e2e-hosted/results/<runId>-<mode>.json` (gitignored, like the server logs and the UI-walk screenshots there).
**Exit code = number of failed flows** (0 = green; 100 = bad invocation, 99 = the runner itself crashed).

## Local mode

Postgres 16 with the repo's migrations and the local seed (Al Bahja Trading, `packages/database/src/seed`). The script can
reset + seed the database and start the API and the worker itself; tokens are minted with HS256 for the seed's logins.

```sh
export PGHOST=127.0.0.1 PGPORT=54329 PGUSER=postgres
# reset + seed flowza_p11, start API (port 4310) + worker on it, run every flow, stop both
node scripts/e2e-hosted/run.mjs --mode=local --reset --start --db=flowza_p11 --api-port=4310
# a subset (flow 0, the setup, always runs)
node scripts/e2e-hosted/run.mjs --mode=local --start --db=flowza_p11 --flows=7,8,abuse
# against an API you run yourself: pass its SUPABASE_JWT_SECRET (and its SUPABASE_URL if not http://127.0.0.1:54399)
E2E_JWT_SECRET=… node scripts/e2e-hosted/run.mjs --mode=local --api=http://127.0.0.1:4310/api/v1 --db=flowza_p11
# keep the servers up for manual poking (prints the JWT secret; Ctrl-C stops them)
node scripts/e2e-hosted/run.mjs --mode=local --start --serve --db=flowza_p11
```

| Option | Default | Meaning |
|---|---|---|
| `--reset` | off | `PGDATABASE=<db> bash scripts/db-reset-local.sh --seed` first (a clean run: every flow finds fresh days) |
| `--start` | off | run the API (`apps/api/src/index.ts`) and the worker (`apps/worker/src/index.ts`) with `node --import tsx`, logs in `results/<runId>-api.log` / `-worker.log`; both are stopped when the run ends |
| `--db` | `flowza_p11` (or `PGDATABASE`) | database the servers and the seed use |
| `--api-port` | 4310 | 4000 / 4173 / 5173 are refused (used by other tools on this machine) |
| `--flows` | all | comma-separated flow ids (`1`…`10`, `abuse`) |
| `--worker-timeout` | 150 s local / 300 s hosted | bound of every wait on the worker (normaliser, recompute, corrections, reports, sync jobs) |
| `--verbose` | off | every HTTP call with its status and duration |

The locally started servers get `NODE_ENV=development`, a random JWT secret, their own credentials master key and
`FLOWZA_ALLOW_PRIVATE_EGRESS=true` — the latter only so the Flowza Finance connector may call the mock Finance server that flow
10 runs on 127.0.0.1 (never set it in a deployed environment). A full run takes about four minutes on a quiet machine.

## Hosted mode (demo tenant only)

Signs each demo login in through Supabase Auth (password grant with the anon key) and runs against the deployed API. It
**refuses to run** unless `E2E_ORG_ID` is the demo tenant, Majan Gulf Trading (`27bfe270-5dea-4587-aec3-0f5c23113261`,
`supabase/seeds/demo-tenant`), and `--i-understand-this-writes-to-the-demo-tenant` is passed. Nothing secret is ever in the file
or on the command line: the password and the keys come from the environment only.

```sh
export E2E_SUPABASE_URL=https://<project>.supabase.co E2E_SUPABASE_ANON_KEY=… E2E_API_URL=https://<api host>/api/v1 \
       E2E_PASSWORD=… E2E_ORG_ID=27bfe270-5dea-4587-aec3-0f5c23113261
node scripts/e2e-hosted/run.mjs --mode=hosted --i-understand-this-writes-to-the-demo-tenant
E2E_FINANCE_TEST=1 node scripts/e2e-hosted/run.mjs --mode=hosted --i-understand-this-writes-to-the-demo-tenant --flows=10
```

Logins used: owner `acme@`, HR `hradmin@`, manager `manager@` (Priya's line manager), employee `employee@` (Priya), auditor
`auditor@`, branch manager `brmanager@` (Sohar only), delegate `payroll@` — all `@flowza.ai`. Any of them can be overridden
with `E2E_LOGIN_<ROLE>` (`OWNER`, `HR`, `MANAGER`, `EMPLOYEE`, `AUDITOR`, `BRANCHMANAGER`, `DELEGATE`).

What hosted mode does NOT do: reset or seed anything; flow 8 (it needs the worker's dev hook, local only); the local-only
check that the worker generated a report copy (flow 6 stops at the delivery row); flow 10 beyond `test connection` against the
connector configured on the tenant, and that only with `E2E_FINANCE_TEST=1` (skipped with a message otherwise); creating a
second organisation for the abuse pass (a random organisation id is used instead). The run changes the tenant's attendance
self-service settings for its duration (web check-in on, geofence enforcement "block") and restores them at the end, even
after a failed flow.

## Flows

| Id | Flow |
|---|---|
| 0 | Setup: every login signs in and resolves its membership; the fixtures the flows rely on (the employee's primary manager is the manager login, the roles' keys, the branch manager is branch-restricted); web check-in switched on for the run |
| 1 | HR creates a temporary fence for the employee → check-in preview inside (allowed) / 5.5 km outside (denied) → a punch outside is refused and not stored → punch IN, status IN, punch OUT → the worker normalises both → the engine recomputes the day (flag `SELF_SERVICE_PUNCH`) → the stats endpoint counts it. Run between local midnight and the shift's punch window, the punches are outside every window: the step then asserts the engine's rule for that (kept out of the record, `OUT_OF_WINDOW` on the calendar day) and the punch-count step is SKIP |
| 2 | Late / absence reason → the manager sees it in `scope=mine`, HR under oversight (`scope=all`) → the manager rejects it with a half-day pay effect → the day carries one 0.5 LOP / pay-effect mark (or the leave balance is charged) → the reason is given again → approved → the charge is reversed |
| 3 | HR creates a two-level REGULARISATION workflow (manager → HR) → the employee files a missed check-out → level 1 manager, level 2 HR → applied through a correction → the worker recomputes the day with the new check-out |
| 4 | Leave: apply → edit (the old request is invalidated, a new one routed) → the manager asks for information → the employee replies → the employee cannot approve their own request (403) → the manager approves → the balance moves; a second pending request is withdrawn and its engine request cancelled |
| 5 | Shift swap with a colleague on another shift that day (HR gives one colleague a one-day assignment when no day qualifies) → approved → both resolve to the other's shift through one-day assignments |
| 6 | HR bulk-sets two days HALF_DAY (through the correction workflow) → "sync punches" (recalculate the range) completes and keeps the manual status → the monthly summary counts the half days → a report schedule run now creates a delivery for the recipient (local: the worker generates it) |
| 7 | The manager delegates leave approvals to a colleague for today → a new request routes to the delegate in the manager's seat → the delegate approves → the history shows the decision "for" the manager |
| 8 | (local) A LEAVE workflow whose level escalates to HR after 1 hour → a request → the worker's approvals sweep run once with the clock two hours on (`apps/worker/src/tools/run-approval-reminders.ts`) → HR is added as an escalated approver and notified (`approval.escalated`) → HR decides it in the manager's seat |
| 9 | The auditor reads attendance, leave and approvals and is refused 11 writes (fence, settings, workflow, bulk status, recalculation, leave record, employee edit, report schedule, Finance connector, delegation, a decision) with nothing changed; the Sohar branch manager reads their own branch but not an HQ employee (by id, timeline, leave, search) and cannot edit one |
| 10 | Flowza Finance connector against a mock Finance server in the script (`attendance-export` + `attendance-ingest`): test connection with typed values (a wrong token is AUTH_FAILED), save (token masked, never echoed), test with the stored token, one web punch pushed and one Finance punch pulled on "Sync now", a second sync never sends the pulled punch back, disconnect |
| abuse | Another organisation's id in the path (local: a real second organisation created by an outsider) → 403 / 404, its employee's id through this organisation → 404; organisation / employee ids in bodies ignored (a punch, a leave request, a fence); a replayed punch (same idempotency key) returns the original, one row; a future-dated / client-timestamped punch is stored at the server's time; deciding a level twice changes nothing; editing an approved reason is refused; batches above their limits (bulk status 201 items, bulk decide 101 items) are refused |

A step that fails because of a defect another agent is already fixing is recorded as `KNOWN: <owner>` (the flow then reads
`PASS (KNOWN)`), so a run can be green while the owner's fix is pending.
