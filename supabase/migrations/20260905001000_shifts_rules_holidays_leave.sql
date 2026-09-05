-- FlowZa Time · 1000 · shifts, rotational patterns, assignments, attendance rule sets, holidays, leave boundary
create type public.shift_type as enum ('FIXED', 'FLEXIBLE');
create type public.assignment_target as enum ('ORGANIZATION', 'BRANCH', 'DEPARTMENT', 'TEAM', 'EMPLOYEE');
create type public.punch_interpretation as enum ('FIRST_LAST', 'PAIRED', 'DIRECTIONAL');
create type public.rounding_mode as enum ('NONE', 'NEAREST', 'UP', 'DOWN');
create type public.missing_punch_behavior as enum ('FLAG_ONLY', 'ASSUME_SHIFT_END', 'TREAT_AS_ABSENT', 'TREAT_AS_HALF_DAY');
create type public.holiday_type as enum ('PUBLIC', 'RELIGIOUS', 'COMPANY', 'REGIONAL');
create type public.leave_status as enum ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
create type public.leave_source as enum ('INTERNAL', 'EXTERNAL');
create type public.half_day_part as enum ('FIRST_HALF', 'SECOND_HALF');

create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code extensions.citext not null,
  name text not null,
  name_ar text,
  type public.shift_type not null default 'FIXED',
  start_time time,                              -- FIXED
  end_time time,                                -- FIXED
  crosses_midnight boolean generated always as (type = 'FIXED' and start_time is not null and end_time is not null and end_time <= start_time) stored,
  required_minutes int check (required_minutes is null or required_minutes between 0 and 1440),  -- FLEXIBLE
  core_start time,                              -- FLEXIBLE optional core hours
  core_end time,
  day_boundary time not null default '04:00',   -- FLEXIBLE: local time at which a new attendance day starts
  breaks jsonb not null default '[]'::jsonb check (jsonb_typeof(breaks) = 'array'), -- [{"start":"13:00","end":"14:00","paid":false}] or [{"minutes":60,"paid":false}]
  punch_in_window_before_minutes int not null default 240 check (punch_in_window_before_minutes between 0 and 720),
  punch_out_window_after_minutes int not null default 360 check (punch_out_window_after_minutes between 0 and 720),
  grace_in_minutes int check (grace_in_minutes is null or grace_in_minutes between 0 and 240),
  grace_out_minutes int check (grace_out_minutes is null or grace_out_minutes between 0 and 240),
  color text,
  status public.record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code),
  unique (id, organization_id),
  constraint shifts_fixed_has_times check (type <> 'FIXED' or (start_time is not null and end_time is not null)),
  constraint shifts_flexible_has_required check (type <> 'FLEXIBLE' or required_minutes is not null)
);
create trigger shifts_updated_at before update on public.shifts for each row execute function app.set_updated_at();

create table public.shift_patterns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code extensions.citext not null,
  name text not null,
  cycle_length_days int not null check (cycle_length_days between 1 and 366),
  sequence jsonb not null check (jsonb_typeof(sequence) = 'array'), -- [{"day":0,"shift_id":"..."},{"day":3,"off":true}]
  anchor_date date not null,
  status public.record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code),
  unique (id, organization_id)
);
create trigger shift_patterns_updated_at before update on public.shift_patterns for each row execute function app.set_updated_at();

create table public.shift_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  target_type public.assignment_target not null,
  target_id uuid not null, -- organisation/branch/department/team/employee id
  branch_id uuid, -- for RLS when target is branch/employee (denormalised)
  shift_id uuid,
  shift_pattern_id uuid,
  effective_from date not null,
  effective_to date,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint shift_assignments_one_target check ((shift_id is null) <> (shift_pattern_id is null)),
  constraint shift_assignments_range check (effective_to is null or effective_to > effective_from),
  constraint shift_assignments_no_overlap exclude using gist (
    target_type with =, target_id with =, daterange(effective_from, effective_to, '[)') with &&
  ),
  foreign key (shift_id, organization_id) references public.shifts(id, organization_id),
  foreign key (shift_pattern_id, organization_id) references public.shift_patterns(id, organization_id)
);
create index shift_assignments_target_idx on public.shift_assignments (organization_id, target_type, target_id, effective_from desc);

-- Effective-dated attendance rules (§107, §113). branch_id null = organisation default.
create table public.attendance_rule_sets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid,
  name text not null,
  effective_from date not null,
  effective_to date,
  grace_in_minutes int not null default 10 check (grace_in_minutes between 0 and 240),
  grace_out_minutes int not null default 0 check (grace_out_minutes between 0 and 240),
  late_threshold_minutes int not null default 0 check (late_threshold_minutes between 0 and 480),      -- flag LATE only when late minutes exceed this
  early_departure_threshold_minutes int not null default 0 check (early_departure_threshold_minutes between 0 and 480),
  min_full_day_minutes int not null default 420 check (min_full_day_minutes between 0 and 1440),
  half_day_threshold_minutes int not null default 240 check (half_day_threshold_minutes between 0 and 1440),
  overtime_enabled boolean not null default true,
  overtime_start_after_minutes int not null default 30 check (overtime_start_after_minutes between 0 and 480), -- OT counts after scheduled end + this
  overtime_min_block_minutes int not null default 30 check (overtime_min_block_minutes between 0 and 480),
  overtime_rounding_minutes int not null default 15 check (overtime_rounding_minutes in (0, 5, 10, 15, 30, 60)),
  overtime_max_minutes_per_day int check (overtime_max_minutes_per_day is null or overtime_max_minutes_per_day between 0 and 1440),
  count_early_in_as_overtime boolean not null default false,
  punch_rounding_minutes int not null default 0 check (punch_rounding_minutes in (0, 5, 10, 15, 30)),
  punch_rounding_mode public.rounding_mode not null default 'NONE',
  worked_rounding_minutes int not null default 0 check (worked_rounding_minutes in (0, 5, 10, 15, 30)),
  worked_rounding_mode public.rounding_mode not null default 'NONE',
  punch_interpretation public.punch_interpretation not null default 'FIRST_LAST',
  duplicate_punch_window_seconds int not null default 60 check (duplicate_punch_window_seconds between 0 and 3600),
  missing_punch_behavior public.missing_punch_behavior not null default 'FLAG_ONLY',
  auto_absent_without_punches boolean not null default true,
  weekly_off_work_counts_as_overtime boolean not null default true,
  holiday_work_counts_as_overtime boolean not null default true,
  ramadan_mode jsonb not null default '{}'::jsonb check (jsonb_typeof(ramadan_mode) = 'object'), -- {"enabled":true,"from":"2026-02-18","to":"2026-03-19","scheduled_minutes":360,"applies_to":"muslim_employees|all"}
  extra jsonb not null default '{}'::jsonb check (jsonb_typeof(extra) = 'object'),
  version int not null default 1,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_rule_sets_range check (effective_to is null or effective_to > effective_from),
  constraint attendance_rule_sets_no_overlap exclude using gist (
    organization_id with =,
    coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid) with =,
    daterange(effective_from, effective_to, '[)') with &&
  ),
  foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete cascade
);
create index attendance_rule_sets_org_idx on public.attendance_rule_sets (organization_id, branch_id, effective_from desc);
create trigger attendance_rule_sets_updated_at before update on public.attendance_rule_sets for each row execute function app.set_updated_at();

create table public.holiday_calendars (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  country_code char(2),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index holiday_calendars_default_idx on public.holiday_calendars (organization_id) where is_default;
create trigger holiday_calendars_updated_at before update on public.holiday_calendars for each row execute function app.set_updated_at();
alter table public.branches add constraint branches_holiday_calendar_fk foreign key (holiday_calendar_id, organization_id) references public.holiday_calendars(id, organization_id) on delete set null (holiday_calendar_id);

create table public.holidays (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  calendar_id uuid not null references public.holiday_calendars(id) on delete cascade,
  name text not null,
  name_ar text,
  date date not null,
  end_date date,
  is_half_day boolean not null default false,
  type public.holiday_type not null default 'PUBLIC',
  branch_ids uuid[], -- null = all branches using this calendar
  is_tentative boolean not null default false, -- moon-sighting dependent holidays
  created_at timestamptz not null default now(),
  constraint holidays_range check (end_date is null or end_date >= date)
);
create index holidays_calendar_date_idx on public.holidays (calendar_id, date);
create index holidays_org_date_idx on public.holidays (organization_id, date);

-- Leave integration boundary (§30). The engine consumes APPROVED leave only.
create table public.leave_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code extensions.citext not null,
  name text not null,
  name_ar text,
  is_paid boolean not null default true,
  color text,
  status public.record_status not null default 'active',
  created_at timestamptz not null default now(),
  unique (organization_id, code),
  unique (id, organization_id)
);

create table public.leave_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  branch_id uuid,
  leave_type_id uuid not null,
  start_date date not null,
  end_date date not null,
  is_half_day boolean not null default false,
  half_day_part public.half_day_part,
  status public.leave_status not null default 'APPROVED',
  source public.leave_source not null default 'INTERNAL',
  external_ref text,
  reason text,
  approved_by uuid references public.user_profiles(id) on delete set null,
  approved_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leave_records_range check (end_date >= start_date),
  constraint leave_records_half_day check (not is_half_day or (start_date = end_date and half_day_part is not null)),
  foreign key (leave_type_id, organization_id) references public.leave_types(id, organization_id)
);
create index leave_records_employee_idx on public.leave_records (organization_id, employee_id, start_date, end_date) where status = 'APPROVED';
create index leave_records_org_dates_idx on public.leave_records (organization_id, start_date, end_date);
create trigger leave_records_updated_at before update on public.leave_records for each row execute function app.set_updated_at();
