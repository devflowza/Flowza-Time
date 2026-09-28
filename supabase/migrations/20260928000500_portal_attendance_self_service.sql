-- Employee portal attendance self-service — HR portal Prompt 4.
--
-- 1. `raw_source` gains SELF_SERVICE: web / mobile check-ins and approved selfie check-ins are raw transactions of a per-
--    organisation VIRTUAL device (provider `self_service`, created lazily by the API — `ensureSelfServiceDevice`), so the
--    raw ledger, the dedupe hash, the normaliser and the engine stay the one pipeline every punch goes through (pack §6.1).
--    The new enum value is NOT used anywhere in this file (hosted apply wraps a file in one transaction and PostgreSQL
--    refuses a value added in the same transaction); the application writes it at runtime.
-- 2. Reference rows for the virtual provider (`device_providers` / `device_models`). The provider has no implementation in
--    packages/device-providers on purpose: nothing is ever sent to it. Its device rows are created `disabled` with auto sync
--    off, so the scheduler (polls, health checks, reconciliation, employee pushes, metering all filter on `status = 'active'`)
--    never touches them, and the API hides them from device lists, counts, plan seats and every device mutation.
-- 3. New enums (mirrored in packages/contracts/src/enums.ts).
-- 4. Tables:
--      attendance_notes                     per-day reasons (one active per employee-day), reviewed through the approval
--                                           engine (entity ATTENDANCE_NOTE); pay effect charged via attendance_day_marks
--      attendance_regularisation_requests   missed / wrong punch, WFH unmarked, system downtime (entity REGULARISATION);
--                                           applied through attendance_corrections (raw immutability holds)
--      employee_attendance_grants           per-employee open (selfie) attendance / selfie-required switches
--      selfie_checkins                      pending selfie punches (photo in the private employee-photos bucket under
--                                           checkins/<org>/<employee>/…; the first path segment is not an organisation id,
--                                           so no tenant storage policy matches it, and a restrictive storage policy (4g)
--                                           denies every client role the prefix outright — only the API's service client
--                                           uploads, and viewers get a 60-second signed URL from the API)
--      geofences / geofence_assignments     circle (mandatory) + optional polygon fences, assigned by scope
--      shift_swap_requests                  shift swaps (entity SHIFT_SWAP); applied as one-day EMPLOYEE shift assignments
--    RLS through the tenant policy generators. The self-service tables (notes, regularisations, grants, selfies, swaps) are
--    read by: the organisation-wide key (attendance.view, branch-scoped where the table has a branch), the employee's own
--    rows, and line managers holding the team key for direct reports; they are WRITTEN ONLY by the system context (the API after its own
--    checks): client INSERT/UPDATE/DELETE privileges are revoked and explicit restrictive deny policies stand in case a later
--    migration re-grants them. Geofences are configuration written by `attendance.manage_geofences` holders (RLS twice).
-- 5. `attendance_corrections.device_id`: a correction that stands for a punch captured on a device — the self-service
--    device for regularisations — records which one; the worker copies it onto the CORRECTION event it inserts.
--
-- Additive, idempotent, single-transaction safe (no CONCURRENTLY, the new enum value is never used here).
set lock_timeout = '5s';
set statement_timeout = '120s';
set client_min_messages = warning;

-- 1. raw source ----------------------------------------------------------------------------------------------------------------
alter type public.raw_source add value if not exists 'SELF_SERVICE';

-- 2. virtual provider + model ---------------------------------------------------------------------------------------------------
insert into public.device_providers (key, vendor, name, description, integration_type, status, capabilities, config_schema, throttling, verification_status, docs_url, sort_order) values
  ('self_service', 'FlowZa', 'FlowZa Self-Service',
   'Virtual device of the employee portal: web / mobile check-ins and approved selfie check-ins are recorded as its raw transactions. Created automatically; never contacted, never listed with the terminals.',
   'DEVICE_PUSH', 'available',
   '{"attendancePull":false,"attendancePush":false,"employeePush":false,"employeePull":false,"employeeDelete":false,"fingerprint":false,"face":false,"card":false,"pin":false,"deviceStatus":false,"remoteRestart":false,"webhooks":false,"devicePush":false,"biometricTemplatePush":false}',
   '{"fields":[]}', '{}', 'VERIFIED', null, 900)
on conflict (key) do update set vendor = excluded.vendor, name = excluded.name, description = excluded.description, integration_type = excluded.integration_type,
  status = excluded.status, capabilities = excluded.capabilities, config_schema = excluded.config_schema, throttling = excluded.throttling,
  verification_status = excluded.verification_status, docs_url = excluded.docs_url, sort_order = excluded.sort_order, updated_at = now();

insert into public.device_models (provider_key, vendor, model, family, capabilities, verification, notes) values
  ('self_service', 'FlowZa', 'FlowZa Self-Service', 'Virtual', '{}', 'VERIFIED',
   'One per organisation, created on the first self-service punch. Not a terminal: excluded from device lists, sync, health checks, reconciliation and plan seats.')
on conflict (provider_key, model) do update set capabilities = excluded.capabilities, verification = excluded.verification, notes = excluded.notes;

-- 3. enums ------------------------------------------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'attendance_note_category') then
    create type public.attendance_note_category as enum ('client_visit', 'field_work', 'late_reason', 'absence_reason', 'wfh', 'other');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'attendance_note_status') then
    create type public.attendance_note_status as enum ('pending', 'approved', 'rejected', 'excused', 'info_requested');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'regularisation_type') then
    create type public.regularisation_type as enum ('missed_punch', 'wrong_punch', 'wfh_unmarked', 'system_downtime');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'regularisation_status') then
    create type public.regularisation_status as enum ('pending', 'approved', 'rejected', 'cancelled');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'selfie_checkin_status') then
    create type public.selfie_checkin_status as enum ('pending', 'approved', 'rejected');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'geofence_enforcement') then
    create type public.geofence_enforcement as enum ('hard_block', 'soft_warn', 'advisory_log');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'geofence_scope') then
    create type public.geofence_scope as enum ('org', 'branch', 'department', 'team', 'employee');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'shift_swap_status') then
    create type public.shift_swap_status as enum ('pending', 'approved', 'rejected', 'cancelled');
  end if;
end $$;

-- Explicit denial of client writes on the RPC-only tables: no privileges and a restrictive policy that refuses every row, so
-- a later `grant` alone can never open them (the API writes in the organisation's system context after its own checks).
create or replace procedure app.deny_client_writes(p_table regclass)
language plpgsql
as $$
declare
  v_name text := p_table::text;
  v_short text := replace(replace(v_name, 'public.', ''), '.', '_');
begin
  execute format('revoke insert, update, delete on %s from authenticated', v_name);
  execute format('drop policy if exists %I on %s', v_short || '_deny_client_insert', v_name);
  execute format('drop policy if exists %I on %s', v_short || '_deny_client_update', v_name);
  execute format('drop policy if exists %I on %s', v_short || '_deny_client_delete', v_name);
  execute format('create policy %I on %s as restrictive for insert to authenticated with check (false)', v_short || '_deny_client_insert', v_name);
  execute format('create policy %I on %s as restrictive for update to authenticated using (false) with check (false)', v_short || '_deny_client_update', v_name);
  execute format('create policy %I on %s as restrictive for delete to authenticated using (false)', v_short || '_deny_client_delete', v_name);
end $$;

-- 4a. attendance notes ------------------------------------------------------------------------------------------------------------
create table if not exists public.attendance_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null,
  branch_id uuid, -- the employee's branch on the date (RLS branch scope)
  attendance_date date not null,
  category public.attendance_note_category not null default 'other',
  note text not null check (length(btrim(note)) between 1 and 2000),
  status public.attendance_note_status not null default 'pending',
  submitted_by uuid references public.user_profiles(id) on delete set null,
  submitted_at timestamptz not null default now(),
  reviewed_by uuid references public.user_profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_reason text check (review_reason is null or length(review_reason) <= 1000),
  -- how the reviewer was entitled: the employee's line manager, or organisation-wide oversight (HR)
  review_via text check (review_via is null or review_via in ('manager', 'oversight')),
  info_request_message text check (info_request_message is null or length(info_request_message) <= 1000),
  info_requested_at timestamptz,
  info_requested_by uuid references public.user_profiles(id) on delete set null,
  pay_effect_days numeric(3,1) check (pay_effect_days is null or pay_effect_days in (0, 0.5, 1.0)),
  loss_of_pay boolean not null default false,
  deducted_leave_record_id uuid references public.leave_records(id) on delete set null,
  day_mark_id uuid references public.attendance_day_marks(id) on delete set null,
  approval_request_id uuid references public.approval_requests(id) on delete set null,
  excused_at timestamptz,
  excused_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_notes_employee_fkey foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade,
  constraint attendance_notes_branch_fkey foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete set null (branch_id)
);
-- one ACTIVE note per employee-day; a rejected note stays as history and a new one may be filed for the day
create unique index if not exists attendance_notes_active_idx on public.attendance_notes (organization_id, employee_id, attendance_date) where status <> 'rejected';
create index if not exists attendance_notes_employee_date_idx on public.attendance_notes (organization_id, employee_id, attendance_date desc);
create index if not exists attendance_notes_queue_idx on public.attendance_notes (organization_id, status, attendance_date) where status in ('pending', 'info_requested');
create index if not exists attendance_notes_request_idx on public.attendance_notes (approval_request_id) where approval_request_id is not null;
drop trigger if exists attendance_notes_updated_at on public.attendance_notes;
create trigger attendance_notes_updated_at before update on public.attendance_notes for each row execute function app.set_updated_at();
call app.apply_readonly_tenant_policies('public.attendance_notes', 'attendance.view', 'branch_id', 'employee_id', 'employee_id', array['attendance.view_team']);
call app.deny_client_writes('public.attendance_notes');

-- 4b. regularisation requests -----------------------------------------------------------------------------------------------------
create table if not exists public.attendance_regularisation_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null,
  branch_id uuid,
  attendance_date date not null,
  type public.regularisation_type not null,
  proposed_in_at timestamptz,
  proposed_out_at timestamptz,
  reason text not null check (length(btrim(reason)) between 3 and 1000),
  status public.regularisation_status not null default 'pending',
  approval_request_id uuid references public.approval_requests(id) on delete set null,
  applied_correction_id uuid references public.attendance_corrections(id) on delete set null,
  applied_at timestamptz,
  decided_by uuid references public.user_profiles(id) on delete set null,
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 1000),
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_regularisation_requests_employee_fkey foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade,
  constraint attendance_regularisation_requests_branch_fkey foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete set null (branch_id),
  constraint attendance_regularisation_requests_times check (proposed_in_at is null or proposed_out_at is null or proposed_out_at > proposed_in_at),
  constraint attendance_regularisation_requests_punch_types check (type not in ('missed_punch', 'wrong_punch') or proposed_in_at is not null or proposed_out_at is not null)
);
create index if not exists attendance_regularisations_employee_idx on public.attendance_regularisation_requests (organization_id, employee_id, attendance_date desc);
create index if not exists attendance_regularisations_pending_idx on public.attendance_regularisation_requests (organization_id, attendance_date) where status = 'pending';
drop trigger if exists attendance_regularisation_requests_updated_at on public.attendance_regularisation_requests;
create trigger attendance_regularisation_requests_updated_at before update on public.attendance_regularisation_requests for each row execute function app.set_updated_at();
call app.apply_readonly_tenant_policies('public.attendance_regularisation_requests', 'attendance.view', 'branch_id', 'employee_id', 'employee_id', array['attendance.view_team']);
call app.deny_client_writes('public.attendance_regularisation_requests');

-- 4c. attendance grants (open / selfie attendance) --------------------------------------------------------------------------------
create table if not exists public.employee_attendance_grants (
  employee_id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  open_attendance boolean not null default false,
  selfie_required boolean not null default false,
  granted_by uuid references public.user_profiles(id) on delete set null,
  granted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_attendance_grants_employee_fkey foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade
);
create index if not exists employee_attendance_grants_org_idx on public.employee_attendance_grants (organization_id) where open_attendance or selfie_required;
drop trigger if exists employee_attendance_grants_updated_at on public.employee_attendance_grants;
create trigger employee_attendance_grants_updated_at before update on public.employee_attendance_grants for each row execute function app.set_updated_at();
call app.apply_readonly_tenant_policies('public.employee_attendance_grants', 'attendance.view', null, 'employee_id', 'employee_id', array['attendance.view_team']);
call app.deny_client_writes('public.employee_attendance_grants');

-- 4d. selfie check-ins -------------------------------------------------------------------------------------------------------------
create table if not exists public.selfie_checkins (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null,
  branch_id uuid,
  punched_at timestamptz not null default now(), -- server time of the submission (the punch time once approved)
  direction text not null check (direction in ('in', 'out')),
  photo_path text not null check (photo_path like 'checkins/%' and length(photo_path) <= 300),
  photo_sha256 text check (photo_sha256 is null or photo_sha256 ~ '^[0-9a-f]{64}$'),
  latitude double precision check (latitude is null or latitude between -90 and 90),
  longitude double precision check (longitude is null or longitude between -180 and 180),
  accuracy_m double precision check (accuracy_m is null or accuracy_m >= 0),
  verdict text check (verdict is null or verdict in ('no_fence', 'allowed', 'flagged', 'logged', 'denied_outside', 'denied_mock')),
  status public.selfie_checkin_status not null default 'pending',
  reviewed_by uuid references public.user_profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_reason text check (review_reason is null or length(review_reason) <= 1000),
  raw_transaction_id bigint, -- the raw punch written on approval (partitioned table: no FK)
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint selfie_checkins_employee_fkey foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade,
  constraint selfie_checkins_branch_fkey foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete set null (branch_id),
  constraint selfie_checkins_location_pair check ((latitude is null) = (longitude is null)),
  constraint selfie_checkins_review_shape check (status = 'pending' or reviewed_at is not null)
);
create index if not exists selfie_checkins_employee_idx on public.selfie_checkins (organization_id, employee_id, punched_at desc);
create index if not exists selfie_checkins_pending_idx on public.selfie_checkins (organization_id, punched_at) where status = 'pending';
drop trigger if exists selfie_checkins_updated_at on public.selfie_checkins;
create trigger selfie_checkins_updated_at before update on public.selfie_checkins for each row execute function app.set_updated_at();
call app.apply_readonly_tenant_policies('public.selfie_checkins', 'attendance.view', 'branch_id', 'employee_id', 'employee_id', array['attendance.view_team']);
call app.deny_client_writes('public.selfie_checkins');

-- 4e. geofences ---------------------------------------------------------------------------------------------------------------------
create table if not exists public.geofences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid, -- the site the fence belongs to (null = organisation-wide); who it applies to is decided by the assignments
  name text not null check (length(btrim(name)) between 1 and 120),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  radius_m int not null check (radius_m between 30 and 5000),
  -- optional polygon ([[lat, lng], …], 3–100 points); when present it is the shape, the circle stays the preview / nearest-zone anchor
  polygon jsonb check (polygon is null or (jsonb_typeof(polygon) = 'array' and jsonb_array_length(polygon) between 3 and 100)),
  enforcement public.geofence_enforcement not null default 'soft_warn',
  accuracy_threshold_m int not null default 100 check (accuracy_threshold_m between 5 and 5000),
  grace_m int not null default 0 check (grace_m between 0 and 1000),
  active_from date,
  active_to date,
  -- weekly windows in the branch's local time: [{"days":[1..7 ISO],"start":"HH:mm","end":"HH:mm"}]; empty / null = always
  time_windows jsonb check (time_windows is null or (jsonb_typeof(time_windows) = 'array' and jsonb_array_length(time_windows) <= 14)),
  is_active boolean not null default true,
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  constraint geofences_branch_fkey foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete set null (branch_id),
  constraint geofences_active_range check (active_to is null or active_from is null or active_to >= active_from)
);
create index if not exists geofences_org_idx on public.geofences (organization_id, is_active, branch_id);
drop trigger if exists geofences_updated_at on public.geofences;
create trigger geofences_updated_at before update on public.geofences for each row execute function app.set_updated_at();
call app.apply_tenant_policies('public.geofences', 'attendance.view', 'attendance.manage_geofences', 'branch_id');

create table if not exists public.geofence_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  geofence_id uuid not null,
  scope public.geofence_scope not null,
  target_id uuid, -- null for scope org; the branch / department / team / employee otherwise
  priority int not null default 100 check (priority between 0 and 1000),
  require_on_check_in boolean not null default true,
  require_on_check_out boolean not null default true,
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint geofence_assignments_fence_fkey foreign key (geofence_id, organization_id) references public.geofences(id, organization_id) on delete cascade,
  constraint geofence_assignments_target check ((scope = 'org') = (target_id is null)),
  constraint geofence_assignments_direction check (require_on_check_in or require_on_check_out)
);
create unique index if not exists geofence_assignments_unique_idx on public.geofence_assignments (geofence_id, scope, coalesce(target_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists geofence_assignments_target_idx on public.geofence_assignments (organization_id, scope, target_id);
call app.apply_tenant_policies('public.geofence_assignments', 'attendance.view', 'attendance.manage_geofences');

-- 4f. shift swaps ---------------------------------------------------------------------------------------------------------------------
create table if not exists public.shift_swap_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  requester_employee_id uuid not null,
  target_employee_id uuid not null,
  branch_id uuid,
  swap_date date not null,
  requester_shift_id uuid not null,
  target_shift_id uuid not null,
  reason text not null check (length(btrim(reason)) between 3 and 1000),
  status public.shift_swap_status not null default 'pending',
  approval_request_id uuid references public.approval_requests(id) on delete set null,
  requester_assignment_id uuid references public.shift_assignments(id) on delete set null,
  target_assignment_id uuid references public.shift_assignments(id) on delete set null,
  decided_by uuid references public.user_profiles(id) on delete set null,
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 1000),
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shift_swap_requests_requester_fkey foreign key (requester_employee_id, organization_id) references public.employees(id, organization_id) on delete cascade,
  constraint shift_swap_requests_target_fkey foreign key (target_employee_id, organization_id) references public.employees(id, organization_id) on delete cascade,
  constraint shift_swap_requests_branch_fkey foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete set null (branch_id),
  constraint shift_swap_requests_requester_shift_fkey foreign key (requester_shift_id, organization_id) references public.shifts(id, organization_id),
  constraint shift_swap_requests_target_shift_fkey foreign key (target_shift_id, organization_id) references public.shifts(id, organization_id),
  constraint shift_swap_requests_two_people check (requester_employee_id <> target_employee_id),
  constraint shift_swap_requests_two_shifts check (requester_shift_id <> target_shift_id)
);
create index if not exists shift_swap_requests_requester_idx on public.shift_swap_requests (organization_id, requester_employee_id, swap_date desc);
create index if not exists shift_swap_requests_target_idx on public.shift_swap_requests (organization_id, target_employee_id, swap_date desc);
create index if not exists shift_swap_requests_pending_idx on public.shift_swap_requests (organization_id, swap_date) where status = 'pending';
drop trigger if exists shift_swap_requests_updated_at on public.shift_swap_requests;
create trigger shift_swap_requests_updated_at before update on public.shift_swap_requests for each row execute function app.set_updated_at();
-- keyed on attendance.view, not shift.view: the manager role holds shift.view organisation-wide (to read the rota), and a
-- swap carries the employee's own reason, so a line manager reads only the swaps of their team (either party)
call app.apply_readonly_tenant_policies('public.shift_swap_requests', 'attendance.view', 'branch_id', 'requester_employee_id', 'requester_employee_id', array['attendance.view_team']);
-- the colleague a swap names reads it too (the generator has one self column)
drop policy if exists shift_swap_requests_target_select on public.shift_swap_requests;
create policy shift_swap_requests_target_select on public.shift_swap_requests for select to authenticated using (
  target_employee_id = any ((select app.own_employee_ids())::uuid[])
  or (organization_id = any ((select app.org_ids_with_any_permission(array['attendance.view_team']::text[]))::uuid[]) and target_employee_id = any ((select app.team_employee_ids())::uuid[]))
);
call app.deny_client_writes('public.shift_swap_requests');

-- 4g. selfie photos: reachable through the API only ------------------------------------------------------------------------------
-- Selfie check-in photos live in the private employee-photos bucket under checkins/<org>/<employee>/<selfie id>.<ext>. Only the
-- API touches them, with its service client: the upload (after its own checks) and a 60-second signed URL per permitted viewer
-- (the employee, their primary / secondary manager, attendance reviewers in scope — every issue audited). Their first path
-- segment is not an organisation id, so no tenant storage policy (all keyed on app.path_org_id) matches them; this restrictive
-- policy makes that explicit and permanent: whatever a later, broader storage policy grants, no client role can list, read,
-- write or delete an object under the prefix.
do $$
begin
  if to_regclass('storage.objects') is not null then
    execute $p$ drop policy if exists flowza_selfie_photos_deny_client on storage.objects $p$;
    execute $p$ create policy flowza_selfie_photos_deny_client on storage.objects as restrictive for all to anon, authenticated, flowza_system
      using (coalesce(bucket_id, '') <> 'employee-photos' or coalesce(name, '') not like 'checkins/%')
      with check (coalesce(bucket_id, '') <> 'employee-photos' or coalesce(name, '') not like 'checkins/%') $p$;
  end if;
end $$;

-- 5. corrections carry the device a punch stands for ---------------------------------------------------------------------------
alter table public.attendance_corrections add column if not exists device_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'attendance_corrections_device_fkey') then
    alter table public.attendance_corrections add constraint attendance_corrections_device_fkey
      foreign key (device_id, organization_id) references public.devices(id, organization_id) on delete set null (device_id);
  end if;
end $$;

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

-- 6. Post-verify (fails the migration rather than leaving a half-applied state) --------------------------------------------------
do $$
declare v_table text; v_count int;
begin
  if not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'raw_source' and e.enumlabel = 'SELF_SERVICE') then
    raise exception 'raw_source lacks SELF_SERVICE';
  end if;
  if not exists (select 1 from public.device_providers where key = 'self_service') then raise exception 'self_service provider row missing'; end if;
  foreach v_table in array array['attendance_notes', 'attendance_regularisation_requests', 'employee_attendance_grants', 'selfie_checkins', 'shift_swap_requests'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = v_table and 'authenticated' = any (roles) and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL') and permissive = 'PERMISSIVE') then
      raise exception '% must have no permissive client write policy', v_table;
    end if;
    select count(*) into v_count from pg_policies where schemaname = 'public' and tablename = v_table and permissive = 'RESTRICTIVE' and 'authenticated' = any (roles);
    if v_count <> 3 then raise exception '% lacks its explicit client write denials (% of 3)', v_table, v_count; end if;
    if has_table_privilege('authenticated', 'public.' || v_table, 'insert') or has_table_privilege('authenticated', 'public.' || v_table, 'update')
       or has_table_privilege('authenticated', 'public.' || v_table, 'delete') then
      raise exception 'authenticated must not hold write privileges on %', v_table;
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = v_table and policyname = v_table || '_system_write') then
      raise exception '% system write policy missing', v_table;
    end if;
  end loop;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'attendance_notes' and policyname = 'attendance_notes_select' and qual like '%own_employee_ids%' and qual like '%team_employee_ids%') then
    raise exception 'attendance_notes select policy lacks the self / team predicates';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'geofences' and policyname = 'geofences_insert' and with_check like '%attendance.manage_geofences%') then
    raise exception 'geofences insert policy is not keyed on attendance.manage_geofences';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'attendance_notes_active_idx') then raise exception 'one-active-note index missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'attendance_corrections' and column_name = 'device_id') then
    raise exception 'attendance_corrections.device_id missing';
  end if;
  if to_regclass('storage.objects') is not null and not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'flowza_selfie_photos_deny_client' and permissive = 'RESTRICTIVE' and cmd = 'ALL' and 'authenticated' = any (roles) and 'anon' = any (roles)) then
    raise exception 'the selfie-photo storage denial is missing';
  end if;
end $$;
