-- Line managers assign shifts to their own team (field report 2026-10-21: "the line manager should have the option to assign
-- shifts to employees" — Shifts & schedules → Assignments offered the Line Manager no way to assign).
--
-- 1. Permission `shift.assign_team` ("Assign shifts to direct reports"), the write twin of the read keys
--    `attendance.view_team` / `leave.view_team`: it opens EMPLOYEE-targeted shift assignments of the holder's DIRECT reports
--    (`app.team_employee_ids()`: primary or secondary manager on the employee record) and nothing else — no branch, department,
--    team or organisation targets, no one outside the team, not the holder's own record. `shift.assign` keeps meaning
--    "assign anybody in my branch scope" and is untouched.
-- 2. Grants: the system `manager` (Line Manager) role, and every SYSTEM role that already holds `shift.assign` (owner, org
--    admin, HR admin… — an actor can only hand out a key they hold, so they must carry it to build custom roles). Custom roles
--    are untouched, like every other additive permission migration.
-- 3. RLS: `shift_assignments` insert / update / delete gain the team clause next to the existing organisation-wide one, so the
--    database enforces the team scope again whatever the service checked (authorization twice). Reads are unchanged
--    (`shift.view`, which the manager role already holds).
--
-- Additive, idempotent, no backfill. Bounded lock waits.
set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

-- 1. Permission -----------------------------------------------------------------------------------------------------------
insert into public.permissions (key, category, description, sort_order) values
  ('shift.assign_team', 'shifts', 'Assign shifts to direct reports (line manager scope)', 72)
on conflict (key) do update set category = excluded.category, description = excluded.description, sort_order = excluded.sort_order;

-- 2. Grants (a migration has no caller, so the escalation trigger — which judges a client's grant by the caller's own
--    permissions — is bypassed for these statements only; each grant mirrors an existing one or the seeded manager role) -------
alter table public.role_permissions disable trigger role_permissions_no_escalation;
insert into public.role_permissions (role_id, permission_key) values ('10000000-0000-0000-0000-000000000009', 'shift.assign_team')
on conflict do nothing;
insert into public.role_permissions (role_id, permission_key)
select rp.role_id, 'shift.assign_team'
from public.role_permissions rp
join public.roles r on r.id = rp.role_id
where rp.permission_key = 'shift.assign' and r.organization_id is null and r.is_system
on conflict do nothing;
alter table public.role_permissions enable trigger role_permissions_no_escalation;

-- 3. RLS on shift_assignments ---------------------------------------------------------------------------------------------
-- The organisation-wide clause is exactly what app.apply_tenant_policies generated (permission + branch scope); the team clause
-- is an EMPLOYEE target that is one of the caller's direct reports in an organisation where they hold the team key.
drop policy if exists shift_assignments_insert on public.shift_assignments;
drop policy if exists shift_assignments_update on public.shift_assignments;
drop policy if exists shift_assignments_delete on public.shift_assignments;

create policy shift_assignments_insert on public.shift_assignments for insert to authenticated, flowza_system
  with check (
    (organization_id = any ((select app.org_ids_with_permission('shift.assign'))::uuid[])
      and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or branch_id is null or branch_id = any ((select app.allowed_branch_ids())::uuid[])))
    or (target_type = 'EMPLOYEE'
      and organization_id = any ((select app.org_ids_with_permission('shift.assign_team'))::uuid[])
      and target_id = any ((select app.team_employee_ids())::uuid[]))
  );
create policy shift_assignments_update on public.shift_assignments for update to authenticated, flowza_system
  using (
    (organization_id = any ((select app.org_ids_with_permission('shift.assign'))::uuid[])
      and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or branch_id is null or branch_id = any ((select app.allowed_branch_ids())::uuid[])))
    or (target_type = 'EMPLOYEE'
      and organization_id = any ((select app.org_ids_with_permission('shift.assign_team'))::uuid[])
      and target_id = any ((select app.team_employee_ids())::uuid[]))
  )
  with check (
    (organization_id = any ((select app.org_ids_with_permission('shift.assign'))::uuid[])
      and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or branch_id is null or branch_id = any ((select app.allowed_branch_ids())::uuid[])))
    or (target_type = 'EMPLOYEE'
      and organization_id = any ((select app.org_ids_with_permission('shift.assign_team'))::uuid[])
      and target_id = any ((select app.team_employee_ids())::uuid[]))
  );
create policy shift_assignments_delete on public.shift_assignments for delete to authenticated, flowza_system
  using (
    (organization_id = any ((select app.org_ids_with_permission('shift.assign'))::uuid[])
      and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or branch_id is null or branch_id = any ((select app.allowed_branch_ids())::uuid[])))
    or (target_type = 'EMPLOYEE'
      and organization_id = any ((select app.org_ids_with_permission('shift.assign_team'))::uuid[])
      and target_id = any ((select app.team_employee_ids())::uuid[]))
  );
