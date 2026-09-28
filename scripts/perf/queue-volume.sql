-- Queue volume for EXPLAIN (HR portal Prompt 10 — security gate; plans in docs/hr-portal/reports/10-security-gate.md §6).
-- A year of synthetic history on top of the deterministic seed, LOCAL databases only:
--   PGDATABASE=flowza_perf bash scripts/db-reset-local.sh --seed
--   psql -d flowza_perf -f scripts/perf/queue-volume.sql
--   psql -d flowza_perf -f scripts/perf/queue-explain.sql
-- 200 more organisations; 220k approval requests (10 % pending) with 2 seats each; a delegation per organisation; 60 days of
-- reasons for the seed's 500 employees; 5k report schedules; 205k jobs (5k pending, 50 running). Triggers and RI are off
-- (session_replication_role = replica) so a year is written in seconds; CHECK constraints still hold.
\set ON_ERROR_STOP on
set session_replication_role = replica;
set statement_timeout = '600s';

select id as seed_org from public.organizations where company_code = 'ALBAHJA' \gset
select u.id as hr from public.user_profiles u where u.email = 'hr@albahja.example' \gset
select u.id as mgr from public.user_profiles u where u.email = 'manager@albahja.example' \gset

insert into public.organizations (id, company_code, legal_name, display_name, timezone, status)
select ('f0000000-0000-4000-8000-' || lpad(to_hex(o), 12, '0'))::uuid, 'VOL-' || o, 'Volume ' || o, 'Volume ' || o, 'Asia/Muscat', 'active'
from generate_series(1, 200) o;

create temp table vol_org as
select 0 as o, :'seed_org'::uuid as id, 20000 as requests
union all
select o, ('f0000000-0000-4000-8000-' || lpad(to_hex(o), 12, '0'))::uuid, 1000 from generate_series(1, 200) o;

-- 20 approvers per organisation; in the seed organisation hr@ and manager@ are two of them
create temp table vol_approver as
select v.o, v.id as org_id, k,
       case when v.o = 0 and k = 0 then :'hr'::uuid when v.o = 0 and k = 1 then :'mgr'::uuid else md5('approver-' || v.o || '-' || k)::uuid end as user_id
from vol_org v, generate_series(0, 19) k;

create temp table seed_emp as select row_number() over (order by id) - 1 as n, id from public.employees where organization_id = :'seed_org';

create temp table vol_request as
select v.o, v.id as org_id, g,
       md5('request-' || v.o || '-' || g)::uuid as id,
       md5('step-' || v.o || '-' || g)::uuid as step_id,
       (array['ATTENDANCE_CORRECTION','LEAVE','ATTENDANCE_NOTE','REGULARISATION'])[1 + g % 4]::public.approval_entity as entity_type,
       case when g % 10 = 0 then 'PENDING' when g % 10 = 1 then 'REJECTED' else 'APPROVED' end::public.approval_status as status,
       now() - make_interval(hours => (g * 7919) % (365 * 24)) as created_at,
       case when v.o = 0 then (select id from seed_emp where n = g % 500) else md5('employee-' || v.o || '-' || (g % 300))::uuid end as employee_id
from vol_org v, generate_series(1, v.requests) g;

insert into public.approval_requests (id, organization_id, entity_type, entity_id, employee_id, status, current_step, created_at, completed_at, decided_by)
select r.id, r.org_id, r.entity_type, md5('entity-' || r.o || '-' || r.g)::uuid, r.employee_id, r.status, 1, r.created_at,
       case when r.status = 'PENDING' then null else r.created_at + interval '1 day' end,
       case when r.status = 'PENDING' then null else md5('approver-' || r.o || '-' || (r.g % 20))::uuid end
from vol_request r;

insert into public.approval_steps (id, organization_id, request_id, step_no, approver_type, status, activated_at, mode)
select r.step_id, r.org_id, r.id, 1, 'HR_ADMIN', r.status, r.created_at, 'ANY' from vol_request r;

insert into public.approval_step_actors (organization_id, step_id, user_id, decision)
select r.org_id, r.step_id, a.user_id,
       case when r.status = 'PENDING' then 'PENDING' when seat = 0 then r.status else 'SKIPPED' end::public.approval_status
from vol_request r
cross join lateral (values (0, r.g % 20), (1, (r.g + 7) % 20)) s(seat, k)
join vol_approver a on a.org_id = r.org_id and a.k = s.k;

insert into public.approval_delegations (organization_id, delegator_user_id, delegate_user_id, starts_on, ends_on, is_active)
select v.id, md5('approver-' || v.o || '-5')::uuid, md5('approver-' || v.o || '-6')::uuid, current_date - 5, current_date + 5, true from vol_org v;

insert into public.attendance_notes (organization_id, employee_id, attendance_date, note, status, category, submitted_at)
select :'seed_org', e.id, current_date - d, 'Synthetic reason',
       case when (e.n + d) % 33 = 0 then 'pending' else 'approved' end::public.attendance_note_status, 'absence_reason', now() - make_interval(days => d)
from seed_emp e, generate_series(1, 60) d;

insert into public.report_schedules (organization_id, name, report_type, cadence, run_day, period_rule, is_active, next_run_at, recipients, channels, filters)
select v.id, 'Schedule ' || s, 'late_report', 'monthly', 5, 'previous_month', s % 5 <> 0,
       case when s % 5 <> 0 then now() + make_interval(hours => ((s * 37 + v.o * 11) % 120) - 60) else null end,
       jsonb_build_object('userIds', jsonb_build_array(md5('approver-' || v.o || '-0')::uuid), 'roleKeys', '[]'::jsonb), array['in_app'], '{}'::jsonb
from vol_org v, generate_series(1, 25) s;

insert into jobs.queue (queue_name, job_type, organization_id, status, run_at, dedupe_key, created_at, completed_at, locked_at)
select case when g % 3 = 0 then 'reports' else 'processing' end, case when g % 3 = 0 then 'GENERATE_REPORT' else 'NORMALIZE_RAW' end,
       ('f0000000-0000-4000-8000-' || lpad(to_hex(1 + g % 200), 12, '0'))::uuid,
       case when g <= 50 then 'running' when g <= 5050 then 'pending' when g % 17 = 0 then 'failed' else 'completed' end::jobs.job_status,
       now() - make_interval(secs => g), 'report-schedule:' || md5(g::text) || ':' || g, now() - make_interval(secs => g),
       case when g > 5050 then now() - make_interval(secs => g - 1) else null end, case when g <= 50 then now() else null end
from generate_series(1, 205050) g;

set session_replication_role = origin;
analyze public.organizations, public.approval_requests, public.approval_steps, public.approval_step_actors, public.approval_delegations,
        public.attendance_notes, public.report_schedules, jobs.queue;
