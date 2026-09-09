-- FlowZa Time · demo tenant seed · Majan Gulf Trading & Contracting LLC (Oman) · step 1/5: organisation structure
--
-- Target: the tenant that owns acme@flowza.ai (organisation 27bfe270-5dea-4587-aec3-0f5c23113261).
-- Idempotent: every row has a deterministic id (uuid v5 in the tenant's namespace) and is upserted on its natural key,
-- so re-running only refreshes values. Runs on an admin connection (psql "$DATABASE_URL_ADMIN" -v ON_ERROR_STOP=1 -f …)
-- or through the Supabase SQL editor; see README.md in this folder.
set client_min_messages = warning;

create or replace function pg_temp.sid(p text) returns uuid language sql immutable as
$$ select extensions.uuid_generate_v5('27bfe270-5dea-4587-aec3-0f5c23113261'::uuid, p) $$;

do $$
declare
  org uuid := '27bfe270-5dea-4587-aec3-0f5c23113261';
  owner_id uuid := '82f009ce-9248-4550-b030-896746ef2e73';
  attadmin_id uuid := pg_temp.sid('user:attadmin@flowza.ai');
  cal uuid := pg_temp.sid('holiday-calendar:default');
  zk_caps jsonb := (select capabilities from public.device_providers where key = 'zkteco_push');
  zk_model uuid := (select id from public.device_models where provider_key = 'zkteco_push' order by model limit 1);
  t0 timestamptz := '2026-02-16 09:00:00+04';
begin
  ---------------------------------------------------------------------------------------------------------------------
  -- Organisation profile, settings, subscription, feature flags
  ---------------------------------------------------------------------------------------------------------------------
  update public.organizations set
    company_code = 'MAJAN',
    legal_name = 'Majan Gulf Trading & Contracting LLC',
    display_name = 'Majan Gulf',
    country_code = 'OM', timezone = 'Asia/Muscat', currency_code = 'OMR', locale = 'en',
    weekly_off_days = '{5,6}'::smallint[],
    contact = jsonb_build_object('name', 'Hamad Al Busaidi', 'email', 'info@majangulf.om', 'phone', '+968 2460 1234', 'website', 'https://www.majangulf.om'),
    address = jsonb_build_object('line1', 'Building 214, Way 3305, Al Khuwair 33', 'line2', 'P.O. Box 1180', 'city', 'Muscat', 'region', 'Muscat Governorate', 'postalCode', '133', 'country', 'OM'),
    status = 'active',
    security_contact_email = 'it.security@majangulf.om',
    updated_at = now()
  where id = org;

  update public.organization_settings set
    general = jsonb_build_object('dateFormat', 'DD/MM/YYYY', 'timeFormat', '12h', 'firstDayOfWeek', 0, 'calendar', 'hijri_secondary'),
    attendance = jsonb_build_object('defaultShiftId', pg_temp.sid('shift:OFFICE'), 'processingDelaySeconds', 30, 'payrollPeriod', 'calendar_month', 'payrollCutoffDay', 25, 'allowSelfServiceCorrections', true),
    sync = jsonb_build_object('defaultIntervalMinutes', 5, 'adaptivePolling', true, 'offlineThresholdMinutes', 30, 'autoPushNewEmployees', true, 'reconciliationIntervalHours', 24, 'maxIntervalMinutes', 60, 'maxClockSkewMinutes', 60),
    notifications = jsonb_build_object('deviceOffline', true, 'syncFailed', true, 'approvalPending', true, 'reportReady', true, 'dailyDigest', true),
    security = jsonb_build_object('mfaRequired', false, 'sessionIdleMinutes', 480, 'allowedEmailDomains', jsonb_build_array(), 'exportRequiresReason', false),
    reports = jsonb_build_object('hoursNotation', 'h.mm', 'codeOverrides', jsonb_build_object(), 'defaultFormat', 'pdf', 'showLegend', true),
    updated_by = owner_id, updated_at = now()
  where organization_id = org;

  update public.subscriptions set
    plan_id = (select id from public.plans where key = 'business'), status = 'active', trial_ends_at = null,
    current_period_start = '2026-03-01 00:00:00+04', current_period_end = '2027-03-01 00:00:00+04', cancel_at = null,
    external_customer_ref = 'cus_majan_gulf_2026', external_subscription_ref = 'sub_majan_business_annual', updated_at = now()
  where organization_id = org;

  insert into public.organization_feature_flags (organization_id, flag_key, enabled, updated_by)
  values (org, 'advanced_reports', true, owner_id), (org, 'employee_self_service', true, owner_id), (org, 'payroll_export', true, owner_id), (org, 'provider_zkteco_push', true, owner_id)
  on conflict (organization_id, flag_key) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now();

  ---------------------------------------------------------------------------------------------------------------------
  -- Holiday calendar (Oman public holidays; moon-sighting dates tentative) — created before branches so they can link to it
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.holiday_calendars (id, organization_id, name, country_code, is_default, created_at)
  values (cal, org, 'Oman Public Holidays', 'OM', true, t0)
  on conflict (id) do update set name = excluded.name, country_code = excluded.country_code, is_default = true;

  insert into public.holidays (id, organization_id, calendar_id, name, name_ar, date, end_date, is_half_day, type, branch_ids, is_tentative, created_at)
  select pg_temp.sid('holiday:' || h.name || ':' || h.d), org, cal, h.name, h.name_ar, h.d::date, h.e::date, false, h.t::public.holiday_type,
         case when h.branch is null then null else array[pg_temp.sid('branch:' || h.branch)] end, h.tent, t0
  from (values
    ('New Year''s Day',            'رأس السنة الميلادية',         '2026-01-01', null,         'PUBLIC',    false, null),
    ('Accession Day',              'يوم التولي',                    '2026-01-11', null,         'PUBLIC',    false, null),
    ('Isra and Mi''raj',           'الإسراء والمعراج',              '2026-01-16', null,         'RELIGIOUS', true,  null),
    ('Eid al-Fitr',                'عيد الفطر',                     '2026-03-19', '2026-03-23', 'RELIGIOUS', true,  null),
    ('Company Foundation Day',     'يوم تأسيس الشركة',              '2026-04-15', null,         'COMPANY',   false, null),
    ('Eid al-Adha',                'عيد الأضحى',                    '2026-05-26', '2026-05-29', 'RELIGIOUS', true,  null),
    ('Islamic New Year',           'رأس السنة الهجرية',             '2026-06-16', null,         'RELIGIOUS', true,  null),
    ('Duqm site maintenance shutdown', 'إغلاق موقع الدقم للصيانة',  '2026-07-02', null,         'COMPANY',   false, 'DQM'),
    ('Prophet''s Birthday',        'المولد النبوي الشريف',          '2026-08-25', null,         'RELIGIOUS', true,  null),
    ('National Day',               'العيد الوطني',                  '2026-11-18', '2026-11-19', 'PUBLIC',    false, null)
  ) as h(name, name_ar, d, e, t, tent, branch)
  on conflict (id) do update set name = excluded.name, name_ar = excluded.name_ar, date = excluded.date, end_date = excluded.end_date, type = excluded.type, branch_ids = excluded.branch_ids, is_tentative = excluded.is_tentative;

  ---------------------------------------------------------------------------------------------------------------------
  -- Head office + five branches
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.branches (id, organization_id, code, name, name_ar, country_code, city, address, timezone, latitude, longitude, geofence_radius_m, contact, weekly_off_days, holiday_calendar_id, status, created_at)
  select pg_temp.sid('branch:' || b.code), org, b.code, b.name, b.name_ar, 'OM', b.city,
         jsonb_build_object('line1', b.line1, 'line2', b.line2, 'city', b.city, 'region', b.region, 'postalCode', b.pc, 'country', 'OM'),
         'Asia/Muscat', b.lat, b.lng, b.radius,
         jsonb_build_object('name', b.cname, 'email', b.cemail, 'phone', b.cphone) || case when b.code = 'MCT-HQ' then jsonb_build_object('website', 'https://www.majangulf.om') else '{}'::jsonb end,
         b.woff::smallint[], cal, 'active', t0
  from (values
    ('MCT-HQ', 'Head Office – Muscat',      'المكتب الرئيسي – مسقط',  'Muscat',  'Building 214, Way 3305, Al Khuwair 33',                'P.O. Box 1180', 'Muscat Governorate',              '133', 23.5967, 58.4290, 200, 'Said Khalfan Al Amri',   'hq@majangulf.om',      '+968 2460 1234', '{5,6}'),
    ('SOH',    'Sohar Industrial Branch',   'فرع صحار الصناعية',      'Sohar',   'Plot 47, Sohar Industrial Estate, Phase 3',            'P.O. Box 522',  'North Al Batinah Governorate',    '311', 24.3618, 56.7245, 300, 'Said Ahmed Al Rawahi',   'sohar@majangulf.om',   '+968 2685 3320', '{5,6}'),
    ('SLL',    'Salalah Branch',            'فرع صلالة',              'Salalah', 'Office 12, Al Saada Commercial Complex, 23 July Street', 'P.O. Box 908',  'Dhofar Governorate',              '211', 17.0194, 54.0897, 200, 'Hilal Saeed Al Mashani', 'salalah@majangulf.om', '+968 2329 4410', '{5,6}'),
    ('NZW',    'Nizwa Branch',              'فرع نزوى',               'Nizwa',   'Shop 6, Firq Roundabout Complex',                       'P.O. Box 233',  'Ad Dakhiliyah Governorate',       '611', 22.9206, 57.5310, 150, 'Sultan Hamed Al Riyami', 'nizwa@majangulf.om',   '+968 2541 1875', '{5,6}'),
    ('SUR',    'Sur Branch',                'فرع صور',                'Sur',     'Building 88, Al Sharia Street',                         'P.O. Box 141',  'South Ash Sharqiyah Governorate', '411', 22.5745, 59.5286, 150, 'Majid Rashid Al Araimi', 'sur@majangulf.om',     '+968 2554 2266', '{5,6}'),
    ('DQM',    'Duqm Site Office',          'مكتب موقع الدقم',        'Duqm',    'Site Compound B-4, Special Economic Zone at Duqm',      'P.O. Box 66',   'Al Wusta Governorate',            '700', 19.6748, 57.7065, 500, 'Ali Hamdan Al Junaibi',  'duqm@majangulf.om',    '+968 2521 7730', '{5}')
  ) as b(code, name, name_ar, city, line1, line2, region, pc, lat, lng, radius, cname, cemail, cphone, woff)
  on conflict (organization_id, code) do update set name = excluded.name, name_ar = excluded.name_ar, city = excluded.city, address = excluded.address, latitude = excluded.latitude, longitude = excluded.longitude,
    geofence_radius_m = excluded.geofence_radius_m, contact = excluded.contact, weekly_off_days = excluded.weekly_off_days, holiday_calendar_id = excluded.holiday_calendar_id, status = 'active', updated_at = now();

  ---------------------------------------------------------------------------------------------------------------------
  -- Departments (hierarchy) and designations. Managers are linked in step 2 once employees exist.
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.departments (id, organization_id, branch_id, parent_id, code, name, name_ar, status, created_at)
  select pg_temp.sid('dept:' || d.code), org, null, case when d.parent is null then null else pg_temp.sid('dept:' || d.parent) end, d.code, d.name, d.name_ar, 'active', t0
  from (values
    ('MGMT',  'Management',              'الإدارة العليا',        null),
    ('HR',    'Human Resources',         'الموارد البشرية',       'MGMT'),
    ('FIN',   'Finance & Accounts',      'المالية والحسابات',     'MGMT'),
    ('PAY',   'Payroll',                 'الرواتب',               'FIN'),
    ('IT',    'Information Technology',  'تقنية المعلومات',       'MGMT'),
    ('ADM',   'Administration',          'الشؤون الإدارية',       'MGMT'),
    ('OPS',   'Operations',              'العمليات',              'MGMT'),
    ('SALES', 'Sales',                   'المبيعات',              'MGMT'),
    ('BD',    'Business Development',    'تطوير الأعمال',         'SALES'),
    ('CS',    'Customer Support',        'خدمة العملاء',          'OPS')
  ) as d(code, name, name_ar, parent)
  on conflict (organization_id, code) do update set parent_id = excluded.parent_id, name = excluded.name, name_ar = excluded.name_ar, status = 'active', updated_at = now();

  insert into public.designations (id, organization_id, code, name, name_ar, level, status, created_at)
  select pg_temp.sid('desig:' || g.code), org, g.code, g.name, g.name_ar, g.lvl, 'active', t0
  from (values
    ('MD',   'Managing Director',               'العضو المنتدب',                 10),
    ('GM',   'General Manager',                 'المدير العام',                  9),
    ('HRM',  'HR Manager',                      'مدير الموارد البشرية',          7),
    ('FM',   'Finance Manager',                 'مدير المالية',                  7),
    ('ITM',  'IT Manager',                      'مدير تقنية المعلومات',          7),
    ('ADMM', 'Administration Manager',          'مدير الشؤون الإدارية',          7),
    ('OPM',  'Operations Manager',              'مدير العمليات',                 7),
    ('SM',   'Sales Manager',                   'مدير المبيعات',                 7),
    ('BM',   'Branch Manager',                  'مدير فرع',                      6),
    ('TL',   'Team Lead',                       'قائد فريق',                     5),
    ('SSE',  'Senior Software Engineer',        'مهندس برمجيات أول',             5),
    ('SACC', 'Senior Accountant',               'محاسب أول',                     5),
    ('SUP',  'Site Supervisor',                 'مشرف موقع',                     5),
    ('HRE',  'HR Executive',                    'تنفيذي موارد بشرية',            4),
    ('PAYS', 'Payroll Specialist',              'أخصائي رواتب',                  4),
    ('ACC',  'Accountant',                      'محاسب',                         4),
    ('SE',   'Software Engineer',               'مهندس برمجيات',                 4),
    ('ITSE', 'IT Support Engineer',             'مهندس دعم تقني',                4),
    ('ATTA', 'Attendance Administrator',        'مسؤول الحضور والانصراف',        4),
    ('BDE',  'Business Development Executive',  'تنفيذي تطوير أعمال',            4),
    ('SEX',  'Sales Executive',                 'تنفيذي مبيعات',                 3),
    ('CSE',  'Customer Support Executive',      'تنفيذي خدمة عملاء',             3),
    ('TECH', 'Technician',                      'فني',                           3),
    ('STK',  'Storekeeper',                     'أمين مخزن',                     3),
    ('AA',   'Administrative Assistant',        'مساعد إداري',                   2),
    ('OA',   'Office Assistant',                'مساعد مكتب',                    1),
    ('DRV',  'Driver',                          'سائق',                          1)
  ) as g(code, name, name_ar, lvl)
  on conflict (organization_id, code) do update set name = excluded.name, name_ar = excluded.name_ar, level = excluded.level, status = 'active', updated_at = now();

  ---------------------------------------------------------------------------------------------------------------------
  -- Shifts, attendance rules (incl. Ramadan hours for Muslim staff), assignments
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.shifts (id, organization_id, code, name, name_ar, type, start_time, end_time, required_minutes, core_start, core_end, day_boundary, breaks, punch_in_window_before_minutes, punch_out_window_after_minutes, grace_in_minutes, grace_out_minutes, color, status, created_at)
  values
    (pg_temp.sid('shift:OFFICE'), org, 'OFFICE', 'Office Hours 08:00–17:00',          'الدوام المكتبي',  'FIXED',    '08:00', '17:00', null, null,    null,    '04:00', '[{"start":"13:00","end":"14:00","paid":false}]'::jsonb, 240, 360, null, null, '#175cd3', 'active', t0),
    (pg_temp.sid('shift:SITE'),   org, 'SITE',   'Site Hours 07:00–16:00',            'دوام الموقع',     'FIXED',    '07:00', '16:00', null, null,    null,    '04:00', '[{"start":"12:00","end":"12:30","paid":false}]'::jsonb, 240, 360, 15,   5,    '#b54708', 'active', t0),
    (pg_temp.sid('shift:FLEX'),   org, 'FLEX',   'Flexible 8h (core 10:00–15:00)',    'دوام مرن',        'FLEXIBLE', null,    null,    480,  '10:00', '15:00', '04:00', '[{"minutes":45,"paid":false}]'::jsonb,                 240, 360, null, null, '#7a2e9d', 'active', t0)
  on conflict (organization_id, code) do update set name = excluded.name, name_ar = excluded.name_ar, type = excluded.type, start_time = excluded.start_time, end_time = excluded.end_time, required_minutes = excluded.required_minutes,
    core_start = excluded.core_start, core_end = excluded.core_end, breaks = excluded.breaks, grace_in_minutes = excluded.grace_in_minutes, grace_out_minutes = excluded.grace_out_minutes, color = excluded.color, status = 'active', updated_at = now();

  insert into public.attendance_rule_sets (id, organization_id, branch_id, name, effective_from, grace_in_minutes, grace_out_minutes, late_threshold_minutes, early_departure_threshold_minutes, min_full_day_minutes, half_day_threshold_minutes,
    overtime_enabled, overtime_start_after_minutes, overtime_min_block_minutes, overtime_rounding_minutes, overtime_max_minutes_per_day, count_early_in_as_overtime, punch_rounding_minutes, punch_rounding_mode, worked_rounding_minutes, worked_rounding_mode,
    punch_interpretation, duplicate_punch_window_seconds, missing_punch_behavior, auto_absent_without_punches, weekly_off_work_counts_as_overtime, holiday_work_counts_as_overtime, ramadan_mode, created_by, created_at)
  values
    (pg_temp.sid('rules:company'), org, null, 'Company standard', '2025-01-01', 10, 5, 0, 0, 420, 240, true, 30, 30, 15, 240, false, 0, 'NONE', 0, 'NONE', 'FIRST_LAST', 60, 'FLAG_ONLY', true, true, true,
      jsonb_build_object('enabled', true, 'from', '2026-02-18', 'to', '2026-03-19', 'scheduledMinutes', 360, 'appliesTo', 'flagged_employees'), owner_id, t0),
    (pg_temp.sid('rules:duqm'), org, pg_temp.sid('branch:DQM'), 'Duqm site rules', '2025-01-01', 15, 5, 0, 0, 480, 240, true, 15, 30, 15, 300, true, 0, 'NONE', 0, 'NONE', 'FIRST_LAST', 60, 'ASSUME_SHIFT_END', true, true, true,
      jsonb_build_object('enabled', true, 'from', '2026-02-18', 'to', '2026-03-19', 'scheduledMinutes', 360, 'appliesTo', 'flagged_employees'), owner_id, t0)
  on conflict (id) do update set name = excluded.name, grace_in_minutes = excluded.grace_in_minutes, grace_out_minutes = excluded.grace_out_minutes, min_full_day_minutes = excluded.min_full_day_minutes,
    overtime_start_after_minutes = excluded.overtime_start_after_minutes, overtime_max_minutes_per_day = excluded.overtime_max_minutes_per_day, count_early_in_as_overtime = excluded.count_early_in_as_overtime,
    missing_punch_behavior = excluded.missing_punch_behavior, ramadan_mode = excluded.ramadan_mode, updated_at = now();

  -- Organisation default → OFFICE; the Duqm site works 07:00–16:00 six days a week. Team and employee assignments follow in step 2.
  insert into public.shift_assignments (id, organization_id, target_type, target_id, branch_id, shift_id, shift_pattern_id, effective_from, effective_to, created_by, created_at)
  values
    (pg_temp.sid('assign:org'),        org, 'ORGANIZATION', org,                       null,                     pg_temp.sid('shift:OFFICE'), null, '2018-01-01', null, owner_id, t0),
    (pg_temp.sid('assign:branch:DQM'), org, 'BRANCH',       pg_temp.sid('branch:DQM'), pg_temp.sid('branch:DQM'), pg_temp.sid('shift:SITE'),  null, '2021-01-01', null, owner_id, t0)
  on conflict (id) do update set shift_id = excluded.shift_id, effective_from = excluded.effective_from, effective_to = excluded.effective_to;

  ---------------------------------------------------------------------------------------------------------------------
  -- Leave types: the product defaults plus two Oman-specific types
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.leave_types (id, organization_id, code, name, name_ar, is_paid, treat_as_present, color, status, created_at)
  select pg_temp.sid('leave-type:' || l.code), org, l.code, l.name, l.name_ar, l.paid, l.present, l.color, 'active', t0
  from (values
    ('AL',  'Annual Leave',     'إجازة سنوية',          true,  false, '#175cd3'),
    ('CL',  'Casual Leave',     'إجازة عرضية',          true,  false, '#0e7490'),
    ('SL',  'Sick Leave',       'إجازة مرضية',          true,  false, '#b54708'),
    ('EL',  'Emergency Leave',  'إجازة طارئة',          true,  false, '#b42318'),
    ('SPL', 'Special Leave',    'إجازة خاصة',           true,  false, '#7a2e9d'),
    ('ML',  'Maternity Leave',  'إجازة أمومة',          true,  false, '#c11574'),
    ('NP',  'No Pay Leave',     'إجازة بدون راتب',      false, false, '#475467'),
    ('SD',  'Site Duty',        'مهمة عمل خارجية',      true,  true,  '#0f6e56'),
    ('HJ',  'Hajj Leave',       'إجازة الحج',           true,  false, '#4d7c0f'),
    ('PTL', 'Paternity Leave',  'إجازة أبوة',           true,  false, '#0891b2')
  ) as l(code, name, name_ar, paid, present, color)
  on conflict (organization_id, code) do update set name = excluded.name, name_ar = excluded.name_ar, is_paid = excluded.is_paid, treat_as_present = excluded.treat_as_present, color = excluded.color, status = 'active';

  ---------------------------------------------------------------------------------------------------------------------
  -- Devices: ZKTeco PUSH terminals — two at head office, one per branch. Nizwa is offline (no heartbeat since yesterday).
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.devices (id, organization_id, branch_id, code, name, provider_key, model_id, manufacturer, model_name, serial_number, vendor_device_id, timezone, integration_type, endpoint_url, config, capabilities,
    status, connection_status, last_heartbeat_at, last_attendance_sync_at, last_employee_sync_at, last_successful_communication_at, last_error_code, last_error, last_error_at, firmware_version, device_time_offset_seconds,
    offline_threshold_minutes, auto_sync_enabled, sync_interval_minutes, push_token_hash, push_token_rotated_at, tags, notes, created_by, created_at)
  select pg_temp.sid('device:' || d.code), org, pg_temp.sid('branch:' || d.branch), d.code, d.name, 'zkteco_push', zk_model, 'ZKTeco', d.model, d.serial, d.serial, 'Asia/Muscat', 'DEVICE_PUSH', null,
         jsonb_build_object('serialNumber', d.serial, 'pushInterval', 30), zk_caps,
         'active', case when d.offline then 'offline' else 'online' end::public.connection_status,
         case when d.offline then now() - interval '26 hours' else now() - (d.hb || ' minutes')::interval end,
         case when d.offline then now() - interval '26 hours' else (((current_date - 1) + time '19:40') at time zone 'Asia/Muscat') end,
         now() - interval '3 days', case when d.offline then now() - interval '26 hours' else now() - (d.hb || ' minutes')::interval end,
         case when d.offline then 'DEVICE_OFFLINE' end, case when d.offline then 'no heartbeat for more than 30 min' end, case when d.offline then now() - interval '25 hours 30 minutes' end,
         d.fw, d.hb - 3, 30, false, 5, encode(extensions.digest('majan-push:' || d.code, 'sha256'), 'hex'), t0, d.tags::text[], d.notes, attadmin_id, t0
  from (values
    ('MCT-HQ-D01', 'MCT-HQ', 'HQ Main Entrance',              'SpeedFace-V5L', 'CJDE224760012', 'Ver 8.0.4.2-20250312', 2,  false, '{hq,entrance,face}',   'Main lobby, ground floor. Face + fingerprint. Installed 16 Feb 2026 by Al Madina Security Systems; comm key held by IT.'),
    ('MCT-HQ-D02', 'MCT-HQ', 'HQ Staff Entrance (Basement)',  'uFace 800',     'AEKW192260345', 'Ver 6.60 Jun 12 2024',  4,  false, '{hq,basement,staff}',  'Basement car-park entrance used by staff arriving by car. Fingerprint + card.'),
    ('SOH-D01',    'SOH',    'Sohar Gate Terminal',           'F22',           'BRHF201560771', 'Ver 6.60 Jun 12 2024',  1,  false, '{branch,gate}',        'Gatehouse at the industrial estate plot; shared by office and warehouse staff.'),
    ('SLL-D01',    'SLL',    'Salalah Office Terminal',       'K40',           'AEJZ214760118', 'Ver 6.60 Jun 12 2024',  3,  false, '{branch,office}',      'Reception wall mount. Fingerprint + card.'),
    ('NZW-D01',    'NZW',    'Nizwa Branch Terminal',         'F18',           'CGFE203260406', 'Ver 6.60 Jun 12 2024',  5,  true,  '{branch,office}',      'Reception. Router replaced 7 Sep 2026 — awaiting the ADMS server address to be re-entered on the device.'),
    ('SUR-D01',    'SUR',    'Sur Branch Terminal',           'MB460',         'AGCJ222460219', 'Ver 8.0.4.2-20250312', 2,  false, '{branch,office,face}', 'Face-capable terminal at the branch entrance.'),
    ('DQM-D01',    'DQM',    'Duqm Site Gate',                'SpeedFace-V4L', 'CKXH231960833', 'Ver 8.0.4.2-20250312', 3,  false, '{site,gate,outdoor}',  'Outdoor housing at the site compound gate; 4G router uplink.')
  ) as d(code, branch, name, model, serial, fw, hb, offline, tags, notes)
  on conflict (organization_id, code) do update set branch_id = excluded.branch_id, name = excluded.name, model_id = excluded.model_id, model_name = excluded.model_name, serial_number = excluded.serial_number, vendor_device_id = excluded.vendor_device_id,
    config = excluded.config, capabilities = excluded.capabilities, status = 'active', connection_status = excluded.connection_status, last_heartbeat_at = excluded.last_heartbeat_at, last_attendance_sync_at = excluded.last_attendance_sync_at,
    last_employee_sync_at = excluded.last_employee_sync_at, last_successful_communication_at = excluded.last_successful_communication_at, last_error_code = excluded.last_error_code, last_error = excluded.last_error, last_error_at = excluded.last_error_at,
    firmware_version = excluded.firmware_version, offline_threshold_minutes = excluded.offline_threshold_minutes, auto_sync_enabled = excluded.auto_sync_enabled, tags = excluded.tags, notes = excluded.notes, updated_at = now();

  insert into public.device_groups (id, organization_id, branch_id, name, description, color, created_at)
  values (pg_temp.sid('device-group:entrances'), org, null, 'Main Entrances', 'Primary entrance terminals at every location — the first place a new employee is enrolled.', '#2563eb', t0)
  on conflict (organization_id, name) do update set description = excluded.description, color = excluded.color, updated_at = now();

  insert into public.device_group_members (group_id, device_id, organization_id)
  select pg_temp.sid('device-group:entrances'), pg_temp.sid('device:' || c), org from unnest(array['MCT-HQ-D01', 'SOH-D01', 'SLL-D01', 'NZW-D01', 'SUR-D01', 'DQM-D01']) as c
  on conflict do nothing;

  ---------------------------------------------------------------------------------------------------------------------
  -- Data retention (business plan keeps raw punches three years)
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.data_retention_policies (id, organization_id, data_class, retention_days, enabled, updated_by)
  values (pg_temp.sid('retention:raw_transactions'), org, 'raw_transactions', 1095, true, owner_id),
         (pg_temp.sid('retention:device_logs'), org, 'device_logs', 90, true, owner_id),
         (pg_temp.sid('retention:sync_logs'), org, 'sync_logs', 90, true, owner_id)
  on conflict (id) do update set retention_days = excluded.retention_days, enabled = excluded.enabled, updated_at = now();
end $$;

select 'structure' as step,
  (select count(*) from public.branches where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261') as branches,
  (select count(*) from public.departments where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261') as departments,
  (select count(*) from public.designations where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261') as designations,
  (select count(*) from public.devices where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261') as devices,
  (select count(*) from public.holidays where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261') as holidays,
  (select count(*) from public.leave_types where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261') as leave_types,
  (select count(*) from public.shifts where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261') as shifts;
