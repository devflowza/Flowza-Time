-- FlowZa Time · 20260928001110 · Security & quality gate — queue indexes (HR portal Prompt 10; plans in
-- docs/hr-portal/reports/10-security-gate.md §6).
--
-- EXPLAIN (ANALYZE, BUFFERS) of the three queue reads on the seeded database with a year of volume (220k approval requests,
-- 440k seats, 30k reasons, 5k report schedules, 205k jobs):
--   * the approval inbox ("Mine", pending) and the team pending counts are served by the existing partial indexes
--     (approval_step_actors_user_pending_idx, approval_requests_pending_unique_idx, attendance_notes_queue_idx /
--     attendance_notes_active_idx, approval_delegations_*_idx) — nothing to add;
--   * the report schedule runner's due scan uses report_schedules_due_idx; its "already queued or running" check
--     (apps/worker/src/tasks/reports.ts: `dedupe_key = any(…) and status in ('pending', 'running')`) could not use
--     jobs_queue_dedupe_idx, which is partial on `status = 'pending'` only (it is the uniqueness of pending jobs), and ran a
--     parallel sequential scan of the whole job table on every scheduler tick (205k rows: 32 ms, growing with the backlog).
--     A partial index over the in-flight jobs answers it from the index alone (0.3 ms).
--
-- Additive and idempotent; built inside the migration's transaction (the replay is single-transaction, so no CONCURRENTLY)
-- under lock_timeout 5s: a busy queue fails fast rather than blocking the workers.
-- Runbook (large hosted job table): build it first out of band with
--   create index concurrently if not exists jobs_queue_inflight_dedupe_idx on jobs.queue (dedupe_key)
--     where dedupe_key is not null and status in ('pending', 'running');
-- (same name, same definition); the statement below is then a no-op.

set lock_timeout = '5s';
set statement_timeout = '300s';

create index if not exists jobs_queue_inflight_dedupe_idx on jobs.queue (dedupe_key)
  where dedupe_key is not null and status in ('pending', 'running');
comment on index jobs.jobs_queue_inflight_dedupe_idx is 'The scheduler''s "occurrence already queued or running" check (report schedules); pending-only uniqueness stays jobs_queue_dedupe_idx.';

-- post-verify
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_index i
    join pg_catalog.pg_class c on c.oid = i.indexrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'jobs' and c.relname = 'jobs_queue_inflight_dedupe_idx' and i.indisvalid
  ) then
    raise exception 'security gate: jobs_queue_inflight_dedupe_idx is missing or invalid';
  end if;
end $$;
