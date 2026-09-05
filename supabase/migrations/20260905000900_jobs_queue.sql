-- FlowZa Time · 0900 · generic background job queue with tenant-fair dequeue (ADR-006)
create type jobs.job_status as enum ('pending', 'running', 'completed', 'failed', 'dead', 'cancelled');

create table jobs.queue (
  id bigint generated always as identity primary key,
  queue_name text not null default 'default',
  job_type text not null,
  organization_id uuid, -- null for platform-wide maintenance jobs
  payload jsonb not null default '{}'::jsonb,
  priority int not null default 5 check (priority between 0 and 9),
  status jobs.job_status not null default 'pending',
  run_at timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 6,
  lock_timeout_seconds int not null default 600,
  locked_at timestamptz,
  locked_by text,
  dedupe_key text,
  correlation_id text,
  last_error_code text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index jobs_queue_dequeue_idx on jobs.queue (queue_name, priority desc, run_at) where status = 'pending';
create index jobs_queue_running_org_idx on jobs.queue (organization_id) where status = 'running';
create index jobs_queue_running_lock_idx on jobs.queue (locked_at) where status = 'running';
-- Dedupe applies to PENDING jobs only: a job enqueued while the same key is RUNNING becomes the next run, so work that
-- arrives mid-flight (e.g. a punch during a recompute) is never lost.
create unique index jobs_queue_dedupe_idx on jobs.queue (dedupe_key) where dedupe_key is not null and status = 'pending';
create index jobs_queue_org_idx on jobs.queue (organization_id, created_at desc);

create table jobs.queue_archive (like jobs.queue including defaults);
alter table jobs.queue_archive add primary key (id);
create index jobs_queue_archive_org_idx on jobs.queue_archive (organization_id, completed_at desc);
create index jobs_queue_archive_completed_idx on jobs.queue_archive (completed_at);

-- Enqueue (idempotent when dedupe_key is provided). Returns the job id or the existing job id.
create or replace function jobs.enqueue(
  p_queue text, p_job_type text, p_org uuid, p_payload jsonb,
  p_priority int default 5, p_run_at timestamptz default now(), p_dedupe_key text default null,
  p_max_attempts int default 6, p_lock_timeout_seconds int default 600, p_correlation_id text default null
) returns bigint language plpgsql as $$
declare v_id bigint;
begin
  if p_dedupe_key is not null then
    select id into v_id from jobs.queue where dedupe_key = p_dedupe_key and status = 'pending' limit 1;
    if v_id is not null then return v_id; end if;
  end if;
  insert into jobs.queue (queue_name, job_type, organization_id, payload, priority, run_at, dedupe_key, max_attempts, lock_timeout_seconds, correlation_id)
  values (p_queue, p_job_type, p_org, coalesce(p_payload, '{}'::jsonb), p_priority, coalesce(p_run_at, now()), p_dedupe_key, p_max_attempts, p_lock_timeout_seconds, p_correlation_id)
  on conflict do nothing
  returning id into v_id;
  if v_id is null and p_dedupe_key is not null then
    select id into v_id from jobs.queue where dedupe_key = p_dedupe_key and status = 'pending' limit 1;
  end if;
  return v_id;
end $$;

-- Fair dequeue: least-served organisation first, then priority, then run_at; per-org running cap.
create or replace function jobs.dequeue(p_worker text, p_queues text[], p_limit int default 1, p_org_cap int default 5)
returns setof jobs.queue language plpgsql as $$
begin
  return query
  with running as (
    select organization_id, count(*)::int as c from jobs.queue where status = 'running' group by organization_id
  ),
  candidates as (
    select q.id
    from jobs.queue q
    left join running r on r.organization_id is not distinct from q.organization_id
    where q.status = 'pending'
      and q.run_at <= now()
      and q.queue_name = any (p_queues)
      and (q.organization_id is null or coalesce(r.c, 0) < p_org_cap)
    order by coalesce(r.c, 0) asc, q.priority desc, q.run_at asc, q.id asc
    limit p_limit
    for update of q skip locked
  )
  update jobs.queue q
  set status = 'running', locked_at = now(), locked_by = p_worker, attempts = q.attempts + 1, updated_at = now()
  from candidates c
  where q.id = c.id
  returning q.*;
end $$;

create or replace function jobs.complete(p_id bigint) returns void language plpgsql as $$
begin
  with moved as (
    delete from jobs.queue where id = p_id returning *
  )
  insert into jobs.queue_archive select (m).* from (select (moved.*)::jobs.queue as m from moved) s;
  update jobs.queue_archive set status = 'completed', completed_at = now(), locked_at = null, locked_by = null where id = p_id;
end $$;

-- Fail with retry (exponential backoff with jitter) or dead-letter after max attempts.
create or replace function jobs.fail(p_id bigint, p_error_code text, p_error text, p_retry_after_seconds int default null)
returns jobs.job_status language plpgsql as $$
declare v jobs.queue%rowtype; v_delay numeric; v_status jobs.job_status;
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
  update jobs.queue set status = 'pending', run_at = now() + (v_delay || ' seconds')::interval, locked_at = null, locked_by = null,
    last_error_code = p_error_code, last_error = left(p_error, 2000), updated_at = now() where id = p_id;
  return 'pending';
end $$;

create or replace function jobs.cancel(p_id bigint) returns boolean language plpgsql as $$
declare v_found boolean;
begin
  with moved as (delete from jobs.queue where id = p_id and status = 'pending' returning *)
  insert into jobs.queue_archive select (m).* from (select (moved.*)::jobs.queue as m from moved) s;
  update jobs.queue_archive set status = 'cancelled', completed_at = now() where id = p_id and status = 'pending';
  get diagnostics v_found = row_count;
  return v_found;
end $$;

-- Requeue jobs whose worker died (lock older than lock_timeout).
create or replace function jobs.reap_stale(p_limit int default 100) returns int language plpgsql as $$
declare v_count int;
begin
  with stale as (
    select id from jobs.queue
    where status = 'running' and locked_at < now() - (lock_timeout_seconds || ' seconds')::interval
    order by locked_at limit p_limit for update skip locked
  )
  update jobs.queue q set status = 'pending', locked_at = null, locked_by = null, run_at = now(),
    last_error_code = 'LOCK_EXPIRED', last_error = 'worker lock expired; requeued', updated_at = now()
  from stale s where q.id = s.id;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create or replace function jobs.stats() returns table (queue_name text, status jobs.job_status, count bigint, oldest_run_at timestamptz)
language sql stable as $$
  select queue_name, status, count(*), min(run_at) from jobs.queue group by 1, 2
$$;

grant select, insert, update, delete on jobs.queue, jobs.queue_archive to flowza_system, flowza_worker, flowza_api;
grant execute on all functions in schema jobs to flowza_system, flowza_worker, flowza_api;
revoke all on all tables in schema jobs from anon, authenticated;
