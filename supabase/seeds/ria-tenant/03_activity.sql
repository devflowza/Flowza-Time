-- FlowZa Time · RIA test tenant seed · step 3/3: leave, approvals inbox, terminal punch history (1 Sep → now), recalculation
--
-- Attendance is never written here: like a real terminal, the seed inserts raw Hikvision HTTP-Listening events (`pending`,
-- source DEVICE_PUSH) on the demo terminal of step 2, and the worker's normaliser, the recalculation and the payroll summary
-- jobs produce every daily record, flag, overtime figure and payroll summary with the real engine. Allow ~10 minutes.
--
-- What the four logins find:
--   ria.manager@  approvals inbox: Reem's annual leave (2–5 Nov), Vikram's casual leave (27 Oct), Reem's missed punch-out
--                 correction (14 Oct) — level 1 of "Line manager → HR"; team view of Reem and Vikram
--   ria.hr@       level 2 of everything the line manager approves; the leave history of the team
--   ria.employee@ her own leave (approved 21–24 Sep, pending 2–5 Nov), balances, the pending correction, her attendance
--   ria.admin@    owner: everything, and level 1 of Khalid's own requests (he reports to the Director General)
--
-- Deterministic (every decision is a hash of employee + date) and idempotent: re-running on a later day tops the history up
-- from the day before the last demo punch to the current minute and recalculates only that window; leave, approval and
-- correction records are created once.
set client_min_messages = warning;

create or replace function pg_temp.sid(p text) returns uuid language sql immutable as
$$ select extensions.uuid_generate_v5('1fa2602c-06d4-4341-86ba-2bc971d83563'::uuid, 'ria:' || p) $$;
create or replace function pg_temp.u(p text) returns double precision language sql immutable as
$$ select (('x' || substr(md5('ria-2026:' || p), 1, 8))::bit(32)::bigint)::double precision / 4294967296.0 $$;

-- a two-level "Line manager → HR" request in the approval engine v2 shape (supabase/seeds/hikvision-tenant/04_leave_attendance.sql):
-- level 1 seated on the employee's manager's login, level 2 on the HR Admin role; every level seated at submission
create or replace function pg_temp.approval(p_key text, p_entity text, p_entity_id uuid, p_emp uuid, p_requested_by uuid, p_created timestamptz, p_outcome text,
  p_seat1 uuid, p_at1 timestamptz, p_note1 text, p_seat2 uuid, p_at2 timestamptz, p_note2 text, p_units numeric default null) returns uuid language plpgsql as $$
declare
  org uuid := '1fa2602c-06d4-4341-86ba-2bc971d83563';
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
    decided_by, completed_at, created_at)
  values (req, org, pg_temp.sid('workflow:' || p_entity), p_entity::public.approval_entity, p_entity_id, e.branch_id, p_emp, e.department_id, p_units,
    case p_outcome when 'APPROVED' then 2 else 1 end, p_outcome::public.approval_status, p_requested_by, subj, decider, done_at, p_created);

  insert into public.approval_steps (id, organization_id, request_id, step_no, approver_type, approver_role_id, approver_user_id, mode, required_count, resolution_path, status, acted_by, acted_at, comment, activated_at)
  values
    (s1, org, req, 1, 'MANAGER', null, p_seat1, 'ANY', 1, 'primary',
     st1::public.approval_status, case when st1 <> 'PENDING' then p_seat1 end, case when st1 <> 'PENDING' then p_at1 end, p_note1, p_created),
    (s2, org, req, 2, 'ROLE', hr_role, p_seat2, 'ANY', 1, 'role',
     st2::public.approval_status, case when st2 = 'APPROVED' then p_seat2 end, case when st2 = 'APPROVED' then p_at2 end, p_note2,
     case when st1 = 'APPROVED' then p_at1 end);

  insert into public.approval_step_actors (organization_id, step_id, user_id, resolution_path, decision, decided_at, comment)
  values (org, s1, p_seat1, 'primary', st1::public.approval_status, case when st1 <> 'PENDING' then p_at1 end, p_note1);
  if st2 in ('PENDING', 'APPROVED') then
    insert into public.approval_step_actors (organization_id, step_id, user_id, resolution_path, decision, decided_at, comment)
    values (org, s2, p_seat2, 'role', st2::public.approval_status, case when st2 = 'APPROVED' then p_at2 end, p_note2);
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
  org uuid := '1fa2602c-06d4-4341-86ba-2bc971d83563';
  admin_id uuid := (select id from auth.users where lower(email) = 'ria.admin@flowza.ai');
  hr_id uuid := (select id from auth.users where lower(email) = 'ria.hr@flowza.ai');
  mgr_id uuid := (select id from auth.users where lower(email) = 'ria.manager@flowza.ai');
  emp_id uuid := (select id from auth.users where lower(email) = 'ria.employee@flowza.ai');
  dev uuid := pg_temp.sid('device:HQ-01');
  tz text := 'Asia/Muscat';
  d_from date := '2026-09-01';
  d_to date := (now() at time zone 'Asia/Muscat')::date;
  -- top-up window: punches after the last demo punch, from the day before it
  cutoff timestamptz := coalesce((select max(r.punched_at) from public.attendance_raw_transactions r
                                  where r.organization_id = '1fa2602c-06d4-4341-86ba-2bc971d83563' and r.device_id = pg_temp.sid('device:HQ-01')), '-infinity');
  fill_from date := case when cutoff = '-infinity' then d_from else greatest(d_from, (cutoff at time zone 'Asia/Muscat')::date - 1) end;
  org_off smallint[] := (select weekly_off_days from public.organizations where id = '1fa2602c-06d4-4341-86ba-2bc971d83563');
  sh public.shifts%rowtype;
  e record; l record; d date; key text;
  on_leave boolean; lv_half boolean; lv_part text;
  in_off double precision; out_off double precision; in_at timestamptz; out_at timestamptz; verify text; missing_out boolean;
  seat1 uuid; req uuid; job_id bigint; days numeric; corr uuid; n int := 0;
begin
  if not exists (select 1 from public.devices where id = dev) or emp_id is null then raise exception 'run 02_people.sql first'; end if;
  select * into sh from public.shifts where id = pg_temp.sid('shift:GOV');

  ---------------------------------------------------------------------------------------------------------------------
  -- 1. Leave: 2026 entitlements, then requests through "Line manager → HR"
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.leave_allocations (id, organization_id, employee_id, leave_type_id, branch_id, year, allocated_days, notes, created_by)
  select pg_temp.sid('alloc:' || x.employee_number || ':' || t.code || ':2026'), org, x.id, lt.id, x.branch_id, 2026, t.n, '2026 entitlement', hr_id
  from public.employees x
  cross join (values ('AL', 30), ('CL', 6), ('SL', 10), ('EL', 6)) as t(code, n)
  join public.leave_types lt on lt.organization_id = org and lt.code = t.code
  where x.organization_id = org and x.deleted_at is null and x.employment_status = 'active'
  on conflict (organization_id, employee_id, leave_type_id, year) do nothing;

  for l in
    select v.*, ee.id as emp, ee.branch_id, ee.manager_employee_id,
           (select lt.id from public.leave_types lt where lt.organization_id = org and lt.code = v.code) as type_id
    from (values
      -- num, type, from, to, half part, outcome, reason, filed at, decision note
      ('RIA-004', 'AL', '2026-09-21', '2026-09-24', null,          'APPROVED', 'Family trip to Salalah for the end of the khareef season.', '2026-09-08 10:15:00+04', 'Approved — enjoy the trip.'),
      ('RIA-005', 'SL', '2026-10-07', '2026-10-07', null,          'APPROVED', 'Fever — medical certificate attached.',                     '2026-10-07 06:50:00+04', 'Get well soon.'),
      ('RIA-003', 'CL', '2026-10-12', '2026-10-12', 'SECOND_HALF', 'APPROVED', 'Parents'' meeting at my son''s school in the afternoon.',  '2026-10-08 13:20:00+04', null),
      ('RIA-005', 'CL', '2026-10-27', '2026-10-27', null,          'PENDING',  'Vehicle registration renewal at the ROP.',                  '2026-10-18 11:05:00+04', null),
      ('RIA-004', 'AL', '2026-11-02', '2026-11-05', null,          'PENDING',  'Family wedding in Sur.',                                    '2026-10-15 09:40:00+04', null)
    ) as v(num, code, sd, ed, part, outcome, reason, created, note)
    join public.employees ee on ee.organization_id = org and ee.employee_number = v.num and ee.deleted_at is null
  loop
    continue when l.type_id is null;
    days := case when l.part is not null then 0.5 else
      (select count(*) from generate_series(l.sd::date, l.ed::date, interval '1 day') g where extract(dow from g)::int <> all (org_off)) end;
    -- level 1: the manager's login (Khalid for Reem and Vikram, the Director General for Khalid); level 2: the HR Admin
    seat1 := (select m.user_id from public.org_memberships m where m.organization_id = org and m.employee_id = l.manager_employee_id and m.status = 'active');
    req := pg_temp.approval('leave:' || l.num || ':' || l.sd, 'LEAVE', pg_temp.sid('leave:' || l.num || ':' || l.sd), l.emp,
             (select m.user_id from public.org_memberships m where m.organization_id = org and m.employee_id = l.emp and m.status = 'active'), l.created::timestamptz, l.outcome,
             seat1, case when l.outcome <> 'PENDING' then l.created::timestamptz + interval '3 hours' end, null,
             hr_id, case when l.outcome = 'APPROVED' then l.created::timestamptz + interval '20 hours' end, case when l.outcome = 'APPROVED' then l.note end, days);
    insert into public.leave_records (id, organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, is_half_day, half_day_part, status, source, reason, days,
      approved_by, approved_at, decision_note, approval_request_id, created_by, created_at)
    values (pg_temp.sid('leave:' || l.num || ':' || l.sd), org, l.emp, l.branch_id, l.type_id, l.sd::date, l.ed::date, l.part is not null, l.part::public.half_day_part,
            l.outcome::public.leave_status, 'INTERNAL', l.reason, days,
            case when l.outcome = 'APPROVED' then hr_id end, case when l.outcome = 'APPROVED' then l.created::timestamptz + interval '20 hours' end,
            l.note, req, (select m.user_id from public.org_memberships m where m.organization_id = org and m.employee_id = l.emp and m.status = 'active'), l.created::timestamptz)
    on conflict (id) do nothing;
  end loop;

  ---------------------------------------------------------------------------------------------------------------------
  -- 2. Punches: government hours 07:30–14:30, Sunday–Thursday, one habit profile per employee
  ---------------------------------------------------------------------------------------------------------------------
  create temp table seed_punch (emp uuid, num text, pin text, at timestamptz, dir text, verify text, d date) on commit drop;
  create temp table seed_inserted (pin text, at timestamptz) on commit drop;

  for e in
    select x.id, x.employee_number as num, x.device_user_id as pin, x.joining_date, coalesce(x.weekly_off_days, org_off) as woff, p.late, p.late_max, p.ot, p.ot_max, p.early, p.abs
    from public.employees x
    join (values
      -- num, P(late), max minutes late, P(overtime), max overtime minutes, P(early departure), P(unplanned absence)
      ('RIA-001', 0.03, 20, 0.45, 90, 0.02, 0.000),   -- Director General: punctual, often stays on
      ('RIA-002', 0.04, 20, 0.15, 45, 0.02, 0.000),   -- HR Manager: punctual
      ('RIA-003', 0.12, 35, 0.35, 75, 0.03, 0.000),   -- Head of Research Programmes: overtime-prone
      ('RIA-004', 0.10, 30, 0.10, 40, 0.04, 0.010),   -- Research Scientist: average
      ('RIA-005', 0.35, 55, 0.05, 30, 0.08, 0.025)    -- Data Scientist: late-prone (late flags, attendance points)
    ) as p(num, late, late_max, ot, ot_max, early, abs) on p.num = x.employee_number
    where x.organization_id = org and x.deleted_at is null and x.employment_status = 'active'
  loop
    for d in select generate_series(greatest(fill_from, e.joining_date), d_to, interval '1 day')::date loop
      key := e.num || ':' || d::text;
      continue when extract(dow from d)::int = any (e.woff);
      continue when exists (select 1 from public.holidays h where h.organization_id = org and h.date <= d and coalesce(h.end_date, h.date) >= d);

      select lr.is_half_day, lr.half_day_part::text into lv_half, lv_part from public.leave_records lr
        where lr.organization_id = org and lr.employee_id = e.id and lr.status = 'APPROVED' and lr.start_date <= d and lr.end_date >= d order by lr.is_half_day limit 1;
      on_leave := found;
      continue when on_leave and not lv_half;
      continue when exists (select 1 from public.leave_records lr where lr.organization_id = org and lr.employee_id = e.id and lr.status = 'PENDING'
                              and not lr.is_half_day and lr.start_date <= d and lr.end_date >= d);
      continue when pg_temp.u(key || ':abs') < e.abs;                                   -- unplanned absence

      in_off := case when pg_temp.u(key || ':late') < e.late then 16 + pg_temp.u(key || ':late2') * (e.late_max - 16)
                     else -25 + pg_temp.u(key || ':in') * 33 end;                        -- inside the 15-minute grace otherwise
      out_off := -2 + pg_temp.u(key || ':out') * 14;
      if pg_temp.u(key || ':ot') < e.ot then out_off := 31 + pg_temp.u(key || ':ot2') * (e.ot_max - 31);
      elsif pg_temp.u(key || ':early') < e.early then out_off := -(10 + pg_temp.u(key || ':early2') * 35); end if;

      in_at := ((d + sh.start_time) + make_interval(secs => round(in_off * 60)::int + floor(pg_temp.u(key || ':insec') * 60)::int)) at time zone tz;
      out_at := ((d + sh.end_time) + make_interval(secs => round(out_off * 60)::int + floor(pg_temp.u(key || ':outsec') * 60)::int)) at time zone tz;
      if on_leave and lv_part = 'FIRST_HALF' then in_at := (d + time '11:00' + make_interval(mins => floor(pg_temp.u(key || ':half') * 15)::int)) at time zone tz; end if;
      if on_leave and lv_part = 'SECOND_HALF' then out_at := (d + time '11:00' + make_interval(mins => floor(pg_temp.u(key || ':half') * 20)::int)) at time zone tz; end if;

      -- Reem forgot to punch out on Wednesday 14 Oct (her correction request is below); a rare missed punch-out otherwise
      missing_out := (e.num = 'RIA-004' and d = date '2026-10-14') or (not on_leave and pg_temp.u(key || ':missout') < 0.012);
      verify := case when pg_temp.u(key || ':verify') < 0.75 then 'face' when pg_temp.u(key || ':verify') < 0.95 then 'fingerprint' else 'card' end;

      insert into seed_punch values (e.id, e.num, e.pin, in_at, 'in', verify, d);
      if pg_temp.u(key || ':dup') < 0.02 then
        insert into seed_punch values (e.id, e.num, e.pin, in_at + make_interval(secs => 20 + floor(pg_temp.u(key || ':dup2') * 30)::int), 'in', verify, d);
      end if;
      if not missing_out then insert into seed_punch values (e.id, e.num, e.pin, out_at, 'out', verify, d); end if;
    end loop;
  end loop;

  -- Hikvision ISAPI AccessControllerEvent rows, as the HTTP-Listening endpoint stores them (allowlisted payload, no picture);
  -- the terminal's event serial number carries on from its last event
  with last_serial as (
    select max(r.provider_transaction_id::bigint) as last_no from public.attendance_raw_transactions r
    where r.organization_id = org and r.device_id = dev and r.provider_transaction_id ~ '^[0-9]+$'
  ), s as (
    select p.*, coalesce((select ls.last_no from last_serial ls), 1000) + row_number() over (order by p.at, p.pin) as serial
    from seed_punch p
    where p.at > cutoff and p.at <= now()
  ), ins as (
    insert into public.attendance_raw_transactions (organization_id, device_id, branch_id, provider_key, provider_transaction_id, device_employee_id, employee_id, punched_at, device_local_time, verification_method, direction,
      raw_payload, received_at, source, sync_job_id, dedupe_hash, processing_status, assumed_timezone, clock_skew_seconds, device_generation)
    select org, dev, pg_temp.sid('branch:HQ'), 'hikvision_push', s.serial::text, s.pin, null, s.at,
           to_char(s.at at time zone tz, 'YYYY-MM-DD"T"HH24:MI:SS') || '+04:00', s.verify::public.verification_method, s.dir::public.punch_direction,
           jsonb_build_object('mask', 'no', 'doorNo', 1, 'dateTime', to_char(s.at at time zone tz, 'YYYY-MM-DD"T"HH24:MI:SS') || '+04:00', 'protocol', 'hikvision',
                              'serialNo', s.serial, 'userType', 'normal', 'eventType', 'AccessControllerEvent',
                              'employeeNo', s.pin, 'cardReaderNo', 1, 'serialNumber', 'FZD-RIA-0001',
                              'subEventType', case s.verify when 'face' then 75 when 'fingerprint' then 38 else 1 end, 'majorEventType', 5, 'activePostCount', 1,
                              'attendanceStatus', case s.dir when 'in' then 'checkIn' else 'checkOut' end, 'currentVerifyMode', 'faceOrFpOrCardOrPw'),
           s.at + make_interval(secs => 1 + floor(pg_temp.u(s.num || s.at::text || ':rcv') * 6)::int), 'DEVICE_PUSH', null,
           encode(extensions.digest(dev::text || '|1|' || s.pin || '|' || to_char(s.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '|' || s.verify || '|' || s.dir, 'sha256'), 'hex'),
           'pending', tz, floor(pg_temp.u(s.num || s.at::text || ':skew') * 4)::int, 1
    from s
    on conflict (organization_id, device_id, dedupe_hash, punched_at) do nothing
    returning device_employee_id, punched_at
  )
  insert into seed_inserted select device_employee_id, punched_at from ins;
  get diagnostics n = row_count;
  raise notice 'raw punches inserted: % (after %, % → %)', n, cutoff, fill_from, d_to;

  -- a day this run has just given its terminal punches is no longer unexplained: revoke the day-close sweep's mark on it
  update public.attendance_day_marks m set revoked_at = now(), revoke_reason = 'Test tenant seed: the day now has terminal punches (demo history)'
  where m.organization_id = org and m.kind = 'UNEXCUSED' and m.source = 'SWEEP' and m.revoked_at is null
    and exists (select 1 from seed_inserted i join seed_punch p on p.pin = i.pin and p.at = i.at where p.emp = m.employee_id and p.d = m.attendance_date);

  ---------------------------------------------------------------------------------------------------------------------
  -- 3. Reem's correction request for the missed punch-out of 14 Oct, waiting for her line manager (created once)
  ---------------------------------------------------------------------------------------------------------------------
  corr := pg_temp.sid('correction:RIA-004:2026-10-14');
  if d_to > date '2026-10-14' and not exists (select 1 from public.attendance_corrections where id = corr) then
    req := pg_temp.approval('correction:RIA-004:2026-10-14', 'ATTENDANCE_CORRECTION', corr, pg_temp.sid('emp:RIA-004'), emp_id, timestamptz '2026-10-15 07:52:00+04', 'PENDING',
             mgr_id, null, null, hr_id, null, null);
    insert into public.attendance_corrections (id, organization_id, employee_id, branch_id, attendance_date, type, proposed_punched_at, proposed_event_type, reason, requested_by, status, approval_request_id, created_at)
    values (corr, org, pg_temp.sid('emp:RIA-004'), pg_temp.sid('branch:HQ'), '2026-10-14', 'ADD_PUNCH', timestamptz '2026-10-14 14:41:00+04', 'PUNCH_OUT',
            'Forgot to punch out — left at 14:41 after the lab safety briefing.', emp_id, 'PENDING', req, timestamptz '2026-10-15 07:52:00+04');
  end if;

  ---------------------------------------------------------------------------------------------------------------------
  -- 4. Hand over to the worker: normalise now, recompute the window, payroll summaries of the months it touches
  ---------------------------------------------------------------------------------------------------------------------
  update public.devices set connection_status = 'online', last_heartbeat_at = now(), last_successful_communication_at = now(), last_attendance_sync_at = now(), updated_at = now()
  where id = dev;

  perform app.enqueue_job('processing', 'NORMALIZE_RAW', org, jsonb_build_object('organizationId', org), 6, now(), 'normalize:' || org::text, 3, 600, 'seed-ria');

  insert into public.attendance_recalculation_requests (id, organization_id, from_date, to_date, reason, requested_by, status)
  values (gen_random_uuid(), org, fill_from, d_to, 'Test tenant data: terminal history and leave (RIA seed)', hr_id, 'QUEUED') returning id into req;
  job_id := app.enqueue_job('processing', 'RECALCULATE_RANGE', org, jsonb_build_object('organizationId', org, 'requestId', req), 3, now() + interval '5 minutes', 'recalculate:' || req::text, 3, 3600, 'seed-ria');
  update public.attendance_recalculation_requests set queue_job_id = job_id where id = req;

  -- the same days as parallel RECOMPUTE_DAILY jobs (recompute-queue contract: priority 5, dedupe key recompute:<employee>:<date>)
  -- finish the punch-less days (leave, weekly offs, absences) in a minute or two; both are idempotent
  perform app.enqueue_job('processing', 'RECOMPUTE_DAILY', org, jsonb_build_object('organizationId', org, 'employeeId', x.id, 'date', g::date, 'reason', 'RECALCULATION'),
                          5, now() + interval '2 minutes', 'recompute:' || x.id || ':' || g::date, 5, 120, 'seed-ria')
  from public.employees x, generate_series(fill_from, d_to, interval '1 day') g
  where x.organization_id = org and x.deleted_at is null and x.employment_status = 'active' and g::date >= x.joining_date;

  perform app.enqueue_job('processing', 'BUILD_PERIOD_SUMMARY', org,
    jsonb_build_object('organizationId', org, 'periodStart', p.ps, 'periodEnd', p.pe, 'finalize', false, 'requestedBy', hr_id),
    4, now() + interval '15 minutes', 'period:' || org::text || ':all:' || p.ps || ':' || p.pe || ':build', 6, 600, 'seed-ria')
  from (select m::date as ps, (m + interval '1 month - 1 day')::date as pe
        from generate_series(date_trunc('month', fill_from::timestamp), date_trunc('month', d_to::timestamp), interval '1 month') m) as p;
end $$;

select 'activity' as step,
  (select count(*) from public.leave_records where organization_id = '1fa2602c-06d4-4341-86ba-2bc971d83563') as leave_records,
  (select count(*) from public.attendance_raw_transactions where organization_id = '1fa2602c-06d4-4341-86ba-2bc971d83563') as raw_punches,
  (select min(punched_at) from public.attendance_raw_transactions where organization_id = '1fa2602c-06d4-4341-86ba-2bc971d83563') as first_punch,
  (select max(punched_at) from public.attendance_raw_transactions where organization_id = '1fa2602c-06d4-4341-86ba-2bc971d83563') as last_punch,
  (select count(*) from public.approval_requests where organization_id = '1fa2602c-06d4-4341-86ba-2bc971d83563' and status = 'PENDING') as pending_approvals,
  (select count(*) from jobs.queue where organization_id = '1fa2602c-06d4-4341-86ba-2bc971d83563' and status = 'pending') as queued_jobs;
