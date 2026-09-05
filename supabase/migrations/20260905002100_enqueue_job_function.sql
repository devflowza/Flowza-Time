-- FlowZa Time · 2100 · app.enqueue_job: safe job enqueue callable from every execution context
-- authenticated users may enqueue only for organisations they belong to; system/platform contexts and the login roles may
-- enqueue for any organisation (or platform-wide with null). Wraps jobs.enqueue (SECURITY DEFINER).
set client_min_messages = warning;
create or replace function app.enqueue_job(
  p_queue text, p_job_type text, p_org uuid, p_payload jsonb,
  p_priority int default 5, p_run_at timestamptz default now(), p_dedupe_key text default null,
  p_max_attempts int default 6, p_lock_timeout_seconds int default 600, p_correlation_id text default null
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_allowed boolean;
begin
  v_allowed := app.is_system()
    or (session_user in ('flowza_worker', 'flowza_api', 'postgres', 'supabase_admin') and coalesce(current_setting('role', true), 'none') in ('none', ''))
    or (p_org is not null and p_org = any (app.member_org_ids()));
  if not v_allowed then
    raise exception 'not allowed to enqueue jobs for organisation %', p_org using errcode = '42501';
  end if;
  return jobs.enqueue(p_queue, p_job_type, p_org, p_payload, p_priority, p_run_at, p_dedupe_key, p_max_attempts, p_lock_timeout_seconds, p_correlation_id);
end $$;
revoke all on function app.enqueue_job(text, text, uuid, jsonb, int, timestamptz, text, int, int, text) from public, anon;
grant execute on function app.enqueue_job(text, text, uuid, jsonb, int, timestamptz, text, int, int, text) to authenticated, flowza_system, flowza_api, flowza_worker;
