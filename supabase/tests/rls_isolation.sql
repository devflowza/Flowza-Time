-- RLS isolation tests. Run with: psql -v ON_ERROR_STOP=1 -f supabase/tests/rls_isolation.sql (as superuser; connects as flowza_api for checks)
\set QUIET on
\set ON_ERROR_STOP on
set client_min_messages = warning;

-- ---------- fixtures (as superuser) ----------
-- Org A: e1 (HQ) reports to e4 (primary, login manager-a, role manager) and e5 (secondary, login secondary-a, role manager);
--        e6 (branch A-2) reports to e1 (a report of a report: reachable by the deep chain, NOT a direct report of e4);
--        e2 (branch A-2) reports to e3 (the self-service employee, role `employee` — a relationship without a team key);
--        auditor-a holds the read-only auditor role and is linked to no employee.
begin;
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'owner-a@test.local'),
  ('a0000000-0000-0000-0000-000000000002', 'bm-a@test.local'),
  ('a0000000-0000-0000-0000-000000000003', 'emp-a@test.local'),
  ('a0000000-0000-0000-0000-000000000005', 'manager-a@test.local'),
  ('a0000000-0000-0000-0000-000000000006', 'secondary-a@test.local'),
  ('a0000000-0000-0000-0000-000000000007', 'auditor-a@test.local'),
  ('b0000000-0000-0000-0000-000000000001', 'owner-b@test.local'),
  ('c0000000-0000-0000-0000-000000000001', 'platform@test.local');
insert into public.user_profiles (id, email, full_name) values
  ('a0000000-0000-0000-0000-000000000001', 'owner-a@test.local', 'Owner A'),
  ('a0000000-0000-0000-0000-000000000002', 'bm-a@test.local', 'Branch Manager A'),
  ('a0000000-0000-0000-0000-000000000003', 'emp-a@test.local', 'Employee A'),
  ('a0000000-0000-0000-0000-000000000005', 'manager-a@test.local', 'Line Manager A'),
  ('a0000000-0000-0000-0000-000000000006', 'secondary-a@test.local', 'Secondary Manager A'),
  ('a0000000-0000-0000-0000-000000000007', 'auditor-a@test.local', 'Auditor A'),
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
  ('0a000000-0000-0000-0000-0000000000e4', '0a000000-0000-0000-0000-000000000000', 'A-004', 'Mansoor', 'Manager', 'Mansoor Manager', '2025-01-01', '0a000000-0000-0000-0000-00000000000b', '4', null),
  ('0a000000-0000-0000-0000-0000000000e5', '0a000000-0000-0000-0000-000000000000', 'A-005', 'Salma', 'Deputy', 'Salma Deputy', '2025-01-01', '0a000000-0000-0000-0000-00000000000b', '5', null),
  ('0a000000-0000-0000-0000-0000000000e6', '0a000000-0000-0000-0000-000000000000', 'A-006', 'Junior', 'Report', 'Junior Report', '2025-01-01', '0a000000-0000-0000-0000-00000000000c', '6', null),
  ('0b000000-0000-0000-0000-0000000000e1', '0b000000-0000-0000-0000-000000000000', 'B-001', 'Omar', 'Khalid', 'Omar Khalid', '2025-01-01', '0b000000-0000-0000-0000-00000000000b', '1', null);
update public.employees set manager_employee_id = '0a000000-0000-0000-0000-0000000000e4', secondary_manager_employee_id = '0a000000-0000-0000-0000-0000000000e5' where id = '0a000000-0000-0000-0000-0000000000e1';
update public.employees set manager_employee_id = '0a000000-0000-0000-0000-0000000000e1' where id = '0a000000-0000-0000-0000-0000000000e6';
update public.employees set manager_employee_id = '0a000000-0000-0000-0000-0000000000e3' where id = '0a000000-0000-0000-0000-0000000000e2';
insert into public.org_memberships (id, organization_id, user_id, role_id, status, all_branches, employee_id) values
  ('0a000000-0000-0000-0000-0000000000a1', '0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'active', true, null),
  ('0a000000-0000-0000-0000-0000000000a2', '0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000005', 'active', false, null),
  ('0a000000-0000-0000-0000-0000000000a3', '0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000008', 'active', true, '0a000000-0000-0000-0000-0000000000e3'),
  ('0a000000-0000-0000-0000-0000000000a5', '0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000009', 'active', true, '0a000000-0000-0000-0000-0000000000e4'),
  ('0a000000-0000-0000-0000-0000000000a6', '0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000009', 'active', true, '0a000000-0000-0000-0000-0000000000e5'),
  ('0a000000-0000-0000-0000-0000000000a7', '0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000010', 'active', true, null),
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
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e4', '2026-09-01', '0a000000-0000-0000-0000-00000000000b', 'Asia/Muscat', 'test', 'PRESENT'),
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e5', '2026-09-01', '0a000000-0000-0000-0000-00000000000b', 'Asia/Muscat', 'test', 'PRESENT'),
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e6', '2026-09-01', '0a000000-0000-0000-0000-00000000000c', 'Asia/Muscat', 'test', 'PRESENT'),
  ('0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '2026-09-01', '0b000000-0000-0000-0000-00000000000b', 'Asia/Muscat', 'test', 'PRESENT');
insert into public.leave_types (id, organization_id, code, name, status) values
  ('0a000000-0000-0000-0000-0000000001a1', '0a000000-0000-0000-0000-000000000000', 'AL', 'Annual Leave', 'active'),
  ('0a000000-0000-0000-0000-0000000001a2', '0a000000-0000-0000-0000-000000000000', 'OLD', 'Archived type', 'archived');
insert into public.leave_records (id, organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, status) values
  ('0a000000-0000-0000-0000-0000000001b1', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-0000000001a1', '2026-10-04', '2026-10-05', 'PENDING'),
  ('0a000000-0000-0000-0000-0000000001b3', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000001a1', '2026-10-11', '2026-10-12', 'PENDING'),
  ('0a000000-0000-0000-0000-0000000001b4', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000001a1', '2026-08-02', '2026-08-03', 'APPROVED');
-- attendance day marks (migration 20260928000300): e1 (HQ) unexcused, e2 (A-2) loss of pay, e3 (A-2, self-service) excused; one in org B
insert into public.attendance_day_marks (id, organization_id, employee_id, attendance_date, branch_id, kind, pay_effect_days, source, reason) values
  ('0a000000-0000-0000-0000-0000000002a1', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '2026-09-01', '0a000000-0000-0000-0000-00000000000b', 'UNEXCUSED', 1, 'SWEEP', 'Day close'),
  ('0a000000-0000-0000-0000-0000000002a2', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e2', '2026-09-01', '0a000000-0000-0000-0000-00000000000c', 'LOP', 1, 'SWEEP', 'No paid leave left'),
  ('0a000000-0000-0000-0000-0000000002a3', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '2026-09-01', '0a000000-0000-0000-0000-00000000000c', 'EXCUSED', 0, 'HR', 'Client visit'),
  ('0b000000-0000-0000-0000-0000000002a1', '0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '2026-09-01', '0b000000-0000-0000-0000-00000000000b', 'UNEXCUSED', 1, 'SWEEP', 'Day close');
-- Flowza Finance connector state (migration 20260928000400): one row per connector device, system-written
insert into public.finance_sync_state (device_id, organization_id, last_pull_count, consecutive_failures) values
  ('0a000000-0000-0000-0000-0000000000d1', '0a000000-0000-0000-0000-000000000000', 3, 0),
  ('0b000000-0000-0000-0000-0000000000d1', '0b000000-0000-0000-0000-000000000000', 1, 2);
-- Flowza Finance push ledger (migration 20260928000450): same rules as the connector state
insert into public.finance_pushed_events (organization_id, device_id, event_id, outcome) values
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000d1', '0a000000-0000-0000-0000-0000000003a1', 'pushed'),
  ('0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000d1', '0b000000-0000-0000-0000-0000000003a1', 'no_pin');
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
create or replace function pg_temp.assert_check_violation(sqltext text, expected_constraint text, label text) returns void language plpgsql as $$
declare v_constraint text;
begin
  begin
    execute sqltext;
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from expected_constraint then raise exception 'ASSERT FAILED: % — expected constraint %, got %', label, expected_constraint, v_constraint; end if;
    raise notice 'ok: % (%)', label, v_constraint; return;
  end;
  raise exception 'ASSERT FAILED: % — expected a check violation', label;
end $$;
grant execute on all functions in schema pg_temp to public;
set client_min_messages = notice;

-- ---------- as Owner A (authenticated) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.organizations), 1, 'owner A sees only org A');
select pg_temp.assert_eq((select count(*) from public.employees), 6, 'owner A sees 6 employees of A');
select pg_temp.assert_eq((select count(*) from public.employees where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'owner A cannot see org B employees even when filtering by B id');
select pg_temp.assert_eq((select count(*) from public.devices), 1, 'owner A sees only A devices');
select pg_temp.assert_eq((select count(*) from public.attendance_daily_records), 6, 'owner A sees 6 daily records');
select pg_temp.assert_raises($q$ select count(*) from public.device_credentials $q$, 'owner A cannot read device_credentials at all');
select pg_temp.assert_raises($q$ insert into public.employees (organization_id, employee_number, first_name, last_name, display_name, joining_date, branch_id, device_user_id) values ('0b000000-0000-0000-0000-000000000000','X','x','x','x','2025-01-01','0b000000-0000-0000-0000-00000000000b','99') $q$, 'owner A cannot insert an employee into org B');
select pg_temp.assert_eq((select count(*) from jsonb_object_keys(secrets.masked_device_credentials('0a000000-0000-0000-0000-0000000000d1'))), 4, 'owner A gets masked credentials for own device');
select pg_temp.assert_eq((select count(*) from jsonb_object_keys(secrets.masked_device_credentials('0b000000-0000-0000-0000-0000000000d1'))), 0, 'owner A gets nothing for org B device');
select pg_temp.assert_raises($q$ select * from secrets.get_device_credentials('0a000000-0000-0000-0000-0000000000d1') $q$, 'user context cannot decrypt credentials');
-- an owner is linked to no employee: no team, whatever the permissions
select pg_temp.assert_eq((select cardinality(app.team_employee_ids())), 0, 'owner A (no employee link) has no team');
-- day marks: organisation-wide read (attendance.view). Since the security gate (20260928001100) no client session writes a
-- mark, whatever it holds: the API checks attendance.approve, the team / branch scope and segregation of duties, then writes
-- in its system step (a direct write let an approver excuse their OWN days or choose the row's branch). The append-only
-- rules are asserted in the system-context block below.
select pg_temp.assert_eq((select count(*) from public.attendance_day_marks), 3, 'owner A sees the 3 day marks of A');
select pg_temp.assert_eq((select count(*) from public.attendance_day_marks where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'owner A cannot see org B day marks');
select pg_temp.assert_raises($q$ insert into public.attendance_day_marks (organization_id, employee_id, attendance_date, branch_id, kind, pay_effect_days, source, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '2026-09-02', '0a000000-0000-0000-0000-00000000000b', 'EXCUSED', 0, 'HR', 'test') $q$, 'owner A (attendance.approve) cannot write a day mark directly: the API writes it in its system step');
select pg_temp.assert_raises($q$ insert into public.attendance_day_marks (organization_id, employee_id, attendance_date, branch_id, kind, pay_effect_days, source, reason) values ('0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '2026-09-02', '0b000000-0000-0000-0000-00000000000b', 'EXCUSED', 0, 'HR', 'test') $q$, 'owner A cannot mark a day in org B');
select pg_temp.assert_raises($q$ update public.attendance_day_marks set revoked_at = now(), revoked_by = 'a0000000-0000-0000-0000-000000000001', revoke_reason = 'Wrong day' where id = '0a000000-0000-0000-0000-0000000002a1' $q$, 'owner A cannot revoke a mark directly');
select pg_temp.assert_raises($q$ delete from public.attendance_day_marks where id = '0a000000-0000-0000-0000-0000000002a2' $q$, 'owner A cannot delete a day mark');
-- finance_sync_state: readable with device.view, never writable from a user session (no policy AND no grant → raises, not 0 rows)
select pg_temp.assert_eq((select count(*) from public.finance_sync_state), 1, 'owner A sees only own connector state');
select pg_temp.assert_eq((select count(*) from public.finance_sync_state where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'owner A cannot see org B connector state');
select pg_temp.assert_raises($q$ insert into public.finance_sync_state (device_id, organization_id) values ('0a000000-0000-0000-0000-0000000000d1', '0a000000-0000-0000-0000-000000000000') $q$, 'owner A cannot insert connector state');
select pg_temp.assert_raises($q$ update public.finance_sync_state set consecutive_failures = 0 where device_id = '0a000000-0000-0000-0000-0000000000d1' $q$, 'owner A cannot update connector state');
select pg_temp.assert_raises($q$ delete from public.finance_sync_state where device_id = '0a000000-0000-0000-0000-0000000000d1' $q$, 'owner A cannot delete connector state');
-- finance_pushed_events (the push ledger): the same — device.view reads, no client write of any kind (raises)
select pg_temp.assert_eq((select count(*) from public.finance_pushed_events), 1, 'owner A sees only own push ledger');
select pg_temp.assert_eq((select count(*) from public.finance_pushed_events where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'owner A cannot see org B push ledger');
select pg_temp.assert_raises($q$ insert into public.finance_pushed_events (organization_id, device_id, event_id) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000d1', '0a000000-0000-0000-0000-0000000003a2') $q$, 'owner A cannot write the push ledger');
select pg_temp.assert_raises($q$ update public.finance_pushed_events set outcome = 'pushed' where device_id = '0a000000-0000-0000-0000-0000000000d1' $q$, 'owner A cannot update the push ledger');
select pg_temp.assert_raises($q$ delete from public.finance_pushed_events where device_id = '0a000000-0000-0000-0000-0000000000d1' $q$, 'owner A cannot delete from the push ledger');
rollback;

-- ---------- the system step (the API after its checks, the day-close sweep): day marks are append-only with revocation ----------
begin;
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system","org_id":"0a000000-0000-0000-0000-000000000000"}', true);
select pg_temp.assert_rows($q$ insert into public.attendance_day_marks (organization_id, employee_id, attendance_date, branch_id, kind, pay_effect_days, source, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '2026-09-02', '0a000000-0000-0000-0000-00000000000b', 'EXCUSED', 0, 'HR', 'test') $q$, 1, 'the system step marks a day');
select pg_temp.assert_raises($q$ insert into public.attendance_day_marks (organization_id, employee_id, attendance_date, branch_id, kind, pay_effect_days, source, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '2026-09-01', '0a000000-0000-0000-0000-00000000000b', 'UNEXCUSED', 1, 'SWEEP', 'test') $q$, 'one active mark per (employee, date, kind)');
select pg_temp.assert_raises($q$ insert into public.attendance_day_marks (organization_id, employee_id, attendance_date, branch_id, kind, pay_effect_days, source, reason) values ('0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '2026-09-02', '0b000000-0000-0000-0000-00000000000b', 'EXCUSED', 0, 'HR', 'test') $q$, 'the system step of org A cannot mark a day in org B');
select pg_temp.assert_raises($q$ update public.attendance_day_marks set kind = 'EXCUSED', pay_effect_days = 0 where id = '0a000000-0000-0000-0000-0000000002a2' $q$, 'a day mark''s verdict is immutable');
select pg_temp.assert_raises($q$ delete from public.attendance_day_marks where id = '0a000000-0000-0000-0000-0000000002a2' $q$, 'day marks are never deleted (revoke instead)');
select pg_temp.assert_raises($q$ update public.attendance_day_marks set organization_id = '0b000000-0000-0000-0000-000000000000' where id = '0a000000-0000-0000-0000-0000000002a2' $q$, 'a day mark never moves to another organisation');
select pg_temp.assert_rows($q$ update public.attendance_day_marks set revoked_at = now(), revoked_by = 'a0000000-0000-0000-0000-000000000001', revoke_reason = 'Wrong day' where id = '0a000000-0000-0000-0000-0000000002a1' $q$, 1, 'the system step revokes a mark');
select pg_temp.assert_raises($q$ update public.attendance_day_marks set revoke_reason = 'Changed my mind' where id = '0a000000-0000-0000-0000-0000000002a1' $q$, 'a revoked mark is frozen');
select pg_temp.assert_rows($q$ insert into public.attendance_day_marks (organization_id, employee_id, attendance_date, branch_id, kind, pay_effect_days, source, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '2026-09-01', '0a000000-0000-0000-0000-00000000000b', 'UNEXCUSED', 1, 'SWEEP', 'test') $q$, 1, 'after the revocation a new active mark of the same kind may be written');
rollback;

-- ---------- as Branch Manager A (restricted to branch A-2) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.employees), 3, 'branch manager sees only branch A-2 employees');
select pg_temp.assert_eq((select count(*) from public.branches), 1, 'branch manager sees only own branch');
select pg_temp.assert_eq((select count(*) from public.devices), 0, 'branch manager sees no devices in HQ');
select pg_temp.assert_eq((select count(*) from public.attendance_daily_records), 3, 'branch manager sees records of own branch only');
-- attempt to move an employee into HQ (branch spoofing) must fail via WITH CHECK
select pg_temp.assert_raises($q$ update public.employees set branch_id = '0a000000-0000-0000-0000-00000000000b' where id = '0a000000-0000-0000-0000-0000000000e2' $q$, 'branch manager cannot move employee to a branch outside scope');
-- cannot create employees (no employee.create), even in own branch
select pg_temp.assert_raises($q$ insert into public.employees (organization_id, employee_number, first_name, last_name, display_name, joining_date, branch_id, device_user_id) values ('0a000000-0000-0000-0000-000000000000','A-009','x','x','x','2025-01-01','0a000000-0000-0000-0000-00000000000c','9') $q$, 'branch manager lacks employee.create');
select pg_temp.assert_eq((select count(*) from public.employee_identity_documents), 0, 'branch manager has no employee.view_sensitive');
-- branch_manager carries the team keys, but this membership is linked to no employee: team semantics add nothing
select pg_temp.assert_eq((select cardinality(app.team_employee_ids())), 0, 'branch manager without an employee link has no team');
select pg_temp.assert_eq((select count(*) from public.attendance_day_marks), 2, 'branch manager sees the day marks of branch A-2 only');
select pg_temp.assert_raises($q$ insert into public.attendance_day_marks (organization_id, employee_id, attendance_date, branch_id, kind, pay_effect_days, source, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '2026-09-02', '0a000000-0000-0000-0000-00000000000b', 'EXCUSED', 0, 'HR', 'test') $q$, 'branch manager cannot mark a day outside the branch scope');
select pg_temp.assert_raises($q$ insert into public.attendance_day_marks (organization_id, employee_id, attendance_date, branch_id, kind, pay_effect_days, source, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e2', '2026-09-02', '0a000000-0000-0000-0000-00000000000c', 'UNEXCUSED', 0, 'HR', 'test') $q$, 'branch manager cannot write a day mark directly, even in own branch (the API writes it after the branch check)');
select pg_temp.assert_raises($q$ update public.attendance_day_marks set revoked_at = now(), revoke_reason = 'x' where id = '0a000000-0000-0000-0000-0000000002a1' $q$, 'branch manager cannot revoke a mark outside the branch scope');
select pg_temp.assert_eq((select count(*) from public.finance_sync_state), 1, 'connector state is organisation-level (device.view, not branch scoped)');
select pg_temp.assert_eq((select count(*) from public.finance_pushed_events), 1, 'push ledger is organisation-level (device.view, not branch scoped)');
rollback;

-- ---------- as Employee (self-service) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.employees), 1, 'employee sees only own employee row');
select pg_temp.assert_eq((select count(*) from public.attendance_daily_records), 1, 'employee sees only own attendance');
select pg_temp.assert_eq((select count(*) from public.devices), 0, 'employee sees no devices');
select pg_temp.assert_eq((select count(*) from public.finance_sync_state), 0, 'employee sees no connector state');
select pg_temp.assert_eq((select count(*) from public.finance_pushed_events), 0, 'employee sees no push ledger');
select pg_temp.assert_rows($q$ update public.employees set display_name = 'Hacked' where id = '0a000000-0000-0000-0000-0000000000e3' $q$, 0, 'employee cannot update own master record');
-- e2 reports to this employee, but the `employee` role holds no team key: the relationship alone opens nothing
select pg_temp.assert_eq((select cardinality(app.team_employee_ids())), 1, 'employee is somebody''s manager (relationship exists)');
select pg_temp.assert_eq((select count(*) from public.attendance_daily_records where employee_id = '0a000000-0000-0000-0000-0000000000e2'), 0, 'a manager relationship without attendance.view_team reveals no attendance');
select pg_temp.assert_eq((select count(*) from public.employees where id = '0a000000-0000-0000-0000-0000000000e2'), 0, 'a manager relationship without a team key reveals no employee row');
select pg_temp.assert_eq((select count(*) from public.attendance_day_marks), 1, 'employee sees only the day marks of own days');
select pg_temp.assert_eq((select count(*) from public.attendance_day_marks where employee_id = '0a000000-0000-0000-0000-0000000000e2'), 0, 'a manager relationship without a team key reveals no day marks');
select pg_temp.assert_raises($q$ insert into public.attendance_day_marks (organization_id, employee_id, attendance_date, branch_id, kind, pay_effect_days, source, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '2026-09-02', '0a000000-0000-0000-0000-00000000000c', 'EXCUSED', 0, 'HR', 'test') $q$, 'employee cannot excuse own day');
select pg_temp.assert_raises($q$ update public.attendance_day_marks set revoked_at = now(), revoke_reason = 'Not me' where id = '0a000000-0000-0000-0000-0000000002a3' $q$, 'employee cannot revoke a mark on own day');
-- self-service leave (migration 20260927000100)
select pg_temp.assert_eq((select count(*) from public.leave_types), 1, 'employee sees active leave types only');
select pg_temp.assert_eq((select count(*) from public.leave_records), 2, 'employee sees only own leave');
-- leave v2 review P2-10 (migration 20260928000850): no direct self-service insert; the API validates a request and writes it in the system context
select pg_temp.assert_raises($q$ insert into public.leave_records (organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, status, created_by, reason)
  values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000001a1', '2026-11-01', '2026-11-02', 'PENDING', 'a0000000-0000-0000-0000-000000000003', 'Trip') $q$, 'employee cannot insert own leave directly, even PENDING (creates go through the API)');
select pg_temp.assert_raises($q$ insert into public.leave_records (organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, status, created_by)
  values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000001a1', '2026-11-08', '2026-11-08', 'APPROVED', 'a0000000-0000-0000-0000-000000000003') $q$, 'employee cannot insert approved leave');
select pg_temp.assert_raises($q$ insert into public.leave_records (organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, status, created_by)
  values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-0000000001a1', '2026-11-08', '2026-11-08', 'PENDING', 'a0000000-0000-0000-0000-000000000003') $q$, 'employee cannot request leave for someone else');
select pg_temp.assert_raises($q$ insert into public.leave_records (organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, status, created_by)
  values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-0000000001a1', '2026-11-08', '2026-11-08', 'PENDING', 'a0000000-0000-0000-0000-000000000003') $q$, 'employee cannot file leave on another branch');
select pg_temp.assert_raises($q$ update public.leave_records set status = 'APPROVED' where id = '0a000000-0000-0000-0000-0000000001b3' $q$, 'employee cannot approve own request');
select pg_temp.assert_raises($q$ update public.leave_records set status = 'CANCELLED', end_date = '2026-10-30' where id = '0a000000-0000-0000-0000-0000000001b3' $q$, 'self-cancel cannot change other columns');
select pg_temp.assert_raises($q$ update public.leave_records set status = 'CANCELLED' where id = '0a000000-0000-0000-0000-0000000001b4' $q$, 'employee cannot cancel approved leave');
select pg_temp.assert_raises($q$ update public.leave_records set status = 'CANCELLED' where id = '0a000000-0000-0000-0000-0000000001b1' $q$, 'employee cannot cancel someone else''s request');
select pg_temp.assert_raises($q$ update public.leave_records set status = 'CANCELLED' where id = '0a000000-0000-0000-0000-0000000001b3' $q$, 'employee cannot withdraw own pending request directly: the API withdraws it in its system step and cancels its approval request (security gate 20260928001100)');
select pg_temp.assert_rows($q$ insert into public.attendance_corrections (organization_id, employee_id, branch_id, attendance_date, type, proposed_punched_at, reason, requested_by, status)
  values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '2026-09-01', 'ADD_PUNCH', '2026-09-01 04:00+00', 'Forgot to punch', 'a0000000-0000-0000-0000-000000000003', 'PENDING') $q$, 1, 'employee may request a correction for own day');
select pg_temp.assert_raises($q$ insert into public.attendance_corrections (organization_id, employee_id, branch_id, attendance_date, type, proposed_punched_at, reason, requested_by, status)
  values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '2026-09-01', 'ADD_PUNCH', '2026-09-01 04:00+00', 'Not mine', 'a0000000-0000-0000-0000-000000000003', 'PENDING') $q$, 'employee cannot request a correction for someone else');
select pg_temp.assert_raises($q$ insert into public.attendance_corrections (organization_id, employee_id, branch_id, attendance_date, type, proposed_punched_at, reason, requested_by, status)
  values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '2026-09-01', 'ADD_PUNCH', '2026-09-01 05:00+00', 'Pre-approved', 'a0000000-0000-0000-0000-000000000003', 'APPROVED') $q$, 'employee cannot insert an approved correction');
rollback;

-- ---------- as Line Manager A (role manager, linked to e4 = primary manager of e1) — migration 20260928000100 ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
select pg_temp.assert_eq((select cardinality(app.team_employee_ids())), 1, 'manager: exactly one direct report');
select pg_temp.assert_eq((select count(*) from unnest(app.team_employee_ids()) t where t = '0a000000-0000-0000-0000-0000000000e1'), 1, 'manager: the direct report is e1');
select pg_temp.assert_eq((select cardinality(app.team_employee_ids_deep())), 2, 'manager: chain to depth 5 = e1 + e6 (report of a report)');
select pg_temp.assert_eq((select count(*) from unnest(app.team_employee_ids_deep()) t where t = '0a000000-0000-0000-0000-0000000000e6'), 1, 'manager: deep chain reaches e6');
select pg_temp.assert_eq((select count(*) from public.attendance_daily_records), 2, 'manager sees own record + the report''s (no organisation-wide attendance.view)');
select pg_temp.assert_eq((select count(*) from public.attendance_daily_records where employee_id = '0a000000-0000-0000-0000-0000000000e1'), 1, 'manager reads the report''s daily record');
select pg_temp.assert_eq((select count(*) from public.attendance_daily_records where employee_id = '0a000000-0000-0000-0000-0000000000e2'), 0, 'manager cannot read a non-report''s daily record');
select pg_temp.assert_eq((select count(*) from public.attendance_daily_records where employee_id = '0a000000-0000-0000-0000-0000000000e6'), 0, 'a report of a report is NOT visible (direct reports only)');
select pg_temp.assert_eq((select count(*) from public.leave_records), 1, 'manager sees the report''s leave only (leave.view_team)');
select pg_temp.assert_eq((select count(*) from public.leave_records where employee_id = '0a000000-0000-0000-0000-0000000000e1'), 1, 'manager reads the report''s leave record');
select pg_temp.assert_eq((select count(*) from public.employees), 2, 'manager directory = own row + the direct report (employee.view_team, no organisation-wide employee.view)');
select pg_temp.assert_eq((select count(*) from public.employees where id in ('0a000000-0000-0000-0000-0000000000e4', '0a000000-0000-0000-0000-0000000000e1')), 2, 'manager reads own employee row and the report''s');
select pg_temp.assert_eq((select count(*) from public.employees where id = '0a000000-0000-0000-0000-0000000000e2'), 0, 'manager cannot read a non-report''s employee row');
select pg_temp.assert_eq((select count(*) from public.employees where id = '0a000000-0000-0000-0000-0000000000e6'), 0, 'manager cannot read a report of a report''s employee row');
select pg_temp.assert_eq((select count(*) from public.devices), 0, 'manager has no device.view');
select pg_temp.assert_rows($q$ update public.employees set display_name = 'x' where id = '0a000000-0000-0000-0000-0000000000e1' $q$, 0, 'manager cannot edit the report''s master record (no employee.update)');
select pg_temp.assert_raises($q$ update public.attendance_daily_records set status = 'ABSENT' where employee_id = '0a000000-0000-0000-0000-0000000000e1' $q$, 'manager cannot write daily records');
select pg_temp.assert_raises($q$ update public.leave_records set status = 'APPROVED' where id = '0a000000-0000-0000-0000-0000000001b1' $q$, 'manager cannot approve leave through RLS (leave.approve is enforced by the API/engine, leave.manage by RLS)');
select pg_temp.assert_eq((select count(*) from public.attendance_day_marks), 1, 'manager sees the day marks of the direct report only (attendance.view_team)');
select pg_temp.assert_eq((select count(*) from public.attendance_day_marks where employee_id = '0a000000-0000-0000-0000-0000000000e1'), 1, 'manager reads the report''s day mark');
select pg_temp.assert_eq((select count(*) from public.attendance_day_marks where employee_id in ('0a000000-0000-0000-0000-0000000000e2', '0a000000-0000-0000-0000-0000000000e3')), 0, 'manager cannot read a non-report''s day marks');
select pg_temp.assert_raises($q$ insert into public.attendance_day_marks (organization_id, employee_id, attendance_date, branch_id, kind, pay_effect_days, source, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '2026-09-02', '0a000000-0000-0000-0000-00000000000b', 'EXCUSED', 0, 'HR', 'test') $q$, 'manager (attendance.approve) cannot write the report''s day mark directly; the API checks the direct-report rule and writes it');
rollback;

-- ---------- as Secondary Manager A (role manager, linked to e5 = secondary manager of e1) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000006","role":"authenticated"}', true);
select pg_temp.assert_eq((select cardinality(app.team_employee_ids())), 1, 'secondary manager: exactly one direct report');
select pg_temp.assert_eq((select count(*) from public.attendance_daily_records), 2, 'secondary manager sees own record + the report''s');
select pg_temp.assert_eq((select count(*) from public.attendance_daily_records where employee_id = '0a000000-0000-0000-0000-0000000000e1'), 1, 'secondary manager reads the report''s daily record');
select pg_temp.assert_eq((select count(*) from public.attendance_daily_records where employee_id = '0a000000-0000-0000-0000-0000000000e2'), 0, 'secondary manager cannot read a non-report''s daily record');
select pg_temp.assert_eq((select count(*) from public.leave_records where employee_id = '0a000000-0000-0000-0000-0000000000e1'), 1, 'secondary manager reads the report''s leave');
select pg_temp.assert_eq((select count(*) from public.leave_records where employee_id = '0a000000-0000-0000-0000-0000000000e3'), 0, 'secondary manager cannot read a non-report''s leave');
select pg_temp.assert_eq((select count(*) from public.attendance_day_marks), 1, 'secondary manager sees the report''s day mark only');
select pg_temp.assert_eq((select count(*) from public.employees), 2, 'secondary manager directory = own row + the report (secondary link)');
rollback;

-- ---------- offboarding (review fix 20260928000150): employees who left drop out of every team ----------
-- a report who is archived or terminated leaves the team of both managers (their rows go with them)
begin;
update public.employees set deleted_at = now() where id = '0a000000-0000-0000-0000-0000000000e1';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
select pg_temp.assert_eq((select cardinality(app.team_employee_ids())), 0, 'an archived report leaves the team');
select pg_temp.assert_eq((select count(*) from public.attendance_daily_records where employee_id = '0a000000-0000-0000-0000-0000000000e1'), 0, 'the archived report''s daily records leave with them');
select pg_temp.assert_eq((select count(*) from public.employees), 1, 'manager directory shrinks to the own row');
rollback;
begin;
update public.employees set employment_status = 'terminated' where id = '0a000000-0000-0000-0000-0000000000e1';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000006","role":"authenticated"}', true);
select pg_temp.assert_eq((select cardinality(app.team_employee_ids())), 0, 'a terminated report leaves the secondary manager''s team too');
select pg_temp.assert_eq((select count(*) from public.leave_records where employee_id = '0a000000-0000-0000-0000-0000000000e1'), 0, 'the terminated report''s leave is no longer a team row');
rollback;
-- a manager who left (login not suspended, e.g. missed) has no team at all: team, deep chain and snapshot are empty
begin;
select pg_temp.assert_eq((select jsonb_array_length(app.principal_snapshot('a0000000-0000-0000-0000-000000000005') -> 'memberships' -> 0 -> 'teamEmployeeIds')), 1, 'snapshot: the manager has one direct report');
update public.employees set employment_status = 'terminated' where id = '0a000000-0000-0000-0000-0000000000e4';
select pg_temp.assert_eq((select jsonb_array_length(app.principal_snapshot('a0000000-0000-0000-0000-000000000005') -> 'memberships' -> 0 -> 'teamEmployeeIds')), 0, 'snapshot: a terminated manager has no team');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
select pg_temp.assert_eq((select cardinality(app.team_employee_ids())), 0, 'a terminated manager''s team is empty');
select pg_temp.assert_eq((select cardinality(app.team_employee_ids_deep())), 0, 'a terminated manager''s reporting chain is empty');
select pg_temp.assert_eq((select count(*) from public.attendance_daily_records where employee_id = '0a000000-0000-0000-0000-0000000000e1'), 0, 'a terminated manager reads none of the report''s rows');
select pg_temp.assert_eq((select count(*) from public.employees where id = '0a000000-0000-0000-0000-0000000000e1'), 0, 'a terminated manager cannot read the report''s employee row');
rollback;
begin;
update public.employees set deleted_at = now() where id = '0a000000-0000-0000-0000-0000000000e5';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000006","role":"authenticated"}', true);
select pg_temp.assert_eq((select cardinality(app.team_employee_ids())), 0, 'an archived manager''s team is empty');
select pg_temp.assert_eq((select count(*) from public.leave_records where employee_id = '0a000000-0000-0000-0000-0000000000e1'), 0, 'an archived manager reads none of the report''s leave');
rollback;

-- ---------- reporting-line cycle guard (trigger employees_no_manager_cycle) ----------
begin;
select pg_temp.assert_check_violation($q$ update public.employees set manager_employee_id = '0a000000-0000-0000-0000-0000000000e1' where id = '0a000000-0000-0000-0000-0000000000e4' $q$, 'employees_no_manager_cycle', 'e4 cannot report to e1, who reports to e4');
select pg_temp.assert_check_violation($q$ update public.employees set secondary_manager_employee_id = '0a000000-0000-0000-0000-0000000000e6' where id = '0a000000-0000-0000-0000-0000000000e4' $q$, 'employees_no_manager_cycle', 'a loop two levels up through a secondary link is refused (e6 -> e1 -> e4)');
select pg_temp.assert_check_violation($q$ update public.employees set manager_employee_id = id where id = '0a000000-0000-0000-0000-0000000000e2' $q$, 'employees_no_manager_cycle', 'nobody is their own manager');
select pg_temp.assert_check_violation($q$ insert into public.employees (id, organization_id, employee_number, first_name, last_name, display_name, joining_date, branch_id, device_user_id, manager_employee_id)
  values ('0a000000-0000-0000-0000-0000000000e9', '0a000000-0000-0000-0000-000000000000', 'A-009', 'Self', 'Loop', 'Self Loop', '2025-01-01', '0a000000-0000-0000-0000-00000000000b', '9', '0a000000-0000-0000-0000-0000000000e9') $q$, 'employees_no_manager_cycle', 'an inserted row cannot name itself as manager');
select pg_temp.assert_rows($q$ update public.employees set manager_employee_id = '0a000000-0000-0000-0000-0000000000e5' where id = '0a000000-0000-0000-0000-0000000000e4' $q$, 1, 'a link that closes no loop is accepted');
select pg_temp.assert_check_violation($q$ update public.employees set manager_employee_id = '0a000000-0000-0000-0000-0000000000e4' where id = '0a000000-0000-0000-0000-0000000000e5' $q$, 'employees_no_manager_cycle', '...and the reverse link is then refused');
rollback;
-- a loop that predates the guard never blocks an unrelated update (unchanged links are not re-walked)
begin;
set local session_replication_role = replica;
update public.employees set manager_employee_id = '0a000000-0000-0000-0000-0000000000e2' where id = '0a000000-0000-0000-0000-0000000000e3';
set local session_replication_role = origin;
select pg_temp.assert_rows($q$ update public.employees set display_name = 'Self Service II' where id = '0a000000-0000-0000-0000-0000000000e3' $q$, 1, 'legacy loop: an unrelated column updates');
select pg_temp.assert_rows($q$ update public.employees set manager_employee_id = '0a000000-0000-0000-0000-0000000000e2' where id = '0a000000-0000-0000-0000-0000000000e3' $q$, 1, 'legacy loop: re-writing the unchanged link passes');
select pg_temp.assert_rows($q$ update public.employees set secondary_manager_employee_id = '0a000000-0000-0000-0000-0000000000e5' where id = '0a000000-0000-0000-0000-0000000000e3' $q$, 1, 'legacy loop: a new link that closes no loop passes');
rollback;

-- ---------- session revocation (app.revoke_user_sessions) ----------
begin;
-- the local shim has no Supabase Auth tables; this is the shape the function deletes from
create table if not exists auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null);
insert into auth.sessions (user_id) values ('a0000000-0000-0000-0000-000000000005'), ('a0000000-0000-0000-0000-000000000005'), ('b0000000-0000-0000-0000-000000000001');
select pg_temp.assert_eq((select (not has_function_privilege('authenticated', 'app.revoke_user_sessions(uuid[])', 'execute') and not has_function_privilege('flowza_api', 'app.revoke_user_sessions(uuid[])', 'execute')
  and has_function_privilege('flowza_system', 'app.revoke_user_sessions(uuid[])', 'execute'))::int), 1, 'only flowza_system may execute revoke_user_sessions');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_raises($q$ select app.revoke_user_sessions(array['a0000000-0000-0000-0000-000000000005']::uuid[]) $q$, 'a user session cannot end anybody''s sessions');
reset role;
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system"}', true);
select pg_temp.assert_raises($q$ select app.revoke_user_sessions(array['a0000000-0000-0000-0000-000000000005']::uuid[]) $q$, 'system context without an organisation is refused');
select set_config('request.jwt.claims', '{"role":"flowza_system","org_id":"0a000000-0000-0000-0000-000000000000"}', true);
select pg_temp.assert_eq(app.revoke_user_sessions(array['a0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000001']::uuid[]), 2, 'org A''s system context ends the sessions of org A''s member only');
reset role;
select pg_temp.assert_eq((select count(*) from auth.sessions where user_id = 'b0000000-0000-0000-0000-000000000001'), 1, 'a user who is not a member of org A keeps their session');
select pg_temp.assert_eq((select count(*) from auth.sessions where user_id = 'a0000000-0000-0000-0000-000000000005'), 0, 'the member''s sessions are gone');
rollback;

-- ---------- as Auditor A (role auditor: read-only, no employee link) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000007","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.employees), 6, 'auditor reads every employee');
select pg_temp.assert_eq((select count(*) from public.attendance_daily_records), 6, 'auditor reads every daily record');
select pg_temp.assert_eq((select count(*) from public.leave_records), 3, 'auditor reads every leave record');
select pg_temp.assert_eq((select count(*) from public.organizations), 1, 'auditor reads the organisation');
select pg_temp.assert_eq((select count(*) from public.devices), 0, 'auditor has no device.view');
select pg_temp.assert_eq((select count(*) from public.employee_identity_documents), 0, 'auditor has no employee.view_sensitive');
select pg_temp.assert_rows($q$ update public.employees set display_name = 'x' where id = '0a000000-0000-0000-0000-0000000000e1' $q$, 0, 'auditor cannot update employees');
select pg_temp.assert_raises($q$ insert into public.employees (organization_id, employee_number, first_name, last_name, display_name, joining_date, branch_id, device_user_id) values ('0a000000-0000-0000-0000-000000000000','A-010','x','x','x','2025-01-01','0a000000-0000-0000-0000-00000000000b','10') $q$, 'auditor cannot create employees');
select pg_temp.assert_rows($q$ delete from public.employees where id = '0a000000-0000-0000-0000-0000000000e1' $q$, 0, 'auditor cannot delete employees');
select pg_temp.assert_raises($q$ insert into public.leave_records (organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, status, created_by)
  values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-0000000001a1', '2026-12-01', '2026-12-02', 'PENDING', 'a0000000-0000-0000-0000-000000000007') $q$, 'auditor cannot record leave');
select pg_temp.assert_raises($q$ update public.leave_records set status = 'APPROVED' where id = '0a000000-0000-0000-0000-0000000001b1' $q$, 'auditor cannot approve leave');
select pg_temp.assert_raises($q$ delete from public.leave_records where id = '0a000000-0000-0000-0000-0000000001b1' $q$, 'auditor cannot delete leave');
select pg_temp.assert_raises($q$ insert into public.attendance_corrections (organization_id, employee_id, branch_id, attendance_date, type, proposed_punched_at, reason, requested_by, status)
  values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '2026-09-01', 'ADD_PUNCH', '2026-09-01 04:00+00', 'Audit note', 'a0000000-0000-0000-0000-000000000007', 'PENDING') $q$, 'auditor cannot file corrections');
select pg_temp.assert_raises($q$ update public.attendance_daily_records set status = 'ABSENT' where organization_id = '0a000000-0000-0000-0000-000000000000' $q$, 'auditor cannot write daily records');
select pg_temp.assert_raises($q$ insert into public.shifts (organization_id, code, name, type, start_time, end_time) values ('0a000000-0000-0000-0000-000000000000', 'AUD', 'Audit shift', 'FIXED', '08:00', '17:00') $q$, 'auditor cannot create shifts');
select pg_temp.assert_rows($q$ update public.organizations set display_name = 'x' where id = '0a000000-0000-0000-0000-000000000000' $q$, 0, 'auditor cannot edit the organisation');
select pg_temp.assert_rows($q$ update public.org_memberships set role_id = '10000000-0000-0000-0000-000000000001' where id = '0a000000-0000-0000-0000-0000000000a7' $q$, 0, 'auditor cannot promote themselves');
select pg_temp.assert_eq((select count(*) from public.attendance_day_marks), 3, 'auditor reads every day mark');
select pg_temp.assert_raises($q$ insert into public.attendance_day_marks (organization_id, employee_id, attendance_date, branch_id, kind, pay_effect_days, source, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '2026-09-02', '0a000000-0000-0000-0000-00000000000b', 'EXCUSED', 0, 'HR', 'test') $q$, 'auditor cannot mark days');
select pg_temp.assert_raises($q$ update public.attendance_day_marks set revoked_at = now(), revoke_reason = 'audit' where id = '0a000000-0000-0000-0000-0000000002a1' $q$, 'auditor cannot revoke marks');
select pg_temp.assert_raises($q$ delete from public.attendance_day_marks where organization_id = '0a000000-0000-0000-0000-000000000000' $q$, 'auditor cannot delete marks');
rollback;

-- ---------- security gate (20260928001100): no privilege escalation through memberships, their branches and invitations ----------
-- An organisation admin (org_admin: user.manage and every key but one, all branches, not an owner), a branch-restricted
-- administrator (a custom role: user.view + user.manage + the employee role's keys, restricted to A-2) and a user with no
-- membership yet. Everything is rolled back.
begin;
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-0000000000b1', 'admin-a@test.local'),
  ('a0000000-0000-0000-0000-0000000000b2', 'radmin-a@test.local'),
  ('a0000000-0000-0000-0000-0000000000b3', 'new-a@test.local');
insert into public.user_profiles (id, email, full_name) values
  ('a0000000-0000-0000-0000-0000000000b1', 'admin-a@test.local', 'Admin A'),
  ('a0000000-0000-0000-0000-0000000000b2', 'radmin-a@test.local', 'Branch Admin A'),
  ('a0000000-0000-0000-0000-0000000000b3', 'new-a@test.local', 'New A');
insert into public.roles (id, organization_id, key, name) values ('0a000000-0000-0000-0000-0000000009f1', '0a000000-0000-0000-0000-000000000000', 'branch_admin', 'Branch admin');
set local session_replication_role = replica; -- fixture only: the role-definition guard needs a user who holds the keys
insert into public.role_permissions (role_id, permission_key)
  select '0a000000-0000-0000-0000-0000000009f1', k from (select 'user.view' as k union select 'user.manage' union select rp.permission_key from public.role_permissions rp where rp.role_id = '10000000-0000-0000-0000-000000000008') s;
set local session_replication_role = origin;
insert into public.org_memberships (id, organization_id, user_id, role_id, status, all_branches) values
  ('0a000000-0000-0000-0000-0000000009b1', '0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-0000000000b1', '10000000-0000-0000-0000-000000000002', 'active', true),
  ('0a000000-0000-0000-0000-0000000009b2', '0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-0000000000b2', '0a000000-0000-0000-0000-0000000009f1', 'active', false);
insert into public.membership_branches (membership_id, branch_id) values ('0a000000-0000-0000-0000-0000000009b2', '0a000000-0000-0000-0000-00000000000c');
-- the organisation admin
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
select pg_temp.assert_raises($q$ update public.org_memberships set role_id = '10000000-0000-0000-0000-000000000001' where id = '0a000000-0000-0000-0000-0000000009b1' $q$, '10-S5 an admin cannot make themselves owner');
select pg_temp.assert_raises($q$ update public.org_memberships set employee_id = '0a000000-0000-0000-0000-0000000000e1' where id = '0a000000-0000-0000-0000-0000000009b1' $q$, '10-S5 an admin cannot link their own login to a colleague''s employee record (their reports and self-service rows)');
select pg_temp.assert_raises($q$ delete from public.org_memberships where id = '0a000000-0000-0000-0000-0000000009b1' $q$, '10-S5 an admin cannot remove their own membership');
select pg_temp.assert_raises($q$ update public.org_memberships set role_id = '10000000-0000-0000-0000-000000000001' where id = '0a000000-0000-0000-0000-0000000000a3' $q$, '10-S5 only an owner grants the owner role');
select pg_temp.assert_raises($q$ update public.org_memberships set status = 'suspended' where id = '0a000000-0000-0000-0000-0000000000a1' $q$, '10-S5 only an owner changes an owner''s membership');
select pg_temp.assert_raises($q$ delete from public.org_memberships where id = '0a000000-0000-0000-0000-0000000000a1' $q$, '10-S5 only an owner removes an owner');
select pg_temp.assert_raises($q$ insert into public.org_memberships (organization_id, user_id, role_id, status, all_branches) values ('0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-0000000000b3', '10000000-0000-0000-0000-000000000001', 'invited', true) $q$, '10-S5 an admin cannot seat a new owner');
select pg_temp.assert_raises($q$ insert into public.invitations (organization_id, email, role_id, all_branches, token_hash, expires_at) values ('0a000000-0000-0000-0000-000000000000', 'new-a@test.local', '10000000-0000-0000-0000-000000000001', true, repeat('b', 64), now() + interval '7 days') $q$, '10-S5 an admin cannot invite an owner');
select pg_temp.assert_rows($q$ update public.org_memberships set role_id = '10000000-0000-0000-0000-000000000004' where id = '0a000000-0000-0000-0000-0000000000a3' $q$, 1, '10-S5 control: an admin changes a member''s role to one they hold every key of');
select pg_temp.assert_rows($q$ insert into public.invitations (organization_id, email, role_id, all_branches, token_hash, expires_at) values ('0a000000-0000-0000-0000-000000000000', 'new-a@test.local', '10000000-0000-0000-0000-000000000003', true, repeat('c', 64), now() + interval '7 days') $q$, 1, '10-S5 control: an admin invites an HR admin with all branches');
-- the branch-restricted administrator
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
select pg_temp.assert_raises($q$ insert into public.org_memberships (organization_id, user_id, role_id, status, all_branches) values ('0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-0000000000b3', '10000000-0000-0000-0000-000000000002', 'invited', false) $q$, '10-S5 a role carrying keys the writer lacks cannot be handed out');
select pg_temp.assert_raises($q$ insert into public.org_memberships (organization_id, user_id, role_id, status, all_branches) values ('0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-0000000000b3', '10000000-0000-0000-0000-000000000008', 'invited', true) $q$, '10-S5 a branch-restricted administrator cannot grant all branches');
select pg_temp.assert_rows($q$ insert into public.org_memberships (id, organization_id, user_id, role_id, status, all_branches) values ('0a000000-0000-0000-0000-0000000009b3', '0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-0000000000b3', '10000000-0000-0000-0000-000000000008', 'invited', false) $q$, 1, '10-S5 control: a branch-restricted administrator seats an employee');
select pg_temp.assert_raises($q$ insert into public.membership_branches (membership_id, branch_id) values ('0a000000-0000-0000-0000-0000000009b3', '0a000000-0000-0000-0000-00000000000b') $q$, '10-S5 ...but never on a branch outside their own scope');
select pg_temp.assert_rows($q$ insert into public.membership_branches (membership_id, branch_id) values ('0a000000-0000-0000-0000-0000000009b3', '0a000000-0000-0000-0000-00000000000c') $q$, 1, '10-S5 control: ...on their own branch');
select pg_temp.assert_raises($q$ insert into public.membership_branches (membership_id, branch_id) values ('0a000000-0000-0000-0000-0000000009b2', '0a000000-0000-0000-0000-00000000000b') $q$, '10-S5 nobody widens their own branch scope beyond it');
select pg_temp.assert_raises($q$ update public.org_memberships set all_branches = true where id = '0a000000-0000-0000-0000-0000000009b3' $q$, '10-S5 a branch-restricted administrator cannot widen a member to all branches');
select pg_temp.assert_raises($q$ insert into public.invitations (organization_id, email, role_id, all_branches, token_hash, expires_at) values ('0a000000-0000-0000-0000-000000000000', 'new-a@test.local', '10000000-0000-0000-0000-000000000008', true, repeat('d', 64), now() + interval '7 days') $q$, '10-S5 a branch-restricted administrator cannot invite with all branches');
select pg_temp.assert_raises($q$ insert into public.invitations (organization_id, email, role_id, all_branches, branch_ids, token_hash, expires_at) values ('0a000000-0000-0000-0000-000000000000', 'new-a@test.local', '10000000-0000-0000-0000-000000000008', false, array['0a000000-0000-0000-0000-00000000000b']::uuid[], repeat('e', 64), now() + interval '7 days') $q$, '10-S5 ...nor on a branch outside their scope');
select pg_temp.assert_rows($q$ insert into public.invitations (organization_id, email, role_id, all_branches, branch_ids, token_hash, expires_at) values ('0a000000-0000-0000-0000-000000000000', 'new-a@test.local', '10000000-0000-0000-0000-000000000008', false, array['0a000000-0000-0000-0000-00000000000c']::uuid[], repeat('f', 64), now() + interval '7 days') $q$, 1, '10-S5 control: a branch-restricted administrator invites on their own branch');
-- the owner
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_rows($q$ update public.org_memberships set employee_id = '0a000000-0000-0000-0000-0000000000e6' where id = '0a000000-0000-0000-0000-0000000000a1' $q$, 1, '10-S5 control: an owner links their own login to an employee record');
select pg_temp.assert_rows($q$ update public.org_memberships set role_id = '10000000-0000-0000-0000-000000000001' where id = '0a000000-0000-0000-0000-0000000009b1' $q$, 1, '10-S5 control: an owner promotes an admin to owner');
select pg_temp.assert_rows($q$ update public.org_memberships set role_id = '10000000-0000-0000-0000-000000000002' where id = '0a000000-0000-0000-0000-0000000000a1' $q$, 1, '10-S5 control: an owner may step down (a change about oneself only keeps or reduces access; the API keeps one active owner)');
-- the organisation's system context (invitation acceptance, offboarding) acts for an already-authorised caller
reset role;
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system","org_id":"0a000000-0000-0000-0000-000000000000"}', true);
select pg_temp.assert_rows($q$ update public.org_memberships set role_id = '10000000-0000-0000-0000-000000000003', status = 'active' where id = '0a000000-0000-0000-0000-0000000009b3' $q$, 1, '10-S5 control: the system context accepts an invitation (not a user write)');
rollback;

-- ---------- as Owner B ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.employees), 1, 'owner B sees 1 employee');
select pg_temp.assert_eq((select count(*) from public.attendance_daily_records where organization_id = '0a000000-0000-0000-0000-000000000000'), 0, 'owner B cannot see org A attendance');
select pg_temp.assert_eq((select count(*) from public.org_memberships), 1, 'owner B sees only own memberships');
select pg_temp.assert_eq((select count(*) from public.attendance_day_marks), 1, 'owner B sees only own day marks');
select pg_temp.assert_eq((select count(*) from public.attendance_day_marks where organization_id = '0a000000-0000-0000-0000-000000000000'), 0, 'owner B cannot see org A day marks (cross-tenant zero)');
select pg_temp.assert_raises($q$ insert into public.attendance_day_marks (organization_id, employee_id, attendance_date, branch_id, kind, pay_effect_days, source, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '2026-09-02', '0a000000-0000-0000-0000-00000000000b', 'EXCUSED', 0, 'HR', 'test') $q$, 'owner B cannot mark a day in org A');
select pg_temp.assert_raises($q$ update public.attendance_day_marks set revoked_at = now(), revoke_reason = 'x' where organization_id = '0a000000-0000-0000-0000-000000000000' $q$, 'owner B cannot revoke org A marks');
select pg_temp.assert_eq((select count(*) from public.finance_sync_state), 1, 'owner B sees only own connector state');
select pg_temp.assert_eq((select count(*) from public.finance_sync_state where organization_id = '0a000000-0000-0000-0000-000000000000'), 0, 'owner B cannot see org A connector state');
select pg_temp.assert_eq((select count(*) from public.finance_pushed_events), 1, 'owner B sees only own push ledger');
select pg_temp.assert_eq((select count(*) from public.finance_pushed_events where organization_id = '0a000000-0000-0000-0000-000000000000'), 0, 'owner B cannot see org A push ledger');
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
select pg_temp.assert_eq((select count(*) from public.employees), 6, 'platform admin WITH grant sees org A employees');
select pg_temp.assert_eq((select count(*) from public.employees where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'grant does not extend to org B');
select pg_temp.assert_rows($q$ update public.employees set display_name = 'x' where id = '0a000000-0000-0000-0000-0000000000e1' $q$, 0, 'read grant cannot write');
select pg_temp.assert_eq((select count(*) from public.attendance_day_marks), 3, 'platform admin WITH a read grant reads org A day marks');
select pg_temp.assert_raises($q$ insert into public.attendance_day_marks (organization_id, employee_id, attendance_date, branch_id, kind, pay_effect_days, source, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '2026-09-02', '0a000000-0000-0000-0000-00000000000b', 'EXCUSED', 0, 'HR', 'test') $q$, 'a read grant cannot mark days');
rollback;

-- ---------- user limit (20261001000300): counts only — platform admins and the organisation's own system context ----------
begin;
insert into public.subscriptions (organization_id, plan_id, status, seats)
  select '0a000000-0000-0000-0000-000000000000', p.id, 'active', 7 from public.plans p where p.key = 'professional'
  on conflict (organization_id) do update set plan_id = excluded.plan_id, status = 'active', seats = 7;
select set_config('test.ul_used', (select count(*)::text from public.employees where organization_id = '0a000000-0000-0000-0000-000000000000'
  and deleted_at is null and employment_status not in ('terminated', 'resigned')), true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from app.org_user_limits(array['0a000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-000000000000']::uuid[])), 0,
  'user limit: a member (even the owner) reads none directly — the API answers it after a permission check');
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from app.org_user_limits(array['0a000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-000000000000']::uuid[])), 2,
  'user limit: a platform admin reads every organisation asked for');
select pg_temp.assert_eq((select count(*) from app.org_user_limits(array['0a000000-0000-0000-0000-000000000000']::uuid[]) u
  where u.user_limit = 7 and u.limit_source = 'seats' and u.used = current_setting('test.ul_used')::bigint), 1,
  'user limit: the seats set by the platform are the limit; used = active employees');
reset role;
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system","org_id":"0a000000-0000-0000-0000-000000000000"}', true);
select pg_temp.assert_eq((select count(*) from app.org_user_limits(array['0a000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-000000000000']::uuid[]) u
  where u.organization_id = '0a000000-0000-0000-0000-000000000000'), 1, 'user limit: the system context reads its own organisation');
select pg_temp.assert_eq((select count(*) from app.org_user_limits(array['0b000000-0000-0000-0000-000000000000']::uuid[])), 0,
  'user limit: the system context of org A never reads org B');
rollback;
