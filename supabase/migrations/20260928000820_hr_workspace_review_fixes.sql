-- FlowZa Time · 20260928000820 · HR attendance workspace — review fixes (HR portal Prompt 6a review,
-- docs/hr-portal/reviews/06a-hr-attendance-workspace-review.md; report: docs/hr-portal/reports/06a-hr-attendance-workspace.md
-- §"Review fixes").
--
-- 1. Storage (defect 1, P0). The `authenticated` read policy on storage.objects let any report.view holder list and download
--    EVERY report file of the organisation (reports/<org>/<request>.<fmt>) — past report.export, branch / team scope, the
--    per-recipient scope of shared copies and download ownership, all of which the API enforces before it signs a 5-minute URL.
--    Report files are now readable by the organisation's system context only; people reach them through the API's download.
--    The same class of problem, audited on every other bucket (an organisation-wide key granting objects whose API access is
--    narrower), is closed where it existed:
--      * employee-photos — read by employee.view org-wide, although a branch-scoped holder reads only their branches' employees
--        (and a line manager their reports): now `<org>/<employee id>/…` is readable exactly when the caller can read that
--        employee record (the employees RLS decides — branch scope, own record, direct reports);
--      * documents (identity documents) — employee.view_sensitive org-wide: now also the employee inside the caller's branches;
--      * writes (insert / update / delete) of both: employee.update org-wide (or organization.manage for any object): now the
--        employee must sit in the caller's branch scope, and organization.manage keeps only org-logos and imports;
--      * the system context now writes only its own organisation's folder (it was any folder).
--    Unchanged on purpose: org-logos (every member sees the logo in the app), imports (employee.import, the same breadth as the
--    import jobs themselves; the CSV travels in the request body today, nothing is stored there).
-- 2. report_schedules (defect 3, P0). The generic tenant policy let a branch-restricted report.schedule holder update, delete
--    and create ORGANISATION-WIDE schedules (branch_id null) directly through PostgREST — re-pointing them, silencing their
--    recipients, or rewinding next_run_at to trigger a full run on every scheduler tick past the share quota. Writes are now
--    RPC / service only: no client write policy, no client write privilege (a client write RAISES), and a system-context write
--    policy for the API's system step (after its checks) and the worker. Reads stay with report.view, but a branch-restricted
--    holder sees the schedules of THEIR branches only — organisation-wide ones need an unrestricted membership.
-- 3. report_deliveries (defect 3). Any report.schedule holder read the whole organisation's delivery trail. Now: the recipient;
--    an unrestricted report.schedule holder (all); a branch-restricted one — what they sent and the deliveries of schedules of
--    their branches.
-- 4. report_deliveries.status gains `cancelled` (minor 14): a recipient who cancels their queued copy settles its delivery.
-- 5. report.schedule granted to the system role hr_admin (the HR "manage" role, which already holds report.view/export/manage),
--    per the review's least-privilege recommendation; payroll keeps it (the recipient picker is now scoped, minor 12).
--
-- Idempotent (drop / create the named policies, `on conflict do nothing`, constraint re-created); additive otherwise. Safe as one
-- transaction (no enum value, no concurrent index). Bounded lock waits.
set lock_timeout = '5s';
set statement_timeout = '120s';
set client_min_messages = warning;

-- 1. Storage ------------------------------------------------------------------------------------------------------------------
-- The n-th folder of an object name as a uuid (`<org>/<employee id>/<file>` → part 2 = the employee), null when it is not one.
create or replace function app.path_uuid(p_name text, p_part int) returns uuid language sql immutable as $$
  select case when split_part(p_name, '/', p_part) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(p_name, '/', p_part)::uuid end
$$;
grant execute on function app.path_uuid(text, int) to authenticated, flowza_system, flowza_api, flowza_worker;

do $$
begin
  if to_regclass('storage.objects') is not null then
    execute $p$ drop policy if exists flowza_objects_read on storage.objects $p$;
    execute $p$ create policy flowza_objects_read on storage.objects for select to authenticated, flowza_system using (
      app.path_org_id(name) is not null and (
        (bucket_id = 'org-logos' and app.path_org_id(name) = any ((select app.member_org_ids())::uuid[]))
        -- <org>/<employee id>/…: whoever may read that employee record (employees RLS: branch scope, own record, direct reports)
        or (bucket_id = 'employee-photos' and exists (
              select 1 from public.employees e where e.organization_id = app.path_org_id(name) and e.id = app.path_uuid(name, 2)))
        -- report files: the organisation's system context only; people download through the API (report.export + ownership)
        or (bucket_id = 'reports' and (select app.is_system()) and app.path_org_id(name) = (select app.system_org_id()))
        or (bucket_id = 'imports' and app.path_org_id(name) = any ((select app.org_ids_with_permission('employee.import'))::uuid[]))
        -- <org>/<employee id>/…: employee.view_sensitive AND the employee inside the caller's branch scope
        or (bucket_id = 'documents' and app.path_org_id(name) = any ((select app.org_ids_with_permission('employee.view_sensitive'))::uuid[])
            and exists (select 1 from public.employees e where e.organization_id = app.path_org_id(name) and e.id = app.path_uuid(name, 2)
                          and (e.organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or e.branch_id = any ((select app.allowed_branch_ids())::uuid[]))))
      )) $p$;
    execute $p$ drop policy if exists flowza_objects_write on storage.objects $p$;
    execute $p$ create policy flowza_objects_write on storage.objects for insert to authenticated, flowza_system with check (
      app.path_org_id(name) is not null and (
        (bucket_id = 'org-logos' and app.path_org_id(name) = any ((select app.org_ids_with_permission('organization.manage'))::uuid[]))
        or (bucket_id in ('employee-photos', 'documents') and app.path_org_id(name) = any ((select app.org_ids_with_permission('employee.update'))::uuid[])
            and exists (select 1 from public.employees e where e.organization_id = app.path_org_id(name) and e.id = app.path_uuid(name, 2)
                          and (e.organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or e.branch_id = any ((select app.allowed_branch_ids())::uuid[]))))
        or (bucket_id = 'reports' and (select app.is_system()) and app.path_org_id(name) = (select app.system_org_id()))
        or (bucket_id = 'imports' and app.path_org_id(name) = any ((select app.org_ids_with_permission('employee.import'))::uuid[]))
      )) $p$;
    execute $p$ drop policy if exists flowza_objects_update on storage.objects $p$;
    execute $p$ create policy flowza_objects_update on storage.objects for update to authenticated, flowza_system using (
      app.path_org_id(name) is not null and (
        ((select app.is_system()) and app.path_org_id(name) = (select app.system_org_id()))
        or (bucket_id in ('org-logos', 'imports') and app.path_org_id(name) = any ((select app.org_ids_with_permission('organization.manage'))::uuid[]))
        or (bucket_id in ('employee-photos', 'documents') and app.path_org_id(name) = any ((select app.org_ids_with_permission('employee.update'))::uuid[])
            and exists (select 1 from public.employees e where e.organization_id = app.path_org_id(name) and e.id = app.path_uuid(name, 2)
                          and (e.organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or e.branch_id = any ((select app.allowed_branch_ids())::uuid[]))))
      )) $p$;
    execute $p$ drop policy if exists flowza_objects_delete on storage.objects $p$;
    execute $p$ create policy flowza_objects_delete on storage.objects for delete to authenticated, flowza_system using (
      app.path_org_id(name) is not null and (
        ((select app.is_system()) and app.path_org_id(name) = (select app.system_org_id()))
        or (bucket_id in ('org-logos', 'imports') and app.path_org_id(name) = any ((select app.org_ids_with_permission('organization.manage'))::uuid[]))
        or (bucket_id in ('employee-photos', 'documents') and app.path_org_id(name) = any ((select app.org_ids_with_permission('employee.update'))::uuid[])
            and exists (select 1 from public.employees e where e.organization_id = app.path_org_id(name) and e.id = app.path_uuid(name, 2)
                          and (e.organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or e.branch_id = any ((select app.allowed_branch_ids())::uuid[]))))
      )) $p$;
  end if;
end $$;

-- 2. report_schedules: read scoped to the caller's branches, written by the service / worker only -------------------------------
drop policy if exists report_schedules_select on public.report_schedules;
create policy report_schedules_select on public.report_schedules for select to authenticated, flowza_system using (
  organization_id = any ((select app.org_ids_with_permission('report.view'))::uuid[])
  -- organisation-wide schedules (branch_id null) only for unrestricted memberships; a branch-scoped holder sees their branches'
  and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or (branch_id is not null and branch_id = any ((select app.allowed_branch_ids())::uuid[])))
);
drop policy if exists report_schedules_insert on public.report_schedules;
drop policy if exists report_schedules_update on public.report_schedules;
drop policy if exists report_schedules_delete on public.report_schedules;
drop policy if exists report_schedules_system_write on public.report_schedules;
create policy report_schedules_system_write on public.report_schedules for all to flowza_system
  using (organization_id = app.system_org_id()) with check (organization_id = app.system_org_id());
-- the schema default privileges grant authenticated insert/update/delete; take them back so a client write raises instead of
-- being filtered (the API writes through its system step after the checks; next_run_at / last_* / created_by are server-computed)
revoke insert, update, delete on public.report_schedules from authenticated;

-- 3. report_deliveries: the recipient, and schedulers within their branch scope ------------------------------------------------
drop policy if exists report_deliveries_select on public.report_deliveries;
create policy report_deliveries_select on public.report_deliveries for select to authenticated, flowza_system using (
  recipient_user_id = (select app.uid())
  or (organization_id = any ((select app.org_ids_with_permission('report.schedule'))::uuid[]) and (
        organization_id = any ((select app.unrestricted_org_ids())::uuid[])
        or sent_by = (select app.uid())
        or exists (select 1 from public.report_schedules s
                   where s.id = report_deliveries.schedule_id and s.organization_id = report_deliveries.organization_id
                     and s.branch_id = any ((select app.allowed_branch_ids())::uuid[]))))
);

-- 4. a cancelled copy settles its delivery ------------------------------------------------------------------------------------
alter table public.report_deliveries drop constraint if exists report_deliveries_status_check;
alter table public.report_deliveries add constraint report_deliveries_status_check check (status in ('queued', 'delivered', 'skipped', 'failed', 'cancelled'));

-- 5. hr_admin shares and schedules reports (system roles are reference data: only migrations write them) ------------------------
insert into public.role_permissions (role_id, permission_key) values ('10000000-0000-0000-0000-000000000003', 'report.schedule') on conflict do nothing;

-- Safety net (new tables must have RLS).
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

-- Post-verify.
do $$
begin
  if to_regclass('storage.objects') is not null then
    if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'flowza_objects_read') then raise exception 'storage read policy missing'; end if;
    if exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'flowza_objects_read' and qual like '%report.view%') then
      raise exception 'storage: report files must not be readable by report.view holders';
    end if;
    if exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'flowza_objects_read' and qual like '%org_ids_with_permission(''employee.view''%') then
      raise exception 'storage: employee photos must not be readable by the organisation-wide key alone';
    end if;
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'report_schedules' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL') and 'authenticated' = any (roles)) then
    raise exception 'report_schedules must have no client write policy';
  end if;
  if has_table_privilege('authenticated', 'public.report_schedules', 'insert') or has_table_privilege('authenticated', 'public.report_schedules', 'update')
     or has_table_privilege('authenticated', 'public.report_schedules', 'delete') then raise exception 'authenticated must not hold write privileges on report_schedules'; end if;
  if not has_table_privilege('authenticated', 'public.report_schedules', 'select') then raise exception 'authenticated must still read report_schedules'; end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'report_schedules' and policyname = 'report_schedules_system_write' and 'flowza_system' = any (roles)) then
    raise exception 'report_schedules system write policy missing';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'report_schedules' and policyname = 'report_schedules_select' and qual like '%branch_id IS NULL%') then
    raise exception 'report_schedules: organisation-wide rows must not be readable through the branch scope';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'report_schedules' and policyname = 'report_schedules_platform_ctx') then
    raise exception 'report_schedules platform-context read policy missing (scheduler)';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'report_deliveries' and policyname = 'report_deliveries_select' and qual like '%unrestricted_org_ids%') then
    raise exception 'report_deliveries read policy must be branch scoped';
  end if;
  if has_table_privilege('authenticated', 'public.report_deliveries', 'insert') or has_table_privilege('authenticated', 'public.report_deliveries', 'update')
     or has_table_privilege('authenticated', 'public.report_deliveries', 'delete') then raise exception 'authenticated must not hold write privileges on report_deliveries'; end if;
  if not exists (select 1 from pg_constraint where conname = 'report_deliveries_status_check' and pg_get_constraintdef(oid) like '%cancelled%') then
    raise exception 'report_deliveries status must accept cancelled';
  end if;
  if not exists (select 1 from public.role_permissions where role_id = '10000000-0000-0000-0000-000000000003' and permission_key = 'report.schedule') then
    raise exception 'hr_admin must hold report.schedule';
  end if;
end $$;
