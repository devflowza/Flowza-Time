-- Leave v2 RLS (migration 20260928000700): leave allocations, the append-only comment thread, comp-off credits and their
-- usage, the self-service edit / withdraw policy + guard on leave records and the half-day aware overlap constraint. Who
-- reads what: the employee their own rows, a line manager their direct reports' (leave.view_team), HR the organisation
-- (branch-scoped), the auditor read-only, an approval assignee the thread of the leave routed to them — and nobody anything
-- of another tenant. Runs after rls_isolation.sql and rls_approvals.sql (their fixtures are committed) as superuser.
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
-- Org A: allocations for e1 (HQ, report of manager-a) and e3 (A-2, the self-service employee emp-a); comments on e1's
-- pending leave (1b1, the leave routed to assignee-a by rls_approvals.sql), e3's pending (1b3) and approved (1b4) leave;
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
select pg_temp.assert_rows($q$ update public.leave_request_comments set body = 'edited' where id = '0a000000-0000-0000-0000-0000000007d3' $q$, 0, 'comments are never updated by clients');
select pg_temp.assert_rows($q$ delete from public.leave_request_comments where id = '0a000000-0000-0000-0000-0000000007d3' $q$, 0, 'comments are never deleted by clients');
select pg_temp.assert_raises($q$ insert into public.leave_allocations (organization_id, employee_id, leave_type_id, branch_id, year, allocated_days) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-0000000001a1', '0a000000-0000-0000-0000-00000000000c', 2027, 99) $q$, 'employee cannot allocate leave (leave.manage)');
select pg_temp.assert_rows($q$ update public.leave_allocations set allocated_days = 99 where id = '0a000000-0000-0000-0000-0000000007c3' $q$, 0, 'employee cannot change own allocation');
select pg_temp.assert_rows($q$ insert into public.comp_off_credits (organization_id, employee_id, branch_id, worked_on, worked_on_type, worked_minutes, days_earned, location, summary, status, created_by) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '2026-09-18', 'weekly_off', 480, 1, 'Site', 'Audit', 'pending_approval', 'a0000000-0000-0000-0000-000000000003') $q$, 1, 'employee requests a comp-off credit for themselves (pending)');
select pg_temp.assert_raises($q$ insert into public.comp_off_credits (organization_id, employee_id, branch_id, worked_on, worked_on_type, worked_minutes, days_earned, location, summary, status, expires_on, created_by) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '2026-09-25', 'weekly_off', 480, 1, 'Site', 'Audit', 'approved', '2026-12-24', 'a0000000-0000-0000-0000-000000000003') $q$, 'employee cannot insert an approved credit');
select pg_temp.assert_raises($q$ insert into public.comp_off_credits (organization_id, employee_id, branch_id, worked_on, worked_on_type, worked_minutes, days_earned, location, summary, status, created_by) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '2026-09-25', 'weekly_off', 480, 1, 'HQ', 'Not mine', 'pending_approval', 'a0000000-0000-0000-0000-000000000003') $q$, 'employee cannot request a credit for somebody else');
select pg_temp.assert_raises($q$ insert into public.comp_off_credits (organization_id, employee_id, branch_id, worked_on, worked_on_type, worked_minutes, days_earned, location, summary, status, created_by) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '2026-09-18', 'weekly_off', 480, 1, 'Site', 'Twice', 'pending_approval', 'a0000000-0000-0000-0000-000000000003') $q$, 'one active credit per worked day');
select pg_temp.assert_rows($q$ update public.comp_off_credits set used_days = 0, status = 'approved' where id = '0a000000-0000-0000-0000-0000000007e3' $q$, 0, 'employee cannot restore a used credit');
select pg_temp.assert_raises($q$ insert into public.comp_off_usages (organization_id, employee_id, branch_id, credit_id, leave_record_id, days) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000007e3', '0a000000-0000-0000-0000-0000000001b3', 1) $q$, 'usages are written by the system only');
-- self-service edit / withdraw (policy leave_records_self_update + guard)
select pg_temp.assert_rows($q$ update public.leave_records set end_date = '2026-10-13', days = 3, edited_at = now() where id = '0a000000-0000-0000-0000-0000000001b3' $q$, 1, 'employee edits the dates of own pending request');
select pg_temp.assert_raises($q$ update public.leave_records set approval_request_id = null, decision_note = 'self-approved' where id = '0a000000-0000-0000-0000-0000000001b3' $q$, 'an edit cannot touch the decision or the approval link');
select pg_temp.assert_raises($q$ update public.leave_records set status = 'APPROVED' where id = '0a000000-0000-0000-0000-0000000001b3' $q$, 'employee cannot approve through an edit');
select pg_temp.assert_rows($q$ update public.leave_records set status = 'CANCELLED', withdrawn_at = now() where id = '0a000000-0000-0000-0000-0000000001b3' $q$, 1, 'employee withdraws own pending request (with the withdrawal stamp)');
select pg_temp.assert_rows($q$ update public.leave_records set end_date = '2026-08-04' where id = '0a000000-0000-0000-0000-0000000001b4' $q$, 0, 'decided leave is not the employee''s to edit');
-- the overlap rule (exclusion constraint): half days of one date coexist, anything else clashes
select pg_temp.assert_rows($q$ insert into public.leave_records (organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, is_half_day, half_day_part, status, created_by, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000001a1', '2026-11-15', '2026-11-15', true, 'FIRST_HALF', 'PENDING', 'a0000000-0000-0000-0000-000000000003', 'Morning') $q$, 1, 'first half');
select pg_temp.assert_rows($q$ insert into public.leave_records (organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, is_half_day, half_day_part, status, created_by, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000001a1', '2026-11-15', '2026-11-15', true, 'SECOND_HALF', 'PENDING', 'a0000000-0000-0000-0000-000000000003', 'Afternoon') $q$, 1, 'second half of the same date');
select pg_temp.assert_raises($q$ insert into public.leave_records (organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, status, created_by, reason) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-00000000000c', '0a000000-0000-0000-0000-0000000001a1', '2026-11-14', '2026-11-16', 'PENDING', 'a0000000-0000-0000-0000-000000000003', 'Overlap') $q$, 'a full day over two half days is refused (exclusion constraint)');
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
select pg_temp.assert_rows($q$ update public.comp_off_credits set status = 'approved', expires_on = '2026-12-10' where id = '0a000000-0000-0000-0000-0000000007e1' $q$, 0, 'a line manager decides credits through the engine only');
rollback;

-- ---------- Approval assignee (rls_approvals.sql: R1 is the LEAVE request of 1b1, routed to assignee-a — no key at all) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000008","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.leave_request_comments), 1, 'assignee reads the thread of the leave routed to them only');
select pg_temp.assert_rows($q$ insert into public.leave_request_comments (organization_id, leave_record_id, author_user_id, body, kind) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000001b1', 'a0000000-0000-0000-0000-000000000008', 'Looks fine to me', 'comment') $q$, 1, 'assignee comments on it');
select pg_temp.assert_eq((select count(*) from public.leave_allocations), 0, 'assignee reads no allocations');
rollback;

-- ---------- Owner A (organisation-wide) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.leave_allocations), 2, 'owner A reads every allocation of org A');
select pg_temp.assert_eq((select count(*) from public.comp_off_credits), 2, 'owner A reads every credit of org A');
select pg_temp.assert_eq((select count(*) from public.leave_request_comments), 3, 'owner A reads every thread of org A');
select pg_temp.assert_rows($q$ insert into public.leave_allocations (organization_id, employee_id, leave_type_id, branch_id, year, allocated_days) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-0000000001a1', '0a000000-0000-0000-0000-00000000000b', 2027, 30) $q$, 1, 'owner A allocates leave');
select pg_temp.assert_rows($q$ update public.leave_allocations set adjustment_days = 1.5 where id = '0a000000-0000-0000-0000-0000000007c1' $q$, 1, 'owner A adjusts an allocation');
select pg_temp.assert_raises($q$ insert into public.leave_allocations (organization_id, employee_id, leave_type_id, branch_id, year, allocated_days) values ('0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '0b000000-0000-0000-0000-0000000007a1', '0b000000-0000-0000-0000-00000000000b', 2027, 30) $q$, 'owner A cannot allocate in org B');
select pg_temp.assert_raises($q$ insert into public.leave_allocations (organization_id, employee_id, leave_type_id, branch_id, year, allocated_days) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-0000000001a1', '0a000000-0000-0000-0000-00000000000b', 2026, 1) $q$, 'one allocation row per employee, type and year');
select pg_temp.assert_raises($q$ insert into public.leave_request_comments (organization_id, leave_record_id, author_user_id, body, kind) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000001b1', 'a0000000-0000-0000-0000-000000000001', 'Please clarify', 'info_request') $q$, 'even the owner writes questions through the engine only');
select pg_temp.assert_rows($q$ update public.leave_request_comments set body = 'x' where id = '0a000000-0000-0000-0000-0000000007d1' $q$, 0, 'the owner cannot rewrite a comment');
select pg_temp.assert_eq((select count(*) from public.leave_allocations where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'owner A sees nothing of org B (allocations)');
select pg_temp.assert_eq((select count(*) from public.comp_off_credits where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'owner A sees nothing of org B (credits)');
select pg_temp.assert_eq((select count(*) from public.leave_request_comments where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'owner A sees nothing of org B (threads)');
rollback;

-- ---------- Branch Manager A (A-2 only; leave.view + leave.manage) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.leave_allocations), 1, 'branch manager reads the allocations of the branch only');
select pg_temp.assert_eq((select count(*) from public.comp_off_credits), 1, 'branch manager reads the credits of the branch only');
select pg_temp.assert_eq((select count(*) from public.comp_off_usages), 1, 'branch manager reads the usage of the branch only');
select pg_temp.assert_raises($q$ insert into public.leave_allocations (organization_id, employee_id, leave_type_id, branch_id, year, allocated_days) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-0000000001a1', '0a000000-0000-0000-0000-00000000000b', 2028, 30) $q$, 'branch manager cannot allocate outside the branch');
select pg_temp.assert_rows($q$ insert into public.leave_allocations (organization_id, employee_id, leave_type_id, branch_id, year, allocated_days) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '0a000000-0000-0000-0000-0000000001a1', '0a000000-0000-0000-0000-00000000000c', 2027, 30) $q$, 1, 'branch manager allocates in the branch');
rollback;

-- ---------- Auditor A (read-only) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000007","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.leave_allocations), 2, 'auditor reads the allocations');
select pg_temp.assert_eq((select count(*) from public.comp_off_credits), 2, 'auditor reads the credits');
select pg_temp.assert_raises($q$ insert into public.leave_allocations (organization_id, employee_id, leave_type_id, branch_id, year, allocated_days) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-0000000001a1', '0a000000-0000-0000-0000-00000000000b', 2029, 30) $q$, 'auditor cannot allocate');
select pg_temp.assert_rows($q$ update public.comp_off_credits set status = 'approved', expires_on = '2026-12-10' where id = '0a000000-0000-0000-0000-0000000007e1' $q$, 0, 'auditor cannot decide a credit');
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
