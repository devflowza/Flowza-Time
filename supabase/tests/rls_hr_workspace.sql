-- RLS: report schedules and the report delivery trail (HR portal Prompt 6a, migration 20260928000600).
-- Run AFTER rls_isolation.sql (its committed fixtures: orgs A / B, owner-a, bm-a (branch A-2), emp-a, manager-a, auditor-a,
-- owner-b) as a superuser; checks switch to `authenticated` / `flowza_system` with the matching claims.
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
grant execute on all functions in schema pg_temp to public;

-- ---------- fixtures (as superuser) ----------
-- Org A: s1 organisation-wide, s2 branch A-2, s3 branch HQ; org B: s4. Deliveries: d1 → manager-a, d2 → auditor-a (org A), d3 → owner-b.
begin;
set local client_min_messages = warning;
insert into public.report_schedules (id, organization_id, name, report_type, format, filters, branch_id, cadence, run_day, run_time, period_rule, recipients, channels, next_run_at, created_by) values
  ('0a000000-0000-0000-0000-0000000006a1', '0a000000-0000-0000-0000-000000000000', 'A org-wide', 'late_report', 'pdf', '{}', null, 'monthly', 1, '07:00', 'previous_month', '{"userIds":[],"roleKeys":["hr_admin"]}', '{in_app,email}', now() + interval '1 day', 'a0000000-0000-0000-0000-000000000001'),
  ('0a000000-0000-0000-0000-0000000006a2', '0a000000-0000-0000-0000-000000000000', 'A branch 2', 'late_report', 'pdf', '{"branchId":"0a000000-0000-0000-0000-00000000000c"}', '0a000000-0000-0000-0000-00000000000c', 'weekly', 0, '06:00', 'previous_week', '{"userIds":[],"roleKeys":[]}', '{email}', now() + interval '1 day', 'a0000000-0000-0000-0000-000000000001'),
  ('0b000000-0000-0000-0000-0000000006a4', '0b000000-0000-0000-0000-000000000000', 'B org-wide', 'late_report', 'pdf', '{}', null, 'monthly', 1, '07:00', 'previous_month', '{"userIds":[],"roleKeys":[]}', '{in_app}', now() + interval '1 day', 'b0000000-0000-0000-0000-000000000001');
insert into public.report_schedules (id, organization_id, name, report_type, format, filters, branch_id, cadence, run_day, run_time, period_rule, custom_from_day, custom_to_day, recipients, channels, next_run_at, created_by) values
  ('0a000000-0000-0000-0000-0000000006a3', '0a000000-0000-0000-0000-000000000000', 'A HQ', 'absence_report', 'csv', '{"branchId":"0a000000-0000-0000-0000-00000000000b"}', '0a000000-0000-0000-0000-00000000000b', 'monthly', 28, '23:00', 'custom', 26, 25, '{"userIds":[],"roleKeys":[]}', '{in_app}', now() + interval '1 day', 'a0000000-0000-0000-0000-000000000001');
insert into public.report_deliveries (id, organization_id, schedule_id, run_key, mode, report_type, format, recipient_user_id, sent_by, status) values
  ('0a000000-0000-0000-0000-0000000006d1', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000006a1', 'schedule:a1:1', 'schedule', 'late_report', 'pdf', 'a0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000001', 'queued'),
  ('0a000000-0000-0000-0000-0000000006d2', '0a000000-0000-0000-0000-000000000000', null, 'send:x', 'send_now', 'late_report', 'pdf', 'a0000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000001', 'skipped'),
  ('0b000000-0000-0000-0000-0000000006d3', '0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000006a4', 'schedule:b4:1', 'schedule', 'late_report', 'pdf', 'b0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'delivered');
commit;

-- ---------- owner A: report.view + report.schedule, all branches ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.report_schedules), 3, 'owner A sees the 3 schedules of A');
select pg_temp.assert_eq((select count(*) from public.report_schedules where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'owner A cannot see B schedules');
select pg_temp.assert_rows($q$ insert into public.report_schedules (organization_id, name, report_type, cadence, run_day, period_rule, recipients, next_run_at) values ('0a000000-0000-0000-0000-000000000000', 'new', 'late_report', 'monthly', 5, 'previous_month', '{"roleKeys":["owner"]}', now()) $q$, 1, 'owner A (report.schedule) may create a schedule');
select pg_temp.assert_rows($q$ update public.report_schedules set name = 'renamed' where id = '0a000000-0000-0000-0000-0000000006a3' $q$, 1, 'owner A may edit a schedule');
select pg_temp.assert_raises($q$ insert into public.report_schedules (organization_id, name, report_type, cadence, run_day, period_rule, next_run_at) values ('0b000000-0000-0000-0000-000000000000', 'x', 'late_report', 'monthly', 5, 'previous_month', now()) $q$, 'owner A cannot create a schedule in org B');
select pg_temp.assert_rows($q$ update public.report_schedules set name = 'hijack' where id = '0b000000-0000-0000-0000-0000000006a4' $q$, 0, 'owner A cannot edit B schedules');
select pg_temp.assert_raises($q$ update public.report_schedules set cadence = 'weekly' where id = '0a000000-0000-0000-0000-0000000006a1' $q$, 'weekly + previous_month violates the cadence/period check');
select pg_temp.assert_raises($q$ update public.report_schedules set is_active = true, next_run_at = null where id = '0a000000-0000-0000-0000-0000000006a1' $q$, 'an active schedule needs a next run');
select pg_temp.assert_eq((select count(*) from public.report_deliveries), 2, 'owner A (report.schedule) sees the delivery trail of A');
select pg_temp.assert_raises($q$ insert into public.report_deliveries (organization_id, run_key, mode, report_type, format, recipient_user_id) values ('0a000000-0000-0000-0000-000000000000', 'send:y', 'send_now', 'late_report', 'pdf', 'a0000000-0000-0000-0000-000000000001') $q$, 'the delivery trail is never written from a user session (raises)');
select pg_temp.assert_raises($q$ update public.report_deliveries set status = 'delivered' where id = '0a000000-0000-0000-0000-0000000006d2' $q$, 'deliveries cannot be updated from a user session');
select pg_temp.assert_raises($q$ delete from public.report_deliveries where id = '0a000000-0000-0000-0000-0000000006d2' $q$, 'deliveries cannot be deleted from a user session');
select pg_temp.assert_rows($q$ delete from public.report_schedules where id = '0a000000-0000-0000-0000-0000000006a3' $q$, 1, 'owner A may delete a schedule');
rollback;

-- ---------- branch manager A (report.view, branch A-2 only, no report.schedule) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.report_schedules), 2, 'branch manager sees organisation-wide + own-branch schedules');
select pg_temp.assert_eq((select count(*) from public.report_schedules where id = '0a000000-0000-0000-0000-0000000006a3'), 0, 'branch manager cannot see the HQ schedule');
select pg_temp.assert_raises($q$ insert into public.report_schedules (organization_id, name, report_type, cadence, run_day, period_rule, branch_id, next_run_at) values ('0a000000-0000-0000-0000-000000000000', 'x', 'late_report', 'monthly', 5, 'previous_month', '0a000000-0000-0000-0000-00000000000c', now()) $q$, 'branch manager (no report.schedule) cannot create a schedule');
select pg_temp.assert_rows($q$ update public.report_schedules set name = 'x' where id = '0a000000-0000-0000-0000-0000000006a2' $q$, 0, 'branch manager cannot edit a schedule');
select pg_temp.assert_eq((select count(*) from public.report_deliveries), 0, 'branch manager is not a recipient of anything');
rollback;

-- ---------- auditor A (report.view org-wide, no report.schedule) and manager A ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000007","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.report_schedules), 3, 'auditor reads every schedule of A');
select pg_temp.assert_rows($q$ delete from public.report_schedules where id = '0a000000-0000-0000-0000-0000000006a1' $q$, 0, 'auditor cannot delete a schedule');
select pg_temp.assert_eq((select count(*) from public.report_deliveries), 1, 'auditor sees only the delivery addressed to them');
select pg_temp.assert_eq((select count(*) from public.report_deliveries where id = '0a000000-0000-0000-0000-0000000006d2'), 1, 'auditor sees their own delivery');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.report_deliveries), 1, 'manager A sees only the delivery addressed to them');
select pg_temp.assert_eq((select count(*) from public.report_deliveries where recipient_user_id <> 'a0000000-0000-0000-0000-000000000005'), 0, 'manager A sees nobody else''s deliveries');
rollback;

-- ---------- employee A (no report.view) and owner B ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.report_schedules), 0, 'an employee without report.view sees no schedule');
select pg_temp.assert_eq((select count(*) from public.report_deliveries), 0, 'an employee sees no delivery');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.report_schedules), 1, 'owner B sees only the B schedule');
select pg_temp.assert_eq((select count(*) from public.report_deliveries), 1, 'owner B sees only the B delivery');
rollback;

-- ---------- system context (worker) and platform context (scheduler scan) ----------
begin;
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system","org_id":"0a000000-0000-0000-0000-000000000000"}', true);
select pg_temp.assert_eq((select count(*) from public.report_schedules), 3, 'system context for A sees A schedules');
select pg_temp.assert_rows($q$ insert into public.report_deliveries (organization_id, run_key, mode, report_type, format, recipient_user_id) values ('0a000000-0000-0000-0000-000000000000', 'send:sys', 'send_now', 'late_report', 'pdf', 'a0000000-0000-0000-0000-000000000001') $q$, 1, 'system context for A writes the A delivery trail');
select pg_temp.assert_raises($q$ insert into public.report_deliveries (organization_id, run_key, mode, report_type, format, recipient_user_id) values ('0a000000-0000-0000-0000-000000000000', 'send:sys', 'send_now', 'late_report', 'pdf', 'a0000000-0000-0000-0000-000000000001') $q$, 'one delivery per (run key, recipient)');
select pg_temp.assert_raises($q$ insert into public.report_deliveries (organization_id, run_key, mode, report_type, format, recipient_user_id) values ('0b000000-0000-0000-0000-000000000000', 'send:sys', 'send_now', 'late_report', 'pdf', 'b0000000-0000-0000-0000-000000000001') $q$, 'system context for A cannot write the B delivery trail');
select pg_temp.assert_rows($q$ update public.report_schedules set last_run_at = now(), last_status = 'success' where id = '0a000000-0000-0000-0000-0000000006a1' $q$, 1, 'system context advances an A schedule');
select pg_temp.assert_rows($q$ update public.report_schedules set last_status = 'success' where id = '0b000000-0000-0000-0000-0000000006a4' $q$, 0, 'system context for A cannot touch B schedules');
rollback;
begin;
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system","scope":"platform"}', true);
select pg_temp.assert_eq((select count(*) from public.report_schedules where next_run_at is not null), 4, 'platform context scans due schedules across organisations');
select pg_temp.assert_rows($q$ update public.report_schedules set name = 'x' $q$, 0, 'platform context cannot write schedules');
select pg_temp.assert_eq((select count(*) from public.report_deliveries), 0, 'platform context cannot read the delivery trail');
rollback;
