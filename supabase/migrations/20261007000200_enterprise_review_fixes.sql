-- FlowZa Time · 20261007000200 · Enterprise review fixes (docs/enterprise/plan.md; review of 20261007000100).
--
--  1. Employee groups are organisation-wide definitions: creating, renaming or deleting one needs access to EVERY branch
--     (app.unrestricted_org_ids) besides attendance.manage_rules — the API refused branch-scoped callers already; the database
--     now says so too (authorization twice).
--  2. Group memberships: writing one needs the employee's branch inside the caller's branch scope
--     (app.can_access_employee_branch — SECURITY DEFINER so the check does not depend on the caller reading the employee).
--  3. Branch deployments remember the terminals they enrolled the employee on (`enrolled_device_ids`): the clean-up removes
--     the employee from those terminals only, never from one they were enrolled on by another path (an explicit device sync,
--     a PIN mapping, an earlier deployment).
-- Additive and idempotent; one transaction; ends with a post-verify block.
set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

-- 1. groups: writes need every branch -------------------------------------------------------------------------------------
drop policy if exists employee_groups_insert on public.employee_groups;
drop policy if exists employee_groups_update on public.employee_groups;
drop policy if exists employee_groups_delete on public.employee_groups;
create policy employee_groups_insert on public.employee_groups for insert to authenticated, flowza_system with check (
  organization_id = any ((select app.org_ids_with_permission('attendance.manage_rules'))::uuid[])
  and organization_id = any ((select app.unrestricted_org_ids())::uuid[]));
create policy employee_groups_update on public.employee_groups for update to authenticated, flowza_system using (
  organization_id = any ((select app.org_ids_with_permission('attendance.manage_rules'))::uuid[])
  and organization_id = any ((select app.unrestricted_org_ids())::uuid[]))
with check (
  organization_id = any ((select app.org_ids_with_permission('attendance.manage_rules'))::uuid[])
  and organization_id = any ((select app.unrestricted_org_ids())::uuid[]));
create policy employee_groups_delete on public.employee_groups for delete to authenticated, flowza_system using (
  organization_id = any ((select app.org_ids_with_permission('attendance.manage_rules'))::uuid[])
  and organization_id = any ((select app.unrestricted_org_ids())::uuid[]));

-- 2. memberships: writes need the employee's branch -----------------------------------------------------------------------
create or replace function app.can_access_employee_branch(p_org uuid, p_employee uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_org = any (app.unrestricted_org_ids())
      or exists (select 1 from public.employees e
                 where e.id = p_employee and e.organization_id = p_org and e.branch_id = any (app.allowed_branch_ids()))
$$;
comment on function app.can_access_employee_branch(uuid, uuid) is 'True when the caller may act on the employee by branch scope: every branch of the organisation, or the employee''s current branch among the caller''s branches.';
revoke all on function app.can_access_employee_branch(uuid, uuid) from public, anon;
grant execute on function app.can_access_employee_branch(uuid, uuid) to authenticated, flowza_system;

drop policy if exists employee_group_memberships_insert on public.employee_group_memberships;
drop policy if exists employee_group_memberships_update on public.employee_group_memberships;
drop policy if exists employee_group_memberships_delete on public.employee_group_memberships;
create policy employee_group_memberships_insert on public.employee_group_memberships for insert to authenticated, flowza_system with check (
  organization_id = any ((select app.org_ids_with_permission('attendance.manage_rules'))::uuid[])
  and app.can_access_employee_branch(organization_id, employee_id));
create policy employee_group_memberships_update on public.employee_group_memberships for update to authenticated, flowza_system using (
  organization_id = any ((select app.org_ids_with_permission('attendance.manage_rules'))::uuid[])
  and app.can_access_employee_branch(organization_id, employee_id))
with check (
  organization_id = any ((select app.org_ids_with_permission('attendance.manage_rules'))::uuid[])
  and app.can_access_employee_branch(organization_id, employee_id));
create policy employee_group_memberships_delete on public.employee_group_memberships for delete to authenticated, flowza_system using (
  organization_id = any ((select app.org_ids_with_permission('attendance.manage_rules'))::uuid[])
  and app.can_access_employee_branch(organization_id, employee_id));

-- 3. deployments: the terminals a deployment enrolled -----------------------------------------------------------------------
alter table public.employee_branch_deployments add column if not exists enrolled_device_ids uuid[] not null default '{}';
comment on column public.employee_branch_deployments.enrolled_device_ids is 'Terminals of the host branch this deployment enrolled the employee on (those where they were not enrolled already); the clean-up removes the employee from these only.';

-- 4. post-verify --------------------------------------------------------------------------------------------------------
do $$
begin
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'employee_groups' and cmd in ('INSERT', 'UPDATE', 'DELETE')
        and coalesce(qual, '') || coalesce(with_check, '') like '%unrestricted_org_ids%') <> 3 then
    raise exception 'employee_groups: every write policy must require access to every branch';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'employee_group_memberships' and cmd in ('INSERT', 'UPDATE', 'DELETE')
        and coalesce(qual, '') || coalesce(with_check, '') like '%can_access_employee_branch%') <> 3 then
    raise exception 'employee_group_memberships: every write policy must check the employee''s branch';
  end if;
  if has_function_privilege('anon', 'app.can_access_employee_branch(uuid, uuid)', 'execute') then
    raise exception 'app.can_access_employee_branch must not be executable by anon';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_branch_deployments' and column_name = 'enrolled_device_ids') then
    raise exception 'employee_branch_deployments.enrolled_device_ids missing';
  end if;
end $$;
