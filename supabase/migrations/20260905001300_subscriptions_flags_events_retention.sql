-- FlowZa Time · 1300 · plans, subscriptions, entitlements, usage, feature flags, api keys, outbox, retention
create type public.subscription_status as enum ('trialing', 'active', 'past_due', 'cancelled', 'expired');
create type public.entitlement_source as enum ('plan', 'override');

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z][a-z0-9_]{1,31}$'),
  name text not null,
  description text,
  prices jsonb not null default '{}'::jsonb check (jsonb_typeof(prices) = 'object'), -- {"OMR": {"monthly": 0, "yearly": 0}} — never hard-coded in code
  limits jsonb not null default '{}'::jsonb check (jsonb_typeof(limits) = 'object'),  -- {"employees": 100, "devices": 10, "branches": 5, "users": 10, "storage_mb": 1024, "api_calls_month": 100000, "raw_retention_days": 730}
  features text[] not null default '{}',
  is_active boolean not null default true,
  sort_order int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger plans_updated_at before update on public.plans for each row execute function app.set_updated_at();

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  plan_id uuid not null references public.plans(id),
  status public.subscription_status not null default 'trialing',
  trial_ends_at timestamptz,
  current_period_start timestamptz not null default now(),
  current_period_end timestamptz,
  cancel_at timestamptz,
  external_customer_ref text,
  external_subscription_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger subscriptions_updated_at before update on public.subscriptions for each row execute function app.set_updated_at();

create table public.entitlements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  key text not null,
  limit_value numeric,
  enabled boolean not null default true,
  source public.entitlement_source not null default 'override',
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, key, effective_from)
);

create table public.usage_records (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  metric text not null,
  period_start date not null,
  period_end date not null,
  value numeric not null default 0,
  updated_at timestamptz not null default now(),
  unique (organization_id, metric, period_start)
);

create table public.feature_flags (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  description text not null,
  default_enabled boolean not null default false,
  rollout_percentage int not null default 0 check (rollout_percentage between 0 and 100),
  updated_at timestamptz not null default now()
);

create table public.organization_feature_flags (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  flag_key text not null references public.feature_flags(key) on delete cascade,
  enabled boolean not null,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (organization_id, flag_key)
);

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  key_prefix text not null,
  key_hash text not null unique,
  scopes text[] not null default '{}',
  branch_ids uuid[],
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index api_keys_org_idx on public.api_keys (organization_id) where revoked_at is null;

-- Transactional outbox: domain events written with the state change, relayed by the worker to
-- notifications, realtime broadcast and (later) customer webhooks.
create table public.domain_events (
  id bigint generated always as identity primary key,
  organization_id uuid,
  event_type text not null check (event_type ~ '^[a-z_]+\.[a-z_]+$'),
  aggregate_type text not null,
  aggregate_id text,
  payload jsonb not null default '{}'::jsonb,
  actor_user_id uuid,
  request_id text,
  occurred_at timestamptz not null default now(),
  published_at timestamptz,
  publish_attempts int not null default 0,
  publish_error text
);
create index domain_events_unpublished_idx on public.domain_events (occurred_at) where published_at is null;
create index domain_events_org_idx on public.domain_events (organization_id, occurred_at desc);

create table public.outbound_webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  url text not null,
  secret_hash text not null,
  events text[] not null,
  status public.record_status not null default 'active',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger outbound_webhook_subscriptions_updated_at before update on public.outbound_webhook_subscriptions for each row execute function app.set_updated_at();

create table public.data_retention_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  data_class text not null check (data_class in ('raw_transactions', 'attendance_events', 'audit_logs', 'device_logs', 'sync_logs', 'report_files', 'notifications', 'import_files', 'login_history')),
  retention_days int check (retention_days is null or retention_days >= 30), -- null = keep forever
  enabled boolean not null default false,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  unique (organization_id, data_class)
);
