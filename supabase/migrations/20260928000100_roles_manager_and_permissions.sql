-- Roles & permissions per the global HR standard; line-manager (team) semantics — HR portal Prompt 1.
--
-- 1. Thirteen permission keys (self-service check-in / notes / shift swaps, team visibility, HR oversight of notes,
--    geofences, overtime, leave approval split from leave.manage, approval configuration + delegation, report
--    schedules, integrations). Reference data: `on conflict do update`, like every other row of the vocabulary.
-- 2. Two system roles: `manager` (Line Manager, …0009) and `auditor` (read-only, …0010), and the new keys granted to
--    the existing system roles per the matrix in docs/hr-portal/prompt-pack.md §Prompt 1. Custom roles are untouched.
-- 3. Manager semantics. `employees.secondary_manager_employee_id` (dotted line / backup approver, composite FK).
--    `app.team_employee_ids()` = employees whose primary OR secondary manager is one of the caller's own employee
--    records — DIRECT reports only — resolved through org_memberships.employee_id (the only user↔employee link in use;
--    employees.user_id is not consulted anywhere). `app.team_employee_ids_deep()` walks the reporting chain to depth 5
--    (level 1 = primary or secondary, deeper levels follow the primary manager, the secondary only where no primary is
--    set) for the manager-chain approver of Prompt 2.
--    The tenant policy generators gain an optional *team* predicate: a row is readable when the caller holds a TEAM key
--    for the organisation AND the row's employee is one of their direct reports. The org-wide key, the branch scope and
--    the self column are unchanged, so nobody loses a row they could read before; a manager relationship alone opens
--    nothing until a role carrying the team key is assigned (authorization twice — the system role `manager` carries
--    them out of the box). Re-applied on attendance_daily_records, attendance_events, attendance_raw_transactions,
--    leave_records, attendance_corrections (team key attendance.view_team / leave.view_team) and employees (either
--    team key: whoever may see a report's attendance or leave may see who that report is).
-- 4. `app.principal_snapshot` returns `teamEmployeeIds` per membership so /me can expose `isManager` and the team size
--    without a second round trip.
-- 5. `invitations.employee_id`: the employee link chosen while inviting someone who has no account yet is stored on the
--    invitation and copied onto the membership when the invitation is accepted (previously it was silently dropped).
--
-- Additive; no backfill; idempotent. Bounded lock waits (hot tables: employees, attendance_*).
set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

-- 1. Permissions --------------------------------------------------------------------------------------------------------
-- Sort orders only order keys inside their own category (the matrix groups by category first), so ties across categories are harmless.
insert into public.permissions (key, category, description, sort_order) values
  ('integration.manage',           'integrations', 'Manage integrations and connectors (Finance sync, webhooks)', 25),
  ('shift.request_swap',           'shifts',       'Request shift swaps (self-service)', 73),
  ('leave.approve',                'leave',        'Approve or reject leave requests', 78),
  ('leave.view_team',              'leave',        'View leave of direct reports (line manager scope)', 79),
  ('attendance.view_team',         'attendance',   'View attendance of direct reports (line manager scope)', 89),
  ('attendance.checkin',           'attendance',   'Check in and out from the web or mobile app (self-service)', 90),
  ('attendance.note',              'attendance',   'Explain own attendance days and request regularisation (self-service)', 91),
  ('attendance.review_notes',      'attendance',   'Review attendance notes and regularisation requests organisation-wide (HR oversight)', 92),
  ('attendance.manage_geofences',  'attendance',   'Manage geofences and check-in locations', 93),
  ('attendance.manage_overtime',   'attendance',   'Approve and manage overtime', 94),
  ('report.schedule',              'reports',      'Share reports and manage report schedules', 103),
  ('approval.manage',              'approval',     'Configure approval workflows', 105),
  ('approval.delegate',            'approval',     'Delegate own approvals to a colleague', 106)
on conflict (key) do update set category = excluded.category, description = excluded.description, sort_order = excluded.sort_order;

-- 2. System roles -------------------------------------------------------------------------------------------------------
insert into public.roles (id, organization_id, key, name, description, is_system) values
  ('10000000-0000-0000-0000-000000000009', null, 'manager', 'Line Manager', 'Sees and approves for direct reports (primary or secondary manager on the employee record); no organisation-wide HR rights', true),
  ('10000000-0000-0000-0000-000000000010', null, 'auditor', 'Auditor',      'Read-only access to organisation data, attendance, leave, payroll summaries, reports and the audit log', true)
on conflict (id) do update set name = excluded.name, description = excluded.description;

-- manager: workspace permissions; row visibility of the team comes from the relationship (team predicate) and of own rows from own_employee_ids
insert into public.role_permissions (role_id, permission_key) select '10000000-0000-0000-0000-000000000009', unnest(array[
  'dashboard.view', 'employee.view', 'attendance.view_team', 'attendance.view_own', 'attendance.checkin', 'attendance.note', 'attendance.approve', 'attendance.correct',
  'attendance.request_correction', 'leave.view_team', 'leave.approve', 'leave.request', 'shift.view', 'shift.request_swap', 'holiday.view', 'report.view', 'approval.delegate'])
on conflict do nothing;
-- auditor: read-only (every write policy keys on a manage/update/create permission the role does not hold)
insert into public.role_permissions (role_id, permission_key) select '10000000-0000-0000-0000-000000000010', unnest(array[
  'dashboard.view', 'organization.view', 'branch.view', 'department.view', 'employee.view', 'attendance.view', 'attendance.view_raw', 'leave.view', 'shift.view', 'holiday.view',
  'report.view', 'report.export', 'audit.view', 'payroll.view'])
on conflict do nothing;

-- new keys for the existing system roles (matrix in the prompt pack)
insert into public.role_permissions (role_id, permission_key)
select r.id, p.key from public.roles r
cross join (values ('integration.manage'), ('shift.request_swap'), ('leave.approve'), ('leave.view_team'), ('attendance.view_team'), ('attendance.checkin'), ('attendance.note'),
                   ('attendance.review_notes'), ('attendance.manage_geofences'), ('attendance.manage_overtime'), ('report.schedule'), ('approval.manage'), ('approval.delegate')) as p(key)
where r.organization_id is null and r.is_system and r.key in ('owner', 'org_admin')
on conflict do nothing;
insert into public.role_permissions (role_id, permission_key) select '10000000-0000-0000-0000-000000000003', unnest(array[
  'attendance.view_team', 'attendance.checkin', 'attendance.note', 'attendance.review_notes', 'attendance.manage_geofences', 'attendance.manage_overtime', 'leave.approve', 'leave.view_team', 'approval.manage', 'approval.delegate'])
on conflict do nothing;
insert into public.role_permissions (role_id, permission_key) select '10000000-0000-0000-0000-000000000004', unnest(array['attendance.review_notes', 'leave.approve']) on conflict do nothing;
insert into public.role_permissions (role_id, permission_key) select '10000000-0000-0000-0000-000000000005', unnest(array['attendance.view_team', 'leave.approve', 'shift.request_swap']) on conflict do nothing;
insert into public.role_permissions (role_id, permission_key) select '10000000-0000-0000-0000-000000000008', unnest(array['attendance.checkin', 'attendance.note', 'shift.request_swap']) on conflict do nothing;
insert into public.role_permissions (role_id, permission_key) select '10000000-0000-0000-0000-000000000007', unnest(array['report.schedule']) on conflict do nothing;

-- 3a. Schema: secondary manager, invitation employee link ---------------------------------------------------------------
alter table public.employees add column if not exists secondary_manager_employee_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'employees_secondary_manager_fkey') then
    alter table public.employees add constraint employees_secondary_manager_fkey
      foreign key (secondary_manager_employee_id, organization_id) references public.employees(id, organization_id) on delete set null (secondary_manager_employee_id);
  end if;
  -- a person is never their own backup, and the secondary manager is somebody other than the primary one
  if not exists (select 1 from pg_constraint where conname = 'employees_secondary_manager_distinct') then
    alter table public.employees add constraint employees_secondary_manager_distinct
      check (secondary_manager_employee_id is null or (secondary_manager_employee_id <> id and secondary_manager_employee_id is distinct from manager_employee_id));
  end if;
end $$;
create index if not exists employees_org_secondary_manager_idx on public.employees (organization_id, secondary_manager_employee_id) where secondary_manager_employee_id is not null;

alter table public.invitations add column if not exists employee_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invitations_employee_fkey') then
    alter table public.invitations add constraint invitations_employee_fkey
      foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete set null (employee_id);
  end if;
end $$;
create index if not exists invitations_org_employee_idx on public.invitations (organization_id, employee_id) where employee_id is not null and accepted_at is null;

-- 3b. Helpers -------------------------------------------------------------------------------------------------------------
-- Direct reports of the caller: employees (not deleted) whose primary or secondary manager is one of the caller's own
-- employee records, resolved through the membership link and always inside the same organisation as that record.
create or replace function app.team_employee_ids() returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(distinct e.id), '{}'::uuid[])
  from public.org_memberships m
  join public.employees e
    on e.organization_id = m.organization_id
   and (e.manager_employee_id = m.employee_id or e.secondary_manager_employee_id = m.employee_id)
  where m.user_id = app.uid() and m.status = 'active' and m.employee_id is not null
    and e.deleted_at is null
$$;

-- The reporting chain under the caller to depth 5 (manager-chain approvals): level 1 as above, deeper levels follow the
-- primary manager and fall back to the secondary manager only where no primary is set. Cycles are bounded by the depth.
create or replace function app.team_employee_ids_deep() returns uuid[]
language sql stable security definer set search_path = ''
as $$
  with recursive roots as (
    select m.employee_id as id, m.organization_id
    from public.org_memberships m
    where m.user_id = app.uid() and m.status = 'active' and m.employee_id is not null
  ),
  chain as (
    select e.id, e.organization_id, 1 as depth
    from public.employees e
    join roots r on r.organization_id = e.organization_id
    where e.deleted_at is null and (e.manager_employee_id = r.id or e.secondary_manager_employee_id = r.id)
    union
    select e.id, e.organization_id, c.depth + 1
    from public.employees e
    join chain c on c.organization_id = e.organization_id
    where c.depth < 5 and e.deleted_at is null
      and (e.manager_employee_id = c.id or (e.manager_employee_id is null and e.secondary_manager_employee_id = c.id))
  )
  select coalesce(array_agg(distinct c.id), '{}'::uuid[])
  from chain c
  where c.id not in (select id from roots)
$$;

-- Organisations where the principal holds ANY of the given permissions (same sources as app.org_ids_with_permission).
create or replace function app.org_ids_with_any_permission(p_perms text[]) returns uuid[]
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
      and rp.permission_key = any (p_perms)
    union all
    select g.organization_id
    from public.platform_access_grants g
    join public.platform_admins pa on pa.user_id = g.platform_admin_user_id and pa.status = 'active'
    where g.platform_admin_user_id = app.uid()
      and g.revoked_at is null
      and now() >= g.starts_at and now() < g.expires_at
      and (g.access_level = 'write' or exists (select 1 from unnest(p_perms) p where p like '%.view' or p like '%.export'))
  ) s
  where s.org_id is not null
$$;

grant execute on function app.team_employee_ids(), app.team_employee_ids_deep(), app.org_ids_with_any_permission(text[]) to authenticated, flowza_system, flowza_api, flowza_worker;

-- 3c. Policy generators with the team predicate --------------------------------------------------------------------------
-- A procedure with extra defaulted parameters is an OVERLOAD, and calls with the old arity would become ambiguous:
-- the previous signatures are dropped first, then the wider ones are (re)created.
drop procedure if exists app.apply_tenant_policies(regclass, text, text, text, text, text);
create or replace procedure app.apply_tenant_policies(
  p_table regclass,
  p_view_perm text,
  p_write_perm text,
  p_branch_col text default null,
  p_self_col text default null,
  p_delete_perm text default null,
  p_team_col text default null,
  p_team_perms text[] default null
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
  v_team text := 'false';
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
  if p_team_col is not null then
    if p_team_perms is null or cardinality(p_team_perms) = 0 then
      raise exception 'apply_tenant_policies(%): a team column needs at least one team permission', v_name;
    end if;
    v_team := format('(organization_id = any ((select app.org_ids_with_any_permission(%L::text[]))::uuid[]) and %I = any ((select app.team_employee_ids())::uuid[]))', p_team_perms, p_team_col);
  end if;

  v_read := format('((organization_id = any ((select app.org_ids_with_permission(%L))::uuid[]) and %s) or %s or %s)', p_view_perm, v_branch, v_self, v_team);
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

drop procedure if exists app.apply_readonly_tenant_policies(regclass, text, text, text);
create or replace procedure app.apply_readonly_tenant_policies(
  p_table regclass,
  p_view_perm text,
  p_branch_col text default null,
  p_self_col text default null,
  p_team_col text default null,
  p_team_perms text[] default null
)
language plpgsql
as $$
declare
  v_name text := p_table::text;
  v_short text := replace(replace(v_name, 'public.', ''), '.', '_');
  v_branch text := 'true';
  v_self text := 'false';
  v_team text := 'false';
begin
  if p_branch_col is not null then
    v_branch := format(
      '(organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or %1$I is null or %1$I = any ((select app.allowed_branch_ids())::uuid[]))',
      p_branch_col);
  end if;
  if p_self_col is not null then
    v_self := format('(%1$I = any ((select app.own_employee_ids())::uuid[]))', p_self_col);
  end if;
  if p_team_col is not null then
    if p_team_perms is null or cardinality(p_team_perms) = 0 then
      raise exception 'apply_readonly_tenant_policies(%): a team column needs at least one team permission', v_name;
    end if;
    v_team := format('(organization_id = any ((select app.org_ids_with_any_permission(%L::text[]))::uuid[]) and %I = any ((select app.team_employee_ids())::uuid[]))', p_team_perms, p_team_col);
  end if;
  execute format('alter table %s enable row level security', v_name);
  execute format('drop policy if exists %I on %s', v_short || '_select', v_name);
  execute format('drop policy if exists %I on %s', v_short || '_system_write', v_name);
  execute format('create policy %I on %s for select to authenticated, flowza_system using ((organization_id = any ((select app.org_ids_with_permission(%L))::uuid[]) and %s) or %s or %s)',
    v_short || '_select', v_name, p_view_perm, v_branch, v_self, v_team);
  execute format('create policy %I on %s for all to flowza_system using (organization_id = app.system_org_id()) with check (organization_id = app.system_org_id())',
    v_short || '_system_write', v_name);
end $$;

-- 3d. Re-apply the policies of the team-scoped tables ------------------------------------------------------------------
-- Only the generator's own policies (<table>_select/_insert/_update/_delete/_system_write) are replaced; the
-- self-service (20260927000100) and platform-context (20260905002000) policies keep their names and stay in force.
call app.apply_tenant_policies('public.employees', 'employee.view', 'employee.update', 'branch_id', 'id', 'employee.delete', 'id', array['attendance.view_team', 'leave.view_team']);
-- creating employees needs employee.create (same override as 20260905001400)
drop policy if exists employees_insert on public.employees;
create policy employees_insert on public.employees for insert to authenticated, flowza_system with check (
  organization_id = any ((select app.org_ids_with_permission('employee.create'))::uuid[])
  and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or branch_id = any ((select app.allowed_branch_ids())::uuid[]))
);
call app.apply_tenant_policies('public.leave_records', 'leave.view', 'leave.manage', 'branch_id', 'employee_id', null, 'employee_id', array['leave.view_team']);
call app.apply_readonly_tenant_policies('public.attendance_raw_transactions', 'attendance.view_raw', 'branch_id', null, 'employee_id', array['attendance.view_team']);
call app.apply_readonly_tenant_policies('public.attendance_events', 'attendance.view', 'branch_id', 'employee_id', 'employee_id', array['attendance.view_team']);
call app.apply_readonly_tenant_policies('public.attendance_daily_records', 'attendance.view', 'branch_id', 'employee_id', 'employee_id', array['attendance.view_team']);
call app.apply_tenant_policies('public.attendance_corrections', 'attendance.view', 'attendance.correct', 'branch_id', 'employee_id', null, 'employee_id', array['attendance.view_team']);

-- 4. Principal snapshot with the team --------------------------------------------------------------------------------------
-- Same document as 20260909000300 plus `teamEmployeeIds` per membership (direct reports of the membership's employee
-- record, same rule as app.team_employee_ids()). Only flowza_api may execute it.
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
        'teamEmployeeIds', case when m.employee_id is null then '[]'::jsonb
                                else coalesce((select jsonb_agg(e.id order by e.id) from public.employees e
                                               where e.organization_id = m.organization_id and e.deleted_at is null
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

-- 5. Post-verify (fails the migration rather than leaving a half-applied state) --------------------------------------------
do $$
declare v_count int;
begin
  if (select count(*) from public.roles where id in ('10000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000010') and is_system and organization_id is null) <> 2 then
    raise exception 'system roles manager/auditor missing';
  end if;
  if (select count(*) from public.permissions where key in ('attendance.view_team', 'attendance.checkin', 'attendance.note', 'attendance.review_notes', 'attendance.manage_geofences', 'attendance.manage_overtime',
        'leave.approve', 'leave.view_team', 'shift.request_swap', 'approval.manage', 'approval.delegate', 'report.schedule', 'integration.manage')) <> 13 then
    raise exception 'permission vocabulary incomplete';
  end if;
  if (select count(*) from public.role_permissions where role_id = '10000000-0000-0000-0000-000000000009') <> 17
     or (select count(*) from public.role_permissions where role_id = '10000000-0000-0000-0000-000000000010') <> 14 then
    raise exception 'manager/auditor permission sets do not match the matrix';
  end if;
  select count(*) into v_count from pg_policies
  where schemaname = 'public' and policyname = tablename || '_select' and qual like '%team_employee_ids%'
    and tablename in ('employees', 'leave_records', 'attendance_raw_transactions', 'attendance_events', 'attendance_daily_records', 'attendance_corrections');
  if v_count <> 6 then raise exception 'team predicate missing on % of the 6 team-scoped tables', 6 - v_count; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employees' and column_name = 'secondary_manager_employee_id')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'invitations' and column_name = 'employee_id') then
    raise exception 'expected columns missing';
  end if;
  if pg_get_functiondef('app.principal_snapshot(uuid)'::regprocedure) not like '%teamEmployeeIds%' then
    raise exception 'principal_snapshot does not return teamEmployeeIds';
  end if;
end $$;
