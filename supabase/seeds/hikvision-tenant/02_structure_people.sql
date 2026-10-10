-- FlowZa Time · Hikvision test tenant seed · step 2/5: structure and people (100 employees, 10 departments × 10)
--
-- Keeps everything that exists: the "attendace ghala" branch, the real Hikvision terminal "james" (GN6733356), its punches,
-- the 20 employees and their shift assignments, the three logins. Adds:
--   · a second location, Sohar Plant, that runs 24/7 (weekly off decided by the rotation, so the branch has none);
--   · 10 departments (7 office departments at Ghala, Warehouse / Security / Maintenance at Sohar) — the existing 20
--     employees are spread over the office departments, 80 new employees fill every department to exactly 10;
--   · designations, the OFFICE / LATE / EVENING / SITE shifts, the Oman holiday calendar, geofences;
--   · three DEMO Hikvision terminals (no physical device behind them; serials start with FZD-) that carry the generated
--     history of step 4, so the real terminal's log only ever holds real punches.
-- premreddy1311@gmail.com (K Kumar, 001) becomes the IT Manager with the Line Manager role: their nine IT reports'
-- requests reach them first. Idempotent (uuid v5 ids in the tenant namespace, upserts); admin connection.
set client_min_messages = warning;

create or replace function pg_temp.sid(p text) returns uuid language sql immutable as
$$ select extensions.uuid_generate_v5('78a5a348-69b6-4c51-8d72-3697f72c50f0'::uuid, 'hk-demo:' || p) $$;
create or replace function pg_temp.u(p text) returns double precision language sql immutable as
$$ select (('x' || substr(md5('hk-demo-2026:' || p), 1, 8))::bit(32)::bigint)::double precision / 4294967296.0 $$;

do $$
declare
  org uuid := '78a5a348-69b6-4c51-8d72-3697f72c50f0';
  owner_id uuid := '49511ed9-d4fb-4db2-9e82-d5ff90a9d125';      -- prem@flowza.ai (Owner)
  hr_id uuid := 'fb89ea8b-1d92-49b1-8ff2-c3796d5f3c70';         -- reddyprem1311@gmail.com (HR Admin)
  kumar_user uuid := 'aa8a8a71-bf85-446a-9978-ab4b969410fb';    -- premreddy1311@gmail.com (employee 001, K Kumar)
  ghala uuid := '63751c8f-885c-4140-8bd7-1511876be027';
  sohar uuid := pg_temp.sid('branch:SOH');
  old_dept uuid := '8e84608b-3357-4ecd-bd07-5a0b14c0fc30';      -- "owner", emptied below
  cal uuid := pg_temp.sid('holiday-calendar:OM');
  hik_caps jsonb := (select capabilities from public.device_providers where key = 'hikvision_push');
  m671 uuid := (select id from public.device_models where provider_key = 'hikvision_push' and model like 'MinMoe DS-K1T671%' limit 1);
  m341 uuid := (select id from public.device_models where provider_key = 'hikvision_push' and model like 'MinMoe DS-K1T341%' limit 1);
  t0 timestamptz := '2026-08-20 09:00:00+04';
begin
  if not exists (select 1 from public.organizations where id = org and company_code = 'HIKVISION') then raise exception 'tenant not found'; end if;

  ---------------------------------------------------------------------------------------------------------------------
  -- Settings: self-service check-in (web, mobile, selfie) with geofence flagging, self-service corrections
  ---------------------------------------------------------------------------------------------------------------------
  update public.organization_settings set
    attendance = jsonb_set(attendance, '{selfService}', coalesce(attendance -> 'selfService', '{}'::jsonb)
                   || jsonb_build_object('webCheckIn', true, 'mobileCheckIn', true, 'allowSelfieCheckIn', true, 'requireGeofence', 'flag'))
                 || jsonb_build_object('allowSelfServiceCorrections', true),
    updated_by = owner_id, updated_at = now()
  where organization_id = org;

  ---------------------------------------------------------------------------------------------------------------------
  -- Holiday calendar (Oman 2026; moon-sighting dates tentative)
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.holiday_calendars (id, organization_id, name, country_code, is_default, created_at)
  values (cal, org, 'Oman Public Holidays', 'OM', true, t0)
  on conflict (id) do update set name = excluded.name, country_code = excluded.country_code, is_default = true;

  insert into public.holidays (id, organization_id, calendar_id, name, name_ar, date, end_date, is_half_day, type, branch_ids, is_tentative, created_at)
  select pg_temp.sid('holiday:' || h.name || ':' || h.d), org, cal, h.name, h.name_ar, h.d::date, h.e::date, false, h.t::public.holiday_type, null, h.tent, t0
  from (values
    ('New Year''s Day',     'رأس السنة الميلادية',    '2026-01-01', null,         'PUBLIC',    false),
    ('Accession Day',       'يوم التولي',              '2026-01-11', null,         'PUBLIC',    false),
    ('Eid al-Fitr',         'عيد الفطر',               '2026-03-19', '2026-03-23', 'RELIGIOUS', true),
    ('Eid al-Adha',         'عيد الأضحى',              '2026-05-26', '2026-05-29', 'RELIGIOUS', true),
    ('Islamic New Year',    'رأس السنة الهجرية',       '2026-06-16', null,         'RELIGIOUS', true),
    ('Prophet''s Birthday', 'المولد النبوي الشريف',    '2026-08-25', null,         'RELIGIOUS', true),
    ('National Day',        'العيد الوطني',            '2026-11-18', '2026-11-19', 'PUBLIC',    false)
  ) as h(name, name_ar, d, e, t, tent)
  on conflict (id) do update set name = excluded.name, name_ar = excluded.name_ar, date = excluded.date, end_date = excluded.end_date, type = excluded.type, is_tentative = excluded.is_tentative;

  ---------------------------------------------------------------------------------------------------------------------
  -- Locations: complete the existing Ghala office (coordinates only where missing) and add the 24/7 Sohar plant
  ---------------------------------------------------------------------------------------------------------------------
  update public.branches set city = coalesce(city, 'Muscat'), latitude = coalesce(latitude, 23.5859), longitude = coalesce(longitude, 58.3854),
    geofence_radius_m = coalesce(geofence_radius_m, 200),
    address = case when address = '{}'::jsonb then jsonb_build_object('line1', 'Way 4508, Ghala Industrial Area', 'city', 'Muscat', 'region', 'Muscat Governorate', 'postalCode', '121', 'country', 'OM') else address end,
    holiday_calendar_id = coalesce(holiday_calendar_id, cal), updated_at = now()
  where id = ghala;

  insert into public.branches (id, organization_id, code, name, name_ar, country_code, city, address, timezone, latitude, longitude, geofence_radius_m, contact, weekly_off_days, holiday_calendar_id, status, created_at)
  values (sohar, org, 'SOH', 'Sohar Plant (24/7)', 'مصنع صحار', 'OM', 'Sohar',
          jsonb_build_object('line1', 'Plot 112, Sohar Industrial Estate, Phase 4', 'city', 'Sohar', 'region', 'North Al Batinah Governorate', 'postalCode', '311', 'country', 'OM'),
          'Asia/Muscat', 24.3615, 56.7240, 400, jsonb_build_object('name', 'Waleed Al-Kindi', 'email', 'sohar.plant@example.com', 'phone', '+968 2685 4410'),
          '{}'::smallint[], cal, 'active', t0)
  on conflict (organization_id, code) do update set name = excluded.name, name_ar = excluded.name_ar, city = excluded.city, address = excluded.address, latitude = excluded.latitude, longitude = excluded.longitude,
    geofence_radius_m = excluded.geofence_radius_m, contact = excluded.contact, weekly_off_days = excluded.weekly_off_days, holiday_calendar_id = excluded.holiday_calendar_id, status = 'active', updated_at = now();

  insert into public.geofences (id, organization_id, branch_id, name, latitude, longitude, radius_m, enforcement, accuracy_threshold_m, grace_m, is_active, created_by, created_at)
  values (pg_temp.sid('geofence:GHALA'), org, ghala, 'Ghala office', 23.5859, 58.3854, 200, 'soft_warn', 100, 25, true, hr_id, t0),
         (pg_temp.sid('geofence:SOH'), org, sohar, 'Sohar plant perimeter', 24.3615, 56.7240, 400, 'soft_warn', 100, 50, true, hr_id, t0)
  on conflict (id) do update set latitude = excluded.latitude, longitude = excluded.longitude, radius_m = excluded.radius_m, enforcement = excluded.enforcement, is_active = true, updated_at = now();

  ---------------------------------------------------------------------------------------------------------------------
  -- Departments (organisation-wide) and designations. Heads are linked once the employees exist.
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.departments (id, organization_id, branch_id, parent_id, code, name, name_ar, status, created_at)
  select pg_temp.sid('dept:' || d.code), org, case d.br when 'SOH' then sohar else ghala end, null, d.code, d.name, d.name_ar, 'active', t0
  from (values
    ('MGMT',  'Management & Administration', 'الإدارة والشؤون الإدارية', 'GHL'),
    ('HR',    'Human Resources',             'الموارد البشرية',          'GHL'),
    ('FIN',   'Finance & Accounts',          'المالية والحسابات',        'GHL'),
    ('IT',    'Information Technology',      'تقنية المعلومات',          'GHL'),
    ('SALES', 'Sales & Marketing',           'المبيعات والتسويق',        'GHL'),
    ('CS',    'Customer Service',            'خدمة العملاء',             'GHL'),
    ('OPS',   'Operations',                  'العمليات',                 'GHL'),
    ('WH',    'Warehouse & Logistics',       'المستودعات والخدمات اللوجستية', 'SOH'),
    ('SEC',   'Security',                    'الأمن',                    'SOH'),
    ('MNT',   'Maintenance',                 'الصيانة',                  'SOH')
  ) as d(code, name, name_ar, br)
  on conflict (organization_id, code) do update set name = excluded.name, name_ar = excluded.name_ar, branch_id = excluded.branch_id, status = 'active', updated_at = now();

  insert into public.designations (id, organization_id, code, name, name_ar, level, status, created_at)
  select pg_temp.sid('desig:' || g.code), org, g.code, g.name, g.name_ar, g.lvl, 'active', t0
  from (values
    ('MD',   'Managing Director',            'العضو المنتدب',              10),
    ('GM',   'General Manager',              'المدير العام',               9),
    ('HRM',  'HR Manager',                   'مدير الموارد البشرية',       7),
    ('FM',   'Finance Manager',              'مدير المالية',               7),
    ('ITM',  'IT Manager',                   'مدير تقنية المعلومات',       7),
    ('SM',   'Sales Manager',                'مدير المبيعات',              7),
    ('OPM',  'Operations Manager',           'مدير العمليات',              7),
    ('MENG', 'Maintenance Engineer',         'مهندس صيانة',                6),
    ('CSL',  'Customer Service Lead',        'قائد خدمة العملاء',          6),
    ('WHS',  'Warehouse Supervisor',         'مشرف مستودع',                6),
    ('SSUP', 'Security Supervisor',          'مشرف أمن',                   6),
    ('OFFM', 'Office Manager',               'مدير المكتب',                5),
    ('SSE',  'Senior Software Engineer',     'مهندس برمجيات أول',          5),
    ('SACC', 'Senior Accountant',            'محاسب أول',                  5),
    ('KAM',  'Key Account Manager',          'مدير حسابات رئيسية',         5),
    ('EXA',  'Executive Assistant',          'مساعد تنفيذي',               4),
    ('PRO',  'Public Relations Officer',     'مندوب علاقات عامة',          4),
    ('HRE',  'HR Executive',                 'تنفيذي موارد بشرية',         4),
    ('HRO',  'HR Officer',                   'مسؤول موارد بشرية',          4),
    ('REC',  'Recruitment Specialist',       'أخصائي توظيف',               4),
    ('TRN',  'Training Coordinator',         'منسق تدريب',                 4),
    ('OMN',  'Omanisation Officer',          'مسؤول التعمين',              4),
    ('ERO',  'Employee Relations Officer',   'مسؤول علاقات الموظفين',      4),
    ('PAYS', 'Payroll Specialist',           'أخصائي رواتب',               4),
    ('ACC',  'Accountant',                   'محاسب',                      4),
    ('PRC',  'Procurement Officer',          'مسؤول مشتريات',              4),
    ('PUR',  'Purchasing Officer',           'مسؤول شراء',                 4),
    ('SE',   'Software Engineer',            'مهندس برمجيات',              4),
    ('QA',   'QA Engineer',                  'مهندس ضمان الجودة',          4),
    ('NET',  'Network Engineer',             'مهندس شبكات',                4),
    ('BA',   'Business Analyst',             'محلل أعمال',                 4),
    ('ITSE', 'IT Support Engineer',          'مهندس دعم تقني',             4),
    ('MKE',  'Marketing Executive',          'تنفيذي تسويق',               4),
    ('LOG',  'Logistics Coordinator',        'منسق لوجستي',                4),
    ('PLN',  'Planner',                      'مخطط',                       4),
    ('OPC',  'Operations Coordinator',       'منسق عمليات',                4),
    ('HSE',  'HSE Officer',                  'مسؤول الصحة والسلامة',       4),
    ('INV',  'Inventory Controller',         'مراقب مخزون',                4),
    ('QAN',  'Quality Analyst',              'محلل جودة',                  4),
    ('SEX',  'Sales Executive',              'تنفيذي مبيعات',              3),
    ('SCO',  'Sales Coordinator',            'منسق مبيعات',                3),
    ('CSE',  'Customer Service Executive',   'تنفيذي خدمة عملاء',          3),
    ('CCA',  'Call Centre Agent',            'موظف مركز اتصال',            3),
    ('APC',  'Accounts Payable Clerk',       'كاتب حسابات دائنة',          3),
    ('ARC',  'Accounts Receivable Clerk',    'كاتب حسابات مدينة',          3),
    ('CSH',  'Cashier',                      'أمين صندوق',                 3),
    ('HRA',  'HR Assistant',                 'مساعد موارد بشرية',          3),
    ('ITT',  'IT Support Technician',        'فني دعم تقني',               3),
    ('QI',   'Quality Inspector',            'مفتش جودة',                  3),
    ('FLT',  'Fleet Coordinator',            'منسق أسطول',                 3),
    ('ELEC', 'Electrician',                  'كهربائي',                    3),
    ('MECH', 'Mechanic',                     'ميكانيكي',                   3),
    ('TECH', 'Technician',                   'فني',                        3),
    ('HVAC', 'HVAC Technician',              'فني تكييف',                  3),
    ('FLO',  'Forklift Operator',            'مشغل رافعة شوكية',           2),
    ('STK',  'Storekeeper',                  'أمين مخزن',                  2),
    ('ADMA', 'Administrative Assistant',     'مساعد إداري',                2),
    ('RCP',  'Receptionist',                 'موظف استقبال',               2),
    ('SGD',  'Security Guard',               'حارس أمن',                   2),
    ('WHA',  'Warehouse Assistant',          'مساعد مستودع',               2),
    ('PLMB', 'Plumber',                      'سباك',                       2),
    ('MER',  'Merchandiser',                 'منسق عرض',                   2),
    ('OA',   'Office Assistant',             'مساعد مكتب',                 1),
    ('LDR',  'Loader',                       'عامل تحميل',                 1),
    ('DRV',  'Driver',                       'سائق',                       1)
  ) as g(code, name, name_ar, lvl)
  on conflict (organization_id, code) do update set name = excluded.name, name_ar = excluded.name_ar, level = excluded.level, status = 'active', updated_at = now();

  ---------------------------------------------------------------------------------------------------------------------
  -- Shifts (the 24/7 crew shifts are created by the round-the-clock step, 03_enterprise.sql) and the default assignments:
  -- organisation → OFFICE, Maintenance → SITE. The existing per-employee FLEX ("1") assignments stay as they are.
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.shifts (id, organization_id, code, name, name_ar, type, start_time, end_time, required_minutes, day_boundary, breaks, punch_in_window_before_minutes, punch_out_window_after_minutes, grace_in_minutes, grace_out_minutes, color, status, created_at)
  values
    (pg_temp.sid('shift:OFFICE'), org, 'OFFICE', 'Office 08:00–17:00',          'الدوام المكتبي',      'FIXED', '08:00', '17:00', null, '00:00', '[{"start":"13:00","end":"14:00","paid":false}]'::jsonb, 240, 360, null, null, '#175cd3', 'active', t0),
    (pg_temp.sid('shift:LATE'),   org, 'LATE',   'Late office 10:00–19:00',     'الدوام المتأخر',      'FIXED', '10:00', '19:00', null, '00:00', '[{"start":"14:00","end":"15:00","paid":false}]'::jsonb, 240, 360, null, null, '#7a2e9d', 'active', t0),
    (pg_temp.sid('shift:EVE'),    org, 'EVE',    'Evening support 18:00–22:00', 'الدعم المسائي',       'FIXED', '18:00', '22:00', null, '00:00', '[]'::jsonb,                                         120, 240, null, null, '#c11574', 'active', t0),
    (pg_temp.sid('shift:SITE'),   org, 'SITE',   'Plant day 07:00–16:00',       'دوام المصنع النهاري', 'FIXED', '07:00', '16:00', null, '00:00', '[{"start":"12:00","end":"12:30","paid":false}]'::jsonb, 240, 360, 15,   5,    '#b54708', 'active', t0)
  on conflict (organization_id, code) do update set name = excluded.name, name_ar = excluded.name_ar, type = excluded.type, start_time = excluded.start_time, end_time = excluded.end_time,
    breaks = excluded.breaks, punch_in_window_before_minutes = excluded.punch_in_window_before_minutes, punch_out_window_after_minutes = excluded.punch_out_window_after_minutes,
    grace_in_minutes = excluded.grace_in_minutes, grace_out_minutes = excluded.grace_out_minutes, color = excluded.color, status = 'active', updated_at = now();

  insert into public.shift_assignments (id, organization_id, target_type, target_id, branch_id, shift_id, shift_pattern_id, effective_from, effective_to, created_by, created_at)
  values (pg_temp.sid('assign:org'),      org, 'ORGANIZATION', org,                     null,  pg_temp.sid('shift:OFFICE'), null, '2026-08-01', null, hr_id, t0),
         (pg_temp.sid('assign:dept:MNT'), org, 'DEPARTMENT',   pg_temp.sid('dept:MNT'), sohar, pg_temp.sid('shift:SITE'),   null, '2026-08-01', null, hr_id, t0)
  on conflict (id) do update set shift_id = excluded.shift_id, effective_from = excluded.effective_from, effective_to = excluded.effective_to;

  ---------------------------------------------------------------------------------------------------------------------
  -- Demo Hikvision terminals (push / HTTP Listening). No device sits behind them: they carry the generated history only.
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.devices (id, organization_id, branch_id, code, name, provider_key, model_id, manufacturer, model_name, serial_number, vendor_device_id, timezone, integration_type, endpoint_url, config, capabilities,
    status, connection_status, last_heartbeat_at, last_attendance_sync_at, last_successful_communication_at, firmware_version, device_time_offset_seconds,
    offline_threshold_minutes, auto_sync_enabled, sync_interval_minutes, push_token_hash, push_token_rotated_at, tags, notes, created_by, created_at)
  select pg_temp.sid('device:' || d.code), org, case d.br when 'SOH' then sohar else ghala end, d.code, d.name, 'hikvision_push', case d.mdl when '341' then m341 else m671 end, 'Hikvision',
         case d.mdl when '341' then 'DS-K1T341CMF' else 'DS-K1T671MF' end, d.serial, null, 'Asia/Muscat', 'DEVICE_PUSH', null,
         jsonb_build_object('serialNumber', d.serial, 'lastSeenAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), hik_caps,
         'active', 'online', now() - interval '2 minutes', now() - interval '20 minutes', now() - interval '2 minutes', 'V3.2.30 build 240318', 0,
         1440, false, 5, encode(extensions.digest('hk-demo-push-token:' || d.code || ':' || gen_random_uuid()::text, 'sha256'), 'hex'), t0, d.tags::text[],
         'Demo terminal created by the demo data seed (supabase/seeds/hikvision-tenant) — no physical device behind it. ' || d.note, hr_id, t0
  from (values
    ('GHL-02', 'GHL', 'Ghala Staff Entrance', '671', 'FZD-GHL-0002', '{ENTRANCE,staff}',  'Staff entrance next to the car park.'),
    ('SOH-01', 'SOH', 'Sohar Plant Gate',     '671', 'FZD-SOH-0001', '{ENTRANCE,gate}',   'Main gatehouse of the plant; every shift clocks here.'),
    ('SOH-02', 'SOH', 'Sohar Warehouse Dock', '341', 'FZD-SOH-0002', '{warehouse,dock}',  'Loading dock entrance used by the warehouse crews.')
  ) as d(code, br, name, mdl, serial, tags, note)
  on conflict (organization_id, code) do update set branch_id = excluded.branch_id, name = excluded.name, model_id = excluded.model_id, model_name = excluded.model_name, serial_number = excluded.serial_number,
    config = excluded.config, capabilities = excluded.capabilities, status = 'active', connection_status = 'online', last_heartbeat_at = excluded.last_heartbeat_at,
    last_successful_communication_at = excluded.last_successful_communication_at, offline_threshold_minutes = excluded.offline_threshold_minutes, tags = excluded.tags, notes = excluded.notes, updated_at = now();

  ---------------------------------------------------------------------------------------------------------------------
  -- The existing 20 employees: departments, designations (Omani test names get a gender and a nationality; 001 keeps theirs)
  ---------------------------------------------------------------------------------------------------------------------
  update public.employees e set department_id = pg_temp.sid('dept:' || v.dept), designation_id = pg_temp.sid('desig:' || v.desig),
    gender = case when v.gender is null then e.gender else v.gender::public.gender end,
    nationality_code = coalesce(e.nationality_code, v.nat),
    updated_by = hr_id, updated_at = now()
  from (values
    ('001',     'IT',    'ITM',  null,     null),
    ('TEST001', 'IT',    'SSE',  'male',   'EG'),
    ('TEST019', 'IT',    'ITSE', 'male',   'OM'),
    ('TEST011', 'MGMT',  'MD',   'male',   'OM'),
    ('TEST005', 'MGMT',  'GM',   'male',   'OM'),
    ('TEST020', 'MGMT',  'EXA',  'female', 'OM'),
    ('TEST002', 'HR',    'HRM',  'female', 'OM'),
    ('TEST012', 'HR',    'HRE',  'female', 'OM'),
    ('TEST014', 'HR',    'HRO',  'female', 'OM'),
    ('TEST006', 'FIN',   'FM',   'female', 'OM'),
    ('TEST009', 'FIN',   'ACC',  'male',   'OM'),
    ('TEST018', 'FIN',   'PAYS', 'female', 'OM'),
    ('TEST003', 'SALES', 'SM',   'male',   'OM'),
    ('TEST007', 'SALES', 'SEX',  'male',   'OM'),
    ('TEST016', 'SALES', 'SEX',  'female', 'OM'),
    ('TEST010', 'CS',    'CSL',  'female', 'OM'),
    ('TEST008', 'CS',    'CSE',  'female', 'OM'),
    ('TEST013', 'CS',    'CSE',  'male',   'OM'),
    ('TEST015', 'OPS',   'OPM',  'male',   'OM'),
    ('TEST017', 'OPS',   'OPC',  'male',   'OM')
  ) as v(num, dept, desig, gender, nat)
  where e.organization_id = org and e.employee_number = v.num and e.deleted_at is null;

  ---------------------------------------------------------------------------------------------------------------------
  -- 80 new employees: Ghala office departments filled to 10, Warehouse / Security / Maintenance at Sohar (10 each).
  -- Device user ids 1001–1080 (the real terminal uses 1–21). Two joiners inside the history window (EMP032, EMP062).
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.employees (id, organization_id, employee_number, first_name, last_name, display_name, gender, date_of_birth, nationality_code, email, phone, joining_date,
    employment_status, employment_type, branch_id, department_id, designation_id, device_user_id, card_number, fingerprint_enrolled, face_enrolled, weekly_off_days, custom_fields, created_by, created_at)
  select pg_temp.sid('emp:' || v.num), org, v.num, v.first, v.last, v.first || ' ' || v.last, v.gender::public.gender,
    (date '1970-01-01' + floor(pg_temp.u(v.num || ':dob') * 12000)::int + 2900)::date, v.nat,
    lower(regexp_replace(v.first || '.' || v.last, '[^A-Za-z.]', '', 'g')) || '.' || lower(v.num) || '@example.com',
    '+968 9' || lpad(floor(pg_temp.u(v.num || ':phone') * 9999999)::bigint::text, 7, '0'),
    v.joining::date, 'active', case when v.dept in ('WH', 'SEC') and pg_temp.u(v.num || ':contract') < 0.3 then 'contract' else 'full_time' end::public.employment_type,
    case when v.dept in ('WH', 'SEC', 'MNT') then sohar else ghala end, pg_temp.sid('dept:' || v.dept), pg_temp.sid('desig:' || v.desig),
    (1000 + substr(v.num, 4)::int - 20)::text, '00' || (4410000 + substr(v.num, 4)::int)::text,
    pg_temp.u(v.num || ':fp') < 0.55, true,
    case when v.dept = 'MNT' then '{5,6}'::smallint[] else null end,
    jsonb_build_object('grade', v.grade, 'crew', v.crew, 'ramadanEligible', v.nat = 'OM' or pg_temp.u(v.num || ':muslim') < 0.6),
    hr_id, greatest(t0, (v.joining::date::timestamp) at time zone 'Asia/Muscat')
  from (values
    -- num,      first,       last,            gender,   nat,  dept,    desig,  joining,      grade, crew
    ('EMP021', 'Saif',      'Al-Maskari',     'male',   'OM', 'MGMT',  'OFFM', '2020-03-15', 'M2', null),
    ('EMP022', 'Reem',      'Al-Kindi',       'female', 'OM', 'MGMT',  'ADMA', '2022-06-01', 'S1', null),
    ('EMP023', 'Joseph',    'Fernandes',      'male',   'IN', 'MGMT',  'ADMA', '2021-01-10', 'S1', null),
    ('EMP024', 'Talal',     'Al-Rashdi',      'male',   'OM', 'MGMT',  'PRO',  '2019-09-01', 'S2', null),
    ('EMP025', 'Abdul',     'Rahman',         'male',   'BD', 'MGMT',  'DRV',  '2018-11-20', 'W1', null),
    ('EMP026', 'Imran',     'Shah',           'male',   'PK', 'MGMT',  'DRV',  '2023-02-14', 'W1', null),
    ('EMP027', 'Marites',   'Cruz',           'female', 'PH', 'MGMT',  'OA',   '2024-05-05', 'W1', null),
    ('EMP028', 'Asma',      'Al-Jabri',       'female', 'OM', 'HR',    'REC',  '2021-04-11', 'S2', null),
    ('EMP029', 'Nasser',    'Al-Saadi',       'male',   'OM', 'HR',    'TRN',  '2022-09-18', 'S2', null),
    ('EMP030', 'Shamsa',    'Al-Harrasi',     'female', 'OM', 'HR',    'OMN',  '2020-07-01', 'S2', null),
    ('EMP031', 'Priya',     'Nair',           'female', 'IN', 'HR',    'HRA',  '2023-08-01', 'S1', null),
    ('EMP032', 'Bushra',    'Al-Mamari',      'female', 'OM', 'HR',    'HRA',  '2026-09-13', 'S1', null),
    ('EMP033', 'Hilal',     'Al-Rawahi',      'male',   'OM', 'HR',    'ERO',  '2019-12-01', 'S2', null),
    ('EMP034', 'Angela',    'Reyes',          'female', 'PH', 'HR',    'RCP',  '2022-02-20', 'W2', null),
    ('EMP035', 'Venkatesh', 'Iyer',           'male',   'IN', 'FIN',   'SACC', '2018-05-06', 'M1', null),
    ('EMP036', 'Muna',      'Al-Shukaili',    'female', 'OM', 'FIN',   'ACC',  '2021-10-10', 'S2', null),
    ('EMP037', 'Faisal',    'Mahmood',        'male',   'PK', 'FIN',   'ACC',  '2020-01-12', 'S2', null),
    ('EMP038', 'Ruqaiya',   'Al-Busaidi',     'female', 'OM', 'FIN',   'APC',  '2023-03-19', 'S1', null),
    ('EMP039', 'Dinesh',    'Kumar',          'male',   'IN', 'FIN',   'ARC',  '2022-11-06', 'S1', null),
    ('EMP040', 'Yaqoob',    'Al-Farsi',       'male',   'OM', 'FIN',   'CSH',  '2019-06-23', 'S1', null),
    ('EMP041', 'Nadia',     'Hassan',         'female', 'EG', 'FIN',   'PRC',  '2024-01-07', 'S2', null),
    ('EMP042', 'Rahul',     'Menon',          'male',   'IN', 'IT',    'SE',   '2021-07-04', 'S3', null),
    ('EMP043', 'Mazin',     'Al-Hinai',       'male',   'OM', 'IT',    'SE',   '2023-09-03', 'S2', null),
    ('EMP044', 'Sneha',     'Pillai',         'female', 'IN', 'IT',    'SE',   '2024-02-11', 'S2', null),
    ('EMP045', 'Ali',       'Raza',           'male',   'PK', 'IT',    'QA',   '2022-05-15', 'S2', null),
    ('EMP046', 'Khalfan',   'Al-Siyabi',      'male',   'OM', 'IT',    'NET',  '2020-10-18', 'S3', null),
    ('EMP047', 'Mark',      'Villanueva',     'male',   'PH', 'IT',    'ITT',  '2023-06-25', 'S1', null),
    ('EMP048', 'Hajar',     'Al-Lamki',       'female', 'OM', 'IT',    'BA',   '2025-01-05', 'S2', null),
    ('EMP049', 'Fahad',     'Al-Balushi',     'male',   'OM', 'SALES', 'KAM',  '2019-03-03', 'M1', null),
    ('EMP050', 'Ahmed',     'Al-Ghailani',    'male',   'OM', 'SALES', 'SEX',  '2021-08-08', 'S1', null),
    ('EMP051', 'Arjun',     'Reddy',          'male',   'IN', 'SALES', 'SEX',  '2022-12-04', 'S1', null),
    ('EMP052', 'Latifa',    'Al-Zaabi',       'female', 'OM', 'SALES', 'MKE',  '2023-04-16', 'S2', null),
    ('EMP053', 'Kareem',    'Mostafa',        'male',   'EG', 'SALES', 'SEX',  '2020-09-27', 'S1', null),
    ('EMP054', 'Wafa',      'Al-Riyami',      'female', 'OM', 'SALES', 'SCO',  '2024-07-21', 'S1', null),
    ('EMP055', 'Rizwan',    'Ahmed',          'male',   'PK', 'SALES', 'MER',  '2025-03-02', 'W2', null),
    ('EMP056', 'Aisha',     'Al-Saadi',       'female', 'OM', 'CS',    'CSE',  '2021-02-07', 'S1', null),
    ('EMP057', 'Mohammed',  'Al-Amri',        'male',   'OM', 'CS',    'CSE',  '2022-10-02', 'S1', null),
    ('EMP058', 'Jennifer',  'Santos',         'female', 'PH', 'CS',    'CSE',  '2023-01-15', 'S1', null),
    ('EMP059', 'Sultan',    'Al-Hashmi',      'male',   'OM', 'CS',    'CSE',  '2020-04-26', 'S1', null),
    ('EMP060', 'Fatma',     'Al-Kalbani',     'female', 'OM', 'CS',    'CCA',  '2024-09-08', 'W2', null),
    ('EMP061', 'Nimal',     'Perera',         'male',   'LK', 'CS',    'CCA',  '2023-11-12', 'W2', null),
    ('EMP062', 'Thuraya',   'Al-Hosni',       'female', 'OM', 'CS',    'QAN',  '2026-09-20', 'S2', null),
    ('EMP063', 'Badar',     'Al-Mughairi',    'male',   'OM', 'OPS',   'LOG',  '2019-08-11', 'S2', null),
    ('EMP064', 'Suresh',    'Babu',           'male',   'IN', 'OPS',   'PLN',  '2020-12-13', 'S2', null),
    ('EMP065', 'Jamal',     'Uddin',          'male',   'BD', 'OPS',   'STK',  '2021-06-06', 'W2', null),
    ('EMP066', 'Anwar',     'Hossain',        'male',   'BD', 'OPS',   'STK',  '2022-03-27', 'W2', null),
    ('EMP067', 'Salma',     'Al-Harthi',      'female', 'OM', 'OPS',   'PUR',  '2023-05-14', 'S2', null),
    ('EMP068', 'Ramesh',    'Thapa',          'male',   'NP', 'OPS',   'FLT',  '2021-09-19', 'S1', null),
    ('EMP069', 'Mohammed',  'Al-Wahaibi',     'male',   'OM', 'OPS',   'QI',   '2024-10-06', 'S1', null),
    ('EMP070', 'Ibrahim',   'Al-Kharusi',     'male',   'OM', 'OPS',   'HSE',  '2020-02-23', 'S2', null),
    ('EMP071', 'Hamood',    'Al-Badi',        'male',   'OM', 'WH',    'WHS',  '2018-04-08', 'M1', 'WH-A'),
    ('EMP072', 'Rajesh',    'Yadav',          'male',   'IN', 'WH',    'FLO',  '2020-06-14', 'W2', 'WH-A'),
    ('EMP073', 'Mohammad',  'Alamgir',        'male',   'BD', 'WH',    'WHA',  '2021-11-21', 'W1', 'WH-A'),
    ('EMP074', 'Zahir',     'Al-Maamari',     'male',   'OM', 'WH',    'INV',  '2019-10-27', 'S1', 'WH-B'),
    ('EMP075', 'Shahid',    'Iqbal',          'male',   'PK', 'WH',    'FLO',  '2022-08-07', 'W2', 'WH-B'),
    ('EMP076', 'Ravi',      'Shankar',        'male',   'IN', 'WH',    'WHA',  '2023-02-26', 'W1', 'WH-B'),
    ('EMP077', 'Yousuf',    'Al-Ruqaishi',    'male',   'OM', 'WH',    'FLO',  '2021-03-21', 'W2', 'WH-C'),
    ('EMP078', 'Kamal',     'Hossain',        'male',   'BD', 'WH',    'WHA',  '2024-04-14', 'W1', 'WH-C'),
    ('EMP079', 'Prakash',   'Rai',            'male',   'NP', 'WH',    'LDR',  '2022-07-10', 'W1', 'WH-D'),
    ('EMP080', 'Saleh',     'Al-Jahwari',     'male',   'OM', 'WH',    'WHA',  '2025-05-18', 'W1', 'WH-D'),
    ('EMP081', 'Mubarak',   'Al-Shidi',       'male',   'OM', 'SEC',   'SSUP', '2017-09-10', 'S2', 'SEC-A'),
    ('EMP082', 'Juma',      'Al-Hamdani',     'male',   'OM', 'SEC',   'SGD',  '2019-01-20', 'W2', 'SEC-A'),
    ('EMP083', 'Sanjay',    'Gurung',         'male',   'NP', 'SEC',   'SGD',  '2021-05-30', 'W2', 'SEC-A'),
    ('EMP084', 'Khamis',    'Al-Mukhaini',    'male',   'OM', 'SEC',   'SGD',  '2020-11-01', 'W2', 'SEC-B'),
    ('EMP085', 'Bikash',    'Tamang',         'male',   'NP', 'SEC',   'SGD',  '2022-01-23', 'W2', 'SEC-B'),
    ('EMP086', 'Said',      'Al-Habsi',       'male',   'OM', 'SEC',   'SGD',  '2023-07-16', 'W2', 'SEC-B'),
    ('EMP087', 'Abdullah',  'Al-Kiyumi',      'male',   'OM', 'SEC',   'SGD',  '2018-08-05', 'W2', 'SEC-C'),
    ('EMP088', 'Rohan',     'Thapa',          'male',   'NP', 'SEC',   'SGD',  '2024-03-03', 'W1', 'SEC-C'),
    ('EMP089', 'Hamdan',    'Al-Mahrouqi',    'male',   'OM', 'SEC',   'SGD',  '2021-12-12', 'W2', 'SEC-D'),
    ('EMP090', 'Dilip',     'Shrestha',       'male',   'NP', 'SEC',   'SGD',  '2023-10-08', 'W1', 'SEC-D'),
    ('EMP091', 'Waleed',    'Al-Kindi',       'male',   'OM', 'MNT',   'MENG', '2018-02-18', 'M1', null),
    ('EMP092', 'Santosh',   'Kumar',          'male',   'IN', 'MNT',   'ELEC', '2019-07-07', 'W2', null),
    ('EMP093', 'Hussain',   'Al-Lawati',      'male',   'OM', 'MNT',   'ELEC', '2022-04-24', 'W2', null),
    ('EMP094', 'Gopal',     'Krishnan',       'male',   'IN', 'MNT',   'MECH', '2020-08-30', 'W2', null),
    ('EMP095', 'Tariq',     'Mehmood',        'male',   'PK', 'MNT',   'MECH', '2021-10-31', 'W2', null),
    ('EMP096', 'Rashid',    'Al-Balushi',     'male',   'OM', 'MNT',   'TECH', '2023-12-10', 'W1', null),
    ('EMP097', 'Anil',      'Joseph',         'male',   'IN', 'MNT',   'TECH', '2022-06-19', 'W1', null),
    ('EMP098', 'Majid',     'Al-Saadi',       'male',   'OM', 'MNT',   'TECH', '2024-08-18', 'W1', null),
    ('EMP099', 'Emmanuel',  'Garcia',         'male',   'PH', 'MNT',   'HVAC', '2021-01-31', 'W2', null),
    ('EMP100', 'Sabir',     'Ali',            'male',   'PK', 'MNT',   'PLMB', '2025-06-01', 'W1', null)
  ) as v(num, first, last, gender, nat, dept, desig, joining, grade, crew)
  on conflict (organization_id, employee_number) do update set first_name = excluded.first_name, last_name = excluded.last_name, display_name = excluded.display_name, gender = excluded.gender,
    nationality_code = excluded.nationality_code, joining_date = excluded.joining_date, employment_status = 'active', branch_id = excluded.branch_id, department_id = excluded.department_id,
    designation_id = excluded.designation_id, device_user_id = excluded.device_user_id, card_number = excluded.card_number, weekly_off_days = excluded.weekly_off_days,
    custom_fields = excluded.custom_fields, updated_by = hr_id, updated_at = now(), deleted_at = null;

  ---------------------------------------------------------------------------------------------------------------------
  -- Reporting lines: every department head reports to the Managing Director (TEST011), everyone else to their head
  ---------------------------------------------------------------------------------------------------------------------
  update public.departments d set manager_employee_id = e.id, updated_at = now()
  from (values ('MGMT', 'TEST011'), ('HR', 'TEST002'), ('FIN', 'TEST006'), ('IT', '001'), ('SALES', 'TEST003'), ('CS', 'TEST010'), ('OPS', 'TEST015'),
               ('WH', 'EMP071'), ('SEC', 'EMP081'), ('MNT', 'EMP091')) as h(code, num)
  join public.employees e on e.organization_id = org and e.employee_number = h.num and e.deleted_at is null
  where d.organization_id = org and d.code = h.code;

  update public.employees set manager_employee_id = null, updated_at = now() where organization_id = org and employee_number = 'TEST011';
  update public.employees e set manager_employee_id = case when e.id = d.manager_employee_id then (select x.id from public.employees x where x.organization_id = org and x.employee_number = 'TEST011')
                                                           else d.manager_employee_id end, updated_at = now()
  from public.departments d
  where e.organization_id = org and e.deleted_at is null and e.employee_number <> 'TEST011' and d.id = e.department_id and d.organization_id = org;

  -- the old single "owner" department is empty now
  update public.departments set status = 'inactive', updated_at = now()
  where id = old_dept and not exists (select 1 from public.employees e where e.department_id = old_dept and e.deleted_at is null);

  ---------------------------------------------------------------------------------------------------------------------
  -- Employment history: the existing rows get the department / designation / manager; the TEST employees (joined 1 Sep,
  -- history from 2 Oct) get their first month; the new employees one placement row from their joining date.
  ---------------------------------------------------------------------------------------------------------------------
  update public.employment_history h set department_id = e.department_id, designation_id = e.designation_id, manager_employee_id = e.manager_employee_id
  from public.employees e
  where h.organization_id = org and e.id = h.employee_id and e.deleted_at is null and h.employment_status = 'active';

  insert into public.employment_history (id, organization_id, employee_id, effective_from, effective_to, branch_id, department_id, designation_id, manager_employee_id, employment_type, employment_status, reason, created_by)
  select pg_temp.sid('hist:' || e.employee_number || ':first-month'), org, e.id, e.joining_date, (select min(h.effective_from) from public.employment_history h where h.employee_id = e.id),
         e.branch_id, e.department_id, e.designation_id, e.manager_employee_id, e.employment_type, 'active', 'Joined', hr_id
  from public.employees e
  where e.organization_id = org and e.deleted_at is null and e.employee_number like 'TEST%'
    and (select min(h.effective_from) from public.employment_history h where h.employee_id = e.id) > e.joining_date
  on conflict (id) do nothing;

  insert into public.employment_history (id, organization_id, employee_id, effective_from, effective_to, branch_id, department_id, designation_id, manager_employee_id, employment_type, employment_status, reason, created_by)
  select pg_temp.sid('hist:' || e.employee_number || ':join'), org, e.id, e.joining_date, null, e.branch_id, e.department_id, e.designation_id, e.manager_employee_id, e.employment_type, 'active', 'Joined', hr_id
  from public.employees e
  where e.organization_id = org and e.employee_number like 'EMP%'
  on conflict (id) do update set branch_id = excluded.branch_id, department_id = excluded.department_id, designation_id = excluded.designation_id, manager_employee_id = excluded.manager_employee_id, employment_type = excluded.employment_type;

  ---------------------------------------------------------------------------------------------------------------------
  -- Terminal enrolment: Ghala staff on the staff entrance, Sohar staff on the plant gate, warehouse crews also on the dock.
  -- (The real terminal "james" keeps its own enrolment rows.) Provider identity = the device user id, like the terminal.
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.device_employee_states (id, organization_id, device_id, employee_id, branch_id, device_user_id, cloud_hash, device_hash, sync_status, desired, last_sync_at, last_success_at, fingerprint_count, face_enrolled, card_enrolled)
  select pg_temp.sid('des:' || dv.code || ':' || e.employee_number), org, dv.id, e.id, dv.branch_id, e.device_user_id,
         'sha1:' || left(md5(e.employee_number || ':cloud'), 16), 'sha1:' || left(md5(e.employee_number || ':cloud'), 16), 'IN_SYNC', true,
         now() - (floor(pg_temp.u(e.employee_number || dv.code || ':sync') * 30)::int || ' hours')::interval, now() - (floor(pg_temp.u(e.employee_number || dv.code || ':sync') * 30)::int || ' hours')::interval,
         case when e.fingerprint_enrolled then 1 + (pg_temp.u(e.employee_number || ':fp2') < 0.5)::int else 0 end, true, e.card_number is not null
  from public.devices dv
  join public.employees e on e.organization_id = dv.organization_id and e.deleted_at is null and e.branch_id = dv.branch_id
  where dv.organization_id = org and dv.code in ('GHL-02', 'SOH-01', 'SOH-02')
    and (dv.code <> 'SOH-02' or e.department_id = pg_temp.sid('dept:WH'))
  on conflict (device_id, device_user_id) do update set employee_id = excluded.employee_id, sync_status = excluded.sync_status, desired = true, updated_at = now();

  insert into public.employee_provider_identities (id, organization_id, employee_id, provider_key, device_user_id, card_number)
  select pg_temp.sid('epi:' || e.employee_number), org, e.id, 'hikvision_push', e.device_user_id, e.card_number
  from public.employees e where e.organization_id = org and e.deleted_at is null
  on conflict (organization_id, employee_id, provider_key) do update set device_user_id = excluded.device_user_id, card_number = excluded.card_number, updated_at = now();

  ---------------------------------------------------------------------------------------------------------------------
  -- premreddy1311@gmail.com: Line Manager (portal + manager workspace + first approver of the IT team)
  ---------------------------------------------------------------------------------------------------------------------
  update public.org_memberships set role_id = '10000000-0000-0000-0000-000000000009', updated_at = now()
  where organization_id = org and user_id = kumar_user and role_id = '10000000-0000-0000-0000-000000000008';
end $$;

select 'structure_people' as step,
  (select count(*) from public.branches where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0') as branches,
  (select count(*) from public.departments where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0' and status = 'active') as departments,
  (select count(*) from public.employees where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0' and deleted_at is null and employment_status = 'active') as active_employees,
  (select string_agg(d.code || '=' || n, ' ' order by d.code) from (select department_id, count(*) n from public.employees where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0' and deleted_at is null group by 1) x
     join public.departments d on d.id = x.department_id) as per_department,
  (select count(*) from public.devices where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0') as devices,
  (select count(*) from public.employment_history where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0') as history_rows;
