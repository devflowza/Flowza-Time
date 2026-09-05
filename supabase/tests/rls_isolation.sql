-- RLS isolation tests. Run with: psql -v ON_ERROR_STOP=1 -f supabase/tests/rls_isolation.sql (as superuser; connects as flowza_api for checks)
\set QUIET on
\set ON_ERROR_STOP on
set client_min_messages = warning;

-- ---------- fixtures (as superuser) ----------
begin;
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'owner-a@test.local'),
  ('a0000000-0000-0000-0000-000000000002', 'bm-a@test.local'),
  ('a0000000-0000-0000-0000-000000000003', 'emp-a@test.local'),
  ('b0000000-0000-0000-0000-000000000001', 'owner-b@test.local'),
  ('c0000000-0000-0000-0000-000000000001', 'platform@test.local');
insert into public.user_profiles (id, email, full_name) values
  ('a0000000-0000-0000-0000-000000000001', 'owner-a@test.local', 'Owner A'),
  ('a0000000-0000-0000-0000-000000000002', 'bm-a@test.local', 'Branch Manager A'),
  ('a0000000-0000-0000-0000-000000000003', 'emp-a@test.local', 'Employee A'),
  ('b0000000-0000-0000-0000-000000000001', 'owner-b@test.local', 'Owner B'),
  ('c0000000-0000-0000-0000-000000000001', 'platform@test.local', 'Platform Admin');
insert into public.organizations (id, company_code, legal_name, display_name) values
  ('0a000000-0000-0000-0000-000000000000', 'TEST-A', 'Org A LLC', 'Org A'),
  ('0b000000-0000-0000-0000-000000000000', 'TEST-B', 'Org B LLC', 'Org B');
insert into public.branches (id, organization_id, code, name) values
  ('0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-000000000000', 'A-HQ', 'A HQ'),
  ('0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-000000000000', 'A-2', 'A Branch 2'),
  ('0b000000-0000-0000-0000-00000000000b', '0b000000-0000-0000-0000-000000000000', 'B-HQ', 'B HQ');
insert into public.employees (id, organization_id, employee_number, first_name, last_name, display_name, joining_date, branch_id, device_user_id, user_id) values
  ('0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-000000000000', 'A-001', 'Ali', 'Said', 'Ali Said', '2025-01-01', '0a000000-0000-0000-0000-00000000000b', '1', null),
  ('0a000000-0000-0000-0000-0000000000e2', '0a000000-0000-0000-0000-000000000000', 'A-002', 'Sara', 'Nasser', 'Sara Nasser', '2025-01-01', '0a000000-0000-0000-0000-00000000000c', '2', null),
  ('0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-000000000000', 'A-003', 'Self', 'Service', 'Self Service', '2025-01-01', '0a000000-0000-0000-0000-00000000000c', '3', 'a0000000-0000-0000-0000-000000000003'),
  ('0b000000-0000-0000-0000-0000000000e1', '0b000000-0000-0000-0000-000000000000', 'B-001', 'Omar', 'Khalid', 'Omar Khalid', '2025-01-01', '0b000000-0000-0000-0000-00000000000b', '1', null);
insert into public.org_memberships (id, organization_id, user_id, role_id, status, all_branches, employee_id) values
  ('0a000000-0000-0000-0000-0000000000a1', '0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'active', true, null),
  ('0a000000-0000-0000-0000-0000000000a2', '0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000005', 'active', false, null),
  ('0a000000-0000-0000-0000-0000000000a3', '0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000008', 'active', true, '0a000000-0000-0000-0000-0000000000e3'),
  ('0b000000-0000-0000-0000-0000000000a1', '0b000000-0000-0000-0000-000000000000', 'b0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'active', true, null);
insert into public.membership_branches (membership_id, branch_id) values ('0a000000-0000-0000-0000-0000000000a2', '0a000000-0000-0000-0000-00000000000c');
insert into public.platform_admins (user_id, level) values ('c0000000-0000-0000-0000-000000000001', 'support');
insert into public.devices (id, organization_id, branch_id, code, name, provider_key, manufacturer, integration_type) values
  ('0a000000-0000-0000-0000-0000000000d1', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-00000000000b', 'A-DEV-1', 'A Device 1', 'mock', 'FlowZa', 'VENDOR_CLOUD_PULL'),
  ('0b000000-0000-0000-0000-0000000000d1', '0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-00000000000b', 'B-DEV-1', 'B Device 1', 'mock', 'FlowZa', 'VENDOR_CLOUD_PULL');
insert into public.device_credentials (device_id, organization_id, key_id, nonce, ciphertext, auth_tag, masked) values
  ('0a000000-0000-0000-0000-0000000000d1', '0a000000-0000-0000-0000-000000000000', 'k1', '\x00', '\x00', '\x00', '{"apiKey":"****abcd"}');
insert into public.attendance_daily_records (organization_id, employee_id, attendance_date, branch_id, timezone, engine_version, status) values
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '2026-09-01', '0a000000-0000-0000-0000-00000000000b', 'Asia/Muscat', 'test', 'PRESENT'),
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e2', '2026-09-01', '0a000000-0000-0000-0000-00000000000c', 'Asia/Muscat', 'test', 'PRESENT'),
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '2026-09-01', '0a000000-0000-0000-0000-00000000000c', 'Asia/Muscat', 'test', 'PRESENT'),
  ('0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '2026-09-01', '0b000000-0000-0000-0000-00000000000b', 'Asia/Muscat', 'test', 'PRESENT');
commit;

-- helper to assert counts
create or replace function pg_temp.assert_eq(actual bigint, expected bigint, label text) returns void language plpgsql as $$
begin
  if actual <> expected then raise exception 'ASSERT FAILED: % — expected %, got %', label, expected, actual; end if;
  raise notice 'ok: % (%)', label, actual;
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
create or replace function pg_temp.assert_rows(sqltext text, expected bigint, label text) returns void language plpgsql as $$
declare n bigint;
begin
  execute sqltext; get diagnostics n = row_count;
  if n <> expected then raise exception 'ASSERT FAILED: % — expected % affected rows, got %', label, expected, n; end if;
  raise notice 'ok: % (% rows)', label, n;
end $$;
grant execute on all functions in schema pg_temp to public;
set client_min_messages = notice;

-- ---------- as Owner A (authenticated) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.organizations), 1, 'owner A sees only org A');
select pg_temp.assert_eq((select count(*) from public.employees), 3, 'owner A sees 3 employees of A');
select pg_temp.assert_eq((select count(*) from public.employees where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'owner A cannot see org B employees even when filtering by B id');
select pg_temp.assert_eq((select count(*) from public.devices), 1, 'owner A sees only A devices');
select pg_temp.assert_eq((select count(*) from public.attendance_daily_records), 3, 'owner A sees 3 daily records');
select pg_temp.assert_raises($q$ select count(*) from public.device_credentials $q$, 'owner A cannot read device_credentials at all');
select pg_temp.assert_raises($q$ insert into public.employees (organization_id, employee_number, first_name, last_name, display_name, joining_date, branch_id, device_user_id) values ('0b000000-0000-0000-0000-000000000000','X','x','x','x','2025-01-01','0b000000-0000-0000-0000-00000000000b','99') $q$, 'owner A cannot insert an employee into org B');
select pg_temp.assert_eq((select count(*) from jsonb_object_keys(secrets.masked_device_credentials('0a000000-0000-0000-0000-0000000000d1'))), 4, 'owner A gets masked credentials for own device');
select pg_temp.assert_eq((select count(*) from jsonb_object_keys(secrets.masked_device_credentials('0b000000-0000-0000-0000-0000000000d1'))), 0, 'owner A gets nothing for org B device');
select pg_temp.assert_raises($q$ select * from secrets.get_device_credentials('0a000000-0000-0000-0000-0000000000d1') $q$, 'user context cannot decrypt credentials');
rollback;

-- ---------- as Branch Manager A (restricted to branch A-2) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.employees), 2, 'branch manager sees only branch A-2 employees');
select pg_temp.assert_eq((select count(*) from public.branches), 1, 'branch manager sees only own branch');
select pg_temp.assert_eq((select count(*) from public.devices), 0, 'branch manager sees no devices in HQ');
select pg_temp.assert_eq((select count(*) from public.attendance_daily_records), 2, 'branch manager sees records of own branch only');
-- attempt to move an employee into HQ (branch spoofing) must fail via WITH CHECK
select pg_temp.assert_raises($q$ update public.employees set branch_id = '0a000000-0000-0000-0000-00000000000b' where id = '0a000000-0000-0000-0000-0000000000e2' $q$, 'branch manager cannot move employee to a branch outside scope');
-- cannot create employees (no employee.create), even in own branch
select pg_temp.assert_raises($q$ insert into public.employees (organization_id, employee_number, first_name, last_name, display_name, joining_date, branch_id, device_user_id) values ('0a000000-0000-0000-0000-000000000000','A-009','x','x','x','2025-01-01','0a000000-0000-0000-0000-00000000000c','9') $q$, 'branch manager lacks employee.create');
select pg_temp.assert_eq((select count(*) from public.employee_identity_documents), 0, 'branch manager has no employee.view_sensitive');
rollback;

-- ---------- as Employee (self-service) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.employees), 1, 'employee sees only own employee row');
select pg_temp.assert_eq((select count(*) from public.attendance_daily_records), 1, 'employee sees only own attendance');
select pg_temp.assert_eq((select count(*) from public.devices), 0, 'employee sees no devices');
select pg_temp.assert_rows($q$ update public.employees set display_name = 'Hacked' where id = '0a000000-0000-0000-0000-0000000000e3' $q$, 0, 'employee cannot update own master record');
rollback;

-- ---------- as Owner B ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.employees), 1, 'owner B sees 1 employee');
select pg_temp.assert_eq((select count(*) from public.attendance_daily_records where organization_id = '0a000000-0000-0000-0000-000000000000'), 0, 'owner B cannot see org A attendance');
select pg_temp.assert_eq((select count(*) from public.org_memberships), 1, 'owner B sees only own memberships');
rollback;

-- ---------- forged system claim from an authenticated session must NOT work ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"flowza_system","org_id":"0b000000-0000-0000-0000-000000000000"}', true);
select pg_temp.assert_eq((select count(*) from public.employees), 0, 'forged system claim under authenticated role sees nothing');
rollback;

-- ---------- platform admin without grant ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.organizations), 2, 'platform admin sees organisation list');
select pg_temp.assert_eq((select count(*) from public.employees), 0, 'platform admin WITHOUT grant sees no employees');
rollback;

-- ---------- platform admin with a read grant on org A ----------
begin;
insert into public.platform_access_grants (platform_admin_user_id, organization_id, access_level, reason, expires_at)
values ('c0000000-0000-0000-0000-000000000001', '0a000000-0000-0000-0000-000000000000', 'read', 'Support ticket #123 investigation', now() + interval '1 hour');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.employees), 3, 'platform admin WITH grant sees org A employees');
select pg_temp.assert_eq((select count(*) from public.employees where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'grant does not extend to org B');
select pg_temp.assert_rows($q$ update public.employees set display_name = 'x' where id = '0a000000-0000-0000-0000-0000000000e1' $q$, 0, 'read grant cannot write');
rollback;
