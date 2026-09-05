# ADR-006: Postgres-backed fair job queue behind a `JobQueue` port

**Status:** Accepted · **Date:** 2026-09-05

## Problem
Durable, retried, tenant-fair asynchronous work (device sync, attendance processing, reports, imports,
notifications, retention) with no extra infrastructure for local development, and a credible path to
very large scale.

## Options
1. Supabase Queues (pgmq) + pg_cron.
2. Redis + BullMQ.
3. Graphile Worker / pg-boss.
4. **Custom `jobs.queue` table with `FOR UPDATE SKIP LOCKED`, fairness-aware dequeue function, scheduler
   with advisory-lock leader election, archive table; all behind a `JobQueue` interface.**

## Decision
Option 4.

## Reasons
- Fairness across organisations (per-org running cap, least-served-first) and provider throttling are
  first-class requirements that none of the off-the-shelf options provide without wrapping anyway.
- Transactional enqueue with domain writes (no lost or phantom jobs); idempotent enqueue via `dedupe_key`.
- Works on plain Postgres — local tests need nothing but the database; pgmq/pg_cron are not available in a
  stock local Postgres and Redis would be a second service.
- The port keeps the door open: when queue throughput or write amplification becomes a problem, the same
  handlers run on BullMQ or a dedicated queue database.

## Trade-offs
- We own ~300 lines of queue SQL/TS and must test crash recovery (lock timeouts/reaper) ourselves.
- Queue writes share the primary database; mitigated by archiving, batching and adaptive polling; scale
  path documented in the blueprint §K.
