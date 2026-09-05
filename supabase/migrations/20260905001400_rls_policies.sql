-- FlowZa Time · 1400 · Row Level Security on every table (ADR-002)
set client_min_messages = warning;
-- Grants ----------------------------------------------------------------------------------------
-- Supabase grants anon/authenticated by default via default privileges of the postgres role; we make the
-- grants explicit (so a stock Postgres behaves identically) and remove anonymous access entirely.
grant select, insert, update, delete on all tables in schema public to authenticated, flowza_system;
grant usage, select on all sequences in schema public to authenticated, flowza_system;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated, flowza_system;
alter default privileges in schema public grant usage, select on sequences to authenticated, flowza_system;
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;

-- Sensitive tables: clients never touch them directly.
revoke all on public.device_credentials from authenticated;
revoke all on public.domain_events from authenticated;
revoke all on public.pending_devices from authenticated;
grant select on public.pending_devices to authenticated;
revoke all on public.login_history from authenticated;
grant select on public.login_history to authenticated;
grant select on audit.logs to authenticated, flowza_system;
grant insert on audit.logs to authenticated, flowza_system;
grant usage on schema audit to authenticated;
grant usage, select on all sequences in schema audit to authenticated, flowza_system;

-- Platform reference tables: readable by everyone signed in, writable only by system/migrations.
alter table public.permissions enable row level security;
create policy permissions_read on public.permissions for select to authenticated, flowza_system using (true);
alter table public.device_providers enable row level security;
create policy device_providers_read on public.device_providers for select to authenticated, flowza_system using (true);
create policy device_providers_system_write on public.device_providers for all to flowza_system using (app.is_system()) with check (app.is_system());
alter table public.device_models enable row level security;
create policy device_models_read on public.device_models for select to authenticated, flowza_system using (true);
create policy device_models_system_write on public.device_models for all to flowza_system using (app.is_system()) with check (app.is_system());
alter table public.plans enable row level security;
create policy plans_read on public.plans for select to authenticated, flowza_system using (is_active or app.is_platform_admin() or app.is_system());
create policy plans_platform_write on public.plans for all to authenticated, flowza_system using (app.is_platform_admin() or app.is_system()) with check (app.is_platform_admin() or app.is_system());
alter table public.feature_flags enable row level security;
create policy feature_flags_read on public.feature_flags for select to authenticated, flowza_system using (true);
create policy feature_flags_platform_write on public.feature_flags for all to authenticated, flowza_system using (app.is_platform_admin() or app.is_system()) with check (app.is_platform_admin() or app.is_system());

-- Users / platform admins -----------------------------------------------------------------------
alter table public.user_profiles enable row level security;
create policy user_profiles_self on public.user_profiles for select to authenticated using (id = app.uid());
create policy user_profiles_self_update on public.user_profiles for update to authenticated using (id = app.uid()) with check (id = app.uid());
create policy user_profiles_self_insert on public.user_profiles for insert to authenticated with check (id = app.uid());
-- members of the same organisation can see each other's profile (name/avatar) for assignment UIs
create policy user_profiles_org_peers on public.user_profiles for select to authenticated using (
  exists (select 1 from public.org_memberships m where m.user_id = user_profiles.id and m.organization_id = any ((select app.org_ids_with_permission('user.view'))::uuid[]))
);
create policy user_profiles_system on public.user_profiles for all to flowza_system using (app.is_system()) with check (app.is_system());
create policy user_profiles_platform on public.user_profiles for select to authenticated using (app.is_platform_admin());

alter table public.platform_admins enable row level security;
create policy platform_admins_self on public.platform_admins for select to authenticated using (user_id = app.uid() or app.is_platform_admin());
create policy platform_admins_system on public.platform_admins for all to flowza_system using (app.is_system()) with check (app.is_system());

alter table public.platform_access_grants enable row level security;
create policy platform_access_grants_admin on public.platform_access_grants for select to authenticated using (app.is_platform_admin() or organization_id = any ((select app.org_ids_with_permission('organization.manage'))::uuid[]));
create policy platform_access_grants_system on public.platform_access_grants for all to flowza_system using (app.is_system()) with check (app.is_system());

alter table public.login_history enable row level security;
create policy login_history_self on public.login_history for select to authenticated using (user_id = app.uid());
create policy login_history_system on public.login_history for all to flowza_system using (app.is_system()) with check (app.is_system());

-- Organisations ----------------------------------------------------------------------------------
alter table public.organizations enable row level security;
create policy organizations_member_read on public.organizations for select to authenticated, flowza_system using (id = any ((select app.member_org_ids())::uuid[]) or app.is_platform_admin());
create policy organizations_manage on public.organizations for update to authenticated, flowza_system using (id = any ((select app.org_ids_with_permission('organization.manage'))::uuid[])) with check (id = any ((select app.org_ids_with_permission('organization.manage'))::uuid[]));
create policy organizations_platform_write on public.organizations for insert to authenticated, flowza_system with check (app.is_platform_admin() or app.is_system());
create policy organizations_platform_delete on public.organizations for delete to authenticated using (app.is_platform_admin());

alter table public.organization_settings enable row level security;
create policy organization_settings_read on public.organization_settings for select to authenticated, flowza_system using (organization_id = any ((select app.member_org_ids())::uuid[]));
create policy organization_settings_write on public.organization_settings for all to authenticated, flowza_system using (organization_id = any ((select app.org_ids_with_permission('organization.manage'))::uuid[])) with check (organization_id = any ((select app.org_ids_with_permission('organization.manage'))::uuid[]));

-- Roles & memberships ----------------------------------------------------------------------------
alter table public.roles enable row level security;
create policy roles_read on public.roles for select to authenticated, flowza_system using (is_system or organization_id = any ((select app.member_org_ids())::uuid[]));
create policy roles_write on public.roles for all to authenticated, flowza_system using (not is_system and organization_id = any ((select app.org_ids_with_permission('role.manage'))::uuid[])) with check (not is_system and organization_id = any ((select app.org_ids_with_permission('role.manage'))::uuid[]));

alter table public.role_permissions enable row level security;
create policy role_permissions_read on public.role_permissions for select to authenticated, flowza_system using (
  exists (select 1 from public.roles r where r.id = role_permissions.role_id and (r.is_system or r.organization_id = any ((select app.member_org_ids())::uuid[])))
);
create policy role_permissions_write on public.role_permissions for all to authenticated, flowza_system using (
  exists (select 1 from public.roles r where r.id = role_permissions.role_id and not r.is_system and r.organization_id = any ((select app.org_ids_with_permission('role.manage'))::uuid[]))
) with check (
  exists (select 1 from public.roles r where r.id = role_permissions.role_id and not r.is_system and r.organization_id = any ((select app.org_ids_with_permission('role.manage'))::uuid[]))
);

alter table public.org_memberships enable row level security;
create policy org_memberships_self on public.org_memberships for select to authenticated using (user_id = app.uid());
create policy org_memberships_read on public.org_memberships for select to authenticated, flowza_system using (organization_id = any ((select app.org_ids_with_permission('user.view'))::uuid[]));
create policy org_memberships_write on public.org_memberships for all to authenticated, flowza_system using (organization_id = any ((select app.org_ids_with_permission('user.manage'))::uuid[])) with check (organization_id = any ((select app.org_ids_with_permission('user.manage'))::uuid[]));

alter table public.membership_branches enable row level security;
create policy membership_branches_read on public.membership_branches for select to authenticated, flowza_system using (
  exists (select 1 from public.org_memberships m where m.id = membership_branches.membership_id and (m.user_id = app.uid() or m.organization_id = any ((select app.org_ids_with_permission('user.view'))::uuid[])))
);
create policy membership_branches_write on public.membership_branches for all to authenticated, flowza_system using (
  exists (select 1 from public.org_memberships m where m.id = membership_branches.membership_id and m.organization_id = any ((select app.org_ids_with_permission('user.manage'))::uuid[]))
) with check (
  exists (select 1 from public.org_memberships m where m.id = membership_branches.membership_id and m.organization_id = any ((select app.org_ids_with_permission('user.manage'))::uuid[]))
);

call app.apply_tenant_policies('public.invitations', 'user.view', 'user.manage');

-- Org structure ----------------------------------------------------------------------------------
call app.apply_tenant_policies('public.branches', 'branch.view', 'branch.manage', 'id');
call app.apply_tenant_policies('public.departments', 'department.view', 'department.manage', 'branch_id');
call app.apply_tenant_policies('public.designations', 'department.view', 'department.manage');
call app.apply_tenant_policies('public.teams', 'department.view', 'department.manage', 'branch_id');
call app.apply_tenant_policies('public.team_members', 'department.view', 'department.manage');

-- Employees --------------------------------------------------------------------------------------
call app.apply_tenant_policies('public.employees', 'employee.view', 'employee.update', 'branch_id', 'id', 'employee.delete');
-- creating employees needs employee.create (override the generated insert policy)
drop policy employees_insert on public.employees;
create policy employees_insert on public.employees for insert to authenticated, flowza_system with check (
  organization_id = any ((select app.org_ids_with_permission('employee.create'))::uuid[])
  and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or branch_id = any ((select app.allowed_branch_ids())::uuid[]))
);
call app.apply_tenant_policies('public.employment_history', 'employee.view', 'employee.update', 'branch_id', 'employee_id');
call app.apply_tenant_policies('public.employee_identity_documents', 'employee.view_sensitive', 'employee.update', 'branch_id', 'employee_id');
call app.apply_tenant_policies('public.employee_provider_identities', 'employee.view', 'employee.update', null, 'employee_id');
call app.apply_tenant_policies('public.device_employee_states', 'device.view', 'device.sync', 'branch_id', 'employee_id');

-- Devices ----------------------------------------------------------------------------------------
call app.apply_tenant_policies('public.devices', 'device.view', 'device.update', 'branch_id', null, 'device.manage');
drop policy devices_insert on public.devices;
create policy devices_insert on public.devices for insert to authenticated, flowza_system with check (
  organization_id = any ((select app.org_ids_with_permission('device.create'))::uuid[])
  and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or branch_id = any ((select app.allowed_branch_ids())::uuid[]))
);
-- device_credentials: system only (API uses secrets.* functions after an explicit device.manage check)
alter table public.device_credentials enable row level security;
create policy device_credentials_system on public.device_credentials for all to flowza_system using (organization_id = app.system_org_id()) with check (organization_id = app.system_org_id());
alter table public.pending_devices enable row level security;
create policy pending_devices_read on public.pending_devices for select to authenticated, flowza_system using (
  app.is_system() or (organization_id is not null and organization_id = any ((select app.org_ids_with_permission('device.create'))::uuid[]))
);
create policy pending_devices_system on public.pending_devices for all to flowza_system using (app.is_system()) with check (app.is_system());
call app.apply_tenant_policies('public.device_groups', 'device.view', 'device.manage', 'branch_id');
call app.apply_tenant_policies('public.device_group_members', 'device.view', 'device.manage');
call app.apply_readonly_tenant_policies('public.device_commands', 'device.view');
call app.apply_readonly_tenant_policies('public.device_logs', 'device.view');

-- Sync -------------------------------------------------------------------------------------------
call app.apply_tenant_policies('public.sync_jobs', 'device.view', 'device.sync', 'branch_id');
call app.apply_tenant_policies('public.sync_job_items', 'device.view', 'device.sync', 'branch_id');
call app.apply_readonly_tenant_policies('public.sync_attempts', 'device.view');
call app.apply_readonly_tenant_policies('public.sync_cursors', 'device.view');
call app.apply_readonly_tenant_policies('public.sync_logs', 'device.view');
alter table public.provider_webhook_events enable row level security;
create policy provider_webhook_events_read on public.provider_webhook_events for select to authenticated, flowza_system using (
  app.is_system() or (organization_id is not null and organization_id = any ((select app.org_ids_with_permission('device.view'))::uuid[]))
);
create policy provider_webhook_events_system on public.provider_webhook_events for all to flowza_system using (app.is_system()) with check (app.is_system());

-- Shifts, rules, holidays, leave -----------------------------------------------------------------
call app.apply_tenant_policies('public.shifts', 'shift.view', 'shift.manage');
call app.apply_tenant_policies('public.shift_patterns', 'shift.view', 'shift.manage');
call app.apply_tenant_policies('public.shift_assignments', 'shift.view', 'shift.assign', 'branch_id');
call app.apply_tenant_policies('public.attendance_rule_sets', 'attendance.view', 'attendance.manage_rules', 'branch_id');
call app.apply_tenant_policies('public.holiday_calendars', 'holiday.view', 'holiday.manage');
call app.apply_tenant_policies('public.holidays', 'holiday.view', 'holiday.manage');
call app.apply_tenant_policies('public.leave_types', 'leave.view', 'leave.manage');
call app.apply_tenant_policies('public.leave_records', 'leave.view', 'leave.manage', 'branch_id', 'employee_id');

-- Attendance -------------------------------------------------------------------------------------
call app.apply_readonly_tenant_policies('public.attendance_raw_transactions', 'attendance.view_raw', 'branch_id');
call app.apply_readonly_tenant_policies('public.attendance_events', 'attendance.view', 'branch_id', 'employee_id');
call app.apply_readonly_tenant_policies('public.attendance_daily_records', 'attendance.view', 'branch_id', 'employee_id');
call app.apply_readonly_tenant_policies('public.attendance_daily_record_history', 'attendance.view', 'branch_id', 'employee_id');
call app.apply_tenant_policies('public.attendance_corrections', 'attendance.view', 'attendance.correct', 'branch_id', 'employee_id');
call app.apply_tenant_policies('public.approval_workflows', 'attendance.view', 'organization.manage', 'branch_id');
call app.apply_tenant_policies('public.approval_requests', 'attendance.view', 'attendance.approve', 'branch_id', 'employee_id');
call app.apply_tenant_policies('public.approval_steps', 'attendance.view', 'attendance.approve');
-- approvers assigned by user id can always see their own steps
create policy approval_steps_assignee on public.approval_steps for select to authenticated using (approver_user_id = app.uid());
call app.apply_tenant_policies('public.attendance_recalculation_requests', 'attendance.view', 'attendance.recalculate', 'branch_id');
call app.apply_tenant_policies('public.attendance_period_locks', 'attendance.view', 'attendance.lock_period', 'branch_id');
call app.apply_readonly_tenant_policies('public.attendance_period_summaries', 'payroll.view', 'branch_id', 'employee_id');

-- Reports, imports, notifications ----------------------------------------------------------------
call app.apply_tenant_policies('public.report_requests', 'report.view', 'report.view', 'branch_id');
drop policy report_requests_select on public.report_requests;
create policy report_requests_select on public.report_requests for select to authenticated, flowza_system using (
  requested_by = app.uid() or app.is_system() or organization_id = any ((select app.org_ids_with_permission('report.manage'))::uuid[])
);
call app.apply_tenant_policies('public.import_jobs', 'employee.import', 'employee.import');
call app.apply_tenant_policies('public.import_job_rows', 'employee.import', 'employee.import');
alter table public.notifications enable row level security;
create policy notifications_self on public.notifications for select to authenticated using (user_id = app.uid());
create policy notifications_self_update on public.notifications for update to authenticated using (user_id = app.uid()) with check (user_id = app.uid());
create policy notifications_system on public.notifications for all to flowza_system using (app.is_system()) with check (app.is_system());
alter table public.notification_preferences enable row level security;
create policy notification_preferences_self on public.notification_preferences for all to authenticated using (user_id = app.uid()) with check (user_id = app.uid());
create policy notification_preferences_system on public.notification_preferences for select to flowza_system using (app.is_system());
alter table public.notification_deliveries enable row level security;
create policy notification_deliveries_system on public.notification_deliveries for all to flowza_system using (app.is_system()) with check (app.is_system());

-- Audit (append-only; readers need audit.view; branch-scoped) -------------------------------------
alter table audit.logs enable row level security;
create policy audit_logs_read on audit.logs for select to authenticated, flowza_system using (
  (organization_id is not null and organization_id = any ((select app.org_ids_with_permission('audit.view'))::uuid[])
     and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or branch_id is null or branch_id = any ((select app.allowed_branch_ids())::uuid[])))
  or (organization_id is null and app.is_platform_admin())
  or app.is_system()
);
create policy audit_logs_insert on audit.logs for insert to authenticated, flowza_system with check (
  app.is_system() or (organization_id is not null and organization_id = any ((select app.member_org_ids())::uuid[]) and actor_user_id = app.uid())
);

-- Subscription, flags, api keys, outbox, retention ------------------------------------------------
alter table public.subscriptions enable row level security;
create policy subscriptions_read on public.subscriptions for select to authenticated, flowza_system using (organization_id = any ((select app.member_org_ids())::uuid[]) or app.is_platform_admin());
create policy subscriptions_platform_write on public.subscriptions for all to authenticated, flowza_system using (app.is_platform_admin() or app.is_system()) with check (app.is_platform_admin() or app.is_system());
alter table public.entitlements enable row level security;
create policy entitlements_read on public.entitlements for select to authenticated, flowza_system using (organization_id = any ((select app.member_org_ids())::uuid[]) or app.is_platform_admin());
create policy entitlements_platform_write on public.entitlements for all to authenticated, flowza_system using (app.is_platform_admin() or app.is_system()) with check (app.is_platform_admin() or app.is_system());
alter table public.usage_records enable row level security;
create policy usage_records_read on public.usage_records for select to authenticated, flowza_system using (organization_id = any ((select app.org_ids_with_permission('organization.manage'))::uuid[]) or app.is_platform_admin());
create policy usage_records_system on public.usage_records for all to flowza_system using (app.is_system()) with check (app.is_system());
alter table public.organization_feature_flags enable row level security;
create policy organization_feature_flags_read on public.organization_feature_flags for select to authenticated, flowza_system using (organization_id = any ((select app.member_org_ids())::uuid[]) or app.is_platform_admin());
create policy organization_feature_flags_platform_write on public.organization_feature_flags for all to authenticated, flowza_system using (app.is_platform_admin() or app.is_system()) with check (app.is_platform_admin() or app.is_system());
call app.apply_tenant_policies('public.api_keys', 'organization.manage', 'organization.manage');
alter table public.domain_events enable row level security;
create policy domain_events_system on public.domain_events for all to flowza_system using (app.is_system() or (organization_id = app.system_org_id())) with check (app.is_system());
-- authenticated sessions may only INSERT outbox rows for their own organisation (through the API service layer)
grant insert on public.domain_events to authenticated;
create policy domain_events_insert on public.domain_events for insert to authenticated with check (organization_id = any ((select app.member_org_ids())::uuid[]));
call app.apply_tenant_policies('public.outbound_webhook_subscriptions', 'organization.manage', 'organization.manage');
call app.apply_tenant_policies('public.data_retention_policies', 'organization.manage', 'organization.manage');

-- Safety net: every table in public/audit must have RLS enabled.
do $$
declare r record;
begin
  for r in select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p') and n.nspname in ('public', 'audit') and not c.relrowsecurity
             and c.relname not like '%\_default' and c.relname !~ '_\d{6}$'
  loop
    raise exception 'table %.% has no RLS', r.nspname, r.relname;
  end loop;
end $$;
