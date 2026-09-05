-- FlowZa Time · 1200 · report requests, imports, notifications, append-only audit log
create type public.report_format as enum ('csv', 'xlsx', 'pdf');
create type public.report_status as enum ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED');
create type public.import_status as enum ('UPLOADED', 'VALIDATING', 'VALIDATED', 'IMPORTING', 'COMPLETED', 'FAILED', 'CANCELLED');
create type public.import_row_status as enum ('valid', 'invalid', 'imported', 'skipped', 'failed');
create type public.notification_category as enum ('DEVICE', 'ATTENDANCE', 'APPROVAL', 'SYSTEM', 'SUBSCRIPTION');
create type public.notification_channel as enum ('IN_APP', 'EMAIL', 'SMS', 'WHATSAPP', 'PUSH');
create type public.delivery_status as enum ('pending', 'sent', 'failed', 'skipped');
create type audit.actor_type as enum ('USER', 'SYSTEM', 'PLATFORM_ADMIN', 'API_KEY', 'DEVICE');

create table public.report_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  report_type text not null check (report_type ~ '^[a-z_]{3,64}$'),
  parameters jsonb not null default '{}'::jsonb check (jsonb_typeof(parameters) = 'object'),
  branch_id uuid, -- scope for branch-restricted requesters
  format public.report_format not null default 'xlsx',
  status public.report_status not null default 'QUEUED',
  file_path text,
  file_size_bytes bigint,
  row_count int,
  error text,
  queue_job_id bigint,
  requested_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz
);
create index report_requests_org_idx on public.report_requests (organization_id, created_at desc);
create index report_requests_user_idx on public.report_requests (requested_by, created_at desc);

create table public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  type text not null check (type in ('EMPLOYEES')),
  file_path text not null,
  original_filename text,
  status public.import_status not null default 'UPLOADED',
  total_rows int not null default 0,
  valid_rows int not null default 0,
  error_rows int not null default 0,
  imported_rows int not null default 0,
  options jsonb not null default '{}'::jsonb,
  summary jsonb,
  error text,
  queue_job_id bigint,
  requested_by uuid references public.user_profiles(id) on delete set null,
  confirmed_by uuid references public.user_profiles(id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index import_jobs_org_idx on public.import_jobs (organization_id, created_at desc);
create trigger import_jobs_updated_at before update on public.import_jobs for each row execute function app.set_updated_at();

create table public.import_job_rows (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  import_job_id uuid not null references public.import_jobs(id) on delete cascade,
  row_no int not null,
  data jsonb not null,
  errors jsonb not null default '[]'::jsonb,
  status public.import_row_status not null default 'valid',
  entity_id uuid,
  unique (import_job_id, row_no)
);
create index import_job_rows_status_idx on public.import_job_rows (import_job_id, status);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  category public.notification_category not null,
  type text not null,
  title text not null,
  body text,
  data jsonb not null default '{}'::jsonb,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_user_unread_idx on public.notifications (user_id) where read_at is null;

create table public.notification_preferences (
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  category public.notification_category not null,
  channel public.notification_channel not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, organization_id, category, channel)
);

create table public.notification_deliveries (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations(id) on delete cascade,
  notification_id uuid not null references public.notifications(id) on delete cascade,
  channel public.notification_channel not null,
  status public.delivery_status not null default 'pending',
  provider text,
  provider_message_id text,
  error text,
  attempts int not null default 0,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index notification_deliveries_pending_idx on public.notification_deliveries (status, created_at) where status = 'pending';

-- Append-only audit log (§52). Platform-level events have organization_id null.
create table audit.logs (
  id bigint generated always as identity primary key,
  organization_id uuid,
  actor_user_id uuid,
  actor_type audit.actor_type not null default 'USER',
  actor_label text,
  action text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  entity_type text not null,
  entity_id text,
  branch_id uuid,
  old_value jsonb,
  new_value jsonb,
  reason text,
  ip inet,
  user_agent text,
  request_id text,
  job_id bigint,
  created_at timestamptz not null default now()
);
create index audit_logs_org_time_idx on audit.logs (organization_id, created_at desc);
create index audit_logs_entity_idx on audit.logs (organization_id, entity_type, entity_id);
create index audit_logs_actor_idx on audit.logs (actor_user_id, created_at desc);
create index audit_logs_action_idx on audit.logs (organization_id, action, created_at desc);
create trigger audit_logs_append_only before update or delete on audit.logs for each row execute function app.reject_modification();
