-- FlowZa Time · 20261019000310 · Short leave (hourly permissions), reduced hours and lost time — part 2 of 2. Needs
-- 20261019000300_short_leave_enum.sql (approval entity SHORT_LEAVE).
--
-- Customer requirements (Oman): short-leave management incl. the special short leaves — the nursing (maternity) hour and short
-- leave for persons with disabilities; "lost hours": out-of-office periods during working hours classified into official
-- assignments, short-leave permissions and unapproved time, with a 20-minute allowance; remote work recorded and counted within
-- the working hours.
--
--  1. `time_off_types` — the organisation's permission types: code, names, category (PERSONAL, OFFICIAL, REMOTE, NURSING,
--     DISABILITY, OTHER), whether the time counts as work (OFFICIAL / REMOTE by default), the longest window per request, the
--     monthly quota (minutes and / or count), whether it needs approval, the gender it applies to and whether the portal offers
--     it. Read with leave.view, managed with leave.manage (HR → Leave → Short leave types).
--  2. `time_off_requests` — one window of one day (local times of the employee's branch, start < end within 00:00–24:00; the
--     minutes are server-computed). Routed through the approval engine (entity SHORT_LEAVE); written by the API's system step
--     only (like leave_records since the security gate): readable with leave.view (branch scope), by the employee themselves
--     and by a line manager with leave.view_team. Two active (PENDING / APPROVED) windows of one employee never overlap.
--  3. `employee_hour_allowances` — recurring reduced hours (nursing hour, persons with disabilities): minutes per working day
--     (15–240) off the START, the END or EITHER, valid from → to (inclusive; open-ended allowed except for nursing — the API
--     refuses it). Read with leave.view (branch scope) and by the employee; written with leave.manage.
--  4. `attendance_rule_sets.out_of_office_allowance_minutes` (0–120, default 0): the out-of-office time per day tolerated
--     before it counts as lost time.
--  5. `attendance_daily_records` gains `excused_minutes`, `credited_minutes` and `lost_minutes` (engine 1.5.0). Hot table:
--     the columns carry constant defaults (metadata-only, no rewrite) and their checks are added NOT VALID (enforced for every
--     new write; the existing rows hold the default 0) under a bounded lock wait.
--
-- Additive and idempotent; one transaction; ends with a post-verify block.
set lock_timeout = '5s';
set statement_timeout = '120s';
set client_min_messages = warning;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Permission types
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.time_off_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code extensions.citext not null check (code::text ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$'),
  name text not null check (length(btrim(name)) between 1 and 120),
  name_ar text check (name_ar is null or length(name_ar) <= 120),
  category text not null check (category in ('PERSONAL', 'OFFICIAL', 'REMOTE', 'NURSING', 'DISABILITY', 'OTHER')),
  counts_as_work boolean not null default false,
  max_minutes_per_request int check (max_minutes_per_request is null or max_minutes_per_request between 5 and 1440),
  monthly_quota_minutes int check (monthly_quota_minutes is null or monthly_quota_minutes between 5 and 20000),
  monthly_quota_count int check (monthly_quota_count is null or monthly_quota_count between 1 and 100),
  requires_approval boolean not null default true,
  applicable_gender text not null default 'all' check (applicable_gender in ('all', 'male', 'female')),
  portal_visible boolean not null default true,
  status public.record_status not null default 'active',
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint time_off_types_organization_id_code_key unique (organization_id, code),
  constraint time_off_types_id_organization_id_key unique (id, organization_id)
);
comment on table public.time_off_types is 'Short leave (hourly permission) types of an organisation: personal permission, official assignment, remote work, nursing hour, disability short leave… (migration 20261019000310).';
comment on column public.time_off_types.counts_as_work is 'The approved window counts as worked time (credited to the daily record) — official assignments and remote work.';
drop trigger if exists time_off_types_updated_at on public.time_off_types;
create trigger time_off_types_updated_at before update on public.time_off_types for each row execute function app.set_updated_at();
create index if not exists time_off_types_created_by_fk_idx on public.time_off_types (created_by) where created_by is not null;
call app.apply_tenant_policies('public.time_off_types', 'leave.view', 'leave.manage');
-- the people who ask for, approve or follow short leave read the types too (an employee's own request shows its type; the
-- portal offers the active ones through the API's system scope) — the types carry no personal data
drop policy if exists time_off_types_requester_select on public.time_off_types;
create policy time_off_types_requester_select on public.time_off_types for select to authenticated, flowza_system using (
  organization_id = any ((select app.org_ids_with_any_permission(array['leave.request', 'leave.approve', 'leave.view_team']::text[]))::uuid[])
);

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Requests
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.time_off_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null,
  -- the employee's branch when the request was written (RLS branch scope, like leave_records.branch_id)
  branch_id uuid,
  time_off_type_id uuid not null,
  request_date date not null,
  -- local wall-clock times of the employee's branch on request_date; 24:00 = the end of the day
  start_time time not null,
  end_time time not null,
  minutes int not null check (minutes between 1 and 1440),
  reason text not null check (length(btrim(reason)) between 3 and 1000),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  approval_request_id uuid references public.approval_requests(id) on delete set null,
  decided_by uuid references public.user_profiles(id) on delete set null,
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 1000),
  cancelled_at timestamptz,
  cancelled_by uuid references public.user_profiles(id) on delete set null,
  cancel_reason text check (cancel_reason is null or length(cancel_reason) <= 1000),
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint time_off_requests_employee_fkey foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade,
  constraint time_off_requests_branch_fkey foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete set null (branch_id),
  constraint time_off_requests_type_fkey foreign key (time_off_type_id, organization_id) references public.time_off_types(id, organization_id),
  constraint time_off_requests_window check (start_time < end_time and start_time < time '24:00'),
  constraint time_off_requests_minutes_match check (minutes = (extract(epoch from (end_time - start_time)) / 60)::int),
  constraint time_off_requests_cancel_shape check (status <> 'CANCELLED' or cancelled_at is not null),
  -- the service refuses an overlap first (with a friendly 409); this is the backstop
  constraint time_off_requests_no_overlap exclude using gist (
    organization_id with =, employee_id with =,
    tsrange(request_date + start_time, request_date + end_time, '[)') with &&
  ) where (status in ('PENDING', 'APPROVED'))
);
comment on table public.time_off_requests is 'Short leave requests — one window of one day, routed through the approval engine (entity SHORT_LEAVE); written by the API system step only.';
create index if not exists time_off_requests_employee_idx on public.time_off_requests (organization_id, employee_id, request_date desc);
create index if not exists time_off_requests_date_idx on public.time_off_requests (organization_id, request_date) where status in ('PENDING', 'APPROVED');
create index if not exists time_off_requests_type_idx on public.time_off_requests (organization_id, time_off_type_id);
create index if not exists time_off_requests_branch_idx on public.time_off_requests (organization_id, branch_id);
create index if not exists time_off_requests_approval_idx on public.time_off_requests (approval_request_id) where approval_request_id is not null;
create index if not exists time_off_requests_created_by_fk_idx on public.time_off_requests (created_by) where created_by is not null;
create index if not exists time_off_requests_decided_by_fk_idx on public.time_off_requests (decided_by) where decided_by is not null;
create index if not exists time_off_requests_cancelled_by_fk_idx on public.time_off_requests (cancelled_by) where cancelled_by is not null;
drop trigger if exists time_off_requests_updated_at on public.time_off_requests;
create trigger time_off_requests_updated_at before update on public.time_off_requests for each row execute function app.set_updated_at();
call app.apply_readonly_tenant_policies('public.time_off_requests', 'leave.view', 'branch_id', 'employee_id', 'employee_id', array['leave.view_team']);

-- ---------------------------------------------------------------------------------------------------------------------------
-- 3. Reduced hours
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.employee_hour_allowances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null,
  -- the employee's branch when the row was written (RLS branch scope)
  branch_id uuid,
  kind text not null check (kind in ('NURSING', 'DISABILITY', 'OTHER')),
  minutes_per_day int not null check (minutes_per_day between 15 and 240),
  position text not null default 'EITHER' check (position in ('START', 'END', 'EITHER')),
  valid_from date not null,
  -- inclusive last day; null = open-ended
  valid_to date,
  reference text check (reference is null or length(reference) <= 120),
  notes text check (notes is null or length(notes) <= 500),
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_hour_allowances_employee_fkey foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade,
  constraint employee_hour_allowances_branch_fkey foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete set null (branch_id),
  constraint employee_hour_allowances_range check (valid_to is null or valid_to >= valid_from),
  -- one allowance of a kind per employee and day
  constraint employee_hour_allowances_no_overlap exclude using gist (organization_id with =, employee_id with =, kind with =, daterange(valid_from, valid_to, '[]') with &&)
);
comment on table public.employee_hour_allowances is 'Recurring reduced daily hours (nursing hour, persons with disabilities): minutes per working day off the start, the end or either (engine 1.5.0).';
create index if not exists employee_hour_allowances_employee_idx on public.employee_hour_allowances (organization_id, employee_id, valid_from desc);
create index if not exists employee_hour_allowances_branch_idx on public.employee_hour_allowances (organization_id, branch_id);
create index if not exists employee_hour_allowances_created_by_fk_idx on public.employee_hour_allowances (created_by) where created_by is not null;
drop trigger if exists employee_hour_allowances_updated_at on public.employee_hour_allowances;
create trigger employee_hour_allowances_updated_at before update on public.employee_hour_allowances for each row execute function app.set_updated_at();
call app.apply_tenant_policies('public.employee_hour_allowances', 'leave.view', 'leave.manage', 'branch_id', 'employee_id');

-- ---------------------------------------------------------------------------------------------------------------------------
-- 4. The rule set's out-of-office allowance
-- ---------------------------------------------------------------------------------------------------------------------------
alter table public.attendance_rule_sets add column if not exists out_of_office_allowance_minutes int not null default 0;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.attendance_rule_sets'::regclass and conname = 'attendance_rule_sets_out_of_office_allowance_check') then
    alter table public.attendance_rule_sets add constraint attendance_rule_sets_out_of_office_allowance_check check (out_of_office_allowance_minutes between 0 and 120);
  end if;
end $$;
comment on column public.attendance_rule_sets.out_of_office_allowance_minutes is
  'Out-of-office minutes per day inside the scheduled hours tolerated before they count as lost time (engine 1.5.0; PAIRED / DIRECTIONAL punching).';

-- ---------------------------------------------------------------------------------------------------------------------------
-- 5. The daily record's short-leave figures (hot table)
-- ---------------------------------------------------------------------------------------------------------------------------
alter table public.attendance_daily_records add column if not exists excused_minutes int not null default 0;
alter table public.attendance_daily_records add column if not exists credited_minutes int not null default 0;
alter table public.attendance_daily_records add column if not exists lost_minutes int not null default 0;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.attendance_daily_records'::regclass and conname = 'attendance_daily_records_short_leave_minutes_check') then
    -- NOT VALID: no scan of the hot table under the lock; every row written from now on is checked, the existing ones hold 0
    alter table public.attendance_daily_records add constraint attendance_daily_records_short_leave_minutes_check
      check (excused_minutes between 0 and 2880 and credited_minutes between 0 and 2880 and lost_minutes between 0 and 2880) not valid;
  end if;
end $$;
comment on column public.attendance_daily_records.excused_minutes is 'Scheduled minutes not worked that an approved (non-work) short leave covered (engine 1.5.0).';
comment on column public.attendance_daily_records.credited_minutes is 'Minutes of an approved official assignment / remote work credited to worked_minutes (part of it, engine 1.5.0).';
comment on column public.attendance_daily_records.lost_minutes is 'Out-of-office minutes inside the scheduled hours no approved short leave covers, beyond the rule set allowance (engine 1.5.0).';

-- ---------------------------------------------------------------------------------------------------------------------------
-- 6. Post-verify
-- ---------------------------------------------------------------------------------------------------------------------------
do $$
declare v_table text;
begin
  if not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'approval_entity' and e.enumlabel = 'SHORT_LEAVE') then
    raise exception 'approval entity SHORT_LEAVE missing (apply 20261019000300 first)';
  end if;
  foreach v_table in array array['time_off_types', 'time_off_requests', 'employee_hour_allowances'] loop
    if not exists (select 1 from pg_class where oid = ('public.' || v_table)::regclass and relrowsecurity and relforcerowsecurity) then
      raise exception '% has no forced RLS', v_table;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.time_off_requests', 'insert') or has_table_privilege('authenticated', 'public.time_off_requests', 'update')
     or has_table_privilege('authenticated', 'public.time_off_requests', 'delete') then
    raise exception 'time_off_requests must be written by the system context only';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'attendance_rule_sets' and column_name = 'out_of_office_allowance_minutes') then
    raise exception 'attendance_rule_sets.out_of_office_allowance_minutes missing';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'attendance_daily_records'
      and column_name in ('excused_minutes', 'credited_minutes', 'lost_minutes')) <> 3 then
    raise exception 'attendance_daily_records short-leave columns missing';
  end if;
end $$;
