# ADR-004: Hybrid synchronisation (push/webhook first, adaptive polling for reconciliation)

**Status:** Accepted · **Date:** 2026-09-05

## Problem
Attendance must arrive automatically and completely from hundreds of devices per organisation, with
idempotency, cursors, retries and per-vendor rate limits, without a user pressing a button and without
holding HTTP requests open.

## Options
1. Fixed-interval polling of every device.
2. Webhooks/push only.
3. **Hybrid**: webhooks/push for real-time where supported; scheduled polls with incremental cursors and
   adaptive intervals for everything else and as reconciliation for webhook providers.

## Decision
Option 3, implemented as user-facing `sync_jobs` fanned out into `sync_job_items`, executed via the
generic `jobs.queue` (ADR-006). Raw transactions are stored unchanged and idempotently keyed by
`(organization_id, device_id, provider_transaction_id, punched_at)` with a content-hash fallback.

## Reasons
- Polling everything at 1-minute intervals does not scale to 1,000 orgs × 500 devices and violates vendor
  limits; webhooks alone miss events. Reconciliation polls close the gap.
- Incremental cursors advanced only after commit make re-runs safe; dedupe keys stop duplicate polls.
- Manual syncs simply enqueue with higher priority and return a job id; progress is broadcast.

## Trade-offs
- Two code paths per provider (event handler + poller). Mitigated by a shared `ingestRawTransactions`
  and the conformance test suite.
- Adaptive intervals add state per device (`next_attendance_sync_at`, empty-poll counter). Acceptable.
