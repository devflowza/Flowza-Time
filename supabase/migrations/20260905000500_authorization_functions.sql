-- FlowZa Time · 0500 · authorization helpers (ADR-002) and the tenant policy generator
-- Execution contexts (see docs/security.md):
--   user            : role authenticated, claims {"sub": <auth user id>, "role": "authenticated"}
--   system-for-org  : role flowza_system, claims {"role": "flowza_system", "org_id": <uuid>}
--   platform admin  : role authenticated + platform_admins row + active platform_access_grants row

create or replace function app.claims() returns jsonb
language sql stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

create or replace function app.uid() returns uuid
language sql stable
as $$
  select nullif(app.claims() ->> 'sub', '')::uuid
$$;

-- System context: the claim role must be flowza_system AND the session must actually have executed
-- SET ROLE flowza_system. current_setting('role') reflects SET ROLE even inside SECURITY DEFINER
-- functions, and only flowza_api/flowza_worker are members of flowza_system, so a forged claim coming
-- through PostgREST (role authenticated/anon) or from a user session can never become system.
create or replace function app.is_system() returns boolean
language sql stable
as $$
  select (app.claims() ->> 'role') = 'flowza_system'
     and current_setting('role', true) = 'flowza_system'
$$;

create or replace function app.system_org_id() returns uuid
language sql stable
as $$
  select case when app.is_system() then nullif(app.claims() ->> 'org_id', '')::uuid end
$$;

create or replace function app.is_platform_admin() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins pa
    where pa.user_id = app.uid() and pa.status = 'active'
  )
$$;

-- Organisations where the current principal holds a permission.
create or replace function app.org_ids_with_permission(p_perm text) returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(distinct s.org_id), '{}'::uuid[])
  from (
    select app.system_org_id() as org_id
    where app.is_system()
    union all
    select m.organization_id
    from public.org_memberships m
    join public.role_permissions rp on rp.role_id = m.role_id
    where m.user_id = app.uid()
      and m.status = 'active'
      and rp.permission_key = p_perm
    union all
    select g.organization_id
    from public.platform_access_grants g
    join public.platform_admins pa on pa.user_id = g.platform_admin_user_id and pa.status = 'active'
    where g.platform_admin_user_id = app.uid()
      and g.revoked_at is null
      and now() >= g.starts_at and now() < g.expires_at
      and (g.access_level = 'write' or p_perm like '%.view' or p_perm like '%.export')
  ) s
  where s.org_id is not null
$$;

-- Organisations where the principal is NOT restricted to specific branches.
create or replace function app.unrestricted_org_ids() returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(distinct s.org_id), '{}'::uuid[])
  from (
    select app.system_org_id() as org_id where app.is_system()
    union all
    select m.organization_id from public.org_memberships m
    where m.user_id = app.uid() and m.status = 'active' and m.all_branches
    union all
    select g.organization_id from public.platform_access_grants g
    join public.platform_admins pa on pa.user_id = g.platform_admin_user_id and pa.status = 'active'
    where g.platform_admin_user_id = app.uid() and g.revoked_at is null
      and now() >= g.starts_at and now() < g.expires_at
  ) s
  where s.org_id is not null
$$;

-- Branch ids the principal is explicitly limited to (for memberships with all_branches = false).
create or replace function app.allowed_branch_ids() returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(mb.branch_id), '{}'::uuid[])
  from public.org_memberships m
  join public.membership_branches mb on mb.membership_id = m.id
  where m.user_id = app.uid() and m.status = 'active' and not m.all_branches
$$;

-- Employee records that belong to the current user (self-service).
create or replace function app.own_employee_ids() returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(m.employee_id), '{}'::uuid[])
  from public.org_memberships m
  where m.user_id = app.uid() and m.status = 'active' and m.employee_id is not null
$$;

create or replace function app.member_org_ids() returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(distinct s.org_id), '{}'::uuid[])
  from (
    select app.system_org_id() as org_id where app.is_system()
    union all
    select m.organization_id from public.org_memberships m where m.user_id = app.uid() and m.status = 'active'
    union all
    select g.organization_id from public.platform_access_grants g
    join public.platform_admins pa on pa.user_id = g.platform_admin_user_id and pa.status = 'active'
    where g.platform_admin_user_id = app.uid() and g.revoked_at is null
      and now() >= g.starts_at and now() < g.expires_at
  ) s where s.org_id is not null
$$;

create or replace function app.has_permission(p_org uuid, p_perm text) returns boolean
language sql stable
as $$
  select p_org = any (app.org_ids_with_permission(p_perm))
$$;

create or replace function app.can_access_branch(p_org uuid, p_branch uuid) returns boolean
language sql stable
as $$
  select p_branch is null
      or p_org = any (app.unrestricted_org_ids())
      or p_branch = any (app.allowed_branch_ids())
$$;

create or replace function app.is_org_member(p_org uuid) returns boolean
language sql stable
as $$
  select p_org = any (app.member_org_ids())
$$;

grant execute on all functions in schema app to authenticated, flowza_system, flowza_api, flowza_worker;
alter default privileges in schema app grant execute on functions to authenticated, flowza_system, flowza_api, flowza_worker;

-- Policy generator ----------------------------------------------------------------------------
-- Creates the standard select/insert/update/delete policies on a tenant table.
--   p_view_perm  : permission required to read rows
--   p_write_perm : permission required to insert/update/delete rows
--   p_branch_col : optional column holding the branch id (branch-scope enforcement)
--   p_self_col   : optional column holding an employee id visible to the linked user (self-service)
create or replace procedure app.apply_tenant_policies(
  p_table regclass,
  p_view_perm text,
  p_write_perm text,
  p_branch_col text default null,
  p_self_col text default null,
  p_delete_perm text default null
)
language plpgsql
as $$
declare
  v_name text := p_table::text;
  v_short text := replace(replace(v_name, 'public.', ''), '.', '_');
  v_read text;
  v_write text;
  v_branch text := 'true';
  v_self text := 'false';
  v_delete_perm text := coalesce(p_delete_perm, p_write_perm);
begin
  if p_branch_col is not null then
    v_branch := format(
      '(organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or %1$I is null or %1$I = any ((select app.allowed_branch_ids())::uuid[]))',
      p_branch_col);
  end if;
  if p_self_col is not null then
    v_self := format('(%1$I = any ((select app.own_employee_ids())::uuid[]))', p_self_col);
  end if;

  v_read := format('((organization_id = any ((select app.org_ids_with_permission(%L))::uuid[]) and %s) or %s)', p_view_perm, v_branch, v_self);
  v_write := format('(organization_id = any ((select app.org_ids_with_permission(%L))::uuid[]) and %s)', p_write_perm, v_branch);

  execute format('alter table %s enable row level security', v_name);
  execute format('drop policy if exists %I on %s', v_short || '_select', v_name);
  execute format('drop policy if exists %I on %s', v_short || '_insert', v_name);
  execute format('drop policy if exists %I on %s', v_short || '_update', v_name);
  execute format('drop policy if exists %I on %s', v_short || '_delete', v_name);
  execute format('create policy %I on %s for select to authenticated, flowza_system using %s', v_short || '_select', v_name, v_read);
  execute format('create policy %I on %s for insert to authenticated, flowza_system with check %s', v_short || '_insert', v_name, v_write);
  execute format('create policy %I on %s for update to authenticated, flowza_system using %s with check %s', v_short || '_update', v_name, v_write, v_write);
  execute format('create policy %I on %s for delete to authenticated, flowza_system using %s',
    v_short || '_delete', v_name,
    format('(organization_id = any ((select app.org_ids_with_permission(%L))::uuid[]) and %s)', v_delete_perm, v_branch));
end $$;

-- Read-only variant for tables written only by the system (audit, history, raw data).
create or replace procedure app.apply_readonly_tenant_policies(
  p_table regclass,
  p_view_perm text,
  p_branch_col text default null,
  p_self_col text default null
)
language plpgsql
as $$
declare
  v_name text := p_table::text;
  v_short text := replace(replace(v_name, 'public.', ''), '.', '_');
  v_branch text := 'true';
  v_self text := 'false';
begin
  if p_branch_col is not null then
    v_branch := format(
      '(organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or %1$I is null or %1$I = any ((select app.allowed_branch_ids())::uuid[]))',
      p_branch_col);
  end if;
  if p_self_col is not null then
    v_self := format('(%1$I = any ((select app.own_employee_ids())::uuid[]))', p_self_col);
  end if;
  execute format('alter table %s enable row level security', v_name);
  execute format('drop policy if exists %I on %s', v_short || '_select', v_name);
  execute format('drop policy if exists %I on %s', v_short || '_system_write', v_name);
  execute format('create policy %I on %s for select to authenticated, flowza_system using ((organization_id = any ((select app.org_ids_with_permission(%L))::uuid[]) and %s) or %s)',
    v_short || '_select', v_name, p_view_perm, v_branch, v_self);
  execute format('create policy %I on %s for all to flowza_system using (organization_id = app.system_org_id()) with check (organization_id = app.system_org_id())',
    v_short || '_system_write', v_name);
end $$;
