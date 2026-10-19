-- FlowZa Time · RIA test tenant seed · step 1/3: the tenant, Enterprise plan, every feature on
--
-- Creates the test organisation "Research and Innovation Authority" (company code RIA, id 1fa2602c-06d4-4341-86ba-2bc971d83563)
-- the way /adm → New tenant does (organisation, settings row, default leave types, Head Office branch, subscription), then:
--   · Enterprise subscription, active, yearly, no seat cap (the plan's own limit applies): every module of the catalogue is on
--     the Enterprise plan, so no module overrides are written;
--   · every feature flag switched on for the tenant except `biometric_template_sync` (gated on a legal review; one toggle in
--     /adm → Tenant → Feature flags), including the placeholder vendor providers (they answer NOT_IMPLEMENTED, never fake success);
--   · self-service web / mobile / selfie check-in, regularisation and self-service corrections on, Oman holidays 2026, a
--     geofence around the Head Office, leave allowances.
-- Idempotent (uuid v5 ids in the tenant namespace, upserts); runs on the admin connection (see README.md in this folder).
set client_min_messages = warning;

create or replace function pg_temp.sid(p text) returns uuid language sql immutable as
$$ select extensions.uuid_generate_v5('1fa2602c-06d4-4341-86ba-2bc971d83563'::uuid, 'ria:' || p) $$;

do $$
declare
  org uuid := '1fa2602c-06d4-4341-86ba-2bc971d83563';
  ent uuid := (select id from public.plans where key = 'enterprise' and is_active);
  hq uuid := pg_temp.sid('branch:HQ');
  cal uuid := pg_temp.sid('holiday-calendar:OM');
  label text := 'Test tenant seed (supabase/seeds/ria-tenant), requested by prem@flowza.ai';
  t0 timestamptz := '2026-08-16 08:00:00+04';
  is_new boolean;
begin
  if ent is null then raise exception 'enterprise plan missing or inactive'; end if;
  if exists (select 1 from public.organizations where lower(company_code::text) = 'ria' and id <> org) then
    raise exception 'company code RIA already belongs to another organisation';
  end if;
  is_new := not exists (select 1 from public.organizations where id = org);

  ---------------------------------------------------------------------------------------------------------------------
  -- Organisation, settings
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.organizations (id, company_code, legal_name, display_name, country_code, timezone, currency_code, locale, weekly_off_days, contact, address, status, created_at)
  values (org, 'RIA', 'Research and Innovation Authority', 'Research and Innovation Authority', 'OM', 'Asia/Muscat', 'OMR', 'en', '{5,6}',
          jsonb_build_object('name', 'Shaima Al Hosni', 'email', 'ria.info@example.com', 'phone', '+968 2448 7100'),
          jsonb_build_object('line1', 'Way 3018, Al Khuwair', 'line2', 'P.O. Box 2120', 'city', 'Muscat', 'region', 'Muscat Governorate', 'postalCode', '133', 'country', 'OM'),
          'active', t0)
  on conflict (id) do update set legal_name = excluded.legal_name, display_name = excluded.display_name, country_code = excluded.country_code, timezone = excluded.timezone,
    currency_code = excluded.currency_code, weekly_off_days = excluded.weekly_off_days, contact = excluded.contact, address = excluded.address, status = 'active', updated_at = now();

  insert into public.organization_settings (organization_id, general, attendance, security, dashboard)
  values (org,
    jsonb_build_object('dateFormat', 'DD/MM/YYYY', 'timeFormat', '12h', 'firstDayOfWeek', 0, 'calendar', 'hijri_secondary'),
    jsonb_build_object(
      'selfService', jsonb_build_object('webCheckIn', true, 'mobileCheckIn', true, 'allowSelfieCheckIn', true, 'regularisation', true, 'requireGeofence', 'flag'),
      'allowSelfServiceCorrections', true,
      'missedPunch', jsonb_build_object('detectionEnabled', true, 'dayCloseGraceDays', 2, 'singlePunchSplitTime', '11:00'),
      'nonWorkingDay', jsonb_build_object('action', 'overtime')),
    jsonb_build_object('mfaRequired', false, 'sessionIdleMinutes', 480),
    jsonb_build_object('theme', 'ocean', 'layout', 'overview', 'trendDays', 30))
  on conflict (organization_id) do update set general = excluded.general, attendance = excluded.attendance, security = excluded.security, dashboard = excluded.dashboard, updated_at = now();

  ---------------------------------------------------------------------------------------------------------------------
  -- Holiday calendar (Oman 2026; moon-sighting dates tentative), Head Office branch, geofence
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

  -- the default branch every tenant gets (apps/api/src/services/tenant-provisioning.ts DEFAULT_BRANCH), with an address
  insert into public.branches (id, organization_id, code, name, name_ar, country_code, city, address, timezone, latitude, longitude, geofence_radius_m, contact, weekly_off_days, holiday_calendar_id, status, created_at)
  values (hq, org, 'HQ', 'Head Office', 'المقر الرئيسي', 'OM', 'Muscat',
          jsonb_build_object('line1', 'Way 3018, Al Khuwair', 'city', 'Muscat', 'region', 'Muscat Governorate', 'postalCode', '133', 'country', 'OM'),
          'Asia/Muscat', 23.5957, 58.4251, 200, jsonb_build_object('name', 'Shaima Al Hosni', 'email', 'ria.info@example.com', 'phone', '+968 2448 7100'),
          null, cal, 'active', t0)
  on conflict (organization_id, code) do update set name = excluded.name, name_ar = excluded.name_ar, city = excluded.city, address = excluded.address, latitude = excluded.latitude,
    longitude = excluded.longitude, geofence_radius_m = excluded.geofence_radius_m, contact = excluded.contact, holiday_calendar_id = excluded.holiday_calendar_id, status = 'active', updated_at = now();

  insert into public.geofences (id, organization_id, branch_id, name, latitude, longitude, radius_m, enforcement, accuracy_threshold_m, grace_m, is_active, created_at)
  values (pg_temp.sid('geofence:HQ'), org, hq, 'Head Office campus', 23.5957, 58.4251, 200, 'soft_warn', 100, 25, true, t0)
  on conflict (id) do update set latitude = excluded.latitude, longitude = excluded.longitude, radius_m = excluded.radius_m, enforcement = excluded.enforcement, is_active = true, updated_at = now();

  ---------------------------------------------------------------------------------------------------------------------
  -- Leave types: the product defaults (@flowza/contracts DEFAULT_LEAVE_TYPES) + the comp-off type, with yearly allowances
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.leave_types (id, organization_id, code, name, name_ar, is_paid, treat_as_present, color, annual_allowance_days, applicable_gender, created_at)
  select pg_temp.sid('leave-type:' || v.code), org, v.code, v.name, v.name_ar, v.paid, v.present, v.color, v.allowance, v.gender, t0
  from (values
    ('AL',  'Annual Leave',    'إجازة سنوية',       true,  false, '#175cd3', 30,   'all'),
    ('CL',  'Casual Leave',    'إجازة عرضية',       true,  false, '#0e7490', 6,    'all'),
    ('SL',  'Sick Leave',      'إجازة مرضية',       true,  false, '#b54708', 10,   'all'),
    ('EL',  'Emergency Leave', 'إجازة طارئة',       true,  false, '#b42318', 6,    'all'),
    ('SPL', 'Special Leave',   'إجازة خاصة',        true,  false, '#7a2e9d', null, 'all'),
    ('ML',  'Maternity Leave', 'إجازة أمومة',       true,  false, '#c11574', 98,   'female'),
    ('NP',  'No Pay Leave',    'إجازة بدون راتب',   false, false, '#475467', null, 'all'),
    ('SD',  'Site Duty',       'مهمة عمل خارجية',   true,  true,  '#0f6e56', null, 'all')
  ) as v(code, name, name_ar, paid, present, color, allowance, gender)
  on conflict (organization_id, code) do update set annual_allowance_days = excluded.annual_allowance_days, applicable_gender = excluded.applicable_gender;

  insert into public.leave_types (id, organization_id, code, name, name_ar, is_paid, treat_as_present, color, requires_approval, count_mode, accrual, is_special, allow_half_day, portal_visible, system_key, created_at)
  values (pg_temp.sid('leave-type:CO'), org, 'CO', 'Compensatory Off', 'إجازة تعويضية', true, false, '#6941c6', true, 'working', 'none', true, true, false, 'COMP_OFF', t0)
  on conflict (organization_id, code) do nothing;

  ---------------------------------------------------------------------------------------------------------------------
  -- Subscription: Enterprise, active, yearly; seats null = the plan's own user limit
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.subscriptions (organization_id, plan_id, status, billing_cycle, seats, trial_ends_at, current_period_start, current_period_end)
  values (org, ent, 'active', 'yearly', null, null, '2026-10-19 00:00:00+04', '2027-10-19 00:00:00+04')
  on conflict (organization_id) do update set plan_id = ent, status = 'active', billing_cycle = 'yearly', seats = null, trial_ends_at = null, cancel_at = null,
    current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end, updated_at = now();

  -- every module comes from the plan: drop any override a tester left behind
  delete from public.organization_modules where organization_id = org;

  ---------------------------------------------------------------------------------------------------------------------
  -- Feature flags: everything on for this tenant, except biometric template sync (legal review first)
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.organization_feature_flags (organization_id, flag_key, enabled)
  select org, f.key, true from public.feature_flags f where f.key <> 'biometric_template_sync'
  on conflict (organization_id, flag_key) do update set enabled = true, updated_at = now();

  if is_new then
    insert into audit.logs (organization_id, actor_type, actor_label, action, entity_type, entity_id, new_value, reason)
    values (org, 'SYSTEM', label, 'organization.created', 'organization', org::text,
            jsonb_build_object('companyCode', 'RIA', 'displayName', 'Research and Innovation Authority', 'planKey', 'enterprise', 'status', 'active',
                               'featureFlags', (select jsonb_object_agg(flag_key, enabled) from public.organization_feature_flags where organization_id = org)),
            'Test tenant: Enterprise plan with every module and feature flag on');
  end if;
end $$;

select 'tenant' as step, o.company_code, o.display_name, o.status, p.key as plan, s.status as subscription, s.seats,
  array_to_string(p.modules, ', ') as modules,
  (select count(*) from public.organization_modules m where m.organization_id = o.id) as module_overrides,
  (select string_agg(f.flag_key, ', ' order by f.flag_key) from public.organization_feature_flags f where f.organization_id = o.id and f.enabled) as flags_on,
  (select count(*) from public.leave_types t where t.organization_id = o.id) as leave_types,
  (select count(*) from public.branches b where b.organization_id = o.id) as branches
from public.organizations o join public.subscriptions s on s.organization_id = o.id join public.plans p on p.id = s.plan_id
where o.id = '1fa2602c-06d4-4341-86ba-2bc971d83563';
