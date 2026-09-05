-- FlowZa Time · 0400 · branches, departments, designations, teams, membership branch scope
create type public.record_status as enum ('active', 'inactive', 'archived');

create table public.branches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code extensions.citext not null,
  name text not null,
  name_ar text,
  country_code char(2) not null default 'OM',
  city text,
  address jsonb not null default '{}'::jsonb check (jsonb_typeof(address) = 'object'),
  timezone text not null default 'Asia/Muscat',
  latitude numeric(9,6) check (latitude between -90 and 90),
  longitude numeric(9,6) check (longitude between -180 and 180),
  geofence_radius_m int check (geofence_radius_m is null or geofence_radius_m between 10 and 5000),
  contact jsonb not null default '{}'::jsonb check (jsonb_typeof(contact) = 'object'),
  weekly_off_days smallint[] check (weekly_off_days is null or weekly_off_days <@ '{0,1,2,3,4,5,6}'::smallint[]),
  holiday_calendar_id uuid, -- FK added in 1000
  status public.record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code),
  unique (id, organization_id) -- enables composite FKs that carry organization_id
);
create index branches_org_status_idx on public.branches (organization_id, status);
create trigger branches_updated_at before update on public.branches for each row execute function app.set_updated_at();
create trigger branches_timezone before insert or update of timezone on public.branches for each row execute function app.validate_timezone_column();

create table public.membership_branches (
  membership_id uuid not null references public.org_memberships(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  primary key (membership_id, branch_id)
);
create index membership_branches_branch_idx on public.membership_branches (branch_id);

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid, -- null = organisation-wide department
  parent_id uuid references public.departments(id) on delete set null,
  code extensions.citext not null,
  name text not null,
  name_ar text,
  manager_employee_id uuid, -- FK added in 0600
  status public.record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code),
  unique (id, organization_id),
  foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete set null (branch_id)
);
create index departments_org_branch_idx on public.departments (organization_id, branch_id);
create trigger departments_updated_at before update on public.departments for each row execute function app.set_updated_at();

create table public.designations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code extensions.citext not null,
  name text not null,
  name_ar text,
  level int not null default 0,
  status public.record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code),
  unique (id, organization_id)
);
create trigger designations_updated_at before update on public.designations for each row execute function app.set_updated_at();

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid,
  code extensions.citext not null,
  name text not null,
  lead_employee_id uuid, -- FK added in 0600
  status public.record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code),
  unique (id, organization_id),
  foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete set null (branch_id)
);
create trigger teams_updated_at before update on public.teams for each row execute function app.set_updated_at();
