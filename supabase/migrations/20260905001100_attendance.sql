-- FlowZa Time · 1100 · raw transactions → events → daily records → corrections/approvals → period summaries (ADR-005)
create type public.verification_method as enum ('fingerprint', 'face', 'card', 'pin', 'password', 'palm', 'iris', 'mobile', 'manual', 'unknown');
create type public.punch_direction as enum ('in', 'out', 'break_out', 'break_in', 'overtime_in', 'overtime_out', 'unknown');
create type public.raw_source as enum ('POLL', 'WEBHOOK', 'DEVICE_PUSH', 'IMPORT', 'MANUAL');
create type public.raw_processing_status as enum ('pending', 'normalized', 'unmatched', 'ignored', 'error');
create type public.event_source as enum ('DEVICE', 'MANUAL', 'CORRECTION', 'IMPORT', 'MOBILE');
create type public.attendance_event_type as enum ('PUNCH', 'PUNCH_IN', 'PUNCH_OUT', 'BREAK_START', 'BREAK_END');
create type public.attendance_status as enum ('PRESENT', 'ABSENT', 'LEAVE', 'HOLIDAY', 'WEEKLY_OFF', 'HALF_DAY', 'MISSING_PUNCH', 'NOT_JOINED', 'EXITED', 'PENDING');
create type public.record_history_reason as enum ('INITIAL', 'NEW_EVENT', 'CORRECTION', 'RULE_CHANGE', 'SHIFT_CHANGE', 'HOLIDAY_CHANGE', 'LEAVE_CHANGE', 'RECALCULATION', 'MANUAL_OVERRIDE', 'UNLOCK');
create type public.correction_type as enum ('ADD_PUNCH', 'EDIT_PUNCH', 'REMOVE_PUNCH', 'SET_STATUS');
create type public.correction_status as enum ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'APPLIED');
create type public.approval_entity as enum ('ATTENDANCE_CORRECTION', 'OVERTIME', 'MISSING_PUNCH', 'SHIFT_CHANGE', 'MANUAL_ATTENDANCE', 'LEAVE');
create type public.approval_status as enum ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
create type public.approver_type as enum ('MANAGER', 'ROLE', 'USER');
create type public.recalculation_status as enum ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');
create type public.period_summary_status as enum ('draft', 'finalized');

-- 1. Raw device transactions: immutable, partitioned by month on punched_at.
create table public.attendance_raw_transactions (
  id bigint generated always as identity,
  organization_id uuid not null,
  device_id uuid not null,
  branch_id uuid, -- device branch at ingestion (RLS scope)
  provider_key text not null,
  provider_transaction_id text,
  device_employee_id text not null,
  employee_id uuid, -- resolved by normaliser
  punched_at timestamptz not null,
  device_local_time text,
  verification_method public.verification_method not null default 'unknown',
  direction public.punch_direction not null default 'unknown',
  raw_payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  source public.raw_source not null,
  sync_job_id uuid,
  dedupe_hash text not null,
  processing_status public.raw_processing_status not null default 'pending',
  processing_error text,
  processed_at timestamptz,
  primary key (id, punched_at)
) partition by range (punched_at);
create unique index attendance_raw_provider_txn_idx on public.attendance_raw_transactions (organization_id, device_id, provider_transaction_id, punched_at) where provider_transaction_id is not null;
create unique index attendance_raw_dedupe_idx on public.attendance_raw_transactions (organization_id, device_id, dedupe_hash, punched_at);
create index attendance_raw_org_device_time_idx on public.attendance_raw_transactions (organization_id, device_id, punched_at desc);
create index attendance_raw_backlog_idx on public.attendance_raw_transactions (organization_id, processing_status, punched_at) where processing_status in ('pending', 'unmatched', 'error');
create index attendance_raw_employee_idx on public.attendance_raw_transactions (organization_id, employee_id, punched_at) where employee_id is not null;
create table public.attendance_raw_transactions_default partition of public.attendance_raw_transactions default;
select app.ensure_month_partitions('public.attendance_raw_transactions', '2025-01-01', 36);

create or replace function app.protect_raw_transactions() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'attendance_raw_transactions is append-only' using errcode = 'P0001'; end if;
  -- only processing bookkeeping columns may change
  if new.organization_id <> old.organization_id or new.device_id <> old.device_id or new.punched_at <> old.punched_at
     or new.raw_payload <> old.raw_payload or new.device_employee_id <> old.device_employee_id
     or new.provider_transaction_id is distinct from old.provider_transaction_id or new.received_at <> old.received_at then
    raise exception 'attendance_raw_transactions source columns are immutable' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger attendance_raw_transactions_protect before update or delete on public.attendance_raw_transactions for each row execute function app.protect_raw_transactions();

-- 2. Normalised events, partitioned by month on punched_at. Never deleted; voided by corrections.
create table public.attendance_events (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  employee_id uuid not null,
  branch_id uuid not null,
  device_id uuid,
  raw_transaction_id bigint,
  source public.event_source not null,
  event_type public.attendance_event_type not null default 'PUNCH',
  punched_at timestamptz not null,
  verification_method public.verification_method not null default 'unknown',
  correction_id uuid,
  note text,
  voided_at timestamptz,
  voided_by_correction_id uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (id, punched_at)
) partition by range (punched_at);
create index attendance_events_employee_time_idx on public.attendance_events (organization_id, employee_id, punched_at);
create index attendance_events_branch_time_idx on public.attendance_events (organization_id, branch_id, punched_at);
create unique index attendance_events_raw_idx on public.attendance_events (raw_transaction_id, punched_at) where raw_transaction_id is not null;
create table public.attendance_events_default partition of public.attendance_events default;
select app.ensure_month_partitions('public.attendance_events', '2025-01-01', 36);

create or replace function app.protect_attendance_events() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'attendance_events is append-only' using errcode = 'P0001'; end if;
  -- raw_transaction_id may be set once (null → id) by the normaliser; everything else is immutable
  if new.employee_id <> old.employee_id or new.punched_at <> old.punched_at or new.event_type <> old.event_type
     or new.source <> old.source or (old.raw_transaction_id is not null and new.raw_transaction_id is distinct from old.raw_transaction_id) then
    raise exception 'attendance_events are immutable; void and re-add through a correction' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger attendance_events_protect before update or delete on public.attendance_events for each row execute function app.protect_attendance_events();

-- 3. Computed daily records.
create table public.attendance_daily_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  attendance_date date not null,
  branch_id uuid not null,
  department_id uuid,
  shift_id uuid,
  shift_assignment_id uuid,
  rule_set_id uuid,
  timezone text not null,
  expected_start_at timestamptz,
  expected_end_at timestamptz,
  scheduled_minutes int not null default 0,
  first_in_at timestamptz,
  last_out_at timestamptz,
  worked_minutes int not null default 0 check (worked_minutes >= 0),
  break_minutes int not null default 0 check (break_minutes >= 0),
  late_minutes int not null default 0 check (late_minutes >= 0),
  early_departure_minutes int not null default 0 check (early_departure_minutes >= 0),
  overtime_minutes int not null default 0 check (overtime_minutes >= 0),
  overtime_category text, -- REGULAR | WEEKLY_OFF | HOLIDAY | NIGHT (for payroll multipliers)
  status public.attendance_status not null default 'PENDING',
  flags text[] not null default '{}',
  punch_count int not null default 0,
  has_correction boolean not null default false,
  calculation_version int not null default 1,
  engine_version text not null,
  trace jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, employee_id, attendance_date)
);
create index attendance_daily_records_date_branch_idx on public.attendance_daily_records (organization_id, attendance_date, branch_id);
create index attendance_daily_records_date_status_idx on public.attendance_daily_records (organization_id, attendance_date) include (status, late_minutes, overtime_minutes, early_departure_minutes, branch_id, department_id);
create index attendance_daily_records_employee_idx on public.attendance_daily_records (organization_id, employee_id, attendance_date desc);
create index attendance_daily_records_flags_idx on public.attendance_daily_records using gin (flags);
create trigger attendance_daily_records_updated_at before update on public.attendance_daily_records for each row execute function app.set_updated_at();

create table public.attendance_daily_record_history (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  record_id uuid not null references public.attendance_daily_records(id) on delete cascade,
  employee_id uuid not null,
  branch_id uuid,
  attendance_date date not null,
  calculation_version int not null,
  reason public.record_history_reason not null,
  snapshot jsonb not null,
  triggered_by uuid,
  job_id bigint,
  created_at timestamptz not null default now()
);
create index attendance_daily_record_history_record_idx on public.attendance_daily_record_history (record_id, calculation_version desc);
create trigger attendance_daily_record_history_append_only before update or delete on public.attendance_daily_record_history for each row execute function app.reject_modification();

-- 4. Approvals (generic) and corrections.
create table public.approval_workflows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entity_type public.approval_entity not null,
  name text not null,
  branch_id uuid,
  steps jsonb not null check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 5), -- [{"order":1,"approver_type":"MANAGER"},{"order":2,"approver_type":"ROLE","role_id":"..."}]
  is_default boolean not null default false,
  status public.record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete cascade
);
create unique index approval_workflows_default_idx on public.approval_workflows (organization_id, entity_type, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)) where is_default;
create trigger approval_workflows_updated_at before update on public.approval_workflows for each row execute function app.set_updated_at();

create table public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workflow_id uuid references public.approval_workflows(id) on delete set null,
  entity_type public.approval_entity not null,
  entity_id uuid not null,
  branch_id uuid,
  employee_id uuid references public.employees(id) on delete set null,
  current_step int not null default 1,
  status public.approval_status not null default 'PENDING',
  requested_by uuid references public.user_profiles(id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index approval_requests_entity_idx on public.approval_requests (entity_type, entity_id);
create index approval_requests_org_status_idx on public.approval_requests (organization_id, status, created_at desc);
create trigger approval_requests_updated_at before update on public.approval_requests for each row execute function app.set_updated_at();

create table public.approval_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  request_id uuid not null references public.approval_requests(id) on delete cascade,
  step_no int not null,
  approver_type public.approver_type not null,
  approver_role_id uuid references public.roles(id) on delete set null,
  approver_user_id uuid references public.user_profiles(id) on delete set null,
  status public.approval_status not null default 'PENDING',
  acted_by uuid references public.user_profiles(id) on delete set null,
  acted_at timestamptz,
  comment text,
  unique (request_id, step_no)
);
create index approval_steps_pending_user_idx on public.approval_steps (approver_user_id, status) where status = 'PENDING';
create index approval_steps_pending_role_idx on public.approval_steps (approver_role_id, status) where status = 'PENDING';

create table public.attendance_corrections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  branch_id uuid not null,
  attendance_date date not null,
  type public.correction_type not null,
  original_event_id uuid,
  original_punched_at timestamptz,
  proposed_punched_at timestamptz,
  proposed_event_type public.attendance_event_type,
  proposed_status public.attendance_status,
  reason text not null check (length(reason) >= 3),
  attachment_path text,
  requested_by uuid references public.user_profiles(id) on delete set null,
  status public.correction_status not null default 'PENDING',
  approval_request_id uuid references public.approval_requests(id) on delete set null,
  applied_event_id uuid,
  applied_at timestamptz,
  applied_by uuid,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_corrections_shape check (
    (type = 'ADD_PUNCH' and proposed_punched_at is not null) or
    (type = 'EDIT_PUNCH' and original_event_id is not null and proposed_punched_at is not null) or
    (type = 'REMOVE_PUNCH' and original_event_id is not null) or
    (type = 'SET_STATUS' and proposed_status is not null)
  )
);
create index attendance_corrections_employee_date_idx on public.attendance_corrections (organization_id, employee_id, attendance_date desc);
create index attendance_corrections_status_idx on public.attendance_corrections (organization_id, status, created_at desc);
create trigger attendance_corrections_updated_at before update on public.attendance_corrections for each row execute function app.set_updated_at();

-- 5. Recalculation requests and period locks.
create table public.attendance_recalculation_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  from_date date not null,
  to_date date not null,
  branch_id uuid,
  department_id uuid,
  employee_ids uuid[],
  reason text not null,
  status public.recalculation_status not null default 'QUEUED',
  queue_job_id bigint,
  requested_by uuid references public.user_profiles(id) on delete set null,
  summary jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  constraint attendance_recalculation_requests_range check (to_date >= from_date and to_date - from_date <= 366)
);
create index attendance_recalculation_requests_org_idx on public.attendance_recalculation_requests (organization_id, created_at desc);

create table public.attendance_period_locks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid, -- null = whole organisation
  period_start date not null,
  period_end date not null,
  locked_by uuid references public.user_profiles(id) on delete set null,
  locked_at timestamptz not null default now(),
  reason text,
  unlocked_by uuid references public.user_profiles(id) on delete set null,
  unlocked_at timestamptz,
  unlock_reason text,
  constraint attendance_period_locks_range check (period_end >= period_start),
  constraint attendance_period_locks_no_overlap exclude using gist (
    organization_id with =,
    coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid) with =,
    daterange(period_start, period_end, '[]') with &&
  ) where (unlocked_at is null)
);
create index attendance_period_locks_org_idx on public.attendance_period_locks (organization_id, period_start, period_end) where unlocked_at is null;

create or replace function app.is_period_locked(p_org uuid, p_branch uuid, p_date date) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.attendance_period_locks l
    where l.organization_id = p_org and l.unlocked_at is null
      and (l.branch_id is null or l.branch_id = p_branch)
      and p_date between l.period_start and l.period_end
  )
$$;

-- Daily records inside a locked period cannot change unless the session declares an unlock/recalc context.
create or replace function app.enforce_period_lock() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('flowza.bypass_period_lock', true), '') = 'on' then return new; end if;
  if app.is_period_locked(new.organization_id, new.branch_id, new.attendance_date) then
    raise exception 'attendance period is locked for % on %', new.employee_id, new.attendance_date using errcode = 'P0002';
  end if;
  return new;
end $$;
create trigger attendance_daily_records_period_lock before insert or update on public.attendance_daily_records for each row execute function app.enforce_period_lock();

-- 6. Payroll-ready period summaries.
create table public.attendance_period_summaries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  branch_id uuid not null,
  period_start date not null,
  period_end date not null,
  working_days int not null default 0,
  present_days numeric(5,2) not null default 0,
  absent_days numeric(5,2) not null default 0,
  leave_days numeric(5,2) not null default 0,
  paid_leave_days numeric(5,2) not null default 0,
  holiday_days int not null default 0,
  weekly_off_days int not null default 0,
  half_days int not null default 0,
  missing_punch_days int not null default 0,
  late_days int not null default 0,
  regular_minutes int not null default 0,
  overtime_minutes int not null default 0,
  overtime_weekly_off_minutes int not null default 0,
  overtime_holiday_minutes int not null default 0,
  late_minutes int not null default 0,
  early_departure_minutes int not null default 0,
  status public.period_summary_status not null default 'draft',
  version int not null default 1,
  record_versions jsonb, -- {record_id: calculation_version}
  finalized_by uuid references public.user_profiles(id) on delete set null,
  finalized_at timestamptz,
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, employee_id, period_start, period_end),
  constraint attendance_period_summaries_range check (period_end >= period_start)
);
create index attendance_period_summaries_period_idx on public.attendance_period_summaries (organization_id, period_start, period_end, branch_id);
create trigger attendance_period_summaries_updated_at before update on public.attendance_period_summaries for each row execute function app.set_updated_at();
