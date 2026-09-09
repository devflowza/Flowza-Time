-- FlowZa Time · demo tenant seed · Majan Gulf Trading & Contracting LLC · step 4/5: six months of terminal punches
--
-- Generates realistic raw ZKTeco push transactions (1 Mar 2026 → yesterday, Muscat time) for every employee and hands
-- them to the worker exactly the way a real terminal would: rows are inserted `pending`, the worker's NORMALIZE_RAW job
-- turns them into events and debounced RECOMPUTE_DAILY jobs, a RECALCULATE_RANGE request fills the punch-less days
-- (absent / weekly off / holiday / leave) and BUILD_PERIOD_SUMMARY produces the monthly payroll summaries. Nothing here
-- computes attendance itself — the real engine does — so every number in the app is the engine's own result.
--
-- Deterministic: every decision (arrival jitter, overtime, absences, missing punches, device, verification method) is a
-- hash of employee + date, so re-running regenerates identical rows and `on conflict do nothing` keeps the append-only
-- raw table free of duplicates. Must run after 03_leave.sql (approved leave suppresses punches).
set client_min_messages = warning;

create or replace function pg_temp.sid(p text) returns uuid language sql immutable as
$$ select extensions.uuid_generate_v5('27bfe270-5dea-4587-aec3-0f5c23113261'::uuid, p) $$;
create or replace function pg_temp.u(p text) returns double precision language sql immutable as
$$ select (('x' || substr(md5('majan-2026:' || p), 1, 8))::bit(32)::bigint)::double precision / 4294967296.0 $$;

do $$
declare
  org uuid := '27bfe270-5dea-4587-aec3-0f5c23113261';
  owner_id uuid := '82f009ce-9248-4550-b030-896746ef2e73';
  hradmin_id uuid := pg_temp.sid('user:hradmin@flowza.ai');
  hruser_id uuid := pg_temp.sid('user:hruser@flowza.ai');
  attadmin_id uuid := pg_temp.sid('user:attadmin@flowza.ai');
  tz text := 'Asia/Muscat';
  d_from date := '2026-03-01';
  d_to date := (now() at time zone 'Asia/Muscat')::date - 1;
  org_off smallint[] := '{5,6}';
  default_cal uuid := pg_temp.sid('holiday-calendar:default');
  hq uuid := pg_temp.sid('branch:MCT-HQ');
  hq1 uuid := pg_temp.sid('device:MCT-HQ-D01');
  hq2 uuid := pg_temp.sid('device:MCT-HQ-D02');
  e record; d date; key text; c record;
  br uuid; woff smallint[]; calid uuid; dev_id uuid;
  is_off boolean; is_hol boolean; on_leave boolean; lv_half boolean; lv_part text; ramadan boolean;
  t_start time; t_end time; base_start timestamp; base_end timestamp;
  in_off double precision; out_off double precision; ot double precision; early double precision;
  in_at timestamptz; out_at timestamptz; verify text;
  missing_out boolean; missing_in boolean;
  req_id uuid; job_id bigint; ps date; i int; n_corr int := 0;
begin
  create temp table seed_punch (emp uuid, num text, pin text, br uuid, dev uuid, at timestamptz, dir text, verify text) on commit drop;
  create temp table seed_missing (emp uuid, num text, d date, br uuid, expected_out timestamptz) on commit drop;

  ---------------------------------------------------------------------------------------------------------------------
  -- 1. Punches
  ---------------------------------------------------------------------------------------------------------------------
  for e in
    select emp.id, emp.employee_number as num, emp.device_user_id as pin, emp.joining_date, emp.exit_date, emp.branch_id as cur_branch,
           coalesce((emp.custom_fields ->> 'ramadanEligible')::boolean, false) as ramadan_ok,
           emp.fingerprint_enrolled as fp, emp.face_enrolled as face, (emp.card_number is not null) as has_card,
           coalesce(
             (select s.code from public.shift_assignments a join public.shifts s on s.id = a.shift_id where a.organization_id = org and a.target_type = 'EMPLOYEE' and a.target_id = emp.id limit 1),
             (select s.code from public.shift_assignments a join public.shifts s on s.id = a.shift_id join public.team_members tm on tm.team_id = a.target_id where a.organization_id = org and a.target_type = 'TEAM' and tm.employee_id = emp.id limit 1),
             (select s.code from public.shift_assignments a join public.shifts s on s.id = a.shift_id where a.organization_id = org and a.target_type = 'BRANCH' and a.target_id = emp.branch_id limit 1),
             'OFFICE')::text as shift_code,
           -- per-employee habits: punctuality band, overtime appetite, absence rate, lunch punching, preferred verification
           pg_temp.u(emp.employee_number || ':punct') as up, pg_temp.u(emp.employee_number || ':ot') as uo, pg_temp.u(emp.employee_number || ':abs') as ua,
           pg_temp.u(emp.employee_number || ':lunch') as ul, pg_temp.u(emp.employee_number || ':verify') as uv
    from public.employees emp where emp.organization_id = org and emp.deleted_at is null
  loop
    for d in select generate_series(greatest(d_from, e.joining_date), least(d_to, coalesce(e.exit_date, d_to)), interval '1 day')::date loop
      key := e.num || ':' || d::text;

      -- placement on this date (branch transfers), weekly off and holidays of that branch
      select h.branch_id into br from public.employment_history h where h.employee_id = e.id and h.effective_from <= d and (h.effective_to is null or h.effective_to > d) order by h.effective_from desc limit 1;
      br := coalesce(br, e.cur_branch);
      select b.weekly_off_days, b.holiday_calendar_id into woff, calid from public.branches b where b.id = br;
      is_off := extract(dow from d)::int = any (coalesce(woff, org_off));
      is_hol := exists (select 1 from public.holidays h where h.organization_id = org and h.calendar_id = coalesce(calid, default_cal)
                          and h.date <= d and coalesce(h.end_date, h.date) >= d and (h.branch_ids is null or br = any (h.branch_ids)));
      select l.is_half_day, l.half_day_part::text into lv_half, lv_part from public.leave_records l
        where l.organization_id = org and l.employee_id = e.id and l.status = 'APPROVED' and l.start_date <= d and l.end_date >= d order by l.is_half_day limit 1;
      on_leave := found;

      if on_leave and not lv_half then continue; end if;                                   -- full-day leave: no punches
      if (is_off or is_hol) and not (e.shift_code = 'SITE' and pg_temp.u(key || ':wend') < case when is_hol then 0.01 else 0.04 end) then continue; end if;
      if pg_temp.u(key || ':abs') < 0.004 + e.ua * 0.03 then continue; end if;             -- unplanned absence

      ramadan := e.ramadan_ok and d between date '2026-02-18' and date '2026-03-19';
      case e.shift_code
        when 'SITE' then t_start := time '07:00'; t_end := time '16:00';
        when 'FLEX' then t_start := time '08:30' + make_interval(mins => floor(pg_temp.u(key || ':flexin') * 90)::int); t_end := t_start + interval '8 hours 45 minutes';
        else t_start := time '08:00'; t_end := time '17:00';
      end case;
      if ramadan then t_end := t_start + interval '6 hours'; end if;
      base_start := d + t_start;
      base_end := d + t_end;

      -- arrival: three punctuality bands (55 % punctual, 30 % average, 15 % late-prone); grace is 10 minutes
      if e.shift_code = 'FLEX' then
        in_off := -5 + pg_temp.u(key || ':in') * 10;
      elsif e.up < 0.55 then
        in_off := case when pg_temp.u(key || ':late') < 0.04 then 11 + pg_temp.u(key || ':late2') * 14 else -25 + pg_temp.u(key || ':in') * 31 end;
      elsif e.up < 0.85 then
        in_off := case when pg_temp.u(key || ':late') < 0.12 then 11 + pg_temp.u(key || ':late2') * 29 else -15 + pg_temp.u(key || ':in') * 24 end;
      else
        in_off := case when pg_temp.u(key || ':late') < 0.45 then 8 + pg_temp.u(key || ':late2') * 47 else -8 + pg_temp.u(key || ':in') * 17 end;
      end if;

      -- departure: overtime for the overtime-prone (22 % of staff) and occasionally for everyone else; rare early departures
      ot := 0; early := 0;
      if e.uo < 0.22 and pg_temp.u(key || ':ot') < 0.40 then ot := 35 + pg_temp.u(key || ':ot2') * 115;
      elsif pg_temp.u(key || ':ot') < 0.06 then ot := 35 + pg_temp.u(key || ':ot2') * 60; end if;
      if ramadan then ot := 0; end if;
      if ot = 0 and pg_temp.u(key || ':early') < 0.05 then early := 15 + pg_temp.u(key || ':early2') * 30; end if;
      out_off := -3 + pg_temp.u(key || ':out') * 17 + ot - early;

      in_at := (base_start + make_interval(secs => round(in_off * 60)::int + floor(pg_temp.u(key || ':insec') * 60)::int)) at time zone tz;
      out_at := (base_end + make_interval(secs => round(out_off * 60)::int + floor(pg_temp.u(key || ':outsec') * 60)::int)) at time zone tz;
      if on_leave and lv_part = 'FIRST_HALF' then in_at := (d + time '13:00' + make_interval(mins => floor(pg_temp.u(key || ':half') * 20)::int)) at time zone tz; end if;
      if on_leave and lv_part = 'SECOND_HALF' then out_at := (d + time '12:30' + make_interval(mins => floor(pg_temp.u(key || ':half') * 35)::int)) at time zone tz; end if;

      missing_out := not on_leave and pg_temp.u(key || ':missout') < 0.015;
      missing_in := not on_leave and not missing_out and pg_temp.u(key || ':missin') < 0.005;

      -- which terminal (head office has two: 80 % main entrance, 20 % basement) and how they verified
      dev_id := case when br = hq then case when pg_temp.u(key || ':dev') < 0.8 then hq1 else hq2 end
                     else (select dv.id from public.devices dv where dv.organization_id = org and dv.branch_id = br order by dv.code limit 1) end;
      verify := case when e.uv < 0.70 and e.fp then 'fingerprint' when e.uv < 0.92 and e.face then 'face' when e.has_card then 'card' when e.fp then 'fingerprint' else 'face' end;
      if pg_temp.u(key || ':vday') < 0.08 then verify := case when e.has_card then 'card' when e.face then 'face' else verify end; end if;

      if not missing_in then insert into seed_punch values (e.id, e.num, e.pin, br, dev_id, in_at, 'in', verify); end if;
      if pg_temp.u(key || ':dup') < 0.02 then insert into seed_punch values (e.id, e.num, e.pin, br, dev_id, in_at + make_interval(secs => 20 + floor(pg_temp.u(key || ':dup2') * 30)::int), 'in', verify); end if;
      if e.shift_code = 'OFFICE' and not ramadan and not on_leave and e.ul < 0.25 and pg_temp.u(key || ':lunch') < 0.55 then
        insert into seed_punch values (e.id, e.num, e.pin, br, dev_id, (d + time '13:00' + make_interval(mins => floor(pg_temp.u(key || ':l1') * 12)::int, secs => floor(pg_temp.u(key || ':l1s') * 60)::int)) at time zone tz, 'break_out', verify);
        insert into seed_punch values (e.id, e.num, e.pin, br, dev_id, (d + time '13:45' + make_interval(mins => floor(pg_temp.u(key || ':l2') * 20)::int, secs => floor(pg_temp.u(key || ':l2s') * 60)::int)) at time zone tz, 'break_in', verify);
      end if;
      if missing_out then insert into seed_missing values (e.id, e.num, d, br, out_at);
      else insert into seed_punch values (e.id, e.num, e.pin, br, dev_id, out_at, 'out', verify); end if;
    end loop;
  end loop;

  -- raw ADMS-style rows, left for the worker's normaliser (employee_id stays null until it resolves the PIN)
  insert into public.attendance_raw_transactions (organization_id, device_id, branch_id, provider_key, provider_transaction_id, device_employee_id, employee_id, punched_at, device_local_time, verification_method, direction,
    raw_payload, received_at, source, sync_job_id, dedupe_hash, processing_status, assumed_timezone, clock_skew_seconds, device_generation)
  select org, p.dev, p.br, 'zkteco_push', dv.serial_number || ':' || to_char(p.at at time zone tz, 'YYYYMMDDHH24MISS') || ':' || p.pin, p.pin, null, p.at,
         to_char(p.at at time zone tz, 'YYYY-MM-DD HH24:MI:SS'), v.verify::public.verification_method, p.dir::public.punch_direction,
         jsonb_build_object('table', 'ATTLOG', 'sn', dv.serial_number, 'pin', p.pin, 'time', to_char(p.at at time zone tz, 'YYYY-MM-DD HH24:MI:SS'),
                            'status', case p.dir when 'in' then '0' when 'out' then '1' when 'break_out' then '2' else '3' end,
                            'verify', case v.verify when 'fingerprint' then '1' when 'face' then '15' when 'card' then '2' else '0' end, 'workcode', '0'),
         p.at + make_interval(secs => 2 + floor(pg_temp.u(p.num || p.at::text || ':rcv') * 40)::int), 'DEVICE_PUSH', null,
         encode(extensions.digest(p.dev::text || '|' || p.pin || '|' || to_char(p.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '|' || v.verify || '|' || p.dir, 'sha256'), 'hex'),
         'pending', tz, dv.device_time_offset_seconds, 1
  from seed_punch p
  join public.devices dv on dv.id = p.dev
  cross join lateral (select case when p.verify = 'face' and dv.model_name in ('F22', 'K40', 'F18') then 'fingerprint' else p.verify end as verify) v
  on conflict (organization_id, device_id, dedupe_hash, punched_at) do nothing;

  ---------------------------------------------------------------------------------------------------------------------
  -- 2. Corrections for some of the missed punch-outs, through the real approval workflow
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.approval_workflows (id, organization_id, entity_type, name, branch_id, steps, is_default, status, created_at)
  values (pg_temp.sid('workflow:corrections'), org, 'ATTENDANCE_CORRECTION', 'Line manager → HR', null,
          jsonb_build_array(jsonb_build_object('order', 1, 'approverType', 'MANAGER'), jsonb_build_object('order', 2, 'approverType', 'ROLE', 'roleId', '10000000-0000-0000-0000-000000000003')), true, 'active', '2026-02-16 09:00:00+04')
  on conflict (id) do update set steps = excluded.steps, is_default = true, status = 'active', updated_at = now();

  for c in
    select m.*, row_number() over (order by m.d, m.num) as rn, ee.manager_employee_id,
           (select om.user_id from public.employees mg join public.org_memberships om on om.employee_id = mg.id and om.status = 'active' where mg.id = ee.manager_employee_id limit 1) as manager_user
    from seed_missing m join public.employees ee on ee.id = m.emp
    where m.d <= d_to - 3
    order by m.d, m.num limit 6
  loop
    n_corr := n_corr + 1;
    insert into public.approval_requests (id, organization_id, workflow_id, entity_type, entity_id, branch_id, employee_id, current_step, status, requested_by, completed_at, created_at)
    values (pg_temp.sid('approval:' || c.num || ':' || c.d), org, pg_temp.sid('workflow:corrections'), 'ATTENDANCE_CORRECTION', pg_temp.sid('correction:' || c.num || ':' || c.d), c.br, c.emp,
            case when c.rn <= 3 then 2 else 1 end, case when c.rn <= 3 then 'APPROVED' when c.rn <= 5 then 'PENDING' else 'REJECTED' end::public.approval_status,
            case when c.rn % 2 = 0 then attadmin_id else hruser_id end,
            case when c.rn <= 3 or c.rn = 6 then ((c.d + 2) + time '11:30') at time zone tz end, ((c.d + 1) + time '09:10') at time zone tz)
    on conflict (id) do nothing;

    insert into public.attendance_corrections (id, organization_id, employee_id, branch_id, attendance_date, type, proposed_punched_at, proposed_event_type, reason, requested_by, status, approval_request_id, rejection_reason, created_at)
    values (pg_temp.sid('correction:' || c.num || ':' || c.d), org, c.emp, c.br, c.d, 'ADD_PUNCH', c.expected_out, 'PUNCH_OUT',
            'Forgot to punch out — left at ' || to_char(c.expected_out at time zone tz, 'HH24:MI') || ' (confirmed by line manager)',
            case when c.rn % 2 = 0 then attadmin_id else hruser_id end,
            case when c.rn <= 3 then 'APPROVED' when c.rn <= 5 then 'PENDING' else 'REJECTED' end::public.correction_status,
            pg_temp.sid('approval:' || c.num || ':' || c.d),
            case when c.rn = 6 then 'No supporting evidence from the line manager' end,
            ((c.d + 1) + time '09:10') at time zone tz)
    on conflict (id) do nothing;

    insert into public.approval_steps (id, organization_id, request_id, step_no, approver_type, approver_role_id, approver_user_id, status, acted_by, acted_at, comment)
    values
      (pg_temp.sid('approval-step:' || c.num || ':' || c.d || ':1'), org, pg_temp.sid('approval:' || c.num || ':' || c.d), 1,
       case when c.manager_user is null then 'ROLE' else 'USER' end::public.approver_type, case when c.manager_user is null then '10000000-0000-0000-0000-000000000003'::uuid end, c.manager_user,
       case when c.rn <= 3 then 'APPROVED' when c.rn <= 5 then 'PENDING' else 'REJECTED' end::public.approval_status,
       case when c.rn <= 3 or c.rn = 6 then coalesce(c.manager_user, hradmin_id) end, case when c.rn <= 3 or c.rn = 6 then ((c.d + 1) + time '16:45') at time zone tz end,
       case when c.rn <= 3 then 'Confirmed — the employee was on site until closing' when c.rn = 6 then 'No supporting evidence from the line manager' end),
      (pg_temp.sid('approval-step:' || c.num || ':' || c.d || ':2'), org, pg_temp.sid('approval:' || c.num || ':' || c.d), 2, 'ROLE', '10000000-0000-0000-0000-000000000003', null,
       case when c.rn <= 3 then 'APPROVED' else 'PENDING' end::public.approval_status,
       case when c.rn <= 3 then hradmin_id end, case when c.rn <= 3 then ((c.d + 2) + time '11:30') at time zone tz end, case when c.rn <= 3 then 'Approved' end)
    on conflict (id) do nothing;

    -- the worker applies approved corrections (adds the CORRECTION event and recomputes the day) once the history is loaded
    if c.rn <= 3 then
      perform app.enqueue_job('processing', 'APPLY_CORRECTION', org, jsonb_build_object('organizationId', org, 'correctionId', pg_temp.sid('correction:' || c.num || ':' || c.d), 'appliedBy', hradmin_id),
                              7, now() + interval '25 minutes', 'apply:' || pg_temp.sid('correction:' || c.num || ':' || c.d)::text, 5, 120, 'seed-majan');
    end if;
  end loop;

  ---------------------------------------------------------------------------------------------------------------------
  -- 3. Hand over to the worker: normalise now, recalculate the whole window in 12 minutes, build payroll summaries in 30
  ---------------------------------------------------------------------------------------------------------------------
  perform app.enqueue_job('processing', 'NORMALIZE_RAW', org, jsonb_build_object('organizationId', org), 6, now(), 'normalize:' || org::text, 3, 600, 'seed-majan');

  insert into public.attendance_recalculation_requests (id, organization_id, from_date, to_date, reason, requested_by, status)
  values (gen_random_uuid(), org, d_from, d_to, 'Initial load of six months of terminal history (demo seed)', owner_id, 'QUEUED') returning id into req_id;
  job_id := app.enqueue_job('processing', 'RECALCULATE_RANGE', org, jsonb_build_object('organizationId', org, 'requestId', req_id), 3, now() + interval '12 minutes', 'recalculate:' || req_id::text, 3, 3600, 'seed-majan');
  update public.attendance_recalculation_requests set queue_job_id = job_id where id = req_id;

  for i in 0..5 loop
    ps := date '2026-03-01' + make_interval(months => i);
    perform app.enqueue_job('processing', 'BUILD_PERIOD_SUMMARY', org,
      jsonb_build_object('organizationId', org, 'periodStart', ps, 'periodEnd', (ps + interval '1 month' - interval '1 day')::date, 'finalize', false, 'requestedBy', owner_id),
      4, now() + interval '30 minutes', 'period:' || org::text || ':all:' || ps || ':' || (ps + interval '1 month' - interval '1 day')::date || ':build', 6, 600, 'seed-majan');
  end loop;
end $$;

select 'attendance' as step,
  (select count(*) from public.attendance_raw_transactions where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261') as raw_punches,
  (select min(punched_at) from public.attendance_raw_transactions where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261') as first_punch,
  (select max(punched_at) from public.attendance_raw_transactions where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261') as last_punch,
  (select count(*) from public.attendance_corrections where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261') as corrections,
  (select count(*) from jobs.queue where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261' and status = 'pending') as queued_jobs;
