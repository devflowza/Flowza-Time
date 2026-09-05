# Synchronisation Engine

Design reference: `docs/blueprint.md` §F, ADR-004, ADR-006. Schema: `supabase/migrations/0800_sync_engine.sql`, `0900_jobs_queue.sql`.
Code: `packages/database/src/queue.ts` (JobQueue port + Postgres implementation), `apps/worker/src/{runner,scheduler}.ts`,
`apps/worker/src/handlers/sync/*` (job handlers), `apps/worker/src/tasks/*` (scheduler ticks), `packages/domain/src/sync/retry.ts`.

## Two layers
| Layer | Table | Meaning |
|---|---|---|
| User-facing sync job | `sync_jobs` → `sync_job_items` → `sync_attempts` | "Sync employees to branch X": one row per (device, employee/operation) with counters and per-item results |
| Execution | `jobs.queue` (+ `jobs.queue_archive`) | Generic durable jobs with fairness, retries and dead letters; one queue job per item (or per batch for bulk-capable providers) |

Progress counters on `sync_jobs` are updated atomically per item (`items_success`, `items_failed`, `items_offline`,
`items_unsupported`, `items_pending`); the outbox emits `sync.completed` / `sync.failed` and the UI receives an invalidation
signal on `org:<id>:sync`.

## Job lifecycle
```
enqueue (same transaction as the state change, dedupe_key) → pending
dequeue (fair: least-running org first, priority desc, run_at asc; per-org cap) → running (locked_by, locked_at)
handler ok → complete → archive(completed)
handler error:
   retryable → fail → pending with backoff (30s·2^attempt ±20 %, max 30 min) or vendor Retry-After
   terminal / max attempts → archive(dead) + sync item FAILED/UNSUPPORTED + notification
worker crash → reaper requeues rows whose lock is older than lock_timeout_seconds (LOCK_EXPIRED)
```
Error classification (`apps/worker/src/runner.ts` → `classify()`): `ProviderError` codes map 1:1 to retry decisions in
`packages/domain/src/sync/retry.ts` (`AUTH_FAILED`, `INVALID_CONFIG`, `UNSUPPORTED`, `NOT_IMPLEMENTED`, `PROTOCOL_ERROR`,
`NOT_FOUND` are terminal; `DEVICE_OFFLINE` keeps the item `OFFLINE` while retrying; `RATE_LIMITED` honours `retryAfterMs`).

## Scheduler (leader-elected)
One worker holds `pg_try_advisory_lock(7242026)` on a dedicated session connection and runs enqueue-only ticks:
| Tick | Interval | Enqueues |
|---|---|---|
| poll-due-devices | 15 s | `PULL_ATTENDANCE` per device with `auto_sync_enabled` and `next_attendance_sync_at <= now()`; dedupe key `pull:<device>`; adaptive interval (double after 3 empty polls, reset on data; max = org setting) |
| health-check | 5 min | `DEVICE_HEALTH_CHECK` per active device not seen within its `offline_threshold_minutes` (hysteresis: `consecutive_failures`) |
| reconciliation | per org setting (default 24 h) | `RECONCILIATION` per device |
| relay-outbox | 5 s | `RELAY_OUTBOX` (notifications + realtime) |
| deliver-notifications | 15 s | `DELIVER_NOTIFICATIONS` |
| reap-stale | 60 s | `REAP_STALE` |
| ensure-partitions | 6 h | `ENSURE_PARTITIONS` (keeps 14 months ahead, alerts on default partitions) |
| usage-metering / retention / prune-queue-archive | 1 h / 24 h / 24 h | platform maintenance |
Ticks never do heavy work; missed ticks coalesce because every job is idempotent via `dedupe_key`. Dedupe applies to **pending**
jobs only: enqueueing a key that is currently *running* creates the next run, so data arriving mid-flight is never lost.

## Connectivity modes and handlers
| Mode | Trigger | Handler(s) |
|---|---|---|
| `VENDOR_CLOUD_PULL` / `ON_PREM_SERVER_API` / `LAN` | scheduler poll or manual | `PULL_ATTENDANCE` (cursor from `sync_cursors`, page loop, `ingestRawTransactions`, advance cursor after commit), `PULL_EMPLOYEES`, `PUSH_EMPLOYEE(S)`, `DELETE_EMPLOYEE`, `DEVICE_HEALTH_CHECK`, `TEST_CONNECTION` |
| `VENDOR_WEBHOOK` | API `/webhooks/providers/:key/:deviceId/:token` | API verifies the vendor signature **once, over the original raw bytes**, stores the verified *normalised* result in `provider_webhook_events` (replay protection), enqueues `WEBHOOK_EVENT` → handler ingests the stored transactions without re-parsing or re-verifying; slow reconciliation poll still runs |
| `DEVICE_PUSH` | API `/device-push/:protocol/*` | API identifies the device by serial (+ push token), ingests raw rows synchronously (idempotent, cheap), updates heartbeat, returns pending `device_commands`; employee push = command rows created by `PUSH_EMPLOYEE`, acknowledged via the protocol's result endpoint |

## Webhook verification happens exactly once (decision)
HMAC-style vendor signatures cover the raw request bytes. Those bytes exist only while the API handles the call: anything
re-serialised later (`JSON.stringify(parsedBody)`) differs in key order, whitespace and unicode escapes and would fail the
check — the earlier worker fallback that re-parsed a stored body through `provider.handleWebhook` could therefore never succeed
and would also have required the raw body (possibly carrying biometric templates) to be persisted. Decision: the API is the
single verification point; `provider_webhook_events.payload` stores `{ vendorDeviceId, eventType, transactions: RawTransaction[],
rawBodySha256, rawBodyBytes, verifiedAt }` with `signature_valid` on the row, `payload_hash = sha256(rawBody)` for replay
protection, and the worker's `WEBHOOK_EVENT` handler only ingests `transactions` (a row without them is marked `failed`).
Rejected signatures are stored as `rejected` rows with the body hash only.

## One fan-out implementation
`createSyncJob(trx, queue, input)` lives in `@flowza/database` (`packages/database/src/sync-jobs.ts`) and is used by the worker
(scheduler ticks, PUSH_EMPLOYEES/RECONCILIATION fan-outs) and by the API (`apps/api/src/services/features/sync-jobs.ts`, run as a
system step inside the caller's transaction after the permission/branch checks). It inserts `sync_jobs` + `sync_job_items`, enqueues
one queue job per item through `JobQueue.enqueue` (`app.enqueue_job`, same transaction) with the dedupe keys documented in
`apps/worker/src/handlers/sync/api.ts`; an item whose key is already pending (a manual pull while the scheduled pull waits) is
marked `SKIPPED` (`result.skipped = 'duplicate_in_flight'`) and the 202 reply reports `itemsQueued` / `itemsSkipped`
(`status: 'SUCCESS'` when nothing new was queued). Likewise the dedupe hash of raw punches is computed by ONE function
(`dedupeHash` in `packages/database/src/ingest-hash.ts`) for device push (API) and polls/webhooks (worker).

## Idempotency & cursors
- Raw rows are unique on `(organization_id, device_id, provider_transaction_id, punched_at)` and on the dedupe hash
  `sha256(device_id|device_generation|device_employee_id|punched_at|verification|direction)`; re-runs are safe.
- Cursors are opaque provider JSON validated by the provider on read; unparseable cursors reset to a time-based cursor
  (`invalid_since` set, alert), operator rewinds keep `previous_cursor`/`rewind_reason`.
- A factory-reset device gets `devices.generation += 1` (new hashes, cursor reset, reconciliation job).

## Throttling & fairness
- Per-org running cap in `jobs.dequeue` (default 5) → a 500-device tenant cannot starve others.
- Per-provider account throttling in the worker (`packages/device-providers/src/throttle.ts`: semaphore + token bucket); when
  exhausted the job is rescheduled a few seconds later instead of blocking a slot.
- Circuit breaker per (org, provider, account) in `provider_circuit_states`: after N consecutive vendor errors the circuit opens,
  devices show `vendor_degraded` (not `offline`), jobs are rescheduled to the half-open probe time.

## Employee ↔ device synchronisation
`device_employee_states` holds the desired/actual state per (device, employee): `cloud_hash` vs `device_hash` decides whether a
push is needed; `PULL_EMPLOYEES` marks `OUT_OF_SYNC` / device-only users; `RECONCILIATION` produces a diff summary on the job
(cloud-only, device-only, differing, unmatched punches, duplicates) which the UI turns into *Repair* actions (new push/delete jobs).
Terminations enqueue `DELETE_EMPLOYEE` on every enrolled device.

## Scaling path
Postgres queue → batching per vendor account → adaptive intervals → separate worker pools per queue family → move `jobs` to its
own Postgres/pgmq/Redis behind the `JobQueue` port (no handler changes). Details: blueprint §K, ADR-006 review note.
