-- FlowZa Time · RIA test tenant seed · step 2/3: structure, four logins, five employees, approval workflows
--
-- Logins (one per role; the password is NOT in this file — the repository is public):
--   ria.admin@flowza.com     Organisation Owner   Mazin Al Lawati, Director General (RIA-001)
--   ria.hr@flowza.com        HR Admin             Shaima Al Hosni, HR Manager (RIA-002)
--   ria.manager@flowza.com   Line Manager         Khalid Al Rashdi, Head of Research Programmes (RIA-003) — manages RIA-004 and RIA-005
--   ria.employee@flowza.com  Employee             Reem Al Shukaili, Research Scientist (RIA-004)
-- plus Vikram Nair, Data Scientist (RIA-005), an employee without a login.
--
-- Password: set it in the same session before this file runs, e.g. as the first statement in the SQL editor
--   select set_config('ria.seed_password', '<password>', false);
-- or for psql:  PGOPTIONS='-c ria.seed_password=<password>' psql "$DATABASE_URL_ADMIN" -v ON_ERROR_STOP=1 -f 02_people.sql
-- The value may also be a bcrypt hash ($2a$/$2b$/$2y$, e.g. from `select extensions.crypt('<password>', extensions.gen_salt('bf', 10))`
-- on any other database), which keeps the plain password out of the server's statement log. Without it the existing logins
-- keep their password and a missing login is an error. Auth rows are written the way Supabase Auth writes them, so this
-- file must run on the admin connection. Idempotent.
set client_min_messages = warning;

create or replace function pg_temp.sid(p text) returns uuid language sql immutable as
$$ select extensions.uuid_generate_v5('1fa2602c-06d4-4341-86ba-2bc971d83563'::uuid, 'ria:' || p) $$;

-- bcrypt hash as Supabase Auth stores it ($2a$/$2b$/$2y$, cost, 53 characters of salt + hash)
create or replace function pg_temp.is_bcrypt(p text) returns boolean language sql immutable as
$$ select p ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' $$;

-- auth user → identity → profile for one login; p_password (plain or bcrypt) null keeps an existing login's password
create or replace function pg_temp.login(p_email text, p_name text, p_password text) returns uuid language plpgsql as $$
declare
  v_id uuid;
  v_pw text := case when p_password is null then null when pg_temp.is_bcrypt(p_password) then p_password else extensions.crypt(p_password, extensions.gen_salt('bf', 10)) end;
  v_col text;
begin
  select id into v_id from auth.users where lower(email) = lower(p_email) limit 1;
  if v_id is null then
    if v_pw is null then raise exception 'login % does not exist yet: set ria.seed_password first (see README.md)', p_email; end if;
    v_id := pg_temp.sid('user:' || lower(p_email));
    insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values (v_id, lower(p_email), v_pw, now(), '{"provider":"email","providers":["email"]}'::jsonb,
            jsonb_build_object('sub', v_id::text, 'email', lower(p_email), 'full_name', p_name, 'email_verified', true, 'phone_verified', false), now(), now());
  else
    update auth.users set encrypted_password = coalesce(v_pw, encrypted_password), email_confirmed_at = coalesce(email_confirmed_at, now()),
      raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('full_name', p_name), updated_at = now()
    where id = v_id;
  end if;

  -- hosted GoTrue columns: instance / audience / role, and the token columns it reads as strings (NULL breaks sign-in);
  -- the local shim's auth.users has none of them
  if exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'instance_id') then
    execute 'update auth.users set instance_id = coalesce(instance_id, ''00000000-0000-0000-0000-000000000000''), aud = coalesce(aud, ''authenticated''), role = coalesce(role, ''authenticated'') where id = $1' using v_id;
  end if;
  foreach v_col in array array['confirmation_token', 'recovery_token', 'email_change_token_new', 'email_change', 'email_change_token_current', 'phone_change', 'phone_change_token', 'reauthentication_token'] loop
    if exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = v_col) then
      execute format('update auth.users set %1$I = coalesce(%1$I, '''') where id = $1', v_col) using v_id;
    end if;
  end loop;
  if to_regclass('auth.identities') is not null then
    execute 'insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
             select $1::text, $1, $2, ''email'', now(), now()
             where not exists (select 1 from auth.identities where user_id = $1 and provider = ''email'')'
      using v_id, jsonb_build_object('sub', v_id::text, 'email', lower(p_email), 'email_verified', true, 'phone_verified', false);
  end if;

  insert into public.user_profiles (id, email, full_name, locale, status)
  values (v_id, lower(p_email), p_name, 'en', 'active')
  on conflict (id) do update set full_name = excluded.full_name, status = 'active', updated_at = now();
  return v_id;
end $$;

-- the first run (19 Oct 2026) created the logins on @flowza.ai: move such a login to its new address, keeping its id,
-- password and memberships (no-op once moved, or when the new address is already taken)
create or replace function pg_temp.move_login(p_old text, p_new text) returns void language plpgsql as $$
declare
  v_id uuid := (select id from auth.users where lower(email) = lower(p_old) limit 1);
begin
  if v_id is null or exists (select 1 from auth.users where lower(email) = lower(p_new)) then return; end if;
  update auth.users set email = lower(p_new), raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('email', lower(p_new)), updated_at = now()
  where id = v_id;
  if to_regclass('auth.identities') is not null then
    execute 'update auth.identities set identity_data = identity_data || jsonb_build_object(''email'', $2::text), updated_at = now() where user_id = $1 and provider = ''email'''
      using v_id, lower(p_new);
  end if;
  update public.user_profiles set email = lower(p_new), updated_at = now() where id = v_id;
  insert into audit.logs (organization_id, actor_type, actor_label, action, entity_type, entity_id, old_value, new_value, reason)
  values ('1fa2602c-06d4-4341-86ba-2bc971d83563', 'SYSTEM', 'Test tenant seed (supabase/seeds/ria-tenant), requested by prem@flowza.ai', 'user.email_changed', 'user', v_id::text,
          jsonb_build_object('email', lower(p_old)), jsonb_build_object('email', lower(p_new)), 'Test logins moved to the flowza.com domain');
end $$;

do $$
declare
  org uuid := '1fa2602c-06d4-4341-86ba-2bc971d83563';
  hq uuid := pg_temp.sid('branch:HQ');
  pw text := nullif(current_setting('ria.seed_password', true), '');
  hik_caps jsonb := (select capabilities from public.device_providers where key = 'hikvision_push');
  m671 uuid := (select id from public.device_models where provider_key = 'hikvision_push' and model like 'MinMoe DS-K1T671%' limit 1);
  t0 timestamptz := '2026-08-16 08:00:00+04';
  admin_id uuid; hr_id uuid; mgr_id uuid; emp_id uuid;
begin
  if not exists (select 1 from public.branches where id = hq) then raise exception 'run 01_tenant.sql first'; end if;
  if pw is not null and not pg_temp.is_bcrypt(pw) and length(pw) < 12 then raise exception 'ria.seed_password must be at least 12 characters'; end if;

  ---------------------------------------------------------------------------------------------------------------------
  -- 1. Logins
  ---------------------------------------------------------------------------------------------------------------------
  perform pg_temp.move_login('ria.' || r || '@flowza.ai', 'ria.' || r || '@flowza.com') from unnest(array['admin', 'hr', 'manager', 'employee']) as r;
  admin_id := pg_temp.login('ria.admin@flowza.com',    'Mazin Al Lawati',  pw);
  hr_id    := pg_temp.login('ria.hr@flowza.com',       'Shaima Al Hosni',  pw);
  mgr_id   := pg_temp.login('ria.manager@flowza.com',  'Khalid Al Rashdi', pw);
  emp_id   := pg_temp.login('ria.employee@flowza.com', 'Reem Al Shukaili', pw);

  ---------------------------------------------------------------------------------------------------------------------
  -- 2. Departments, designations, the government-hours shift (organisation default from 1 Aug)
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.departments (id, organization_id, branch_id, parent_id, code, name, name_ar, status, created_at)
  select pg_temp.sid('dept:' || d.code), org, hq, null, d.code, d.name, d.name_ar, 'active', t0
  from (values
    ('DGO', 'Office of the Director General',   'مكتب المدير العام'),
    ('HRA', 'Human Resources & Administration', 'الموارد البشرية والشؤون الإدارية'),
    ('RND', 'Research & Development',           'البحث والتطوير'),
    ('INN', 'Innovation & Technology Transfer', 'الابتكار ونقل التقنية')
  ) as d(code, name, name_ar)
  on conflict (organization_id, code) do update set name = excluded.name, name_ar = excluded.name_ar, branch_id = excluded.branch_id, status = 'active', updated_at = now();

  insert into public.designations (id, organization_id, code, name, name_ar, level, status, created_at)
  select pg_temp.sid('desig:' || g.code), org, g.code, g.name, g.name_ar, g.lvl, 'active', t0
  from (values
    ('DG',  'Director General',            'المدير العام',            10),
    ('HRM', 'HR Manager',                  'مدير الموارد البشرية',     7),
    ('HRP', 'Head of Research Programmes', 'رئيس البرامج البحثية',     7),
    ('RS',  'Research Scientist',          'باحث علمي',                5),
    ('DS',  'Data Scientist',              'عالم بيانات',              5),
    ('INO', 'Innovation Officer',          'أخصائي ابتكار',            4),
    ('RA',  'Research Assistant',          'مساعد باحث',               3),
    ('LT',  'Laboratory Technician',       'فني مختبر',                3),
    ('ADO', 'Administrative Officer',      'موظف إداري',               3)
  ) as g(code, name, name_ar, lvl)
  on conflict (organization_id, code) do update set name = excluded.name, name_ar = excluded.name_ar, level = excluded.level, status = 'active', updated_at = now();

  insert into public.shifts (id, organization_id, code, name, name_ar, type, start_time, end_time, required_minutes, day_boundary, breaks, punch_in_window_before_minutes, punch_out_window_after_minutes, grace_in_minutes, grace_out_minutes, color, status, created_at)
  values (pg_temp.sid('shift:GOV'), org, 'GOV', 'Government hours 07:30–14:30', 'الدوام الرسمي', 'FIXED', '07:30', '14:30', null, '00:00', '[]'::jsonb, 120, 300, 15, 5, '#0e7490', 'active', t0)
  on conflict (organization_id, code) do update set name = excluded.name, name_ar = excluded.name_ar, type = excluded.type, start_time = excluded.start_time, end_time = excluded.end_time,
    breaks = excluded.breaks, punch_in_window_before_minutes = excluded.punch_in_window_before_minutes, punch_out_window_after_minutes = excluded.punch_out_window_after_minutes,
    grace_in_minutes = excluded.grace_in_minutes, grace_out_minutes = excluded.grace_out_minutes, color = excluded.color, status = 'active', updated_at = now();

  insert into public.shift_assignments (id, organization_id, target_type, target_id, branch_id, shift_id, shift_pattern_id, effective_from, effective_to, created_by, created_at)
  values (pg_temp.sid('assign:org'), org, 'ORGANIZATION', org, null, pg_temp.sid('shift:GOV'), null, '2026-08-01', null, hr_id, t0)
  on conflict (id) do update set shift_id = excluded.shift_id, effective_from = excluded.effective_from, effective_to = excluded.effective_to;

  -- the organisation's baseline policy: without one the engine counts every minute after 14:30 as overtime
  insert into public.attendance_rule_sets (id, organization_id, name, description, branch_id, country_code, department_id, employee_group_id, shift_id, effective_from,
    grace_in_minutes, grace_out_minutes, late_threshold_minutes, early_departure_threshold_minutes, min_full_day_minutes, half_day_threshold_minutes,
    overtime_enabled, overtime_start_after_minutes, overtime_min_block_minutes, overtime_rounding_minutes, overtime_max_minutes_per_day, count_early_in_as_overtime,
    punch_interpretation, duplicate_punch_window_seconds, missing_punch_behavior, auto_absent_without_punches, weekly_off_work_counts_as_overtime, holiday_work_counts_as_overtime,
    ramadan_mode, policy, created_by, created_at)
  values (pg_temp.sid('policy:company'), org, 'Company standard',
          'Government hours: a full day is 6 h; overtime starts 30 min after 14:30, in blocks of 30 min rounded down to 15, at most 4 h a day; Ramadan 2027 hours (5 h) for eligible staff.',
          null, null, null, null, null, '2026-08-01',
          15, 5, 0, 0, 360, 210, true, 30, 30, 15, 240, false, 'FIRST_LAST', 60, 'FLAG_ONLY', true, true, true,
          '{"enabled":true,"from":"2027-02-08","to":"2027-03-09","scheduledMinutes":300,"appliesTo":"flagged_employees"}'::jsonb, '{}'::jsonb, hr_id, t0)
  on conflict (id) do update set name = excluded.name, description = excluded.description, grace_in_minutes = excluded.grace_in_minutes, grace_out_minutes = excluded.grace_out_minutes,
    min_full_day_minutes = excluded.min_full_day_minutes, half_day_threshold_minutes = excluded.half_day_threshold_minutes, overtime_start_after_minutes = excluded.overtime_start_after_minutes,
    overtime_min_block_minutes = excluded.overtime_min_block_minutes, overtime_rounding_minutes = excluded.overtime_rounding_minutes, overtime_max_minutes_per_day = excluded.overtime_max_minutes_per_day,
    ramadan_mode = excluded.ramadan_mode, updated_at = now();

  ---------------------------------------------------------------------------------------------------------------------
  -- 3. A DEMO Hikvision terminal (push / HTTP Listening; no device behind it) that carries the generated punches of step 3
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.devices (id, organization_id, branch_id, code, name, provider_key, model_id, manufacturer, model_name, serial_number, vendor_device_id, timezone, integration_type, endpoint_url, config, capabilities,
    status, connection_status, last_heartbeat_at, last_attendance_sync_at, last_successful_communication_at, firmware_version, device_time_offset_seconds,
    offline_threshold_minutes, auto_sync_enabled, sync_interval_minutes, push_token_hash, push_token_rotated_at, tags, notes, created_by, created_at)
  values (pg_temp.sid('device:HQ-01'), org, hq, 'HQ-01', 'Head Office Main Entrance', 'hikvision_push', m671, 'Hikvision', 'DS-K1T671MF', 'FZD-RIA-0001', null, 'Asia/Muscat', 'DEVICE_PUSH', null,
          jsonb_build_object('serialNumber', 'FZD-RIA-0001', 'lastSeenAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), hik_caps,
          'active', 'online', now() - interval '2 minutes', now() - interval '20 minutes', now() - interval '2 minutes', 'V3.2.30 build 240318', 0,
          1440, false, 5, encode(extensions.digest('ria-demo-push-token:HQ-01:' || gen_random_uuid()::text, 'sha256'), 'hex'), t0, '{ENTRANCE,staff}',
          'Demo terminal created by the test tenant seed (supabase/seeds/ria-tenant) — no physical device behind it.', hr_id, t0)
  on conflict (organization_id, code) do update set name = excluded.name, model_id = excluded.model_id, model_name = excluded.model_name, serial_number = excluded.serial_number,
    config = excluded.config, capabilities = excluded.capabilities, status = 'active', connection_status = 'online', last_heartbeat_at = excluded.last_heartbeat_at,
    last_successful_communication_at = excluded.last_successful_communication_at, offline_threshold_minutes = excluded.offline_threshold_minutes, tags = excluded.tags, notes = excluded.notes, updated_at = now();

  ---------------------------------------------------------------------------------------------------------------------
  -- 4. Employees
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.employees (id, organization_id, employee_number, first_name, middle_name, last_name, display_name, display_name_ar, gender, date_of_birth, nationality_code, email, phone, joining_date,
    employment_status, employment_type, branch_id, department_id, designation_id, manager_employee_id, user_id, device_user_id, card_number, fingerprint_enrolled, face_enrolled, weekly_off_days, custom_fields, created_by, created_at)
  select pg_temp.sid('emp:' || v.num), org, v.num, v.first, v.middle, v.last, v.first || ' ' || v.last, v.name_ar, v.gender::public.gender, v.dob::date, v.nat, v.email, v.phone, v.joining::date,
    'active', 'full_time', hq, pg_temp.sid('dept:' || v.dept), pg_temp.sid('desig:' || v.desig), case when v.mgr is null then null else pg_temp.sid('emp:' || v.mgr) end,
    case v.email when 'ria.admin@flowza.com' then admin_id when 'ria.hr@flowza.com' then hr_id when 'ria.manager@flowza.com' then mgr_id when 'ria.employee@flowza.com' then emp_id end,
    v.pin, v.card, true, true, null,
    jsonb_build_object('ramadanEligible', v.ramadan, 'bloodGroup', v.blood, 'maritalStatus', v.marital, 'grade', v.grade,
                       'emergencyContact', jsonb_build_object('name', v.ec_name, 'phone', v.ec_phone, 'relation', v.ec_rel)),
    hr_id, t0
  from (values
    -- num, first, middle, last, name_ar, gender, dob, nat, email, phone, joining, dept, desig, manager, pin, card, ramadan, blood, marital, grade, ec_name, ec_phone, ec_rel
    ('RIA-001', 'Mazin',  'Ali',    'Al Lawati',   'مازن بن علي اللواتي',      'male',   '1975-03-14', 'OM', 'ria.admin@flowza.com',     '+968 9901 4101', '2019-02-03', 'DGO', 'DG',  null,      '101', '0300000101', true,  'A+',  'married', 'E1', 'Huda Al Lawati',  '+968 9901 4201', 'spouse'),
    ('RIA-002', 'Shaima', 'Said',   'Al Hosni',    'شيماء بنت سعيد الحوسنية',  'female', '1986-07-22', 'OM', 'ria.hr@flowza.com',        '+968 9902 4102', '2020-05-10', 'HRA', 'HRM', 'RIA-001', '102', '0300000102', true,  'O+',  'married', 'M1', 'Said Al Hosni',   '+968 9902 4202', 'father'),
    ('RIA-003', 'Khalid', 'Nasser', 'Al Rashdi',   'خالد بن ناصر الراشدي',     'male',   '1981-11-05', 'OM', 'ria.manager@flowza.com',   '+968 9903 4103', '2020-09-13', 'RND', 'HRP', 'RIA-001', '103', '0300000103', true,  'B+',  'married', 'M1', 'Muna Al Rashdi',  '+968 9903 4203', 'spouse'),
    ('RIA-004', 'Reem',   'Hamed',  'Al Shukaili', 'ريم بنت حمد الشكيلية',     'female', '1994-02-18', 'OM', 'ria.employee@flowza.com',  '+968 9904 4104', '2023-01-15', 'RND', 'RS',  'RIA-003', '104', '0300000104', true,  'A-',  'single',  'S3', 'Hamed Al Shukaili', '+968 9904 4204', 'father'),
    ('RIA-005', 'Vikram', 'Suresh', 'Nair',        'فيكرام سوريش ناير',        'male',   '1991-09-30', 'IN', 'vikram.nair@example.com', '+968 9905 4105', '2025-03-02', 'RND', 'DS',  'RIA-003', '105', '0300000105', false, 'AB+', 'married', 'S3', 'Anjali Nair',     '+91 98470 41105', 'spouse')
  ) as v(num, first, middle, last, name_ar, gender, dob, nat, email, phone, joining, dept, desig, mgr, pin, card, ramadan, blood, marital, grade, ec_name, ec_phone, ec_rel)
  on conflict (organization_id, employee_number) do update set first_name = excluded.first_name, middle_name = excluded.middle_name, last_name = excluded.last_name, display_name = excluded.display_name,
    display_name_ar = excluded.display_name_ar, gender = excluded.gender, date_of_birth = excluded.date_of_birth, nationality_code = excluded.nationality_code, email = excluded.email, phone = excluded.phone,
    joining_date = excluded.joining_date, employment_status = 'active', branch_id = excluded.branch_id, department_id = excluded.department_id, designation_id = excluded.designation_id,
    manager_employee_id = excluded.manager_employee_id, user_id = excluded.user_id, device_user_id = excluded.device_user_id, card_number = excluded.card_number,
    custom_fields = excluded.custom_fields, updated_by = hr_id, updated_at = now(), deleted_at = null;

  update public.departments d set manager_employee_id = pg_temp.sid('emp:' || m.num), updated_at = now()
  from (values ('DGO', 'RIA-001'), ('HRA', 'RIA-002'), ('RND', 'RIA-003')) as m(code, num)
  where d.organization_id = org and d.code = m.code;

  insert into public.employment_history (id, organization_id, employee_id, effective_from, effective_to, branch_id, department_id, designation_id, manager_employee_id, employment_type, employment_status, reason, created_by)
  select pg_temp.sid('hist:' || e.employee_number || ':join'), org, e.id, e.joining_date, null, e.branch_id, e.department_id, e.designation_id, e.manager_employee_id, e.employment_type, 'active', 'Joined', hr_id
  from public.employees e where e.organization_id = org and e.deleted_at is null
  on conflict (id) do update set branch_id = excluded.branch_id, department_id = excluded.department_id, designation_id = excluded.designation_id, manager_employee_id = excluded.manager_employee_id;

  insert into public.teams (id, organization_id, branch_id, code, name, lead_employee_id, status, created_at)
  values (pg_temp.sid('team:RND-PRG'), org, hq, 'RND-PRG', 'Research Programmes', pg_temp.sid('emp:RIA-003'), 'active', t0)
  on conflict (organization_id, code) do update set name = excluded.name, lead_employee_id = excluded.lead_employee_id, status = 'active', updated_at = now();

  insert into public.team_members (team_id, employee_id, organization_id, added_at)
  select pg_temp.sid('team:RND-PRG'), pg_temp.sid('emp:' || m), org, t0 from unnest(array['RIA-003', 'RIA-004', 'RIA-005']) as m
  on conflict do nothing;

  -- terminal enrolment and the provider identity that maps the terminal's employeeNo to the employee
  insert into public.device_employee_states (id, organization_id, device_id, employee_id, branch_id, device_user_id, cloud_hash, device_hash, sync_status, desired, last_sync_at, last_success_at, fingerprint_count, face_enrolled, card_enrolled)
  select pg_temp.sid('des:HQ-01:' || e.employee_number), org, pg_temp.sid('device:HQ-01'), e.id, hq, e.device_user_id,
         'sha1:' || left(md5(e.employee_number || ':cloud'), 16), 'sha1:' || left(md5(e.employee_number || ':cloud'), 16), 'IN_SYNC', true, now() - interval '3 hours', now() - interval '3 hours', 2, true, true
  from public.employees e where e.organization_id = org and e.deleted_at is null
  on conflict (device_id, device_user_id) do update set employee_id = excluded.employee_id, sync_status = excluded.sync_status, desired = true, updated_at = now();

  insert into public.employee_provider_identities (id, organization_id, employee_id, provider_key, device_user_id, card_number)
  select pg_temp.sid('epi:' || e.employee_number), org, e.id, 'hikvision_push', e.device_user_id, e.card_number
  from public.employees e where e.organization_id = org and e.deleted_at is null
  on conflict (organization_id, employee_id, provider_key) do update set device_user_id = excluded.device_user_id, card_number = excluded.card_number, updated_at = now();

  ---------------------------------------------------------------------------------------------------------------------
  -- 5. Memberships (role, all branches, linked employee) and notification preferences
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.org_memberships (id, organization_id, user_id, role_id, status, all_branches, employee_id, invited_by, joined_at, created_at)
  select pg_temp.sid('membership:' || m.who), org, m.user_id, m.role_id::uuid, 'active', true, pg_temp.sid('emp:' || m.num), case when m.who = 'admin' then null else admin_id end, t0, t0
  from (values
    ('admin',    admin_id, '10000000-0000-0000-0000-000000000001', 'RIA-001'),   -- Organisation Owner
    ('hr',       hr_id,    '10000000-0000-0000-0000-000000000003', 'RIA-002'),   -- HR Admin
    ('manager',  mgr_id,   '10000000-0000-0000-0000-000000000009', 'RIA-003'),   -- Line Manager (team = direct reports)
    ('employee', emp_id,   '10000000-0000-0000-0000-000000000008', 'RIA-004')    -- Employee (self-service)
  ) as m(who, user_id, role_id, num)
  on conflict (organization_id, user_id) do update set role_id = excluded.role_id, status = 'active', all_branches = true, employee_id = excluded.employee_id,
    joined_at = coalesce(org_memberships.joined_at, excluded.joined_at), updated_at = now();

  insert into public.notification_preferences (user_id, organization_id, category, channel, enabled)
  select m.user_id, org, c.cat::public.notification_category, ch.ch::public.notification_channel,
         -- test mailboxes: e-mail stays off for the chatty ATTENDANCE and SYSTEM categories; in-app is on for everything
         case when ch.ch = 'EMAIL' and c.cat in ('SYSTEM', 'ATTENDANCE') then false else true end
  from public.org_memberships m
  cross join (values ('DEVICE'), ('ATTENDANCE'), ('APPROVAL'), ('SYSTEM'), ('SUBSCRIPTION'), ('LEAVE'), ('REPORTS')) as c(cat)
  cross join (values ('IN_APP'), ('EMAIL')) as ch(ch)
  where m.organization_id = org
  on conflict (user_id, organization_id, category, channel) do update set enabled = excluded.enabled, updated_at = now();

  ---------------------------------------------------------------------------------------------------------------------
  -- 6. Approval workflows: "Line manager → HR" for every request an employee can file
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.approval_workflows (id, organization_id, entity_type, name, branch_id, steps, is_default, status, created_at)
  select pg_temp.sid('workflow:' || w.entity), org, w.entity::public.approval_entity, 'Line manager → HR', null,
         '[{"order":1,"approverType":"MANAGER","mode":"ANY"},{"order":2,"approverType":"ROLE","roleId":"10000000-0000-0000-0000-000000000003","mode":"ANY"}]'::jsonb, true, 'active', t0
  from (values ('LEAVE'), ('ATTENDANCE_CORRECTION'), ('REGULARISATION'), ('SHIFT_CHANGE'), ('SHIFT_SWAP'), ('OVERTIME_CLAIM'), ('COMP_OFF')) as w(entity)
  on conflict (id) do update set steps = excluded.steps, is_default = true, status = 'active', updated_at = now();
end $$;

select 'people' as step,
  (select count(*) from public.employees where organization_id = '1fa2602c-06d4-4341-86ba-2bc971d83563' and deleted_at is null) as employees,
  (select string_agg(u.email || ' = ' || r.name, ' · ' order by r.name) from public.org_memberships m join public.user_profiles u on u.id = m.user_id join public.roles r on r.id = m.role_id
     where m.organization_id = '1fa2602c-06d4-4341-86ba-2bc971d83563' and m.status = 'active') as logins,
  (select count(*) from public.departments where organization_id = '1fa2602c-06d4-4341-86ba-2bc971d83563') as departments,
  (select count(*) from public.approval_workflows where organization_id = '1fa2602c-06d4-4341-86ba-2bc971d83563') as workflows,
  (select count(*) from public.device_employee_states where organization_id = '1fa2602c-06d4-4341-86ba-2bc971d83563') as enrolments;
