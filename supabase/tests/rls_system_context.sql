-- System (worker) context tests: run connected as flowza_worker AFTER rls_isolation.sql fixtures exist.
\set QUIET on
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.assert_eq(actual bigint, expected bigint, label text) returns void language plpgsql as $$
begin
  if actual <> expected then raise exception 'ASSERT FAILED: % — expected %, got %', label, expected, actual; end if;
  raise notice 'ok: % (%)', label, actual;
end $$;
create or replace function pg_temp.assert_rows(sqltext text, expected bigint, label text) returns void language plpgsql as $$
declare n bigint;
begin
  execute sqltext; get diagnostics n = row_count;
  if n <> expected then raise exception 'ASSERT FAILED: % — expected % affected rows, got %', label, expected, n; end if;
  raise notice 'ok: % (% rows)', label, n;
end $$;
create or replace function pg_temp.assert_raises(sqltext text, label text) returns void language plpgsql as $$
begin
  begin
    execute sqltext;
  exception when others then
    raise notice 'ok: % (raised %)', label, sqlerrm; return;
  end;
  raise exception 'ASSERT FAILED: % — expected an error', label;
end $$;
begin;
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system","org_id":"0a000000-0000-0000-0000-000000000000"}', true);
select pg_temp.assert_eq((select count(*) from public.employees), 6, 'system context for org A sees A employees');
-- Flowza Finance connector state: the worker (system context) is its only writer, scoped to its own organisation
select pg_temp.assert_eq((select count(*) from public.finance_sync_state), 1, 'system context for org A sees A connector state');
select pg_temp.assert_eq((select count(*) from public.finance_sync_state where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'system context for org A cannot see B connector state');
select pg_temp.assert_rows($q$ update public.finance_sync_state set last_pull_count = 4, last_pull_at = now() where device_id = '0a000000-0000-0000-0000-0000000000d1' $q$, 1, 'system context for org A updates own connector state');
select pg_temp.assert_rows($q$ update public.finance_sync_state set consecutive_failures = 0 where device_id = '0b000000-0000-0000-0000-0000000000d1' $q$, 0, 'system context for org A cannot update B connector state');
-- an insert outside the system context's organisation violates the WITH CHECK half of the system write policy (raises, never silently 0 rows)
select pg_temp.assert_raises($q$ insert into public.finance_sync_state (device_id, organization_id) values ('0b000000-0000-0000-0000-0000000000d2', '0b000000-0000-0000-0000-000000000000') $q$, 'system context for org A cannot insert B connector state');
-- the push ledger: the worker records and prunes its own organisation's rows only
select pg_temp.assert_eq((select count(*) from public.finance_pushed_events), 1, 'system context for org A sees A push ledger');
select pg_temp.assert_rows($q$ insert into public.finance_pushed_events (organization_id, device_id, event_id) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000d1', '0a000000-0000-0000-0000-0000000003a2') $q$, 1, 'system context for org A records a pushed event');
select pg_temp.assert_raises($q$ insert into public.finance_pushed_events (organization_id, device_id, event_id) values ('0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000d1', '0b000000-0000-0000-0000-0000000003a2') $q$, 'system context for org A cannot write B push ledger');
select pg_temp.assert_rows($q$ delete from public.finance_pushed_events where device_id = '0b000000-0000-0000-0000-0000000000d1' $q$, 0, 'system context for org A cannot prune B push ledger');
select pg_temp.assert_rows($q$ delete from public.finance_pushed_events where device_id = '0a000000-0000-0000-0000-0000000000d1' $q$, 2, 'system context for org A prunes own push ledger');
select pg_temp.assert_eq((select count(*) from public.employees where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'system context for org A cannot see org B');
select pg_temp.assert_eq((select count(*) from secrets.get_device_credentials('0a000000-0000-0000-0000-0000000000d1')), 1, 'system context decrypts own device credentials');
select pg_temp.assert_eq((select count(*) from secrets.get_device_credentials('0b000000-0000-0000-0000-0000000000d1')), 0, 'system context for A cannot read B credentials');
select pg_temp.assert_eq((select count(*) from jobs.queue), 0, 'system can read the job queue');
select pg_temp.assert_eq((select count(*) from public.attendance_day_marks), 3, 'system context for org A reads A day marks');
select pg_temp.assert_eq((select count(*) from public.attendance_day_marks where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'system context for org A cannot read B day marks');
rollback;
begin;
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system"}', true);
select pg_temp.assert_eq((select count(*) from public.employees), 0, 'system context without org_id sees no tenant rows');
rollback;
