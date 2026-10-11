-- FlowZa Time · Hikvision test tenant seed · step 5/5: read-only checks once the worker has drained the queue (~30 min)
--
-- Expect: raw punches normalised (none pending / unmatched on the demo terminals), a daily record for every employee-day
-- 1 Sep → today, the recalculation request COMPLETED, the period summaries built, the approved corrections applied, the
-- policies resolving to the employees they were written for, and the double-shift / deployment days calculated as such.
with o as (select '78a5a348-69b6-4c51-8d72-3697f72c50f0'::uuid as id)
select 'subscription' as check, (select p.key || ' · ' || s.status || ' · user limit ' || s.seats from public.subscriptions s join public.plans p on p.id = s.plan_id, o where s.organization_id = o.id) as result
union all select 'employees per department', (select string_agg(d.code || ' ' || n, ', ' order by d.code) from (select department_id, count(*) n from public.employees e, o where e.organization_id = o.id and e.deleted_at is null and e.employment_status = 'active' group by 1) x join public.departments d on d.id = x.department_id)
union all select 'raw punches (demo terminals)', (select string_agg(processing_status::text || ' ' || n, ', ') from (select processing_status, count(*) n from public.attendance_raw_transactions r, o where r.organization_id = o.id and r.device_id <> '29bce771-016b-4130-b877-d40e9c40a11a' group by 1) x)
union all select 'raw punches (real terminal james)', (select count(*)::text from public.attendance_raw_transactions r, o where r.organization_id = o.id and r.device_id = '29bce771-016b-4130-b877-d40e9c40a11a')
union all select 'daily records 1 Sep → today', (select string_agg(status::text || ' ' || n, ', ' order by n desc) from (select status, count(*) n from public.attendance_daily_records r, o where r.organization_id = o.id and r.attendance_date >= '2026-09-01' group by 1) x)
union all select 'flags', (select string_agg(f || ' ' || n, ', ' order by n desc) from (select f, count(*) n from public.attendance_daily_records r, o, unnest(r.flags) f where r.organization_id = o.id and r.attendance_date >= '2026-09-01' group by 1) x)
union all select 'recalculation requests', (select string_agg(status::text || ' ' || n, ', ') from (select status, count(*) n from public.attendance_recalculation_requests r, o where r.organization_id = o.id group by 1) x)
union all select 'period summaries', (select count(*)::text from public.attendance_period_summaries s, o where s.organization_id = o.id)
union all select 'corrections (seeded)', (select string_agg(status::text || ' ' || n, ', ') from (select status, count(*) n from public.attendance_corrections c, o where c.organization_id = o.id and c.reason like 'Forgot to punch out%' group by 1) x)
union all select 'pending approvals', (select string_agg(entity_type::text || ' ' || n, ', ') from (select entity_type, count(*) n from public.approval_requests r, o where r.organization_id = o.id and r.status = 'PENDING' group by 1) x)
union all select 'double-shift days', (select count(*)::text from public.attendance_daily_records r, o where r.organization_id = o.id and 'DOUBLE_SHIFT' = any (r.flags))
union all select 'locations (step 6)', (select coalesce(string_agg(role::text || ' ' || n, ', '), 'not built') from (select role, count(*) n from public.locations l, o where l.organization_id = o.id group by 1) x)
union all select 'queue', (select string_agg(job_type || ' ' || status || ' ' || n, ', ') from (select job_type, status, count(*) n from jobs.queue q, o where q.organization_id = o.id and q.correlation_id = 'seed-hikvision' group by 1, 2) x);
