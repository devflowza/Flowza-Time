-- RLS: report schedules, the report delivery trail and the Storage objects of the HR attendance workspace (HR portal Prompt 6a,
-- migration 20260928000600; review fixes 20260928000820).
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
-- Org A: s1 organisation-wide, s2 branch A-2, s3 branch HQ; org B: s4.
-- Deliveries: d1 (s1) → manager-a, d2 (send now) → auditor-a, d4 (s2) → owner-a, d5 (send now by the branch scheduler) → owner-a;
-- d3 → owner-b in org B.
-- A branch-scoped scheduler "bs-a": a custom role with report.view + report.schedule, restricted to branch A-2.
begin;
set local client_min_messages = warning;
insert into auth.users (id, email) values ('a0000000-0000-0000-0000-0000000006f9', 'bs-a@test.local');
insert into public.user_profiles (id, email, full_name) values ('a0000000-0000-0000-0000-0000000006f9', 'bs-a@test.local', 'Branch Scheduler A');
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system","org_id":"0a000000-0000-0000-0000-000000000000"}', true);
insert into public.roles (id, organization_id, key, name, is_system) values ('0a000000-0000-0000-0000-0000000006f8', '0a000000-0000-0000-0000-000000000000', 'branch_scheduler', 'Branch scheduler', false);
insert into public.role_permissions (role_id, permission_key) values ('0a000000-0000-0000-0000-0000000006f8', 'report.view'), ('0a000000-0000-0000-0000-0000000006f8', 'report.schedule');
reset role;
insert into public.org_memberships (id, organization_id, user_id, role_id, status, all_branches, employee_id) values
  ('0a000000-0000-0000-0000-0000000006f7', '0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-0000000006f9', '0a000000-0000-0000-0000-0000000006f8', 'active', false, null);
insert into public.membership_branches (membership_id, branch_id) values ('0a000000-0000-0000-0000-0000000006f7', '0a000000-0000-0000-0000-00000000000c');
insert into public.report_schedules (id, organization_id, name, report_type, format, filters, branch_id, cadence, run_day, run_time, period_rule, recipients, channels, next_run_at, created_by) values
  ('0a000000-0000-0000-0000-0000000006a1', '0a000000-0000-0000-0000-000000000000', 'A org-wide', 'late_report', 'pdf', '{}', null, 'monthly', 1, '07:00', 'previous_month', '{"userIds":[],"roleKeys":["hr_admin"]}', '{in_app,email}', now() + interval '1 day', 'a0000000-0000-0000-0000-000000000001'),
  ('0a000000-0000-0000-0000-0000000006a2', '0a000000-0000-0000-0000-000000000000', 'A branch 2', 'late_report', 'pdf', '{"branchId":"0a000000-0000-0000-0000-00000000000c"}', '0a000000-0000-0000-0000-00000000000c', 'weekly', 0, '06:00', 'previous_week', '{"userIds":[],"roleKeys":[]}', '{email}', now() + interval '1 day', 'a0000000-0000-0000-0000-000000000001'),
  ('0b000000-0000-0000-0000-0000000006a4', '0b000000-0000-0000-0000-000000000000', 'B org-wide', 'late_report', 'pdf', '{}', null, 'monthly', 1, '07:00', 'previous_month', '{"userIds":[],"roleKeys":[]}', '{in_app}', now() + interval '1 day', 'b0000000-0000-0000-0000-000000000001');
insert into public.report_schedules (id, organization_id, name, report_type, format, filters, branch_id, cadence, run_day, run_time, period_rule, custom_from_day, custom_to_day, recipients, channels, next_run_at, created_by) values
  ('0a000000-0000-0000-0000-0000000006a3', '0a000000-0000-0000-0000-000000000000', 'A HQ', 'absence_report', 'csv', '{"branchId":"0a000000-0000-0000-0000-00000000000b"}', '0a000000-0000-0000-0000-00000000000b', 'monthly', 28, '23:00', 'custom', 26, 25, '{"userIds":[],"roleKeys":[]}', '{in_app}', now() + interval '1 day', 'a0000000-0000-0000-0000-000000000001');
insert into public.report_deliveries (id, organization_id, schedule_id, run_key, mode, report_type, format, recipient_user_id, sent_by, status) values
  ('0a000000-0000-0000-0000-0000000006d1', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000006a1', 'schedule:a1:1', 'schedule', 'late_report', 'pdf', 'a0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000001', 'queued'),
  ('0a000000-0000-0000-0000-0000000006d2', '0a000000-0000-0000-0000-000000000000', null, 'send:x', 'send_now', 'late_report', 'pdf', 'a0000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000001', 'skipped'),
  ('0a000000-0000-0000-0000-0000000006d4', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000006a2', 'schedule:a2:1', 'schedule', 'late_report', 'pdf', 'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'delivered'),
  ('0a000000-0000-0000-0000-0000000006d5', '0a000000-0000-0000-0000-000000000000', null, 'send:bs', 'send_now', 'late_report', 'pdf', 'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000006f9', 'queued'),
  ('0b000000-0000-0000-0000-0000000006d3', '0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000006a4', 'schedule:b4:1', 'schedule', 'late_report', 'pdf', 'b0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'delivered');
-- Storage objects where the worker / a future upload would put them: reports/<org>/<request>.<fmt>, employee-photos and
-- documents under <org>/<employee id>/… (e1 = HQ, e2 and e3 = branch A-2; e3 is emp-a's own record)
insert into storage.objects (bucket_id, name) values
  ('reports', '0a000000-0000-0000-0000-000000000000/0a000000-0000-0000-0000-0000000007a1.csv'),
  ('reports', '0a000000-0000-0000-0000-000000000000/0a000000-0000-0000-0000-0000000007a2.csv'),
  ('reports', '0b000000-0000-0000-0000-000000000000/0b000000-0000-0000-0000-0000000007a1.csv'),
  ('employee-photos', '0a000000-0000-0000-0000-000000000000/0a000000-0000-0000-0000-0000000000e1/photo.jpg'),
  ('employee-photos', '0a000000-0000-0000-0000-000000000000/0a000000-0000-0000-0000-0000000000e2/photo.jpg'),
  ('employee-photos', '0a000000-0000-0000-0000-000000000000/0a000000-0000-0000-0000-0000000000e3/photo.jpg'),
  ('employee-photos', '0a000000-0000-0000-0000-000000000000/not-an-employee/photo.jpg'),
  ('employee-photos', '0b000000-0000-0000-0000-000000000000/0b000000-0000-0000-0000-0000000000e1/photo.jpg'),
  ('documents', '0a000000-0000-0000-0000-000000000000/0a000000-0000-0000-0000-0000000000e1/passport.pdf'),
  ('documents', '0a000000-0000-0000-0000-000000000000/0a000000-0000-0000-0000-0000000000e2/passport.pdf'),
  ('org-logos', '0a000000-0000-0000-0000-000000000000/logo.png');
commit;

select pg_temp.assert_eq((select count(*) from public.role_permissions where role_id = '10000000-0000-0000-0000-000000000003' and permission_key = 'report.schedule'), 1, '6a-P hr_admin holds report.schedule (review least-privilege recommendation)');
select pg_temp.assert_eq((select count(*) from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.organization_id is null and rp.permission_key = 'report.schedule' and r.key not in ('owner', 'org_admin', 'hr_admin', 'payroll')), 0, '6a-P report.schedule stays off hr_user, branch_manager, attendance_admin, auditor, manager, employee');

-- ---------- 6a-D1 Storage: report files are never readable by a client; photos / documents follow the record's scope ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'reports'), 0, '6a-D1 manager A (report.view, no report.export) reads no report object');
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'employee-photos'), 1, '6a-D1 manager A reads the photo of their direct report (e1) only');
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'documents'), 0, '6a-D1 manager A reads no identity document');
select pg_temp.assert_rows($q$ update storage.objects set metadata = '{"x":1}' where bucket_id = 'reports' $q$, 0, '6a-D1 manager A cannot touch a report object');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'reports'), 0, '6a-D1 branch manager A (branch A-2) reads no report object');
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'employee-photos'), 2, '6a-D1 branch manager A reads the photos of branch A-2 only (e2, e3)');
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'employee-photos' and name like '%0000000000e1/%'), 0, '6a-D1 branch manager A cannot read an HQ employee''s photo');
select pg_temp.assert_rows($q$ insert into storage.objects (bucket_id, name) values ('employee-photos', '0a000000-0000-0000-0000-000000000000/0a000000-0000-0000-0000-0000000000e2/new.jpg') $q$, 1, '6a-D1 branch manager A (employee.update) may upload a photo for a branch A-2 employee');
select pg_temp.assert_raises($q$ insert into storage.objects (bucket_id, name) values ('employee-photos', '0a000000-0000-0000-0000-000000000000/0a000000-0000-0000-0000-0000000000e1/new.jpg') $q$, '6a-D1 branch manager A cannot upload a photo for an HQ employee');
select pg_temp.assert_raises($q$ insert into storage.objects (bucket_id, name) values ('reports', '0a000000-0000-0000-0000-000000000000/forged.csv') $q$, '6a-D1 a user session cannot place a report file');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'reports'), 0, '6a-D1 an employee (no report.view) reads no report object');
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'employee-photos'), 1, '6a-D1 an employee reads their own photo only');
select pg_temp.assert_rows($q$ delete from storage.objects where bucket_id = 'employee-photos' $q$, 0, '6a-D1 an employee (no employee.update) cannot delete photos');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'reports'), 0, '6a-D1 even the owner reads report files only through the API download');
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'employee-photos'), 3, '6a-D1 owner A reads every photo of A (malformed paths excluded)');
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'documents'), 2, '6a-D1 owner A (employee.view_sensitive) reads the identity documents of A');
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'org-logos'), 1, '6a-D1 org logos stay readable by members');
select pg_temp.assert_rows($q$ delete from storage.objects where bucket_id = 'reports' $q$, 0, '6a-D1 organization.manage no longer deletes report files');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000007","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'reports'), 0, '6a-D1 auditor A (report.view + report.export) reads no report object directly');
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'documents'), 0, '6a-D1 auditor A (no employee.view_sensitive) reads no identity document');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from storage.objects where name like '0a000000-%'), 0, '6a-D1 owner B reads nothing of org A');
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'reports'), 0, '6a-D1 owner B reads not even their own report files directly');
select pg_temp.assert_eq((select count(*) from storage.objects where bucket_id = 'employee-photos'), 1, '6a-D1 owner B reads the photos of B');
rollback;

-- ---------- owner A: report.view + report.schedule, all branches ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.report_schedules), 3, 'owner A sees the 3 schedules of A');
select pg_temp.assert_eq((select count(*) from public.report_schedules where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'owner A cannot see B schedules');
select pg_temp.assert_raises($q$ insert into public.report_schedules (organization_id, name, report_type, cadence, run_day, period_rule, recipients, next_run_at) values ('0a000000-0000-0000-0000-000000000000', 'new', 'late_report', 'monthly', 5, 'previous_month', '{"roleKeys":["owner"]}', now()) $q$, '6a-D3 schedules are written by the API only: a user session cannot insert (raises)');
select pg_temp.assert_raises($q$ update public.report_schedules set name = 'renamed' where id = '0a000000-0000-0000-0000-0000000006a3' $q$, '6a-D3 a user session cannot update a schedule (raises)');
select pg_temp.assert_raises($q$ update public.report_schedules set next_run_at = now() - interval '1 minute' where id = '0a000000-0000-0000-0000-0000000006a1' $q$, '6a-D3 next_run_at cannot be rewound from a user session');
select pg_temp.assert_raises($q$ delete from public.report_schedules where id = '0a000000-0000-0000-0000-0000000006a3' $q$, '6a-D3 a user session cannot delete a schedule (raises)');
select pg_temp.assert_eq((select count(*) from public.report_deliveries), 4, 'owner A (unrestricted report.schedule) sees the whole delivery trail of A');
select pg_temp.assert_raises($q$ insert into public.report_deliveries (organization_id, run_key, mode, report_type, format, recipient_user_id) values ('0a000000-0000-0000-0000-000000000000', 'send:y', 'send_now', 'late_report', 'pdf', 'a0000000-0000-0000-0000-000000000001') $q$, 'the delivery trail is never written from a user session (raises)');
select pg_temp.assert_raises($q$ update public.report_deliveries set status = 'delivered' where id = '0a000000-0000-0000-0000-0000000006d2' $q$, 'deliveries cannot be updated from a user session');
select pg_temp.assert_raises($q$ delete from public.report_deliveries where id = '0a000000-0000-0000-0000-0000000006d2' $q$, 'deliveries cannot be deleted from a user session');
rollback;

-- ---------- 6a-D3 branch-scoped scheduler (report.view + report.schedule, branch A-2 only) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-0000000006f9","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.report_schedules), 1, '6a-D3 a branch-scoped scheduler sees the schedules of their branch only');
select pg_temp.assert_eq((select count(*) from public.report_schedules where branch_id is null), 0, '6a-D3 a branch-scoped scheduler does not see organisation-wide schedules');
select pg_temp.assert_raises($q$ update public.report_schedules set name = 'hijacked', recipients = '{"userIds":["a0000000-0000-0000-0000-0000000006f9"],"roleKeys":[]}' where branch_id is null $q$, '6a-D3 re-pointing an organisation-wide schedule raises');
select pg_temp.assert_raises($q$ update public.report_schedules set next_run_at = now() - interval '1 minute' where id = '0a000000-0000-0000-0000-0000000006a2' $q$, '6a-D3 even their own branch''s next_run_at cannot be rewound directly');
select pg_temp.assert_raises($q$ delete from public.report_schedules where branch_id is null $q$, '6a-D3 deleting an organisation-wide schedule raises');
select pg_temp.assert_raises($q$ insert into public.report_schedules (organization_id, name, report_type, cadence, run_day, period_rule, recipients, next_run_at) values ('0a000000-0000-0000-0000-000000000000', 'bs org-wide', 'late_report', 'monthly', 5, 'previous_month', '{"roleKeys":["owner"]}', now()) $q$, '6a-D3 inserting a schedule raises');
select pg_temp.assert_eq((select count(*) from public.report_deliveries), 2, '6a-D3 a branch-scoped scheduler sees the deliveries of their branch''s schedules and what they sent');
select pg_temp.assert_eq((select count(*) from public.report_deliveries where id in ('0a000000-0000-0000-0000-0000000006d4', '0a000000-0000-0000-0000-0000000006d5')), 2, '6a-D3 … namely d4 (schedule of A-2) and d5 (sent by them)');
select pg_temp.assert_eq((select count(*) from public.report_deliveries where id in ('0a000000-0000-0000-0000-0000000006d1', '0a000000-0000-0000-0000-0000000006d2')), 0, '6a-D3 … never the organisation-wide schedule''s or other people''s sends');
rollback;

-- ---------- branch manager A (report.view, branch A-2 only, no report.schedule) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.report_schedules), 1, '6a-D3 branch manager sees own-branch schedules only (no organisation-wide ones)');
select pg_temp.assert_eq((select count(*) from public.report_schedules where id = '0a000000-0000-0000-0000-0000000006a3'), 0, 'branch manager cannot see the HQ schedule');
select pg_temp.assert_raises($q$ insert into public.report_schedules (organization_id, name, report_type, cadence, run_day, period_rule, branch_id, next_run_at) values ('0a000000-0000-0000-0000-000000000000', 'x', 'late_report', 'monthly', 5, 'previous_month', '0a000000-0000-0000-0000-00000000000c', now()) $q$, 'branch manager cannot create a schedule');
select pg_temp.assert_raises($q$ update public.report_schedules set name = 'x' where id = '0a000000-0000-0000-0000-0000000006a2' $q$, 'branch manager cannot edit a schedule');
select pg_temp.assert_eq((select count(*) from public.report_deliveries), 0, 'branch manager is not a recipient of anything');
rollback;

-- ---------- auditor A (report.view org-wide, no report.schedule) and manager A ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000007","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.report_schedules), 3, 'auditor reads every schedule of A');
select pg_temp.assert_raises($q$ delete from public.report_schedules where id = '0a000000-0000-0000-0000-0000000006a1' $q$, 'auditor cannot delete a schedule');
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

-- ---------- system context (API system step, worker) and platform context (scheduler scan) ----------
begin;
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system","org_id":"0a000000-0000-0000-0000-000000000000"}', true);
select pg_temp.assert_eq((select count(*) from public.report_schedules), 3, 'system context for A sees A schedules');
select pg_temp.assert_rows($q$ insert into public.report_schedules (organization_id, name, report_type, cadence, run_day, period_rule, recipients, next_run_at) values ('0a000000-0000-0000-0000-000000000000', 'new', 'late_report', 'monthly', 5, 'previous_month', '{"roleKeys":["owner"]}', now()) $q$, 1, '6a-D3 the API''s system step writes A schedules');
select pg_temp.assert_raises($q$ insert into public.report_schedules (organization_id, name, report_type, cadence, run_day, period_rule, next_run_at) values ('0b000000-0000-0000-0000-000000000000', 'x', 'late_report', 'monthly', 5, 'previous_month', now()) $q$, 'system context for A cannot create a schedule in org B');
select pg_temp.assert_raises($q$ update public.report_schedules set cadence = 'weekly' where id = '0a000000-0000-0000-0000-0000000006a1' $q$, 'weekly + previous_month violates the cadence/period check');
select pg_temp.assert_raises($q$ update public.report_schedules set is_active = true, next_run_at = null where id = '0a000000-0000-0000-0000-0000000006a1' $q$, 'an active schedule needs a next run');
select pg_temp.assert_rows($q$ insert into public.report_deliveries (organization_id, run_key, mode, report_type, format, recipient_user_id) values ('0a000000-0000-0000-0000-000000000000', 'send:sys', 'send_now', 'late_report', 'pdf', 'a0000000-0000-0000-0000-000000000001') $q$, 1, 'system context for A writes the A delivery trail');
select pg_temp.assert_raises($q$ insert into public.report_deliveries (organization_id, run_key, mode, report_type, format, recipient_user_id) values ('0a000000-0000-0000-0000-000000000000', 'send:sys', 'send_now', 'late_report', 'pdf', 'a0000000-0000-0000-0000-000000000001') $q$, 'one delivery per (run key, recipient)');
select pg_temp.assert_raises($q$ insert into public.report_deliveries (organization_id, run_key, mode, report_type, format, recipient_user_id) values ('0b000000-0000-0000-0000-000000000000', 'send:sys', 'send_now', 'late_report', 'pdf', 'b0000000-0000-0000-0000-000000000001') $q$, 'system context for A cannot write the B delivery trail');
select pg_temp.assert_rows($q$ update public.report_deliveries set status = 'cancelled' where id = '0a000000-0000-0000-0000-0000000006d1' $q$, 1, '6a-M14 a delivery can settle as cancelled');
select pg_temp.assert_raises($q$ update public.report_deliveries set status = 'lost' where id = '0a000000-0000-0000-0000-0000000006d1' $q$, 'an unknown delivery status is refused');
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
