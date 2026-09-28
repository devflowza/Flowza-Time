-- FlowZa Time · 20260928000840 · Employee portal attendance — review fixes (HR portal Prompt 4 review,
-- docs/hr-portal/reviews/04-employee-portal-attendance-review.md; report: docs/hr-portal/reports/04-employee-portal-attendance.md
-- §10 "Review fixes").
--
-- 1. geofences / geofence_assignments (P0-1). The generic tenant policies let a branch-restricted attendance.manage_geofences
--    holder UPDATE / DELETE organisation-wide fences (branch_id null) and INSERT / DELETE any assignment (the table has no
--    branch column at all) directly through PostgREST — loosening every branch's hard-block fence. Both tables become
--    service-write-only exactly like report_schedules after the 6a review: no client write privilege, three explicit restrictive
--    denials each (a later GRANT alone never reopens them), and a system-context write policy for the API's system step, which
--    runs after the service's checks (the stored fence's branch — organisation-wide fences for unrestricted holders only —, the
--    new branch, every assignment target inside the caller's branches, and the fence's reach). Reads stay RLS-scoped:
--      * geofences: attendance.view or attendance.manage_geofences, branch scope; an organisation-wide fence (branch null) is
--        READ-ONLY context for a branch-restricted holder (it applies to their people too; they can never change it);
--      * geofence_assignments: only of a fence the caller can read, and only a target inside the caller's branches (or the
--        organisation scope) — a branch-restricted holder no longer reads another branch's assignments.
-- 2. approval_requests.co_subject_employee_ids / co_subject_user_ids (P0-2). The OTHER people a request is about besides
--    employee_id — the colleague of a shift swap. The engine drops them (and their logins) from every rung of the resolution
--    ladder like the subject and refuses them at decide / bypass / reassign / request-info / withdraw-on-behalf; the owner is
--    the one logged exception. co_subject_user_ids is the submit-time login snapshot (like subject_user_id); the live
--    membership link is checked too. Pending swap requests of before this migration are backfilled.
-- 3. shift_swap_requests (P2-12): one pending / approved swap per person and day, per role — partial unique indexes on
--    (organization_id, target_employee_id, swap_date) and (organization_id, requester_employee_id, swap_date). The API also
--    takes ordered advisory locks on both people; the indexes are the database's word on it.
-- 4. selfie_checkins.verdict_reason (P2-7): why the geofence verdict was given (inside / outside / location_missing / …), so the
--    punch written on approval carries a truthful within-geofence fact.
-- 5. device_providers (P2-19): re-applying the migrations must change nothing. The provider upserts of 20260928000400 /
--    000450 / 000500 set `updated_at = now()` unconditionally; a BEFORE UPDATE trigger keeps the old stamp when no other
--    column changed, so a no-op upsert (any later one too) leaves the row byte-identical.
-- 6. Special leave types (ATT-82): marriage, bereavement, adoption and compassionate leave are never charged for an unexcused
--    day (Finance parity). The default exclusion list of the settings is extended in @flowza/contracts; existing leave types
--    whose CODE is one of those words (case-insensitive) are marked `is_special` here, one audit row each. No other type is
--    touched.
--
-- Idempotent (named policies dropped / created, `if not exists`, guarded updates); additive otherwise. Safe as one transaction
-- (no enum value, no concurrent index; the indexed tables are small and new). Bounded lock waits.
set lock_timeout = '5s';
set statement_timeout = '120s';
set client_min_messages = warning;

-- 1. geofences: read RLS-scoped, written by the service's system step only --------------------------------------------------
drop policy if exists geofences_select on public.geofences;
create policy geofences_select on public.geofences for select to authenticated, flowza_system using (
  organization_id = any ((select app.org_ids_with_any_permission(array['attendance.view', 'attendance.manage_geofences']::text[]))::uuid[])
  -- a branch-restricted holder reads their branches' fences and the organisation-wide ones (read-only context: the API never
  -- lets them change one); another branch's fence stays hidden
  and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or branch_id is null or branch_id = any ((select app.allowed_branch_ids())::uuid[]))
);
drop policy if exists geofences_insert on public.geofences;
drop policy if exists geofences_update on public.geofences;
drop policy if exists geofences_delete on public.geofences;
drop policy if exists geofences_system_write on public.geofences;
create policy geofences_system_write on public.geofences for all to flowza_system
  using (organization_id = app.system_org_id()) with check (organization_id = app.system_org_id());
call app.deny_client_writes('public.geofences');

-- The branch an assignment target belongs to (the branch itself, a department's / team's branch, an employee's current branch);
-- null for the organisation scope, an unknown target or a department / team without a branch (organisation-wide). Reads the
-- directory regardless of the caller's own read keys — it returns an id only, and only for an organisation the caller belongs to.
create or replace function app.geofence_target_branch_id(p_org uuid, p_scope public.geofence_scope, p_target uuid) returns uuid
language sql stable security definer set search_path = ''
as $$
  select case when p_org is null or not (p_org = any (app.member_org_ids())) then null
    else case p_scope
      when 'branch' then (select b.id from public.branches b where b.organization_id = p_org and b.id = p_target)
      when 'department' then (select d.branch_id from public.departments d where d.organization_id = p_org and d.id = p_target)
      when 'team' then (select t.branch_id from public.teams t where t.organization_id = p_org and t.id = p_target)
      when 'employee' then (select e.branch_id from public.employees e where e.organization_id = p_org and e.id = p_target)
      else null end
  end
$$;
grant execute on function app.geofence_target_branch_id(uuid, public.geofence_scope, uuid) to authenticated, flowza_system, flowza_api, flowza_worker;

drop policy if exists geofence_assignments_select on public.geofence_assignments;
create policy geofence_assignments_select on public.geofence_assignments for select to authenticated, flowza_system using (
  organization_id = any ((select app.org_ids_with_any_permission(array['attendance.view', 'attendance.manage_geofences']::text[]))::uuid[])
  -- the fence must be readable under the caller's own RLS (never an assignment of another branch's fence)
  and exists (select 1 from public.geofences g where g.id = geofence_assignments.geofence_id and g.organization_id = geofence_assignments.organization_id)
  -- and the target inside the caller's branches; organisation-scope assignments are read-only context
  and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or scope = 'org'
       or app.geofence_target_branch_id(organization_id, scope, target_id) = any ((select app.allowed_branch_ids())::uuid[]))
);
drop policy if exists geofence_assignments_insert on public.geofence_assignments;
drop policy if exists geofence_assignments_update on public.geofence_assignments;
drop policy if exists geofence_assignments_delete on public.geofence_assignments;
drop policy if exists geofence_assignments_system_write on public.geofence_assignments;
create policy geofence_assignments_system_write on public.geofence_assignments for all to flowza_system
  using (organization_id = app.system_org_id()) with check (organization_id = app.system_org_id());
call app.deny_client_writes('public.geofence_assignments');

-- 2. co-subjects of an approval request ---------------------------------------------------------------------------------------
alter table public.approval_requests add column if not exists co_subject_employee_ids uuid[];
alter table public.approval_requests add column if not exists co_subject_user_ids uuid[];
comment on column public.approval_requests.co_subject_employee_ids is
  'Other employees the request is about besides employee_id (a shift swap''s colleague): never seated, never decide, bypass, ask, withdraw on behalf or receive a reassignment (segregation of duties; the owner is the logged exception).';
comment on column public.approval_requests.co_subject_user_ids is
  'Logins linked to the co-subject employees when the request was submitted (the live membership link is checked as well).';
-- pending swap requests filed before this migration: the colleague becomes a co-subject (idempotent: only rows still unset)
update public.approval_requests r
   set co_subject_employee_ids = array[s.target_employee_id],
       co_subject_user_ids = coalesce((select array_agg(distinct m.user_id) from public.org_memberships m
                                        where m.organization_id = s.organization_id and m.employee_id = s.target_employee_id), '{}'::uuid[])
  from public.shift_swap_requests s
 where r.entity_type = 'SHIFT_SWAP' and r.entity_id = s.id and r.organization_id = s.organization_id and r.co_subject_employee_ids is null;

-- 3. one pending / approved swap per person and day --------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.shift_swap_requests where status in ('pending', 'approved') group by organization_id, target_employee_id, swap_date having count(*) > 1)
     or exists (select 1 from public.shift_swap_requests where status in ('pending', 'approved') group by organization_id, requester_employee_id, swap_date having count(*) > 1) then
    raise exception 'shift_swap_requests holds two pending / approved swaps for one person and day: decide or withdraw one of them before applying 20260928000840';
  end if;
end $$;
create unique index if not exists shift_swap_requests_open_target_day_idx on public.shift_swap_requests (organization_id, target_employee_id, swap_date) where status in ('pending', 'approved');
create unique index if not exists shift_swap_requests_open_requester_day_idx on public.shift_swap_requests (organization_id, requester_employee_id, swap_date) where status in ('pending', 'approved');

-- 4. why a selfie's geofence verdict was given --------------------------------------------------------------------------------
alter table public.selfie_checkins add column if not exists verdict_reason text check (verdict_reason is null or length(verdict_reason) <= 60);

-- 5. a no-op provider upsert keeps the row byte-identical ------------------------------------------------------------------
create or replace function app.device_providers_keep_updated_at() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new) - 'updated_at') = (to_jsonb(old) - 'updated_at') then
    new.updated_at := old.updated_at;
  end if;
  return new;
end $$;
drop trigger if exists device_providers_keep_updated_at on public.device_providers;
create trigger device_providers_keep_updated_at before update on public.device_providers for each row execute function app.device_providers_keep_updated_at();

-- 6. marriage / bereavement / adoption / compassionate leave are special (never charged for an unexcused day) -----------------
with marked as (
  update public.leave_types t set is_special = true
   where lower(t.code::text) in ('marriage', 'bereavement', 'adoption', 'compassionate') and not t.is_special
  returning t.id, t.organization_id, t.code::text as code, t.name
)
insert into audit.logs (organization_id, actor_type, actor_label, action, entity_type, entity_id, branch_id, old_value, new_value, reason)
select m.organization_id, 'SYSTEM', 'migration 20260928000840', 'leave_type.marked_special', 'leave_type', m.id::text, null,
       jsonb_build_object('isSpecial', false, 'code', m.code, 'name', m.name), jsonb_build_object('isSpecial', true),
       'Marriage, bereavement, adoption and compassionate leave are never charged for an unexcused day (Finance parity, ATT-82).'
from marked m;

-- Safety net (every table keeps RLS on).
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
declare v_table text; v_count int;
begin
  foreach v_table in array array['geofences', 'geofence_assignments'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = v_table and 'authenticated' = any (roles) and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL') and permissive = 'PERMISSIVE') then
      raise exception '% must have no permissive client write policy', v_table;
    end if;
    select count(*) into v_count from pg_policies where schemaname = 'public' and tablename = v_table and permissive = 'RESTRICTIVE' and 'authenticated' = any (roles);
    if v_count <> 3 then raise exception '% lacks its explicit client write denials (% of 3)', v_table, v_count; end if;
    if has_table_privilege('authenticated', 'public.' || v_table, 'insert') or has_table_privilege('authenticated', 'public.' || v_table, 'update')
       or has_table_privilege('authenticated', 'public.' || v_table, 'delete') then
      raise exception 'authenticated must not hold write privileges on %', v_table;
    end if;
    if not has_table_privilege('authenticated', 'public.' || v_table, 'select') then raise exception 'authenticated must still read %', v_table; end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = v_table and policyname = v_table || '_system_write' and 'flowza_system' = any (roles)) then
      raise exception '% system write policy missing', v_table;
    end if;
  end loop;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'geofence_assignments' and policyname = 'geofence_assignments_select' and qual like '%geofences g%' and qual like '%geofence_target_branch_id%') then
    raise exception 'geofence_assignments read policy must follow the fence and the target''s branch';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'geofences' and policyname = 'geofences_select' and qual like '%attendance.manage_geofences%') then
    raise exception 'geofences read policy must admit attendance.manage_geofences holders';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'approval_requests' and column_name = 'co_subject_employee_ids')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'approval_requests' and column_name = 'co_subject_user_ids') then
    raise exception 'approval_requests co-subject columns missing';
  end if;
  if exists (select 1 from public.approval_requests r join public.shift_swap_requests s on s.id = r.entity_id and s.organization_id = r.organization_id
             where r.entity_type = 'SHIFT_SWAP' and (r.co_subject_employee_ids is null or not (s.target_employee_id = any (r.co_subject_employee_ids)))) then
    raise exception 'a shift swap request lacks its colleague as co-subject';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'shift_swap_requests_open_target_day_idx')
     or not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'shift_swap_requests_open_requester_day_idx') then
    raise exception 'one-open-swap-per-person-and-day indexes missing';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'selfie_checkins' and column_name = 'verdict_reason') then
    raise exception 'selfie_checkins.verdict_reason missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'device_providers_keep_updated_at' and not tgisinternal) then
    raise exception 'device_providers no-op upsert trigger missing';
  end if;
  if exists (select 1 from public.leave_types where lower(code::text) in ('marriage', 'bereavement', 'adoption', 'compassionate') and not is_special) then
    raise exception 'a marriage / bereavement / adoption / compassionate leave type is still chargeable';
  end if;
end $$;
