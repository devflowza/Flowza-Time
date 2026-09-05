-- FlowZa Time · 0600 · employee master, effective-dated employment history, identities
create type public.gender as enum ('male', 'female', 'other', 'unspecified');
create type public.employment_status as enum ('active', 'on_leave', 'suspended', 'terminated', 'resigned');
create type public.employment_type as enum ('full_time', 'part_time', 'contract', 'intern', 'temporary');
create type public.identity_document_type as enum ('civil_id', 'passport', 'labour_card', 'residence_card', 'visa', 'other');
create type public.device_employee_sync_status as enum ('PENDING', 'IN_SYNC', 'OUT_OF_SYNC', 'FAILED', 'OFFLINE', 'UNSUPPORTED', 'REMOVING', 'REMOVED');

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_number extensions.citext not null,
  first_name text not null,
  middle_name text,
  last_name text not null,
  display_name text not null,
  display_name_ar text,
  photo_path text,
  gender public.gender not null default 'unspecified',
  date_of_birth date,
  nationality_code char(2),
  email extensions.citext,
  phone text,
  joining_date date not null,
  exit_date date,
  employment_status public.employment_status not null default 'active',
  employment_type public.employment_type not null default 'full_time',
  branch_id uuid not null,
  department_id uuid,
  designation_id uuid,
  manager_employee_id uuid references public.employees(id) on delete set null,
  user_id uuid references public.user_profiles(id) on delete set null,
  device_user_id text not null,                 -- vendor-neutral default identity used on devices
  card_number text,
  pin_hash text,                                -- hashed; never store PINs in clear
  fingerprint_enrolled boolean not null default false,
  face_enrolled boolean not null default false,
  weekly_off_days smallint[] check (weekly_off_days is null or weekly_off_days <@ '{0,1,2,3,4,5,6}'::smallint[]),
  custom_fields jsonb not null default '{}'::jsonb check (jsonb_typeof(custom_fields) = 'object'),
  search tsvector generated always as (
    to_tsvector('simple', coalesce(employee_number::text, '') || ' ' || coalesce(first_name, '') || ' ' || coalesce(middle_name, '') || ' ' || coalesce(last_name, '') || ' ' || coalesce(display_name, '') || ' ' || coalesce(email::text, '') || ' ' || coalesce(device_user_id, ''))
  ) stored,
  deleted_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, employee_number),
  unique (organization_id, device_user_id),
  unique (id, organization_id),
  constraint employees_exit_after_join check (exit_date is null or exit_date >= joining_date),
  constraint employees_device_user_id_format check (device_user_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  foreign key (branch_id, organization_id) references public.branches(id, organization_id),
  foreign key (department_id, organization_id) references public.departments(id, organization_id) on delete set null (department_id),
  foreign key (designation_id, organization_id) references public.designations(id, organization_id) on delete set null (designation_id)
);
create index employees_org_branch_status_idx on public.employees (organization_id, branch_id, employment_status) where deleted_at is null;
create index employees_org_department_idx on public.employees (organization_id, department_id) where deleted_at is null;
create index employees_org_manager_idx on public.employees (organization_id, manager_employee_id);
create index employees_user_idx on public.employees (user_id) where user_id is not null;
create index employees_search_idx on public.employees using gin (search);
create index employees_display_name_trgm_idx on public.employees using gin (display_name extensions.gin_trgm_ops);
create trigger employees_updated_at before update on public.employees for each row execute function app.set_updated_at();

alter table public.org_memberships add constraint org_memberships_employee_fk foreign key (employee_id) references public.employees(id) on delete set null;
alter table public.departments add constraint departments_manager_fk foreign key (manager_employee_id) references public.employees(id) on delete set null;
alter table public.teams add constraint teams_lead_fk foreign key (lead_employee_id) references public.employees(id) on delete set null;

create table public.team_members (
  team_id uuid not null references public.teams(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (team_id, employee_id)
);
create index team_members_employee_idx on public.team_members (organization_id, employee_id);

-- Effective-dated employment history: the truth for "where did this employee work on date X".
create table public.employment_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  effective_from date not null,
  effective_to date, -- exclusive upper bound; null = current
  branch_id uuid not null references public.branches(id),
  department_id uuid references public.departments(id) on delete set null,
  designation_id uuid references public.designations(id) on delete set null,
  manager_employee_id uuid references public.employees(id) on delete set null,
  employment_type public.employment_type not null,
  employment_status public.employment_status not null,
  reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint employment_history_range check (effective_to is null or effective_to > effective_from),
  constraint employment_history_no_overlap exclude using gist (
    employee_id with =,
    daterange(effective_from, effective_to, '[)') with &&
  )
);
create index employment_history_employee_idx on public.employment_history (organization_id, employee_id, effective_from desc);

create table public.employee_identity_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  branch_id uuid, -- denormalised for branch-scoped RLS
  type public.identity_document_type not null,
  number text not null,
  issuing_country char(2),
  issued_at date,
  expires_at date,
  file_path text,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index employee_identity_documents_employee_idx on public.employee_identity_documents (organization_id, employee_id);
create index employee_identity_documents_expiry_idx on public.employee_identity_documents (organization_id, expires_at) where expires_at is not null;
create trigger employee_identity_documents_updated_at before update on public.employee_identity_documents for each row execute function app.set_updated_at();

-- Vendor-specific identity (e.g. ZKTeco user id 425 vs Hikvision employee no HK-7782).
create table public.employee_provider_identities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  provider_key text not null,
  device_user_id text not null,
  card_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, employee_id, provider_key),
  unique (organization_id, provider_key, device_user_id)
);
create trigger employee_provider_identities_updated_at before update on public.employee_provider_identities for each row execute function app.set_updated_at();
