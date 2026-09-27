-- HR portal Prompt 1 — review fixes (docs/hr-portal/reports/01-roles-permissions.md §"Review fixes").
--
-- 1. Directory scope for line managers (Finance parity: own record + direct reports). New key `employee.view_team`
--    ("View the employee records of direct reports"), granted to the manager, branch_manager and hr_user system roles —
--    and to owner/org_admin (who hold every key: the role editor only lets an actor grant keys they hold) and hr_admin
--    (who holds every other team key and must stay a superset of hr_user, or moving a person from hr_user to hr_admin
--    would read as a downgrade). hr_admin already reads every employee, so the grant opens nothing new for it. The
--    `manager` system role LOSES the organisation-wide `employee.view`: it reads its own row (self column) and its
--    direct reports' rows (team predicate) and nothing else. The employees team predicate now accepts any of
--    employee.view_team | attendance.view_team | leave.view_team.
-- 2. Offboarding (B-75). The team helpers and the principal snapshot ignore a caller whose own employee record is
--    archived (deleted_at) or has left (employment_status terminated/resigned), and drop such records from every team,
--    so a manager who left loses the team even if a login was missed. The API suspends the linked memberships on
--    termination/resignation/archive and ends the user's sessions through `app.revoke_user_sessions` (below).
-- 3. Reporting-line cycle guard: `app.employees_no_manager_cycle` (BEFORE INSERT OR UPDATE OF the two manager columns)
--    walks the proposed managers' chains (primary and secondary links, depth ≤ 20) and refuses a link that would make
--    somebody report to themselves (check_violation, constraint `employees_no_manager_cycle`). Reporting-line changes
--    are serialised per organisation so two concurrent edits cannot close a loop together. Unchanged links are not
--    re-checked, so a pre-existing loop never blocks an unrelated update.
-- 4. `app.revoke_user_sessions(uuid[])`: ends every Supabase Auth session of the given users (refresh tokens die with
--    their session) — the statement Auth's own global sign-out runs. Supabase Auth has no admin endpoint that signs a
--    user out by id (admin.signOut needs that user's own access token; banning is global and would also lock the
--    person out of their other organisations). Only an organisation's system context may call it, and only for users
--    holding a membership of that organisation.
--
-- Functions re-created here keep the grants/owners 20260928000100 gave them (restated below, verified at the end).
-- Idempotent; no backfill (existing active logins linked to employees who already left are listed by the query in the
-- phase report, and are suspended by HR explicitly). Bounded lock waits (hot table: employees).
set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

-- 1. employee.view_team -----------------------------------------------------------------------------------------------------
insert into public.permissions (key, category, description, sort_order) values
  ('employee.view_team', 'employees', 'View the employee records of direct reports (line manager scope)', 57)
on conflict (key) do update set category = excluded.category, description = excluded.description, sort_order = excluded.sort_order;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'employee.view_team' from public.roles r
where r.organization_id is null and r.is_system and r.key in ('owner', 'org_admin', 'hr_admin', 'manager', 'branch_manager', 'hr_user')
on conflict do nothing;
-- the line manager reads its own record and its direct reports only, not the whole directory
delete from public.role_permissions where role_id = '10000000-0000-0000-0000-000000000009' and permission_key = 'employee.view';

-- employees: org-wide employee.view + branch scope, OR own row, OR (a team key AND a direct report)
call app.apply_tenant_policies('public.employees', 'employee.view', 'employee.update', 'branch_id', 'id', 'employee.delete', 'id',
  array['employee.view_team', 'attendance.view_team', 'leave.view_team']);
-- creating employees needs employee.create (same override as 20260905001400 / 20260928000100)
drop policy if exists employees_insert on public.employees;
create policy employees_insert on public.employees for insert to authenticated, flowza_system with check (
  organization_id = any ((select app.org_ids_with_permission('employee.create'))::uuid[])
  and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or branch_id = any ((select app.allowed_branch_ids())::uuid[]))
);

-- 2. Team helpers and the principal snapshot ignore employees who left ---------------------------------------------------------
-- "Left" = archived (deleted_at) or employment_status terminated/resigned. A caller whose own record left has no team;
-- a report who left is no longer part of anybody's team (HR keeps organisation-wide access to their history).
create or replace function app.team_employee_ids() returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(distinct e.id), '{}'::uuid[])
  from public.org_memberships m
  join public.employees me
    on me.id = m.employee_id and me.organization_id = m.organization_id
   and me.deleted_at is null and me.employment_status not in ('terminated', 'resigned')
  join public.employees e
    on e.organization_id = m.organization_id
   and (e.manager_employee_id = me.id or e.secondary_manager_employee_id = me.id)
  where m.user_id = app.uid() and m.status = 'active' and m.employee_id is not null
    and e.deleted_at is null and e.employment_status not in ('terminated', 'resigned')
$$;

-- The reporting chain under the caller to depth 5: level 1 as above, deeper levels follow the primary manager and the
-- secondary only where no primary is set. Employees who left neither count nor carry the walk further.
create or replace function app.team_employee_ids_deep() returns uuid[]
language sql stable security definer set search_path = ''
as $$
  with recursive roots as (
    select m.employee_id as id, m.organization_id
    from public.org_memberships m
    join public.employees me
      on me.id = m.employee_id and me.organization_id = m.organization_id
     and me.deleted_at is null and me.employment_status not in ('terminated', 'resigned')
    where m.user_id = app.uid() and m.status = 'active' and m.employee_id is not null
  ),
  chain as (
    select e.id, e.organization_id, 1 as depth
    from public.employees e
    join roots r on r.organization_id = e.organization_id
    where e.deleted_at is null and e.employment_status not in ('terminated', 'resigned')
      and (e.manager_employee_id = r.id or e.secondary_manager_employee_id = r.id)
    union
    select e.id, e.organization_id, c.depth + 1
    from public.employees e
    join chain c on c.organization_id = e.organization_id
    where c.depth < 5 and e.deleted_at is null and e.employment_status not in ('terminated', 'resigned')
      and (e.manager_employee_id = c.id or (e.manager_employee_id is null and e.secondary_manager_employee_id = c.id))
  )
  select coalesce(array_agg(distinct c.id), '{}'::uuid[])
  from chain c
  where c.id not in (select id from roots)
$$;

-- same grants as 20260928000100 (policy helpers: executable by every application role)
grant execute on function app.team_employee_ids(), app.team_employee_ids_deep() to authenticated, flowza_system, flowza_api, flowza_worker;

-- Same document as 20260928000100; `teamEmployeeIds` is empty when the membership's own employee record left, and never
-- lists a report who left. Only flowza_api may execute it.
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
        'teamEmployeeIds', case when m.employee_id is null or not exists (
                                  select 1 from public.employees me
                                  where me.id = m.employee_id and me.organization_id = m.organization_id
                                    and me.deleted_at is null and me.employment_status not in ('terminated', 'resigned'))
                                then '[]'::jsonb
                                else coalesce((select jsonb_agg(e.id order by e.id) from public.employees e
                                               where e.organization_id = m.organization_id and e.deleted_at is null
                                                 and e.employment_status not in ('terminated', 'resigned')
                                                 and (e.manager_employee_id = m.employee_id or e.secondary_manager_employee_id = m.employee_id)), '[]'::jsonb) end
      ) order by m.created_at, m.id)
      from public.org_memberships m
      join public.roles r on r.id = m.role_id
      where m.user_id = p_user_id and m.status = 'active'), '[]'::jsonb),
    'grants', coalesce((select jsonb_agg(jsonb_build_object('organizationId', organization_id, 'accessLevel', access_level)) from grants), '[]'::jsonb),
    'allPermissions', case when (select is_admin from admin)
                           then coalesce((select jsonb_agg(k.key order by k.key) from public.permissions k), '[]'::jsonb)
                           else '[]'::jsonb end,
    'mfaRequiredOrgIds', coalesce((
      select jsonb_agg(s.organization_id) from public.organization_settings s
      where s.organization_id in (select organization_id from member_orgs) and s.security -> 'mfaRequired' = 'true'::jsonb), '[]'::jsonb)
  );
$$;
revoke all on function app.principal_snapshot(uuid) from public, anon, authenticated, flowza_system, flowza_worker;
grant execute on function app.principal_snapshot(uuid) to flowza_api;

-- 3. Reporting-line cycle guard ----------------------------------------------------------------------------------------------
-- Walks upwards from each CHANGED manager link (primary and secondary links of every ancestor, depth ≤ 20) and refuses
-- the link when the walk reaches the employee itself. Security definer: the walk must see the whole organisation, not
-- only the rows the caller's branch scope shows. An unchanged link was checked when it was set, so it is not re-walked
-- (a loop that predates this guard never blocks an unrelated update).
create or replace function app.employees_no_manager_cycle() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_old_manager uuid;
  v_old_secondary uuid;
  v_field text;
  v_start uuid;
begin
  if tg_op = 'UPDATE' then
    v_old_manager := old.manager_employee_id;
    v_old_secondary := old.secondary_manager_employee_id;
    if new.manager_employee_id is not distinct from v_old_manager and new.secondary_manager_employee_id is not distinct from v_old_secondary then
      return new;
    end if;
  end if;
  if new.manager_employee_id is null and new.secondary_manager_employee_id is null then
    return new;
  end if;
  -- one reporting-line change at a time per organisation: two concurrent edits cannot close a loop together
  perform pg_advisory_xact_lock(hashtextextended('flowza:employees:reporting-line:' || new.organization_id::text, 0));
  foreach v_field in array array['manager_employee_id', 'secondary_manager_employee_id'] loop
    if v_field = 'manager_employee_id' then
      v_start := new.manager_employee_id;
      continue when v_start is null or (tg_op = 'UPDATE' and v_start is not distinct from v_old_manager);
    else
      v_start := new.secondary_manager_employee_id;
      continue when v_start is null or (tg_op = 'UPDATE' and v_start is not distinct from v_old_secondary);
    end if;
    if v_start = new.id or exists (
      with recursive up(id, depth) as (
        select v_start, 1
        union
        select l.manager_id, u.depth + 1
        from up u
        join public.employees e on e.id = u.id and e.organization_id = new.organization_id
        cross join lateral (values (e.manager_employee_id), (e.secondary_manager_employee_id)) as l(manager_id)
        where u.depth < 20 and l.manager_id is not null
      )
      select 1 from up where up.id = new.id
    ) then
      raise exception 'reporting line cycle: employee % cannot report to % (that person already reports to them)', new.id, v_start
        using errcode = 'check_violation', constraint = 'employees_no_manager_cycle', column = v_field, schema = 'public', table = 'employees';
    end if;
  end loop;
  return new;
end $$;

create or replace trigger employees_no_manager_cycle
  before insert or update of manager_employee_id, secondary_manager_employee_id on public.employees
  for each row execute function app.employees_no_manager_cycle();

-- 4. Session revocation -------------------------------------------------------------------------------------------------------
-- Returns the number of sessions ended, or -1 when the auth schema is not reachable (the local shim has no auth.sessions,
-- or the privilege is missing): the caller logs that — the membership change itself already closed the organisation,
-- because every API request and every RLS predicate re-reads the memberships.
create or replace function app.revoke_user_sessions(p_user_ids uuid[]) returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid := app.system_org_id();
  v_count integer := 0;
begin
  if v_org is null then
    raise exception 'app.revoke_user_sessions: only the system context of an organisation may end sessions' using errcode = '42501';
  end if;
  if p_user_ids is null or cardinality(p_user_ids) = 0 then
    return 0;
  end if;
  if to_regclass('auth.sessions') is null then
    return -1;
  end if;
  begin
    -- only users who hold (or held) a membership of the calling organisation
    execute 'delete from auth.sessions s where s.user_id = any ($1)
               and exists (select 1 from public.org_memberships m where m.user_id = s.user_id and m.organization_id = $2)'
      using p_user_ids, v_org;
    get diagnostics v_count = row_count;
  exception when insufficient_privilege or undefined_table or undefined_column then
    return -1;
  end;
  return v_count;
end $$;
revoke all on function app.revoke_user_sessions(uuid[]) from public, anon, authenticated, flowza_api, flowza_worker;
grant execute on function app.revoke_user_sessions(uuid[]) to flowza_system;

-- 5. Post-verify: raises when an expectation does not hold. Every statement above is idempotent, so after a fix the file
--    is simply applied again (locally `psql -f` runs it statement by statement; it is not one transaction there). ------
do $$
declare v_def text;
begin
  if not exists (select 1 from public.permissions where key = 'employee.view_team' and category = 'employees') then
    raise exception 'employee.view_team missing';
  end if;
  if (select count(*) from public.role_permissions rp join public.roles r on r.id = rp.role_id
      where rp.permission_key = 'employee.view_team' and r.organization_id is null and r.key in ('owner', 'org_admin', 'hr_admin', 'manager', 'branch_manager', 'hr_user')) <> 6 then
    raise exception 'employee.view_team not granted to owner, org_admin, hr_admin, manager, branch_manager and hr_user';
  end if;
  if exists (select 1 from public.role_permissions where role_id = '10000000-0000-0000-0000-000000000009' and permission_key = 'employee.view') then
    raise exception 'the manager system role still holds the organisation-wide employee.view';
  end if;
  select qual into v_def from pg_policies where schemaname = 'public' and tablename = 'employees' and policyname = 'employees_select';
  if v_def is null or v_def not like '%employee.view_team%' or v_def not like '%team_employee_ids%' then
    raise exception 'employees_select does not carry the employee.view_team team predicate';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employees' and policyname = 'employees_insert' and with_check like '%employee.create%') then
    raise exception 'employees_insert override missing';
  end if;
  foreach v_def in array array[pg_get_functiondef('app.team_employee_ids()'::regprocedure), pg_get_functiondef('app.team_employee_ids_deep()'::regprocedure), pg_get_functiondef('app.principal_snapshot(uuid)'::regprocedure)] loop
    if v_def not like '%terminated%' or v_def not like '%deleted_at is null%' then
      raise exception 'a team helper does not ignore employees who left';
    end if;
  end loop;
  if pg_get_functiondef('app.principal_snapshot(uuid)'::regprocedure) not like '%teamEmployeeIds%' then
    raise exception 'principal_snapshot does not return teamEmployeeIds';
  end if;
  -- grants exactly as 20260928000100 set them
  if not (has_function_privilege('authenticated', 'app.team_employee_ids()', 'execute') and has_function_privilege('flowza_system', 'app.team_employee_ids()', 'execute')
          and has_function_privilege('authenticated', 'app.team_employee_ids_deep()', 'execute') and has_function_privilege('flowza_worker', 'app.team_employee_ids_deep()', 'execute')) then
    raise exception 'team helpers lost their grants';
  end if;
  if has_function_privilege('authenticated', 'app.principal_snapshot(uuid)', 'execute') or has_function_privilege('flowza_system', 'app.principal_snapshot(uuid)', 'execute')
     or has_function_privilege('flowza_worker', 'app.principal_snapshot(uuid)', 'execute') or not has_function_privilege('flowza_api', 'app.principal_snapshot(uuid)', 'execute') then
    raise exception 'principal_snapshot grants differ from 20260928000100 (flowza_api only)';
  end if;
  if has_function_privilege('authenticated', 'app.revoke_user_sessions(uuid[])', 'execute') or has_function_privilege('flowza_worker', 'app.revoke_user_sessions(uuid[])', 'execute')
     or not has_function_privilege('flowza_system', 'app.revoke_user_sessions(uuid[])', 'execute') then
    raise exception 'revoke_user_sessions must be executable by flowza_system only';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.employees'::regclass and tgname = 'employees_no_manager_cycle' and not tgisinternal) then
    raise exception 'employees_no_manager_cycle trigger missing';
  end if;
end $$;
