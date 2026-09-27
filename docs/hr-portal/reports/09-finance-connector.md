# Phase 9 — Flowza Finance ↔ FlowZa Time attendance sync connector (FlowZa Time half)

**Prompt:** `docs/hr-portal/prompt-pack.md` §Prompt 9 + the coordinator brief (provider, worker push, identity, state table, integration settings API/UI).
**Branch:** `worktree-agent-aebfcd44d9b8777e7` (rebased on `0749045`, the Prompt 1 head) · **Migration:** `supabase/migrations/20260928000400_finance_connector.sql` · **Date:** 2026-09-27.
**Status:** every gate green (§8). Nothing applied to the hosted project (Prompt 12); the Finance half (`attendance-export`, `attendance-ingest`) lives in the Finance repository.
**User guide:** `docs/integrations/flowza-finance.md`.

## 1. What shipped

### Database (one additive, idempotent migration — re-applying it is a no-op, verified)
- **`integration.manage`** is Prompt 1's key (`20260928000100`, owner + org_admin). This migration restates it with Prompt 1's exact values and `on conflict do nothing`, so it can neither drift nor widen the grants, and its post-verify asserts the owner grant.
- **Provider row `flowza_finance`** (`VENDOR_CLOUD_PULL`, `beta`, `REPORTED`, sort 5) — byte-for-byte what `definitionToRow(FLOWZA_FINANCE_DEFINITION)` produces; `registry.test.ts` now reads both reference migrations and pins it. One **model row** "Flowza Finance connector" (family `Integration`).
- **Feature flag `provider_flowza_finance`**, default off: hides the connector from the device wizard's provider list.
- **`sync_job_type` + `PUSH_ATTENDANCE`** (no existing kind described "send attendance to a remote system").
- **`domain_events_event_type_check`** relaxed from one to one-or-two dots (`^[a-z_]+(\.[a-z_]+){1,2}$`, added `not valid` then validated) so `sync.finance.failed` fits.
- **`public.finance_sync_state`** — one row per connector device: `device_id` (PK, composite FK `(device_id, organization_id)` → devices, cascade), `organization_id`, `last_pushed_event_id` + `last_pushed_event_at` (the push keyset position; CHECK both-or-neither), `last_push_at`, `last_push_count`, `next_push_at`, `last_pull_at`, `last_pull_count`, `last_error`, `last_error_at`, `consecutive_failures`, `created_at`, `updated_at` (trigger). RLS: `app.apply_readonly_tenant_policies(…, 'device.view')` — read with `device.view`, written only by the system context of the same organisation; a platform-context SELECT for the scheduler; INSERT/UPDATE/DELETE revoked from `authenticated`, so a client write **raises** instead of silently touching nothing.
- **Index `attendance_events (organization_id, created_at, id)`** for the push keyset walk.
- Safety net (every public table has RLS) + post-verify (permission + owner grant, provider + model rows, system write policy present, no client write policy, no client write grant, event-type check validated).

### Contracts (`packages/contracts`)
- `integrations.ts`: `FLOWZA_FINANCE_PROVIDER_KEY`, `FINANCE_DEFAULT_BASE_URL`, `FINANCE_PIN_KEYS`, `FINANCE_SYNC_DIRECTIONS`, `FINANCE_POLL_MINUTES` (5–60, default 10), input/test schemas and the DTOs of the four endpoints.
- `SYNC_JOB_TYPES` + `PUSH_ATTENDANCE`; `DOMAIN_EVENT_TYPES` + `sync.finance.failed`. (`integration.manage` was already in `PERMISSIONS` from Prompt 1 — not duplicated.)

### Provider (`packages/device-providers/src/providers/flowza-finance/`)
- `definition.ts` — capabilities `attendancePull` + `deviceStatus` (everything else false; not a push protocol); config fields `baseUrl` (url, default), `deviceSerial`, `token` (password ⇒ secret), `direction`, `pinKey`, `pollMinutes`; throttling 1/device, 2/account, 60 req/min.
- `mapping.ts` — the HTTP contract (lenient zod: unknown keys ignored, one bad punch never fails a page), verify/state vocabularies (incl. ADMS numeric codes), cursor parsing (`{ since: <Finance next_cursor> }`, anything else ⇒ `INVALID_CONFIG` so the engine rewinds), `financeCursorFromTime` (rewind cursor in Finance's own format with the nil uuid), `parseFinanceTime` (PostgREST ISO with 0–6 fractional digits, Postgres text form, naive ⇒ UTC), `resolveFinanceBaseUrl` + `isPrivateHostname` (the connector's egress rule).
- `provider.ts` — `FlowzaFinanceProvider`: one `post()` for both functions (throttled via `ctx.acquire`, bounded by `ctx.signal`, `redirect: 'manual'`, 16 MB response cap, status → `ProviderError`, token never in a message or `details`); `testConnection` (never throws), `getDeviceStatus` (limit-1 export, clock skew), `pullAttendance`, `pushAttendance` (1–500 punches) behind the `FinancePushCapable` interface + `hasFinancePush` guard; employee operations `UNSUPPORTED`.
- `mock-finance-server.ts` — `node:http` stand-in for both functions (serial+token auth, keyset paging with base64url cursors, ingest dedupe on `serial|pin|time|state`, unmapped PINs, fault injection incl. hangs); shared by provider, worker and API tests. No new dependency.
- Registry: `defaultRegistry({ flowzaFinance: { allowPrivateHosts } })`, `PROVIDER_SORT_ORDER.flowza_finance = 5`.

### Worker (`apps/worker`)
- **Pull**: the connector is an ordinary auto-sync device, so `poll-due-devices` + `PULL_ATTENDANCE` + `ingestRawTransactions` do the work unchanged (raw rows `source='POLL'`, `device_id` = connector, dedupe on Finance's id). Hooks: `recordFinancePull` on success, `recordFinanceFailure(…, 'pull')` on failure, and adaptive back-off is disabled for the connector so "sync every N minutes" holds.
- **Identity** (`handlers/attendance/finance-identity.ts`, wired into `normalizeBatch`): connector rows resolve on the configured `pinKey` first (employee number case-insensitive via `lower(::text)`, device user id, card number; same organisation, not deleted), then the explicit device-identity mappings reconciliation writes (device state, provider identity). They never fall through to the generic `employees.device_user_id` match. Anything else stays `unmatched`.
- **Push** (`handlers/sync/finance-push.ts`, job type `PUSH_ATTENDANCE`, dedupe key `finance-push:<device>`): see §2.
- **State + alert** (`handlers/sync/finance-state.ts`): pull/push bookkeeping, failure streak in its own transaction (never throws), `sync.finance.failed` exactly when the streak reaches 3 (once per streak; a success resets it). Outbox `ROUTING['sync.finance.failed']` → in-app notification to `device.sync` holders, link `/settings/integrations` (templates en/ar: Prompt 8).
- **Scheduler** (`tasks/finance.ts`, tick `finance-push` every 30 s): active connectors with direction `push|both`, org active/trial, `next_push_at` null or due, no `PUSH_ATTENDANCE` item in flight ⇒ one SCHEDULED sync job per organisation; `next_push_at` moved forward by `pollMinutes` at admission.
- Scheduled reconciliation skips the connector (it has no device user list; reconciling it would report every employee "missing on device").
- Config `FLOWZA_ALLOW_PRIVATE_EGRESS` (default false) → `defaultRegistry` option.

### API (`apps/api`)
- `services/features/integrations.service.ts` + `routes/v1/features/integrations.ts` (the four endpoints of §3), registered in `features/index.ts`.
- Generic device mutations refuse the connector with 409 "managed in Settings → Integrations": create, claim-pending, PATCH, credentials, remove/decommission (reads, logs, health checks, attendance syncs keep working). Without this a `device.update` holder could re-point the endpoint and a `device.manage` holder re-key it around `integration.manage`.
- The connector does not consume a plan device seat; manual reconciliation (`POST /sync/reconcile`) excludes it.
- Config `FLOWZA_ALLOW_PRIVATE_EGRESS` (default false); test harness accepts a `providers` registry.

### Web (`apps/web`)
- **Settings → Integrations** (`/settings/integrations`, nav entry and route guarded by `integration.manage`; the section itself also refuses without it and never calls the API): form (enable, base URL, serial, token with masked "replace" flow, direction, PIN key, poll minutes), **Test connection** with the result (latency, code, stored-token badge, Finance time, first punch), **Sync status** card (last pull / last push with counts, consecutive failures + last error, unmatched punches → `/attendance?tab=raw&processingStatus=unmatched&deviceId=…`, circuit-breaker notice, recent jobs → `/sync/:id`), **Sync now**. en + ar.
- Device detail page: a notice on the connector pointing to Settings → Integrations. `jobType.PUSH_ATTENDANCE` label (en + ar).

## 2. Design as built

**Pull (Finance → FlowZa Time).** `pullAttendance` POSTs `{ device_serial, token, since?, limit }` (limit default 500, max 1000) to `<baseUrl>/attendance-export`. Each punch becomes a `RawTransaction`: `providerTransactionId` = Finance `id`, `deviceEmployeeId` = `employee_number ?? pin` (rows with neither are skipped and counted), `punchedAt` = `time_utc` (UTC; sub-millisecond digits truncated deterministically), `deviceLocalTime` in the producing device's zone, `verificationMethod`/`direction` from `verify`/`state`, `rawPayload` = allowlist `{ financeId, employeeNumber, pin, source, deviceSerial, deviceTimezone, state, verify, workcode, lat, lng, accuracy, geofenceVerdict, geoFlagged, createdAt, connectorSerial }` (bounded strings). The stored cursor is `{ since: next_cursor }` verbatim; on an empty page (`next_cursor` null) the position we asked from is kept — including a synthesised rewind position, never "from the beginning". `hasMore` = Finance's `has_more` **and** a non-empty page **and** an advancing cursor; the engine's page cap (20 pages/run, then the next poll in 1 minute) bounds the loop.

**Push (FlowZa Time → Finance).** Per run: load the connector, stop when direction is `pull`, check the circuit, read the keyset position, then batches of ≤ 500 `attendance_events` in creation order `(created_at, id) > position`, filtered to: this organisation, not voided, `source ∈ {DEVICE, MOBILE, IMPORT, CORRECTION}`, not produced by the connector (neither `device_id` nor the raw transaction's `device_id`), older than a 5-second settle window. Each event maps to `{ pin: <employee's pinKey field>, time: punched_at ISO UTC, verify: method (unknown ⇒ null), state: PUNCH_IN→check_in, PUNCH_OUT→check_out, BREAK_START→break_out, BREAK_END→break_in, PUNCH→null, workcode: null, lat/lng/accuracy from the raw payload }`; employees without that field are skipped and counted. `provider.pushAttendance` POSTs `{ device_serial, token, punches }`; **only after a 2xx** does a separate transaction advance `last_pushed_event_id/at`. At most 20 batches per run; when more remain, `next_push_at = now` so the next tick continues. Health (device online, heartbeat) and the circuit are updated only when a request actually went out.

**State.** `finance_sync_state` holds the push position and both directions' last run, counts and the failure streak; pull cursors stay in `sync_cursors` like every device's. The API's status endpoint joins both plus the provider circuit, the connector's unmatched/pending raw counts and its last five pull/push jobs.

**Failures.** Provider errors map to the sync engine's codes (401/403 `AUTH_FAILED`, 400 `PROTOCOL_ERROR`, 404/405 `INVALID_CONFIG`, 429 `RATE_LIMITED` with Retry-After, 5xx/network `VENDOR_ERROR` retryable, abort `TIMEOUT`, 3xx `PROTOCOL_ERROR` — redirects are never followed). `runItem` applies the standard retry backoff; vendor-level codes feed the per-account circuit breaker; auth/config errors flag the device `error`. Every failed attempt of either direction increments `consecutive_failures`; the third emits `sync.finance.failed`.

**Egress.** The base URL must be `https` on a public host (IPv4 private/loopback/link-local/CGNAT/multicast, IPv6 loopback/ULA/link-local/mapped, `localhost`, `*.local`, `*.internal`, `*.lan` and bare names refused), no credentials, query or fragment. Enforced on save and test by the API (`resolveFinanceBaseUrl` + the existing `assertEndpointAllowed` egress helper) and on every call by the provider. `FLOWZA_ALLOW_PRIVATE_EGRESS=true` (local development against the mock server only) relaxes it.

## 3. Endpoints

All require `integration.manage` (403 otherwise); none ever returns the token.

| Method & path | Body | Result |
|---|---|---|
| `GET /api/v1/orgs/:orgId/integrations/finance` | — | `FinanceIntegrationDto` (`configured`, `enabled`, `deviceId`, `branchId`, `baseUrl`, `deviceSerial`, `direction`, `pinKey`, `pollMinutes`, `hasToken`, `tokenMasked` e.g. `****cdef`, `connectionStatus`, `lastErrorCode`, `lastError`, `updatedAt`); unconfigured ⇒ defaults with `configured: false` |
| `PUT /api/v1/orgs/:orgId/integrations/finance` | `{ enabled=true, baseUrl=default, deviceSerial, token?, direction='both', pinKey='employee_number', pollMinutes=10, branchId? }` | creates or updates the connector `devices` row (code `FLOWZA-FINANCE`, model "Flowza Finance connector", tags `integration`/`flowza-finance`, `auto_sync_enabled = enabled && direction ≠ push`, `sync_interval_minutes = pollMinutes`, status active/disabled), stores the token through `DeviceCredentialsStore` (masked copy only), ensures the state row, audits `integration.finance_created`/`_updated` (never the token) and emits `device.created`/`device.updated`. The token is required on creation and whenever the base URL or serial changes; otherwise omitted = keep. 400 on validation or egress violations |
| `POST /api/v1/orgs/:orgId/integrations/finance/test` | `{ baseUrl?, deviceSerial?, token? }` (missing values from the stored connector) | `{ ok, message, latencyMs, code, retryable, serverTime, firstPunchAt, usedStoredCredentials }` — `attendance-export` with `limit: 1` through the provider's `testConnection` (10 s budget, throttled). The stored token is reused only for the stored base URL **and** serial |
| `POST /api/v1/orgs/:orgId/integrations/finance/sync-now` | — (idempotency header honoured) | 202 `{ pullJobId, pushJobId, message }` — MANUAL `PULL_ATTENDANCE` and/or `PUSH_ATTENDANCE` per the direction; 409 when not configured or disabled; audited |
| `GET /api/v1/orgs/:orgId/integrations/finance/status` | — | `{ configured, enabled, deviceId, connectionStatus, state, cursor, circuit, unmatchedCount, pendingCount, lastJobs[5] }` |

## 4. Configuration keys

| Where | Key | Values / default |
|---|---|---|
| `devices.config` (connector) | `baseUrl` | https URL, default `https://ucjtxdmklhhhvayirwqe.supabase.co/functions/v1` (any https public host is accepted, e.g. a `finance.flowza.ai` path) |
| | `deviceSerial` | 3–64 chars `[A-Za-z0-9_.-]`, e.g. `FLOWZA-TIME-ACME` (also stored in `devices.serial_number`) |
| | `direction` | `pull` · `push` · `both` (default) |
| | `pinKey` | `employee_number` (default) · `device_user_id` · `card_number` |
| | `pollMinutes` | 5–60, default 10 (mirrored in `devices.sync_interval_minutes`) |
| `device_credentials` (encrypted) | `token` | 8–256 chars; masked in every read (`****` + last 4) |
| env (API + worker) | `FLOWZA_ALLOW_PRIVATE_EGRESS` | `false` (default) · `true` for local development against the mock server only |

## 5. Loop guards

1. **Finance never exports what the connector pushed** (Finance side: `attendance-export` excludes rows whose `device_id` is the connector's own device).
2. **FlowZa Time never pushes what it pulled.** Pulled punches are raw transactions of the connector device, and their events carry `device_id` = connector; the push excludes events whose `device_id` **or** whose raw transaction's `device_id` is the connector. Tested: the pulled events exist in `attendance_events` and none of their times reaches the mock Finance.
3. The connector is excluded from employee pushes (capabilities false), reconciliation (scheduled and manual) and plan seats; its row can only be changed through the integration endpoints.

## 6. Registering the Finance virtual device (from Finance's `docs/hr-portal/flowza-time-sync.md` §1)

In Flowza Finance: Sidebar → **Workforce** (`/hrms/workforce`, HR+) → **Devices & Punches** → **Devices** → **Add device** (also `/hrms/workforce-config`; needs `hrms.workforce_devices.manage`).
1. **Friendly name** `FlowZa Time`; **Serial / SN** `FLOWZA-TIME-<company code>` (unique per company; serial + token is the whole credential); **Connection method** **LAN Agent / REST** (`integration_method = 'agent_rest'`); **Device timezone** the company's IANA zone (only used for naive push times — FlowZa Time always sends UTC with `Z`).
2. Tick **Auto-map PINs to employee numbers (connector devices)** (`connector_config.auto_map_by_employee_number = true`): `attendance-ingest` then maps each new PIN to the employee whose employee number equals it (exact match, same organisation, not terminated/merged) before ingesting. Without it, map PINs in **Workforce Config → PIN Mapping** / **Unmapped Punches**.
3. **Save.** For `agent_rest` Finance mints a 32-hex token and shows **Ingest endpoint**, **device_serial** and **token**. Copy serial + token into FlowZa Time → Settings → Integrations; keep the default base URL (`https://ucjtxdmklhhhvayirwqe.supabase.co/functions/v1`). **Test connection**, **Save**, **Sync now**.
4. Rotation: Finance → edit device → **Regen** → **Save**, then FlowZa Time → **Replace** token → **Save** (both directions answer 401 in between). Cut-off: the **Enabled** toggle in Finance refuses both directions immediately.

## 7. Decisions (recorded)

1. **Permission grants follow Prompt 1's matrix** (owner + org_admin). The first draft also granted `attendance_admin`; dropped after the rebase — widening a Prompt 1 grant is not this prompt's call.
2. **State keyed by connector device**, not `(org, direction)` as sketched in the prompt pack: one connector per org in practice, both directions on one row, and the device FK gives cascade + RLS for free. Pull cursors stay in `sync_cursors`.
3. **Push position = `(created_at, id)` keyset**, stored as Postgres **text** (microseconds intact — a JS `Date` truncates to ms and would re-select the last row forever), plus a 5-second settle window against late commits. `attendance_events.id` is random and `punched_at` can be back-dated, so neither orders creation.
4. **No `state='void'` markers for voided events** (prompt pack suggested them, "Finance ignores"). Verified in the Finance repo: `ingest_punch` stores `punch_state` verbatim and no pairing/recompute code filters on it, so a marker would be counted as a real punch at the voided time. Voided events are simply not pushed; removals are a known limit.
5. **Identity order for pulled rows:** configured PIN field → explicit reconciliation mappings → otherwise unmatched; the generic `device_user_id` fallback is skipped for connector rows (a Finance number or foreign terminal PIN coinciding with a local device user id would silently mis-attribute). Employee numbers compare via `lower(employee_number::text)`: the worker's `search_path` lacks `extensions`, so a bare comparison on the citext column silently turns case-sensitive (caught by a test).
6. **`deviceStatus: true`** in addition to `attendancePull`, so the ordinary health check probes the connector (limit-1 export) — the only honest liveness signal for a push-only connector with nothing to send.
7. **`PUSH_ATTENDANCE`** as the job type (new enum value) and **`finance-push`** as the scheduler tick name (house style for tick names; the brief's "`finance.push` task" is this tick + job).
8. **Three-segment event type** `sync.finance.failed` (the brief's name) — required relaxing the `domain_events` CHECK, done additively (`not valid` + `validate`).
9. **Adaptive polling disabled for the connector**, so the configured interval is the real cadence (Finance shows the device Stale/Offline from the time of last contact).
10. **Health/circuit only on real contact:** a push run with nothing to send records its (empty) run in the state but does not mark the device online.
11. **Generic device mutations refuse the connector** (and the wizard hides the provider behind a default-off flag); the connector takes no plan seat and is not reconciled.
12. **Mock Finance server shipped from the package** (`createMockFinanceServer`) so provider, worker and API tests exercise the real HTTP path, and **`allowPrivateHosts`** is an explicit option / env flag rather than a test-only code path.

## 8. Verification

| Gate | Command | Result |
|---|---|---|
| Packages build | `pnpm build:packages` | ✓ |
| Lint | `pnpm lint` | ✓ (0 warnings) |
| Typecheck apps | `pnpm -r --filter "./apps/*" run typecheck` | ✓ api, web, worker |
| Unit | `pnpm test:unit` | ✓ shared 4 · domain 194 · device-providers 165 (flowza-finance 24 incl. conformance 6; registry 20 incl. `flowza_finance matches its device_providers row`) · database 20 |
| Web | `pnpm --filter @flowza/web run test` | ✓ 49 files / 187 tests (new `integrations-section.test.tsx`: 8) |
| RLS | `PGDATABASE=flowza_p9_rls flock /tmp/flowza-dbtests.lock bash supabase/tests/run-rls-tests.sh` | ✓ "RLS tests passed", 107 assertions (14 new on `finance_sync_state`: own-org read for owner and branch manager, cross-tenant 0, employee 0, client insert/update/delete raise; system context reads/updates own org only, cross-org insert raises) |
| DB | `flock /tmp/flowza-dbtests.lock pnpm test:db` | ✓ 2 files / 11 tests |
| API | `pnpm --filter @flowza/api run test` | ✓ 18 files / 179 tests (new `integrations.test.ts`: 8 — permission matrix, egress + token validation, creation with encrypted token never returned, device-API guard + plan seat + reconciliation exclusion, token kept vs demanded on identity change, test connection against the stub incl. `AUTH_FAILED` and no stored-token reuse for another serial, sync-now payload contract + status, disabled connector) |
| Worker | `flock /tmp/flowza-dbtests.lock pnpm --filter @flowza/worker exec vitest run` (= the package's `test` script) | ✓ 11 files / 113 passed, 1 skipped (pre-existing Chromium PDF test) — new `finance.test.ts`: 9 (pull ingest + cursor + state, idempotent re-pull + full re-sync dedupe, interval not stretched, identity paths incl. case-insensitive number / explicit mapping / no device-user fallback / unmatched; push ordering + sources + GPS + break state + MANUAL/voided/pulled exclusion + position only after 2xx, batching + skipped PIN fields + batch cap with continuation, failure streak + single `sync.finance.failed` + reset, pull auth failure, pull-only skip, scheduler admission/in-flight/direction) |
| Apps build | `pnpm -r --filter "./apps/*" run build` | ✓ (web: pre-existing chunk-size warning) |
| Replay | `PGDATABASE=flowza_p9_ci2 bash scripts/db-reset-local.sh` | ✓ all migrations; re-applying `20260928000400` on top is a no-op |
| Types | `DATABASE_URL_ADMIN=…/flowza_p9 pnpm db:types` | ✓ `packages/database/src/generated/db.ts` committed (`FinanceSyncState`, `SyncJobType` + `PUSH_ATTENDANCE`) |

(The literal `flock … pnpm --filter @flowza/worker run test` was refused by this session's worktree command guard; the equivalent `exec vitest run` is what that script runs.)

## 9. Known limits and open items

- **Removals are not propagated** (Decision 4). Needs a Finance-side void/delete endpoint keyed on the pushed punch.
- **Late attribution in Finance does not re-attribute an already-pulled row** (raw rows are immutable and dedupe on Finance's id); map the Finance PIN in FlowZa Time's reconciliation instead. Finance's recommended daily re-pull is not scheduled — a manual **full re-sync** (Sync → attendance) re-reads safely; the commit-order window it would close is milliseconds wide.
- **Egress check is name/pattern based** (like the existing helper): a public hostname resolving to a private address is not detected; no DNS pinning.
- `consecutive_failures` counts every failed attempt of either direction (retries included), so a flapping pull can raise the alert while pushes succeed; the alert fires once per streak.
- Adaptive polling is org-wide; the exemption is keyed on the provider.
- Playwright e2e mock backend (`apps/web/e2e/support/mock-backend.ts`) not extended with the integration endpoints; notification templates (en/ar) for `sync.finance.failed` belong to Prompt 8; live round trip against the Finance project is Prompt 12.
- The device list still shows the connector (for health, logs and raw-punch filtering); its edit/credential/remove actions answer 409 with a pointer to Settings → Integrations rather than being hidden.
