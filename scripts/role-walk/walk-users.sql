-- Role walk logins (LOCAL DATABASES ONLY — applied by scripts/role-walk/run.mjs --setup on top of the local seed, Al Bahja Trading).
--
--   walk.<role>@albahja.example          every system role, linked to an employee record (the self-service portal opens)
--   walk.<role>.nolink@albahja.example   the same roles without an employee link
--   walk.none / walk.none.nolink         a custom role with no permission at all (membership only)
--   walk.c_<module>@albahja.example      custom roles holding ONE key each (dashboard, reports, employees, devices, attendance, leave)
--
-- Line managers holding a non-manager role are part of the walk: walk.hr_user and walk.employee get two direct reports each,
-- walk.manager four. Every module is switched on for the organisation (a module that is off is its own, already tested screen).
-- Idempotent: a database that already has the walk logins is left as it is. Nothing else is changed apart from the module
-- switches and the reports' manager link.
\set ON_ERROR_STOP on
begin;

insert into public.organization_modules (organization_id, module_key, enabled, reason)
select '00000000-0000-4000-a000-000000000001', key, true, 'role walk' from public.modules
on conflict (organization_id, module_key) do update set enabled = true;

create temp table walk_roles (role_key text, role_id uuid, perm text, all_branches boolean, branch_code text, reports int, unlinked boolean);
insert into walk_roles values
  ('owner',            '10000000-0000-0000-0000-000000000001', null, true,  null,  0, true),
  ('org_admin',        '10000000-0000-0000-0000-000000000002', null, true,  null,  0, true),
  ('hr_admin',         '10000000-0000-0000-0000-000000000003', null, true,  null,  0, true),
  ('hr_user',          '10000000-0000-0000-0000-000000000004', null, true,  null,  2, true),
  ('branch_manager',   '10000000-0000-0000-0000-000000000005', null, false, 'SOH', 0, true),
  ('attendance_admin', '10000000-0000-0000-0000-000000000006', null, true,  null,  0, true),
  ('payroll',          '10000000-0000-0000-0000-000000000007', null, true,  null,  0, true),
  ('employee',         '10000000-0000-0000-0000-000000000008', null, true,  null,  2, true),
  ('manager',          '10000000-0000-0000-0000-000000000009', null, true,  null,  4, true),
  ('auditor',          '10000000-0000-0000-0000-000000000010', null, true,  null,  0, true),
  ('none',             '20000000-0000-0000-0000-0000000000ff', null, true,  null,  0, true),
  ('c_dashboard',      '20000000-0000-0000-0000-0000000000a1', 'dashboard.view',  true, null, 0, false),
  ('c_reports',        '20000000-0000-0000-0000-0000000000a2', 'report.view',     true, null, 0, false),
  ('c_employees',      '20000000-0000-0000-0000-0000000000a3', 'employee.view',   true, null, 0, false),
  ('c_devices',        '20000000-0000-0000-0000-0000000000a4', 'device.view',     true, null, 0, false),
  ('c_attendance',     '20000000-0000-0000-0000-0000000000a5', 'attendance.view', true, null, 0, false),
  ('c_leave',          '20000000-0000-0000-0000-0000000000a6', 'leave.view',      true, null, 0, false);

-- the custom roles: membership only, or one key (the escalation guard is for people granting keys, not for this fixture)
insert into public.roles (id, organization_id, key, name, description, is_system)
select role_id, '00000000-0000-4000-a000-000000000001', 'walk_' || role_key, 'Walk: ' || coalesce(perm || ' only', 'no permissions'), 'Role walk fixture', false
from walk_roles where role_id::text like '20000000-%'
on conflict (id) do nothing;
alter table public.role_permissions disable trigger role_permissions_no_escalation;
insert into public.role_permissions (role_id, permission_key) select role_id, perm from walk_roles where perm is not null on conflict do nothing;
alter table public.role_permissions enable trigger role_permissions_no_escalation;

do $$
declare r record; v_user uuid; v_member uuid; v_emp uuid; v_branch uuid; v_linked boolean; v_email text;
begin
  if exists (select 1 from public.user_profiles where email like 'walk.%@albahja.example') then
    raise notice 'the walk logins exist already';
    return;
  end if;
  for r in select * from walk_roles order by role_key loop
    foreach v_linked in array (case when r.unlinked then array[true, false] else array[true] end) loop
      v_email := 'walk.' || r.role_key || case when v_linked then '' else '.nolink' end || '@albahja.example';
      v_user := gen_random_uuid();
      insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
      values (v_user, v_email, extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('full_name', 'Walk ' || r.role_key));
      insert into public.user_profiles (id, email, full_name, locale) values (v_user, v_email, 'Walk ' || r.role_key || case when v_linked then '' else ' (no link)' end, 'en') on conflict (id) do nothing;
      v_branch := (select id from public.branches where organization_id = '00000000-0000-4000-a000-000000000001' and code = coalesce(r.branch_code, 'MCT-HQ'));
      v_emp := null;
      if v_linked then
        -- an active employee of the branch nobody logs in as and who manages nobody yet
        select e.id into v_emp from public.employees e
        where e.organization_id = '00000000-0000-4000-a000-000000000001' and e.deleted_at is null and e.employment_status = 'active' and e.branch_id = v_branch
          and not exists (select 1 from public.org_memberships m where m.employee_id = e.id)
          and not exists (select 1 from public.employees x where x.manager_employee_id = e.id or x.secondary_manager_employee_id = e.id)
        order by e.employee_number limit 1;
      end if;
      v_member := gen_random_uuid();
      insert into public.org_memberships (id, organization_id, user_id, role_id, status, all_branches, employee_id, joined_at)
      values (v_member, '00000000-0000-4000-a000-000000000001', v_user, r.role_id, 'active', r.all_branches, v_emp, now());
      if r.branch_code is not null then insert into public.membership_branches (membership_id, branch_id) values (v_member, v_branch); end if;
      if v_linked and r.reports > 0 then
        update public.employees set manager_employee_id = v_emp
        where id in (select e.id from public.employees e
                     where e.organization_id = '00000000-0000-4000-a000-000000000001' and e.deleted_at is null and e.employment_status = 'active'
                       and e.branch_id = v_branch and e.id <> v_emp
                       and not exists (select 1 from public.org_memberships m where m.employee_id = e.id)
                       and not exists (select 1 from public.employees x where x.manager_employee_id = e.id)
                       and not exists (select 1 from public.org_memberships m join public.user_profiles u on u.id = m.user_id
                                       where m.employee_id = e.manager_employee_id and u.email like 'walk.%')
                     order by e.employee_number desc limit r.reports);
      end if;
    end loop;
  end loop;
end $$;
commit;
