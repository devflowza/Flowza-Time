-- System (worker) context tests: run connected as flowza_worker AFTER rls_isolation.sql fixtures exist.
\set QUIET on
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.assert_eq(actual bigint, expected bigint, label text) returns void language plpgsql as $$
begin
  if actual <> expected then raise exception 'ASSERT FAILED: % — expected %, got %', label, expected, actual; end if;
  raise notice 'ok: % (%)', label, actual;
end $$;
begin;
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system","org_id":"0a000000-0000-0000-0000-000000000000"}', true);
select pg_temp.assert_eq((select count(*) from public.employees), 3, 'system context for org A sees A employees');
select pg_temp.assert_eq((select count(*) from public.employees where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'system context for org A cannot see org B');
select pg_temp.assert_eq((select count(*) from secrets.get_device_credentials('0a000000-0000-0000-0000-0000000000d1')), 1, 'system context decrypts own device credentials');
select pg_temp.assert_eq((select count(*) from secrets.get_device_credentials('0b000000-0000-0000-0000-0000000000d1')), 0, 'system context for A cannot read B credentials');
select pg_temp.assert_eq((select count(*) from jobs.queue), 0, 'system can read the job queue');
select pg_temp.assert_eq((select count(*) from public.attendance_statements), 2, 'system context for org A sees its statements (tokenized review flow)');
select pg_temp.assert_eq((select count(*) from public.attendance_statements where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'system context for org A cannot see org B statements');
rollback;
begin;
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system","scope":"platform"}', true);
select pg_temp.assert_eq((select count(*) from public.organization_settings), 2, 'platform context reads organization_settings for the statements sweep');
select pg_temp.assert_eq((select count(*) from public.attendance_statements), 0, 'platform context still cannot read statements themselves');
rollback;
begin;
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system"}', true);
select pg_temp.assert_eq((select count(*) from public.employees), 0, 'system context without org_id sees no tenant rows');
rollback;
