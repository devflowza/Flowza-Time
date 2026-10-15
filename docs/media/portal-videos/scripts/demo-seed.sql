-- FlowZa Time · portal videos · demo data on top of the LOCAL seed (Al Bahja Trading, `scripts/db-reset-local.sh --seed`).
-- Local development database only (it writes auth.users directly). Idempotent: deterministic ids and natural keys.
--
-- What it sets up for the per-portal videos (docs/media/portal-videos/README.md):
--   · Enterprise plan (shift swaps, policies, meeting rooms), manager team scope = whole hierarchy, web check-in on;
--   · location places HQ › Floor 3 › Boardroom and HQ › Floor 5 › Training Room;
--   · terminals by punch role: HQ Main Entrance = entry-only (CHECK_IN), HQ Lobby = two-way IN/OUT keys (AUTO),
--     HQ Parking Gate = exit-only (CHECK_OUT), Boardroom / Training Room readers = ACCESS (room access, never attendance);
--   · shift "Office 08:00–14:00", employee group "Office staff (time away tracked)" and its DIRECTIONAL policy with time away on;
--   · the cast: Ahmed Al Hinai (employee@, a fresh record so his history is all 08:00–14:00), colleagues Huda, Yousuf, Rashid,
--     Mariam; Hamed Al Rashdi, Head of Technology (head@, new login) over Nasser (manager@) and Salma Hussain (QA manager);
--     Khalid Al Harthi, General Manager (owner@) over Hamed — a three-level reporting line;
--   · four weeks of punches with out-and-back patterns, approved official duty / personal permission windows, unapproved time
--     away, a short gap, a late arrival, a leave day; today: Ahmed checked in at 08:02 on the entry-only terminal;
--   · meeting rooms (Boardroom restricted to IT, QA and Administration), meetings with room entries (on time, late, absent,
--     an unauthorised walk-in);
--   · leave allowances (AL 30, SL 15, EL 6) and a few leave records.
-- Raw punches land as `pending`; the worker's normaliser and recompute turn them into events and daily records (engine output).
-- Pending requests (leave, swap, time away) are created through the API by `seed-requests.mjs`, so they reach the approvals inbox.
-- Logins (password FlowZa-Demo-2026!): employee@ (Ahmed), manager@ (Nasser), head@ (Hamed), owner@ (Khalid, GM), hr@ (Fatma),
-- huda@ and yousuf@ (colleagues) — all @albahja.example.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

-- deterministic ids (md5 of a name: the local stack has no uuid-ossp)
create or replace function pg_temp.did(p text) returns uuid language sql immutable as
$$ select md5('albahja-video-demo:' || p)::uuid $$;

-- One raw punch on a terminal (by code) at a local Muscat wall-clock time. Self-service punches name the employee.
create or replace function pg_temp.punch(p_dev text, p_user text, p_local timestamp, p_dir text, p_emp uuid default null, p_payload jsonb default '{}'::jsonb) returns void language plpgsql as $$
declare d record; v_at timestamptz := p_local at time zone 'Asia/Muscat'; v_self boolean;
begin
  select id, organization_id, branch_id, provider_key, generation, timezone into d from public.devices
  where organization_id = '00000000-0000-4000-a000-000000000001' and code = p_dev;
  if d.id is null then raise exception 'device % missing', p_dev; end if;
  v_self := d.provider_key = 'self_service';
  insert into public.attendance_raw_transactions (organization_id, device_id, branch_id, provider_key, provider_transaction_id, device_employee_id, employee_id, punched_at,
    verification_method, direction, raw_payload, source, dedupe_hash, processing_status, assumed_timezone, clock_skew_seconds, device_generation)
  values (d.organization_id, d.id, d.branch_id, d.provider_key, 'demo:' || p_dev || ':' || p_user || ':' || extract(epoch from v_at)::bigint, p_user, case when v_self then p_emp else null end, v_at,
    (case when v_self then 'mobile' when p_dev like '%BRD%' or p_dev like '%TRN%' then 'card' else 'fingerprint' end)::public.verification_method, p_dir::public.punch_direction,
    case when v_self then p_payload || jsonb_build_object('channel', 'web') else p_payload end,
    (case when v_self then 'SELF_SERVICE' else 'DEVICE_PUSH' end)::public.raw_source,
    md5('video-demo|' || d.id || '|' || p_user || '|' || v_at::text || '|' || p_dir), 'pending', 'Asia/Muscat', 0, d.generation)
  on conflict do nothing;
end $$;

do $$
declare
  org uuid := '00000000-0000-4000-a000-000000000001';
  hq uuid := (select id from public.branches where organization_id = org and code = 'MCT-HQ');
  hq_node uuid;
  lvl_floor uuid := pg_temp.did('level:floor');
  lvl_room uuid := pg_temp.did('level:room');
  floor3 uuid := pg_temp.did('loc:floor3');
  floor5 uuid := pg_temp.did('loc:floor5');
  boardroom uuid := pg_temp.did('loc:boardroom');
  training uuid := pg_temp.did('loc:training');
  dep_it uuid := (select id from public.departments where organization_id = org and name = 'Information Technology');
  dep_qa uuid := (select id from public.departments where organization_id = org and name = 'Quality Assurance');
  dep_admin uuid := (select id from public.departments where organization_id = org and name = 'Administration');
  des_tech uuid := (select id from public.designations where organization_id = org and name = 'Technician');
  des_officer uuid := (select id from public.designations where organization_id = org and name = 'Officer');
  des_mgr uuid := (select id from public.designations where organization_id = org and name = 'Manager');
  owner_user uuid := (select id from auth.users where email = 'owner@albahja.example');
  emp_user uuid := (select id from auth.users where email = 'employee@albahja.example');
  mgr_user uuid := (select id from auth.users where email = 'manager@albahja.example');
  head_user uuid := pg_temp.did('user:head');
  nasser uuid := (select m.employee_id from public.org_memberships m where m.user_id = (select id from auth.users where email = 'manager@albahja.example'));
  old_ahmed uuid := (select m.employee_id from public.org_memberships m where m.user_id = (select id from auth.users where email = 'employee@albahja.example'));
  salma uuid := (select manager_employee_id from public.departments where organization_id = org and name = 'Quality Assurance');
  ahmed uuid := pg_temp.did('emp:ahmed');
  huda uuid := pg_temp.did('emp:huda');
  yousuf uuid := pg_temp.did('emp:yousuf');
  rashid uuid := pg_temp.did('emp:rashid');
  mariam uuid := pg_temp.did('emp:mariam');
  hamed uuid := pg_temp.did('emp:hamed');
  gm uuid := pg_temp.did('emp:gm');
  shift_office uuid := pg_temp.did('shift:office6');
  shift_late uuid := pg_temp.did('shift:late6');
  grp uuid := pg_temp.did('group:office');
  policy uuid := pg_temp.did('policy:office');
  room_brd uuid := pg_temp.did('room:boardroom');
  room_trn uuid := pg_temp.did('room:training');
  r record;
  d date;
  i int := 0;
  pat text;
  cast_ids uuid[];
begin
  if hq is null then raise exception 'run scripts/db-reset-local.sh --seed first (Al Bahja local seed)'; end if;
  select id into hq_node from public.locations where organization_id = org and role = 'branch' and branch_id = hq;

  -- ---------------------------------------------------------------------------------------------------------------------------
  -- Plan, modules, settings
  -- ---------------------------------------------------------------------------------------------------------------------------
  update public.subscriptions set plan_id = (select id from public.plans where key = 'enterprise'), status = 'active' where organization_id = org;
  update public.organization_settings set attendance = coalesce(attendance, '{}'::jsonb)
      || jsonb_build_object('team', jsonb_build_object('scope', 'hierarchy'))
      || jsonb_build_object('selfService', coalesce(attendance -> 'selfService', '{}'::jsonb) || jsonb_build_object('webCheckIn', true, 'mobileCheckIn', true, 'requireGeofence', 'off', 'regularisation', true))
  where organization_id = org;

  -- ---------------------------------------------------------------------------------------------------------------------------
  -- Location places: HQ › Floor 3 › Boardroom, HQ › Floor 5 › Training Room
  -- ---------------------------------------------------------------------------------------------------------------------------
  insert into public.location_levels (id, organization_id, position, role, name, name_ar, icon) values
    (lvl_floor, org, 2, 'place', 'Floor', 'طابق', 'floor'), (lvl_room, org, 3, 'place', 'Room', 'غرفة', 'room')
  on conflict (id) do nothing;
  insert into public.locations (id, organization_id, level_id, role, parent_id, code, name, name_ar, path) values
    (floor3, org, lvl_floor, 'place', hq_node, 'HQ-F3', 'Floor 3', 'الطابق 3', '{}'),
    (floor5, org, lvl_floor, 'place', hq_node, 'HQ-F5', 'Floor 5', 'الطابق 5', '{}')
  on conflict (id) do nothing;
  insert into public.locations (id, organization_id, level_id, role, parent_id, code, name, name_ar, path) values
    (boardroom, org, lvl_room, 'place', floor3, 'HQ-F3-BRD', 'Boardroom', 'قاعة الاجتماعات الرئيسية', '{}'),
    (training, org, lvl_room, 'place', floor5, 'HQ-F5-TRN', 'Training Room', 'قاعة التدريب', '{}')
  on conflict (id) do nothing;

  -- ---------------------------------------------------------------------------------------------------------------------------
  -- Terminals by punch role (+ two ACCESS readers); terminals look healthy for the screens
  -- ---------------------------------------------------------------------------------------------------------------------------
  update public.devices set punch_role = 'CHECK_IN', name = 'HQ Main Entrance (entry only)' where organization_id = org and code = 'MCT-ENT-01';
  update public.devices set punch_role = 'AUTO', name = 'HQ Lobby (IN / OUT keys)' where organization_id = org and code = 'MCT-ENT-02';
  update public.devices set punch_role = 'CHECK_OUT', name = 'HQ Parking Gate (exit only)' where organization_id = org and code = 'MCT-PKG-01';
  insert into public.devices (id, organization_id, branch_id, location_id, code, name, provider_key, model_id, manufacturer, model_name, serial_number, timezone, integration_type, endpoint_url,
    config, capabilities, status, connection_status, last_heartbeat_at, last_successful_communication_at, offline_threshold_minutes, auto_sync_enabled, sync_interval_minutes, tags, notes, punch_role)
  select pg_temp.did('dev:' || v.code), org, hq, v.loc, v.code, v.name, d.provider_key, d.model_id, 'ZKTeco', 'SpeedFace-V5L', v.serial, 'Asia/Muscat', d.integration_type, d.endpoint_url,
    d.config, d.capabilities, 'active', 'online', now(), now(), 30, false, 10, array['meeting-room', 'access'], 'Door reader of a meeting room: entries are room access, not attendance.', 'ACCESS'
  from (values ('MCT-BRD-01', 'Boardroom reader', boardroom, 'SFV5L-30017'), ('MCT-TRN-01', 'Training Room reader', training, 'SFV5L-30018')) as v(code, name, loc, serial)
  cross join (select * from public.devices where organization_id = org and code = 'MCT-ENT-02') d
  on conflict (id) do update set location_id = excluded.location_id, punch_role = 'ACCESS';
  -- the local seed's mock terminals carry credentials under a dev key the API does not hold: show them as polled-by-push, online
  delete from public.device_credentials where organization_id = org;
  update public.devices set connection_status = (case when code in ('NZW-WS-01', 'MCT-ANX-01') then 'offline' else 'online' end)::public.connection_status,
    last_heartbeat_at = case when code in ('NZW-WS-01', 'MCT-ANX-01') then now() - interval '3 hours' else now() - interval '1 minute' end,
    last_successful_communication_at = now() - interval '1 minute', last_error_code = null, last_error = null, consecutive_failures = 0, auto_sync_enabled = false
  where organization_id = org and provider_key <> 'self_service';

  -- the organisation's self-service virtual device (as the API creates it on the first portal punch)
  if not exists (select 1 from public.devices where organization_id = org and provider_key = 'self_service') then
    insert into public.devices (id, organization_id, branch_id, code, name, provider_key, model_id, manufacturer, model_name, integration_type, status, auto_sync_enabled, capabilities, config,
      timezone, offline_threshold_minutes, sync_interval_minutes, tags, notes)
    values (pg_temp.did('dev:self'), org, hq, 'FLOWZA-SELF-SERVICE', 'FlowZa Self-Service', 'self_service', (select id from public.device_models where provider_key = 'self_service' order by model limit 1),
      'FlowZa', 'FlowZa Self-Service', 'DEVICE_PUSH', 'disabled', false, '{}', '{}', 'Asia/Muscat', 1440, 1440, array['self-service', 'virtual'], 'Virtual device of the employee portal (web / mobile / selfie check-ins). Created automatically; not a terminal.');
  end if;

  -- ---------------------------------------------------------------------------------------------------------------------------
  -- Shifts, the time-away policy and its employee group
  -- ---------------------------------------------------------------------------------------------------------------------------
  insert into public.shifts (id, organization_id, code, name, type, start_time, end_time, breaks, punch_in_window_before_minutes, punch_out_window_after_minutes, grace_in_minutes, color)
  values (shift_office, org, 'OFFICE6', 'Office 08:00–14:00', 'FIXED', '08:00', '14:00', '[]', 180, 240, 10, '#0f766e'),
         (shift_late, org, 'LATE6', 'Office 12:00–18:00', 'FIXED', '12:00', '18:00', '[]', 180, 240, 10, '#7c3aed')
  on conflict (id) do update set name = excluded.name, start_time = excluded.start_time, end_time = excluded.end_time;

  insert into public.employee_groups (id, organization_id, code, name, name_ar, description)
  values (grp, org, 'OFFICE-TA', 'Office staff (time away tracked)', 'موظفو المكتب (تتبع الخروج أثناء الدوام)', 'Office day 08:00–14:00; time away between check-in and check-out is measured and classified.')
  on conflict (id) do nothing;

  -- ---------------------------------------------------------------------------------------------------------------------------
  -- People: the cast (fresh records, so their history is all 08:00–14:00)
  -- ---------------------------------------------------------------------------------------------------------------------------
  -- the local seed's Ahmed stays as a colleague without a login
  update public.employees set user_id = null, display_name = 'Ahmad Al Hinai', first_name = 'Ahmad' where id = old_ahmed and id <> ahmed;
  for r in select * from (values
      (gm,     'EMP-10901', 'Khalid', 'Al Harthi', 'General Manager',        dep_admin, des_mgr,     null::uuid, '91900', '2019-01-06'),
      (hamed,  'EMP-10902', 'Hamed',  'Al Rashdi', 'Head of Technology',     dep_it,    des_mgr,     gm,         '91901', '2020-03-01'),
      (ahmed,  'EMP-10910', 'Ahmed',  'Al Hinai',  null,                     dep_qa,    des_tech,    nasser,     '91910', '2024-02-04'),
      (huda,   'EMP-10911', 'Huda',   'Al Kindi',  null,                     dep_qa,    des_tech,    nasser,     '91911', '2024-05-12'),
      (yousuf, 'EMP-10912', 'Yousuf', 'Al Balushi', null,                    dep_qa,    des_officer, nasser,     '91912', '2023-09-17'),
      (rashid, 'EMP-10913', 'Rashid', 'Al Farsi',  null,                     dep_it,    des_tech,    nasser,     '91913', '2025-01-05'),
      (mariam, 'EMP-10914', 'Mariam', 'Al Lawati', null,                     dep_qa,    des_officer, nasser,     '91914', '2022-11-20')
    ) as v(id, num, first, last, title, dep, des, mgr, pin, joined)
  loop
    insert into public.employees (id, organization_id, employee_number, first_name, last_name, display_name, gender, nationality_code, email, phone, joining_date, employment_status, employment_type,
      branch_id, department_id, designation_id, manager_employee_id, device_user_id, card_number, fingerprint_enrolled, face_enrolled, custom_fields)
    values (r.id, org, r.num, r.first, r.last, r.first || ' ' || r.last, case when r.first in ('Huda', 'Mariam') then 'female' else 'male' end::public.gender, 'OM',
      lower(r.first) || '.' || lower(replace(r.last, 'Al ', 'al')) || '@albahja.example', '+968 9' || r.pin || '1', r.joined::date, 'active', 'full_time', hq, r.dep, r.des, r.mgr, r.pin, 'C' || r.pin, true, r.first in ('Ahmed', 'Huda'),
      jsonb_build_object('jobTitle', coalesce(r.title, '')))
    on conflict (id) do update set manager_employee_id = excluded.manager_employee_id, department_id = excluded.department_id, deleted_at = null;
    insert into public.employment_history (id, organization_id, employee_id, effective_from, branch_id, department_id, designation_id, manager_employee_id, employment_type, employment_status, reason)
    values (pg_temp.did('hist:' || r.id), org, r.id, r.joined::date, hq, r.dep, r.des, r.mgr, 'full_time', 'active', 'Joined')
    on conflict (id) do update set manager_employee_id = excluded.manager_employee_id;
  end loop;
  -- the reporting line: Khalid (GM) → Hamed (Head of Technology) → Nasser (IT) and Salma (QA) → their teams
  update public.employees set manager_employee_id = hamed where id in (nasser, salma);
  update public.employment_history set manager_employee_id = hamed where employee_id in (nasser, salma) and effective_to is null;
  update public.departments set manager_employee_id = hamed where id = dep_it;
  update public.departments set manager_employee_id = gm where id = dep_admin;

  -- logins: employee@ → the new Ahmed, owner@ → Khalid (GM), head@ (new) → Hamed
  update public.employees set user_id = emp_user where id = ahmed;
  update public.org_memberships set employee_id = ahmed where user_id = emp_user and organization_id = org;
  update public.employees set user_id = owner_user where id = gm;
  update public.org_memberships set employee_id = gm where user_id = owner_user and organization_id = org;
  insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
  values (head_user, 'head@albahja.example', extensions.crypt('FlowZa-Demo-2026!', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Hamed Al Rashdi"}')
  on conflict (id) do nothing;
  insert into public.user_profiles (id, email, full_name, locale) values (head_user, 'head@albahja.example', 'Hamed Al Rashdi', 'en') on conflict (id) do nothing;
  insert into public.org_memberships (id, organization_id, user_id, role_id, status, all_branches, joined_at, employee_id)
  values (pg_temp.did('member:head'), org, head_user, '10000000-0000-0000-0000-000000000009', 'active', true, now(), hamed)
  on conflict (id) do nothing;
  update public.employees set user_id = head_user where id = hamed;
  -- managers receive the daily roll call (a report delivered every working morning): a tenant role = the system Manager role
  -- plus report.export, whose reports are always narrowed to the manager's team (attendance.view_team → TEAM scope)
  insert into public.roles (id, organization_id, key, name, description, is_system)
  values (pg_temp.did('role:line-manager'), org, 'line_manager', 'Line manager', 'Manager, plus opening the reports delivered to them — always narrowed to their team.', false)
  on conflict (id) do nothing;
  -- granted as the owner (role_permissions_no_escalation: nobody grants a permission they do not hold)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', owner_user, 'role', 'authenticated')::text, true);
  insert into public.role_permissions (role_id, permission_key)
  select pg_temp.did('role:line-manager'), permission_key from public.role_permissions where role_id = '10000000-0000-0000-0000-000000000009'
  union select pg_temp.did('role:line-manager'), 'report.export'
  on conflict do nothing;
  perform set_config('request.jwt.claims', '', true);
  update public.org_memberships set role_id = pg_temp.did('role:line-manager')
  where organization_id = org and user_id in (select id from auth.users where email in ('manager@albahja.example', 'head@albahja.example'));
  -- two colleagues with portal logins (their requests reach the manager's inbox)
  for r in select * from (values ('huda@albahja.example', 'Huda Al Kindi', huda), ('yousuf@albahja.example', 'Yousuf Al Balushi', yousuf)) as v(email, name, emp) loop
    insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
    values (pg_temp.did('user:' || r.email), r.email, extensions.crypt('FlowZa-Demo-2026!', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', r.name))
    on conflict (id) do nothing;
    insert into public.user_profiles (id, email, full_name, locale) values (pg_temp.did('user:' || r.email), r.email, r.name, 'en') on conflict (id) do nothing;
    insert into public.org_memberships (id, organization_id, user_id, role_id, status, all_branches, joined_at, employee_id)
    values (pg_temp.did('member:' || r.email), org, pg_temp.did('user:' || r.email), '10000000-0000-0000-0000-000000000008', 'active', true, now(), r.emp)
    on conflict (id) do nothing;
    update public.employees set user_id = pg_temp.did('user:' || r.email) where id = r.emp;
  end loop;

  -- shifts and the policy group for the office cast (from 2026-09-01)
  cast_ids := array[ahmed, huda, yousuf, rashid, mariam];
  insert into public.shift_assignments (id, organization_id, target_type, target_id, branch_id, shift_id, effective_from)
  select pg_temp.did('assign:' || e), org, 'EMPLOYEE', e, hq, case when e = huda then shift_late else shift_office end, '2026-09-01' from unnest(cast_ids || array[hamed]) as e
  on conflict (id) do nothing;
  insert into public.employee_group_memberships (id, organization_id, employee_group_id, employee_id, effective_from)
  select pg_temp.did('grpm:' || e), org, grp, e, '2026-09-01' from unnest(cast_ids) as e
  on conflict (id) do nothing;
  insert into public.attendance_rule_sets (id, organization_id, name, description, employee_group_id, effective_from, grace_in_minutes, grace_out_minutes, late_threshold_minutes,
    min_full_day_minutes, half_day_threshold_minutes, overtime_start_after_minutes, overtime_min_block_minutes, overtime_rounding_minutes, punch_interpretation, missing_punch_behavior, policy)
  values (policy, org, 'Office day with time away', 'Office staff 08:00–14:00: every out-and-back between check-in and check-out is measured — official duty counts as worked, personal permission is excused (4 h a month), the rest is unapproved.',
    grp, '2026-09-01', 10, 5, 0, 330, 180, 30, 30, 15, 'DIRECTIONAL', 'FLAG_ONLY',
    jsonb_build_object('timeAway', jsonb_build_object('enabled', true, 'ignoreUnderMinutes', 5, 'returnGraceMinutes', 10, 'officialCountsAsWorked', true, 'permissionExcusesShortfall', true,
      'personalMonthlyQuotaMinutes', 240, 'personalMaxMinutes', 120, 'flagUnapprovedAfterMinutes', 15, 'stepOutFromPortal', true, 'returnBy', 'device_or_portal')))
  on conflict (id) do update set policy = excluded.policy, punch_interpretation = excluded.punch_interpretation, overtime_start_after_minutes = excluded.overtime_start_after_minutes,
    overtime_min_block_minutes = excluded.overtime_min_block_minutes, overtime_rounding_minutes = excluded.overtime_rounding_minutes;

  -- ---------------------------------------------------------------------------------------------------------------------------
  -- Leave allowances and a few leave records
  -- ---------------------------------------------------------------------------------------------------------------------------
  update public.leave_types set annual_allowance_days = case code::text when 'ANNUAL' then 30 when 'SICK' then 15 when 'EMERGENCY' then 6 else annual_allowance_days end where organization_id = org;
  insert into public.leave_records (id, organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, status, source, reason, approved_by, approved_at, days)
  select pg_temp.did('leave:' || v.k), org, v.e, hq, (select id from public.leave_types where organization_id = org and code = v.t), v.s::date, v.f::date, 'APPROVED', 'INTERNAL', v.reason, mgr_user, now(), v.days
  from (values ('ahmed-1', ahmed, 'ANNUAL', '2026-09-24', '2026-09-24', 'Family occasion', 1),
               ('ahmed-2', ahmed, 'SICK', '2026-10-06', '2026-10-06', 'Fever — medical certificate attached', 1),
               ('huda-1', huda, 'ANNUAL', '2026-10-20', '2026-10-22', 'Travel to Salalah', 3),
               ('yousuf-1', yousuf, 'ANNUAL', '2026-10-15', '2026-10-15', 'Personal errand', 1)) as v(k, e, t, s, f, reason, days)
  on conflict (id) do nothing;

  -- ---------------------------------------------------------------------------------------------------------------------------
  -- Four weeks of punches (Sun–Thu; Fri/Sat off) with out-and-back patterns, and the approved time-away windows they use
  -- ---------------------------------------------------------------------------------------------------------------------------
  for d in select g::date from generate_series('2026-09-13'::date, '2026-10-14'::date, interval '1 day') g where extract(isodow from g) not in (5, 6) loop
    i := i + 1;
    -- Ahmed: the patterns of the brief, in rotation
    if d in ('2026-09-24'::date, '2026-10-06'::date) then pat := 'leave';
    else pat := (array['plain', 'official', 'plain', 'permission', 'unapproved', 'plain', 'late', 'official', 'short', 'plain', 'permission', 'official_half'])[1 + (i % 12)];
    end if;
    if pat = 'plain' then
      perform pg_temp.punch('MCT-ENT-02', '91910', d + time '07:56' + (i % 7) * interval '1 minute', 'in');
      perform pg_temp.punch('MCT-ENT-02', '91910', d + time '14:02' + (i % 5) * interval '1 minute', 'out');
    elsif pat = 'late' then
      perform pg_temp.punch('MCT-ENT-01', '91910', d + time '08:23', 'unknown');
      perform pg_temp.punch('MCT-PKG-01', '91910', d + time '14:11', 'unknown');
    elsif pat = 'official' then
      -- two-way terminal: OUT on the lobby keys, back through the entry-only gate; an approved client visit 10:00–12:00
      perform pg_temp.punch('MCT-ENT-02', '91910', d + time '07:58', 'in');
      perform pg_temp.punch('MCT-ENT-02', '91910', d + time '10:01', 'out');
      perform pg_temp.punch('MCT-ENT-01', '91910', d + time '12:06', 'unknown');
      perform pg_temp.punch('MCT-ENT-02', '91910', d + time '14:04', 'out');
      insert into public.time_away_requests (id, organization_id, employee_id, branch_id, attendance_date, kind, source, starts_at, ends_at, reason, destination, status, decided_by, decided_at, decision_note, created_by, created_at)
      values (pg_temp.did('ta:' || ahmed || d), org, ahmed, hq, d, 'OFFICIAL', 'request', (d + time '10:00') at time zone 'Asia/Muscat', (d + time '12:00') at time zone 'Asia/Muscat',
        (array['Site inspection — Oman LNG supplier audit', 'Ministry of Labour — work permit renewals', 'Client visit — Muscat Municipality'])[1 + (i % 3)], (array['Sur, Oman LNG', 'Ministry of Labour, Al Khuwair', 'Muscat Municipality'])[1 + (i % 3)],
        'approved', mgr_user, (d - 1 + time '16:00') at time zone 'Asia/Muscat', 'Approved', emp_user, (d - 1 + time '15:00') at time zone 'Asia/Muscat')
      on conflict (id) do nothing;
    elsif pat = 'official_half' then
      -- an official errand to the end of the day: stepped out from the portal and checked out from the portal
      perform pg_temp.punch('MCT-ENT-01', '91910', d + time '07:59', 'unknown');
      perform pg_temp.punch('FLOWZA-SELF-SERVICE', ahmed::text, d + time '12:30', 'break_out', ahmed, jsonb_build_object('timeAway', true, 'kind', 'OFFICIAL'));
      perform pg_temp.punch('FLOWZA-SELF-SERVICE', ahmed::text, d + time '14:00', 'out', ahmed);
      insert into public.time_away_requests (id, organization_id, employee_id, branch_id, attendance_date, kind, source, starts_at, ends_at, reason, destination, status, decided_by, decided_at, created_by, created_at)
      values (pg_temp.did('ta:' || ahmed || d), org, ahmed, hq, d, 'OFFICIAL', 'step_out', (d + time '12:30') at time zone 'Asia/Muscat', (d + time '14:00') at time zone 'Asia/Muscat',
        'Bank — company account signatory update', 'Bank Muscat, CBD', 'approved', mgr_user, (d + time '12:41') at time zone 'Asia/Muscat', emp_user, (d + time '12:30') at time zone 'Asia/Muscat')
      on conflict (id) do nothing;
    elsif pat = 'permission' then
      -- entry-only site: stepped out from the portal at 11:00 (personal), back on the entry terminal at 11:52
      perform pg_temp.punch('MCT-ENT-01', '91910', d + time '08:01', 'unknown');
      perform pg_temp.punch('FLOWZA-SELF-SERVICE', ahmed::text, d + time '11:00', 'break_out', ahmed, jsonb_build_object('timeAway', true, 'kind', 'PERSONAL'));
      perform pg_temp.punch('MCT-ENT-01', '91910', d + time '11:52', 'unknown');
      perform pg_temp.punch('MCT-PKG-01', '91910', d + time '14:05', 'unknown');
      insert into public.time_away_requests (id, organization_id, employee_id, branch_id, attendance_date, kind, source, starts_at, ends_at, returned_at, reason, status, decided_by, decided_at, created_by, created_at)
      values (pg_temp.did('ta:' || ahmed || d), org, ahmed, hq, d, 'PERSONAL', 'step_out', (d + time '11:00') at time zone 'Asia/Muscat', (d + time '12:00') at time zone 'Asia/Muscat', (d + time '11:52') at time zone 'Asia/Muscat',
        (array['School — collect my son early', 'Hospital appointment (father)'])[1 + (i % 2)], 'approved', mgr_user, (d + time '11:10') at time zone 'Asia/Muscat', emp_user, (d + time '11:00') at time zone 'Asia/Muscat')
      on conflict (id) do nothing;
    elsif pat = 'unapproved' then
      perform pg_temp.punch('MCT-ENT-02', '91910', d + time '08:04', 'in');
      perform pg_temp.punch('MCT-ENT-02', '91910', d + time '09:40', 'out');
      perform pg_temp.punch('MCT-ENT-01', '91910', d + time '10:25', 'unknown');
      perform pg_temp.punch('MCT-ENT-02', '91910', d + time '14:01', 'out');
    elsif pat = 'short' then
      perform pg_temp.punch('MCT-ENT-02', '91910', d + time '07:57', 'in');
      perform pg_temp.punch('MCT-ENT-02', '91910', d + time '10:30', 'out');
      perform pg_temp.punch('MCT-ENT-02', '91910', d + time '10:33', 'in');
      perform pg_temp.punch('MCT-ENT-02', '91910', d + time '14:00', 'out');
    end if;

    -- colleagues: simple days with some time away, so the team and HR views have a spread
    if not (d = '2026-10-15'::date) then
      -- Huda works 12:00–18:00
      perform pg_temp.punch('MCT-ENT-02', '91911', d + time '11:55' + (i % 6) * interval '1 minute', 'in');
      if i % 4 = 1 then
        perform pg_temp.punch('MCT-ENT-02', '91911', d + time '15:00', 'out');
        perform pg_temp.punch('MCT-ENT-01', '91911', d + time '15:40', 'unknown');
      end if;
      perform pg_temp.punch('MCT-ENT-02', '91911', d + time '18:03', 'out');
      perform pg_temp.punch('MCT-ENT-02', '91912', d + time '07:52' + (i % 9) * interval '1 minute', 'in');
      if i % 3 = 0 then
        perform pg_temp.punch('MCT-ENT-02', '91912', d + time '10:00', 'out');
        perform pg_temp.punch('MCT-ENT-01', '91912', d + time '11:30', 'unknown');
        insert into public.time_away_requests (id, organization_id, employee_id, branch_id, attendance_date, kind, source, starts_at, ends_at, reason, destination, status, decided_by, decided_at, created_by)
        values (pg_temp.did('ta:' || yousuf || d), org, yousuf, hq, d, 'OFFICIAL', 'request', (d + time '10:00') at time zone 'Asia/Muscat', (d + time '11:30') at time zone 'Asia/Muscat',
          'Supplier sample collection', 'Rusayl Industrial Estate', 'approved', mgr_user, (d - 1 + time '16:00') at time zone 'Asia/Muscat', null)
        on conflict (id) do nothing;
      end if;
      perform pg_temp.punch('MCT-ENT-02', '91912', d + time '14:06', 'out');
      perform pg_temp.punch('MCT-ENT-02', '91913', d + time '08:00' + (i % 15) * interval '1 minute', 'in');
      if i % 5 = 2 then
        perform pg_temp.punch('MCT-ENT-02', '91913', d + time '11:15', 'out');
        perform pg_temp.punch('MCT-ENT-01', '91913', d + time '12:20', 'unknown');
      end if;
      perform pg_temp.punch('MCT-PKG-01', '91913', d + time '14:09', 'unknown');
      if i % 6 <> 4 then
        perform pg_temp.punch('MCT-ENT-02', '91914', d + time '07:50' + (i % 4) * interval '1 minute', 'in');
        perform pg_temp.punch('MCT-ENT-02', '91914', d + time '14:00' + (i % 8) * interval '1 minute', 'out');
      end if;
      perform pg_temp.punch('MCT-ENT-02', '91901', d + time '07:45', 'in');
      perform pg_temp.punch('MCT-ENT-02', '91901', d + time '15:10', 'out');
      perform pg_temp.punch('MCT-ENT-02', '91900', d + time '08:20', 'in');
      perform pg_temp.punch('MCT-ENT-02', '91900', d + time '16:30', 'out');
    end if;
  end loop;

  -- today: Ahmed checked in on the entry-only terminal; colleagues in; Rashid stepped out on official duty
  perform pg_temp.punch('MCT-ENT-01', '91910', '2026-10-15 08:02', 'unknown');
  perform pg_temp.punch('MCT-ENT-02', '91911', '2026-10-15 11:58', 'in');
  perform pg_temp.punch('MCT-ENT-02', '91913', '2026-10-15 08:11', 'in');
  perform pg_temp.punch('MCT-ENT-02', '91914', '2026-10-15 07:53', 'in');
  perform pg_temp.punch('MCT-ENT-02', '91901', '2026-10-15 07:44', 'in');
  perform pg_temp.punch('MCT-ENT-02', '91900', '2026-10-15 08:15', 'in');

  -- ---------------------------------------------------------------------------------------------------------------------------
  -- Meeting rooms, meetings and room entries
  -- ---------------------------------------------------------------------------------------------------------------------------
  insert into public.meeting_rooms (id, organization_id, branch_id, location_id, name, capacity, restricted, allowed_department_ids, allowed_employee_ids)
  values (room_brd, org, hq, boardroom, 'Boardroom', 12, true, array[dep_it, dep_qa, dep_admin], array[gm, hamed]),
         (room_trn, org, hq, training, 'Training Room', 24, false, '{}', '{}')
  on conflict (id) do update set restricted = excluded.restricted, allowed_department_ids = excluded.allowed_department_ids;

  insert into public.meetings (id, organization_id, branch_id, room_id, title, description, starts_at, ends_at, late_after_minutes, organizer_employee_id)
  values
    (pg_temp.did('mtg:qa-review'), org, hq, room_brd, 'Weekly QA review', 'Defect trends, supplier audit findings, release readiness.', '2026-10-14 10:00+04', '2026-10-14 11:00+04', 5, salma),
    (pg_temp.did('mtg:sprint'), org, hq, room_brd, 'Sprint planning — release 4.2', 'Scope and estimates for the next two weeks.', '2026-10-15 11:00+04', '2026-10-15 12:00+04', 5, nasser),
    (pg_temp.did('mtg:safety'), org, hq, room_trn, 'Safety induction — new joiners', 'Fire drill, first aid and site rules.', '2026-10-13 13:00+04', '2026-10-13 14:00+04', 10, hamed),
    (pg_temp.did('mtg:client'), org, hq, room_brd, 'Client demo — Oman LNG', 'Quality dashboard walkthrough for the client.', '2026-10-18 10:00+04', '2026-10-18 11:30+04', 5, hamed),
    (pg_temp.did('mtg:townhall'), org, hq, room_trn, 'Technology town hall', 'Quarterly update from the Head of Technology.', '2026-10-19 12:00+04', '2026-10-19 13:00+04', 5, hamed)
  on conflict (id) do nothing;

  insert into public.meeting_invitees (organization_id, meeting_id, employee_id, is_required)
  select org, pg_temp.did('mtg:' || v.m), v.e, v.req
  from (values ('qa-review', ahmed, true), ('qa-review', huda, true), ('qa-review', yousuf, true), ('qa-review', rashid, true), ('qa-review', mariam, false), ('qa-review', nasser, true), ('qa-review', salma, true), ('qa-review', hamed, false),
               ('sprint', ahmed, true), ('sprint', rashid, true), ('sprint', nasser, true), ('sprint', mariam, true), ('sprint', huda, false), ('sprint', hamed, false),
               ('safety', ahmed, true), ('safety', huda, true), ('safety', yousuf, true), ('safety', rashid, true), ('safety', mariam, true),
               ('client', ahmed, true), ('client', nasser, true), ('client', hamed, true), ('client', salma, true),
               ('townhall', ahmed, true), ('townhall', huda, true), ('townhall', yousuf, true), ('townhall', rashid, true), ('townhall', mariam, true), ('townhall', nasser, true), ('townhall', salma, true)) as v(m, e, req)
  on conflict do nothing;

  -- room entries (ACCESS readers): on time, late, absent, a repeat entry and an unauthorised walk-in (a sales executive)
  perform pg_temp.punch('MCT-BRD-01', '91910', '2026-10-14 09:56', 'in');
  perform pg_temp.punch('MCT-BRD-01', '91911', '2026-10-14 10:02', 'in');
  perform pg_temp.punch('MCT-BRD-01', '91912', '2026-10-14 10:07', 'in');
  perform pg_temp.punch('MCT-BRD-01', '91914', '2026-10-14 09:58', 'in');
  perform pg_temp.punch('MCT-BRD-01', (select device_user_id from public.employees where id = nasser), '2026-10-14 09:59', 'in');
  perform pg_temp.punch('MCT-BRD-01', (select device_user_id from public.employees where id = salma), '2026-10-14 10:12', 'in');
  perform pg_temp.punch('MCT-BRD-01', '91910', '2026-10-14 10:31', 'in');
  perform pg_temp.punch('MCT-BRD-01', (select device_user_id from public.employees where organization_id = org and employee_number = 'EMP-10023'), '2026-10-14 10:20', 'in');
  perform pg_temp.punch('MCT-BRD-01', '91910', '2026-10-15 10:57', 'in');
  perform pg_temp.punch('MCT-BRD-01', '91913', '2026-10-15 11:09', 'in');
  perform pg_temp.punch('MCT-BRD-01', (select device_user_id from public.employees where id = nasser), '2026-10-15 10:55', 'in');
  perform pg_temp.punch('MCT-BRD-01', '91914', '2026-10-15 11:01', 'in');
  perform pg_temp.punch('MCT-BRD-01', '91911', '2026-10-15 11:25', 'in');
  perform pg_temp.punch('MCT-TRN-01', '91910', '2026-10-13 12:55', 'in');
  perform pg_temp.punch('MCT-TRN-01', '91911', '2026-10-13 12:58', 'in');
  perform pg_temp.punch('MCT-TRN-01', '91912', '2026-10-13 13:04', 'in');
  perform pg_temp.punch('MCT-TRN-01', '91913', '2026-10-13 13:16', 'in');
  perform pg_temp.punch('MCT-TRN-01', '91914', '2026-10-13 12:51', 'in');
  perform pg_temp.punch('MCT-TRN-01', '91901', '2026-10-13 13:02', 'in');

  -- ---------------------------------------------------------------------------------------------------------------------------
  -- Process: normalise the raw punches, then recompute every day of the cast (leave days and days without punches too)
  -- ---------------------------------------------------------------------------------------------------------------------------
  insert into jobs.queue (queue_name, job_type, organization_id, payload, priority) values ('processing', 'NORMALIZE_RAW', org, jsonb_build_object('organizationId', org), 9);
  insert into jobs.queue (queue_name, job_type, organization_id, payload, priority, run_at)
  select 'processing', 'RECOMPUTE_DAILY', org, jsonb_build_object('organizationId', org, 'employeeId', e, 'date', g::date::text, 'reason', 'RECALCULATION'), 4, now() + interval '20 seconds'
  from unnest(cast_ids || array[hamed, gm, nasser, salma]) as e, generate_series('2026-09-13'::date, '2026-10-15'::date, interval '1 day') g;
end $$;
