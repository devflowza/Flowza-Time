-- Short leave (migration 20261019000310): permission types, short leave requests, reduced hours. Runs as superuser AFTER
-- rls_isolation.sql (it reuses that suite's organisations, branches, employees, logins and roles):
--   Org A: branches HQ (…0b), A-2 (…0c); owner-a (all branches), bm-a (branch manager, A-2 only), emp-a (employee role, linked
--          to e3 in A-2), manager-a (line manager of e1, HQ). Org B: owner-b.
-- Self-contained: every block inserts its fixtures through pg_temp.fixtures() and rolls back.
-- Rules under test:
--   * the three tables isolate tenants and force RLS; requests and allowances honour the branch scope;
--   * requests are written by the system context only (no client privilege, three explicit denials); the employee reads their
--     own, a line manager (leave.view_team) their team's; the types are readable by whoever requests, approves or follows them;
--   * allowances are written with leave.manage inside the branch scope; the employee reads their own;
--   * constraints: two active windows of an employee never overlap, a window runs forward within the day and carries its
--     minutes, one allowance of a kind per employee and day, no cross-tenant type.
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
  insert into public.time_off_types (id, organization_id, code, name, category, counts_as_work) values
    ('0a000000-0000-0000-0000-000000000f01', '0a000000-0000-0000-0000-000000000000', 'PERSONAL', 'Personal permission', 'PERSONAL', false),
    ('0a000000-0000-0000-0000-000000000f02', '0a000000-0000-0000-0000-000000000000', 'OFFICIAL', 'Official assignment', 'OFFICIAL', true),
    ('0b000000-0000-0000-0000-000000000f01', '0b000000-0000-0000-0000-000000000000', 'PERSONAL', 'Personal permission', 'PERSONAL', false);
  insert into public.time_off_requests (id, organization_id, employee_id, branch_id, time_off_type_id, request_date, start_time, end_time, minutes, reason, status) values
    ('0a000000-0000-0000-0000-000000000f11', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-000000000f02', '2026-11-02', '08:00', '10:00', 120, 'Ministry visit', 'APPROVED'),
    ('0a000000-0000-0000-0000-000000000f12', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-000000000f01', '2026-11-03', '09:00', '10:00', 60, 'Doctor', 'PENDING'),
    ('0b000000-0000-0000-0000-000000000f11', '0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '0b000000-0000-0000-0000-00000000000b', '0b000000-0000-0000-0000-000000000f01', '2026-11-02', '08:00', '09:00', 60, 'Org B', 'PENDING');
  insert into public.employee_hour_allowances (id, organization_id, employee_id, branch_id, kind, minutes_per_day, position, valid_from, valid_to) values
    ('0a000000-0000-0000-0000-000000000f21', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', 'NURSING', 60, 'START', '2026-10-01', '2027-03-31'),
    ('0a000000-0000-0000-0000-000000000f22', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', 'DISABILITY', 120, 'EITHER', '2026-01-01', null),
    ('0b000000-0000-0000-0000-000000000f21', '0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '0b000000-0000-0000-0000-00000000000b', 'DISABILITY', 60, 'END', '2026-01-01', null);
end $$;

-- ---------- schema facts and constraints ----------
begin;
select pg_temp.fixtures();
select pg_temp.assert_eq((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relrowsecurity and c.relforcerowsecurity
  and c.relname in ('time_off_types', 'time_off_requests', 'employee_hour_allowances')), 3, 'every new table has RLS enabled and forced');
select pg_temp.assert_eq((select count(*) from unnest(array['insert', 'update', 'delete']) p where has_table_privilege('authenticated', 'public.time_off_requests', p)), 0, 'no client write privilege on the requests');
select pg_temp.assert_eq((select count(*) from pg_policies where schemaname = 'public' and tablename = 'time_off_requests' and permissive = 'RESTRICTIVE' and policyname ~ '_deny_client_(insert|update|delete)$'), 3, 'three explicit client write denials on the requests');
select pg_temp.assert_sqlstate($q$ insert into public.time_off_requests (organization_id, employee_id, time_off_type_id, request_date, start_time, end_time, minutes, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-000000000f01', '2026-11-02', '09:30', '11:00', 90, 'Overlap') $q$, '23P01', 'two active windows of an employee cannot overlap');
select pg_temp.assert_rows($q$ insert into public.time_off_requests (organization_id, employee_id, time_off_type_id, request_date, start_time, end_time, minutes, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-000000000f01', '2026-11-02', '10:00', '11:00', 60, 'Adjacent') $q$, 1, 'an adjacent window is fine');
select pg_temp.assert_rows($q$ insert into public.time_off_requests (organization_id, employee_id, time_off_type_id, request_date, start_time, end_time, minutes, reason, status, cancelled_at) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-000000000f01', '2026-11-02', '08:30', '09:00', 30, 'Cancelled', 'CANCELLED', now()) $q$, 1, 'a cancelled window holds nothing');
select pg_temp.assert_rows($q$ insert into public.time_off_requests (organization_id, employee_id, time_off_type_id, request_date, start_time, end_time, minutes, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e2', '0a000000-0000-0000-0000-000000000f01', '2026-11-02', '22:00', '24:00', 120, 'Until midnight') $q$, 1, 'a window may end at 24:00');
select pg_temp.assert_raises($q$ insert into public.time_off_requests (organization_id, employee_id, time_off_type_id, request_date, start_time, end_time, minutes, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e2', '0a000000-0000-0000-0000-000000000f01', '2026-11-05', '10:00', '09:00', 60, 'Backwards') $q$, 'a window runs forward');
select pg_temp.assert_raises($q$ insert into public.time_off_requests (organization_id, employee_id, time_off_type_id, request_date, start_time, end_time, minutes, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e2', '0a000000-0000-0000-0000-000000000f01', '2026-11-05', '09:00', '10:00', 45, 'Wrong minutes') $q$, 'the minutes are the window''s');
select pg_temp.assert_raises($q$ insert into public.time_off_requests (organization_id, employee_id, time_off_type_id, request_date, start_time, end_time, minutes, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e2', '0b000000-0000-0000-0000-000000000f01', '2026-11-05', '09:00', '10:00', 60, 'Cross-tenant type') $q$, 'a request cannot use another organisation''s type');
select pg_temp.assert_raises($q$ update public.time_off_requests set status = 'CANCELLED' where id = '0a000000-0000-0000-0000-000000000f12' $q$, 'a cancellation records when');
select pg_temp.assert_sqlstate($q$ insert into public.employee_hour_allowances (organization_id, employee_id, kind, minutes_per_day, position, valid_from, valid_to) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', 'NURSING', 30, 'END', '2027-01-01', '2027-02-01') $q$, '23P01', 'one allowance of a kind per employee and day');
select pg_temp.assert_rows($q$ insert into public.employee_hour_allowances (organization_id, employee_id, kind, minutes_per_day, position, valid_from) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', 'DISABILITY', 30, 'END', '2027-01-01') $q$, 1, 'another kind may overlap');
select pg_temp.assert_raises($q$ insert into public.employee_hour_allowances (organization_id, employee_id, kind, minutes_per_day, position, valid_from) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e2', 'OTHER', 300, 'END', '2027-01-01') $q$, 'at most 240 minutes a day');
select pg_temp.assert_raises($q$ insert into public.employee_hour_allowances (organization_id, employee_id, kind, minutes_per_day, position, valid_from, valid_to) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e2', 'OTHER', 30, 'END', '2027-01-02', '2027-01-01') $q$, 'the range runs forward');
select pg_temp.assert_raises($q$ insert into public.attendance_rule_sets (organization_id, name, effective_from, out_of_office_allowance_minutes, ramadan_mode) values ('0a000000-0000-0000-0000-000000000000', 'Too tolerant', '2031-01-01', 121, '{}') $q$, 'the out-of-office allowance is 0..120');
rollback;

-- ---------- as Owner A ----------
begin;
select pg_temp.fixtures();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.time_off_types), 2, 'owner A sees org A types only');
select pg_temp.assert_eq((select count(*) from public.time_off_requests), 2, 'owner A sees org A requests only');
select pg_temp.assert_eq((select count(*) from public.employee_hour_allowances), 2, 'owner A sees org A allowances only');
select pg_temp.assert_rows($q$ insert into public.time_off_types (organization_id, code, name, category) values ('0a000000-0000-0000-0000-000000000000', 'REMOTE', 'Remote work', 'REMOTE') $q$, 1, 'owner A (leave.manage) creates a type');
select pg_temp.assert_raises($q$ insert into public.time_off_types (organization_id, code, name, category) values ('0b000000-0000-0000-0000-000000000000', 'REMOTE', 'Remote work', 'REMOTE') $q$, 'owner A cannot create a type in org B');
select pg_temp.assert_raises($q$ insert into public.time_off_requests (organization_id, employee_id, time_off_type_id, request_date, start_time, end_time, minutes, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e4', '0a000000-0000-0000-0000-000000000f01', '2026-11-10', '08:00', '09:00', 60, 'Direct write') $q$, 'nobody writes a request directly — the API''s system step does');
select pg_temp.assert_raises($q$ update public.time_off_requests set status = 'APPROVED' where id = '0a000000-0000-0000-0000-000000000f12' $q$, 'owner A cannot approve a request directly (no client privilege at all)');
select pg_temp.assert_rows($q$ insert into public.employee_hour_allowances (organization_id, employee_id, branch_id, kind, minutes_per_day, position, valid_from) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e4', '0a000000-0000-0000-0000-00000000000b', 'DISABILITY', 60, 'END', '2026-11-01') $q$, 1, 'owner A grants reduced hours');
rollback;

-- ---------- as Branch Manager A (A-2 only; leave.view + leave.manage) ----------
begin;
select pg_temp.fixtures();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.time_off_types), 2, 'types are organisation-wide reference data');
select pg_temp.assert_eq((select count(*) from public.time_off_requests), 1, 'requests: the A-2 row only (branch scope)');
select pg_temp.assert_eq((select count(*) from public.employee_hour_allowances), 1, 'allowances: the A-2 row only');
select pg_temp.assert_rows($q$ insert into public.employee_hour_allowances (organization_id, employee_id, branch_id, kind, minutes_per_day, position, valid_from) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e2', '0a000000-0000-0000-0000-00000000000c', 'OTHER', 30, 'END', '2026-11-01') $q$, 1, 'leave.manage inside the branch grants reduced hours');
select pg_temp.assert_raises($q$ insert into public.employee_hour_allowances (organization_id, employee_id, branch_id, kind, minutes_per_day, position, valid_from) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e4', '0a000000-0000-0000-0000-00000000000b', 'OTHER', 30, 'END', '2026-11-01') $q$, 'never in another branch');
select pg_temp.assert_rows($q$ delete from public.employee_hour_allowances where id = '0a000000-0000-0000-0000-000000000f21' $q$, 0, 'nor removes another branch''s');
rollback;

-- ---------- as Employee A (emp-a, linked to e3) ----------
begin;
select pg_temp.fixtures();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.time_off_types), 2, 'a requester reads the types');
select pg_temp.assert_eq((select count(*) from public.time_off_requests), 1, 'an employee reads their own request only');
select pg_temp.assert_eq((select count(*) from public.time_off_requests where employee_id = '0a000000-0000-0000-0000-0000000000e3'), 1, '… which is theirs');
select pg_temp.assert_eq((select count(*) from public.employee_hour_allowances), 1, 'an employee reads their own reduced hours');
select pg_temp.assert_raises($q$ update public.time_off_requests set status = 'CANCELLED', cancelled_at = now() where id = '0a000000-0000-0000-0000-000000000f12' $q$, 'the employee withdraws through the API only');
select pg_temp.assert_raises($q$ insert into public.employee_hour_allowances (organization_id, employee_id, branch_id, kind, minutes_per_day, position, valid_from) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', 'OTHER', 240, 'END', '2026-11-01') $q$, 'an employee cannot grant themselves reduced hours');
select pg_temp.assert_raises($q$ insert into public.time_off_types (organization_id, code, name, category) values ('0a000000-0000-0000-0000-000000000000', 'MINE', 'Mine', 'OTHER') $q$, 'an employee cannot create a type');
rollback;

-- ---------- as Line Manager A (manager of e1) ----------
begin;
select pg_temp.fixtures();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.time_off_requests), 1, 'a line manager reads their direct report''s request');
select pg_temp.assert_eq((select count(*) from public.time_off_requests where employee_id = '0a000000-0000-0000-0000-0000000000e1'), 1, '… e1''s');
select pg_temp.assert_eq((select count(*) from public.time_off_types), 2, 'an approver reads the types');
rollback;

-- ---------- the system context of org A ----------
begin;
select pg_temp.fixtures();
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system","org_id":"0a000000-0000-0000-0000-000000000000"}', true);
select pg_temp.assert_rows($q$ insert into public.time_off_requests (organization_id, employee_id, branch_id, time_off_type_id, request_date, start_time, end_time, minutes, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e4', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-000000000f01', '2026-11-10', '08:00', '09:00', 60, 'Filed by the API') $q$, 1, 'the system step files a request');
select pg_temp.assert_rows($q$ update public.time_off_requests set status = 'APPROVED', decided_at = now() where id = '0a000000-0000-0000-0000-000000000f12' $q$, 1, 'the approval hook decides it');
select pg_temp.assert_raises($q$ insert into public.time_off_requests (organization_id, employee_id, branch_id, time_off_type_id, request_date, start_time, end_time, minutes, reason) values ('0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '0b000000-0000-0000-0000-00000000000b', '0b000000-0000-0000-0000-000000000f01', '2026-11-10', '08:00', '09:00', 60, 'Other tenant') $q$, 'the system context of org A cannot write org B');
select pg_temp.assert_eq((select count(*) from public.time_off_requests where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'the system context of org A reads nothing of org B');
rollback;

-- ---------- as Owner B ----------
begin;
select pg_temp.fixtures();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.time_off_types), 1, 'owner B sees org B types only');
select pg_temp.assert_eq((select count(*) from public.time_off_requests), 1, 'owner B sees org B requests only');
select pg_temp.assert_eq((select count(*) from public.employee_hour_allowances), 1, 'owner B sees org B allowances only');
rollback;

\echo rls_short_leave: all assertions passed
