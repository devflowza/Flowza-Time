-- FlowZa Time · 20261007000100 · Enterprise: shift requests, round-the-clock scheduling and global attendance policies
-- (docs/enterprise/plan.md). Additive and idempotent; one transaction; ends with a post-verify block.
--
--  1. Three modules, included in the ENTERPRISE plan only (docs/pricing.md):
--       shift_requests       — shift change requests, additional (double) shift requests and shift swaps. Shift swaps existed
--                              before for every plan with the self-service portal: every organisation that has used them
--                              keeps them through a platform override (organization_modules, reason recorded) — nobody loses
--                              a feature they use.
--       advanced_scheduling  — round-the-clock (24/7) rotation templates, coverage targets, additional (double) shifts and
--                              temporary deployment of an employee to another branch.
--       attendance_policies  — attendance policies scoped by country → branch → department → employee group → shift, employee
--                              groups, country rule packs, the policy sections (very late, methods, overtime rates, points
--                              and disciplinary escalation).
--  2. Permission `shift.request_change` (self-service), granted with `shift.request_swap` to the same system roles.
--  3. `employee_groups` + effective-dated `employee_group_memberships` (one group per employee on a date — the policy
--     dimension HR calls "employee group" / "category": Office Staff, Sales Staff, Field Staff…).
--  4. `attendance_rule_sets` becomes the attendance POLICY: `description`, the scope dimensions `country_code`,
--     `department_id`, `employee_group_id`, `shift_id` (with `branch_id`, all optional: every dimension that is set must match;
--     the most specific matching policy wins — shift > employee group > department > branch > country > organisation;
--     packages/domain resolvePolicy) and `policy` (jsonb sections validated by @flowza/contracts attendancePolicySectionsSchema).
--     The no-overlap exclusion now runs per scope (two policies with the same scope cannot overlap in time).
--  5. `additional_shift_assignments` — an employee's ADDITIONAL shift on a date range (a double shift): the engine input combines
--     it with the day's resolved shift (packages/domain composeDoubleShift). A separate table, so every reader of
--     `shift_assignments` keeps its one-shift-per-day meaning.
--  6. `shift_change_requests` — CHANGE (work another shift) or ADDITIONAL (work a second shift) over a date range, routed
--     through the approval engine (entity SHIFT_CHANGE, which existed unused) and applied on approval as EMPLOYEE assignments /
--     additional shift assignments. System-written (the API's system step), like shift_swap_requests.
--  7. `employee_branch_deployments` — an employee temporarily works at another branch (from → to, inclusive): web check-in
--     accepts that branch's geofences and the employee is enrolled on that branch's terminals. Payroll, the attendance
--     calendar and the employee's branch stay the home branch (a permanent move is a transfer: employment_history).
--  8. `shift_coverage_requirements` — minimum headcount per (branch, shift, weekdays) for the round-the-clock roster.
set lock_timeout = '5s';
set statement_timeout = '120s';
set client_min_messages = warning;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Modules (Enterprise only) and the swap grandfathering
-- ---------------------------------------------------------------------------------------------------------------------------
insert into public.modules (key, name, description, category, sort_order) values
  ('shift_requests', 'Shift change & swap requests', 'Employees ask for another shift, an additional (double) shift or a swap with a colleague; managers decide through the approval workflow.', 'time', 90),
  ('advanced_scheduling', 'Round-the-clock scheduling', '24/7 multi-shift rotations from templates, coverage targets, double shifts and temporary deployment to another branch.', 'time', 100),
  ('attendance_policies', 'Global attendance policies', 'Attendance policies by country, branch, department, employee group and shift; country rule packs; attendance points and disciplinary escalation.', 'time', 110)
on conflict (key) do update set name = excluded.name, description = excluded.description, category = excluded.category, sort_order = excluded.sort_order
  where (public.modules.name, public.modules.description, public.modules.category, public.modules.sort_order)
        is distinct from (excluded.name, excluded.description, excluded.category, excluded.sort_order);

-- swaps leave the portal module's description (a description an administrator rewrote is left alone)
update public.modules set description = 'Employees sign in to see their attendance, requests, shift and profile.'
where key = 'self_service' and description = 'Employees sign in to see their attendance, requests, shift, shift swaps and profile.';

update public.plans set modules = modules || array['shift_requests', 'advanced_scheduling', 'attendance_policies']
where key = 'enterprise' and not (modules @> array['shift_requests', 'advanced_scheduling', 'attendance_policies']);

-- shift swaps were part of the self-service portal for every plan: an organisation that has used them keeps them (and the
-- shift change requests that come with the module) through an override a platform admin can see and remove
insert into public.organization_modules (organization_id, module_key, enabled, reason)
select o.id, 'shift_requests', true, 'Kept on: the organisation used shift swaps before they became an Enterprise feature (migration 20261007000100)'
from public.organizations o
where exists (select 1 from public.shift_swap_requests s where s.organization_id = o.id)
  and not exists (select 1 from public.subscriptions sub join public.plans p on p.id = sub.plan_id
                  where sub.organization_id = o.id and 'shift_requests' = any (p.modules))
on conflict (organization_id, module_key) do nothing;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Permission: shift change requests (self-service)
-- ---------------------------------------------------------------------------------------------------------------------------
insert into public.permissions (key, category, description, sort_order) values
  ('shift.request_change', 'shifts', 'Request a shift change or an additional shift (self-service)', 74)
on conflict (key) do update set category = excluded.category, description = excluded.description, sort_order = excluded.sort_order;
-- every role that may ask for a swap may ask for a change: the system roles (owner, org_admin, branch_manager, employee,
-- manager) AND the custom roles that hold shift.request_swap — otherwise a custom role that mirrors the employee role could no
-- longer grant it (an actor grants only what they hold) and its holders would lose the right to invite employees. The
-- escalation trigger judges a CLIENT's grant by the caller's permissions; a migration has no caller, so it is bypassed for
-- this one statement (the grant mirrors an existing one exactly).
alter table public.role_permissions disable trigger role_permissions_no_escalation;
insert into public.role_permissions (role_id, permission_key)
select rp.role_id, 'shift.request_change' from public.role_permissions rp
where rp.permission_key = 'shift.request_swap'
on conflict do nothing;
alter table public.role_permissions enable trigger role_permissions_no_escalation;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 3. Employee groups (policy dimension)
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.employee_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code extensions.citext not null check (code::text ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$'),
  name text not null check (length(btrim(name)) between 1 and 120),
  name_ar text check (name_ar is null or length(name_ar) <= 120),
  description text not null default '' check (length(description) <= 500),
  status public.record_status not null default 'active',
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_groups_organization_id_code_key unique (organization_id, code),
  constraint employee_groups_id_organization_id_key unique (id, organization_id)
);
comment on table public.employee_groups is 'Employee groups (categories) of an organisation — a dimension of the attendance policy scope (Enterprise, attendance_policies).';
drop trigger if exists employee_groups_updated_at on public.employee_groups;
create trigger employee_groups_updated_at before update on public.employee_groups for each row execute function app.set_updated_at();
call app.apply_tenant_policies('public.employee_groups', 'attendance.view', 'attendance.manage_rules');

create table if not exists public.employee_group_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_group_id uuid not null,
  employee_id uuid not null,
  effective_from date not null,
  -- exclusive, like every effective-dated table (the API speaks of the inclusive last day)
  effective_to date,
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint employee_group_memberships_group_fkey foreign key (employee_group_id, organization_id) references public.employee_groups(id, organization_id) on delete cascade,
  constraint employee_group_memberships_employee_fkey foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade,
  constraint employee_group_memberships_range check (effective_to is null or effective_to > effective_from),
  constraint employee_group_memberships_no_overlap exclude using gist (organization_id with =, employee_id with =, daterange(effective_from, effective_to, '[)') with &&)
);
comment on table public.employee_group_memberships is 'Which group an employee belongs to, effective-dated (at most one group per employee on a date).';
create index if not exists employee_group_memberships_group_idx on public.employee_group_memberships (organization_id, employee_group_id, effective_from desc);
create index if not exists employee_group_memberships_employee_idx on public.employee_group_memberships (organization_id, employee_id, effective_from desc);
call app.apply_tenant_policies('public.employee_group_memberships', 'attendance.view', 'attendance.manage_rules');

-- ---------------------------------------------------------------------------------------------------------------------------
-- 4. Attendance rule sets become scoped attendance policies
-- ---------------------------------------------------------------------------------------------------------------------------
alter table public.attendance_rule_sets add column if not exists description text not null default '';
alter table public.attendance_rule_sets add column if not exists country_code char(2);
alter table public.attendance_rule_sets add column if not exists department_id uuid;
alter table public.attendance_rule_sets add column if not exists employee_group_id uuid;
alter table public.attendance_rule_sets add column if not exists shift_id uuid;
alter table public.attendance_rule_sets add column if not exists policy jsonb not null default '{}'::jsonb;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.attendance_rule_sets'::regclass and conname = 'attendance_rule_sets_description_check') then
    alter table public.attendance_rule_sets add constraint attendance_rule_sets_description_check check (length(description) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.attendance_rule_sets'::regclass and conname = 'attendance_rule_sets_country_code_check') then
    alter table public.attendance_rule_sets add constraint attendance_rule_sets_country_code_check check (country_code is null or country_code ~ '^[A-Z]{2}$');
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.attendance_rule_sets'::regclass and conname = 'attendance_rule_sets_policy_check') then
    alter table public.attendance_rule_sets add constraint attendance_rule_sets_policy_check check (jsonb_typeof(policy) = 'object');
  end if;
  -- a department that goes takes its policies with it, like a branch; a group or a shift in use cannot be deleted
  if not exists (select 1 from pg_constraint where conrelid = 'public.attendance_rule_sets'::regclass and conname = 'attendance_rule_sets_department_fkey') then
    alter table public.attendance_rule_sets add constraint attendance_rule_sets_department_fkey foreign key (department_id, organization_id) references public.departments(id, organization_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.attendance_rule_sets'::regclass and conname = 'attendance_rule_sets_employee_group_fkey') then
    alter table public.attendance_rule_sets add constraint attendance_rule_sets_employee_group_fkey foreign key (employee_group_id, organization_id) references public.employee_groups(id, organization_id);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.attendance_rule_sets'::regclass and conname = 'attendance_rule_sets_shift_fkey') then
    alter table public.attendance_rule_sets add constraint attendance_rule_sets_shift_fkey foreign key (shift_id, organization_id) references public.shifts(id, organization_id);
  end if;
end $$;
comment on column public.attendance_rule_sets.country_code is 'Policy scope: employees whose branch (on the date) is in this country. Null = any.';
comment on column public.attendance_rule_sets.department_id is 'Policy scope: employees of this department (on the date). Null = any.';
comment on column public.attendance_rule_sets.employee_group_id is 'Policy scope: members of this employee group (on the date). Null = any.';
comment on column public.attendance_rule_sets.shift_id is 'Policy scope: days worked on this shift. Null = any.';
comment on column public.attendance_rule_sets.policy is 'Policy sections (very late, check-in methods, overtime rates and weekly threshold, attendance points, escalation, regularisation limits, country pack provenance) — @flowza/contracts attendancePolicySectionsSchema.';

-- the no-overlap rule per scope: two policies of the SAME scope cannot be effective on the same day
alter table public.attendance_rule_sets drop constraint if exists attendance_rule_sets_no_overlap;
alter table public.attendance_rule_sets add constraint attendance_rule_sets_no_overlap exclude using gist (
  organization_id with =,
  (coalesce(country_code::text, '')) with =,
  (coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)) with =,
  (coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid)) with =,
  (coalesce(employee_group_id, '00000000-0000-0000-0000-000000000000'::uuid)) with =,
  (coalesce(shift_id, '00000000-0000-0000-0000-000000000000'::uuid)) with =,
  daterange(effective_from, effective_to, '[)') with &&
);
create index if not exists attendance_rule_sets_org_effective_idx on public.attendance_rule_sets (organization_id, effective_from desc);
create index if not exists attendance_rule_sets_employee_group_idx on public.attendance_rule_sets (organization_id, employee_group_id) where employee_group_id is not null;
create index if not exists attendance_rule_sets_shift_idx on public.attendance_rule_sets (organization_id, shift_id) where shift_id is not null;
create index if not exists attendance_rule_sets_department_idx on public.attendance_rule_sets (organization_id, department_id) where department_id is not null;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 5. Additional (double) shift assignments
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.additional_shift_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null,
  branch_id uuid,
  shift_id uuid not null,
  effective_from date not null,
  -- exclusive (the API speaks of the inclusive last day, like shift assignments)
  effective_to date,
  shift_change_request_id uuid,
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint additional_shift_assignments_employee_fkey foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade,
  constraint additional_shift_assignments_branch_fkey foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete set null (branch_id),
  constraint additional_shift_assignments_shift_fkey foreign key (shift_id, organization_id) references public.shifts(id, organization_id),
  constraint additional_shift_assignments_range check (effective_to is null or effective_to > effective_from),
  constraint additional_shift_assignments_no_overlap exclude using gist (organization_id with =, employee_id with =, daterange(effective_from, effective_to, '[)') with &&)
);
comment on table public.additional_shift_assignments is 'A second shift an employee works on the same attendance date (double shift); combined with the resolved shift by the engine input (Enterprise, advanced_scheduling / shift_requests).';
create index if not exists additional_shift_assignments_employee_idx on public.additional_shift_assignments (organization_id, employee_id, effective_from desc);
create index if not exists additional_shift_assignments_shift_idx on public.additional_shift_assignments (organization_id, shift_id);
create index if not exists additional_shift_assignments_branch_idx on public.additional_shift_assignments (organization_id, branch_id);
call app.apply_tenant_policies('public.additional_shift_assignments', 'shift.view', 'shift.assign', 'branch_id');

-- ---------------------------------------------------------------------------------------------------------------------------
-- 6. Shift change requests (CHANGE / ADDITIONAL), approval entity SHIFT_CHANGE
-- ---------------------------------------------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'shift_change_kind' and typnamespace = 'public'::regnamespace) then
    create type public.shift_change_kind as enum ('CHANGE', 'ADDITIONAL');
  end if;
  if not exists (select 1 from pg_type where typname = 'shift_change_status' and typnamespace = 'public'::regnamespace) then
    create type public.shift_change_status as enum ('pending', 'approved', 'rejected', 'cancelled');
  end if;
end $$;

create table if not exists public.shift_change_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null,
  branch_id uuid,
  kind public.shift_change_kind not null default 'CHANGE',
  -- inclusive range
  from_date date not null,
  to_date date not null,
  requested_shift_id uuid not null,
  -- the shift the employee worked on from_date when the request was filed (informational)
  current_shift_id uuid,
  reason text not null check (length(btrim(reason)) between 3 and 1000),
  status public.shift_change_status not null default 'pending',
  approval_request_id uuid references public.approval_requests(id) on delete set null,
  -- the shift_assignments / additional_shift_assignments rows written on approval
  applied_assignment_ids uuid[] not null default '{}',
  decided_by uuid references public.user_profiles(id) on delete set null,
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 1000),
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shift_change_requests_employee_fkey foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade,
  constraint shift_change_requests_branch_fkey foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete set null (branch_id),
  constraint shift_change_requests_requested_shift_fkey foreign key (requested_shift_id, organization_id) references public.shifts(id, organization_id),
  constraint shift_change_requests_current_shift_fkey foreign key (current_shift_id, organization_id) references public.shifts(id, organization_id) on delete set null (current_shift_id),
  constraint shift_change_requests_range check (to_date >= from_date and to_date - from_date <= 365),
  -- one waiting request of a kind per employee and day (the service refuses first; this is the backstop)
  constraint shift_change_requests_one_pending exclude using gist (organization_id with =, employee_id with =, kind with =, daterange(from_date, to_date, '[]') with &&) where (status = 'pending')
);
create index if not exists shift_change_requests_employee_idx on public.shift_change_requests (organization_id, employee_id, from_date desc);
create index if not exists shift_change_requests_pending_idx on public.shift_change_requests (organization_id, from_date) where status = 'pending';
create index if not exists shift_change_requests_approval_idx on public.shift_change_requests (approval_request_id) where approval_request_id is not null;
create index if not exists shift_change_requests_requested_shift_idx on public.shift_change_requests (organization_id, requested_shift_id);
create index if not exists shift_change_requests_current_shift_idx on public.shift_change_requests (organization_id, current_shift_id) where current_shift_id is not null;
create index if not exists shift_change_requests_branch_idx on public.shift_change_requests (organization_id, branch_id);
drop trigger if exists shift_change_requests_updated_at on public.shift_change_requests;
create trigger shift_change_requests_updated_at before update on public.shift_change_requests for each row execute function app.set_updated_at();
-- read like swaps: attendance.view (branch scope), own rows, a line manager's team; written by the API's system step only
call app.apply_readonly_tenant_policies('public.shift_change_requests', 'attendance.view', 'branch_id', 'employee_id', 'employee_id', array['attendance.view_team']);

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.additional_shift_assignments'::regclass and conname = 'additional_shift_assignments_request_fkey') then
    alter table public.additional_shift_assignments add constraint additional_shift_assignments_request_fkey foreign key (shift_change_request_id) references public.shift_change_requests(id) on delete set null;
  end if;
end $$;
create index if not exists additional_shift_assignments_request_idx on public.additional_shift_assignments (shift_change_request_id) where shift_change_request_id is not null;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 7. Temporary deployment to another branch
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.employee_branch_deployments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null,
  -- the branch the employee belonged to when deployed (snapshot) and the branch they work at
  home_branch_id uuid,
  branch_id uuid not null,
  -- inclusive range
  from_date date not null,
  to_date date not null,
  reason text not null check (length(btrim(reason)) between 3 and 1000),
  -- enrol the employee on the branch's terminals (async job; null when nothing was enqueued)
  enrol_on_devices boolean not null default true,
  enrol_job_id uuid,
  cleanup_job_id uuid,
  cleaned_up_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid references public.user_profiles(id) on delete set null,
  cancel_reason text check (cancel_reason is null or length(btrim(cancel_reason)) between 3 and 1000),
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_branch_deployments_employee_fkey foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade,
  constraint employee_branch_deployments_branch_fkey foreign key (branch_id, organization_id) references public.branches(id, organization_id),
  constraint employee_branch_deployments_home_branch_fkey foreign key (home_branch_id, organization_id) references public.branches(id, organization_id) on delete set null (home_branch_id),
  constraint employee_branch_deployments_range check (to_date >= from_date and to_date - from_date <= 366),
  constraint employee_branch_deployments_other_branch check (home_branch_id is null or home_branch_id <> branch_id),
  constraint employee_branch_deployments_cancel_shape check (case when cancelled_at is null then cancelled_by is null and cancel_reason is null else cancel_reason is not null end),
  constraint employee_branch_deployments_no_overlap exclude using gist (organization_id with =, employee_id with =, daterange(from_date, to_date, '[]') with &&) where (cancelled_at is null)
);
comment on table public.employee_branch_deployments is 'An employee temporarily works at another branch (Enterprise, advanced_scheduling): web check-in accepts that branch''s geofences and the employee is enrolled on its terminals. The attendance calendar and payroll stay the home branch.';
create index if not exists employee_branch_deployments_employee_idx on public.employee_branch_deployments (organization_id, employee_id, from_date desc);
create index if not exists employee_branch_deployments_branch_idx on public.employee_branch_deployments (organization_id, branch_id, from_date desc);
create index if not exists employee_branch_deployments_home_idx on public.employee_branch_deployments (organization_id, home_branch_id);
create index if not exists employee_branch_deployments_cleanup_idx on public.employee_branch_deployments (to_date) where cancelled_at is null and cleaned_up_at is null;
drop trigger if exists employee_branch_deployments_updated_at on public.employee_branch_deployments;
create trigger employee_branch_deployments_updated_at before update on public.employee_branch_deployments for each row execute function app.set_updated_at();
-- readable with employee.view in the HOST branch scope (the generator's branch column), by the employee themselves, and (below)
-- in the HOME branch scope; written only by the API's system step after employee.update on both branches
call app.apply_readonly_tenant_policies('public.employee_branch_deployments', 'employee.view', 'branch_id', 'employee_id');
drop policy if exists employee_branch_deployments_home_select on public.employee_branch_deployments;
create policy employee_branch_deployments_home_select on public.employee_branch_deployments for select to authenticated, flowza_system using (
  organization_id = any ((select app.org_ids_with_permission('employee.view'))::uuid[])
  and home_branch_id is not null and home_branch_id = any ((select app.allowed_branch_ids())::uuid[])
);

-- ---------------------------------------------------------------------------------------------------------------------------
-- 8. Coverage targets for round-the-clock rosters
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.shift_coverage_requirements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  shift_id uuid not null,
  weekdays smallint[] not null default '{0,1,2,3,4,5,6}',
  min_headcount int not null check (min_headcount between 1 and 10000),
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shift_coverage_requirements_branch_fkey foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete cascade,
  constraint shift_coverage_requirements_shift_fkey foreign key (shift_id, organization_id) references public.shifts(id, organization_id) on delete cascade,
  constraint shift_coverage_requirements_weekdays check (cardinality(weekdays) between 1 and 7 and weekdays <@ '{0,1,2,3,4,5,6}'::smallint[]),
  constraint shift_coverage_requirements_unique unique (organization_id, branch_id, shift_id)
);
comment on table public.shift_coverage_requirements is 'Minimum headcount per branch and shift on the given weekdays (0 = Sunday); the round-the-clock roster shows the gaps.';
create index if not exists shift_coverage_requirements_shift_idx on public.shift_coverage_requirements (organization_id, shift_id);
drop trigger if exists shift_coverage_requirements_updated_at on public.shift_coverage_requirements;
create trigger shift_coverage_requirements_updated_at before update on public.shift_coverage_requirements for each row execute function app.set_updated_at();
call app.apply_tenant_policies('public.shift_coverage_requirements', 'shift.view', 'shift.manage', 'branch_id');

-- covering indexes for the user-profile foreign keys (invariant I3)
create index if not exists employee_groups_created_by_fk_idx on public.employee_groups (created_by) where created_by is not null;
create index if not exists employee_group_memberships_created_by_fk_idx on public.employee_group_memberships (created_by) where created_by is not null;
create index if not exists additional_shift_assignments_created_by_fk_idx on public.additional_shift_assignments (created_by) where created_by is not null;
create index if not exists shift_change_requests_created_by_fk_idx on public.shift_change_requests (created_by) where created_by is not null;
create index if not exists shift_change_requests_decided_by_fk_idx on public.shift_change_requests (decided_by) where decided_by is not null;
create index if not exists employee_branch_deployments_created_by_fk_idx on public.employee_branch_deployments (created_by) where created_by is not null;
create index if not exists employee_branch_deployments_cancelled_by_fk_idx on public.employee_branch_deployments (cancelled_by) where cancelled_by is not null;
create index if not exists shift_coverage_requirements_created_by_fk_idx on public.shift_coverage_requirements (created_by) where created_by is not null;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 9. Post-verify
-- ---------------------------------------------------------------------------------------------------------------------------
do $$
declare v_table text;
begin
  if (select count(*) from public.modules where key in ('shift_requests', 'advanced_scheduling', 'attendance_policies')) <> 3 then
    raise exception 'enterprise modules: catalogue rows missing';
  end if;
  if not exists (select 1 from public.plans where key = 'enterprise' and modules @> array['shift_requests', 'advanced_scheduling', 'attendance_policies']) then
    raise exception 'enterprise modules: the enterprise plan does not include them';
  end if;
  if exists (select 1 from public.plans where key in ('trial', 'starter', 'professional', 'business')
             and modules && array['shift_requests', 'advanced_scheduling', 'attendance_policies']) then
    raise exception 'enterprise modules: a non-enterprise plan includes an enterprise module';
  end if;
  -- every organisation that used swaps still has them
  if exists (select 1 from (select distinct organization_id from public.shift_swap_requests) s
             join lateral app._org_module_states(array[s.organization_id]) st on st.module_key = 'shift_requests'
             where not st.enabled and not st.lapsed and st.available) then
    raise exception 'shift swaps: an organisation that used them lost them';
  end if;
  if not exists (select 1 from public.permissions where key = 'shift.request_change') then
    raise exception 'permission shift.request_change missing';
  end if;
  foreach v_table in array array['employee_groups', 'employee_group_memberships', 'additional_shift_assignments', 'shift_change_requests', 'employee_branch_deployments', 'shift_coverage_requirements'] loop
    if not exists (select 1 from pg_class where oid = ('public.' || v_table)::regclass and relrowsecurity) then
      raise exception '% has no RLS', v_table;
    end if;
  end loop;
  foreach v_table in array array['shift_change_requests', 'employee_branch_deployments'] loop
    if has_table_privilege('authenticated', 'public.' || v_table, 'insert') or has_table_privilege('authenticated', 'public.' || v_table, 'update')
       or has_table_privilege('authenticated', 'public.' || v_table, 'delete') then
      raise exception '% must be written by the system context only', v_table;
    end if;
  end loop;
end $$;
