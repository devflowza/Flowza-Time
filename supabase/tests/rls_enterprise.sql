-- Enterprise: shift requests, round-the-clock scheduling, global attendance policies (migration 20261007000100,
-- docs/enterprise/plan.md). Runs as superuser AFTER rls_isolation.sql (it reuses that suite's organisations, branches,
-- employees, logins and roles):
--   Org A: branches A-HQ, A-2 (+ A-3 created here); owner-a (all branches), bm-a (branch manager, A-2 only), emp-a (employee
--          role, linked to e3 in A-2), manager-a (line manager of e1, HQ), auditor-a (read-only). Org B: owner-b.
-- Self-contained: every block inserts its fixtures through pg_temp.fixtures() and rolls back.
-- Rules under test:
--   * every new table isolates tenants, honours the branch scope where it has a branch column, and its constraints hold
--     (one group per employee and day, no overlapping additional shifts, one pending change request of a kind per day, no
--     overlapping active deployments, one policy per scope and day, no cross-tenant reference);
--   * shift change requests and branch deployments are written by the system context only (no client privilege, three
--     explicit denials); the employee reads their own rows, a line manager their team's change requests;
--   * a deployment is readable in the HOST branch scope and in the HOME branch scope;
--   * the Enterprise modules are in the enterprise plan only.
\set QUIET on
\set ON_ERROR_STOP on
set client_min_messages = warning;
create or replace function pg_temp.assert_eq(actual bigint, expected bigint, label text) returns void language plpgsql as $$
begin
  if actual is distinct from expected then raise exception 'ASSERT FAILED: % — expected %, got %', label, expected, actual; end if;
end $$;
create or replace function pg_temp.assert_rows(sqltext text, expected bigint, label text) returns void language plpgsql as $$
declare n bigint;
begin
  execute sqltext; get diagnostics n = row_count;
  if n <> expected then raise exception 'ASSERT FAILED: % — expected % affected rows, got %', label, expected, n; end if;
end $$;
create or replace function pg_temp.assert_raises(sqltext text, label text) returns void language plpgsql as $$
begin
  begin
    execute sqltext;
  exception when others then
    return;
  end;
  raise exception 'ASSERT FAILED: % — expected an error', label;
end $$;
create or replace function pg_temp.assert_sqlstate(sqltext text, expected_state text, label text) returns void language plpgsql as $$
declare v_state text;
begin
  begin
    execute sqltext;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> expected_state then raise exception 'ASSERT FAILED: % — expected SQLSTATE %, got %', label, expected_state, v_state; end if;
    return;
  end;
  raise exception 'ASSERT FAILED: % — expected SQLSTATE %', label, expected_state;
end $$;

-- fixtures (as superuser, inside the caller's transaction)
create or replace function pg_temp.fixtures() returns void language plpgsql as $$
begin
  insert into public.branches (id, organization_id, code, name) values
    ('0a000000-0000-0000-0000-0000000000f3', '0a000000-0000-0000-0000-000000000000', 'A-3', 'A Branch 3');
  insert into public.shifts (id, organization_id, code, name, type, start_time, end_time) values
    ('0a000000-0000-0000-0000-000000000e51', '0a000000-0000-0000-0000-000000000000', 'E-M', 'Morning', 'FIXED', '06:00', '14:00'),
    ('0a000000-0000-0000-0000-000000000e52', '0a000000-0000-0000-0000-000000000000', 'E-E', 'Evening', 'FIXED', '18:00', '22:00'),
    ('0b000000-0000-0000-0000-000000000e51', '0b000000-0000-0000-0000-000000000000', 'E-M', 'Morning', 'FIXED', '06:00', '14:00');
  insert into public.employee_groups (id, organization_id, code, name) values
    ('0a000000-0000-0000-0000-000000000e61', '0a000000-0000-0000-0000-000000000000', 'OFFICE', 'Office staff'),
    ('0a000000-0000-0000-0000-000000000e62', '0a000000-0000-0000-0000-000000000000', 'FIELD', 'Field staff'),
    ('0b000000-0000-0000-0000-000000000e61', '0b000000-0000-0000-0000-000000000000', 'OFFICE', 'Office staff');
  insert into public.employee_group_memberships (organization_id, employee_group_id, employee_id, effective_from, effective_to) values
    ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000000e61', '0a000000-0000-0000-0000-0000000000e1', '2026-01-01', '2026-07-01'),
    ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000000e62', '0a000000-0000-0000-0000-0000000000e1', '2026-07-01', null),
    ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000000e61', '0a000000-0000-0000-0000-0000000000e3', '2026-01-01', null),
    ('0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-000000000e61', '0b000000-0000-0000-0000-0000000000e1', '2026-01-01', null);
  insert into public.attendance_rule_sets (id, organization_id, name, country_code, employee_group_id, effective_from, ramadan_mode) values
    ('0a000000-0000-0000-0000-000000000e71', '0a000000-0000-0000-0000-000000000000', 'Oman office', 'OM', '0a000000-0000-0000-0000-000000000e61', '2026-01-01', '{}'),
    ('0b000000-0000-0000-0000-000000000e71', '0b000000-0000-0000-0000-000000000000', 'B office', null, '0b000000-0000-0000-0000-000000000e61', '2026-01-01', '{}');
  insert into public.additional_shift_assignments (id, organization_id, employee_id, branch_id, shift_id, effective_from, effective_to) values
    ('0a000000-0000-0000-0000-000000000e81', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-000000000e52', '2026-10-10', '2026-10-11'),
    ('0a000000-0000-0000-0000-000000000e82', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e2', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-000000000e52', '2026-10-10', '2026-10-11');
  insert into public.shift_change_requests (id, organization_id, employee_id, branch_id, kind, from_date, to_date, requested_shift_id, reason) values
    ('0a000000-0000-0000-0000-000000000e91', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', 'CHANGE', '2026-11-01', '2026-11-05', '0a000000-0000-0000-0000-000000000e52', 'Evening classes'),
    ('0a000000-0000-0000-0000-000000000e92', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', 'ADDITIONAL', '2026-11-01', '2026-11-01', '0a000000-0000-0000-0000-000000000e52', 'Extra cover'),
    ('0b000000-0000-0000-0000-000000000e91', '0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '0b000000-0000-0000-0000-00000000000b', 'CHANGE', '2026-11-01', '2026-11-05', '0b000000-0000-0000-0000-000000000e51', 'Org B change');
  -- D1: e1 HQ → A-2 (host A-2); D2: e2 A-2 → HQ (home A-2); D3: e4 HQ → A-3 (neither is A-2); D4: e3 A-2 → HQ (emp-a's own)
  insert into public.employee_branch_deployments (id, organization_id, employee_id, home_branch_id, branch_id, from_date, to_date, reason) values
    ('0a000000-0000-0000-0000-000000000ea1', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-00000000000c', '2026-10-01', '2026-10-31', 'Cover at A-2'),
    ('0a000000-0000-0000-0000-000000000ea2', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e2', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-00000000000b', '2026-10-01', '2026-10-31', 'Cover at HQ'),
    ('0a000000-0000-0000-0000-000000000ea3', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e4', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-0000000000f3', '2026-10-01', '2026-10-31', 'Opening A-3'),
    ('0a000000-0000-0000-0000-000000000ea4', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-00000000000b', '2026-12-01', '2026-12-05', 'Training at HQ'),
    ('0b000000-0000-0000-0000-000000000ea1', '0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', null, '0b000000-0000-0000-0000-00000000000b', '2026-10-01', '2026-10-31', 'Org B deployment');
  insert into public.shift_coverage_requirements (organization_id, branch_id, shift_id, min_headcount) values
    ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-000000000e51', 3),
    ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-000000000e51', 2),
    ('0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-00000000000b', '0b000000-0000-0000-0000-000000000e51', 1);
end $$;

-- ---------- schema facts and constraints ----------
begin;
select pg_temp.fixtures();
select pg_temp.assert_eq((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relrowsecurity and c.relforcerowsecurity
  and c.relname in ('employee_groups', 'employee_group_memberships', 'additional_shift_assignments', 'shift_change_requests', 'employee_branch_deployments', 'shift_coverage_requirements')), 6, 'every new table has RLS enabled and forced');
select pg_temp.assert_eq((select count(*) from unnest(array['shift_change_requests', 'employee_branch_deployments']) t
  where has_table_privilege('authenticated', 'public.' || t, 'insert') or has_table_privilege('authenticated', 'public.' || t, 'update') or has_table_privilege('authenticated', 'public.' || t, 'delete')), 0, 'no client write privilege on the system-written tables');
select pg_temp.assert_eq((select count(*) from pg_policies where schemaname = 'public' and tablename in ('shift_change_requests', 'employee_branch_deployments') and permissive = 'RESTRICTIVE'
  and policyname ~ '_deny_client_(insert|update|delete)$'), 6, 'three explicit client write denials on each system-written table');
select pg_temp.assert_eq((select count(*) from public.plans where key = 'enterprise' and modules @> array['shift_requests', 'advanced_scheduling', 'attendance_policies']), 1, 'the enterprise plan includes the three modules');
select pg_temp.assert_eq((select count(*) from public.plans where key <> 'enterprise' and modules && array['shift_requests', 'advanced_scheduling', 'attendance_policies']), 0, 'no other plan includes them');
select pg_temp.assert_eq((select count(*) from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.is_system and rp.permission_key = 'shift.request_change'), 5, 'shift.request_change goes with shift.request_swap on the system roles');
-- one group per employee and day
select pg_temp.assert_sqlstate($q$ insert into public.employee_group_memberships (organization_id, employee_group_id, employee_id, effective_from) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000000e61', '0a000000-0000-0000-0000-0000000000e1', '2026-08-01') $q$, '23P01', 'an employee is in one group on a date');
select pg_temp.assert_raises($q$ insert into public.employee_group_memberships (organization_id, employee_group_id, employee_id, effective_from) values ('0a000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-000000000e61', '0a000000-0000-0000-0000-0000000000e2', '2026-01-01') $q$, 'a membership cannot point at another organisation''s group');
-- one policy per scope and day; another scope may overlap
select pg_temp.assert_sqlstate($q$ insert into public.attendance_rule_sets (organization_id, name, country_code, employee_group_id, effective_from, ramadan_mode) values ('0a000000-0000-0000-0000-000000000000', 'Duplicate scope', 'OM', '0a000000-0000-0000-0000-000000000e61', '2026-06-01', '{}') $q$, '23P01', 'two policies of the same scope cannot overlap');
select pg_temp.assert_rows($q$ insert into public.attendance_rule_sets (organization_id, name, country_code, effective_from, ramadan_mode) values ('0a000000-0000-0000-0000-000000000000', 'Oman', 'OM', '2026-06-01', '{}') $q$, 1, 'a broader scope overlaps freely');
select pg_temp.assert_raises($q$ insert into public.attendance_rule_sets (organization_id, name, employee_group_id, effective_from, ramadan_mode) values ('0a000000-0000-0000-0000-000000000000', 'Cross', '0b000000-0000-0000-0000-000000000e61', '2026-01-01', '{}') $q$, 'a policy cannot be scoped to another organisation''s group');
select pg_temp.assert_raises($q$ insert into public.attendance_rule_sets (organization_id, name, country_code, effective_from, ramadan_mode) values ('0a000000-0000-0000-0000-000000000000', 'Lower', 'om', '2027-01-01', '{}') $q$, 'a country code is two capital letters');
select pg_temp.assert_raises($q$ delete from public.employee_groups where id = '0a000000-0000-0000-0000-000000000e61' $q$, 'a group a policy uses cannot be deleted');
-- additional shifts: no overlap per employee
select pg_temp.assert_sqlstate($q$ insert into public.additional_shift_assignments (organization_id, employee_id, shift_id, effective_from) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-000000000e51', '2026-10-01') $q$, '23P01', 'additional shift assignments of an employee cannot overlap');
-- one pending change request of a kind per employee and day; a decided one is history
select pg_temp.assert_sqlstate($q$ insert into public.shift_change_requests (organization_id, employee_id, kind, from_date, to_date, requested_shift_id, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', 'CHANGE', '2026-11-05', '2026-11-06', '0a000000-0000-0000-0000-000000000e51', 'Second ask') $q$, '23P01', 'one pending change request per employee, kind and day');
select pg_temp.assert_rows($q$ insert into public.shift_change_requests (organization_id, employee_id, kind, from_date, to_date, requested_shift_id, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', 'ADDITIONAL', '2026-11-05', '2026-11-06', '0a000000-0000-0000-0000-000000000e52', 'Another kind') $q$, 1, 'another kind on the same days is allowed');
select pg_temp.assert_rows($q$ insert into public.shift_change_requests (organization_id, employee_id, kind, from_date, to_date, requested_shift_id, reason, status) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', 'CHANGE', '2026-11-05', '2026-11-06', '0a000000-0000-0000-0000-000000000e51', 'History', 'rejected') $q$, 1, 'a rejected request is history');
select pg_temp.assert_raises($q$ insert into public.shift_change_requests (organization_id, employee_id, kind, from_date, to_date, requested_shift_id, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e2', 'CHANGE', '2026-11-05', '2026-11-04', '0a000000-0000-0000-0000-000000000e51', 'Backwards') $q$, 'the range runs forward');
select pg_temp.assert_raises($q$ insert into public.shift_change_requests (organization_id, employee_id, kind, from_date, to_date, requested_shift_id, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e2', 'CHANGE', '2026-11-05', '2026-11-05', '0b000000-0000-0000-0000-000000000e51', 'Cross-tenant shift') $q$, 'a change request cannot ask for another organisation''s shift');
-- deployments: no overlapping active deployment; a cancelled one is history; never to the home branch
select pg_temp.assert_sqlstate($q$ insert into public.employee_branch_deployments (organization_id, employee_id, home_branch_id, branch_id, from_date, to_date, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-0000000000f3', '2026-10-31', '2026-11-02', 'Overlap') $q$, '23P01', 'active deployments of an employee cannot overlap');
select pg_temp.assert_rows($q$ update public.employee_branch_deployments set cancelled_at = now(), cancel_reason = 'Plans changed' where id = '0a000000-0000-0000-0000-000000000ea1' $q$, 1, 'a deployment can be cancelled with a reason');
select pg_temp.assert_rows($q$ insert into public.employee_branch_deployments (organization_id, employee_id, home_branch_id, branch_id, from_date, to_date, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-0000000000f3', '2026-10-31', '2026-11-02', 'After the cancellation') $q$, 1, 'a cancelled deployment no longer holds the days');
select pg_temp.assert_raises($q$ insert into public.employee_branch_deployments (organization_id, employee_id, home_branch_id, branch_id, from_date, to_date, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e5', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-00000000000b', '2026-10-01', '2026-10-02', 'Home') $q$, 'a deployment goes to another branch');
select pg_temp.assert_raises($q$ update public.employee_branch_deployments set cancelled_at = now() where id = '0a000000-0000-0000-0000-000000000ea2' $q$, 'a cancellation carries its reason');
select pg_temp.assert_raises($q$ insert into public.shift_coverage_requirements (organization_id, branch_id, shift_id, weekdays, min_headcount) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000f3', '0a000000-0000-0000-0000-000000000e51', '{7}', 1) $q$, 'coverage weekdays are 0..6');
rollback;

-- ---------- as Owner A ----------
begin;
select pg_temp.fixtures();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.employee_groups), 2, 'owner A sees org A groups only');
select pg_temp.assert_eq((select count(*) from public.employee_group_memberships), 3, 'owner A sees org A memberships only');
select pg_temp.assert_eq((select count(*) from public.attendance_rule_sets where employee_group_id is not null), 1, 'owner A sees org A scoped policies only');
select pg_temp.assert_eq((select count(*) from public.additional_shift_assignments), 2, 'owner A sees org A additional shifts only');
select pg_temp.assert_eq((select count(*) from public.shift_change_requests), 2, 'owner A sees org A change requests only');
select pg_temp.assert_eq((select count(*) from public.employee_branch_deployments), 4, 'owner A sees org A deployments only');
select pg_temp.assert_eq((select count(*) from public.shift_coverage_requirements), 2, 'owner A sees org A coverage only');
select pg_temp.assert_rows($q$ insert into public.employee_groups (organization_id, code, name) values ('0a000000-0000-0000-0000-000000000000', 'SALES', 'Sales staff') $q$, 1, 'owner A (attendance.manage_rules) creates a group');
select pg_temp.assert_raises($q$ insert into public.employee_groups (organization_id, code, name) values ('0b000000-0000-0000-0000-000000000000', 'SALES', 'Sales staff') $q$, 'owner A cannot create a group in org B');
select pg_temp.assert_raises($q$ insert into public.shift_change_requests (organization_id, employee_id, kind, from_date, to_date, requested_shift_id, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e4', 'CHANGE', '2026-11-10', '2026-11-10', '0a000000-0000-0000-0000-000000000e51', 'Direct write') $q$, 'nobody writes a change request directly — the API''s system step does');
select pg_temp.assert_raises($q$ insert into public.employee_branch_deployments (organization_id, employee_id, home_branch_id, branch_id, from_date, to_date, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e5', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-00000000000c', '2026-11-10', '2026-11-11', 'Direct write') $q$, 'nobody writes a deployment directly — the API''s system step does');
select pg_temp.assert_raises($q$ update public.shift_change_requests set status = 'approved' where id = '0a000000-0000-0000-0000-000000000e91' $q$, 'owner A cannot approve a change request directly (no client privilege at all)');
rollback;

-- ---------- as Branch Manager A (A-2 only, no attendance.manage_rules / shift.manage) ----------
begin;
select pg_temp.fixtures();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.employee_groups), 2, 'groups are organisation-wide reference data for attendance.view holders');
select pg_temp.assert_raises($q$ insert into public.employee_groups (organization_id, code, name) values ('0a000000-0000-0000-0000-000000000000', 'BM', 'By the branch manager') $q$, 'a branch manager without attendance.manage_rules cannot create a group');
select pg_temp.assert_eq((select count(*) from public.additional_shift_assignments), 1, 'additional shifts: the A-2 row only (branch scope)');
select pg_temp.assert_rows($q$ insert into public.additional_shift_assignments (organization_id, employee_id, branch_id, shift_id, effective_from, effective_to) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e6', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-000000000e52', '2026-10-12', '2026-10-13') $q$, 1, 'shift.assign inside the branch adds an additional shift');
select pg_temp.assert_raises($q$ insert into public.additional_shift_assignments (organization_id, employee_id, branch_id, shift_id, effective_from, effective_to) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e4', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-000000000e52', '2026-10-12', '2026-10-13') $q$, 'never in another branch');
select pg_temp.assert_eq((select count(*) from public.shift_coverage_requirements), 1, 'coverage: the A-2 target only');
select pg_temp.assert_raises($q$ insert into public.shift_coverage_requirements (organization_id, branch_id, shift_id, min_headcount) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-000000000e52', 1) $q$, 'coverage needs shift.manage');
select pg_temp.assert_eq((select count(*) from public.shift_change_requests), 1, 'change requests: the A-2 row only');
select pg_temp.assert_eq((select count(*) from public.employee_branch_deployments), 3, 'deployments hosted in A-2, homed in A-2 (the employee''s own branch), never one between two other branches');
select pg_temp.assert_eq((select count(*) from public.employee_branch_deployments where id = '0a000000-0000-0000-0000-000000000ea3'), 0, 'a deployment between HQ and A-3 stays out of reach');
rollback;

-- ---------- as a branch-scoped attendance admin (A-2 only, attendance.manage_rules) — review fix 20261007000200 ----------
begin;
select pg_temp.fixtures();
insert into auth.users (id, email) values ('a0000000-0000-0000-0000-0000000000aa', 'aa-a@test.local');
insert into public.user_profiles (id, email, full_name) values ('a0000000-0000-0000-0000-0000000000aa', 'aa-a@test.local', 'Attendance Admin A-2');
insert into public.org_memberships (id, organization_id, user_id, role_id, status, all_branches) values
  ('0a000000-0000-0000-0000-0000000000aa', '0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-0000000000aa', '10000000-0000-0000-0000-000000000006', 'active', false);
insert into public.membership_branches (membership_id, branch_id) values ('0a000000-0000-0000-0000-0000000000aa', '0a000000-0000-0000-0000-00000000000c');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-0000000000aa","role":"authenticated"}', true);
select pg_temp.assert_raises($q$ insert into public.employee_groups (organization_id, code, name) values ('0a000000-0000-0000-0000-000000000000', 'BRANCH', 'Branch-made group') $q$, 'a group is organisation-wide: creating one needs every branch');
select pg_temp.assert_rows($q$ update public.employee_groups set name = 'Renamed' where id = '0a000000-0000-0000-0000-000000000e62' $q$, 0, 'renaming a group needs every branch');
select pg_temp.assert_rows($q$ insert into public.employee_group_memberships (organization_id, employee_group_id, employee_id, effective_from) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000000e62', '0a000000-0000-0000-0000-0000000000e2', '2026-01-01') $q$, 1, 'a branch-scoped admin puts an employee of their branch in a group');
select pg_temp.assert_raises($q$ insert into public.employee_group_memberships (organization_id, employee_group_id, employee_id, effective_from) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000000e62', '0a000000-0000-0000-0000-0000000000e4', '2026-01-01') $q$, '… never an employee of another branch');
select pg_temp.assert_rows($q$ update public.employee_group_memberships set effective_to = '2026-12-01' where employee_id = '0a000000-0000-0000-0000-0000000000e3' $q$, 1, 'ends the membership of an employee of their branch');
select pg_temp.assert_rows($q$ update public.employee_group_memberships set effective_to = '2026-12-01' where employee_id = '0a000000-0000-0000-0000-0000000000e1' and effective_to is null $q$, 0, '… not one of another branch''s employee');
select pg_temp.assert_rows($q$ delete from public.employee_group_memberships where employee_id = '0a000000-0000-0000-0000-0000000000e1' $q$, 0, '… nor deletes one');
rollback;

-- ---------- as Employee A (emp-a, linked to e3) ----------
begin;
select pg_temp.fixtures();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.shift_change_requests), 1, 'an employee reads their own change request only');
select pg_temp.assert_eq((select count(*) from public.shift_change_requests where employee_id = '0a000000-0000-0000-0000-0000000000e3'), 1, '… which is theirs');
select pg_temp.assert_eq((select count(*) from public.employee_branch_deployments), 1, 'an employee reads their own deployment only');
select pg_temp.assert_eq((select count(*) from public.employee_groups), 0, 'no attendance.view, no groups');
select pg_temp.assert_eq((select count(*) from public.additional_shift_assignments), 0, 'no shift.view, no additional shifts');
select pg_temp.assert_raises($q$ update public.shift_change_requests set status = 'cancelled' where id = '0a000000-0000-0000-0000-000000000e92' $q$, 'the employee withdraws through the API only');
rollback;

-- ---------- as Line Manager A (manager of e1) ----------
begin;
select pg_temp.fixtures();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.shift_change_requests), 1, 'a line manager reads their direct report''s change request');
select pg_temp.assert_eq((select count(*) from public.shift_change_requests where employee_id = '0a000000-0000-0000-0000-0000000000e1'), 1, '… e1''s');
rollback;

-- ---------- the system context of org A ----------
begin;
select pg_temp.fixtures();
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system","org_id":"0a000000-0000-0000-0000-000000000000"}', true);
select pg_temp.assert_rows($q$ insert into public.shift_change_requests (organization_id, employee_id, branch_id, kind, from_date, to_date, requested_shift_id, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e4', '0a000000-0000-0000-0000-00000000000b', 'CHANGE', '2026-11-10', '2026-11-10', '0a000000-0000-0000-0000-000000000e51', 'Filed by the API') $q$, 1, 'the system step files a change request');
select pg_temp.assert_rows($q$ update public.employee_branch_deployments set cleaned_up_at = now() where id = '0a000000-0000-0000-0000-000000000ea2' $q$, 1, 'the system step records a clean-up');
select pg_temp.assert_raises($q$ insert into public.shift_change_requests (organization_id, employee_id, branch_id, kind, from_date, to_date, requested_shift_id, reason) values ('0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '0b000000-0000-0000-0000-00000000000b', 'CHANGE', '2026-11-10', '2026-11-10', '0b000000-0000-0000-0000-000000000e51', 'Other tenant') $q$, 'the system context of org A cannot write org B');
select pg_temp.assert_eq((select count(*) from public.employee_branch_deployments where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'the system context of org A reads nothing of org B');
rollback;

-- ---------- as Owner B ----------
begin;
select pg_temp.fixtures();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.employee_groups), 1, 'owner B sees org B groups only');
select pg_temp.assert_eq((select count(*) from public.shift_change_requests), 1, 'owner B sees org B change requests only');
select pg_temp.assert_eq((select count(*) from public.employee_branch_deployments), 1, 'owner B sees org B deployments only');
select pg_temp.assert_eq((select count(*) from public.shift_coverage_requirements), 1, 'owner B sees org B coverage only');
rollback;

\echo rls_enterprise: all assertions passed
