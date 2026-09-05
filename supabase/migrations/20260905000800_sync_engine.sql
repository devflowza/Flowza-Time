-- FlowZa Time · 0800 · sync jobs, items, attempts, cursors, logs, inbound webhook replay protection
create type public.sync_job_type as enum ('PULL_ATTENDANCE', 'PULL_EMPLOYEES', 'PUSH_EMPLOYEE', 'PUSH_EMPLOYEES', 'DEVICE_HEALTH_CHECK', 'RECONCILIATION', 'TEST_CONNECTION', 'DELETE_EMPLOYEE');
create type public.sync_trigger as enum ('MANUAL', 'SCHEDULED', 'WEBHOOK', 'SYSTEM', 'DEVICE_PUSH');
create type public.sync_status as enum ('PENDING', 'QUEUED', 'RUNNING', 'SUCCESS', 'PARTIAL_SUCCESS', 'FAILED', 'RETRYING', 'CANCELLED');
create type public.sync_item_status as enum ('PENDING', 'QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'RETRYING', 'OFFLINE', 'UNSUPPORTED', 'CANCELLED', 'SKIPPED');
create type public.webhook_event_status as enum ('received', 'queued', 'processed', 'rejected', 'duplicate', 'failed');

create table public.sync_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_type public.sync_job_type not null,
  trigger public.sync_trigger not null default 'MANUAL',
  scope jsonb not null default '{}'::jsonb check (jsonb_typeof(scope) = 'object'),
  branch_id uuid, -- when the job targets one branch (RLS scope)
  status public.sync_status not null default 'PENDING',
  priority int not null default 5 check (priority between 0 and 9),
  items_total int not null default 0,
  items_success int not null default 0,
  items_failed int not null default 0,
  items_pending int not null default 0,
  items_offline int not null default 0,
  items_unsupported int not null default 0,
  records_ingested int not null default 0,
  requested_by uuid references public.user_profiles(id) on delete set null,
  correlation_id text not null,
  parent_job_id uuid references public.sync_jobs(id) on delete set null,
  error_code text,
  error text,
  summary jsonb,
  queued_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sync_jobs_org_created_idx on public.sync_jobs (organization_id, created_at desc);
create index sync_jobs_org_status_idx on public.sync_jobs (organization_id, status) where status in ('PENDING', 'QUEUED', 'RUNNING', 'RETRYING');
create index sync_jobs_correlation_idx on public.sync_jobs (correlation_id);
create trigger sync_jobs_updated_at before update on public.sync_jobs for each row execute function app.set_updated_at();

create table public.sync_job_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  sync_job_id uuid not null references public.sync_jobs(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  branch_id uuid,
  employee_id uuid references public.employees(id) on delete set null,
  operation public.sync_job_type not null,
  status public.sync_item_status not null default 'PENDING',
  attempts int not null default 0,
  max_attempts int not null default 6,
  next_attempt_at timestamptz,
  last_error_code text,
  last_error text,
  result jsonb,
  records_ingested int not null default 0,
  queue_job_id bigint,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sync_job_items_job_status_idx on public.sync_job_items (sync_job_id, status);
create index sync_job_items_device_idx on public.sync_job_items (device_id, created_at desc);
create index sync_job_items_employee_idx on public.sync_job_items (organization_id, employee_id, created_at desc) where employee_id is not null;
create trigger sync_job_items_updated_at before update on public.sync_job_items for each row execute function app.set_updated_at();

create table public.sync_attempts (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  sync_job_item_id uuid not null references public.sync_job_items(id) on delete cascade,
  attempt_no int not null,
  status public.sync_item_status not null,
  error_code text,
  error_message text,
  duration_ms int,
  response_meta jsonb,
  worker_id text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index sync_attempts_item_idx on public.sync_attempts (sync_job_item_id, attempt_no);

create table public.sync_cursors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  stream text not null check (stream in ('attendance', 'employees', 'events')),
  cursor jsonb not null default '{}'::jsonb,
  last_transaction_at timestamptz,
  last_pulled_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (device_id, stream)
);
create trigger sync_cursors_updated_at before update on public.sync_cursors for each row execute function app.set_updated_at();

create table public.sync_logs (
  id bigint generated always as identity,
  organization_id uuid not null,
  sync_job_id uuid,
  sync_job_item_id uuid,
  device_id uuid,
  level public.log_level not null default 'info',
  event text not null,
  message text,
  details jsonb,
  created_at timestamptz not null default now(),
  primary key (id, created_at)
) partition by range (created_at);
create index sync_logs_job_idx on public.sync_logs (sync_job_id, created_at);
create index sync_logs_org_idx on public.sync_logs (organization_id, created_at desc);
create table public.sync_logs_default partition of public.sync_logs default;
select app.ensure_month_partitions('public.sync_logs', '2025-01-01', 36);

-- Inbound provider webhook events with replay protection (§80, §81).
create table public.provider_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null references public.device_providers(key),
  organization_id uuid references public.organizations(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  event_id text,
  event_type text,
  payload_hash text not null,
  payload jsonb not null,
  headers jsonb not null default '{}'::jsonb,
  signature_valid boolean,
  status public.webhook_event_status not null default 'received',
  error text,
  remote_ip inet,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create unique index provider_webhook_events_event_idx on public.provider_webhook_events (provider_key, event_id) where event_id is not null;
create unique index provider_webhook_events_hash_idx on public.provider_webhook_events (provider_key, payload_hash);
create index provider_webhook_events_status_idx on public.provider_webhook_events (status, received_at) where status in ('received', 'queued');
