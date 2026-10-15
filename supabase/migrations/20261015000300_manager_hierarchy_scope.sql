-- FlowZa Time · 20261015000300 · Manager scope: direct reports or the whole reporting hierarchy (docs/time-away.md §5).
-- Additive and idempotent; one transaction; ends with a post-verify block.
--
-- `organization_settings.attendance -> 'team' ->> 'scope'` (@flowza/contracts attendanceSettingsSchema `team.scope`):
--   direct     (default — today's behaviour) a line manager's team is their direct reports (primary or secondary manager);
--   hierarchy  the team is the whole reporting line under the manager, to depth 5: level 1 as above, deeper levels follow the
--              primary manager and the secondary only where no primary is set (the walk of app.team_employee_ids_deep()).
-- One implementation, `app._team_of(org, employee)`, feeds both readers of "the team", so the API (principal snapshot →
-- `teamEmployeeIds`) and RLS (`app.team_employee_ids()`) can never disagree. Employees who left neither count nor carry the
-- walk further; a caller whose own record left has no team. The snapshot also returns `directReportIds` (level 1 only) for
-- the UI's "direct / through …" labels.
set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

create or replace function app._team_of(p_org uuid, p_employee uuid) returns uuid[]
language sql stable security definer set search_path = ''
as $$
  with recursive opts as (
    select coalesce((select s.attendance -> 'team' ->> 'scope' from public.organization_settings s where s.organization_id = p_org), 'direct') = 'hierarchy' as deep
  ),
  chain as (
    select e.id, 1 as depth
    from public.employees e
    where e.organization_id = p_org and e.deleted_at is null and e.employment_status not in ('terminated', 'resigned')
      and (e.manager_employee_id = p_employee or e.secondary_manager_employee_id = p_employee)
    union
    select e.id, c.depth + 1
    from chain c
    cross join opts
    join public.employees e on e.organization_id = p_org
    where opts.deep and c.depth < 5 and e.deleted_at is null and e.employment_status not in ('terminated', 'resigned')
      and (e.manager_employee_id = c.id or (e.manager_employee_id is null and e.secondary_manager_employee_id = c.id))
  )
  select coalesce(array_agg(distinct c.id), '{}'::uuid[]) from chain c where c.id <> p_employee
$$;
comment on function app._team_of(uuid, uuid) is 'The team of an employee: direct reports, or the reporting line to depth 5 when the organisation''s team scope is hierarchy. Owner only; read through app.team_employee_ids() / app.principal_snapshot().';
revoke all on function app._team_of(uuid, uuid) from public, anon, authenticated, flowza_system, flowza_api, flowza_worker;

-- Same signature and grants as 20260928000150 (create or replace keeps them); the team now follows the organisation's scope.
create or replace function app.team_employee_ids() returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(distinct t.id), '{}'::uuid[])
  from public.org_memberships m
  join public.employees me
    on me.id = m.employee_id and me.organization_id = m.organization_id
   and me.deleted_at is null and me.employment_status not in ('terminated', 'resigned')
  cross join lateral unnest(app._team_of(m.organization_id, m.employee_id)) as t(id)
  where m.user_id = app.uid() and m.status = 'active' and m.employee_id is not null
$$;

-- principal_snapshot (latest body: 20260929000600) with `teamEmployeeIds` from app._team_of and `directReportIds`
create or replace function app.principal_snapshot(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with admin as (
    select exists (select 1 from public.platform_admins pa where pa.user_id = p_user_id and pa.status = 'active') as is_admin
  ),
  grants as (
    select g.organization_id, g.access_level
    from public.platform_access_grants g, admin
    where admin.is_admin
      and g.platform_admin_user_id = p_user_id and g.revoked_at is null and now() >= g.starts_at and now() < g.expires_at
  ),
  member_orgs as (
    select m.organization_id from public.org_memberships m where m.user_id = p_user_id and m.status = 'active'
    union
    select organization_id from grants
  )
  select jsonb_build_object(
    'profile', (select jsonb_build_object('id', p.id, 'email', p.email, 'status', p.status) from public.user_profiles p where p.id = p_user_id),
    'isPlatformAdmin', (select is_admin from admin),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'membershipId', m.id, 'organizationId', m.organization_id, 'roleId', m.role_id, 'roleKey', r.key,
        'allBranches', m.all_branches, 'employeeId', m.employee_id,
        'permissions', coalesce((select jsonb_agg(rp.permission_key order by rp.permission_key) from public.role_permissions rp where rp.role_id = m.role_id), '[]'::jsonb),
        'branchIds', case when m.all_branches then '[]'::jsonb
                          else coalesce((select jsonb_agg(mb.branch_id) from public.membership_branches mb where mb.membership_id = m.id), '[]'::jsonb) end,
        'teamEmployeeIds', case when me.id is null then '[]'::jsonb
                                else coalesce((select jsonb_agg(t.id order by t.id) from unnest(app._team_of(m.organization_id, m.employee_id)) as t(id)), '[]'::jsonb) end,
        'directReportIds', case when me.id is null then '[]'::jsonb
                                else coalesce((select jsonb_agg(e.id order by e.id) from public.employees e
                                               where e.organization_id = m.organization_id and e.deleted_at is null
                                                 and e.employment_status not in ('terminated', 'resigned')
                                                 and (e.manager_employee_id = m.employee_id or e.secondary_manager_employee_id = m.employee_id)), '[]'::jsonb) end
      ) order by m.created_at, m.id)
      from public.org_memberships m
      join public.roles r on r.id = m.role_id
      left join public.employees me
        on me.id = m.employee_id and me.organization_id = m.organization_id
       and me.deleted_at is null and me.employment_status not in ('terminated', 'resigned')
      where m.user_id = p_user_id and m.status = 'active'), '[]'::jsonb),
    'grants', coalesce((select jsonb_agg(jsonb_build_object('organizationId', organization_id, 'accessLevel', access_level)) from grants), '[]'::jsonb),
    'allPermissions', case when (select is_admin from admin)
                           then coalesce((select jsonb_agg(k.key order by k.key) from public.permissions k), '[]'::jsonb)
                           else '[]'::jsonb end,
    'mfaRequiredOrgIds', coalesce((
      select jsonb_agg(s.organization_id) from public.organization_settings s
      where s.organization_id in (select organization_id from member_orgs) and s.security -> 'mfaRequired' = 'true'::jsonb), '[]'::jsonb),
    'disabledModules', coalesce((
      select jsonb_object_agg(d.organization_id, d.keys)
      from (select ms.organization_id, jsonb_agg(ms.module_key order by ms.module_key) as keys
            from app._org_module_states(array(select organization_id from member_orgs)) ms
            where not ms.enabled
            group by ms.organization_id) d), '{}'::jsonb)
  );
$$;
revoke all on function app.principal_snapshot(uuid) from public, anon, authenticated, flowza_system, flowza_worker;
grant execute on function app.principal_snapshot(uuid) to flowza_api;

-- Post-verify ---------------------------------------------------------------------------------------------------------------
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('app.principal_snapshot(uuid)'::regprocedure);
  if v_def not like '%teamEmployeeIds%' or v_def not like '%directReportIds%' or v_def not like '%disabledModules%' or v_def not like '%mfaRequiredOrgIds%' then
    raise exception 'principal_snapshot lost a key';
  end if;
  if has_function_privilege('authenticated', 'app.principal_snapshot(uuid)', 'execute') or not has_function_privilege('flowza_api', 'app.principal_snapshot(uuid)', 'execute') then
    raise exception 'principal_snapshot grants differ (flowza_api only)';
  end if;
  if has_function_privilege('authenticated', 'app._team_of(uuid, uuid)', 'execute') or has_function_privilege('flowza_api', 'app._team_of(uuid, uuid)', 'execute') then
    raise exception '_team_of must not be callable by the application roles';
  end if;
  if not has_function_privilege('authenticated', 'app.team_employee_ids()', 'execute') or not has_function_privilege('flowza_worker', 'app.team_employee_ids()', 'execute') then
    raise exception 'team_employee_ids grants lost';
  end if;
end $$;
