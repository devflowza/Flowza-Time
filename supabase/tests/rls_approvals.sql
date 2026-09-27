-- Approval engine v2 RLS (migration 20260928000200): who reads approval requests, steps, actors and the timeline
-- (assignee / delegate / subject / requester / team / organisation-wide keys), that clients never write them, that e-mail
-- tokens are unreadable, and the attendance-correction hardening (a client inserts only PENDING corrections for somebody
-- in reach, and never updates or deletes one). Runs after rls_isolation.sql (its fixtures are committed) as superuser.
\set QUIET on
\set ON_ERROR_STOP on
set client_min_messages = warning;

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

-- ---------- fixtures (superuser) ----------
-- R1: LEAVE about e1 (HQ; manager-a is e1's primary manager), filed by owner-a; level 1 routed to assignee-a (an `employee`
--     role holder with no key at all — only the assignment opens it) and manager-a; manager-a delegates LEAVE to delegate-a.
-- R2: ATTENDANCE_CORRECTION about e3 (branch A-2), filed by emp-a about themselves; level 1 routed to bm-a.
-- R3: LEAVE in org B, filed by owner-b.
begin;
insert into auth.users (id, email) values ('a0000000-0000-0000-0000-000000000008', 'assignee-a@test.local'), ('a0000000-0000-0000-0000-000000000009', 'delegate-a@test.local');
insert into public.user_profiles (id, email, full_name) values ('a0000000-0000-0000-0000-000000000008', 'assignee-a@test.local', 'Assignee A'), ('a0000000-0000-0000-0000-000000000009', 'delegate-a@test.local', 'Delegate A');
insert into public.org_memberships (organization_id, user_id, role_id, status, all_branches) values
  ('0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000008', 'active', true),
  ('0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000008', 'active', true);
insert into public.approval_requests (id, organization_id, entity_type, entity_id, branch_id, employee_id, subject_user_id, current_step, status, requested_by) values
  ('0a000000-0000-0000-0000-0000000002a1', '0a000000-0000-0000-0000-000000000000', 'LEAVE', '0a000000-0000-0000-0000-0000000001b1', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-0000000000e1', null, 1, 'PENDING', 'a0000000-0000-0000-0000-000000000001'),
  ('0a000000-0000-0000-0000-0000000002a2', '0a000000-0000-0000-0000-000000000000', 'ATTENDANCE_CORRECTION', '0a000000-0000-0000-0000-0000000003c1', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000000e3', 'a0000000-0000-0000-0000-000000000003', 1, 'PENDING', 'a0000000-0000-0000-0000-000000000003'),
  ('0b000000-0000-0000-0000-0000000002a3', '0b000000-0000-0000-0000-000000000000', 'LEAVE', '0b000000-0000-0000-0000-0000000001b1', '0b000000-0000-0000-0000-00000000000b', '0b000000-0000-0000-0000-0000000000e1', null, 1, 'PENDING', 'b0000000-0000-0000-0000-000000000001');
insert into public.approval_steps (id, organization_id, request_id, step_no, approver_type, status, mode) values
  ('0a000000-0000-0000-0000-0000000002b1', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000002a1', 1, 'MANAGER', 'PENDING', 'ANY'),
  ('0a000000-0000-0000-0000-0000000002b2', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000002a2', 1, 'ROLE', 'PENDING', 'ANY'),
  ('0b000000-0000-0000-0000-0000000002b3', '0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000002a3', 1, 'USER', 'PENDING', 'ANY');
insert into public.approval_step_actors (organization_id, step_id, user_id, resolution_path) values
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000002b1', 'a0000000-0000-0000-0000-000000000008', 'user'),
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000002b1', 'a0000000-0000-0000-0000-000000000005', 'primary'),
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000002b2', 'a0000000-0000-0000-0000-000000000002', 'permission'),
  ('0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000002b3', 'b0000000-0000-0000-0000-000000000001', 'user');
insert into public.approval_request_events (organization_id, request_id, kind, actor_user_id) values
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000002a1', 'submitted', 'a0000000-0000-0000-0000-000000000001'),
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000002a2', 'submitted', 'a0000000-0000-0000-0000-000000000003'),
  ('0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000002a3', 'submitted', 'b0000000-0000-0000-0000-000000000001');
insert into public.approval_delegations (organization_id, delegator_user_id, delegate_user_id, entity_types, starts_on, ends_on, created_by) values
  ('0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000009', '{LEAVE}', current_date - 1, current_date + 1, 'a0000000-0000-0000-0000-000000000005');
insert into public.approval_email_tokens (organization_id, request_id, step_id, user_id, action, token_hash, expires_at) values
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000002a1', '0a000000-0000-0000-0000-0000000002b1', 'a0000000-0000-0000-0000-000000000008', 'APPROVE', repeat('a', 64), now() + interval '7 days');
-- a pending correction by owner-a about e1, used by the update / delete assertions
insert into public.attendance_corrections (id, organization_id, employee_id, branch_id, attendance_date, type, proposed_punched_at, reason, requested_by, status) values
  ('0a000000-0000-0000-0000-0000000003c9', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '2026-08-30', 'ADD_PUNCH', '2026-08-30 04:00+00', 'HR filed', 'a0000000-0000-0000-0000-000000000001', 'PENDING');
commit;
set client_min_messages = notice;

-- ---------- assignee (no key, only the assignment) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000008","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.approval_requests), 1, 'assignee sees exactly the request routed to them');
select pg_temp.assert_eq((select count(*) from public.approval_requests where id = '0a000000-0000-0000-0000-0000000002a1'), 1, 'assignee sees R1');
select pg_temp.assert_eq((select count(*) from public.approval_steps), 1, 'assignee sees R1''s level');
select pg_temp.assert_eq((select count(*) from public.approval_step_actors), 2, 'assignee sees the actors of R1''s level');
select pg_temp.assert_eq((select count(*) from public.approval_request_events), 1, 'assignee sees R1''s timeline');
select pg_temp.assert_eq((select count(*) from public.approval_delegations), 0, 'assignee does not see somebody else''s delegation');
select pg_temp.assert_raises($q$ select count(*) from public.approval_email_tokens $q$, 'clients cannot read e-mail tokens at all');
select pg_temp.assert_raises($q$ insert into public.approval_requests (organization_id, entity_type, entity_id, current_step, status) values ('0a000000-0000-0000-0000-000000000000', 'LEAVE', gen_random_uuid(), 1, 'APPROVED') $q$, 'clients cannot create requests');
select pg_temp.assert_rows($q$ update public.approval_requests set status = 'APPROVED' where id = '0a000000-0000-0000-0000-0000000002a1' $q$, 0, 'clients cannot decide a request by UPDATE');
select pg_temp.assert_rows($q$ update public.approval_step_actors set decision = 'APPROVED' where user_id = 'a0000000-0000-0000-0000-000000000008' $q$, 0, 'clients cannot record a decision by UPDATE');
select pg_temp.assert_raises($q$ insert into public.approval_step_actors (organization_id, step_id, user_id) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000002b2', 'a0000000-0000-0000-0000-000000000008') $q$, 'clients cannot seat themselves on another level');
select pg_temp.assert_raises($q$ insert into public.approval_request_events (organization_id, request_id, kind) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000002a1', 'approved') $q$, 'clients cannot forge timeline events');
select pg_temp.assert_rows($q$ delete from public.approval_steps $q$, 0, 'clients cannot delete levels');
rollback;

-- ---------- delegate of the approver (LEAVE, today) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000009","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.approval_requests), 1, 'a delegate sees the request waiting for the approver they cover');
select pg_temp.assert_eq((select count(*) from public.approval_requests where entity_type = 'ATTENDANCE_CORRECTION'), 0, 'the delegation covers LEAVE only');
select pg_temp.assert_eq((select count(*) from public.approval_delegations), 1, 'the delegate sees the delegation');
rollback;

-- ---------- subject + requester of R2 (self-service employee) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.approval_requests), 1, 'the employee sees only the request about them');
select pg_temp.assert_eq((select count(*) from public.approval_requests where id = '0a000000-0000-0000-0000-0000000002a2'), 1, 'the employee sees R2');
select pg_temp.assert_eq((select count(*) from public.approval_steps), 1, 'the employee sees R2''s level');
select pg_temp.assert_eq((select count(*) from public.approval_request_events), 1, 'the employee sees R2''s timeline');
rollback;

-- ---------- line manager (team keys; e1 is a direct report; assignee of R1) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.approval_requests), 1, 'manager sees R1 (report + assignee), not R2 (not a report, no organisation-wide key)');
select pg_temp.assert_eq((select count(*) from public.approval_delegations), 1, 'the delegator sees their own delegation');
-- correction hardening (Prompt 1 review): PENDING, filed by oneself, for somebody in reach only
select pg_temp.assert_rows($q$ insert into public.attendance_corrections (organization_id, employee_id, branch_id, attendance_date, type, proposed_punched_at, reason, requested_by, status)
  values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '2026-09-01', 'ADD_PUNCH', '2026-09-01 04:00+00', 'Report forgot', 'a0000000-0000-0000-0000-000000000005', 'PENDING') $q$, 1, 'manager may file a PENDING correction for a direct report');
select pg_temp.assert_rows($q$ insert into public.attendance_corrections (organization_id, employee_id, branch_id, attendance_date, type, proposed_punched_at, reason, requested_by, status)
  values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e4', '0a000000-0000-0000-0000-00000000000b', '2026-09-01', 'ADD_PUNCH', '2026-09-01 04:10+00', 'My own punch', 'a0000000-0000-0000-0000-000000000005', 'PENDING') $q$, 1, 'manager may file a PENDING correction for their own record');
select pg_temp.assert_raises($q$ insert into public.attendance_corrections (organization_id, employee_id, branch_id, attendance_date, type, proposed_punched_at, reason, requested_by, status)
  values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e2', '0a000000-0000-0000-0000-00000000000c', '2026-09-01', 'ADD_PUNCH', '2026-09-01 04:00+00', 'Not my report', 'a0000000-0000-0000-0000-000000000005', 'PENDING') $q$, 'manager cannot file a correction for a non-report');
select pg_temp.assert_raises($q$ insert into public.attendance_corrections (organization_id, employee_id, branch_id, attendance_date, type, proposed_punched_at, reason, requested_by, status)
  values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '2026-09-02', 'ADD_PUNCH', '2026-09-02 04:00+00', 'Pre-approved', 'a0000000-0000-0000-0000-000000000005', 'APPROVED') $q$, 'manager cannot insert an APPROVED correction');
select pg_temp.assert_raises($q$ insert into public.attendance_corrections (organization_id, employee_id, branch_id, attendance_date, type, proposed_punched_at, reason, requested_by, status)
  values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '2026-09-03', 'ADD_PUNCH', '2026-09-03 04:00+00', 'In HR''s name', 'a0000000-0000-0000-0000-000000000001', 'PENDING') $q$, 'manager cannot file a correction in somebody else''s name');
select pg_temp.assert_rows($q$ update public.attendance_corrections set status = 'APPROVED' where id = '0a000000-0000-0000-0000-0000000003c9' $q$, 0, 'manager cannot approve a correction by UPDATE');
select pg_temp.assert_rows($q$ update public.attendance_corrections set proposed_punched_at = '2026-08-30 09:00+00' where id = '0a000000-0000-0000-0000-0000000003c9' $q$, 0, 'manager cannot rewrite a pending correction');
select pg_temp.assert_rows($q$ delete from public.attendance_corrections where id = '0a000000-0000-0000-0000-0000000003c9' $q$, 0, 'manager cannot delete a correction');
rollback;

-- ---------- organisation-wide reader (auditor) and HR (owner) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000007","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.approval_requests), 2, 'auditor (organisation-wide keys) sees org A''s requests');
select pg_temp.assert_eq((select count(*) from public.approval_requests where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'auditor sees nothing of org B');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.approval_delegations), 1, 'approval.manage sees the organisation''s delegations');
select pg_temp.assert_rows($q$ insert into public.attendance_corrections (organization_id, employee_id, branch_id, attendance_date, type, proposed_punched_at, reason, requested_by, status)
  values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e2', '0a000000-0000-0000-0000-00000000000c', '2026-09-04', 'ADD_PUNCH', '2026-09-04 04:00+00', 'HR files for anyone', 'a0000000-0000-0000-0000-000000000001', 'PENDING') $q$, 1, 'HR (organisation-wide attendance.view) files for anyone in scope');
select pg_temp.assert_rows($q$ update public.attendance_corrections set status = 'APPLIED' where id = '0a000000-0000-0000-0000-0000000003c9' $q$, 0, 'not even HR applies a correction by UPDATE (system context only)');
select pg_temp.assert_eq((select count(*) from public.approval_requests where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'owner A sees no request of org B');
rollback;

-- ---------- org B ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.approval_requests), 1, 'owner B sees only R3');
select pg_temp.assert_eq((select count(*) from public.approval_steps), 1, 'owner B sees only R3''s level');
select pg_temp.assert_eq((select count(*) from public.approval_step_actors), 1, 'owner B sees only R3''s actors');
select pg_temp.assert_eq((select count(*) from public.approval_request_events), 1, 'owner B sees only R3''s timeline');
select pg_temp.assert_eq((select count(*) from public.approval_delegations), 0, 'owner B sees no delegation of org A');
rollback;

-- ---------- system context (the engine) ----------
begin;
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system","org_id":"0a000000-0000-0000-0000-000000000000"}', true);
select pg_temp.assert_eq((select count(*) from public.approval_email_tokens), 1, 'the system context reads its organisation''s tokens');
select pg_temp.assert_rows($q$ update public.attendance_corrections set status = 'APPROVED' where id = '0a000000-0000-0000-0000-0000000003c9' $q$, 1, 'the engine (system context) approves a correction');
select pg_temp.assert_rows($q$ update public.approval_requests set status = 'APPROVED' where id = '0b000000-0000-0000-0000-0000000002a3' $q$, 0, 'the system context of org A cannot touch org B');
rollback;
