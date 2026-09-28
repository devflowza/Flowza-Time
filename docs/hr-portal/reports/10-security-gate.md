# Phase 10: Security and quality gate

**Prompt:** `docs/hr-portal/prompt-pack.md` §Prompt 10, plus the coordinator brief. The brief asks for eight things: RLS invariants and a generated cross-tenant probe, a route authorisation matrix, abuse tests, schema traps, a dependency audit and secret hygiene, partial indexes with EXPLAIN, tenant-key immutability and the residuals, and `docs/security.md`.
**Branch:** `worktree-agent-a812ee8d7b8d8f371`, based on `319efde`.
**Migrations:**
- `20260928001100_security_gate.sql`
- `20260928001110_security_gate_queue_indexes.sql`
- `20260928001120_platform_grant_approval.sql`

**Date:** 2026-09-28.

**Status:** 19 findings, all fixed on this branch, each with a regression test (§3). Two defects sit inside areas that parallel fixes own. They are covered by the generic tests and allow-listed with the owner named, not fixed here (§4).

Gates are in §8: all green, apart from one time-of-day flake that predates this branch and is explained there.

Nothing was applied to the hosted project; that is Prompt 12. The hosted runbook is in §9.

## 1. What shipped, per deliverable

### 1.1 RLS invariants and the generated cross-tenant probe

**`supabase/tests/rls_invariants.sql`** runs last in `run-rls-tests.sh`. It is catalogue-driven: nothing in it names a feature, so a table, partition, policy or function added later is held to the same rules automatically.

| # | Invariant |
|---|---|
| I1 | Every table in `public` and `audit` has RLS on. Tenant tables have it **forced** when their owner could bypass it. |
| I2 | Every tenant table has a permissive SELECT policy, and no policy or privilege for `anon`/PUBLIC. |
| I3 | Every tenant table has an index whose first column is `organization_id`. Every foreign key of a tenant table has a covering index. |
| I4 | Every tenant table carries `organization_id_immutable`. A generated probe tries to move one row of **each** table to another org and expects 42501. |
| I5 | Every table in `public` and `audit` carries `<table>_no_data_api`. `rls_data_api.sql` checks this behaviourally: it connects **as `authenticator`** and reads, inserts, updates and deletes nothing. |
| I6 | Partitions are storage only: RLS on, and no privilege for `anon`, `authenticated` or `flowza_system`. |
| I7 | System-written tables (42 "RPC-only" tables) have no client write privilege, no permissive client write policy, and the three restrictive `_deny_client_*` policies. A member holding **every** permission is refused every write. |
| I8 | Privilege implies policy. A client write privilege is backed by a permissive client policy for that command; latent privileges are revoked. |
| I9 | SECURITY DEFINER functions have a pinned `search_path` and are not executable by PUBLIC or `anon`. |
| I10 | Schemas without RLS (`jobs`) grant no USAGE to `anon` or `authenticated`. |
| X1 | **Generated cross-tenant probe.** Org A's rows are cloned into a second organisation. A member of A holding every permission (custom role, all branches, linked to a line manager) reads 0 of that organisation's rows in **every** tenant table, updates or deletes 0, and has every insert refused. The system context of A also reads 0. Positive control: the same statements reach A's own rows. |
| X2 | **Self-addressed probe.** Same clone, but every user reference points at the probing member. A non-member reads none of the organisation's rows, even the ones addressed to them. |

The allow-lists are self-policing: an entry that no longer matches anything fails the suite.

Numbers on a fresh reset:

| What | Count |
|---|---|
| Tables with RLS | 98 |
| Tenant tables | 87 |
| Partitions locked | 777 |
| `_no_data_api` policies | 98 |
| RPC-only tables | 42 |

The existing suites were updated to the new rules: `rls_isolation`, `rls_leave`, `rls_approvals`, and the runner, which adds `rls_data_api` and `rls_invariants`.

### 1.2 Route authorisation matrix: `apps/api/src/test/route-authz.test.ts`

The matrix is generated from `app.routes`, covering every route under `/api/v1/orgs/:orgId` and `/orgs/:orgId/*` and `/api/v1/platform/*`. Five checks:

- **(a) Declared.** Every organisation route declares its permission in the matrix, or is listed in `MEMBERSHIP_ONLY` (13 entries, each with a reason). An undeclared route fails.
- **(b) Anonymous.** 401 for an anonymous caller on every route.
- **(c) Non-member.** 403 for a member of another organisation, and 403 for a member without the declared permission. The test fails on any 5xx **or 429**, because a 429 would hide the check; see finding P3-1.
- **(d) Holder passes.** A holder of exactly the declared key passes the authorisation step (not 401/403).
- **(e) Platform routes.** Every `/platform/*` route gives 401 anonymously, and 403 to an organisation owner and to a caller with no permissions.

Mutation-checked:
- a new unauthorised route is caught;
- a route downgraded to membership-only is caught (`listBranches`);
- a removed matrix entry is caught.

Samples for the body schemas come from `apps/api/src/test/schema-sample.ts`. It walks the Zod schemas via `z.toJSONSchema(io: 'input')` and has three `SAMPLE_HINTS` for refinements the JSON schema cannot express.

### 1.3 Abuse tests

**`apps/api/src/test/abuse.test.ts`** has 16 tests over two organisations.

- **Client-supplied identifiers are ignored or refused.**
  - `employeeId` and `organizationId` in note and leave bodies are ignored.
  - Report `branchIds` outside scope are stripped.
  - A report `branchId` outside scope gets 403.
  - Bulk-deciding a foreign request gets `NOT_FOUND`.
- **Punch replays.**
  - Five concurrent identical punches produce one row.
  - Server time is authoritative, and a past `clientQueuedAt` is ignored.
  - A regularisation dated in the future gets 400.
- **Mock location.** Under the `block` policy the punch gets 403 `MOCK_LOCATION`. Under `flag` it gets 201, flagged `isMock`.
- **Self-approval is refused** in five ways:
  - as HR;
  - as the manager holding the `hr_user` role;
  - through a delegation to oneself (400);
  - through a delegation to the requester;
  - through bulk decide.
- **Locked approvals.**
  - A double decision is a no-op; concurrent approve and reject are both no-ops after the first.
  - Deciding a step that is not current gets 409.
  - An approved note, regularisation or leave cannot be edited (409).
- **Caps.** Eight batch endpoints refuse an oversized batch with 400 `VALIDATION_ERROR`.
- **Exports.**
  - All 7 export routes return 403 for a role holding everything except `report.export`. The export list is checked against the app for completeness.
  - CSV formula injection is escaped.
- **Selfie uploads.**
  - HTML, SVG and a PNG/HTML polyglot get 400.
  - An oversize upload gets 413.
  - Another organisation's employee gets 403.
  - A path-traversal filename is stored at `employee-photos/checkins/<org>/<employee>/<id>.png`.
- **E-mail action tokens.**
  - Stored hashed.
  - GET does nothing.
  - Bound to the recipient and to the action.
  - Single-use, including the sibling token.
  - Expire.

**`apps/worker/src/handlers/reports/render/csv.test.ts`** (2 tests) checks formula escaping in the worker's CSV renderer.

### 1.4 Schema traps: `apps/api/src/test/schema-traps.test.ts`

Seven tests over the body and query schema of every `/api/v1` route, plus the settings group schemas:

- PATCH/PUT `{}` parses to `{}`, so no default silently overwrites stored values.
- A one-field PATCH carries only that field.
- Unknown keys are never passed through, except in the `MAPS` and `STRICT` allow-lists.
- Every array has `maxItems`. Every string has `maxLength`, unless it is an enum, a const, a bounded format or a bounded pattern. Every map has bounded keys.
- There are no identity fields (`employeeId`, `userId`, …) in self-service requests, and no `organizationId` in organisation routes.
- The allow-lists are honest: each entry must still match something.

All four mutation probes were caught.

### 1.5 Dependency audit and secret hygiene

- **`pnpm audit`** (full, and `--prod`): 1 moderate advisory, 0 high, 0 critical. Details in §7.
- **`apps/web/src/test/secret-hygiene.test.ts`** (5 tests) reads the git-tracked files and checks:
  - `apps/web` never names the service-role key, `sb_secret_`, the database URLs or a server-side secret variable, and never assigns a password literal in code;
  - no committed file holds a private key, a service-role JWT or a Supabase secret key;
  - committed env files hold only empty values or placeholders;
  - credentialed URLs point at the local loopback database only;
  - the `VITE_*` variables are exactly the three public ones in `PUBLIC_VITE_VARS`, and the Vite env prefix stays `VITE_`.

  The scan skips exactly one file: itself, since it names the strings it looks for. Mutation-checked.

### 1.6 Partial indexes and EXPLAIN

Plans are in §6. One index was added:

```sql
jobs_queue_inflight_dedupe_idx on jobs.queue (dedupe_key)
  where dedupe_key is not null and status in ('pending','running')
```

Migration `001110`. It takes the report scheduler's in-flight check from 32.4 ms to 0.44 ms.

The approval inbox and the team pending counts are already served by the existing partial indexes. The one slow half is fixed by a query rewrite (§6, 2b*), which is recommended to its owner rather than changed here.

The scripts are committed as `scripts/perf/queue-volume.sql` and `scripts/perf/queue-explain.sql`, so the plans can be reproduced.

### 1.7 Tenant-key immutability and the residuals

- **Tenant key.** `organization_id_immutable` (BEFORE UPDATE, 42501) is on every tenant table. The generators add it to future tables.
- **Residuals closed by `_no_data_api`, for every table at once.** The phase reports left several direct-write paths open, all of which went through the data API:
  - a leave withdrawn around the approval engine;
  - a day mark written for oneself;
  - a membership or invitation carrying a role its writer does not hold;
  - a client-chosen branch column;
  - the API-only masking of employee DOB, phone and address.
- **Explicit write denials.** The same residuals also get explicit denials (I7), and the API's leave and day-mark writes moved into its system step:
  - `day-marks.ts`;
  - leave `common.ts`, `self-leave`, `hr-balances`, `hr-leave`.

### 1.8 `docs/security.md`

Rewritten after the gate. It covers:
- the 60 permission keys × 10 system roles matrix;
- the RLS model, both contexts (member and system/platform) and the data-API rule;
- approval segregation of duties;
- storage buckets and their path rules;
- secrets;
- API hardening (organisation access gate, platform access gate, caps, upload order, rate limits);
- inbound endpoints;
- a "Testing the model" table naming the suite that proves each claim.

## 2. Checks run

- Every invariant I1–I10, X1, X2 on a fresh reset (`flowza_p10_rls`, via the runner).
- The route authorisation matrix, 7/7. Schema traps, 7/7. Abuse, 16/16. Middleware scope, 3/3. Web grants table, 2/2. Secret hygiene, 5/5.
- Mutation checks:

  | Suite | What was broken to prove it catches it |
  |---|---|
  | Route authz | an unauthorised route; a downgrade to membership-only; a removed matrix entry |
  | Schema traps | 4 of 4 mutations |
  | Middleware scope | the old app-wide inbound wiring |
  | Secret hygiene | a needle planted in another `apps/web` file |
  | Invariants | an allow-list entry that no longer matches |

- EXPLAIN (ANALYZE, BUFFERS) of the three queue reads at a year's volume, run in the application's own execution context (§6).
- `pnpm audit` and `pnpm audit --prod`.
- The full gate list (§8), including the single-transaction replay of every migration and the e2e suite.

## 3. Findings

Severity scale: P0 = cross-tenant data exposure; P1 = privilege escalation, or bypassing a control around the approval engine; P2 = scoped leak or broken control; P3 = hardening or performance.

| # | Sev | Finding | Fix | Commit |
|---|---|---|---|---|
| 1 | **P0** | The monthly and default partitions of `attendance_events`, `attendance_raw_transactions`, `device_logs` and `sync_logs` had **RLS disabled** and inherited `authenticated=arwd`. Any signed-in user, even one in no organisation, could read and write every tenant's punches and logs through `/rest/v1/<partition>`. | All 777 partitions locked (RLS on and forced, no client privilege). `app.ensure_month_partitions` locks new ones. Invariant I6. | f73c382 |
| 2 | **P1** | Privilege escalation through memberships, membership branches and invitations. Only custom role definitions were guarded, so a member could grant a role or branches beyond their own, or the owner role. | `app.guard_membership_write`, `…_branch_write`, `…_invitation_write`: every change is bounded by what the writer holds. The API's `updateMember` now also applies the all-branches rule. | f73c382 |
| 3 | **P1** | `attendance_day_marks` was client-writable directly, so an employee could mark their own day. | RPC-only (I7). The API writes it in its system step. | f73c382 |
| 4 | **P1** | The leave tables (records, allocations, comp-off credits and usages) were client-writable directly. This included the withdrawal residual: a leave withdrawn around the approval engine. | RPC-only. All writes go through `systemStep` after the service's checks. | f73c382 |
| 5 | P1/P2 | **Data API exposure.** Every table in `public` was reachable through PostgREST and pg_graphql under the table policies alone. This bypassed API-only rules (column masking, engine-only writes). | A restrictive `<table>_no_data_api` policy on all 98 tables (session login `authenticator` refused); I5 plus a behavioural suite connected as `authenticator`. | f73c382 |
| 6 | P2 | **The tenant key was mutable.** A member holding a key in two organisations could move a row between tenants. | `organization_id_immutable` on every tenant table (I4, generated probe). | f73c382 |
| 7 | P2 | **The system context crossed organisations.** Ten policies used a bare `app.is_system()`, so organisation A's system step read and wrote B's subscriptions, entitlements, feature-flag overrides, quotas, usage, platform grants, pending devices, provider events, report requests and audit log. | Scoped to the claimed organisation, the platform context, or rows of no organisation. X1 system half. | f73c382 |
| 8 | P2 | **Former members kept reading self-addressed rows** (notifications, preferences, report deliveries and requests) after leaving the organisation. | Self predicates require an active membership. X2. | f73c382 |
| 9 | P2 | **Self employee re-link.** A member could link their own login to another employee record and inherit that employee's self-service view. | Refused unless the writer is an owner, in both the guard and `members.service.ts`. | f73c382 |
| 10 | P2 | SECURITY DEFINER functions were executable by PUBLIC and `anon`. | EXECUTE revoked from PUBLIC and `anon`; migration-only procedures revoked from every application role. I9. | f73c382 |
| 11 | P2 | **Latent client write privileges**: tables granting `authenticated` INSERT/UPDATE/DELETE with no policy for it. Such a privilege silently opens the table the day somebody adds a permissive policy. | Revoked. Schema default privileges no longer grant client writes on new tables. I8. | f73c382 |
| 12 | P2 | **The second approver of a platform write grant was only a claim.** A platform admin could give themselves write access to any tenant by typing another admin's id as `approvedBy`. | Write grants are created **pending** (a window that ended at creation grants nothing). Only the named approver starts them, in their own session, via `POST /platform/access-grants/:id/approve`, within 24 h. DB constraints make an active unapproved write grant impossible. Web: pending badge, Approve button, en and ar. | b9bb6ff |
| 13 | P3 | **The inbound limiter capped the whole API.** `inbound` was mounted at `/` with `use('*')`, so its edge gate and 60/min limiter applied to every request. This throttled normal traffic and made route-authz check (c) partly vacuous (429 instead of 403). | Scoped to `INBOUND_PREFIXES` (`/device-push`, `/webhooks`). `middleware-scope.test.ts`. | 0695c10 |
| 14 | P3 | **Platform routes parsed the body before authorising.** | `v1.use('/platform/*', platformAccessGate())` (`requirePlatformAdmin` before validation). Route-authz (e). | 0695c10 |
| 15 | P3 | **Work before authorisation.** Selfie and import uploads were parsed before authorisation; the import template had no permission; and there was no organisation access gate before body parsing. | An organisation access gate on `/orgs/:orgId` and `/orgs/:orgId/*`. Uploads authorised first. The template requires the import permission. | 1bfd83b |
| 16 | P3 | **Unbounded request fields.** Examples: `employees.customFields` accepted arbitrary JSON; the contact `website`, device `endpointUrl` and device `config` were unbounded; so were `allowedEmailDomains` items, `codeOverrides` keys, role permission arrays, shift `sequence`, holiday `branchIds`, and report `status`. | Every array, string and map in the contracts is capped. `employeeCustomFieldsSchema` allows max 50 fields; `deviceConfigSchema` max 64. Schema traps. | 95f28da |
| 17 | P3 | **The report scheduler's in-flight job check sequentially scanned `jobs.queue`** on every tick: 32.4 ms at 205k jobs, growing with the backlog. | Partial index `jobs_queue_inflight_dedupe_idx`, 0.44 ms. | 4c84133 |
| 18 | P3 | Missing `organization_id`-leading indexes and foreign-key covering indexes on tenant tables. RI checks of a parent delete scanned children once per row. | Indexes generated for every gap (I3). | f73c382 |
| 19 | P3 | RLS was not forced on tenant tables whose owner can bypass it. | Forced where safe (I1). A WARNING names any table where forcing would blind the definer helpers. | f73c382 |

Test-only commits:

| Commit | What |
|---|---|
| fb76079 | route authorisation matrix |
| 0af7ce3 | schema traps |
| d43a02e | abuse tests |
| b1bd4d5 | secret hygiene |
| c901ba8 | lint of the mock import |
| a45ce19 | perf scripts |
| 858b1d3 | secret-hygiene self-exclusion, needed once the file is committed |

Docs: 31cdd6e.

## 4. Allow-lists, with reasons

| Where | Entry | Reason |
|---|---|---|
| `rls_invariants.sql` `system_scope` | `domain_events` | **Owned by the Prompt 8 fix (in flight).** `domain_events_system` is `app.is_system() OR organization_id = app.system_org_id()`, with CHECK `app.is_system()`: any organisation's system context reads and writes every organisation's events. The Prompt 8 fix replaces these outbox policies (8-P0-1). The entry becomes stale when that fix lands, and the suite then **fails**, telling the integrator to delete it. |
| route-authz `MEMBERSHIP_ONLY` | 13 routes | Routes any member may call, each with its reason in the file. **Organisation context:** the org's profile, settings (+ one group) and the role catalogue, which every member's UI renders (writes need `organization.manage` / `role.manage`). **Filtered by the caller's own keys:** search. **Scoped to the caller by assignment:** the approval inbox (×2), history, mine, bulk-decide (only requests routed to the caller), own delegations, team pending counts, and the notes review queue. Each service was read to confirm the scoping. |
| route-authz `SAMPLE_HINTS` | 3 | Refinements (date ranges, cross-field rules) that JSON Schema cannot express, so the generated sample would be refused as invalid rather than as unauthorised. |
| schema-traps `MAPS` | 6 | Genuine string-keyed maps, all bounded in keys and values: integration credentials (root); device `config` (device and test-connection); platform feature flags `flags`; employee `customFields` (POST and PATCH). |
| schema-traps `STRICT` | 4 | Objects that deliberately reject unknown keys with 400 instead of stripping them: notification preferences (root and items); report-schedule `filters` (POST and PATCH). |
| schema-traps `IDENTITY_ALLOWED` | 3 | `/me/notifications` (GET) and `/me/notification-preferences` (GET, PUT) take `organizationId` in the **query**. These routes are not under `/orgs/:orgId`, so the query names which membership, and the service checks it. |
| secret-hygiene `PUBLIC_VITE_VARS` | 3 | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (publishable; `anon` holds no privilege and RLS denies it every row), `VITE_API_URL`. |

**Areas owned by others, with defects noted but not fixed here:**

- **Prompt 5/6b fix:** `createInvitation` has no `allBranches` check in the service. The new database guard `app.guard_invitation_write` refuses it anyway, so this is defence in depth only.
- **Prompt 5 (team workspace):** the notes pending-count query shape (§6, 2b). A performance recommendation, not a defect.

## 5. Tests added

| File | Tests | Purpose |
|---|---|---|
| `supabase/tests/rls_invariants.sql` | I1–I10, X1, X2 | Catalogue-driven invariants and the generated probes |
| `supabase/tests/rls_data_api.sql` | — | Connected as `authenticator`: every table refuses the data API |
| `apps/api/src/test/route-authz.test.ts` | 7 | Generated route authorisation matrix |
| `apps/api/src/test/schema-traps.test.ts` | 7 | Request-schema traps |
| `apps/api/src/test/abuse.test.ts` | 16 | Abuse cases |
| `apps/api/src/test/middleware-scope.test.ts` | 3 | Inbound gate and limiter scoped to their paths; platform gate |
| `apps/api/src/test/review.test.ts` | +1 | Pending, then approved, platform write grant |
| `apps/web/src/features/platform/…/grants-table.test.tsx` | 2 | Approve flow in the UI |
| `apps/web/src/test/secret-hygiene.test.ts` | 5 | Secret hygiene |
| `apps/worker/src/handlers/reports/render/csv.test.ts` | 2 | Formula escaping |

The shared harness stub now implements the full `ProviderRegistry`. The partial stub had turned `integrations/finance/test` into a 500 once the limiter stopped masking it.

## 6. EXPLAIN plans

**Setup.** Database `flowza_p10`: the deterministic seed plus `scripts/perf/queue-volume.sql`:

| Added | Volume |
|---|---|
| Organisations | 200 |
| Approval requests | 220k (10% pending), 440k seats |
| Delegations | 1 per organisation |
| Notes | 60 days for 500 employees (30k) |
| Report schedules | 5,025 |
| Jobs | 205k (5k pending, 50 running) |

**How it was run.** `scripts/perf/queue-explain.sql`, with `EXPLAIN (ANALYZE, BUFFERS)`, in the application's execution context: role `authenticated` plus JWT claims for hr@ or manager@, and `flowza_system` platform claims for the scheduler. Each query runs inside a rolled-back transaction. Plans are condensed; the full output reproduces from the scripts.

### 1. Approval inbox, "Mine", pending (hr@, 1,003 actionable)

```
1a total     Aggregate                                                           44.0 ms
               Hash Join (approval_requests.id = approval_actionable_request_ids(org))
                 Index Scan using approval_requests_pending_unique_idx  rows=2006  (RLS filter)
                 Hash <- HashAggregate <- ProjectSet (the SECURITY DEFINER function)  rows=1003
1b page      Limit 25 <- Sort top-N heapsort (created_at, id) <- same Hash Join  16.7 ms
1c function  Unique <- Append                                                    10.1 ms
               Bitmap Index Scan on approval_step_actors_user_pending_idx  rows=1006
               Index Scan approval_steps_pkey (loops=1006), approval_requests_pkey (loops=1006)
               delegation branch: approval_delegations_org_delegate_idx  rows=1 -> 0
```

Every access is indexed. The cost is proportional to the org's pending set (2,006) and the caller's own seats (1,006), not to history (220k).

### 2. Team pending counts (manager@, 21 direct reports)

```
2a approvals half   Function Scan approval_actionable_request_ids                  1.9 ms
2b reasons half     HashAggregate <- Hash Right Anti Join (r.entity_id = n.id)    79.6 ms
                      Index Scan approval_requests_pending_unique_idx  rows=40
                        Rows Removed by Filter: 1966   (per-row RLS predicate)
                      Bitmap Heap Scan attendance_notes <- attendance_notes_active_idx  rows=37
2b* recommended     GroupAggregate <- Nested Loop Anti Join                         5.3 ms
                      Bitmap Heap Scan attendance_notes <- attendance_notes_active_idx  rows=37
                      Index Scan approval_requests_pkey (id = n.approval_request_id)  loops=37
2c secondary seats  Index Scan approval_step_actors_via_delegation_of_fk_idx -> 0 rows  0.2 ms
```

**Why 2b is slow.** It is the only part above 50 ms. `entity_type = 'ATTENDANCE_NOTE'` is an enum comparison, and `enum_eq` is not leakproof. Under RLS it therefore cannot become an index condition, so the anti join walks all 2,006 pending requests of the organisation and evaluates the RLS predicate on each.

**Recommended rewrite (2b\*).** Anti-join through the note's own `approval_request_id`: 5.3 ms, and it no longer grows with the organisation's queue. The query belongs to the team workspace (Prompt 5 fix scope), so it is recommended there and not changed on this branch.

**Rejected index.** A pending `approval_requests (organization_id, entity_id)` index was tried. It did not help under RLS for the same leakproofness reason, so it was not added.

### 3. Report schedule runner (platform context)

```
3a due schedules   Limit 200 <- Sort top-N <- Hash Join organizations               6.7 ms
                     Bitmap Index Scan on report_schedules_due_idx  rows=2035
3b in-flight check
   before (319efde)  Gather <- Parallel Seq Scan on queue  Rows Removed by Filter: 68317 x3   32.4 ms
   after  (001110)   Index Only Scan using jobs_queue_inflight_dedupe_idx  rows=100            0.44 ms
```

The existing `jobs_queue_dedupe_idx` is partial on `status = 'pending'` only, because it enforces uniqueness of pending jobs. So it could not answer `status in ('pending','running')`. The new partial index answers it from the index alone.

## 7. `pnpm audit`

Command: `pnpm audit`, and `pnpm audit --prod`, run 2026-09-28. The result is identical for both.

| Severity | Count |
|---|---|
| critical | 0 |
| high | 0 |
| moderate | 1 |
| low | 0 |

**The one moderate:**
- **Advisory:** GHSA-w5hq-g745-h8pq. `uuid <11.1.1`, "missing buffer bounds check in v3/v5/v6 when `buf` is provided".
- **Path:** `apps/worker > exceljs > uuid`.
- **Not reachable.** exceljs only calls `v4()` without a buffer, and the worker never calls uuid directly.
- **Why not fixed.** The fix needs `uuid@11`, a major version under exceljs, and the brief forbids new or bumped dependencies.
- **Status:** documented, to revisit when exceljs moves.

## 8. Gates

Environment: `PGHOST=127.0.0.1 PGPORT=54329`. Databases: `flowza_p10_rls`, `flowza_p10_ci2`, `flowza_p10_tx`. Shared suites ran under `flock /tmp/flowza-dbtests.lock`.

| Gate | Result |
|---|---|
| `pnpm build:packages` | ✅ |
| `pnpm lint` | ✅ |
| `pnpm -r --filter "./apps/*" run typecheck` | ✅ |
| `pnpm test:unit` | ✅ shared 4, contracts 45, domain 347, device-providers 286, database 21 |
| `pnpm --filter @flowza/web run test` | ✅ 84 files, 470 tests (after 858b1d3; the first run of part A caught the hygiene test matching itself once committed, and that commit fixes it) |
| `run-rls-tests.sh` (`flowza_p10_rls`) | ✅ "RLS tests passed"; every suite including invariants (611 `ok:` checks) and the data API suite |
| `pnpm test:db` | ✅ 5 files, 24 tests |
| `pnpm --filter @flowza/api run test` | ⚠️ 41 files, 521/522: the only failure is the time-of-day flake below (run at 20:25 UTC) |
| `pnpm --filter @flowza/worker exec vitest run` | ✅ 22 files, 225 passed, 1 skipped |
| `pnpm -r --filter "./apps/*" run build` | ✅ |
| `db-reset-local.sh` (`flowza_p10_ci2`) | ✅ every migration, including 001100/001110/001120, "database flowza_p10_ci2 ready" |
| single-transaction replay (`flowza_p10_tx`) | ✅ "single-transaction replay OK" |
| `build:e2e` + `test:e2e` (`CI=1`, system Chromium) | ✅ 64 passed (1.3 min) |

**Time-of-day flake, predates this branch.** `apps/api/src/routes/v1/portal-requests.test.ts` › "counts the recent days that need a reason…" fails between 20:00 and 24:00 UTC. `isoToday` uses UTC while the organisation is in Muscat (UTC+4), so after 20:00 UTC the day the test seeds as "today, still running" is already the org's yesterday. It is counted, and the test sees 2 instead of 1. That is exactly the observed failure (run at 20:25 UTC). The test file, the features harness and `services/portal/*` are unchanged on this branch (the diff against `319efde` is empty for them); this branch's only `portal-attendance.ts` change is the selfie authorisation order. Outside 20:00–24:00 UTC the seeded "today" is the org's today and is not counted. Not changed here, because it is in the Prompt 4/5 area.

## 9. Hosted runbook and merge notes

**Order.** `001100` → `001110` → `001120`. All three are additive and idempotent, with `lock_timeout` 5s. Each ends with a post-verify block that fails the migration rather than leave a partial state.

**Indexes on hot tables.**
- `001100` builds its index gaps in-transaction. The hosted project holds 54 employees, so they are small.
- For a large hosted `jobs.queue`, pre-build `001110`'s index out of band; the migration's own statement is then a no-op:
  ```sql
  create index concurrently if not exists jobs_queue_inflight_dedupe_idx on jobs.queue (dedupe_key)
    where dedupe_key is not null and status in ('pending','running');
  ```
- The same approach applies to any `001100` index if a table has grown: take the name and definition from the migration.

**Before applying `001100` hosted:**
- Confirm nothing calls PostgREST or pg_graphql for **tables**. The web uses `/api/v1`, Supabase Auth and Realtime broadcast only.
- `_no_data_api` refuses the `authenticator` login. Storage and Realtime evaluate policies under their own logins, so they are unaffected.

**`001120`:**
- Existing write grants are backfilled as approved at their creation time. They lapse within 72 h anyway.
- `platform_access_grants_approver_distinct` is added `NOT VALID` and then validated. If an old row violates it, it stays `NOT VALID` with a WARNING rather than failing the deploy.

**Merge notes for the integrator:**
- **Default privileges.** The schema's default privileges no longer grant `authenticated` INSERT/UPDATE/DELETE on new `public` tables. A new client-writable table must be granted by its migration: use the generators, which grant together with the policies.
- **Gate policies target `flowza_client`,** the group role `authenticated` and `anon` inherit. New policies written for `authenticated` still work.
- **New routes and tables must pass the gate.** Every new route must appear in the route matrix (or `MEMBERSHIP_ONLY` with a reason) and pass the schema traps. Every new table must pass I1–I10.
- **Prompt 8 ordering.** Prompt 8's migration (`001050`) sorts before these, so the gate's generators and invariants apply over its tables.
- **Prompt 8 allow-list entry.** When the Prompt 8 fix scopes `domain_events_system`, the `system_scope domain_events` entry becomes stale and the invariant suite fails on purpose. Delete the entry.

## 10. Limits and open items

**Out of scope for these tests:**
- **Storage and Realtime policies** are asserted by the existing suites and by upload behaviour in the abuse tests. They were not re-generated catalogue-wide, because `storage.objects` belongs to the local shim.
- **Rate limits.** Tested for scope (they no longer apply app-wide), not for exact thresholds under load.
- **Hosted project.** Nothing applied (Prompt 12). EXPLAIN volumes are synthetic, and plans on hosted data may differ.

**Open items:**
- The `domain_events` system scope (Prompt 8 fix, §4).
- The `createInvitation` all-branches service check (Prompt 5/6b fix; database-enforced already).
- The notes pending-count rewrite, 2b\* (Prompt 5 fix).
- The `uuid` moderate advisory under exceljs.
- The `portal-requests` time-of-day flake.
