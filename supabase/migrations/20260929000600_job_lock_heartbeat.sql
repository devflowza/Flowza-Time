-- FlowZa Time · 20260929000600 · Job queue: lock heartbeat, owned outcomes, bounded and dedupe-safe requeueing
--
-- A running job holds a lock (`locked_at`, `locked_by`) that `jobs.reap_stale` treats as abandoned once it is older than the
-- job's `lock_timeout_seconds`. Nothing refreshed that lock while a handler ran, so a job that ran longer than its lock
-- timeout was requeued while it was still running: another worker slot started the same job from the beginning, and again
-- after every further timeout. The six-month recalculations on the hosted demo tenant all show it (9, 27 and 29 Sep: 3, 3
-- and 6 attempts of max 3, requeued by the reaper): on 29 Sep four executions ran side by side, and the request's progress
-- summary jumped backwards each time one execution overwrote another's (docs/hr-portal/reports/12-ship.md §9).
--
-- 1. `jobs.heartbeat(worker, ids, attempts)` — the worker extends the lock of every job it is still running. Only a row still
--    running under the same worker AND the same attempt is extended; the ids returned are the jobs the worker still owns, so
--    a job missing from the result has been reaped or finished elsewhere and its execution must stop.
-- 2. `jobs.complete_owned` / `jobs.fail_owned` — complete or fail a job only while the caller still owns it (same worker,
--    same attempt). A superseded execution can no longer complete, fail or reschedule a job another attempt is running.
-- 3. `jobs.release_owned` — a worker that is shutting down hands a job it cannot finish back to the queue at once, without
--    spending an attempt (a deploy is not the job's fault), instead of leaving it locked until its lock times out.
-- 4. `jobs.reap_stale` counts a lost lock as a spent attempt: a job whose worker died is requeued as before until its
--    attempts are used, then dead-lettered (`LOCK_EXPIRED`) instead of being requeued forever.
-- 5. Requeueing no longer collides with the dedupe index. That index is unique over PENDING rows only, so a job enqueued
--    while its twin runs waits as the next run; moving the running twin back to 'pending' (a retry in `jobs.fail`, a reap)
--    then raised unique_violation. For a reap that would fail the whole batch, every minute, so no stale job would be
--    recovered again. A job whose key is already held by a pending job now goes back to the queue without its key (both runs are
--    kept: the key only merges enqueues). `jobs.complete` also no longer rewrites a job that was already archived.
-- 6. EXECUTE on the queue functions is revoked from PUBLIC (the API, worker and system roles keep their explicit grants),
--    and every queue function runs with an empty search_path.
--
-- Idempotent and one transaction; no table changes.

set lock_timeout = '5s';
set statement_timeout = '60s';

-- ---------------------------------------------------------------------------------------------------------------------------
-- Dedupe-safe requeueing
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function jobs.drop_conflicting_dedupe_keys(p_ids bigint[]) returns void language sql set search_path = '' as $$
  -- The given running jobs are about to become 'pending'. Drop the dedupe key of any whose key is already held by a
  -- pending job, and of all but the newest when several of them share a key, so the pending-only unique index holds.
  update jobs.queue q set dedupe_key = null, updated_at = now()
  where q.id = any (p_ids) and q.dedupe_key is not null
    and (exists (select 1 from jobs.queue p where p.dedupe_key = q.dedupe_key and p.status = 'pending' and p.id <> q.id)
         or exists (select 1 from jobs.queue o where o.id = any (p_ids) and o.id > q.id and o.dedupe_key = q.dedupe_key))
$$;
comment on function jobs.drop_conflicting_dedupe_keys(bigint[]) is 'Before jobs go back to pending: drops the dedupe key of those whose key a pending job (or a newer job of the same batch) already holds, so the pending-only dedupe index cannot reject the requeue.';

create or replace function jobs.fail(p_id bigint, p_error_code text, p_error text, p_retry_after_seconds int default null)
returns jobs.job_status language plpgsql set search_path = '' as $$
declare v jobs.queue%rowtype; v_delay numeric;
begin
  select * into v from jobs.queue where id = p_id for update;
  if not found then return null; end if;
  if v.attempts >= v.max_attempts or p_retry_after_seconds = -1 then
    with moved as (delete from jobs.queue where id = p_id returning *)
    insert into jobs.queue_archive select (m).* from (select (moved.*)::jobs.queue as m from moved) s;
    update jobs.queue_archive set status = 'dead', completed_at = now(), locked_at = null, locked_by = null,
      last_error_code = p_error_code, last_error = left(p_error, 2000) where id = p_id;
    return 'dead';
  end if;
  v_delay := coalesce(p_retry_after_seconds, least(1800, 30 * power(2, v.attempts - 1)) * (0.8 + random() * 0.4));
  perform jobs.drop_conflicting_dedupe_keys(array[p_id]);
  begin
    update jobs.queue set status = 'pending', run_at = now() + (v_delay || ' seconds')::interval, locked_at = null, locked_by = null,
      last_error_code = p_error_code, last_error = left(p_error, 2000), updated_at = now() where id = p_id;
  exception when unique_violation then
    -- a twin was enqueued between the check above and this update
    update jobs.queue set status = 'pending', run_at = now() + (v_delay || ' seconds')::interval, locked_at = null, locked_by = null,
      dedupe_key = null, last_error_code = p_error_code, last_error = left(p_error, 2000), updated_at = now() where id = p_id;
  end;
  return 'pending';
end $$;

create or replace function jobs.complete(p_id bigint) returns void language plpgsql set search_path = '' as $$
declare v_rows int;
begin
  with moved as (
    delete from jobs.queue where id = p_id returning *
  )
  insert into jobs.queue_archive select (m).* from (select (moved.*)::jobs.queue as m from moved) s;
  get diagnostics v_rows = row_count;
  -- a job archived earlier (completed, failed or cancelled) keeps its outcome and its completion time
  if v_rows = 0 then return; end if;
  update jobs.queue_archive set status = 'completed', completed_at = now(), locked_at = null, locked_by = null where id = p_id;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Heartbeat and owned outcomes
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function jobs.heartbeat(p_worker text, p_ids bigint[], p_attempts int[])
returns setof bigint language sql set search_path = '' as $$
  update jobs.queue q set locked_at = now(), updated_at = now()
  from unnest(p_ids, p_attempts) as h(id, attempt)
  where q.id = h.id and q.attempts = h.attempt and q.status = 'running' and q.locked_by = p_worker
  returning q.id
$$;
comment on function jobs.heartbeat(text, bigint[], int[]) is 'Extends the lock of the given running jobs that the worker still owns (same worker, same attempt); returns the ids it still owns.';

create or replace function jobs.complete_owned(p_id bigint, p_worker text, p_attempt int) returns boolean language plpgsql set search_path = '' as $$
declare v_rows int;
begin
  with moved as (
    delete from jobs.queue where id = p_id and status = 'running' and locked_by = p_worker and attempts = p_attempt returning *
  )
  insert into jobs.queue_archive select (m).* from (select (moved.*)::jobs.queue as m from moved) s;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return false; end if;
  update jobs.queue_archive set status = 'completed', completed_at = now(), locked_at = null, locked_by = null where id = p_id;
  return true;
end $$;
comment on function jobs.complete_owned(bigint, text, int) is 'Completes a job only while the caller still owns it (same worker, same attempt); false when the lock was lost.';

create or replace function jobs.fail_owned(p_id bigint, p_worker text, p_attempt int, p_error_code text, p_error text, p_retry_after_seconds int default null)
returns jobs.job_status language plpgsql set search_path = '' as $$
begin
  perform 1 from jobs.queue where id = p_id and status = 'running' and locked_by = p_worker and attempts = p_attempt for update;
  if not found then return null; end if;
  return jobs.fail(p_id, p_error_code, p_error, p_retry_after_seconds);
end $$;
comment on function jobs.fail_owned(bigint, text, int, text, text, int) is 'Fails (retries or dead-letters) a job only while the caller still owns it (same worker, same attempt); null when the lock was lost.';

create or replace function jobs.release_owned(p_id bigint, p_worker text, p_attempt int) returns boolean language plpgsql set search_path = '' as $$
begin
  perform 1 from jobs.queue where id = p_id and status = 'running' and locked_by = p_worker and attempts = p_attempt for update;
  if not found then return false; end if;
  perform jobs.drop_conflicting_dedupe_keys(array[p_id]);
  -- `attempts` stays as it is (it is also what tells this execution from the next one); the attempt is given back through
  -- max_attempts instead, so a deploy never uses up a job's retries.
  update jobs.queue set status = 'pending', run_at = now(), locked_at = null, locked_by = null, max_attempts = max_attempts + 1,
    last_error_code = 'WORKER_SHUTDOWN', last_error = 'worker shut down; released to another worker', updated_at = now()
  where id = p_id;
  return found;
end $$;
comment on function jobs.release_owned(bigint, text, int) is 'A worker shutting down hands back a job it still owns (same worker, same attempt): pending again at once, without spending an attempt.';

-- ---------------------------------------------------------------------------------------------------------------------------
-- Reaping: a lost lock is an attempt; spent jobs are dead-lettered
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function jobs.reap_stale(p_limit int default 100) returns int language plpgsql set search_path = '' as $$
declare v_ids bigint[]; v_requeue bigint[];
begin
  select array_agg(id) into v_ids from (
    select id from jobs.queue
    where status = 'running' and locked_at < now() - (lock_timeout_seconds || ' seconds')::interval
    order by locked_at limit p_limit for update skip locked
  ) s;
  if v_ids is null then return 0; end if;

  with moved as (delete from jobs.queue where id = any (v_ids) and attempts >= max_attempts returning *)
  insert into jobs.queue_archive select (m).* from (select (moved.*)::jobs.queue as m from moved) s;
  update jobs.queue_archive set status = 'dead', completed_at = now(), locked_at = null, locked_by = null,
    last_error_code = 'LOCK_EXPIRED', last_error = 'worker lock expired; attempts exhausted'
  where id = any (v_ids) and status = 'running';

  select array_agg(id) into v_requeue from jobs.queue where id = any (v_ids) and status = 'running';
  if v_requeue is not null then
    perform jobs.drop_conflicting_dedupe_keys(v_requeue);
    begin
      update jobs.queue set status = 'pending', locked_at = null, locked_by = null, run_at = now(),
        last_error_code = 'LOCK_EXPIRED', last_error = 'worker lock expired; requeued', updated_at = now()
      where id = any (v_requeue);
    exception when unique_violation then
      update jobs.queue set status = 'pending', locked_at = null, locked_by = null, run_at = now(), dedupe_key = null,
        last_error_code = 'LOCK_EXPIRED', last_error = 'worker lock expired; requeued', updated_at = now()
      where id = any (v_requeue);
    end;
  end if;
  return cardinality(v_ids);
end $$;

-- Every queue function resolves names with an empty search_path (all references are schema-qualified).
alter function jobs.enqueue(text, text, uuid, jsonb, int, timestamptz, text, int, int, text) set search_path = '';
alter function jobs.dequeue(text, text[], int, int) set search_path = '';
alter function jobs.cancel(bigint) set search_path = '';
alter function jobs.stats() set search_path = '';

-- The queue functions are for the API, worker and system roles only. They were also executable by PUBLIC (the default for a
-- new function); no client could reach them (no USAGE on schema jobs, no privilege on its tables), and now none holds them.
grant execute on all functions in schema jobs to flowza_system, flowza_worker, flowza_api;
revoke execute on all functions in schema jobs from public, anon, authenticated;

-- post-verify
do $$
declare v_fn text; v_client text;
begin
  foreach v_fn in array array['jobs.drop_conflicting_dedupe_keys(bigint[])', 'jobs.heartbeat(text, bigint[], int[])',
    'jobs.complete_owned(bigint, text, int)', 'jobs.fail_owned(bigint, text, int, text, text, int)',
    'jobs.release_owned(bigint, text, int)', 'jobs.reap_stale(int)', 'jobs.fail(bigint, text, text, int)', 'jobs.complete(bigint)'] loop
    if to_regprocedure(v_fn) is null then
      raise exception 'job lock heartbeat: % is missing', v_fn;
    end if;
  end loop;
  select string_agg(p.oid::regprocedure::text, ', ') into v_client
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'jobs' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
    or not has_function_privilege('flowza_worker', p.oid, 'execute') or not has_function_privilege('flowza_api', p.oid, 'execute')
    or not has_function_privilege('flowza_system', p.oid, 'execute'));
  if v_client is not null then
    raise exception 'job lock heartbeat: wrong execute privileges on %', v_client;
  end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_client
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'jobs' and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
  if v_client is not null then
    raise exception 'job lock heartbeat: search_path not fixed on %', v_client;
  end if;
end $$;
