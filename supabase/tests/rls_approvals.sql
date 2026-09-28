-- Approval engine v2 RLS (migration 20260928000200): who reads approval requests, steps, actors and the timeline
-- (assignee / delegate / subject / requester / team / organisation-wide keys), that clients never write them, that e-mail
-- tokens are unreadable, and the attendance-correction hardening (a client inserts only PENDING corrections for somebody
-- in reach, and never updates or deletes one). Runs after rls_isolation.sql (its fixtures are committed) as superuser.
-- The last section pins the review fixes (20260928000800): current memberships only, the organisation's date for
-- delegations, the CHECK on self-approval, canonical applies_to and the per-row indexed assignee check (it commits a heavy
-- third tenant, so it stays last).
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
select pg_temp.assert_raises($q$ update public.approval_requests set status = 'APPROVED' where id = '0a000000-0000-0000-0000-0000000002a1' $q$, 'clients cannot decide a request by UPDATE');
select pg_temp.assert_raises($q$ update public.approval_step_actors set decision = 'APPROVED' where user_id = 'a0000000-0000-0000-0000-000000000008' $q$, 'clients cannot record a decision by UPDATE');
select pg_temp.assert_raises($q$ insert into public.approval_step_actors (organization_id, step_id, user_id) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000002b2', 'a0000000-0000-0000-0000-000000000008') $q$, 'clients cannot seat themselves on another level');
select pg_temp.assert_raises($q$ insert into public.approval_request_events (organization_id, request_id, kind) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000002a1', 'approved') $q$, 'clients cannot forge timeline events');
select pg_temp.assert_raises($q$ delete from public.approval_steps $q$, 'clients cannot delete levels');
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
select pg_temp.assert_raises($q$ update public.attendance_corrections set status = 'APPROVED' where id = '0a000000-0000-0000-0000-0000000003c9' $q$, 'manager cannot approve a correction by UPDATE');
select pg_temp.assert_raises($q$ update public.attendance_corrections set proposed_punched_at = '2026-08-30 09:00+00' where id = '0a000000-0000-0000-0000-0000000003c9' $q$, 'manager cannot rewrite a pending correction');
select pg_temp.assert_raises($q$ delete from public.attendance_corrections where id = '0a000000-0000-0000-0000-0000000003c9' $q$, 'manager cannot delete a correction');
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
select pg_temp.assert_raises($q$ update public.attendance_corrections set status = 'APPLIED' where id = '0a000000-0000-0000-0000-0000000003c9' $q$, 'not even HR applies a correction by UPDATE (system context only)');
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

-- ======================================================================================================================
-- Review fixes (migration 20260928000800, docs/hr-portal/reviews/02-approval-engine-v2-review.md). Each assertion names
-- the defect it pins.
-- ======================================================================================================================

-- ---------- P0-2: every read branch requires a CURRENT membership ----------
-- a suspended assignee (assignee-a is seated on R1 only through the assignment)
begin;
update public.org_memberships set status = 'suspended' where organization_id = '0a000000-0000-0000-0000-000000000000' and user_id = 'a0000000-0000-0000-0000-000000000008';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000008","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.approval_requests), 0, 'P0-2 a suspended assignee reads no request');
select pg_temp.assert_eq((select count(*) from public.approval_steps), 0, 'P0-2 a suspended assignee reads no level');
select pg_temp.assert_eq((select count(*) from public.approval_step_actors), 0, 'P0-2 a suspended assignee reads no actor row (no comments)');
select pg_temp.assert_eq((select count(*) from public.approval_request_events), 0, 'P0-2 a suspended assignee reads no timeline');
rollback;
-- a suspended requester (emp-a filed R2, about themselves)
begin;
update public.org_memberships set status = 'suspended' where organization_id = '0a000000-0000-0000-0000-000000000000' and user_id = 'a0000000-0000-0000-0000-000000000003';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.approval_requests), 0, 'P0-2 a suspended requester reads no request');
select pg_temp.assert_eq((select count(*) from public.approval_steps), 0, 'P0-2 a suspended requester reads no level');
select pg_temp.assert_eq((select count(*) from public.approval_request_events), 0, 'P0-2 a suspended requester reads no timeline');
rollback;
-- a removed member (the membership row is gone)
begin;
delete from public.org_memberships where organization_id = '0a000000-0000-0000-0000-000000000000' and user_id = 'a0000000-0000-0000-0000-000000000008';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000008","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.approval_requests), 0, 'P0-2 a removed member reads no request');
select pg_temp.assert_eq((select count(*) from public.approval_step_actors), 0, 'P0-2 a removed member reads no actor row');
select pg_temp.assert_eq((select count(*) from public.approval_request_events), 0, 'P0-2 a removed member reads no timeline');
rollback;
-- a suspended delegator (manager-a delegates LEAVE to delegate-a): reads nothing, and their seat is no longer covered
begin;
update public.org_memberships set status = 'suspended' where organization_id = '0a000000-0000-0000-0000-000000000000' and user_id = 'a0000000-0000-0000-0000-000000000005';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.approval_delegations), 0, 'P0-2 a suspended delegator no longer reads their delegation (nor its reason)');
select pg_temp.assert_eq((select count(*) from public.approval_requests), 0, 'P0-2 a suspended delegator reads no request');
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000009","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.approval_requests), 0, 'P0-2 the delegate of a suspended delegator no longer covers their seat');
select pg_temp.assert_eq((select count(*) from app.approval_actionable_request_ids('0a000000-0000-0000-0000-000000000000')), 0, 'P0-2 ...nor counts it as actionable');
rollback;
-- an outsider who was never a member, and anon
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.approval_requests), 0, 'P0-2 an outsider reads no request');
select pg_temp.assert_eq((select count(*) from public.approval_steps), 0, 'P0-2 an outsider reads no level');
select pg_temp.assert_eq((select count(*) from public.approval_step_actors), 0, 'P0-2 an outsider reads no actor row');
select pg_temp.assert_eq((select count(*) from public.approval_request_events), 0, 'P0-2 an outsider reads no timeline');
select pg_temp.assert_eq((select count(*) from public.approval_delegations), 0, 'P0-2 an outsider reads no delegation');
select pg_temp.assert_eq((select count(*) from app.approval_actionable_request_ids('0a000000-0000-0000-0000-000000000000')), 0, 'P0-2 an outsider has nothing actionable');
select pg_temp.assert_eq((select count(*) from app.approval_inbox_summary()), 0, 'P0-2 an outsider has no inbox summary');
rollback;
begin;
set local role anon;
select pg_temp.assert_raises($q$ select count(*) from public.approval_requests $q$, 'P0-2 anon is denied approval requests');
select pg_temp.assert_raises($q$ select count(*) from public.approval_delegations $q$, 'P0-2 anon is denied delegations');
rollback;

-- ---------- P0-3: self-approval cannot be switched on ----------
begin;
do $$
declare v_name text;
begin
  insert into public.approval_workflows (organization_id, entity_type, name, steps, allow_self_approval)
  values ('0a000000-0000-0000-0000-000000000000', 'LEAVE', 'self', '[{"order":1,"approverType":"HR_ADMIN","mode":"ANY"}]', true);
  raise exception 'ASSERT FAILED: P0-3 a workflow allowing self-approval was accepted';
exception when check_violation then
  get stacked diagnostics v_name = constraint_name;
  if v_name <> 'approval_workflows_no_self_approval' then raise exception 'ASSERT FAILED: P0-3 refused by % instead of the self-approval CHECK', v_name; end if;
  raise notice 'ok: P0-3 a workflow cannot allow self-approval (%)', v_name;
end $$;
rollback;

-- ---------- P2-8: applies_to is canonical; reordered or repeated ids are one default ----------
begin;
insert into public.approval_workflows (id, organization_id, entity_type, name, steps, applies_to, is_default, status) values
  ('0a000000-0000-0000-0000-0000000004f1', '0a000000-0000-0000-0000-000000000000', 'LEAVE', 'canonical', '[{"order":1,"approverType":"MANAGER","mode":"ANY"}]', '{"branchIds":["0A000000-0000-0000-0000-00000000000C","0a000000-0000-0000-0000-00000000000b"],"departmentIds":[]}', true, 'active');
select pg_temp.assert_eq((select count(*) from public.approval_workflows where id = '0a000000-0000-0000-0000-0000000004f1' and applies_to = '{"branchIds":["0a000000-0000-0000-0000-00000000000b","0a000000-0000-0000-0000-00000000000c"]}'::jsonb), 1, 'P2-8 applies_to is stored sorted, de-duplicated, lower-cased, without empty lists');
do $$
declare v_name text;
begin
  insert into public.approval_workflows (organization_id, entity_type, name, steps, applies_to, is_default, status) values ('0a000000-0000-0000-0000-000000000000', 'LEAVE', 'reordered', '[{"order":1,"approverType":"MANAGER","mode":"ANY"}]',
    '{"branchIds":["0a000000-0000-0000-0000-00000000000c","0a000000-0000-0000-0000-00000000000b","0a000000-0000-0000-0000-00000000000b"]}', true, 'active');
  raise exception 'ASSERT FAILED: P2-8 a reordered copy of a default workflow was accepted';
exception when unique_violation then
  get stacked diagnostics v_name = constraint_name;
  if v_name <> 'approval_workflows_default_v3_idx' then raise exception 'ASSERT FAILED: P2-8 refused by % instead of the canonical index', v_name; end if;
  raise notice 'ok: P2-8 the same scope in another order is a duplicate default (%)', v_name;
end $$;
rollback;

-- ---------- P2-1: the organisation's date, the one "today" of delegations ----------
begin;
update public.organizations set timezone = 'Pacific/Kiritimati' where id = '0a000000-0000-0000-0000-000000000000';
update public.organizations set timezone = 'America/Los_Angeles' where id = '0b000000-0000-0000-0000-000000000000';
select pg_temp.assert_eq((select (app.org_date_at('0a000000-0000-0000-0000-000000000000', '2026-09-27 23:30+00') = date '2026-09-28')::int), 1, 'P2-1 Kiritimati: 23:30 UTC on the 27th is already the 28th');
select pg_temp.assert_eq((select (app.org_date_at('0a000000-0000-0000-0000-000000000000', '2026-09-28 09:59+00') = date '2026-09-28')::int), 1, 'P2-1 Kiritimati: 09:59 UTC is still the 28th');
select pg_temp.assert_eq((select (app.org_date_at('0a000000-0000-0000-0000-000000000000', '2026-09-28 10:00+00') = date '2026-09-29')::int), 1, 'P2-1 Kiritimati: 10:00 UTC is the next day');
select pg_temp.assert_eq((select (app.org_date_at('0b000000-0000-0000-0000-000000000000', '2026-09-28 00:30+00') = date '2026-09-27')::int), 1, 'P2-1 Los Angeles: 00:30 UTC on the 28th is still the 27th');
select pg_temp.assert_eq((select (app.org_date_at('0b000000-0000-0000-0000-000000000000', '2026-09-28 07:00+00') = date '2026-09-28')::int), 1, 'P2-1 Los Angeles: 07:00 UTC (PDT) is the 28th');
select pg_temp.assert_eq((select (app.org_today('0a000000-0000-0000-0000-000000000000') = app.org_date_at('0a000000-0000-0000-0000-000000000000', now()))::int), 1, 'P2-1 org_today is org_date_at(now())');
-- delegate-a covers manager-a on R1 only on the days of the window, read in the organisation's date
update public.approval_delegations set starts_on = app.org_today('0a000000-0000-0000-0000-000000000000') - 1, ends_on = app.org_today('0a000000-0000-0000-0000-000000000000') - 1
where delegate_user_id = 'a0000000-0000-0000-0000-000000000009';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000009","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.approval_requests), 0, 'P2-1 a window that ended yesterday (organisation date) is not in force, whatever the UTC date');
select pg_temp.assert_eq((select count(*) from app.approval_actionable_request_ids('0a000000-0000-0000-0000-000000000000')), 0, 'P2-1 ...and nothing is actionable');
reset role;
update public.approval_delegations set starts_on = app.org_today('0a000000-0000-0000-0000-000000000000'), ends_on = app.org_today('0a000000-0000-0000-0000-000000000000')
where delegate_user_id = 'a0000000-0000-0000-0000-000000000009';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000009","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.approval_requests), 1, 'P2-1 a window of today (organisation date) is in force for the read rule');
select pg_temp.assert_eq((select count(*) from app.approval_actionable_request_ids('0a000000-0000-0000-0000-000000000000')), 1, 'P2-1 ...the inbox queue');
select pg_temp.assert_eq((select count(*) from app.approval_inbox_summary() where organization_id = '0a000000-0000-0000-0000-000000000000' and actionable = 1 and delegated_to_me), 1, 'P2-1 ...and /me');
rollback;

-- ---------- HR portal Prompt 5 review (20260928000950): ONE definition of "waiting for you" ----------
-- R5: REGULARISATION about e1 — manager-a seated as primary, e1's secondary manager (a…06) standing in on that seat
--     (`secondary`, no delegation behind it: 5-P1-3); R6: LEAVE about delegate-a, seated on manager-a, whose LEAVE seats
--     delegate-a covers today (5-P2-1); R7: LEAVE delegate-a filed about e1, seated on manager-a (5-P2-1, requester);
-- R8: two levels — level 1 approved by assignee-a and by owner-a, level 2 seats both of them again (5-O3 four-eyes).
begin;
insert into public.approval_requests (id, organization_id, entity_type, entity_id, branch_id, employee_id, subject_user_id, current_step, status, requested_by) values
  ('0a000000-0000-0000-0000-0000000005a5', '0a000000-0000-0000-0000-000000000000', 'REGULARISATION', gen_random_uuid(), '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-0000000000e1', null, 1, 'PENDING', 'a0000000-0000-0000-0000-000000000001'),
  ('0a000000-0000-0000-0000-0000000005a6', '0a000000-0000-0000-0000-000000000000', 'LEAVE', gen_random_uuid(), '0a000000-0000-0000-0000-00000000000b', null, 'a0000000-0000-0000-0000-000000000009', 1, 'PENDING', 'a0000000-0000-0000-0000-000000000009'),
  ('0a000000-0000-0000-0000-0000000005a7', '0a000000-0000-0000-0000-000000000000', 'LEAVE', gen_random_uuid(), '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-0000000000e1', null, 1, 'PENDING', 'a0000000-0000-0000-0000-000000000009'),
  ('0a000000-0000-0000-0000-0000000005a8', '0a000000-0000-0000-0000-000000000000', 'LEAVE', gen_random_uuid(), '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-0000000000e1', null, 2, 'PENDING', 'a0000000-0000-0000-0000-000000000003');
insert into public.approval_steps (id, organization_id, request_id, step_no, approver_type, status, mode) values
  ('0a000000-0000-0000-0000-0000000005b5', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000005a5', 1, 'MANAGER', 'PENDING', 'ANY'),
  ('0a000000-0000-0000-0000-0000000005b6', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000005a6', 1, 'MANAGER', 'PENDING', 'ANY'),
  ('0a000000-0000-0000-0000-0000000005b7', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000005a7', 1, 'MANAGER', 'PENDING', 'ANY'),
  ('0a000000-0000-0000-0000-0000000005b8', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000005a8', 1, 'USER', 'APPROVED', 'ALL'),
  ('0a000000-0000-0000-0000-0000000005b9', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000005a8', 2, 'USER', 'PENDING', 'ANY');
insert into public.approval_step_actors (organization_id, step_id, user_id, via_delegation_of, resolution_path, decision) values
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000005b5', 'a0000000-0000-0000-0000-000000000005', null, 'primary', 'PENDING'),
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000005b5', 'a0000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000005', 'secondary', 'PENDING'),
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000005b6', 'a0000000-0000-0000-0000-000000000005', null, 'primary', 'PENDING'),
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000005b7', 'a0000000-0000-0000-0000-000000000005', null, 'primary', 'PENDING'),
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000005b8', 'a0000000-0000-0000-0000-000000000008', null, 'user', 'APPROVED'),
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000005b8', 'a0000000-0000-0000-0000-000000000001', null, 'user', 'APPROVED'),
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000005b9', 'a0000000-0000-0000-0000-000000000008', null, 'user', 'PENDING'),
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000005b9', 'a0000000-0000-0000-0000-000000000001', null, 'user', 'PENDING');
set local role authenticated;
-- the secondary manager standing in: their seat counts — no delegation needed, any entity type (5-P1-3)
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000006","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from app.approval_actionable_request_ids('0a000000-0000-0000-0000-000000000000') x where x = '0a000000-0000-0000-0000-0000000005a5'), 1, '5-P1-3 a secondary manager''s stand-in seat on a regularisation is waiting for them');
select pg_temp.assert_eq((select actionable from app.approval_inbox_summary() where organization_id = '0a000000-0000-0000-0000-000000000000'), 1, '5-P1-3 ...and /me counts it');
-- the primary still has it too
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from app.approval_actionable_request_ids('0a000000-0000-0000-0000-000000000000') x where x = '0a000000-0000-0000-0000-0000000005a5'), 1, '5-P1-3 ...as it waits for the primary manager');
-- a delegate never waits for their own request, nor for one they filed that they would reach only as the delegate (5-P2-1)
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000009","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from app.approval_actionable_request_ids('0a000000-0000-0000-0000-000000000000') x where x in ('0a000000-0000-0000-0000-0000000005a6', '0a000000-0000-0000-0000-0000000005a7')), 0, '5-P2-1 a delegate''s own request (subject or requester) is not waiting for them');
select pg_temp.assert_eq((select count(*) from app.approval_actionable_request_ids('0a000000-0000-0000-0000-000000000000') x where x = '0a000000-0000-0000-0000-0000000002a1'), 1, '5-P2-1 ...the delegator''s other seats still are');
-- four-eyes: a level after one the caller approved is not waiting for them; the owner keeps the logged override (5-O3)
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000008","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from app.approval_actionable_request_ids('0a000000-0000-0000-0000-000000000000') x where x = '0a000000-0000-0000-0000-0000000005a8'), 0, '5-O3 a level after one the caller approved is not waiting for them');
select pg_temp.assert_eq((select count(*) from app.approval_actionable_request_ids('0a000000-0000-0000-0000-000000000000') x where x = '0a000000-0000-0000-0000-0000000002a1'), 1, '5-O3 ...their other seats are');
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from app.approval_actionable_request_ids('0a000000-0000-0000-0000-000000000000') x where x = '0a000000-0000-0000-0000-0000000005a8'), 1, '5-O3 the owner keeps the override (logged when they decide)');
rollback;

-- ---------- P1-5: indexed per-row assignee check, no array of every assignment ----------
select pg_temp.assert_eq((select count(*) from pg_policies where schemaname = 'public' and tablename like 'approval%' and (qual ~ 'approval_assigned_request_ids' or coalesce(with_check, '') ~ 'approval_assigned_request_ids')), 0, 'P1-5 no approval read rule builds the array of every assignment');
select pg_temp.assert_eq((select count(*) from pg_policies where schemaname = 'public' and tablename = 'approval_requests' and policyname = 'approval_requests_select' and qual ~ 'approval_request_assigned\(id, organization_id, entity_type\)'), 1, 'P1-5 the assignee branch is a per-row check on the request''s own ids');
select pg_temp.assert_eq((select count(*) from pg_indexes where schemaname = 'public' and indexname in ('approval_step_actors_user_step_idx', 'approval_steps_org_request_idx', 'approval_request_events_org_request_idx', 'approval_delegations_delegate_window_idx')), 4, 'P1-5 the read rules'' indexes exist');
-- a heavy approver in a third tenant: 2,000 requests, 4,000 levels, 8,000 actor rows, all of them seated on every level
begin;
insert into auth.users (id, email) values ('c0000000-0000-0000-0000-0000000000c1', 'heavy-c@test.local'), ('c0000000-0000-0000-0000-0000000000c2', 'requester-c@test.local');
insert into public.user_profiles (id, email, full_name) values ('c0000000-0000-0000-0000-0000000000c1', 'heavy-c@test.local', 'Heavy C'), ('c0000000-0000-0000-0000-0000000000c2', 'requester-c@test.local', 'Requester C');
insert into public.organizations (id, company_code, legal_name, display_name) values ('0c000000-0000-0000-0000-000000000000', 'TEST-C', 'Org C LLC', 'Org C');
insert into public.branches (id, organization_id, code, name) values ('0c000000-0000-0000-0000-00000000000b', '0c000000-0000-0000-0000-000000000000', 'C-HQ', 'C HQ');
insert into public.org_memberships (organization_id, user_id, role_id, status, all_branches) values
  ('0c000000-0000-0000-0000-000000000000', 'c0000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-000000000008', 'active', true),
  ('0c000000-0000-0000-0000-000000000000', 'c0000000-0000-0000-0000-0000000000c2', '10000000-0000-0000-0000-000000000008', 'active', true);
insert into public.approval_requests (id, organization_id, entity_type, entity_id, branch_id, current_step, status, requested_by)
select ('0c000000-0000-0000-0001-' || lpad(to_hex(n), 12, '0'))::uuid, '0c000000-0000-0000-0000-000000000000', 'LEAVE', gen_random_uuid(), '0c000000-0000-0000-0000-00000000000b', 1, 'PENDING', 'c0000000-0000-0000-0000-0000000000c2'
from generate_series(1, 2000) n;
insert into public.approval_steps (id, organization_id, request_id, step_no, approver_type, status, mode)
select ('0c000000-0000-0000-0002-' || lpad(to_hex(n * 2 + s), 12, '0'))::uuid, '0c000000-0000-0000-0000-000000000000', ('0c000000-0000-0000-0001-' || lpad(to_hex(n), 12, '0'))::uuid, s, 'USER', 'PENDING', 'ANY'
from generate_series(1, 2000) n cross join generate_series(1, 2) s;
insert into public.approval_step_actors (organization_id, step_id, user_id, resolution_path)
select '0c000000-0000-0000-0000-000000000000', s.id, u.user_id, 'user'
from public.approval_steps s cross join (values ('c0000000-0000-0000-0000-0000000000c1'::uuid), ('c0000000-0000-0000-0000-0000000000c2'::uuid)) u(user_id)
where s.organization_id = '0c000000-0000-0000-0000-000000000000';
commit;
analyze public.approval_requests, public.approval_steps, public.approval_step_actors, public.org_memberships;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.approval_requests where id = '0c000000-0000-0000-0001-000000000400'), 1, 'P1-5 the heavy approver reads one of their requests');
select pg_temp.assert_eq((select count(*) from public.approval_requests where organization_id <> '0c000000-0000-0000-0000-000000000000'), 0, 'P1-5 ...and nothing of the other tenants');
do $$
declare v_plan json; v_buffers bigint;
begin
  execute 'explain (analyze, buffers, format json) select * from public.approval_requests where id = ''0c000000-0000-0000-0001-000000000400''' into v_plan;
  v_buffers := coalesce((v_plan -> 0 -> 'Plan' ->> 'Shared Hit Blocks')::bigint, 0) + coalesce((v_plan -> 0 -> 'Plan' ->> 'Shared Read Blocks')::bigint, 0);
  if v_buffers > 100 then raise exception 'ASSERT FAILED: P1-5 a by-id read of a heavy approver touches % buffers (bound 100)', v_buffers; end if;
  if v_plan::text ~ 'approval_assigned_request_ids' then raise exception 'ASSERT FAILED: P1-5 the plan builds the array of every assignment'; end if;
  raise notice 'ok: P1-5 a by-id read of a heavy approver (8,000 assignments) touches % buffers', v_buffers;
end $$;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.approval_requests where organization_id = '0c000000-0000-0000-0000-000000000000'), 0, 'P1-5 org A''s owner reads nothing of the heavy tenant');
do $$
declare v_plan json; v_buffers bigint;
begin
  -- the API's shape (always one organisation): the other tenants' 2,000 requests are never evaluated
  execute 'explain (analyze, buffers, format json) select count(*) from public.approval_requests where organization_id = ''0a000000-0000-0000-0000-000000000000''' into v_plan;
  v_buffers := coalesce((v_plan -> 0 -> 'Plan' ->> 'Shared Hit Blocks')::bigint, 0) + coalesce((v_plan -> 0 -> 'Plan' ->> 'Shared Read Blocks')::bigint, 0);
  if v_buffers > 200 then raise exception 'ASSERT FAILED: P1-5 org A''s owner reading their organisation touches % buffers (bound 200)', v_buffers; end if;
  raise notice 'ok: P1-5 org A''s owner reads their organisation''s requests in % buffers next to the heavy tenant', v_buffers;
end $$;
rollback;
