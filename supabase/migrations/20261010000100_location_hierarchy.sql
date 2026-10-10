-- FlowZa Time · 20261010000100 · Location hierarchy (docs/locations.md, ADR-009). Additive and idempotent; one transaction;
-- ends with a post-verify block.
--
--  1. `location_levels` — 1–8 customer-named levels per organisation (English / Arabic, an icon), ordered by `position`
--     (1 = top). Exactly one has role `branch`: the operating unit = today's branches. Levels above it are `group` levels
--     (Headquarters, Region…), levels below it `place` levels (Site, Building, Floor, Zone…). Every organisation gets the
--     level "Branch / فرع" (backfill + a trigger for new organisations). A deferred check keeps the list contiguous and
--     ordered (groups < branch < places) and every location below its parent.
--  2. `locations` — one tree per organisation: adjacency list + materialised `path` (ids from the root, maintained by
--     triggers that derive the role, the branch and the path from the level and the parent — never from the client).
--     Group nodes (code + name), branch nodes (one per branch, created by a trigger on branches and backfilled; name,
--     code and status stay on the branch) and place nodes (code + name, always under their branch).
--  3. Place references with composite foreign keys `(location_id, branch_id, organization_id)` so a reference never points
--     into another branch: `devices.location_id`, `employees.work_location_id`, `geofences.location_id`,
--     `shift_coverage_requirements.location_id` (Enterprise), and `attendance_rule_sets.location_id` (Enterprise policy
--     scope: a group node, or a place with branch_id = its branch). A guard trigger clears a place reference when the row
--     changes branch (no writer of branch_id can break the key) and refuses a reference to a group / branch node.
--  4. RLS: read with branch.view (group nodes, or nodes of an allowed branch); write with branch.manage — group / branch
--     nodes and the levels for members with every branch only, place nodes for the members whose scope holds the branch.
set lock_timeout = '5s';
set statement_timeout = '120s';
set client_min_messages = warning;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Levels
-- ---------------------------------------------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'location_level_role') then
    create type public.location_level_role as enum ('group', 'branch', 'place');
  end if;
end $$;

create table if not exists public.location_levels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  position smallint not null check (position between 1 and 8),
  role public.location_level_role not null,
  name text not null check (length(btrim(name)) between 1 and 60),
  name_ar text check (name_ar is null or length(btrim(name_ar)) between 1 and 60),
  -- presentation hint (@flowza/contracts LOCATION_LEVEL_ICONS)
  icon text not null default 'other' check (icon in ('headquarters', 'region', 'country', 'city', 'branch', 'store', 'site', 'campus', 'building',
    'floor', 'zone', 'area', 'section', 'room', 'line', 'station', 'post', 'ward', 'warehouse', 'other')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- deferrable: inserting / deleting a level shifts the positions below it in one statement
  constraint location_levels_position_key unique (organization_id, position) deferrable initially immediate,
  constraint location_levels_id_organization_id_key unique (id, organization_id)
);
comment on table public.location_levels is 'Customer-named location levels of an organisation (docs/locations.md): groups above the branch level, places below it.';
create unique index if not exists location_levels_one_branch_level on public.location_levels (organization_id) where role = 'branch';
drop trigger if exists location_levels_updated_at on public.location_levels;
create trigger location_levels_updated_at before update on public.location_levels for each row execute function app.set_updated_at();

-- a level keeps its role (its locations' shape depends on it)
create or replace function app.location_levels_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.role is distinct from old.role then
    raise exception 'a location level keeps its role (%)', old.role using errcode = '22023';
  end if;
  return new;
end $$;
revoke execute on function app.location_levels_guard() from public, anon;
drop trigger if exists location_levels_guard on public.location_levels;
create trigger location_levels_guard before update on public.location_levels for each row execute function app.location_levels_guard();

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Locations
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  level_id uuid not null,
  -- the level's role, set by the shape trigger
  role public.location_level_role not null,
  parent_id uuid,
  -- branch nodes: the branch; place nodes: the branch they belong to (shape trigger); group nodes: null
  branch_id uuid,
  code extensions.citext check (code is null or code::text ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$'),
  name text check (name is null or length(btrim(name)) between 1 and 120),
  name_ar text check (name_ar is null or length(btrim(name_ar)) between 1 and 120),
  latitude numeric(9,6) check (latitude is null or latitude between -90 and 90),
  longitude numeric(9,6) check (longitude is null or longitude between -180 and 180),
  -- ids from the root to this node (inclusive), maintained by the shape / cascade triggers
  path uuid[] not null,
  depth smallint generated always as (cardinality(path)::smallint) stored,
  status public.record_status not null default 'active',
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint locations_id_organization_id_key unique (id, organization_id),
  -- the target of the place references: a reference carries the branch, so it cannot point into another branch
  constraint locations_id_branch_id_organization_id_key unique (id, branch_id, organization_id),
  constraint locations_level_fkey foreign key (level_id, organization_id) references public.location_levels(id, organization_id),
  constraint locations_parent_fkey foreign key (parent_id, organization_id) references public.locations(id, organization_id),
  constraint locations_branch_fkey foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete cascade,
  constraint locations_not_own_parent check (parent_id is null or parent_id <> id),
  constraint locations_point check ((latitude is null) = (longitude is null)),
  constraint locations_shape check (
    (role = 'branch' and branch_id is not null and code is null and name is null and name_ar is null and latitude is null)
    or (role = 'group' and branch_id is null and code is not null and name is not null)
    or (role = 'place' and branch_id is not null and parent_id is not null and code is not null and name is not null))
);
comment on table public.locations is 'The location tree of an organisation (docs/locations.md): group nodes, one node per branch, place nodes.';
create index if not exists locations_org_parent_idx on public.locations (organization_id, parent_id);
create index if not exists locations_org_level_idx on public.locations (organization_id, level_id);
create index if not exists locations_org_branch_idx on public.locations (organization_id, branch_id) where branch_id is not null;
create index if not exists locations_path_gin on public.locations using gin (path);
create index if not exists locations_created_by_fk_idx on public.locations (created_by) where created_by is not null;
create unique index if not exists locations_branch_node_key on public.locations (branch_id) where role = 'branch';
-- codes are unique among siblings (top-level nodes among themselves)
create unique index if not exists locations_sibling_code_key on public.locations (organization_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), code) where code is not null;
drop trigger if exists locations_updated_at on public.locations;
create trigger locations_updated_at before update on public.locations for each row execute function app.set_updated_at();

-- The shape of a node comes from its level and its parent: role, branch and path are derived here (a client's values are
-- ignored). SECURITY DEFINER: the parent and the levels are read whatever the caller may see — row security still decides
-- whether the resulting row may be written.
create or replace function app.locations_shape() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_level record;
  v_parent record;
begin
  select l.role, l.position into v_level from public.location_levels l where l.id = new.level_id and l.organization_id = new.organization_id;
  if not found then
    raise exception 'location level % does not belong to this organisation', new.level_id using errcode = '23503';
  end if;
  if tg_op = 'UPDATE' then
    if v_level.role is distinct from old.role then
      raise exception 'a location keeps its kind (%): choose a level of the same kind', old.role using errcode = '22023';
    end if;
    if old.role = 'branch' and new.branch_id is distinct from old.branch_id then
      raise exception 'a branch location belongs to its branch' using errcode = '22023';
    end if;
  end if;
  new.role := v_level.role;

  if new.parent_id is null then
    if new.role = 'place' then
      raise exception 'a place sits under a branch or another place' using errcode = '22023';
    end if;
    new.path := array[new.id];
  else
    select p.role, p.branch_id, p.path, pl.position into v_parent
    from public.locations p join public.location_levels pl on pl.id = p.level_id
    where p.id = new.parent_id and p.organization_id = new.organization_id;
    if not found then
      raise exception 'parent location % does not belong to this organisation', new.parent_id using errcode = '23503';
    end if;
    if new.id = any (v_parent.path) then
      raise exception 'a location cannot move under itself or one of the locations below it' using errcode = '22023';
    end if;
    if v_parent.position >= v_level.position then
      raise exception 'a location sits on a deeper level than its parent' using errcode = '22023';
    end if;
    if new.role in ('group', 'branch') and v_parent.role <> 'group' then
      raise exception 'a % location sits under a group location (or at the top)', new.role using errcode = '22023';
    end if;
    if new.role = 'place' and v_parent.role = 'group' then
      raise exception 'a place sits under a branch or another place' using errcode = '22023';
    end if;
    if new.role = 'place' then
      new.branch_id := v_parent.branch_id;
    end if;
    new.path := v_parent.path || new.id;
  end if;
  if new.role = 'group' then
    new.branch_id := null;
  end if;

  -- a re-levelled node stays above every child
  if tg_op = 'UPDATE' and new.level_id is distinct from old.level_id and exists (
    select 1 from public.locations c join public.location_levels cl on cl.id = c.level_id
    where c.parent_id = new.id and c.organization_id = new.organization_id and cl.position <= v_level.position) then
    raise exception 'a location stays on a higher level than the locations below it' using errcode = '22023';
  end if;
  return new;
end $$;
revoke execute on function app.locations_shape() from public, anon;
drop trigger if exists locations_shape on public.locations;
create trigger locations_shape before insert or update on public.locations for each row execute function app.locations_shape();

-- A moved node (or a place that changed branch) re-derives its children, which re-derive theirs: every row recomputes its
-- path from its already-updated parent, whatever order the rows are visited in.
create or replace function app.locations_cascade() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.path is distinct from old.path or new.branch_id is distinct from old.branch_id then
    update public.locations c set parent_id = c.parent_id where c.parent_id = new.id and c.organization_id = new.organization_id;
  end if;
  return null;
end $$;
revoke execute on function app.locations_cascade() from public, anon;
drop trigger if exists locations_cascade on public.locations;
create trigger locations_cascade after update on public.locations for each row execute function app.locations_cascade();

-- The level list of an organisation stays well formed (checked at commit: a level insert / delete shifts positions in
-- several statements): contiguous positions from 1, exactly one branch level, groups above it, places below it, and every
-- location on a deeper level than its parent.
create or replace function app.location_levels_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := coalesce(new.organization_id, old.organization_id);
  v_n int; v_min int; v_max int; v_branches int; v_branch_pos int;
begin
  if not exists (select 1 from public.organizations o where o.id = v_org) then
    return null; -- the organisation is being deleted
  end if;
  select count(*), min(position), max(position), count(*) filter (where role = 'branch'), max(position) filter (where role = 'branch')
  into v_n, v_min, v_max, v_branches, v_branch_pos
  from public.location_levels where organization_id = v_org;
  if v_branches <> 1 then
    raise exception 'an organisation has exactly one branch level' using errcode = '23514';
  end if;
  if v_min <> 1 or v_max <> v_n then
    raise exception 'location levels are numbered 1..% without gaps', v_n using errcode = '23514';
  end if;
  if exists (select 1 from public.location_levels where organization_id = v_org and ((role = 'group' and position > v_branch_pos) or (role = 'place' and position < v_branch_pos))) then
    raise exception 'group levels sit above the branch level and place levels below it' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.locations c
    join public.locations p on p.id = c.parent_id
    join public.location_levels cl on cl.id = c.level_id
    join public.location_levels pl on pl.id = p.level_id
    where c.organization_id = v_org and cl.position <= pl.position) then
    raise exception 'a location would sit on a level above its parent' using errcode = '23514';
  end if;
  return null;
end $$;
revoke execute on function app.location_levels_check() from public, anon;
drop trigger if exists location_levels_check on public.location_levels;
create constraint trigger location_levels_check after insert or update or delete on public.location_levels
  deferrable initially deferred for each row execute function app.location_levels_check();

-- Every organisation has its branch level; every branch its node.
create or replace function app.organizations_location_level() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.location_levels (organization_id, position, role, name, name_ar, icon)
  values (new.id, 1, 'branch', 'Branch', 'فرع', 'branch')
  on conflict (organization_id) where role = 'branch' do nothing;
  return null;
end $$;
revoke execute on function app.organizations_location_level() from public, anon;
drop trigger if exists organizations_location_level on public.organizations;
create trigger organizations_location_level after insert on public.organizations for each row execute function app.organizations_location_level();

create or replace function app.branches_location_node() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_level uuid;
begin
  select l.id into v_level from public.location_levels l where l.organization_id = new.organization_id and l.role = 'branch';
  if v_level is null then
    insert into public.location_levels (organization_id, position, role, name, name_ar, icon)
    values (new.organization_id, 1, 'branch', 'Branch', 'فرع', 'branch') returning id into v_level;
  end if;
  insert into public.locations (organization_id, level_id, role, branch_id, path)
  values (new.organization_id, v_level, 'branch', new.id, '{}')
  on conflict (branch_id) where role = 'branch' do nothing;
  return null;
end $$;
revoke execute on function app.branches_location_node() from public, anon;
drop trigger if exists branches_location_node on public.branches;
create trigger branches_location_node after insert on public.branches for each row execute function app.branches_location_node();

-- backfill: the branch level of every organisation, the node of every branch (top level)
insert into public.location_levels (organization_id, position, role, name, name_ar, icon)
select o.id, 1, 'branch', 'Branch', 'فرع', 'branch' from public.organizations o
where not exists (select 1 from public.location_levels l where l.organization_id = o.id)
on conflict (organization_id) where role = 'branch' do nothing;
insert into public.locations (organization_id, level_id, role, branch_id, path)
select b.organization_id, l.id, 'branch', b.id, '{}'
from public.branches b join public.location_levels l on l.organization_id = b.organization_id and l.role = 'branch'
where not exists (select 1 from public.locations x where x.branch_id = b.id and x.role = 'branch')
on conflict (branch_id) where role = 'branch' do nothing;

-- RLS: read with branch.view (group nodes, or the nodes of an allowed branch); write with branch.manage — levels, group and
-- branch nodes for members with every branch, place nodes for members whose scope holds their branch
alter table public.location_levels enable row level security;
grant select, insert, update, delete on public.location_levels to authenticated, flowza_system;
drop policy if exists location_levels_select on public.location_levels;
drop policy if exists location_levels_insert on public.location_levels;
drop policy if exists location_levels_update on public.location_levels;
drop policy if exists location_levels_delete on public.location_levels;
create policy location_levels_select on public.location_levels for select to authenticated, flowza_system using (
  organization_id = any ((select app.org_ids_with_permission('branch.view'))::uuid[]));
create policy location_levels_insert on public.location_levels for insert to authenticated, flowza_system with check (
  organization_id = any ((select app.org_ids_with_permission('branch.manage'))::uuid[]) and organization_id = any ((select app.unrestricted_org_ids())::uuid[]));
create policy location_levels_update on public.location_levels for update to authenticated, flowza_system using (
  organization_id = any ((select app.org_ids_with_permission('branch.manage'))::uuid[]) and organization_id = any ((select app.unrestricted_org_ids())::uuid[])
) with check (
  organization_id = any ((select app.org_ids_with_permission('branch.manage'))::uuid[]) and organization_id = any ((select app.unrestricted_org_ids())::uuid[]));
create policy location_levels_delete on public.location_levels for delete to authenticated, flowza_system using (
  organization_id = any ((select app.org_ids_with_permission('branch.manage'))::uuid[]) and organization_id = any ((select app.unrestricted_org_ids())::uuid[]));
call app.enforce_tenant_table('public.location_levels');

alter table public.locations enable row level security;
grant select, insert, update, delete on public.locations to authenticated, flowza_system;
drop policy if exists locations_select on public.locations;
drop policy if exists locations_insert on public.locations;
drop policy if exists locations_update on public.locations;
drop policy if exists locations_delete on public.locations;
create policy locations_select on public.locations for select to authenticated, flowza_system using (
  organization_id = any ((select app.org_ids_with_permission('branch.view'))::uuid[])
  and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or branch_id is null or branch_id = any ((select app.allowed_branch_ids())::uuid[])));
create policy locations_insert on public.locations for insert to authenticated, flowza_system with check (
  organization_id = any ((select app.org_ids_with_permission('branch.manage'))::uuid[])
  and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or (role = 'place' and branch_id = any ((select app.allowed_branch_ids())::uuid[]))));
create policy locations_update on public.locations for update to authenticated, flowza_system using (
  organization_id = any ((select app.org_ids_with_permission('branch.manage'))::uuid[])
  and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or (role = 'place' and branch_id = any ((select app.allowed_branch_ids())::uuid[])))
) with check (
  organization_id = any ((select app.org_ids_with_permission('branch.manage'))::uuid[])
  and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or (role = 'place' and branch_id = any ((select app.allowed_branch_ids())::uuid[]))));
create policy locations_delete on public.locations for delete to authenticated, flowza_system using (
  organization_id = any ((select app.org_ids_with_permission('branch.manage'))::uuid[])
  and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or (role = 'place' and branch_id = any ((select app.allowed_branch_ids())::uuid[]))));
call app.enforce_tenant_table('public.locations');

-- ---------------------------------------------------------------------------------------------------------------------------
-- 3. Place references
-- ---------------------------------------------------------------------------------------------------------------------------
-- One guard for every table that points at a place (TG_ARGV[0] = the column): a row that changes branch drops a place of
-- the old branch it still points at, and a reference must be a PLACE (the composite key already pins it to the branch).
create or replace function app.place_reference_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_col text := tg_argv[0];
  v_ref uuid;
  v_role public.location_level_role;
begin
  if tg_op = 'UPDATE' and new.branch_id is distinct from old.branch_id
     and (to_jsonb(new) -> v_col) is not distinct from (to_jsonb(old) -> v_col) then
    new := jsonb_populate_record(new, jsonb_build_object(v_col, null));
  end if;
  v_ref := (to_jsonb(new) ->> v_col)::uuid;
  if v_ref is not null then
    select l.role into v_role from public.locations l where l.id = v_ref and l.organization_id = new.organization_id;
    if v_role is distinct from 'place' then
      raise exception 'choose a place (site, floor, zone…) of the branch for %', v_col using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
revoke execute on function app.place_reference_guard() from public, anon;

-- devices: where the terminal is installed
alter table public.devices add column if not exists location_id uuid;
alter table public.devices drop constraint if exists devices_location_fkey;
alter table public.devices add constraint devices_location_fkey foreign key (location_id, branch_id, organization_id) references public.locations(id, branch_id, organization_id) not valid;
alter table public.devices validate constraint devices_location_fkey;
create index if not exists devices_location_idx on public.devices (organization_id, location_id, branch_id) where location_id is not null;
drop trigger if exists devices_place_reference on public.devices;
create trigger devices_place_reference before insert or update of branch_id, location_id on public.devices for each row execute function app.place_reference_guard('location_id');

-- employees: where the employee works inside their branch (current; changes are audited)
alter table public.employees add column if not exists work_location_id uuid;
alter table public.employees drop constraint if exists employees_work_location_fkey;
alter table public.employees add constraint employees_work_location_fkey foreign key (work_location_id, branch_id, organization_id) references public.locations(id, branch_id, organization_id) not valid;
alter table public.employees validate constraint employees_work_location_fkey;
create index if not exists employees_work_location_idx on public.employees (organization_id, work_location_id, branch_id) where work_location_id is not null;
drop trigger if exists employees_place_reference on public.employees;
create trigger employees_place_reference before insert or update of branch_id, work_location_id on public.employees for each row execute function app.place_reference_guard('work_location_id');

-- geofences: the place a fence outlines (an organisation-wide fence has no place)
alter table public.geofences add column if not exists location_id uuid;
alter table public.geofences drop constraint if exists geofences_location_fkey;
alter table public.geofences add constraint geofences_location_fkey foreign key (location_id, branch_id, organization_id) references public.locations(id, branch_id, organization_id);
alter table public.geofences drop constraint if exists geofences_location_needs_branch;
alter table public.geofences add constraint geofences_location_needs_branch check (location_id is null or branch_id is not null);
create index if not exists geofences_location_idx on public.geofences (organization_id, location_id, branch_id) where location_id is not null;
drop trigger if exists geofences_place_reference on public.geofences;
create trigger geofences_place_reference before insert or update of branch_id, location_id on public.geofences for each row execute function app.place_reference_guard('location_id');

-- coverage targets per place (Enterprise, advanced_scheduling): null = the whole branch
alter table public.shift_coverage_requirements add column if not exists location_id uuid;
alter table public.shift_coverage_requirements drop constraint if exists shift_coverage_requirements_location_fkey;
alter table public.shift_coverage_requirements add constraint shift_coverage_requirements_location_fkey foreign key (location_id, branch_id, organization_id) references public.locations(id, branch_id, organization_id) on delete cascade;
alter table public.shift_coverage_requirements drop constraint if exists shift_coverage_requirements_unique;
alter table public.shift_coverage_requirements add constraint shift_coverage_requirements_unique unique nulls not distinct (organization_id, branch_id, shift_id, location_id);
create index if not exists shift_coverage_requirements_location_idx on public.shift_coverage_requirements (organization_id, location_id, branch_id) where location_id is not null;
drop trigger if exists shift_coverage_requirements_place_reference on public.shift_coverage_requirements;
create trigger shift_coverage_requirements_place_reference before insert or update of branch_id, location_id on public.shift_coverage_requirements for each row execute function app.place_reference_guard('location_id');

-- attendance policies scoped by location (Enterprise, attendance_policies): a group node (branch_id null) or a place with
-- branch_id = its branch (the composite key; branch-scoped administrators manage the place policies of their branches)
alter table public.attendance_rule_sets add column if not exists location_id uuid;
alter table public.attendance_rule_sets drop constraint if exists attendance_rule_sets_location_fkey;
alter table public.attendance_rule_sets add constraint attendance_rule_sets_location_fkey foreign key (location_id, organization_id) references public.locations(id, organization_id);
alter table public.attendance_rule_sets drop constraint if exists attendance_rule_sets_location_branch_fkey;
alter table public.attendance_rule_sets add constraint attendance_rule_sets_location_branch_fkey foreign key (location_id, branch_id, organization_id) references public.locations(id, branch_id, organization_id);
create index if not exists attendance_rule_sets_location_idx on public.attendance_rule_sets (organization_id, location_id, branch_id) where location_id is not null;

create or replace function app.attendance_rule_sets_location() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_role public.location_level_role;
  v_branch uuid;
begin
  if new.location_id is null then
    return new;
  end if;
  select l.role, l.branch_id into v_role, v_branch from public.locations l where l.id = new.location_id and l.organization_id = new.organization_id;
  if v_role = 'branch' or v_role is null then
    raise exception 'a policy names a branch through branch_id; location_id is a group location or a place' using errcode = '22023';
  end if;
  if v_role = 'group' and new.branch_id is not null then
    raise exception 'a policy for a group location does not name a branch' using errcode = '22023';
  end if;
  if v_role = 'place' and new.branch_id is distinct from v_branch then
    raise exception 'a policy for a place names the place''s branch' using errcode = '22023';
  end if;
  return new;
end $$;
revoke execute on function app.attendance_rule_sets_location() from public, anon;
drop trigger if exists attendance_rule_sets_location on public.attendance_rule_sets;
create trigger attendance_rule_sets_location before insert or update of location_id, branch_id on public.attendance_rule_sets for each row execute function app.attendance_rule_sets_location();

-- two policies of the same scope (now including the location) cannot overlap in time
alter table public.attendance_rule_sets drop constraint if exists attendance_rule_sets_no_overlap;
alter table public.attendance_rule_sets add constraint attendance_rule_sets_no_overlap exclude using gist (
  organization_id with =,
  coalesce(country_code::text, '') with =,
  coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid) with =,
  coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid) with =,
  coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid) with =,
  coalesce(employee_group_id, '00000000-0000-0000-0000-000000000000'::uuid) with =,
  coalesce(shift_id, '00000000-0000-0000-0000-000000000000'::uuid) with =,
  daterange(effective_from, effective_to, '[)') with &&);

-- ---------------------------------------------------------------------------------------------------------------------------
-- 4. Post-verify
-- ---------------------------------------------------------------------------------------------------------------------------
do $$
declare v_table text;
begin
  if exists (select 1 from public.organizations o where (select count(*) from public.location_levels l where l.organization_id = o.id and l.role = 'branch') <> 1) then
    raise exception 'location hierarchy: an organisation has no branch level';
  end if;
  if exists (select 1 from public.branches b where (select count(*) from public.locations l where l.branch_id = b.id and l.role = 'branch') <> 1) then
    raise exception 'location hierarchy: a branch has no location node';
  end if;
  if exists (select 1 from public.locations l where l.path is null or l.path[cardinality(l.path)] <> l.id) then
    raise exception 'location hierarchy: a location path does not end with the location';
  end if;
  foreach v_table in array array['location_levels', 'locations'] loop
    if not exists (select 1 from pg_class where oid = ('public.' || v_table)::regclass and relrowsecurity and relforcerowsecurity) then
      raise exception '% has no forced RLS', v_table;
    end if;
  end loop;
  if (select count(*) from pg_constraint where conname in ('devices_location_fkey', 'employees_work_location_fkey', 'geofences_location_fkey',
      'shift_coverage_requirements_location_fkey', 'attendance_rule_sets_location_fkey', 'attendance_rule_sets_location_branch_fkey') and convalidated) <> 6 then
    raise exception 'location hierarchy: a place reference key is missing or not validated';
  end if;
end $$;
