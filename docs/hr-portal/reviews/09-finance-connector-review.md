# Prompt 9 review — Flowza Finance connector (FlowZa Time half)

Reviewed `worktree-agent-aebfcd44d9b8777e7` @ `72daa36` (commits `8620b45..72daa36` on `0749045`) in a clean worktree. No tracked file was changed. Throwaway probes (15 worker, 7 API, 1 web, 4 node scripts) were run and then deleted, and `git status` is clean. Databases used: `flowza_rev9`, `flowza_rev9_rls`, `flowza_rev9_ci2`, plus the harness DBs the probes create per pid and drop again.

Evidence logs (scratchpad): `probe-worker-evidence.log`, `probe-api-evidence.log`, `probe-web-evidence.log`, and the node probes `probe-size.mjs`, `probe-hasmore.mjs`, `probe-egress.mjs`, `probe-status.mjs` under `/tmp/claude-0/-home-user/3e053703-0570-5920-ab25-0c5288142d30/scratchpad/`.

## 1. Gates (all re-run from scratch)

| Gate | Command | Result |
|---|---|---|
| Install + packages | `pnpm install --frozen-lockfile && pnpm build:packages` | ✓ |
| Lint | `pnpm lint` | ✓ 0 warnings |
| Apps typecheck | `pnpm --filter @flowza/api --filter @flowza/web --filter @flowza/worker run typecheck` (same as `-r --filter "./apps/*"`, which the worktree guard refused) | ✓ api, web, worker |
| Unit | `pnpm test:unit` | ✓ shared 4 · domain 194 · device-providers 165 · database 20 (contracts: no tests) |
| Web | `pnpm --filter @flowza/web run test` | ✓ 49 files / 187 tests |
| RLS | `PGDATABASE=flowza_rev9_rls flock … run-rls-tests.sh` | ✓ "RLS tests passed", 107 `ok:` assertions, 14 of them on `finance_sync_state` |
| DB | `flock … pnpm test:db` | ✓ 2 files / 11 tests |
| API | `pnpm --filter @flowza/api run test` | ✓ 18 files / 179 tests |
| Worker | `flock … pnpm --filter @flowza/worker exec vitest run` | ✓ 11 files / 113 passed, 1 skipped |
| Apps build | `pnpm --filter @flowza/api --filter @flowza/web --filter @flowza/worker run build` | ✓ (web shows the chunk-size warning it already showed before) |
| Fresh replay | `PGDATABASE=flowza_rev9_ci2 bash scripts/db-reset-local.sh` | ✓ 27 migrations |
| Second apply | `psql -d flowza_rev9 -f 20260928000400_finance_connector.sql` on the seeded DB | ✓ no errors; the permission insert reports `INSERT 0 0`; permissions, role grants, provider-row md5, policies and index are unchanged |
| Types | `DATABASE_URL_ADMIN=…/flowza_rev9 pnpm db:types` then `git diff --exit-code -- packages/database/src/generated/db.ts` | ✓ no diff, so nothing needed restoring |

Every gate passed, and every count matches the phase report.

## 2. Defects

### D1 — P0 (security): the SSRF guard is name-based and can be bypassed; the test endpoint is a port-scan oracle
- **Where:**
  - `packages/device-providers/src/providers/flowza-finance/mapping.ts:223-231`: `isPrivateHostname` only matches name patterns and does not strip a trailing dot.
  - `apps/api/src/services/features/devices.service.ts:85`: the `PRIVATE_HOST` regex has no `.internal`, `.local` or `.lan` entries.
  - `provider.ts:91`: the socket error code goes into the error message.
  - `integrations.service.ts:186-187`: that message is returned to the caller.
- **Repro 1 — API probe A2, production defaults (no `FLOWZA_ALLOW_PRIVATE_EGRESS`, default registry).** `POST /orgs/:org/integrations/finance/test` as the owner:
  - `https://localtest.me:<open port>/functions/v1` → `200 {ok:false, message:"… unreachable (ERR_SSL_PACKET_LENGTH_TOO_LONG)", latencyMs:16}`
  - the same host on a closed port → `"… unreachable (ECONNREFUSED)", latencyMs:5`
  - `localtest.me` resolves to 127.0.0.1, so the answer distinguishes an open loopback port on the API host from a closed one.
  - `https://flowza-time-api.internal./…` and `https://intranet./…` pass validation and reach `fetch` (here they fail with ENOTFOUND; on Fly `*.internal` resolves to 6PN `fdaa::` addresses).
  - Controls: `127.0.0.1` and `.internal` without the trailing dot are refused (400).
  - `PUT` also accepts `https://localtest.me:<port>/functions/v1` (200). The worker then calls it on every poll, and the same message comes back through `/status` in `state.lastError`.
- **Repro 2 — egress matrix (`probe-egress.mjs`).** Both checks accept: `intranet.`, `db.internal.`, `metadata.google.internal.`, `printer.local.`, `nas.lan.`, `app.localhost.`, `localtest.me`, `7f000001.nip.io`, `[fec0::1]`, `[::127.0.0.1]`.
- This contradicts report §2 ("`*.internal`, `*.lan` and bare names refused") and AGENTS.md ("egress helper that blocks private IP ranges").
- **Fix:**
  - Strip one trailing dot before classifying the host.
  - Resolve the host at call time (`dns.lookup` with `all: true`) and refuse any loopback, private, link-local, ULA, CGNAT, site-local or IPv4-compatible/mapped address.
  - Pin the connection to the vetted address, e.g. a custom `lookup` on the `fetch` dispatcher, so DNS rebinding does not work.
  - Return a generic "unreachable" message without low-level codes to the API caller.
  - Apply the same check in the API (PUT and test) and in the worker.

### D2 — P0 (security / availability): the 16 MB response cap is checked only after the whole body is buffered
- **Where:** `provider.ts:95-96`. It calls `await res.text()` first and checks `text.length > MAX_RESPONSE_BYTES` afterwards.
- **Repro (`probe-size.mjs`, local HTTP server streaming a body):**

  | Body | Peak RSS | Growth | Time | Outcome |
  |---|---|---|---|---|
  | 20 MB | 165 MB | +75 MB | — | `PROTOCOL_ERROR "response is too large"` |
  | 200 MB | 711 MB | +623 MB | 1.1 s | `PROTOCOL_ERROR "response is too large"` |
  | 600 MB | — | +1.2 GB | — | non-`ProviderError`: `Error: Cannot create a string longer than 0x1fffffe8 characters` |

- API and worker machines have `memory = "512mb"` (`fly.api.toml:80`, `fly.worker.toml:46`).
- An `integration.manage` holder can point the base URL at their own public https host that streams a large body. The test endpoint then kills the shared API process, and the scheduled pull does the same to the shared worker on every poll, which becomes a crash loop for all tenants.
- **Fix:** refuse when `content-length` exceeds the cap, and read `res.body` with a byte counter, aborting the request once the cap is passed.

### D3 — P1: per-punch errors from Finance advance the push position, so those punches are lost for good
- **Where:** `apps/worker/src/handlers/sync/finance-push.ts:129-133`. `res.errors` is added to the totals, but the keyset position still advances.
- Finance's `attendance-ingest` answers 200 and only counts `ingest_punch` failures in `errors` (its doc says "per-punch errors are counted, not raised").
- **Repro W1** (mock answers `200 {ok:true, received:1, ingested:0, errors:1}`):
  - first run: `{status:"SUCCESS", pushed:1, ingested:0, errors:1}`, position moves past the event, `consecutiveFailures: 0`
  - second run: `pushed: 0`
  - Finance never stored the punch, and no alert or failure was recorded.
- `probe-status.mjs` confirms that `pushAttendance` resolves successfully on that response.
- The mock server only counts `errors` for malformed input, so the shipped tests cannot see this.
- **Fix:** treat `errors > 0` (or `ingested + duplicates < sent`) as a retryable failure and do not advance the position; Finance dedupes on re-send. Add a poison-batch escape (e.g. give up after N attempts, with an audit row and an alert). Count it in the failure streak.

### D4 — P1: the push keyset skips events whose transaction commits after the 5-second settle window
- **Where:** `finance-push.ts:21` and `:68`. `attendance_events.created_at` defaults to `now()`, i.e. the transaction start (`20260905001100_attendance.sql`).
- **Repro W2**, using the real default settle of 5 s:
  - Transaction T1 inserts event A and is held open.
  - Event B is committed about 1 s later (`created_at` 22:26:15.527 for A, 22:26:16.536 for B).
  - After 5.6 s the push sends B and stores B as the position.
  - T1 then commits.
  - The next two runs push 0; Finance received only `E0100@…05:00`, never A.
- Any event-creating transaction longer than about 5 s does this: normaliser batches of up to 1 000 rows, imports, or corrections running while another event commits.
- The settle window also compares the worker clock (`deps.now()`) with DB-assigned `created_at`, so clock skew between them changes the window.
- **Fix:** bound the scan by commit visibility rather than wall-clock time. Options:
  - add `created_xid xid8 default pg_current_xact_id()` and only push rows with `created_xid < pg_snapshot_xmin(pg_current_snapshot())`;
  - or use an outbox table consumed with `FOR UPDATE SKIP LOCKED`.
  - At minimum, compute the settle window from the database's `now()`.

### D5 — P1: a push run that never contacted Finance resets the failure streak, so `sync.finance.failed` never fires
- **Where:** `finance-push.ts:133` and `:143` call `recordFinancePush`, which sets `consecutive_failures = 0, last_error = null` (`finance-state.ts:47`) even when `totals.requests === 0`.
- **Repro W5** (pull answers 401 each cycle, the scheduled push has nothing to send): `pull:AUTH_FAILED → streak 1 | push:SUCCESS(requests=0) → streak 0` repeated three times, and **0** `sync.finance.failed` events.
- This hits the most actionable alert: a revoked token or a disabled Finance device. It happens in the default `both` direction whenever FlowZa has little of its own to push.
- It contradicts report §9, which says a flapping pull can raise the alert. It also clears `last_error` on the status card every poll.
- **Fix:** only reset the streak and `last_error` when a Finance request actually succeeded (the same rule already used for health and the circuit), or keep a separate streak per direction.

### D6 — P1: a push-only connector is still pulled
- **Where:**
  - `integrations.service.ts:117` writes `capabilities: def.capabilities`, so `attendancePull` is true even for `direction='push'`.
  - `apps/worker/src/handlers/sync/attendance.ts:62` checks the capability only; there is no direction guard (unlike push's guard at `finance-push.ts:105`).
- **Repro A4:** with the connector set to `direction:'push'`, `POST /orgs/:org/sync/attendance {all:true}` → 202 with items `["CONNECTOR:PULL_ATTENDANCE"]`. The device action `sync-attendance` also answers 202 (A3).
- **Repro W6:** `pullAttendance` on a push-only connector → `{status:"SUCCESS", inserted:3}`, one export call.
- This fails the acceptance item "push-only never pulls". The "sync all devices" action alone is enough to import Finance punches the admin opted out of.
- **Fix:** store `attendancePull=false` in `devices.capabilities` when the direction is `push`, and add a direction guard for connector devices in `pullAttendance` that skips the same way push does.

### D7 — P1: pulled rows are matched on the configured `pinKey`, including the raw PIN of a Finance terminal, which can attribute punches to the wrong person
- **Where:**
  - `mapping.ts:181`: identity is `employee_number ?? pin`.
  - `apps/worker/src/handlers/attendance/finance-identity.ts:61-63` matches it against the `pinKey` field.
  - `normalize.ts:132`.
- **Repro W7** (`pinKey=device_user_id`):
  - A Finance row with `employee_number:null, pin:'7'` (a Finance terminal PIN that Finance has not mapped) is normalised to FlowZa employee E0107, whose `device_user_id` is `'7'`.
  - A Finance row that Finance *did* map, `employee_number:'E0100'`, stays `unmatched`.
- The prompt pack says pulled punches are "resolved by employee_number (falls back to the device identity mapping)". Report decision 5 itself says a foreign terminal PIN must never be matched to a local device user id, and that is exactly what happens here. With the default `employee_number` key, an unmapped foreign PIN is still compared with FlowZa employee numbers.
- **Fix:**
  - Resolve pulled rows only by Finance's `employeeNumber` against FlowZa's `employee_number`.
  - Never match the raw `pin`. Keep those rows unmatched under a namespaced id such as `pin:<finance serial>:<pin>` so reconciliation mappings can target them.

### D8 — P1: the loop guard misses corrections of pulled punches
- **Where:** `apps/worker/src/handlers/attendance/corrections.ts:53` inserts CORRECTION events with `deviceId: null, rawTransactionId: null`. The guard at `finance-push.ts:66-67` only checks the device id and the raw transaction.
- **Repro W10:**
  - Pull the Finance punch at 04:31. Its event carries `device_id` = connector.
  - Apply an EDIT_PUNCH correction to 05:30.
  - Push → `pushed:1`. Finance receives `{pin:'E0100', time:'…05:30', state:'check_in', verify:'manual'}` while still holding its original 04:31 punch.
- This breaks the UI hint ("Pulled punches are never pushed back"), the guide §4 ("Not included: anything that came from Finance") and Finance's own loop-guard contract. The result is two conflicting punches in Finance; if the edit moves the time later, Finance's first-in stays wrong.
- **Fix:** exclude CORRECTION events whose `attendance_corrections.original_event_id` points at an event of the connector device, or at least document it and surface a warning.

### D9 — P1: changing the connector's identity keeps the old pull cursor and push position
- **Where:** `integrations.service.ts:102-131`. When the base URL or serial changes, the service requires a new token but does not reset `sync_cursors` or `finance_sync_state.last_pushed_*`, and does not bump `devices.generation`.
- **Repro A7:** `PUT` with a new serial and base URL plus a token → 200. Afterwards the cursor is unchanged, the push position is unchanged (`lastPushedEventId …aa`), and `generation` is still 1.
- **Repro W12:** after re-pointing from a "sandbox" to a "production" Finance whose three rows were created before the old cursor:
  - the first export to the new instance carries the old cursor, and the pull inserts 0;
  - push sends 0 (FlowZa events before the old position never reach the new instance).
- The sandbox → production switch is part of the Prompt 12 plan. AGENTS.md requires cursor invalidation and a generation bump on re-registration.
- **Fix:** on an identity change, reset the cursor (keeping `previous_cursor` and a `rewind_reason`), reset or choose the push start, bump the generation, and audit it. When re-pulling from a Finance instance FlowZa pushed to before, also filter export rows whose `device_serial` equals a previous connector serial.

### D10 — P2: a transient 404/405/400/3xx or bad response shape resets a valid cursor, and older unpulled punches are skipped
- **Where:** `provider.ts:104-105` maps 404/405 to `INVALID_CONFIG` and 400/3xx/bad shape to `PROTOCOL_ERROR`. Both codes are in `CURSOR_RESET_CODES` (`attendance.ts:20`, reset at `:86`), so the engine treats them as a bad cursor and rewinds only 7 days.
- **Repro W8:**
  - Stored cursor points at a row from 10 days ago; an unpulled row exists at 9 days ago and another at 1 day ago.
  - One gateway 404 → `{inserted:1, cursorResets:1}`, `rewindReason: invalid_cursor:INVALID_CONFIG`.
  - Only E0102 (1 day ago) is ingested; the 9-day-old row is never pulled.
- **Fix:** signal cursor problems only from `parseFinanceCursor` (for example with `details.cursor`), and map HTTP-level failures to a code the engine does not treat as a cursor error.

### D11 — P2: only one push per connector at a time is not enforced
- The `finance-push:<device>` dedupe key only collapses *pending* jobs (`jobs_queue_dedupe_idx … where status='pending'`, `20260905000900_jobs_queue.sql:31`). `sync-now` (`integrations.service.ts:213`) does not check for an in-flight push, unlike the scheduler (`tasks/finance.ts:37`).
- **Repro W9:** after job 1 is marked running, a second push job is queued (two queue rows with the same key). Running both concurrently: run A `{pushed:3, dup:0}`, run B `{pushed:3, dup:3}`, 2 ingest requests, Finance saw 3 punches twice.
- Finance dedupes, so nothing is lost, but traffic doubles and the position writes can go backwards.
- **Fix:** hold a lease or lock per connector for the run (for example a conditional lease column on `finance_sync_state`), skip `sync-now` while a push item is in flight, and keep position writes monotonic.

### D12 — P2: every tenant on the default Finance URL shares one worker throttle account
- **Where:** `apps/worker/src/handlers/sync/context.ts:33-40`, `:82`, `:99`. `accountKeyFor` hashes only `baseUrl` and `endpointUrl`.
- **Repro (node, built worker):** two tenants' connectors get the same account key, `b2cc938eaf26fc8f`.
- **Repro W14:** with two leases held on that account by other tenants' conversations, this tenant's push fails with `TIMEOUT: Throttle wait … aborted` after 0 Finance requests. It still records `streak 1` and a `lastError`, and the circuit breaker counts it as a vendor failure (`TIMEOUT` is in `VENDOR_ERROR_CODES`).
- Effect: platform-wide concurrency of 2 Finance conversations per worker process, noisy neighbours, and spurious alerts and circuit opens.
- **Fix:** include the organisation id or serial in the connector's account key, and do not count a throttle-wait timeout as a Finance failure.

### D13 — P2: some generic device endpoints are not fenced off for the connector
- **Repro A3:**
  - `POST /devices/<connector>/actions/reconcile` → 202 and creates a `RECONCILIATION` item for the connector (`devices.service.ts:496`). The report only excludes `POST /sync/reconcile`.
  - `POST /devices/test-connection {providerKey:'flowza_finance', deviceId:<connector>}` as `attendance_admin`, who does not hold `integration.manage` → `ok:true, usedStoredCredentials:true` with Finance's `organizationId`, `connectorDeviceId` and first punch time (`devices.service.ts:370-400`). A different base URL is correctly not given the stored token (0 requests reached the other host).
- **Fix:** refuse `reconcile` and the generic test-connection for `flowza_finance`, and point the caller to the integration endpoints.

### D14 — P2 (i18n): the status card shows raw enum values
- **Where:** `integrations-section.tsx:160` (`{s.connectionStatus}`), `:182` (`{j.status}`), `:174` (circuit `state` interpolated as-is).
- **Repro (web probe, `ar`):** the rendered DOM contains "online", "SUCCESS" and "(open)", while the job type next to them is translated ("إرسال الحضور").
- **Fix:** use the existing `ConnectionBadge` / `devices:connection.*` and `sync:status.*` (as in `status-badges.tsx`), and translate the circuit state.

### D15 — P2: the migration builds a blocking index on the hot partitioned `attendance_events`
- **Where:** `20260928000400_finance_connector.sql:99`. It is a plain `create index` on the partitioned parent, which takes SHARE locks on every partition and blocks punch inserts while it builds, under `statement_timeout 120s`.
- AGENTS.md: "indexes on hot tables use CONCURRENTLY (non-transactional file)".
- **Fix:** `create index … on only` the parent, `create index concurrently` on each partition, then `alter index … attach partition`, in a non-transactional migration.

### D16 — P2: the `sync.finance.failed` notification link is a dead end for most recipients
- **Where:** `apps/worker/src/handlers/notifications/outbox.ts:18` routes the event to `device.sync` holders (hr_user, hr_admin, branch_manager, attendance_admin) with a link to `/settings/integrations`.
- That route and section require `integration.manage`, which only owner and org_admin hold (confirmed in the database).
- **Fix:** route to `integration.manage` holders, or link to a page every recipient can open.

### D17 — P2: the API egress helper wrongly refuses hosts starting with `fc`, `fd` or `fe80`
- **Where:** the unanchored `PRIVATE_HOST` prefixes at `devices.service.ts:85`, now on this feature's save and test path.
- **Repro (egress matrix):** `https://fdic.gov/x` → "Cloud providers cannot target private or loopback addresses."
- A Finance Supabase project whose ref starts with `fc` or `fd` cannot be configured.

### D18 — P2 (hygiene): the mock Finance server ships in the runtime entry point
- **Where:** `packages/device-providers/src/index.ts:21` re-exports `mock-finance-server.js`, a `node:http` test server, from the package the production API and worker import.
- **Fix:** move it to the `testing` entry.

## 3. Checked and found correct (with evidence)

- **Gates:** all of §1, with the counts matching the report.
- **Migration:**
  - The second apply is a no-op (permissions, role grants, provider-row md5, policies and index unchanged).
  - `integration.manage` is granted only to owner and org_admin.
  - The provider row is beta / `VENDOR_CLOUD_PULL` / sort 5.
  - Flag `provider_flowza_finance` defaults to off.
  - Policies: system write, `device.view` select, platform select. Client writes raise an error (RLS suite).
- **Finance contract:**
  - Request bodies for both functions match the Finance code.
  - Status mapping (`probe-status.mjs`):

    | Finance answer | Mapped to |
    |---|---|
    | 400 | `PROTOCOL_ERROR`, not retried |
    | 401 | `AUTH_FAILED`, not retried |
    | 404 / 405 | `INVALID_CONFIG` |
    | 429 | `RATE_LIMITED`, retried with `retryAfterMs` 7000 |
    | 500 / 503 | `VENDOR_ERROR`, retried |
    | 302 | `PROTOCOL_ERROR` (redirects are not followed) |
    | 200 with HTML | `PROTOCOL_ERROR` |
    | network failure | `VENDOR_ERROR`, retried |

  - Finance's conservative `has_more` at `limit=1000` (emulated exactly): 2 calls (1000 rows, then an empty page with `next_cursor` null). The cursor is kept on the empty page, and the next poll resumes after row 1000.
  - Push times are ISO with `Z`, and batches are at most 500 (W4: 500 → `[500]`, 501 → `[500, 1]`).
- **Push ordering:** exactly once across 4 events sharing one `created_at` plus neighbours at `.123456` and `.123457`, over 8 single-event runs: 6 sends, 0 duplicates (W3).
- **Loop guard and dedupe:**
  - Events pulled from Finance are not pushed (existing test).
  - A re-pull after Finance maps the PIN late is not ingested twice (W13: inserted 0, duplicates 1, one raw row).
- **Direction, disable and token rotation:**
  - A pull-only connector never pushes (existing test plus the scheduler filter).
  - A disabled connector makes no requests in either direction (W11: both fail `INVALID_STATE` locally, 0 requests).
  - A rotated token is used on the next run (W11).
- **Circuit breaker:** it opens after 5 × 503; the next push is refused locally with 0 requests and is not counted in the streak. The alert fired once (W15; single emission also covered by the existing test).
- **Tenant isolation and permissions:**
  - The org A owner gets 403 on all five of org B's routes, and org B is unchanged (A1).
  - `hr_user`, `hr_admin` and outsiders get 403 (existing tests); `attendance_admin` gets 403 on GET (A3).
- **Token handling:**
  - Never in the GET, PUT, test, status or sync-now responses; masked `****cdef` on the device (A3).
  - Not echoed in a 400 and not present in audit rows (A6).
  - Never sent to another base URL through either test endpoint (A3, A5: 0 requests).
  - Logger redaction covers `token`, `*.token` and `credentials`; the error handler does not log request bodies.
- **Private-egress flag:** `FLOWZA_ALLOW_PRIVATE_EGRESS` defaults to false, is absent from `fly.api.toml` and `fly.worker.toml`, and `booleanFromEnv` parses `'false'` correctly.
- **Identity:** case-insensitive employee numbers (existing test). Several probe orgs all had an employee `E0100`, and each pulled punch resolved within its own organisation (W7, W10).
- **Push query plan:** the keyset query uses the new index through a Merge Append (EXPLAIN on the seeded tenant with 23 290 events).
- **Web:**
  - en/ar key parity is complete (settings, devices, sync; Arabic has all plural forms).
  - The nav entry, route and section are all gated on `integration.manage`.
  - The masked-token and Replace flow, and the test result display, are covered by the section tests.

## 4. Prompt 9 / AGENTS acceptance items not met

- "push-only never pulls" — D6.
- Pull identity "resolved by employee_number (falls back to the device identity mapping)" — D7.
- Loop guard "never push what it pulled" — D8.
- Alert on 3 consecutive failures — D5.
- AGENTS egress rule "blocks private IP ranges" / test endpoint must not be an SSRF oracle — D1.
- Response bounds — D2.
- Cursor invalidation on re-registration — D9.
- Hot-table index built CONCURRENTLY — D15.
- Prompt pack §6.8, "extend the mock backend for every new endpoint the UI calls": `apps/web/e2e/support/mock-backend.ts` has no `/integrations/finance` routes (the report lists this as open).

## 5. Observations (by code, not defects)

- There is no way to delete the stored Finance token or remove the connector: the generic DELETE is refused and the integration API has no delete. Disabling the device in Finance is the only revocation.
- The first push walks the organisation's whole event history (`finance-push.ts:69`, with a null cursor), and the first pull reads Finance's whole history. There is no start date, and no decision about this is recorded.
- The integration endpoints do all their database work in system context, so RLS never re-checks `integration.manage` (AGENTS rule 2, "authorization twice"). The service-level check is the only gate.
- Usage metering (`handlers/maintenance/index.ts:92`) and the platform tenant device count include the connector, although plan seats exclude it.
