-- FlowZa Time · Hikvision test tenant seed · step 3/5: the Enterprise modules
--
--   attendance_policies  · employee groups (Office Employees, 24/7 Shift Workers, Senior Management) and six scoped policies:
--                          Company standard (organisation) → Sohar Plant – Maintenance (branch) → Sales – Field staff
--                          (department) → Oman – Office Employees (country + group, from the OM pack) / Sohar Plant – 24/7
--                          Shift Workers (branch + group) / Senior Management – exempt (group) → Security – Night shift (shift)
--   advanced_scheduling  · the round-the-clock plans exactly as POST /round-the-clock writes them (domain
--                          buildRoundTheClockPlan): Security 2 × 12 h "4 on 4 off" and Warehouse 3 × 8 h "continental", four
--                          crews each anchored on 1 Sep, the crews' teams on their patterns, coverage targets of 2 per shift;
--                          double shifts (Customer Service evening support on top of the office day); branch deployments
--                          (completed, active, upcoming, cancelled)
--   shift_requests       · shift change requests (approved, approved double shift, rejected, three pending) and swaps
--                          (approved, pending), each with its approval request in the engine v2 shape
-- Approval workflows "Line manager → HR" for leave, corrections, shift changes and swaps: a manager without a login falls back
-- to the HR admins (reddyprem1311@gmail.com), and four-eyes hands level 2 to the owner (prem@flowza.ai) when the HR admin
-- approved level 1 — what the engine does live, so a seeded pending request is approved in the UI like a real one.
set client_min_messages = warning;

create or replace function pg_temp.sid(p text) returns uuid language sql immutable as
$$ select extensions.uuid_generate_v5('78a5a348-69b6-4c51-8d72-3697f72c50f0'::uuid, 'hk-demo:' || p) $$;
create or replace function pg_temp.emp(p_num text) returns uuid language sql stable as
$$ select id from public.employees where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0' and employee_number = p_num and deleted_at is null $$;

-- One approval request in the engine v2 shape: level 1 = the line manager (or the HR admins when the manager has no login),
-- level 2 = the HR Admin role (the owner when four-eyes excludes the HR admin who approved level 1). Idempotent.
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
  ghala uuid := '63751c8f-885c-4140-8bd7-1511876be027';
  sohar uuid := pg_temp.sid('branch:SOH');
  flex_shift uuid := 'ae0a0f8c-d7da-4096-a02c-d5111d9b4662';   -- the existing "1" flexible shift (001 and TEST001 stay on it)
  t0 timestamptz := '2026-08-25 10:00:00+04';
  wf_steps jsonb := '[{"order":1,"approverType":"MANAGER","mode":"ANY"},{"order":2,"approverType":"ROLE","roleId":"10000000-0000-0000-0000-000000000003","mode":"ANY"}]';
  ramadan_om jsonb := '{"enabled":true,"from":"2027-02-08","to":"2027-03-09","scheduledMinutes":360,"appliesTo":"flagged_employees"}';
  ramadan_off jsonb := '{"enabled":false,"appliesTo":"all"}';
  req uuid; a1 uuid; a2 uuid;
begin
  if not exists (select 1 from public.branches where id = sohar) then raise exception 'run 02_structure_people.sql first'; end if;

  ---------------------------------------------------------------------------------------------------------------------
  -- Approval workflows
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.approval_workflows (id, organization_id, entity_type, name, branch_id, steps, is_default, status, created_at)
  select pg_temp.sid('workflow:' || w.entity), org, w.entity::public.approval_entity, 'Line manager → HR', null, wf_steps, true, 'active', t0
  from (values ('LEAVE'), ('ATTENDANCE_CORRECTION'), ('SHIFT_CHANGE'), ('SHIFT_SWAP')) as w(entity)
  on conflict (id) do update set steps = excluded.steps, is_default = true, status = 'active', updated_at = now();

  ---------------------------------------------------------------------------------------------------------------------
  -- Employee groups (from 1 Aug, or the joining date)
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.employee_groups (id, organization_id, code, name, name_ar, description, status, created_by, created_at)
  values
    (pg_temp.sid('group:OFFICE'), org, 'OFFICE', 'Office Employees',   'موظفو المكتب',        'Head-office staff on the Oman office policy: HR, Finance, IT, Customer Service and Operations at Ghala.', 'active', hr_id, t0),
    (pg_temp.sid('group:SHIFT'),  org, 'SHIFT',  '24/7 Shift Workers', 'عمال المناوبات 24/7', 'Security and warehouse crews of the Sohar plant on the round-the-clock rotations. Terminal check-in only.', 'active', hr_id, t0),
    (pg_temp.sid('group:EXEC'),   org, 'EXEC',   'Senior Management',  'الإدارة العليا',       'Management & Administration: exempt from overtime and attendance points.', 'active', hr_id, t0)
  on conflict (organization_id, code) do update set name = excluded.name, name_ar = excluded.name_ar, description = excluded.description, status = 'active', updated_at = now();

  insert into public.employee_group_memberships (id, organization_id, employee_group_id, employee_id, effective_from, effective_to, created_by, created_at)
  select pg_temp.sid('group-member:' || e.employee_number), org, pg_temp.sid('group:' || g.code), e.id, greatest(e.joining_date, date '2026-08-01'), null, hr_id, t0
  from public.employees e
  join public.departments d on d.id = e.department_id
  cross join lateral (select case when d.code in ('HR', 'FIN', 'IT', 'CS', 'OPS') then 'OFFICE' when d.code in ('WH', 'SEC') then 'SHIFT' when d.code = 'MGMT' then 'EXEC' end as code) g
  where e.organization_id = org and e.deleted_at is null and g.code is not null
  on conflict (id) do nothing;

  ---------------------------------------------------------------------------------------------------------------------
  -- Round-the-clock plans (what POST /round-the-clock writes): shifts, crew patterns anchored on 1 Sep, crew teams
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.shifts (id, organization_id, code, name, type, start_time, end_time, day_boundary, breaks, punch_in_window_before_minutes, punch_out_window_after_minutes, color, status, created_at)
  values
    (pg_temp.sid('shift:SEC-D'), org, 'SEC-D', 'Security Day',      'FIXED', '06:00', '18:00', '00:00', '[{"minutes":60,"paid":false}]'::jsonb, 240, 360, '#F59E0B', 'active', t0),
    (pg_temp.sid('shift:SEC-N'), org, 'SEC-N', 'Security Night',    'FIXED', '18:00', '06:00', '00:00', '[{"minutes":60,"paid":false}]'::jsonb, 240, 360, '#4338CA', 'active', t0),
    (pg_temp.sid('shift:WH-M'),  org, 'WH-M',  'Warehouse Morning', 'FIXED', '06:00', '14:00', '00:00', '[{"minutes":30,"paid":false}]'::jsonb, 240, 360, '#0EA5E9', 'active', t0),
    (pg_temp.sid('shift:WH-E'),  org, 'WH-E',  'Warehouse Evening', 'FIXED', '14:00', '22:00', '00:00', '[{"minutes":30,"paid":false}]'::jsonb, 240, 360, '#F97316', 'active', t0),
    (pg_temp.sid('shift:WH-N'),  org, 'WH-N',  'Warehouse Night',   'FIXED', '22:00', '06:00', '00:00', '[{"minutes":30,"paid":false}]'::jsonb, 240, 360, '#4338CA', 'active', t0)
  on conflict (organization_id, code) do update set name = excluded.name, start_time = excluded.start_time, end_time = excluded.end_time, breaks = excluded.breaks, color = excluded.color, status = 'active', updated_at = now();

  -- crew k works on cycle day d what the base cycle has on day d − k·(cycle / 4)
  insert into public.shift_patterns (id, organization_id, code, name, cycle_length_days, sequence, anchor_date, status, created_at)
  select pg_temp.sid('pattern:' || p.prefix || '-' || c.crew), org, p.prefix || '-' || c.crew, p.label || ' Crew ' || c.crew, p.len,
         (select jsonb_agg(case when k.key is null then jsonb_build_object('day', g.day, 'off', true)
                                else jsonb_build_object('day', g.day, 'shiftId', pg_temp.sid('shift:' || p.prefix || '-' || k.key)) end order by g.day)
          from generate_series(0, p.len - 1) g(day)
          cross join lateral (select (p.cycle)[(((g.day - c.idx * (p.len / 4)) % p.len) + p.len) % p.len + 1] as key) k),
         date '2026-09-01', 'active', t0
  from (values ('SEC', 'Security',  16, array['D','D','D','D',null,null,null,null,'N','N','N','N',null,null,null,null]::text[]),
               ('WH',  'Warehouse',  8, array['M','M','E','E','N','N',null,null]::text[])) as p(prefix, label, len, cycle)
  cross join (values ('A', 0), ('B', 1), ('C', 2), ('D', 3)) as c(crew, idx)
  on conflict (organization_id, code) do update set name = excluded.name, cycle_length_days = excluded.cycle_length_days, sequence = excluded.sequence, anchor_date = excluded.anchor_date, status = 'active', updated_at = now();

  insert into public.teams (id, organization_id, branch_id, code, name, lead_employee_id, status, created_at)
  select pg_temp.sid('team:' || t.code), org, sohar, t.code, t.name, pg_temp.emp(t.lead), 'active', t0
  from (values ('SEC-A', 'Security Crew A', 'EMP081'), ('SEC-B', 'Security Crew B', 'EMP084'), ('SEC-C', 'Security Crew C', 'EMP087'), ('SEC-D', 'Security Crew D', 'EMP089'),
               ('WH-A', 'Warehouse Crew A', 'EMP071'), ('WH-B', 'Warehouse Crew B', 'EMP074'), ('WH-C', 'Warehouse Crew C', 'EMP077'), ('WH-D', 'Warehouse Crew D', 'EMP079')) as t(code, name, lead)
  on conflict (organization_id, code) do update set name = excluded.name, branch_id = excluded.branch_id, lead_employee_id = excluded.lead_employee_id, status = 'active', updated_at = now();

  insert into public.team_members (team_id, employee_id, organization_id, added_at)
  select pg_temp.sid('team:' || (e.custom_fields ->> 'crew')), e.id, org, t0
  from public.employees e where e.organization_id = org and e.deleted_at is null and e.custom_fields ->> 'crew' is not null
  on conflict do nothing;

  insert into public.shift_assignments (id, organization_id, target_type, target_id, branch_id, shift_id, shift_pattern_id, effective_from, effective_to, created_by, created_at)
  select pg_temp.sid('assign:team:' || c.code), org, 'TEAM', pg_temp.sid('team:' || c.code), sohar, null, pg_temp.sid('pattern:' || c.code), date '2026-09-01', null, hr_id, t0
  from (values ('SEC-A'), ('SEC-B'), ('SEC-C'), ('SEC-D'), ('WH-A'), ('WH-B'), ('WH-C'), ('WH-D')) as c(code)
  on conflict (id) do update set shift_pattern_id = excluded.shift_pattern_id, effective_from = excluded.effective_from, effective_to = excluded.effective_to;

  insert into public.shift_coverage_requirements (id, organization_id, branch_id, shift_id, weekdays, min_headcount, created_by, created_at)
  select pg_temp.sid('coverage:' || s.code), org, sohar, pg_temp.sid('shift:' || s.code), '{0,1,2,3,4,5,6}', 2, hr_id, t0
  from (values ('SEC-D'), ('SEC-N'), ('WH-M'), ('WH-E'), ('WH-N')) as s(code)
  -- branch-wide targets (no location): the key includes the location since migration 20261010000100 (nulls not distinct)
  on conflict (organization_id, branch_id, shift_id, location_id) do update set min_headcount = excluded.min_headcount, weekdays = excluded.weekdays, updated_at = now();

  ---------------------------------------------------------------------------------------------------------------------
  -- Attendance policies (attendance_rule_sets with scope + policy sections), all effective from 1 Aug 2026
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.attendance_rule_sets (id, organization_id, name, description, branch_id, country_code, department_id, employee_group_id, shift_id, effective_from,
    grace_in_minutes, grace_out_minutes, late_threshold_minutes, early_departure_threshold_minutes, min_full_day_minutes, half_day_threshold_minutes,
    overtime_enabled, overtime_start_after_minutes, overtime_min_block_minutes, overtime_rounding_minutes, overtime_max_minutes_per_day, count_early_in_as_overtime,
    punch_interpretation, duplicate_punch_window_seconds, missing_punch_behavior, auto_absent_without_punches, weekly_off_work_counts_as_overtime, holiday_work_counts_as_overtime,
    ramadan_mode, policy, created_by, created_at)
  values
    (pg_temp.sid('policy:company'), org, 'Company standard', 'Baseline for everybody no other policy covers.', null, null, null, null, null, '2026-08-01',
     10, 5, 0, 0, 420, 240, true, 30, 30, 15, 240, false, 'FIRST_LAST', 60, 'FLAG_ONLY', true, true, true, ramadan_off, '{}'::jsonb, hr_id, t0),

    (pg_temp.sid('policy:oman-office'), org, 'Oman – Office Employees', 'Created from the Oman country pack (Labour Law 53/2023): 8 h days, 40 h weeks, overtime capped at 4 h a day, rest-day and holiday work at 200 %.',
     null, 'OM', null, pg_temp.sid('group:OFFICE'), null, '2026-08-01',
     10, 5, 0, 0, 420, 240, true, 30, 30, 15, 240, false, 'FIRST_LAST', 60, 'FLAG_ONLY', true, true, true, ramadan_om,
     '{"countryPack":{"code":"OM","version":"2026.10"},
       "late":{"veryLateAfterMinutes":60,"repeatedLate":{"occurrences":3,"periodDays":30}},
       "methods":{"web":true,"mobile":true,"selfie":true,"requireGeofence":"flag"},
       "overtime":{"weeklyThresholdMinutes":2400,"maxDailyWorkMinutes":720,"rates":{"regular":1.25,"weekly":1.25,"weeklyOff":2,"holiday":2}},
       "points":{"enabled":true,"late":1,"veryLate":2,"earlyDeparture":1,"absent":3,"missingPunch":1,"unexcused":2,"repeatedLate":2,"expiryDays":90,
                 "escalation":[{"points":4,"action":"NOTIFY_MANAGER"},{"points":8,"action":"VERBAL_WARNING"},{"points":12,"action":"WRITTEN_WARNING"},{"points":18,"action":"FINAL_WARNING"},{"points":24,"action":"HR_REVIEW"}]},
       "regularisation":{"maxPerMonth":3,"backdateDays":7}}'::jsonb, hr_id, t0),

    (pg_temp.sid('policy:sohar-shift'), org, 'Sohar Plant – 24/7 Shift Workers', 'Security and warehouse crews: terminal check-in only, automatic check-out at the shift end when a punch-out is missing, stricter points.',
     sohar, null, null, pg_temp.sid('group:SHIFT'), null, '2026-08-01',
     5, 5, 0, 0, 420, 240, true, 15, 15, 15, 240, false, 'FIRST_LAST', 60, 'ASSUME_SHIFT_END', true, true, true, ramadan_off,
     '{"countryPack":{"code":"OM","version":"2026.10"},
       "late":{"veryLateAfterMinutes":30,"repeatedLate":{"occurrences":3,"periodDays":28}},
       "methods":{"web":false,"mobile":false,"selfie":false,"requireGeofence":"block"},
       "overtime":{"weeklyThresholdMinutes":2520,"maxDailyWorkMinutes":720,"rates":{"regular":1.25,"weekly":1.25,"weeklyOff":2,"holiday":2}},
       "points":{"enabled":true,"late":1,"veryLate":2,"earlyDeparture":1,"absent":4,"missingPunch":2,"unexcused":3,"repeatedLate":2,"expiryDays":60,
                 "escalation":[{"points":5,"action":"NOTIFY_MANAGER"},{"points":10,"action":"WRITTEN_WARNING"},{"points":15,"action":"HR_REVIEW"}]},
       "regularisation":{"maxPerMonth":2,"backdateDays":3}}'::jsonb, hr_id, t0),

    (pg_temp.sid('policy:security-night'), org, 'Security – Night shift', 'Night guards (18:00–06:00): 15 minutes of grace, half a point per late arrival.',
     sohar, null, null, null, pg_temp.sid('shift:SEC-N'), '2026-08-01',
     15, 5, 0, 0, 420, 240, true, 15, 15, 15, 240, false, 'FIRST_LAST', 60, 'ASSUME_SHIFT_END', true, true, true, ramadan_off,
     '{"countryPack":{"code":"OM","version":"2026.10"},
       "late":{"veryLateAfterMinutes":45,"repeatedLate":{"occurrences":3,"periodDays":28}},
       "methods":{"web":false,"mobile":false,"selfie":false,"requireGeofence":"block"},
       "overtime":{"weeklyThresholdMinutes":2520,"maxDailyWorkMinutes":720,"rates":{"regular":1.25,"weekly":1.25,"weeklyOff":2,"holiday":2}},
       "points":{"enabled":true,"late":0.5,"veryLate":1.5,"earlyDeparture":1,"absent":4,"missingPunch":2,"unexcused":3,"repeatedLate":2,"expiryDays":60,
                 "escalation":[{"points":5,"action":"NOTIFY_MANAGER"},{"points":10,"action":"WRITTEN_WARNING"},{"points":15,"action":"HR_REVIEW"}]},
       "regularisation":{"maxPerMonth":2,"backdateDays":3}}'::jsonb, hr_id, t0),

    (pg_temp.sid('policy:sales'), org, 'Sales – Field staff', 'Sales & Marketing: mobile check-in from customer sites without a geofence, no overtime, no points.',
     null, null, pg_temp.sid('dept:SALES'), null, null, '2026-08-01',
     15, 10, 0, 0, 420, 240, false, 0, 0, 0, null, false, 'FIRST_LAST', 60, 'FLAG_ONLY', true, false, false, ramadan_off,
     '{"countryPack":null,"late":{"veryLateAfterMinutes":90,"repeatedLate":null},
       "methods":{"web":true,"mobile":true,"selfie":true,"requireGeofence":"off"},
       "overtime":{"weeklyThresholdMinutes":null,"maxDailyWorkMinutes":null,"rates":{"regular":1.25,"weekly":1.25,"weeklyOff":1.5,"holiday":2}},
       "points":{"enabled":false,"late":1,"veryLate":2,"earlyDeparture":1,"absent":3,"missingPunch":1,"unexcused":2,"repeatedLate":2,"expiryDays":90,"escalation":[]},
       "regularisation":{"maxPerMonth":6,"backdateDays":14}}'::jsonb, hr_id, t0),

    (pg_temp.sid('policy:exec'), org, 'Senior Management – exempt', 'Management & Administration: 30 minutes of grace, no overtime, no attendance points.',
     null, null, null, pg_temp.sid('group:EXEC'), null, '2026-08-01',
     30, 15, 0, 0, 420, 240, false, 0, 0, 0, null, false, 'FIRST_LAST', 60, 'FLAG_ONLY', true, false, false, ramadan_off,
     '{"countryPack":null,"late":{"veryLateAfterMinutes":null,"repeatedLate":null},
       "methods":{"web":true,"mobile":true,"selfie":false,"requireGeofence":"off"},
       "overtime":{"weeklyThresholdMinutes":null,"maxDailyWorkMinutes":null,"rates":{"regular":1.25,"weekly":1.25,"weeklyOff":1.5,"holiday":2}},
       "points":{"enabled":false,"late":1,"veryLate":2,"earlyDeparture":1,"absent":3,"missingPunch":1,"unexcused":2,"repeatedLate":2,"expiryDays":90,"escalation":[]},
       "regularisation":{"maxPerMonth":null,"backdateDays":30}}'::jsonb, hr_id, t0),

    (pg_temp.sid('policy:sohar-maintenance'), org, 'Sohar Plant – Maintenance', 'Plant day staff (07:00–16:00, Sunday–Thursday).',
     sohar, null, null, null, null, '2026-08-01',
     10, 5, 0, 0, 420, 240, true, 30, 30, 15, 240, false, 'FIRST_LAST', 60, 'FLAG_ONLY', true, true, true, ramadan_off,
     '{"countryPack":{"code":"OM","version":"2026.10"},
       "late":{"veryLateAfterMinutes":60,"repeatedLate":{"occurrences":3,"periodDays":30}},
       "methods":{"web":true,"mobile":false,"selfie":false,"requireGeofence":"block"},
       "overtime":{"weeklyThresholdMinutes":2400,"maxDailyWorkMinutes":720,"rates":{"regular":1.25,"weekly":1.25,"weeklyOff":2,"holiday":2}},
       "points":{"enabled":true,"late":1,"veryLate":2,"earlyDeparture":1,"absent":3,"missingPunch":1,"unexcused":2,"repeatedLate":2,"expiryDays":90,
                 "escalation":[{"points":3,"action":"NOTIFY_MANAGER"},{"points":6,"action":"VERBAL_WARNING"},{"points":9,"action":"WRITTEN_WARNING"}]},
       "regularisation":{"maxPerMonth":3,"backdateDays":7}}'::jsonb, hr_id, t0)
  on conflict (id) do update set name = excluded.name, description = excluded.description, grace_in_minutes = excluded.grace_in_minutes, grace_out_minutes = excluded.grace_out_minutes,
    overtime_enabled = excluded.overtime_enabled, overtime_start_after_minutes = excluded.overtime_start_after_minutes, overtime_max_minutes_per_day = excluded.overtime_max_minutes_per_day,
    missing_punch_behavior = excluded.missing_punch_behavior, ramadan_mode = excluded.ramadan_mode, policy = excluded.policy, updated_at = now();

  ---------------------------------------------------------------------------------------------------------------------
  -- Shift change requests (shift_requests) and the double shifts (advanced_scheduling)
  ---------------------------------------------------------------------------------------------------------------------
  -- R1 approved CHANGE: Fatma Al-Kalbani (call centre) on the late office shift 21–24 Sep
  req := pg_temp.approval('scr:EMP060:2026-09-21', 'SHIFT_CHANGE', pg_temp.sid('scr:EMP060:2026-09-21'), pg_temp.emp('EMP060'), null, '2026-09-16 10:12:00+04', 'APPROVED',
           hr_id, 'hr_admin', '2026-09-16 15:40:00+04', 'Morning queue covered by Aisha Al-Saadi.', owner_id, 'owner', '2026-09-17 09:05:00+04', 'Approved.', 4);
  insert into public.shift_assignments (id, organization_id, target_type, target_id, branch_id, shift_id, shift_pattern_id, effective_from, effective_to, created_by, created_at)
  values (pg_temp.sid('assign:scr:EMP060:2026-09-21'), org, 'EMPLOYEE', pg_temp.emp('EMP060'), ghala, pg_temp.sid('shift:LATE'), null, '2026-09-21', '2026-09-25', owner_id, '2026-09-17 09:05:00+04')
  on conflict (id) do nothing;
  insert into public.shift_change_requests (id, organization_id, employee_id, branch_id, kind, from_date, to_date, requested_shift_id, current_shift_id, reason, status, approval_request_id, applied_assignment_ids, decided_by, decided_at, decision_note, created_by, created_at)
  values (pg_temp.sid('scr:EMP060:2026-09-21'), org, pg_temp.emp('EMP060'), ghala, 'CHANGE', '2026-09-21', '2026-09-24', pg_temp.sid('shift:LATE'), pg_temp.sid('shift:OFFICE'),
          'Evening Arabic-language support line needs cover while Sultan is on training.', 'approved', req, array[pg_temp.sid('assign:scr:EMP060:2026-09-21')], owner_id, '2026-09-17 09:05:00+04', 'Approved.', null, '2026-09-16 10:12:00+04')
  on conflict (id) do nothing;

  -- R2 approved ADDITIONAL: Aisha Al-Saadi adds the evening support shift 5–8 Oct (double shift 08:00–22:00)
  req := pg_temp.approval('scr:EMP056:2026-10-05', 'SHIFT_CHANGE', pg_temp.sid('scr:EMP056:2026-10-05'), pg_temp.emp('EMP056'), null, '2026-10-01 11:30:00+04', 'APPROVED',
           hr_id, 'hr_admin', '2026-10-01 14:10:00+04', 'Product launch week — extra evening cover needed.', owner_id, 'owner', '2026-10-01 16:45:00+04', 'Approved, overtime at 125 %.', 4);
  insert into public.shift_change_requests (id, organization_id, employee_id, branch_id, kind, from_date, to_date, requested_shift_id, current_shift_id, reason, status, approval_request_id, applied_assignment_ids, decided_by, decided_at, decision_note, created_by, created_at)
  values (pg_temp.sid('scr:EMP056:2026-10-05'), org, pg_temp.emp('EMP056'), ghala, 'ADDITIONAL', '2026-10-05', '2026-10-08', pg_temp.sid('shift:EVE'), pg_temp.sid('shift:OFFICE'),
          'Launch week: I can cover the 18:00–22:00 support line after my office day.', 'approved', req, array[pg_temp.sid('asa:EMP056:2026-10-05')], owner_id, '2026-10-01 16:45:00+04', 'Approved, overtime at 125 %.', null, '2026-10-01 11:30:00+04')
  on conflict (id) do nothing;
  insert into public.additional_shift_assignments (id, organization_id, employee_id, branch_id, shift_id, effective_from, effective_to, shift_change_request_id, created_by, created_at)
  values (pg_temp.sid('asa:EMP056:2026-10-05'), org, pg_temp.emp('EMP056'), ghala, pg_temp.sid('shift:EVE'), '2026-10-05', '2026-10-09', pg_temp.sid('scr:EMP056:2026-10-05'), owner_id, '2026-10-01 16:45:00+04'),
         (pg_temp.sid('asa:EMP058:2026-09-28'), org, pg_temp.emp('EMP058'), ghala, pg_temp.sid('shift:EVE'), '2026-09-28', '2026-10-02', null, hr_id, '2026-09-24 12:00:00+04')
  on conflict (id) do nothing;

  -- R3 pending CHANGE: K Kumar (premreddy1311@gmail.com) asks for the late shift 18–22 Oct — their manager has no login → HR admin
  req := pg_temp.approval('scr:001:2026-10-18', 'SHIFT_CHANGE', pg_temp.sid('scr:001:2026-10-18'), pg_temp.emp('001'), kumar_user, '2026-10-09 09:20:00+04', 'PENDING',
           hr_id, 'hr_admin', null, null, hr_id, 'role', null, null, 5);
  insert into public.shift_change_requests (id, organization_id, employee_id, branch_id, kind, from_date, to_date, requested_shift_id, current_shift_id, reason, status, approval_request_id, created_by, created_at)
  values (pg_temp.sid('scr:001:2026-10-18'), org, pg_temp.emp('001'), ghala, 'CHANGE', '2026-10-18', '2026-10-22', pg_temp.sid('shift:LATE'), flex_shift,
          'School run in the mornings that week; I will cover the late support window instead.', 'pending', req, kumar_user, '2026-10-09 09:20:00+04')
  on conflict (id) do nothing;

  -- R4 pending CHANGE: Abdullah Al-Kiyumi (crew C, nights 19–22 Oct) asks for the day shift
  req := pg_temp.approval('scr:EMP087:2026-10-19', 'SHIFT_CHANGE', pg_temp.sid('scr:EMP087:2026-10-19'), pg_temp.emp('EMP087'), null, '2026-10-08 18:30:00+04', 'PENDING',
           hr_id, 'hr_admin', null, null, hr_id, 'role', null, null, 4);
  insert into public.shift_change_requests (id, organization_id, employee_id, branch_id, kind, from_date, to_date, requested_shift_id, current_shift_id, reason, status, approval_request_id, created_by, created_at)
  values (pg_temp.sid('scr:EMP087:2026-10-19'), org, pg_temp.emp('EMP087'), sohar, 'CHANGE', '2026-10-19', '2026-10-22', pg_temp.sid('shift:SEC-D'), pg_temp.sid('shift:SEC-N'),
          'Medical follow-up in the evenings that week (letter from the clinic attached to my HR file).', 'pending', req, null, '2026-10-08 18:30:00+04')
  on conflict (id) do nothing;

  -- R5 rejected CHANGE: Kamal Hossain (warehouse crew C) wanted mornings for the whole of October
  req := pg_temp.approval('scr:EMP078:2026-10-01', 'SHIFT_CHANGE', pg_temp.sid('scr:EMP078:2026-10-01'), pg_temp.emp('EMP078'), null, '2026-09-27 08:15:00+04', 'REJECTED',
           hr_id, 'hr_admin', '2026-09-28 10:00:00+04', 'Night coverage would fall below the minimum of 2 on the warehouse night shift.', hr_id, 'role', null, null, 31);
  insert into public.shift_change_requests (id, organization_id, employee_id, branch_id, kind, from_date, to_date, requested_shift_id, current_shift_id, reason, status, approval_request_id, decided_by, decided_at, decision_note, created_by, created_at)
  values (pg_temp.sid('scr:EMP078:2026-10-01'), org, pg_temp.emp('EMP078'), sohar, 'CHANGE', '2026-10-01', '2026-10-31', pg_temp.sid('shift:WH-M'), pg_temp.sid('shift:WH-E'),
          'Evening classes in October — mornings only, please.', 'rejected', req, hr_id, '2026-09-28 10:00:00+04', 'Night coverage would fall below the minimum of 2 on the warehouse night shift.', null, '2026-09-27 08:15:00+04')
  on conflict (id) do nothing;

  -- R6 pending ADDITIONAL: Mohammed Al-Amri offers the evening support shift on 19–20 Oct (double shift)
  req := pg_temp.approval('scr:EMP057:2026-10-19', 'SHIFT_CHANGE', pg_temp.sid('scr:EMP057:2026-10-19'), pg_temp.emp('EMP057'), null, '2026-10-10 08:45:00+04', 'PENDING',
           hr_id, 'hr_admin', null, null, hr_id, 'role', null, null, 2);
  insert into public.shift_change_requests (id, organization_id, employee_id, branch_id, kind, from_date, to_date, requested_shift_id, current_shift_id, reason, status, approval_request_id, created_by, created_at)
  values (pg_temp.sid('scr:EMP057:2026-10-19'), org, pg_temp.emp('EMP057'), ghala, 'ADDITIONAL', '2026-10-19', '2026-10-20', pg_temp.sid('shift:EVE'), pg_temp.sid('shift:OFFICE'),
          'Happy to take the evening line on Monday and Tuesday while the team is short.', 'pending', req, null, '2026-10-10 08:45:00+04')
  on conflict (id) do nothing;

  ---------------------------------------------------------------------------------------------------------------------
  -- Shift swaps: approved on 24 Sep (Khamis crew B day ↔ Hamdan crew D night), pending on 15 Oct (Bikash crew B night ↔
  -- Dilip crew D day). An approved swap places a one-day EMPLOYEE assignment for each side (swap-effects placeOneDayShift).
  ---------------------------------------------------------------------------------------------------------------------
  req := pg_temp.approval('swap:EMP084:2026-09-24', 'SHIFT_SWAP', pg_temp.sid('swap:EMP084:2026-09-24'), pg_temp.emp('EMP084'), null, '2026-09-20 19:10:00+04', 'APPROVED',
           hr_id, 'hr_admin', '2026-09-21 08:30:00+04', 'Both supervisors agreed.', owner_id, 'owner', '2026-09-21 09:15:00+04', 'Approved.', 1, array[pg_temp.emp('EMP089')]);
  a1 := pg_temp.sid('assign:swap:EMP084:2026-09-24');
  a2 := pg_temp.sid('assign:swap:EMP089:2026-09-24');
  insert into public.shift_assignments (id, organization_id, target_type, target_id, branch_id, shift_id, shift_pattern_id, effective_from, effective_to, created_by, created_at)
  values (a1, org, 'EMPLOYEE', pg_temp.emp('EMP084'), sohar, pg_temp.sid('shift:SEC-N'), null, '2026-09-24', '2026-09-25', owner_id, '2026-09-21 09:15:00+04'),
         (a2, org, 'EMPLOYEE', pg_temp.emp('EMP089'), sohar, pg_temp.sid('shift:SEC-D'), null, '2026-09-24', '2026-09-25', owner_id, '2026-09-21 09:15:00+04')
  on conflict (id) do nothing;
  insert into public.shift_swap_requests (id, organization_id, requester_employee_id, target_employee_id, branch_id, swap_date, requester_shift_id, target_shift_id, reason, status, approval_request_id,
    requester_assignment_id, target_assignment_id, decided_by, decided_at, decision_note, created_by, created_at)
  values (pg_temp.sid('swap:EMP084:2026-09-24'), org, pg_temp.emp('EMP084'), pg_temp.emp('EMP089'), sohar, '2026-09-24', pg_temp.sid('shift:SEC-D'), pg_temp.sid('shift:SEC-N'),
          'Family wedding in Sohar on the 24th during the day.', 'approved', req, a1, a2, owner_id, '2026-09-21 09:15:00+04', 'Approved.', null, '2026-09-20 19:10:00+04')
  on conflict (id) do nothing;

  req := pg_temp.approval('swap:EMP085:2026-10-15', 'SHIFT_SWAP', pg_temp.sid('swap:EMP085:2026-10-15'), pg_temp.emp('EMP085'), null, '2026-10-09 21:05:00+04', 'PENDING',
           hr_id, 'hr_admin', null, null, hr_id, 'role', null, null, 1, array[pg_temp.emp('EMP090')]);
  insert into public.shift_swap_requests (id, organization_id, requester_employee_id, target_employee_id, branch_id, swap_date, requester_shift_id, target_shift_id, reason, status, approval_request_id, created_by, created_at)
  values (pg_temp.sid('swap:EMP085:2026-10-15'), org, pg_temp.emp('EMP085'), pg_temp.emp('EMP090'), sohar, '2026-10-15', pg_temp.sid('shift:SEC-N'), pg_temp.sid('shift:SEC-D'),
          'Embassy appointment in Muscat on the morning of the 16th; Dilip agreed to take my night.', 'pending', req, null, '2026-10-09 21:05:00+04')
  on conflict (id) do nothing;

  ---------------------------------------------------------------------------------------------------------------------
  -- Branch deployments (completed, active, upcoming, cancelled). Terminal enrolment is left off: these are demo terminals.
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.employee_branch_deployments (id, organization_id, employee_id, home_branch_id, branch_id, from_date, to_date, reason, enrol_on_devices, cancelled_at, cancelled_by, cancel_reason, created_by, created_at)
  values
    (pg_temp.sid('deploy:EMP065:2026-09-13'), org, pg_temp.emp('EMP065'), ghala, sohar, '2026-09-13', '2026-09-17', 'Quarterly stock count at the plant warehouse.', false, null, null, null, hr_id, '2026-09-08 11:00:00+04'),
    (pg_temp.sid('deploy:EMP046:2026-10-04'), org, pg_temp.emp('EMP046'), ghala, sohar, '2026-10-04', '2026-10-15', 'Network upgrade at the plant: new fibre backbone and Wi-Fi for the warehouse.', false, null, null, null, hr_id, '2026-09-30 09:30:00+04'),
    (pg_temp.sid('deploy:EMP092:2026-10-18'), org, pg_temp.emp('EMP092'), sohar, ghala, '2026-10-18', '2026-10-22', 'Electrical and HVAC overhaul at the Ghala office.', false, null, null, null, hr_id, '2026-10-07 13:15:00+04'),
    (pg_temp.sid('deploy:EMP053:2026-10-25'), org, pg_temp.emp('EMP053'), ghala, sohar, '2026-10-25', '2026-10-29', 'Customer visits in the Sohar industrial estate.', false, '2026-10-08 10:20:00+04', hr_id,
     'Customer visits moved to Muscat.', hr_id, '2026-10-05 15:00:00+04')
  on conflict (id) do nothing;

  ---------------------------------------------------------------------------------------------------------------------
  -- Audit trail of the set-up (what the HR admin did in the app)
  ---------------------------------------------------------------------------------------------------------------------
  insert into audit.logs (organization_id, actor_user_id, actor_type, actor_label, action, entity_type, entity_id, branch_id, old_value, new_value, reason, request_id, created_at)
  select org, a.actor, 'USER', a.label, a.action, a.entity_type, a.entity_id, a.branch, null, a.new_value, a.reason, 'seed-' || left(md5(a.action || a.entity_id), 12), a.at
  from (values
    (hr_id, 'reddyprem1311@gmail.com', 'employee_group.created', 'employee_group', pg_temp.sid('group:OFFICE')::text, null::uuid, '{"code":"OFFICE","name":"Office Employees"}'::jsonb, null::text, '2026-08-25 10:05:00+04'::timestamptz),
    (hr_id, 'reddyprem1311@gmail.com', 'employee_group.created', 'employee_group', pg_temp.sid('group:SHIFT')::text, null, '{"code":"SHIFT","name":"24/7 Shift Workers"}'::jsonb, null, '2026-08-25 10:07:00+04'),
    (hr_id, 'reddyprem1311@gmail.com', 'attendance.rule_set_created', 'attendance_rule_set', pg_temp.sid('policy:oman-office')::text, null, '{"name":"Oman – Office Employees","countryPack":"OM 2026.10","scope":{"countryCode":"OM","employeeGroup":"OFFICE"}}'::jsonb, 'Created from the Oman country pack', '2026-08-25 10:30:00+04'),
    (hr_id, 'reddyprem1311@gmail.com', 'attendance.rule_set_created', 'attendance_rule_set', pg_temp.sid('policy:sohar-shift')::text, sohar, '{"name":"Sohar Plant – 24/7 Shift Workers","scope":{"branch":"SOH","employeeGroup":"SHIFT"}}'::jsonb, null, '2026-08-25 10:45:00+04'),
    (hr_id, 'reddyprem1311@gmail.com', 'shift.round_the_clock_applied', 'shift_pattern', pg_temp.sid('pattern:SEC-A')::text, sohar, '{"template":"TWO_SHIFT_4ON4OFF","codePrefix":"SEC","namePrefix":"Security","firstShiftStart":"06:00","anchorDate":"2026-09-01","crewTeams":["SEC-A","SEC-B","SEC-C","SEC-D"],"coverage":{"minHeadcount":2}}'::jsonb, '24/7 guarding of the plant', '2026-08-26 09:10:00+04'),
    (hr_id, 'reddyprem1311@gmail.com', 'shift.round_the_clock_applied', 'shift_pattern', pg_temp.sid('pattern:WH-A')::text, sohar, '{"template":"THREE_SHIFT_CONTINENTAL","codePrefix":"WH","namePrefix":"Warehouse","firstShiftStart":"06:00","anchorDate":"2026-09-01","crewTeams":["WH-A","WH-B","WH-C","WH-D"],"coverage":{"minHeadcount":2}}'::jsonb, 'Warehouse runs three shifts from September', '2026-08-26 09:25:00+04'),
    (hr_id, 'reddyprem1311@gmail.com', 'branch_deployment.created', 'employee_branch_deployment', pg_temp.sid('deploy:EMP046:2026-10-04')::text, sohar, '{"employee":"EMP046","from":"2026-10-04","to":"2026-10-15","branch":"SOH"}'::jsonb, 'Network upgrade at the plant', '2026-09-30 09:30:00+04')
  ) as a(actor, label, action, entity_type, entity_id, branch, new_value, reason, at)
  where not exists (select 1 from audit.logs l where l.organization_id = org and l.action = a.action and l.entity_id = a.entity_id and l.created_at = a.at);
end $$;

-- what the rotation gives each crew on the dates the requests name (must match the requests' current shifts)
select 'enterprise' as step,
  (select count(*) from public.employee_groups where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0') as groups,
  (select count(*) from public.employee_group_memberships where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0') as group_members,
  (select count(*) from public.attendance_rule_sets where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0') as policies,
  (select count(*) from public.shift_patterns where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0') as patterns,
  (select count(*) from public.team_members where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0') as crew_members,
  (select count(*) from public.shift_coverage_requirements where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0') as coverage_targets,
  (select count(*) from public.additional_shift_assignments where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0') as double_shifts,
  (select count(*) from public.employee_branch_deployments where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0') as deployments,
  (select string_agg(status::text || '=' || n, ' ') from (select status, count(*) n from public.shift_change_requests where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0' group by 1) x) as shift_changes,
  (select string_agg(status::text || '=' || n, ' ') from (select status, count(*) n from public.shift_swap_requests where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0' group by 1) x) as swaps,
  (select string_agg(p.code || ':' || coalesce((select s.code from jsonb_array_elements(p.sequence) e join public.shifts s on s.id = (e ->> 'shiftId')::uuid
                                                   where (e ->> 'day')::int = ((d.d - p.anchor_date) % p.cycle_length_days + p.cycle_length_days) % p.cycle_length_days), 'off')
                     || '@' || to_char(d.d, 'MM-DD'), ' ' order by d.d, p.code)
     from public.shift_patterns p cross join (values (date '2026-09-24'), (date '2026-10-01'), (date '2026-10-15'), (date '2026-10-19')) d(d)
     where p.organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0' and p.code in ('SEC-B', 'SEC-C', 'SEC-D', 'WH-C')) as crew_check;
