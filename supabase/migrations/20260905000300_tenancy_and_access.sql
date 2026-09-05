-- FlowZa Time · 0300 · organisations, users, platform admins, roles & permissions, memberships
create type public.org_status as enum ('trial', 'active', 'suspended', 'closed');
create type public.membership_status as enum ('invited', 'active', 'suspended');
create type public.platform_admin_level as enum ('support', 'admin', 'owner');
create type public.grant_access_level as enum ('read', 'write');
create type public.login_event as enum ('success', 'failed', 'logout', 'mfa_challenge', 'password_reset');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  company_code extensions.citext not null unique,
  legal_name text not null,
  display_name text not null,
  country_code char(2) not null default 'OM',
  timezone text not null default 'Asia/Muscat',
  currency_code char(3) not null default 'OMR',
  locale text not null default 'en',
  weekly_off_days smallint[] not null default '{5,6}' check (weekly_off_days <@ '{0,1,2,3,4,5,6}'::smallint[]),
  logo_path text,
  contact jsonb not null default '{}'::jsonb check (jsonb_typeof(contact) = 'object'),
  address jsonb not null default '{}'::jsonb check (jsonb_typeof(address) = 'object'),
  status public.org_status not null default 'trial',
  region_cell text not null default 'default',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_company_code_format check (company_code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$')
);
create trigger organizations_updated_at before update on public.organizations for each row execute function app.set_updated_at();
create trigger organizations_timezone before insert or update of timezone on public.organizations for each row execute function app.validate_timezone_column();
create index organizations_status_idx on public.organizations (status);

create table public.organization_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  general jsonb not null default '{}'::jsonb check (jsonb_typeof(general) = 'object'),
  attendance jsonb not null default '{}'::jsonb check (jsonb_typeof(attendance) = 'object'),
  sync jsonb not null default '{}'::jsonb check (jsonb_typeof(sync) = 'object'),
  notifications jsonb not null default '{}'::jsonb check (jsonb_typeof(notifications) = 'object'),
  security jsonb not null default '{}'::jsonb check (jsonb_typeof(security) = 'object'),
  integrations jsonb not null default '{}'::jsonb check (jsonb_typeof(integrations) = 'object'),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
create trigger organization_settings_updated_at before update on public.organization_settings for each row execute function app.set_updated_at();

-- Profile row per auth user (created by the API on first sign-in / invitation acceptance).
create table public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email extensions.citext not null,
  full_name text not null default '',
  avatar_path text,
  locale text not null default 'en',
  status text not null default 'active' check (status in ('active', 'disabled')),
  mfa_enrolled boolean not null default false,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index user_profiles_email_idx on public.user_profiles (email);
create trigger user_profiles_updated_at before update on public.user_profiles for each row execute function app.set_updated_at();

create table public.platform_admins (
  user_id uuid primary key references public.user_profiles(id) on delete cascade,
  level public.platform_admin_level not null default 'support',
  status text not null default 'active' check (status in ('active', 'disabled')),
  granted_by uuid references public.user_profiles(id),
  created_at timestamptz not null default now()
);

-- Reason-based, time-boxed access of platform staff to a tenant's data (§91).
create table public.platform_access_grants (
  id uuid primary key default gen_random_uuid(),
  platform_admin_user_id uuid not null references public.platform_admins(user_id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  access_level public.grant_access_level not null default 'read',
  reason text not null check (length(reason) >= 10),
  ticket_ref text,
  granted_by uuid references public.user_profiles(id),
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint platform_access_grants_window check (expires_at > starts_at and expires_at <= starts_at + interval '30 days')
);
create index platform_access_grants_admin_idx on public.platform_access_grants (platform_admin_user_id, organization_id) where revoked_at is null;

-- Permissions vocabulary (seeded reference data) ------------------------------------------------
create table public.permissions (
  key text primary key check (key ~ '^[a-z_]+\.[a-z_]+$'),
  category text not null,
  description text not null,
  sort_order int not null default 0
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade, -- null = system role
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  name text not null,
  description text,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index roles_org_key_idx on public.roles (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), key);
create trigger roles_updated_at before update on public.roles for each row execute function app.set_updated_at();

create table public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_key text not null references public.permissions(key) on delete cascade,
  primary key (role_id, permission_key)
);

create table public.org_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  role_id uuid not null references public.roles(id),
  status public.membership_status not null default 'active',
  all_branches boolean not null default true,
  employee_id uuid, -- FK added after employees exists
  invited_by uuid references public.user_profiles(id),
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index org_memberships_user_idx on public.org_memberships (user_id, status);
create index org_memberships_role_idx on public.org_memberships (role_id);
create trigger org_memberships_updated_at before update on public.org_memberships for each row execute function app.set_updated_at();

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email extensions.citext not null,
  role_id uuid not null references public.roles(id),
  all_branches boolean not null default true,
  branch_ids uuid[] not null default '{}',
  token_hash text not null unique,
  invited_by uuid references public.user_profiles(id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references public.user_profiles(id),
  created_at timestamptz not null default now()
);
create index invitations_org_email_idx on public.invitations (organization_id, email) where accepted_at is null;

create table public.login_history (
  id bigint generated always as identity primary key,
  user_id uuid references public.user_profiles(id) on delete set null,
  email extensions.citext,
  event public.login_event not null,
  ip inet,
  user_agent text,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index login_history_user_idx on public.login_history (user_id, occurred_at desc);
create trigger login_history_append_only before update or delete on public.login_history for each row execute function app.reject_modification();
