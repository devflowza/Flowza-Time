-- FlowZa Time · 1800 · Supabase Auth hook: record login attempts into login_history (ADR-007)
set client_min_messages = warning;
-- Called by Supabase Auth (role supabase_auth_admin) after each password verification attempt.
-- Payload: {"user_id": "...", "valid": true|false}
create or replace function app.on_password_verification_attempt(event jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := nullif(event ->> 'user_id', '')::uuid; v_valid boolean := coalesce((event ->> 'valid')::boolean, false);
begin
  insert into public.login_history (user_id, event, details)
  values (v_user, case when v_valid then 'success' else 'failed' end, jsonb_build_object('source', 'password_verification_hook'));
  if v_valid then
    update public.user_profiles set last_login_at = now() where id = v_user;
  end if;
  -- decision: {} = allow; failed attempts are throttled by Supabase Auth itself
  return '{"decision": "continue"}'::jsonb;
exception when others then
  -- never block sign-in because of a logging failure
  return '{"decision": "continue"}'::jsonb;
end $$;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema app to supabase_auth_admin;
    grant execute on function app.on_password_verification_attempt(jsonb) to supabase_auth_admin;
    revoke execute on function app.on_password_verification_attempt(jsonb) from authenticated, anon, public;
  end if;
end $$;
