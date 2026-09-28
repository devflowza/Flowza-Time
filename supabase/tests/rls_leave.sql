-- Leave v2 RLS (migration 20260928000700): leave allocations, the append-only comment thread, comp-off credits and their
-- usage, the self-service withdraw policy + guard on leave records (edits are the API's), the half-day aware overlap constraint and
-- (review fixes, migration 20260928000850) the subject guard: nobody writes their own leave / credits / allocation from a client
-- session — creates, decisions and corrections go through the API (P0-2, P2-10). Since the security gate (20260928001100) no
-- client session writes leave records, allocations or comp-off credits at all, whoever they are about: the API checks the
-- permission, the branch scope and segregation of duties, then writes in its system step — the withdrawal of an undecided
-- request included (it cancels the approval request in the same transaction; a direct withdrawal left the request pending).
-- The subject guard stays as a second layer (asserted below with the client privilege re-opened on purpose). Who
-- reads what: the employee their own rows, a line manager their direct reports' (leave.view_team), HR the organisation
-- (branch-scoped), the auditor read-only, an approval assignee the thread of the leave routed to them — and nobody anything
-- of another tenant. Runs after rls_isolation.sql (its fixtures are committed) as superuser. It needs nothing from
-- rls_approvals.sql — the approval-assignee case builds its own request and rolls it back — and it commits rows only to the
-- leave v2 tables (plus one leave type and leave record of org B), so rls_approvals.sql stays the last suite of the runner.
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
-- refused by an authorization layer (SQLSTATE 42501): the missing client write privilege (security gate 20260928001100) or the
-- subject guard itself — not by RLS filtering to zero rows or a constraint, so an unrelated error must not pass for the fix
create or replace function pg_temp.assert_guarded(sqltext text, label text) returns void language plpgsql as $$
begin
  begin
    execute sqltext;
  exception when others then
    if sqlstate = '42501' and (sqlerrm like '%segregation of duties%' or sqlerrm like 'permission denied for table%') then raise notice 'ok: % (raised %)', label, sqlerrm; return; end if;
    raise exception 'ASSERT FAILED: % — refused for another reason: % %', label, sqlstate, sqlerrm;
  end;
  raise exception 'ASSERT FAILED: % — expected the write to be refused', label;
end $$;
-- the subject guard itself (defense in depth, exercised with the client privilege re-opened on purpose)
create or replace function pg_temp.assert_subject_guard(sqltext text, label text) returns void language plpgsql as $$
begin
  begin
    execute sqltext;
  exception when others then
    if sqlstate = '42501' and sqlerrm like '%segregation of duties%' then raise notice 'ok: % (raised %)', label, sqlerrm; return; end if;
    raise exception 'ASSERT FAILED: % — refused for another reason: % %', label, sqlstate, sqlerrm;
  end;
  raise exception 'ASSERT FAILED: % — expected the subject guard to refuse it', label;
end $$;

grant execute on all functions in schema pg_temp to public;

-- ---------- fixtures (superuser) ----------
-- Org A: allocations for e1 (HQ, report of manager-a) and e3 (A-2, the self-service employee emp-a); comments on e1's
-- pending leave (1b1), e3's pending (1b3) and approved (1b4) leave;
-- comp-off credits for e3 (approved, used by 1b4) and e1 (pending). Org B: one of each.
begin;
insert into public.leave_types (id, organization_id, code, name, status) values ('0b000000-0000-0000-0000-0000000007a1', '0b000000-0000-0000-0000-000000000000', 'AL', 'Annual Leave', 'active');
insert into public.leave_records (id, organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, status) values
  ('0b000000-0000-0000-0000-0000000007b1', '0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '0b000000-0000-0000-0000-00000000000b', '0b000000-0000-0000-0000-0000000007a1', '2026-10-04', '2026-10-05', 'PENDING');
insert into public.leave_allocations (id, organization_id, employee_id, leave_type_id, branch_id, year, allocated_days) values
  ('0a000000-0000-0000-0000-0000000007c1', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-0000000001a1', '0a000000-0000-0000-0000-00000000000b', 2026, 30),
  ('0a000000-0000-0000-0000-0000000007c3', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-0000000001a1', '0a000000-0000-0000-0000-00000000000c', 2026, 30),
  ('0b000000-0000-0000-0000-0000000007c1', '0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '0b000000-0000-0000-0000-0000000007a1', '0b000000-0000-0000-0000-00000000000b', 2026, 21);
insert into public.leave_request_comments (id, organization_id, leave_record_id, author_user_id, body, kind) values
  ('0a000000-0000-0000-0000-0000000007d1', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000001b1', 'a0000000-0000-0000-0000-000000000001', 'Handover?', 'comment'),
  ('0a000000-0000-0000-0000-0000000007d3', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000001b3', 'a0000000-0000-0000-0000-000000000003', 'Visa appointment', 'comment'),
  ('0a000000-0000-0000-0000-0000000007d4', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000001b4', 'a0000000-0000-0000-0000-000000000001', 'Enjoy', 'comment'),
  ('0b000000-0000-0000-0000-0000000007d1', '0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000007b1', 'b0000000-0000-0000-0000-000000000001', 'Org B note', 'comment');
insert into public.comp_off_credits (id, organization_id, employee_id, branch_id, worked_on, worked_on_type, worked_minutes, days_earned, location, summary, status, used_days, expires_on, created_by) values
  ('0a000000-0000-0000-0000-0000000007e3', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '2026-09-04', 'weekly_off', 480, 1, 'Site', 'Stock count', 'used', 1, '2026-12-03', 'a0000000-0000-0000-0000-000000000003'),
  ('0a000000-0000-0000-0000-0000000007e1', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '2026-09-11', 'weekly_off', 300, 0.5, 'HQ', 'Release', 'pending_approval', 0, null, 'a0000000-0000-0000-0000-000000000001'),
  ('0b000000-0000-0000-0000-0000000007e1', '0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '0b000000-0000-0000-0000-00000000000b', '2026-09-04', 'holiday', 480, 1, 'B HQ', 'Holiday cover', 'approved', 0, '2026-12-03', 'b0000000-0000-0000-0000-000000000001');
insert into public.comp_off_usages (organization_id, employee_id, branch_id, credit_id, leave_record_id, days) values
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000007e3', '0a000000-0000-0000-0000-0000000001b4', 1);
commit;
set client_min_messages = notice;

-- ---------- Employee (emp-a → e3, role employee: leave.request only) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.leave_allocations), 1, 'employee reads own allocation only');
select pg_temp.assert_eq((select count(*) from public.comp_off_credits), 1, 'employee reads own comp-off credits only');
select pg_temp.assert_eq((select count(*) from public.comp_off_usages), 1, 'employee reads the usage of own credits only');
select pg_temp.assert_eq((select count(*) from public.leave_request_comments), 2, 'employee reads the threads of own leave only');
select pg_temp.assert_eq((select count(*) from public.leave_request_comments where leave_record_id = '0a000000-0000-0000-0000-0000000001b1'), 0, 'employee cannot read somebody else''s thread');
select pg_temp.assert_rows($q$ insert into public.leave_request_comments (organization_id, leave_record_id, author_user_id, body, kind) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000001b3', 'a0000000-0000-0000-0000-000000000003', 'Adding the ticket number', 'comment') $q$, 1, 'employee comments on own leave');
select pg_temp.assert_raises($q$ insert into public.leave_request_comments (organization_id, leave_record_id, author_user_id, body, kind) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000001b3', 'a0000000-0000-0000-0000-000000000003', 'I approve', 'info_request') $q$, 'clients write plain comments only (questions / replies come from the engine)');
select pg_temp.assert_raises($q$ insert into public.leave_request_comments (organization_id, leave_record_id, author_user_id, body, kind) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000001b3', 'a0000000-0000-0000-0000-000000000001', 'Signed as the owner', 'comment') $q$, 'a comment is written as oneself only');
select pg_temp.assert_raises($q$ insert into public.leave_request_comments (organization_id, leave_record_id, author_user_id, body, kind) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000001b1', 'a0000000-0000-0000-0000-000000000003', 'Not my leave', 'comment') $q$, 'employee cannot comment on a leave they cannot read');
select pg_temp.assert_raises($q$ update public.leave_request_comments set body = 'edited' where id = '0a000000-0000-0000-0000-0000000007d3' $q$, 'comments are never updated by clients');
select pg_temp.assert_raises($q$ delete from public.leave_request_comments where id = '0a000000-0000-0000-0000-0000000007d3' $q$, 'comments are never deleted by clients');
select pg_temp.assert_raises($q$ insert into public.leave_allocations (organization_id, employee_id, leave_type_id, branch_id, year, allocated_days) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-0000000001a1', '0a000000-0000-0000-0000-00000000000c', 2027, 99) $q$, 'employee cannot allocate leave (leave.manage)');
select pg_temp.assert_raises($q$ update public.leave_allocations set allocated_days = 99 where id = '0a000000-0000-0000-0000-0000000007c3' $q$, 'employee cannot change own allocation');
-- review P2-10 / P0-2: a credit is requested through the API (the worked day is validated, then written in the system context)
select pg_temp.assert_guarded($q$ insert into public.comp_off_credits (organization_id, employee_id, branch_id, worked_on, worked_on_type, worked_minutes, days_earned, location, summary, status, created_by) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '2026-09-18', 'weekly_off', 480, 1, 'Site', 'Audit', 'pending_approval', 'a0000000-0000-0000-0000-000000000003') $q$, '7-P2-10 an employee cannot insert a comp-off credit directly, even a pending one (the API validates and writes it)');
select pg_temp.assert_raises($q$ insert into public.comp_off_credits (organization_id, employee_id, branch_id, worked_on, worked_on_type, worked_minutes, days_earned, location, summary, status, expires_on, created_by) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '2026-09-25', 'weekly_off', 480, 1, 'Site', 'Audit', 'approved', '2026-12-24', 'a0000000-0000-0000-0000-000000000003') $q$, 'employee cannot insert an approved credit');
select pg_temp.assert_raises($q$ insert into public.comp_off_credits (organization_id, employee_id, branch_id, worked_on, worked_on_type, worked_minutes, days_earned, location, summary, status, created_by) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '2026-09-25', 'weekly_off', 480, 1, 'HQ', 'Not mine', 'pending_approval', 'a0000000-0000-0000-0000-000000000003') $q$, 'employee cannot request a credit for somebody else');
select pg_temp.assert_raises($q$ update public.comp_off_credits set used_days = 0, status = 'approved' where id = '0a000000-0000-0000-0000-0000000007e3' $q$, 'employee cannot restore a used credit');
select pg_temp.assert_raises($q$ insert into public.comp_off_usages (organization_id, employee_id, branch_id, credit_id, leave_record_id, days) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000007e3', '0a000000-0000-0000-0000-0000000001b3', 1) $q$, 'usages are written by the system only');
-- edits AND the withdrawal go through the API (validated, days recomputed, resubmitted / the approval request cancelled, written
-- in the system context) — a client write could otherwise move the dates, forge `days` or strand a pending approval request
select pg_temp.assert_raises($q$ update public.leave_records set end_date = '2026-10-13', days = 3, edited_at = now() where id = '0a000000-0000-0000-0000-0000000001b3' $q$, 'a client cannot edit its own request directly (the API does, after validation)');
select pg_temp.assert_raises($q$ update public.leave_records set days = 0.5 where id = '0a000000-0000-0000-0000-0000000001b3' $q$, 'a client cannot forge the days a request charges');
select pg_temp.assert_raises($q$ update public.leave_records set status = 'CANCELLED', days = 0.5 where id = '0a000000-0000-0000-0000-0000000001b3' $q$, 'a withdrawal cannot carry other changes');
select pg_temp.assert_raises($q$ insert into public.leave_records (organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, status, created_by, reason, days) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000001a1', '2026-12-06', '2026-12-10', 'PENDING', 'a0000000-0000-0000-0000-000000000003', 'Forged days', 0.5) $q$, 'a client insert cannot set the server-computed days');
select pg_temp.assert_raises($q$ update public.leave_records set approval_request_id = null, decision_note = 'self-approved' where id = '0a000000-0000-0000-0000-0000000001b3' $q$, 'an edit cannot touch the decision or the approval link');
select pg_temp.assert_raises($q$ update public.leave_records set status = 'APPROVED' where id = '0a000000-0000-0000-0000-0000000001b3' $q$, 'employee cannot approve through an edit');
select pg_temp.assert_guarded($q$ update public.leave_records set status = 'CANCELLED', withdrawn_at = now() where id = '0a000000-0000-0000-0000-0000000001b3' $q$, '10-S7 an employee cannot withdraw own pending request directly (the API withdraws it and cancels its approval request)');
select pg_temp.assert_raises($q$ update public.leave_records set end_date = '2026-08-04' where id = '0a000000-0000-0000-0000-0000000001b4' $q$, 'decided leave is not the employee''s to edit');
-- review P2-10: no direct insert of one's own leave — the API validates it (applicability, half days, locked periods, the one
-- leave per date rule) and writes it in the system context. The probes HALF-1 / HALF-3 of the review:
select pg_temp.assert_guarded($q$ insert into public.leave_records (organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, status, created_by, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000001a1', '2026-11-01', '2026-11-02', 'PENDING', 'a0000000-0000-0000-0000-000000000003', 'Trip') $q$, '7-P2-10 an employee cannot insert their own leave directly (creates go through the API)');
select pg_temp.assert_guarded($q$ insert into public.leave_records (organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, is_half_day, half_day_part, status, created_by, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000001a1', '2026-11-15', '2026-11-15', true, 'SECOND_HALF', 'PENDING', 'a0000000-0000-0000-0000-000000000003', 'Afternoon') $q$, '7-P2-10 HALF-1 the other half of a date cannot be added around the API');
rollback;

-- ---------- Line Manager A (role manager → e4, primary manager of e1: leave.view_team) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.leave_allocations), 1, 'manager reads the direct report''s allocation only');
select pg_temp.assert_eq((select count(*) from public.leave_allocations where employee_id = '0a000000-0000-0000-0000-0000000000e1'), 1, 'manager reads e1''s allocation');
select pg_temp.assert_eq((select count(*) from public.comp_off_credits), 1, 'manager reads the report''s comp-off credit only');
select pg_temp.assert_eq((select count(*) from public.leave_request_comments where leave_record_id = '0a000000-0000-0000-0000-0000000001b1'), 1, 'manager reads the thread of the report''s leave');
select pg_temp.assert_eq((select count(*) from public.leave_request_comments where leave_record_id in ('0a000000-0000-0000-0000-0000000001b3', '0a000000-0000-0000-0000-0000000001b4')), 0, 'manager cannot read a non-report''s thread');
select pg_temp.assert_raises($q$ insert into public.leave_allocations (organization_id, employee_id, leave_type_id, branch_id, year, allocated_days) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-0000000001a1', '0a000000-0000-0000-0000-00000000000b', 2027, 40) $q$, 'a line manager does not allocate leave');
select pg_temp.assert_raises($q$ update public.comp_off_credits set status = 'approved', expires_on = '2026-12-10' where id = '0a000000-0000-0000-0000-0000000007e1' $q$, 'a line manager decides credits through the engine only');
rollback;

-- ---------- Approval assignee (a member with no leave key at all, seated on the LEAVE request of one leave) ----------
-- Self-contained and rolled back: its own member, leave, thread and request (a pending request is unique per leave, so it
-- does not reuse 1b1, which rls_approvals.sql routes later).
begin;
insert into auth.users (id, email) values ('a0000000-0000-0000-0000-0000000007a8', 'leave-assignee-a@test.local');
insert into public.user_profiles (id, email, full_name) values ('a0000000-0000-0000-0000-0000000007a8', 'leave-assignee-a@test.local', 'Leave Assignee A');
insert into public.org_memberships (organization_id, user_id, role_id, status, all_branches) values
  ('0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-0000000007a8', '10000000-0000-0000-0000-000000000008', 'active', true);
insert into public.leave_records (id, organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, status) values
  ('0a000000-0000-0000-0000-0000000007b8', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-0000000001a1', '2027-02-01', '2027-02-02', 'PENDING');
insert into public.leave_request_comments (organization_id, leave_record_id, author_user_id, body, kind) values
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000007b8', 'a0000000-0000-0000-0000-000000000001', 'Who covers the week?', 'comment');
insert into public.approval_requests (id, organization_id, entity_type, entity_id, branch_id, employee_id, subject_user_id, current_step, status, requested_by) values
  ('0a000000-0000-0000-0000-0000000007f1', '0a000000-0000-0000-0000-000000000000', 'LEAVE', '0a000000-0000-0000-0000-0000000007b8', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-0000000000e1', null, 1, 'PENDING', 'a0000000-0000-0000-0000-000000000001');
insert into public.approval_steps (id, organization_id, request_id, step_no, approver_type, status, mode) values
  ('0a000000-0000-0000-0000-0000000007f2', '0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000007f1', 1, 'USER', 'PENDING', 'ANY');
insert into public.approval_step_actors (organization_id, step_id, user_id, resolution_path) values
  ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000007f2', 'a0000000-0000-0000-0000-0000000007a8', 'user');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-0000000007a8","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.leave_request_comments), 1, 'assignee reads the thread of the leave routed to them only');
select pg_temp.assert_rows($q$ insert into public.leave_request_comments (organization_id, leave_record_id, author_user_id, body, kind) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000007b8', 'a0000000-0000-0000-0000-0000000007a8', 'Looks fine to me', 'comment') $q$, 1, 'assignee comments on it');
select pg_temp.assert_raises($q$ insert into public.leave_request_comments (organization_id, leave_record_id, author_user_id, body, kind) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000001b3', 'a0000000-0000-0000-0000-0000000007a8', 'Not routed to me', 'comment') $q$, 'assignee cannot comment on a leave not routed to them');
select pg_temp.assert_eq((select count(*) from public.leave_allocations), 0, 'assignee reads no allocations');
select pg_temp.assert_eq((select count(*) from public.comp_off_credits), 0, 'assignee reads no comp-off credits');
rollback;

-- ---------- Owner A (organisation-wide) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.leave_allocations), 2, 'owner A reads every allocation of org A');
select pg_temp.assert_eq((select count(*) from public.comp_off_credits), 2, 'owner A reads every credit of org A');
select pg_temp.assert_eq((select count(*) from public.leave_request_comments), 3, 'owner A reads every thread of org A');
-- 10-S7: leave.manage reads, the API writes (in its system step, after the permission / branch / segregation checks)
select pg_temp.assert_guarded($q$ insert into public.leave_allocations (organization_id, employee_id, leave_type_id, branch_id, year, allocated_days) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-0000000001a1', '0a000000-0000-0000-0000-00000000000b', 2027, 30) $q$, '10-S7 owner A (leave.manage) cannot allocate leave directly');
select pg_temp.assert_guarded($q$ update public.leave_allocations set adjustment_days = 1.5 where id = '0a000000-0000-0000-0000-0000000007c1' $q$, '10-S7 owner A cannot adjust an allocation directly');
select pg_temp.assert_raises($q$ insert into public.leave_allocations (organization_id, employee_id, leave_type_id, branch_id, year, allocated_days) values ('0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '0b000000-0000-0000-0000-0000000007a1', '0b000000-0000-0000-0000-00000000000b', 2027, 30) $q$, 'owner A cannot allocate in org B');
select pg_temp.assert_raises($q$ insert into public.leave_request_comments (organization_id, leave_record_id, author_user_id, body, kind) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000001b1', 'a0000000-0000-0000-0000-000000000001', 'Please clarify', 'info_request') $q$, 'even the owner writes questions through the engine only');
select pg_temp.assert_raises($q$ update public.leave_request_comments set body = 'x' where id = '0a000000-0000-0000-0000-0000000007d1' $q$, 'the owner cannot rewrite a comment');
select pg_temp.assert_eq((select count(*) from public.leave_allocations where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'owner A sees nothing of org B (allocations)');
select pg_temp.assert_eq((select count(*) from public.comp_off_credits where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'owner A sees nothing of org B (credits)');
select pg_temp.assert_eq((select count(*) from public.leave_request_comments where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'owner A sees nothing of org B (threads)');
-- nor somebody ELSE's rows (e3 is not the owner's employee record): the API writes them after its checks
select pg_temp.assert_guarded($q$ insert into public.comp_off_credits (organization_id, employee_id, branch_id, worked_on, worked_on_type, worked_minutes, days_earned, location, summary, status, created_by) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '2026-09-18', 'weekly_off', 480, 1, 'Site', 'Audit', 'pending_approval', 'a0000000-0000-0000-0000-000000000001') $q$, '10-S7 owner A cannot record a credit for an employee directly');
select pg_temp.assert_guarded($q$ insert into public.leave_records (organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, is_half_day, half_day_part, status, created_by, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000001a1', '2026-11-15', '2026-11-15', true, 'FIRST_HALF', 'APPROVED', 'a0000000-0000-0000-0000-000000000001', 'Around the engine') $q$, '10-S7 owner A cannot record approved leave around the approval engine');
select pg_temp.assert_guarded($q$ update public.leave_records set status = 'APPROVED' where id = '0a000000-0000-0000-0000-0000000001b1' $q$, '10-S7 owner A cannot approve a pending leave around the approval engine');
rollback;

-- ---------- the system step (the API after its checks): the table rules hold for the only writer ----------
begin;
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system","org_id":"0a000000-0000-0000-0000-000000000000"}', true);
select pg_temp.assert_rows($q$ insert into public.leave_allocations (organization_id, employee_id, leave_type_id, branch_id, year, allocated_days) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-0000000001a1', '0a000000-0000-0000-0000-00000000000b', 2027, 30) $q$, 1, 'the system step allocates leave');
select pg_temp.assert_rows($q$ update public.leave_allocations set adjustment_days = 1.5 where id = '0a000000-0000-0000-0000-0000000007c1' $q$, 1, 'the system step adjusts an allocation');
select pg_temp.assert_raises($q$ insert into public.leave_allocations (organization_id, employee_id, leave_type_id, branch_id, year, allocated_days) values ('0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '0b000000-0000-0000-0000-0000000007a1', '0b000000-0000-0000-0000-00000000000b', 2027, 30) $q$, 'the system step of org A cannot allocate in org B');
select pg_temp.assert_rows($q$ update public.leave_allocations set adjustment_days = 1 where id = '0b000000-0000-0000-0000-0000000007c1' $q$, 0, 'the system step of org A cannot touch org B''s allocation');
select pg_temp.assert_raises($q$ insert into public.leave_allocations (organization_id, employee_id, leave_type_id, branch_id, year, allocated_days) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-0000000001a1', '0a000000-0000-0000-0000-00000000000b', 2026, 1) $q$, 'one allocation row per employee, type and year');
select pg_temp.assert_rows($q$ insert into public.comp_off_credits (organization_id, employee_id, branch_id, worked_on, worked_on_type, worked_minutes, days_earned, location, summary, status, created_by) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '2026-09-18', 'weekly_off', 480, 1, 'Site', 'Audit', 'pending_approval', 'a0000000-0000-0000-0000-000000000001') $q$, 1, 'the system step records a credit for an employee');
select pg_temp.assert_raises($q$ insert into public.comp_off_credits (organization_id, employee_id, branch_id, worked_on, worked_on_type, worked_minutes, days_earned, location, summary, status, created_by) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '2026-09-18', 'weekly_off', 480, 1, 'Site', 'Twice', 'pending_approval', 'a0000000-0000-0000-0000-000000000001') $q$, 'one active credit per worked day');
-- the overlap rule (exclusion constraint): half days of one date coexist, anything else clashes
select pg_temp.assert_rows($q$ insert into public.leave_records (organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, is_half_day, half_day_part, status, created_by, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000001a1', '2026-11-15', '2026-11-15', true, 'FIRST_HALF', 'PENDING', 'a0000000-0000-0000-0000-000000000001', 'Morning') $q$, 1, 'first half');
select pg_temp.assert_rows($q$ insert into public.leave_records (organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, is_half_day, half_day_part, status, created_by, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000001a1', '2026-11-15', '2026-11-15', true, 'SECOND_HALF', 'PENDING', 'a0000000-0000-0000-0000-000000000001', 'Afternoon') $q$, 1, 'second half of the same date');
select pg_temp.assert_raises($q$ insert into public.leave_records (organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, status, created_by, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000001a1', '2026-11-14', '2026-11-16', 'PENDING', 'a0000000-0000-0000-0000-000000000001', 'Overlap') $q$, 'a full day over two half days is refused (exclusion constraint)');
-- the withdrawal (self-service or HR cancel): written here, with the approval request cancelled in the same transaction by the API
select pg_temp.assert_rows($q$ update public.leave_records set status = 'CANCELLED', withdrawn_at = now() where id = '0a000000-0000-0000-0000-0000000001b3' $q$, 1, 'the system step withdraws a pending request');
select pg_temp.assert_raises($q$ update public.leave_records set organization_id = '0b000000-0000-0000-0000-000000000000' where id = '0a000000-0000-0000-0000-0000000001b4' $q$, 'a leave record never moves to another organisation');
select pg_temp.assert_raises($q$ update public.comp_off_credits set organization_id = '0b000000-0000-0000-0000-000000000000' where id = '0a000000-0000-0000-0000-0000000007e3' $q$, 'a comp-off credit never moves to another organisation');
rollback;

-- ---------- Branch Manager A (A-2 only; leave.view + leave.manage) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.leave_allocations), 1, 'branch manager reads the allocations of the branch only');
select pg_temp.assert_eq((select count(*) from public.comp_off_credits), 1, 'branch manager reads the credits of the branch only');
select pg_temp.assert_eq((select count(*) from public.comp_off_usages), 1, 'branch manager reads the usage of the branch only');
select pg_temp.assert_raises($q$ insert into public.leave_allocations (organization_id, employee_id, leave_type_id, branch_id, year, allocated_days) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-0000000001a1', '0a000000-0000-0000-0000-00000000000b', 2028, 30) $q$, 'branch manager cannot allocate outside the branch');
select pg_temp.assert_guarded($q$ insert into public.leave_allocations (organization_id, employee_id, leave_type_id, branch_id, year, allocated_days) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-0000000001a1', '0a000000-0000-0000-0000-00000000000c', 2027, 30) $q$, '10-S7 branch manager cannot allocate directly, even in the branch (the API checks the branch, then writes)');
rollback;

-- ---------- Review P0-2: the subject guard — leave.manage holders acting on THEMSELVES ----------
-- The review's probes RLS-1…4 as an HR user, a branch manager and an organisation admin, each linked to their own employee
-- record: every write on their own leave / credits / allocation is refused from a client session (the API does it after
-- its segregation-of-duties checks). Since the security gate (20260928001100) the refusal comes first from the missing client
-- write privilege — the withdrawal and the same person's writes on somebody ELSE's rows included (the API writes them in its
-- system step). `subject_guard_layer` then re-opens the client privilege inside the transaction to prove the subject guard
-- still refuses on its own (defense in depth). Fixtures and writes are rolled back.
create or replace function pg_temp.subject_guard_fixtures(p_label text, p_user uuid, p_role uuid, p_all_branches boolean, p_emp uuid, p_branch uuid, p_other_emp uuid, p_other_branch uuid) returns void language plpgsql as $$
begin
  insert into auth.users (id, email) values (p_user, p_label || '-self@test.local') on conflict do nothing;
  insert into public.user_profiles (id, email, full_name) values (p_user, p_label || '-self@test.local', p_label) on conflict do nothing;
  insert into public.employees (id, organization_id, employee_number, first_name, last_name, display_name, joining_date, branch_id, device_user_id)
  values (p_emp, '0a000000-0000-0000-0000-000000000000', 'SG-' || p_label, 'Self', p_label, 'Self ' || p_label, '2025-01-01', p_branch, 'sg-' || p_label)
  on conflict (id) do nothing;
  insert into public.org_memberships (organization_id, user_id, role_id, status, all_branches, employee_id)
  values ('0a000000-0000-0000-0000-000000000000', p_user, p_role, 'active', p_all_branches, p_emp)
  on conflict (organization_id, user_id) do update set employee_id = excluded.employee_id;
  insert into public.leave_records (id, organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, status, days, created_by) values
    (md5(p_label || ':pending')::uuid, '0a000000-0000-0000-0000-000000000000', p_emp, p_branch, '0a000000-0000-0000-0000-0000000001a1', '2026-12-20', '2026-12-21', 'PENDING', 2, p_user),
    (md5(p_label || ':approved')::uuid, '0a000000-0000-0000-0000-000000000000', p_emp, p_branch, '0a000000-0000-0000-0000-0000000001a1', '2026-12-06', '2026-12-06', 'APPROVED', 1, p_user);
  insert into public.comp_off_credits (id, organization_id, employee_id, branch_id, worked_on, worked_on_type, worked_minutes, days_earned, location, summary, status, created_by) values
    (md5(p_label || ':credit')::uuid, '0a000000-0000-0000-0000-000000000000', p_emp, p_branch, '2026-09-19', 'weekly_off', 240, 0.5, 'Site', 'Own claim', 'pending_approval', p_user),
    (md5(p_label || ':other-credit')::uuid, '0a000000-0000-0000-0000-000000000000', p_other_emp, p_other_branch, '2026-09-26', 'weekly_off', 480, 1, 'Site', 'A colleague''s claim', 'pending_approval', p_user);
  insert into public.leave_allocations (id, organization_id, employee_id, leave_type_id, branch_id, year, allocated_days) values
    (md5(p_label || ':alloc')::uuid, '0a000000-0000-0000-0000-000000000000', p_emp, '0a000000-0000-0000-0000-0000000001a1', p_branch, 2026, 10);
end $$;

create or replace function pg_temp.subject_guard_checks(p_label text, p_user uuid, p_emp uuid, p_branch uuid, p_other_emp uuid, p_other_branch uuid) returns void language plpgsql as $$
declare
  v_pending text := md5(p_label || ':pending')::uuid::text;
  v_approved text := md5(p_label || ':approved')::uuid::text;
  v_credit text := md5(p_label || ':credit')::uuid::text;
  v_other_credit text := md5(p_label || ':other-credit')::uuid::text;
  v_alloc text := md5(p_label || ':alloc')::uuid::text;
begin
  if not (p_emp = any (app.own_employee_ids())) then raise exception 'ASSERT FAILED: % is not linked to their own employee record', p_label; end if;
  -- RLS-1: deciding one's own leave (and the other ways of moving it)
  perform pg_temp.assert_guarded(format($f$ update public.leave_records set status = 'APPROVED', approved_by = %L, approved_at = now() where id = %L $f$, p_user, v_pending), format('7-P0-2 RLS-1 a %s cannot approve their own leave through RLS', p_label));
  perform pg_temp.assert_guarded(format($f$ update public.leave_records set status = 'REJECTED' where id = %L $f$, v_pending), format('7-P0-2 a %s cannot reject their own leave through RLS', p_label));
  perform pg_temp.assert_guarded(format($f$ update public.leave_records set days = 0.5 where id = %L $f$, v_pending), format('7-P0-2 a %s cannot change the days of their own leave through RLS', p_label));
  perform pg_temp.assert_guarded(format($f$ update public.leave_records set end_date = end_date + 2 where id = %L $f$, v_pending), format('7-P0-2 a %s cannot move their own request through RLS (the API resubmits it)', p_label));
  perform pg_temp.assert_guarded(format($f$ update public.leave_records set end_date = end_date + 4, days = 5 where id = %L $f$, v_approved), format('7-P0-1/P0-2 SOD-1 a %s cannot correct their own approved leave through RLS', p_label));
  perform pg_temp.assert_guarded(format($f$ update public.leave_records set status = 'CANCELLED' where id = %L $f$, v_approved), format('7-P0-2 a %s cancels their own approved leave through the API only (the past days are recomputed)', p_label));
  perform pg_temp.assert_guarded(format($f$ delete from public.leave_records where id = %L $f$, v_approved), format('7-P0-2 a %s cannot delete their own leave', p_label));
  perform pg_temp.assert_guarded(format($f$ insert into public.leave_records (organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, status, created_by, reason) values ('0a000000-0000-0000-0000-000000000000', %L, %L, '0a000000-0000-0000-0000-0000000001a1', '2027-01-10', '2027-01-11', 'APPROVED', %L, 'Own') $f$, p_emp, p_branch, p_user), format('7-P0-2 a %s cannot insert their own (approved) leave through RLS', p_label));
  perform pg_temp.assert_guarded(format($f$ insert into public.leave_records (organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, status, created_by, reason) values ('0a000000-0000-0000-0000-000000000000', %L, %L, '0a000000-0000-0000-0000-0000000001a1', '2027-01-17', '2027-01-18', 'PENDING', %L, 'Own') $f$, p_emp, p_branch, p_user), format('7-P2-10 a %s files their own leave through the API only', p_label));
  -- RLS-2 / RLS-3: comp-off credits
  perform pg_temp.assert_guarded(format($f$ update public.comp_off_credits set status = 'approved', expires_on = '2099-12-31', days_earned = 1.0, worked_minutes = 600 where id = %L $f$, v_credit), format('7-P0-2 RLS-2 a %s cannot approve / extend / raise their own comp-off credit through RLS', p_label));
  perform pg_temp.assert_guarded(format($f$ update public.comp_off_credits set summary = 'edited' where id = %L $f$, v_credit), format('7-P0-2 a %s cannot edit their own comp-off credit through RLS', p_label));
  perform pg_temp.assert_guarded(format($f$ insert into public.comp_off_credits (organization_id, employee_id, branch_id, worked_on, worked_on_type, worked_minutes, days_earned, location, summary, status, expires_on, created_by) values ('0a000000-0000-0000-0000-000000000000', %L, %L, '2026-09-12', 'holiday', 600, 1.0, 'Nowhere', 'Minted', 'approved', '2099-12-31', %L) $f$, p_emp, p_branch, p_user), format('7-P0-2 RLS-3 a %s cannot mint an approved credit for themselves', p_label));
  perform pg_temp.assert_guarded(format($f$ delete from public.comp_off_credits where id = %L $f$, v_credit), format('7-P0-2 a %s cannot delete their own credit', p_label));
  -- RLS-4: allocations
  perform pg_temp.assert_guarded(format($f$ insert into public.leave_allocations (organization_id, employee_id, leave_type_id, branch_id, year, allocated_days, adjustment_days) values ('0a000000-0000-0000-0000-000000000000', %L, '0a000000-0000-0000-0000-0000000001a1', %L, 2027, 366, 366) $f$, p_emp, p_branch), format('7-P0-2 RLS-4 a %s cannot allocate leave to themselves', p_label));
  perform pg_temp.assert_guarded(format($f$ update public.leave_allocations set adjustment_days = 366 where id = %L $f$, v_alloc), format('7-P0-2 a %s cannot raise their own allocation', p_label));
  perform pg_temp.assert_guarded(format($f$ delete from public.leave_allocations where id = %L $f$, v_alloc), format('7-P0-2 a %s cannot delete their own allocation (falling back to a larger type allowance)', p_label));
  -- 10-S7: the withdrawal goes through the API too (it cancels the approval request in the same transaction)
  perform pg_temp.assert_guarded(format($f$ update public.leave_records set status = 'CANCELLED', withdrawn_at = now() where id = %L $f$, v_pending), format('10-S7 a %s withdraws their own pending request through the API only', p_label));
  -- 10-S7: and somebody ELSE's rows as well — the API writes them after the permission / branch checks
  perform pg_temp.assert_guarded(format($f$ insert into public.leave_allocations (organization_id, employee_id, leave_type_id, branch_id, year, allocated_days) values ('0a000000-0000-0000-0000-000000000000', %L, '0a000000-0000-0000-0000-0000000001a1', %L, 2028, 12) $f$, p_other_emp, p_other_branch), format('10-S7 a %s allocates leave to a colleague through the API only', p_label));
  perform pg_temp.assert_guarded(format($f$ update public.comp_off_credits set decision_note = 'Checked the gate log' where id = %L $f$, v_other_credit), format('10-S7 a %s writes a colleague''s credit through the API only', p_label));
end $$;

-- defense in depth: with the client INSERT privilege re-opened (rolled back), the subject guard still refuses a write about
-- oneself (BEFORE ROW triggers run before the row-security WITH CHECK, so it is the guard that answers)
create or replace function pg_temp.subject_guard_layer(p_label text, p_user uuid, p_emp uuid, p_branch uuid) returns void language plpgsql as $$
begin
  perform pg_temp.assert_subject_guard(format($f$ insert into public.leave_records (organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, status, created_by, reason) values ('0a000000-0000-0000-0000-000000000000', %L, %L, '0a000000-0000-0000-0000-0000000001a1', '2027-01-10', '2027-01-11', 'APPROVED', %L, 'Own') $f$, p_emp, p_branch, p_user), format('7-P0-2 guard: a %s cannot insert their own (approved) leave', p_label));
  perform pg_temp.assert_subject_guard(format($f$ insert into public.comp_off_credits (organization_id, employee_id, branch_id, worked_on, worked_on_type, worked_minutes, days_earned, location, summary, status, expires_on, created_by) values ('0a000000-0000-0000-0000-000000000000', %L, %L, '2026-09-12', 'holiday', 600, 1.0, 'Nowhere', 'Minted', 'approved', '2099-12-31', %L) $f$, p_emp, p_branch, p_user), format('7-P0-2 guard: a %s cannot mint an approved credit for themselves', p_label));
  perform pg_temp.assert_subject_guard(format($f$ insert into public.leave_allocations (organization_id, employee_id, leave_type_id, branch_id, year, allocated_days, adjustment_days) values ('0a000000-0000-0000-0000-000000000000', %L, '0a000000-0000-0000-0000-0000000001a1', %L, 2027, 366, 366) $f$, p_emp, p_branch), format('7-P0-2 guard: a %s cannot allocate leave to themselves', p_label));
end $$;
grant execute on all functions in schema pg_temp to public;

-- an HR user (hr_user: leave.manage + leave.approve, all branches), linked to their own record in A-2
begin;
select pg_temp.subject_guard_fixtures('hr_user', 'a0000000-0000-0000-0000-0000000007c1', '10000000-0000-0000-0000-000000000004', true, '0a000000-0000-0000-0000-0000000007c7', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-0000000007c1","role":"authenticated"}', true);
select pg_temp.subject_guard_checks('hr_user', 'a0000000-0000-0000-0000-0000000007c1', '0a000000-0000-0000-0000-0000000007c7', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b');
reset role;
grant insert on public.leave_records, public.comp_off_credits, public.leave_allocations to authenticated;
set local role authenticated;
select pg_temp.subject_guard_layer('hr_user', 'a0000000-0000-0000-0000-0000000007c1', '0a000000-0000-0000-0000-0000000007c7', '0a000000-0000-0000-0000-00000000000c');
rollback;

-- the branch manager of A-2 (branch_manager: leave.manage + leave.approve), linked to e2 (A-2) — the review's own probe
begin;
select pg_temp.subject_guard_fixtures('branch_manager', 'a0000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000005', false, '0a000000-0000-0000-0000-0000000000e2', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000000e6', '0a000000-0000-0000-0000-00000000000c');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select pg_temp.subject_guard_checks('branch_manager', 'a0000000-0000-0000-0000-000000000002', '0a000000-0000-0000-0000-0000000000e2', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000000e6', '0a000000-0000-0000-0000-00000000000c');
reset role;
grant insert on public.leave_records, public.comp_off_credits, public.leave_allocations to authenticated;
set local role authenticated;
select pg_temp.subject_guard_layer('branch_manager', 'a0000000-0000-0000-0000-000000000002', '0a000000-0000-0000-0000-0000000000e2', '0a000000-0000-0000-0000-00000000000c');
rollback;

-- an organisation admin (org_admin: every leave key, all branches), linked to their own record at HQ
begin;
select pg_temp.subject_guard_fixtures('org_admin', 'a0000000-0000-0000-0000-0000000007c2', '10000000-0000-0000-0000-000000000002', true, '0a000000-0000-0000-0000-0000000007c8', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-0000000007c2","role":"authenticated"}', true);
select pg_temp.subject_guard_checks('org_admin', 'a0000000-0000-0000-0000-0000000007c2', '0a000000-0000-0000-0000-0000000007c8', '0a000000-0000-0000-0000-00000000000b', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b');
reset role;
grant insert on public.leave_records, public.comp_off_credits, public.leave_allocations to authenticated;
set local role authenticated;
select pg_temp.subject_guard_layer('org_admin', 'a0000000-0000-0000-0000-0000000007c2', '0a000000-0000-0000-0000-0000000007c8', '0a000000-0000-0000-0000-00000000000b');
rollback;

-- ---------- Auditor A (read-only) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000007","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.leave_allocations), 2, 'auditor reads the allocations');
select pg_temp.assert_eq((select count(*) from public.comp_off_credits), 2, 'auditor reads the credits');
select pg_temp.assert_raises($q$ insert into public.leave_allocations (organization_id, employee_id, leave_type_id, branch_id, year, allocated_days) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-0000000001a1', '0a000000-0000-0000-0000-00000000000b', 2029, 30) $q$, 'auditor cannot allocate');
select pg_temp.assert_raises($q$ update public.comp_off_credits set status = 'approved', expires_on = '2026-12-10' where id = '0a000000-0000-0000-0000-0000000007e1' $q$, 'auditor cannot decide a credit');
rollback;

-- ---------- Owner B (another tenant) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.leave_allocations), 1, 'owner B reads org B''s allocation only');
select pg_temp.assert_eq((select count(*) from public.comp_off_credits), 1, 'owner B reads org B''s credit only');
select pg_temp.assert_eq((select count(*) from public.comp_off_usages), 0, 'owner B reads no usage of org A');
select pg_temp.assert_eq((select count(*) from public.leave_request_comments), 1, 'owner B reads org B''s thread only');
select pg_temp.assert_raises($q$ insert into public.leave_request_comments (organization_id, leave_record_id, author_user_id, body, kind) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000001b1', 'b0000000-0000-0000-0000-000000000001', 'Cross-tenant', 'comment') $q$, 'owner B cannot comment on org A''s leave');
rollback;

-- ---------- anon ----------
begin;
set local role anon;
select pg_temp.assert_raises($q$ select count(*) from public.leave_allocations $q$, 'anon cannot read allocations');
select pg_temp.assert_raises($q$ select count(*) from public.leave_request_comments $q$, 'anon cannot read threads');
select pg_temp.assert_raises($q$ select count(*) from public.comp_off_credits $q$, 'anon cannot read credits');
rollback;

\echo 'rls_leave: all assertions passed'
