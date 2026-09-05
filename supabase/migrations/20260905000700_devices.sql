-- FlowZa Time · 0700 · providers, models, devices, credentials, groups, commands, logs
create type public.integration_type as enum ('VENDOR_CLOUD_PULL', 'VENDOR_WEBHOOK', 'DEVICE_PUSH', 'ON_PREM_SERVER_API', 'LAN');
create type public.provider_status as enum ('available', 'beta', 'placeholder', 'deprecated');
create type public.verification_status as enum ('VERIFIED', 'REPORTED', 'UNVERIFIED');
create type public.device_status as enum ('active', 'disabled', 'decommissioned');
create type public.connection_status as enum ('unknown', 'online', 'offline', 'degraded', 'error');
create type public.device_command_status as enum ('pending', 'sent', 'acked', 'failed', 'expired');
create type public.log_level as enum ('debug', 'info', 'warn', 'error');

alter table public.employee_provider_identities add constraint employee_provider_identities_provider_fk_placeholder check (provider_key ~ '^[a-z][a-z0-9_]{1,63}$');

create table public.device_providers (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  vendor text not null,
  name text not null,
  description text,
  integration_type public.integration_type not null,
  status public.provider_status not null default 'placeholder',
  capabilities jsonb not null default '{}'::jsonb check (jsonb_typeof(capabilities) = 'object'),
  config_schema jsonb not null default '{"fields":[]}'::jsonb check (jsonb_typeof(config_schema) = 'object'),
  throttling jsonb not null default '{}'::jsonb check (jsonb_typeof(throttling) = 'object'),
  verification_status public.verification_status not null default 'UNVERIFIED',
  docs_url text,
  sort_order int not null default 100,
  updated_at timestamptz not null default now()
);

create table public.device_models (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null references public.device_providers(key) on delete cascade,
  vendor text not null,
  model text not null,
  family text,
  capabilities jsonb not null default '{}'::jsonb check (jsonb_typeof(capabilities) = 'object'),
  verification public.verification_status not null default 'UNVERIFIED',
  notes text,
  unique (provider_key, model)
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  code extensions.citext not null,
  name text not null,
  provider_key text not null references public.device_providers(key),
  model_id uuid references public.device_models(id) on delete set null,
  manufacturer text not null,
  model_name text,
  serial_number text,
  vendor_device_id text,
  timezone text not null default 'Asia/Muscat',
  integration_type public.integration_type not null,
  endpoint_url text,
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  capabilities jsonb not null default '{}'::jsonb check (jsonb_typeof(capabilities) = 'object'),
  status public.device_status not null default 'active',
  connection_status public.connection_status not null default 'unknown',
  last_heartbeat_at timestamptz,
  last_attendance_sync_at timestamptz,
  last_employee_sync_at timestamptz,
  last_successful_communication_at timestamptz,
  last_error_code text,
  last_error text,
  last_error_at timestamptz,
  firmware_version text,
  device_time_offset_seconds int, -- measured clock skew (device - server)
  offline_threshold_minutes int not null default 15 check (offline_threshold_minutes between 1 and 1440),
  auto_sync_enabled boolean not null default true,
  sync_interval_minutes int not null default 5 check (sync_interval_minutes between 1 and 1440),
  adaptive_interval_minutes int,
  empty_poll_count int not null default 0,
  next_attendance_sync_at timestamptz,
  push_token_hash text,
  tags text[] not null default '{}',
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code),
  unique (id, organization_id),
  foreign key (branch_id, organization_id) references public.branches(id, organization_id)
);
create unique index devices_provider_serial_idx on public.devices (provider_key, serial_number) where serial_number is not null and status <> 'decommissioned';
create index devices_org_branch_idx on public.devices (organization_id, branch_id, status);
create index devices_org_connection_idx on public.devices (organization_id, connection_status);
create index devices_scheduler_idx on public.devices (next_attendance_sync_at) where auto_sync_enabled and status = 'active';
create index devices_tags_idx on public.devices using gin (tags);
create trigger devices_updated_at before update on public.devices for each row execute function app.set_updated_at();
create trigger devices_timezone before insert or update of timezone on public.devices for each row execute function app.validate_timezone_column();

-- Encrypted credentials. No client policies are ever created for this table (see 1400).
create table public.device_credentials (
  device_id uuid primary key references public.devices(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  key_id text not null,
  nonce bytea not null,
  ciphertext bytea not null,
  auth_tag bytea not null,
  masked jsonb not null default '{}'::jsonb check (jsonb_typeof(masked) = 'object'),
  version int not null default 1,
  rotated_at timestamptz,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger device_credentials_updated_at before update on public.device_credentials for each row execute function app.set_updated_at();

-- Devices that contacted a push endpoint but are not registered yet (zero-touch onboarding).
create table public.pending_devices (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null references public.device_providers(key),
  serial_number text not null,
  claim_code text not null,
  organization_id uuid references public.organizations(id) on delete cascade, -- set when the URL carried an org token
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  remote_ip inet,
  device_info jsonb not null default '{}'::jsonb,
  claimed_device_id uuid references public.devices(id) on delete set null,
  unique (provider_key, serial_number)
);

create table public.device_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid,
  name text not null,
  description text,
  color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name),
  foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete set null (branch_id)
);
create trigger device_groups_updated_at before update on public.device_groups for each row execute function app.set_updated_at();

create table public.device_group_members (
  group_id uuid not null references public.device_groups(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  primary key (group_id, device_id)
);
create index device_group_members_device_idx on public.device_group_members (organization_id, device_id);

-- Per-device employee mapping + synchronisation state (§34, §35).
create table public.device_employee_states (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete set null, -- null = exists on device, unknown in cloud
  branch_id uuid, -- device branch, denormalised for RLS
  device_user_id text not null,
  cloud_hash text,
  device_hash text,
  sync_status public.device_employee_sync_status not null default 'PENDING',
  desired boolean not null default true, -- should the employee exist on this device?
  last_sync_at timestamptz,
  last_success_at timestamptz,
  last_error_code text,
  last_error text,
  fingerprint_count int not null default 0,
  face_enrolled boolean not null default false,
  card_enrolled boolean not null default false,
  device_record jsonb, -- last snapshot from device (no biometric templates)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (device_id, device_user_id)
);
create unique index device_employee_states_device_employee_idx on public.device_employee_states (device_id, employee_id) where employee_id is not null;
create index device_employee_states_employee_idx on public.device_employee_states (organization_id, employee_id);
create index device_employee_states_status_idx on public.device_employee_states (device_id, sync_status);
create trigger device_employee_states_updated_at before update on public.device_employee_states for each row execute function app.set_updated_at();

-- Outbound commands for push-protocol devices that poll for work.
create table public.device_commands (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  command_type text not null,
  payload jsonb not null default '{}'::jsonb,
  status public.device_command_status not null default 'pending',
  sync_job_item_id uuid,
  sequence bigint generated always as identity,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  acked_at timestamptz,
  expires_at timestamptz not null default now() + interval '7 days',
  result jsonb
);
create index device_commands_pending_idx on public.device_commands (device_id, sequence) where status in ('pending', 'sent');

-- Device logs, partitioned monthly (retention by partition drop).
create table public.device_logs (
  id bigint generated always as identity,
  organization_id uuid not null,
  device_id uuid not null,
  level public.log_level not null default 'info',
  event text not null,
  message text,
  details jsonb,
  job_id uuid,
  created_at timestamptz not null default now(),
  primary key (id, created_at)
) partition by range (created_at);
create index device_logs_device_idx on public.device_logs (device_id, created_at desc);
create index device_logs_org_idx on public.device_logs (organization_id, created_at desc);

-- Partition maintenance helper used for all monthly partitioned tables.
create or replace function app.ensure_month_partitions(p_table regclass, p_from date, p_months int)
returns int language plpgsql as $$
declare
  v_schema text; v_table text; v_start date; v_end date; v_name text; v_created int := 0; i int;
begin
  select n.nspname, c.relname into v_schema, v_table from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = p_table;
  for i in 0 .. p_months - 1 loop
    v_start := date_trunc('month', p_from)::date + (i || ' months')::interval;
    v_end := v_start + interval '1 month';
    v_name := format('%s_%s', v_table, to_char(v_start, 'YYYYMM'));
    if to_regclass(format('%I.%I', v_schema, v_name)) is null then
      execute format('create table %I.%I partition of %I.%I for values from (%L) to (%L)', v_schema, v_name, v_schema, v_table, v_start, v_end);
      v_created := v_created + 1;
    end if;
  end loop;
  return v_created;
end $$;

create table public.device_logs_default partition of public.device_logs default;
select app.ensure_month_partitions('public.device_logs', '2025-01-01', 36);
