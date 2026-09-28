-- EXPLAIN (ANALYZE, BUFFERS) of the queue reads (HR portal Prompt 10 — security gate; docs/hr-portal/reports/10-security-gate.md
-- §6), each in the execution context the application uses (role + JWT claims), inside a rolled-back transaction. Run after
-- scripts/perf/queue-volume.sql on a LOCAL seeded database.
\set ON_ERROR_STOP on
\pset pager off
select id as org from public.organizations where company_code = 'ALBAHJA' \gset
select u.id as hr from public.user_profiles u where u.email = 'hr@albahja.example' \gset
select u.id as mgr from public.user_profiles u where u.email = 'manager@albahja.example' \gset
select string_agg(quote_literal(e.id), ',') as team from public.employees e
  where e.manager_employee_id = (select employee_id from public.org_memberships where user_id = :'mgr' and organization_id = :'org') \gset
select string_agg(quote_literal(k), ',') as keys from (select dedupe_key as k from jobs.queue where status in ('pending', 'running') order by id limit 100) x \gset

\echo '==== 1. Approval inbox — "Mine", pending (apps/api/src/services/approvals/queries.ts listInbox), as hr@'
begin;
select set_config('role', 'authenticated', true), set_config('request.jwt.claims', json_build_object('sub', :'hr', 'role', 'authenticated')::text, true) \g /dev/null
\echo '-- 1a. the total'
explain (analyze, buffers, costs off, summary on)
select count(*) as n from public.approval_requests
where approval_requests.organization_id = :'org' and approval_requests.status = 'PENDING'
  and approval_requests.id in (select app.approval_actionable_request_ids(:'org'::uuid));
\echo '-- 1b. the first page'
explain (analyze, buffers, costs off, summary on)
select approval_requests.* from public.approval_requests
where approval_requests.organization_id = :'org' and approval_requests.status = 'PENDING'
  and approval_requests.id in (select app.approval_actionable_request_ids(:'org'::uuid))
order by approval_requests.created_at asc, approval_requests.id limit 25 offset 0;
rollback;

\echo '-- 1c. inside app.approval_actionable_request_ids (SECURITY DEFINER: runs as its owner)'
begin;
select set_config('request.jwt.claims', json_build_object('sub', :'hr', 'role', 'authenticated')::text, true) \g /dev/null
explain (analyze, buffers, costs off, summary on)
  with me as (
    select app.uid() as uid
    where exists (select 1 from public.org_memberships m where m.organization_id = :'org' and m.user_id = app.uid() and m.status = 'active')
  )
  select s.request_id
  from me
  join public.approval_step_actors a on a.user_id = me.uid and a.organization_id = :'org' and a.decision = 'PENDING'
  join public.approval_steps s on s.id = a.step_id and s.status = 'PENDING'
  join public.approval_requests r on r.id = s.request_id and r.status = 'PENDING' and r.current_step = s.step_no
  where a.via_delegation_of is null or app.approval_delegate_of(:'org', a.via_delegation_of, r.entity_type) = me.uid
  union
  select s.request_id
  from me
  join public.approval_delegations d on d.delegate_user_id = me.uid and d.organization_id = :'org' and d.is_active
  join public.approval_step_actors a on a.organization_id = :'org' and a.user_id = d.delegator_user_id and a.decision = 'PENDING'
  join public.approval_steps s on s.id = a.step_id and s.status = 'PENDING'
  join public.approval_requests r on r.id = s.request_id and r.status = 'PENDING' and r.current_step = s.step_no
  where app.org_today(:'org') between d.starts_on and d.ends_on
    and app.approval_delegate_of(:'org', a.user_id, r.entity_type) = me.uid;
rollback;

\echo '==== 2. Team pending counts (apps/api/src/services/team.service.ts pendingCounts), as manager@'
begin;
select set_config('role', 'authenticated', true), set_config('request.jwt.claims', json_build_object('sub', :'mgr', 'role', 'authenticated')::text, true) \g /dev/null
\echo '-- 2a. approvals half'
explain (analyze, buffers, costs off, summary on)
select count(*)::text as n from app.approval_actionable_request_ids(:'org'::uuid);
\echo '-- 2b. reasons half (direct reports)'
explain (analyze, buffers, costs off, summary on)
select n.employee_id, count(*) as n from public.attendance_notes as n
where n.organization_id = :'org' and n.employee_id in (:team) and n.status = 'pending'
  and not exists (select r.id from public.approval_requests as r where r.organization_id = :'org' and r.entity_type = 'ATTENDANCE_NOTE' and r.entity_id = n.id and r.status = 'PENDING')
group by n.employee_id;
\echo '-- 2b*. the same, through the reason''s own request (recommended form, §6)'
explain (analyze, buffers, costs off, summary on)
select n.employee_id, count(*) as n from public.attendance_notes as n
where n.organization_id = :'org' and n.employee_id in (:team) and n.status = 'pending'
  and not exists (select r.id from public.approval_requests as r where r.id = n.approval_request_id and r.status = 'PENDING')
group by n.employee_id;
\echo '-- 2c. reasons half (seats the caller covers as the secondary manager)'
explain (analyze, buffers, costs off, summary on)
select distinct r.id, r.employee_id from public.approval_requests as r
inner join public.approval_steps as s on s.request_id = r.id and s.step_no = r.current_step
inner join public.approval_step_actors as a on a.step_id = s.id
inner join public.attendance_notes as n on n.id = r.entity_id and n.status = 'pending'
where r.organization_id = :'org' and r.entity_type = 'ATTENDANCE_NOTE' and r.status = 'PENDING' and s.status = 'PENDING'
  and a.user_id = :'mgr' and a.decision = 'PENDING' and a.resolution_path = 'secondary' and a.via_delegation_of is not null
  and n.employee_id <> '00000000-0000-0000-0000-000000000000';
rollback;

\echo '==== 3. Report schedule runner (apps/worker/src/tasks/reports.ts scheduleDueReports), platform context'
begin;
select set_config('role', 'flowza_system', true), set_config('request.jwt.claims', '{"role":"flowza_system","scope":"platform"}', true) \g /dev/null
\echo '-- 3a. due schedules'
explain (analyze, buffers, costs off, summary on)
select s.id, s.organization_id as "organizationId", s.next_run_at as "nextRunAt"
from public.report_schedules s join public.organizations o on o.id = s.organization_id
where s.is_active and s.next_run_at is not null and s.next_run_at <= now() and o.status in ('active', 'trial')
order by s.next_run_at, s.id
limit 200;
\echo '-- 3b. occurrences already queued or running'
explain (analyze, buffers, costs off, summary on)
select dedupe_key as "dedupeKey" from jobs.queue where dedupe_key = any(array[:keys]::text[]) and status in ('pending', 'running');
rollback;
