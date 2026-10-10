-- FlowZa Time · Hikvision test tenant seed · step 4/5: leave, Hikvision punch history (1 Sep → now), corrections, recalculation
--
-- Attendance is never written here: like a real terminal, the seed inserts raw Hikvision HTTP-Listening events (`pending`,
-- source DEVICE_PUSH) on the DEMO terminals of step 2, and the worker's normaliser, the RECALCULATE_RANGE request and the
-- BUILD_PERIOD_SUMMARY jobs produce every daily record, flag, overtime figure and payroll summary with the real engine
-- (policies, rotations, double shifts, deployments and leave included). Allow ~15 minutes for the queue to drain.
--
-- The shift of each day is resolved like the engine does (EMPLOYEE > TEAM > DEPARTMENT > BRANCH > ORGANIZATION, latest
-- effective first, rotation patterns mapped from their anchor date). Days on which an employee already has attendance events
-- (the real terminal "james", corrections made while testing) are left exactly as they are. Deterministic: every decision is
-- a hash of employee + date, and the dedupe index keeps the append-only raw table free of duplicates on a re-run (which only
-- adds the days since the last run).
set client_min_messages = warning;

create or replace function pg_temp.sid(p text) returns uuid language sql immutable as
$$ select extensions.uuid_generate_v5('78a5a348-69b6-4c51-8d72-3697f72c50f0'::uuid, 'hk-demo:' || p) $$;
create or replace function pg_temp.u(p text) returns double precision language sql immutable as
$$ select (('x' || substr(md5('hk-demo-2026:' || p), 1, 8))::bit(32)::bigint)::double precision / 4294967296.0 $$;
create or replace function pg_temp.emp(p_num text) returns uuid language sql stable as
$$ select id from public.employees where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0' and employee_number = p_num and deleted_at is null $$;

-- the shift an employee works on a date (null = rotation off day / no assignment) — packages/domain resolveShift
create or replace function pg_temp.shift_on(p_emp uuid, p_dept uuid, p_branch uuid, p_d date) returns uuid language sql stable as $$
  with cand as (
    select a.shift_id, a.shift_pattern_id
    from public.shift_assignments a
    where a.organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0' and a.effective_from <= p_d and (a.effective_to is null or p_d < a.effective_to)
      and ((a.target_type = 'EMPLOYEE' and a.target_id = p_emp)
        or (a.target_type = 'TEAM' and a.target_id in (select tm.team_id from public.team_members tm where tm.employee_id = p_emp))
        or (a.target_type = 'DEPARTMENT' and a.target_id = p_dept)
        or (a.target_type = 'BRANCH' and a.target_id = p_branch)
        or (a.target_type = 'ORGANIZATION' and a.target_id = a.organization_id))
    order by case a.target_type when 'EMPLOYEE' then 5 when 'TEAM' then 4 when 'DEPARTMENT' then 3 when 'BRANCH' then 2 else 1 end desc, a.effective_from desc, a.id::text
    limit 1)
  select coalesce(c.shift_id,
    (select (s ->> 'shiftId')::uuid from public.shift_patterns p, jsonb_array_elements(p.sequence) s
     where p.id = c.shift_pattern_id and s ? 'shiftId'
       and (s ->> 'day')::int = ((p_d - p.anchor_date) % p.cycle_length_days + p.cycle_length_days) % p.cycle_length_days))
  from cand c $$;

-- same approval shape as 03_enterprise.sql
create or replace function pg_temp.approval(p_key text, p_entity text, p_entity_id uuid, p_emp uuid, p_requested_by uuid, p_created timestamptz, p_outcome text,
  p_seat1 uuid, p_path1 text, p_at1 timestamptz, p_note1 text, p_seat2 uuid, p_path2 text, p_at2 timestamptz, p_note2 text,
  p_units numeric default null, p_co_subjects uuid[] default null) returns uuid language plpgsql as $$
declare
  org uuid := '78a5a348-69b6-4c51-8d72-3697f72c50f0';
  hr_role uuid := '10000000-0000-0000-0000-000000000003';
  req uuid := pg_temp.sid('approval:' || p_key);
  s1 uuid := pg_temp.sid('approval-step:' || p_key || ':1');
  s2 uuid := pg_temp.sid('approval-step:' || p_key || ':2');
  e record; subj uuid; st1 text; st2 text; decider uuid; done_at timestamptz;
begin
  if exists (select 1 from public.approval_requests where id = req) then return req; end if;
  select id, branch_id, department_id into e from public.employees where id = p_emp;
  select m.user_id into subj from public.org_memberships m where m.organization_id = org and m.employee_id = p_emp and m.status = 'active' limit 1;
  st1 := case p_outcome when 'PENDING' then 'PENDING' when 'APPROVED' then 'APPROVED' else 'REJECTED' end;
  st2 := case p_outcome when 'PENDING' then 'PENDING' when 'APPROVED' then 'APPROVED' else 'SKIPPED' end;
  decider := case p_outcome when 'APPROVED' then p_seat2 when 'REJECTED' then p_seat1 end;
  done_at := case p_outcome when 'APPROVED' then p_at2 when 'REJECTED' then p_at1 end;

  insert into public.approval_requests (id, organization_id, workflow_id, entity_type, entity_id, branch_id, employee_id, department_id, units, current_step, status, requested_by, subject_user_id,
    co_subject_employee_ids, co_subject_user_ids, decided_by, completed_at, created_at)
  values (req, org, pg_temp.sid('workflow:' || p_entity), p_entity::public.approval_entity, p_entity_id, e.branch_id, p_emp, e.department_id, p_units,
    case p_outcome when 'APPROVED' then 2 else 1 end, p_outcome::public.approval_status, p_requested_by, subj,
    p_co_subjects, case when p_co_subjects is null then null else '{}'::uuid[] end, decider, done_at, p_created);

  insert into public.approval_steps (id, organization_id, request_id, step_no, approver_type, approver_role_id, approver_user_id, mode, required_count, resolution_path, resolution_reason, status, acted_by, acted_at, comment, activated_at)
  values
    (s1, org, req, 1, 'MANAGER', null, p_seat1, 'ANY', 1, p_path1,
     case when p_path1 = 'hr_admin' then 'primary manager: no login linked to the manager; fell back to HR admins' end,
     st1::public.approval_status, case when st1 <> 'PENDING' then p_seat1 end, case when st1 <> 'PENDING' then p_at1 end, p_note1, p_created),
    (s2, org, req, 2, 'ROLE', hr_role, p_seat2, 'ANY', 1, p_path2,
     case when p_path2 = 'owner' then 'approved an earlier level excluded (four-eyes); fell back to the owner' end,
     st2::public.approval_status, case when st2 = 'APPROVED' then p_seat2 end, case when st2 = 'APPROVED' then p_at2 end, p_note2,
     case when st1 = 'APPROVED' then p_at1 end);

  insert into public.approval_step_actors (organization_id, step_id, user_id, resolution_path, decision, decided_at, comment)
  values (org, s1, p_seat1, p_path1, st1::public.approval_status, case when st1 <> 'PENDING' then p_at1 end, p_note1);
  if st2 in ('PENDING', 'APPROVED') then
    insert into public.approval_step_actors (organization_id, step_id, user_id, resolution_path, decision, decided_at, comment)
    values (org, s2, p_seat2, p_path2, st2::public.approval_status, case when st2 = 'APPROVED' then p_at2 end, p_note2);
  end if;

  insert into public.approval_request_events (organization_id, request_id, at, actor_user_id, kind, detail)
  values (org, req, p_created, p_requested_by, 'submitted', jsonb_build_object('workflowId', pg_temp.sid('workflow:' || p_entity), 'workflowName', 'Line manager → HR'));
  if st1 <> 'PENDING' then
    insert into public.approval_request_events (organization_id, request_id, at, actor_user_id, kind, detail)
    values (org, req, p_at1, p_seat1, case st1 when 'APPROVED' then 'step_approved' else 'step_rejected' end, jsonb_strip_nulls(jsonb_build_object('stepNo', 1, 'comment', p_note1)));
  end if;
  if st2 = 'APPROVED' then
    insert into public.approval_request_events (organization_id, request_id, at, actor_user_id, kind, detail)
    values (org, req, p_at2, p_seat2, 'step_approved', jsonb_strip_nulls(jsonb_build_object('stepNo', 2, 'comment', p_note2)));
  end if;
  if p_outcome in ('APPROVED', 'REJECTED') then
    insert into public.approval_request_events (organization_id, request_id, at, actor_user_id, kind, detail)
    values (org, req, done_at, decider, lower(p_outcome), '{}'::jsonb);
  end if;
  return req;
end $$;

do $$
declare
  org uuid := '78a5a348-69b6-4c51-8d72-3697f72c50f0';
  owner_id uuid := '49511ed9-d4fb-4db2-9e82-d5ff90a9d125';
  hr_id uuid := 'fb89ea8b-1d92-49b1-8ff2-c3796d5f3c70';
  kumar_user uuid := 'aa8a8a71-bf85-446a-9978-ab4b969410fb';
  kumar_emp uuid := pg_temp.emp('001');
  sohar uuid := pg_temp.sid('branch:SOH');
  ghl2 uuid := pg_temp.sid('device:GHL-02');
  soh1 uuid := pg_temp.sid('device:SOH-01');
  soh2 uuid := pg_temp.sid('device:SOH-02');
  tz text := 'Asia/Muscat';
  d_from date := '2026-09-01';
  d_to date := (now() at time zone 'Asia/Muscat')::date;
  org_off smallint[] := (select weekly_off_days from public.organizations where id = '78a5a348-69b6-4c51-8d72-3697f72c50f0');
  e record; l record; c record; d date; key text;
  sh public.shifts%rowtype; add_sh public.shifts%rowtype; has_add boolean; sh_id uuid;
  woff smallint[]; on_leave boolean; lv_half boolean; lv_part text; dep_br uuid; br uuid; dev_id uuid;
  base_start timestamp; base_end timestamp; in_off double precision; out_off double precision; ot double precision; early double precision;
  in_at timestamptz; out_at timestamptz; verify text; missing_out boolean; missing_in boolean; crew boolean;
  req uuid; job_id bigint; seat1 uuid; path1 text; seat2 uuid; path2 text; days numeric; n int := 0;
begin
  if not exists (select 1 from public.devices where id = ghl2) then raise exception 'run 02_structure_people.sql first'; end if;

  ---------------------------------------------------------------------------------------------------------------------
  -- 1. Leave: 2026 allowances, then records through the "Line manager → HR" workflow (IT reports reach K Kumar first)
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.leave_allocations (id, organization_id, employee_id, leave_type_id, branch_id, year, allocated_days, notes, created_by)
  select pg_temp.sid('alloc:' || x.employee_number || ':' || t.code || ':2026'), org, x.id, lt.id, x.branch_id, 2026, t.n, '2026 entitlement', hr_id
  from public.employees x
  cross join (values ('AL', 30), ('CL', 6), ('SL', 10), ('EL', 6)) as t(code, n)
  join public.leave_types lt on lt.organization_id = org and lt.code = t.code
  where x.organization_id = org and x.deleted_at is null and x.employment_status = 'active'
  on conflict (organization_id, employee_id, leave_type_id, year) do nothing;

  for l in
    select v.*, pg_temp.emp(v.num) as emp_id, dp.code as dept,
           (select lt.id from public.leave_types lt where lt.organization_id = org and lt.code = v.code) as type_id
    from (values
      -- key num, type, from, to, half part, outcome, reason, created, decision note
      ('EMP022', 'AL', '2026-09-07', '2026-09-10', null,          'APPROVED', 'Family visit to Salalah.',                          '2026-08-30 10:00:00+04', 'Enjoy the break.'),
      ('EMP036', 'SL', '2026-09-15', '2026-09-16', null,          'APPROVED', 'Flu — medical certificate uploaded.',               '2026-09-15 08:05:00+04', 'Get well soon.'),
      ('EMP044', 'AL', '2026-09-20', '2026-09-24', null,          'APPROVED', 'Sister''s wedding in Kochi.',                       '2026-09-02 12:40:00+04', 'Congratulations!'),
      ('EMP050', 'CL', '2026-09-29', '2026-09-29', null,          'APPROVED', 'Car registration renewal at the ROP.',              '2026-09-24 09:15:00+04', null),
      ('EMP064', 'AL', '2026-09-06', '2026-09-17', null,          'APPROVED', 'Annual home leave (Hyderabad).',                    '2026-08-12 11:00:00+04', 'Planner duties handed to Badar.'),
      ('EMP074', 'SL', '2026-09-10', '2026-09-12', null,          'APPROVED', 'Back strain — doctor''s note attached.',            '2026-09-10 06:30:00+04', null),
      ('EMP088', 'AL', '2026-10-03', '2026-10-09', null,          'APPROVED', 'Annual leave — home visit to Pokhara.',             '2026-09-14 20:10:00+04', 'Crew C runs one short; supervisor informed.'),
      ('EMP095', 'SL', '2026-10-05', '2026-10-06', null,          'APPROVED', 'Fever.',                                            '2026-10-05 06:45:00+04', null),
      ('TEST012','CL', '2026-09-23', '2026-09-23', 'SECOND_HALF', 'APPROVED', 'Child''s school event in the afternoon.',            '2026-09-21 14:20:00+04', null),
      ('EMP028', 'CL', '2026-10-06', '2026-10-06', 'FIRST_HALF',  'APPROVED', 'Dentist appointment in the morning.',               '2026-10-04 16:00:00+04', null),
      ('EMP041', 'AL', '2026-10-18', '2026-10-22', null,          'APPROVED', 'Family trip to Cairo.',                             '2026-09-25 10:30:00+04', 'Approved — hand over open POs to Venkatesh.'),
      ('EMP067', 'AL', '2026-10-25', '2026-11-05', null,          'APPROVED', 'Umrah.',                                            '2026-09-28 13:00:00+04', 'Approved. Safe travels.'),
      ('EMP042', 'AL', '2026-10-25', '2026-10-29', null,          'PENDING',  'Brother''s wedding in Thrissur.',                   '2026-10-08 17:25:00+04', null),
      ('EMP045', 'CL', '2026-10-14', '2026-10-14', null,          'PENDING',  'Visa renewal appointment.',                         '2026-10-09 10:05:00+04', null),
      ('EMP052', 'AL', '2026-11-01', '2026-11-05', null,          'PENDING',  'Family event in Dubai.',                            '2026-10-07 15:40:00+04', null),
      ('EMP079', 'EL', '2026-10-12', '2026-10-13', null,          'PENDING',  'Family emergency at home in Nepal.',                '2026-10-10 07:10:00+04', null),
      ('001',    'AL', '2026-11-08', '2026-11-12', null,          'PENDING',  'Annual leave.',                                     '2026-10-09 09:35:00+04', null),
      ('EMP083', 'AL', '2026-10-04', '2026-10-08', null,          'REJECTED', 'Trip home.',                                        '2026-09-26 22:00:00+04', 'Crew A is already one short that week; please choose dates after 20 October.'),
      ('EMP070', 'CL', '2026-09-30', '2026-09-30', null,          'REJECTED', 'Personal errand.',                                  '2026-09-27 09:00:00+04', 'HSE audit by the Ministry is scheduled that day.')
    ) as v(num, code, sd, ed, part, outcome, reason, created, note)
    join public.employees ee on ee.organization_id = org and ee.employee_number = v.num and ee.deleted_at is null
    left join public.departments dp on dp.id = ee.department_id
  loop
    continue when l.type_id is null;
    days := case when l.part is not null then 0.5 else
      (select count(*) from generate_series(l.sd::date, l.ed::date, interval '1 day') g where l.dept in ('WH', 'SEC') or extract(dow from g)::int not in (5, 6)) end;
    -- level 1: the line manager's login (K Kumar for the IT team), else the HR admins; level 2: HR admin, or the owner (four-eyes)
    if l.dept = 'IT' and l.emp_id <> kumar_emp then seat1 := kumar_user; path1 := 'primary'; seat2 := hr_id; path2 := 'role';
    else seat1 := hr_id; path1 := 'hr_admin'; seat2 := case when l.outcome = 'APPROVED' then owner_id else hr_id end; path2 := case when l.outcome = 'APPROVED' then 'owner' else 'role' end;
    end if;
    req := pg_temp.approval('leave:' || l.num || ':' || l.sd, 'LEAVE', pg_temp.sid('leave:' || l.num || ':' || l.sd), l.emp_id,
             case when l.emp_id = kumar_emp then kumar_user end, l.created::timestamptz, l.outcome,
             seat1, path1, case when l.outcome <> 'PENDING' then l.created::timestamptz + interval '5 hours' end, case when l.outcome = 'REJECTED' then l.note end,
             seat2, path2, case when l.outcome = 'APPROVED' then l.created::timestamptz + interval '20 hours' end, case when l.outcome = 'APPROVED' then l.note end, days);
    insert into public.leave_records (id, organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, is_half_day, half_day_part, status, source, reason, days,
      approved_by, approved_at, decision_note, approval_request_id, created_by, created_at)
    select pg_temp.sid('leave:' || l.num || ':' || l.sd), org, l.emp_id, ee.branch_id, l.type_id, l.sd::date, l.ed::date, l.part is not null, l.part::public.half_day_part,
           l.outcome::public.leave_status, 'INTERNAL', l.reason, days,
           case when l.outcome = 'APPROVED' then seat2 when l.outcome = 'REJECTED' then seat1 end,
           case when l.outcome = 'APPROVED' then l.created::timestamptz + interval '20 hours' when l.outcome = 'REJECTED' then l.created::timestamptz + interval '5 hours' end,
           l.note, req, case when l.emp_id = kumar_emp then kumar_user end, l.created::timestamptz
    from public.employees ee where ee.id = l.emp_id
    on conflict (id) do nothing;
  end loop;

  ---------------------------------------------------------------------------------------------------------------------
  -- 2. Punches
  ---------------------------------------------------------------------------------------------------------------------
  create temp table seed_punch (emp uuid, num text, pin text, br uuid, dev uuid, at timestamptz, dir text, verify text) on commit drop;
  create temp table seed_missing (emp uuid, num text, dept text, d date, br uuid, expected_out timestamptz) on commit drop;
  create temp table seed_skip on commit drop as
    select distinct ev.employee_id as emp, (ev.punched_at at time zone tz)::date as day from public.attendance_events ev where ev.organization_id = org;

  for e in
    select emp.id, emp.employee_number as num, emp.device_user_id as pin, emp.joining_date, emp.branch_id as home, emp.department_id as dept_id, dp.code as dept,
           coalesce(emp.weekly_off_days, b.weekly_off_days, org_off) as woff, emp.fingerprint_enrolled as fp, (emp.card_number is not null) as has_card,
           pg_temp.u(emp.employee_number || ':punct') as up, pg_temp.u(emp.employee_number || ':ot') as uo,
           pg_temp.u(emp.employee_number || ':abs') as ua, pg_temp.u(emp.employee_number || ':verify') as uv
    from public.employees emp
    join public.branches b on b.id = emp.branch_id
    left join public.departments dp on dp.id = emp.department_id
    where emp.organization_id = org and emp.deleted_at is null and emp.employment_status = 'active'
  loop
    crew := e.dept in ('WH', 'SEC');
    for d in select generate_series(greatest(d_from, e.joining_date), d_to, interval '1 day')::date loop
      continue when exists (select 1 from seed_skip s where s.emp = e.id and s.day = d);
      key := e.num || ':' || d::text;

      select lr.is_half_day, lr.half_day_part::text into lv_half, lv_part from public.leave_records lr
        where lr.organization_id = org and lr.employee_id = e.id and lr.status = 'APPROVED' and lr.start_date <= d and lr.end_date >= d order by lr.is_half_day limit 1;
      on_leave := found;
      continue when on_leave and not lv_half;
      continue when extract(dow from d)::int = any (e.woff);
      continue when exists (select 1 from public.holidays h where h.organization_id = org and h.date <= d and coalesce(h.end_date, h.date) >= d and (h.branch_ids is null or e.home = any (h.branch_ids)));

      sh_id := pg_temp.shift_on(e.id, e.dept_id, e.home, d);
      continue when sh_id is null;                                                   -- rotation off day
      select * into sh from public.shifts where id = sh_id;
      continue when pg_temp.u(key || ':abs') < 0.006 + e.ua * 0.03;                  -- unplanned absence

      select dpl.branch_id into dep_br from public.employee_branch_deployments dpl
        where dpl.organization_id = org and dpl.employee_id = e.id and dpl.cancelled_at is null and dpl.from_date <= d and dpl.to_date >= d limit 1;
      br := case when found then dep_br else e.home end;
      dev_id := case when br = sohar then case when e.dept = 'WH' and pg_temp.u(key || ':dev') < 0.7 then soh2 else soh1 end else ghl2 end;

      if sh.type = 'FIXED' then
        base_start := d + sh.start_time;
        base_end := d + sh.end_time;
        if sh.end_time <= sh.start_time then base_end := base_end + interval '1 day'; end if;
      else
        base_start := d + time '07:40' + make_interval(mins => floor(pg_temp.u(key || ':flexin') * 100)::int);
        base_end := base_start + make_interval(mins => coalesce(sh.required_minutes, 480) + 45);
      end if;

      select s2.* into add_sh from public.additional_shift_assignments a join public.shifts s2 on s2.id = a.shift_id
        where a.organization_id = org and a.employee_id = e.id and a.effective_from <= d and (a.effective_to is null or d < a.effective_to) limit 1;
      has_add := found;

      -- arrival: punctual (55 %), average (30 %), late-prone (15 %: these build up attendance points and warnings)
      if sh.type = 'FLEXIBLE' then
        in_off := -5 + pg_temp.u(key || ':in') * 10;
      elsif e.up < 0.55 then
        in_off := case when pg_temp.u(key || ':late') < 0.04 then 11 + pg_temp.u(key || ':late2') * 14 else -25 + pg_temp.u(key || ':in') * 31 end;
      elsif e.up < 0.85 then
        in_off := case when pg_temp.u(key || ':late') < 0.12 then 11 + pg_temp.u(key || ':late2') * 29 else -15 + pg_temp.u(key || ':in') * 24 end;
      else
        in_off := case when pg_temp.u(key || ':late') < 0.40 then 12 + pg_temp.u(key || ':late2') * 70 else -8 + pg_temp.u(key || ':in') * 17 end;
      end if;

      -- departure: overtime for the overtime-prone and often for the crews; rare early departures
      ot := 0; early := 0;
      if crew and pg_temp.u(key || ':ot') < 0.18 then ot := 30 + pg_temp.u(key || ':ot2') * 60;
      elsif e.uo < 0.22 and pg_temp.u(key || ':ot') < 0.40 then ot := 35 + pg_temp.u(key || ':ot2') * 115;
      elsif pg_temp.u(key || ':ot') < 0.06 then ot := 35 + pg_temp.u(key || ':ot2') * 60; end if;
      if has_add then ot := 0; end if;
      if ot = 0 and pg_temp.u(key || ':early') < 0.05 then early := 15 + pg_temp.u(key || ':early2') * 30; end if;
      out_off := -3 + pg_temp.u(key || ':out') * 17 + ot - early;

      in_at := (base_start + make_interval(secs => round(in_off * 60)::int + floor(pg_temp.u(key || ':insec') * 60)::int)) at time zone tz;
      out_at := (base_end + make_interval(secs => round(out_off * 60)::int + floor(pg_temp.u(key || ':outsec') * 60)::int)) at time zone tz;
      if on_leave and lv_part = 'FIRST_HALF' then in_at := (d + time '13:00' + make_interval(mins => floor(pg_temp.u(key || ':half') * 20)::int)) at time zone tz; end if;
      if on_leave and lv_part = 'SECOND_HALF' then out_at := (d + time '12:30' + make_interval(mins => floor(pg_temp.u(key || ':half') * 35)::int)) at time zone tz; end if;

      missing_out := not on_leave and not has_add and pg_temp.u(key || ':missout') < 0.015;
      missing_in := not on_leave and not missing_out and not has_add and pg_temp.u(key || ':missin') < 0.005;

      verify := case when e.uv < 0.72 then 'face' when e.uv < 0.88 and e.fp then 'fingerprint' when e.has_card then 'card' else 'face' end;
      if pg_temp.u(key || ':vday') < 0.06 then verify := case when e.has_card then 'card' else 'face' end; end if;

      if not missing_in then insert into seed_punch values (e.id, e.num, e.pin, br, dev_id, in_at, 'in', verify); end if;
      if pg_temp.u(key || ':dup') < 0.02 then
        insert into seed_punch values (e.id, e.num, e.pin, br, dev_id, in_at + make_interval(secs => 20 + floor(pg_temp.u(key || ':dup2') * 30)::int), 'in', verify);
      end if;
      if has_add then
        -- double shift: out after the office day, back for the evening shift, out at its end
        insert into seed_punch values (e.id, e.num, e.pin, br, dev_id, out_at, 'out', verify);
        insert into seed_punch values (e.id, e.num, e.pin, br, dev_id, ((d + add_sh.start_time) - make_interval(mins => 2 + floor(pg_temp.u(key || ':add-in') * 8)::int)) at time zone tz, 'in', verify);
        insert into seed_punch values (e.id, e.num, e.pin, br, dev_id, ((d + add_sh.end_time) + make_interval(mins => 1 + floor(pg_temp.u(key || ':add-out') * 12)::int)) at time zone tz, 'out', verify);
      elsif missing_out then
        insert into seed_missing values (e.id, e.num, e.dept, d, br, out_at);
      else
        insert into seed_punch values (e.id, e.num, e.pin, br, dev_id, out_at, 'out', verify);
      end if;
    end loop;
  end loop;

  -- Hikvision ISAPI AccessControllerEvent rows, as the HTTP-Listening endpoint stores them (allowlisted payload, no picture)
  insert into public.attendance_raw_transactions (organization_id, device_id, branch_id, provider_key, provider_transaction_id, device_employee_id, employee_id, punched_at, device_local_time, verification_method, direction,
    raw_payload, received_at, source, sync_job_id, dedupe_hash, processing_status, assumed_timezone, clock_skew_seconds, device_generation)
  select org, p.dev, dv.branch_id, 'hikvision_push', (5000 + row_number() over (partition by p.dev order by p.at, p.pin))::text, p.pin, null, p.at,
         to_char(p.at at time zone tz, 'YYYY-MM-DD"T"HH24:MI:SS') || '+04:00', p.verify::public.verification_method, p.dir::public.punch_direction,
         jsonb_build_object('mask', 'no', 'doorNo', 1, 'dateTime', to_char(p.at at time zone tz, 'YYYY-MM-DD"T"HH24:MI:SS') || '+04:00', 'protocol', 'hikvision',
                            'serialNo', 5000 + row_number() over (partition by p.dev order by p.at, p.pin), 'userType', 'normal', 'eventType', 'AccessControllerEvent',
                            'employeeNo', p.pin, 'cardReaderNo', 1, 'serialNumber', dv.serial_number,
                            'subEventType', case p.verify when 'face' then 75 when 'fingerprint' then 38 else 1 end, 'majorEventType', 5, 'activePostCount', 1,
                            'attendanceStatus', case p.dir when 'in' then 'checkIn' else 'checkOut' end, 'currentVerifyMode', 'faceOrFpOrCardOrPw'),
         p.at + make_interval(secs => 1 + floor(pg_temp.u(p.num || p.at::text || ':rcv') * 6)::int), 'DEVICE_PUSH', null,
         encode(extensions.digest(p.dev::text || '|1|' || p.pin || '|' || to_char(p.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '|' || p.verify || '|' || p.dir, 'sha256'), 'hex'),
         'pending', tz, floor(pg_temp.u(p.num || p.at::text || ':skew') * 4)::int, 1
  from seed_punch p
  join public.devices dv on dv.id = p.dev
  where p.at <= now()
  on conflict (organization_id, device_id, dedupe_hash, punched_at) do nothing;
  get diagnostics n = row_count;
  raise notice 'raw punches inserted: %', n;

  ---------------------------------------------------------------------------------------------------------------------
  -- 3. Corrections for some missed punch-outs at the office (3 approved and applied by the worker, 2 pending, 1 rejected)
  ---------------------------------------------------------------------------------------------------------------------
  for c in
    select m.*, row_number() over (order by m.d, m.num) as rn
    from seed_missing m
    where m.num like 'EMP%' and m.dept not in ('WH', 'SEC') and m.d <= d_to - 3
    order by m.d, m.num limit 6
  loop
    if c.dept = 'IT' then seat1 := kumar_user; path1 := 'primary'; seat2 := hr_id; path2 := 'role';
    else seat1 := hr_id; path1 := 'hr_admin'; seat2 := case when c.rn <= 3 then owner_id else hr_id end; path2 := case when c.rn <= 3 then 'owner' else 'role' end;
    end if;
    req := pg_temp.approval('correction:' || c.num || ':' || c.d, 'ATTENDANCE_CORRECTION', pg_temp.sid('correction:' || c.num || ':' || c.d), c.emp, null,
             ((c.d + 1) + time '09:10') at time zone tz, case when c.rn <= 3 then 'APPROVED' when c.rn <= 5 then 'PENDING' else 'REJECTED' end,
             seat1, path1, case when c.rn <= 3 or c.rn = 6 then ((c.d + 1) + time '16:45') at time zone tz end,
             case when c.rn <= 3 then 'Confirmed — on site until closing.' when c.rn = 6 then 'No supporting evidence from the line manager.' end,
             seat2, path2, case when c.rn <= 3 then ((c.d + 2) + time '11:30') at time zone tz end, case when c.rn <= 3 then 'Approved.' end);
    insert into public.attendance_corrections (id, organization_id, employee_id, branch_id, attendance_date, type, proposed_punched_at, proposed_event_type, reason, requested_by, status, approval_request_id, rejection_reason, created_at)
    values (pg_temp.sid('correction:' || c.num || ':' || c.d), org, c.emp, c.br, c.d, 'ADD_PUNCH', c.expected_out, 'PUNCH_OUT',
            'Forgot to punch out — left at ' || to_char(c.expected_out at time zone tz, 'HH24:MI') || '.', null,
            case when c.rn <= 3 then 'APPROVED' when c.rn <= 5 then 'PENDING' else 'REJECTED' end::public.correction_status, req,
            case when c.rn = 6 then 'No supporting evidence from the line manager.' end, ((c.d + 1) + time '09:10') at time zone tz)
    on conflict (id) do nothing;
    if c.rn <= 3 then
      perform app.enqueue_job('processing', 'APPLY_CORRECTION', org, jsonb_build_object('organizationId', org, 'correctionId', pg_temp.sid('correction:' || c.num || ':' || c.d), 'appliedBy', owner_id),
                              7, now() + interval '20 minutes', 'apply:' || pg_temp.sid('correction:' || c.num || ':' || c.d)::text, 5, 120, 'seed-hikvision');
    end if;
  end loop;

  ---------------------------------------------------------------------------------------------------------------------
  -- 4. Hand over to the worker: normalise now, recalculate 1 Sep → today in 10 minutes, payroll summaries in 30
  ---------------------------------------------------------------------------------------------------------------------
  update public.devices set connection_status = 'online', last_heartbeat_at = now(), last_successful_communication_at = now(), last_attendance_sync_at = now(), updated_at = now()
  where id in (ghl2, soh1, soh2);

  perform app.enqueue_job('processing', 'NORMALIZE_RAW', org, jsonb_build_object('organizationId', org), 6, now(), 'normalize:' || org::text, 3, 600, 'seed-hikvision');

  insert into public.attendance_recalculation_requests (id, organization_id, from_date, to_date, reason, requested_by, status)
  values (gen_random_uuid(), org, d_from, d_to, 'Enterprise demo data: Hikvision terminal history, policies, rotations and leave (demo seed)', owner_id, 'QUEUED') returning id into req;
  job_id := app.enqueue_job('processing', 'RECALCULATE_RANGE', org, jsonb_build_object('organizationId', org, 'requestId', req), 3, now() + interval '10 minutes', 'recalculate:' || req::text, 3, 3600, 'seed-hikvision');
  update public.attendance_recalculation_requests set queue_job_id = job_id where id = req;

  perform app.enqueue_job('processing', 'BUILD_PERIOD_SUMMARY', org,
    jsonb_build_object('organizationId', org, 'periodStart', p.ps, 'periodEnd', p.pe, 'finalize', false, 'requestedBy', owner_id),
    4, now() + interval '30 minutes', 'period:' || org::text || ':all:' || p.ps || ':' || p.pe || ':build', 6, 600, 'seed-hikvision')
  from (values (date '2026-09-01', date '2026-09-30'), (date '2026-10-01', date '2026-10-31')) as p(ps, pe);
end $$;

select 'leave_attendance' as step,
  (select count(*) from public.leave_records where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0') as leave_records,
  (select count(*) from public.attendance_raw_transactions where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0' and device_id <> '29bce771-016b-4130-b877-d40e9c40a11a') as demo_raw_punches,
  (select count(*) from public.attendance_raw_transactions where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0' and device_id = '29bce771-016b-4130-b877-d40e9c40a11a') as real_terminal_punches,
  (select min(punched_at) from public.attendance_raw_transactions where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0' and device_id <> '29bce771-016b-4130-b877-d40e9c40a11a') as first_punch,
  (select max(punched_at) from public.attendance_raw_transactions where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0' and device_id <> '29bce771-016b-4130-b877-d40e9c40a11a') as last_punch,
  (select count(*) from public.attendance_corrections where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0' and created_at > '2026-09-01') as corrections,
  (select count(*) from public.approval_requests where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0' and status = 'PENDING') as pending_approvals,
  (select count(*) from jobs.queue where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0' and status = 'pending') as queued_jobs;
