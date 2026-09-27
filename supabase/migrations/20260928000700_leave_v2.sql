-- Leave v2 — Finance parity (HR portal Prompt 7), part 2 of 2. Needs 20260928000690_leave_v2_enum.sql (INFO_REQUESTED).
--
-- 1. `leave_types` gains the policy of a type: requires_approval (false ⇒ an application is approved at once), count_mode
--    (working days vs calendar days), max_consecutive_days, advance_notice_days, applicable_gender, accrual (none /
--    monthly), carry-forward (max days, expiry in months), is_special (never charged for unexcused days), allow_half_day,
--    portal_visible, and `system_key` ('COMP_OFF' marks the per-organisation compensatory-off type the comp-off redemption
--    books against; at most one per organisation). Every existing type keeps its behaviour (defaults = today's rules).
-- 2. `leave_records` gains `days` (server-computed at submit / edit by the type's count mode; null on rows written before
--    this migration — the API computes those on read), `withdrawn_at` and `edited_at`.
-- 3. `leave_allocations` — the yearly entitlement of one employee for one type: allocated days (prorated for joiners by
--    the generator), carried-forward days (+ their expiry), opening balance and manual adjustment. No stored counters:
--    taken / pending / available are always computed (one function, packages/domain/src/leave/balances.ts).
-- 4. `leave_request_comments` — the append-only thread of a leave request (comment / info_request / reply / system).
--    Readable wherever the leave row is readable or a LEAVE approval request about it is (the approver's assignment);
--    a client may only add a plain `comment` in its own name; questions, replies and system lines are written by the
--    approval engine hooks in the organisation's system context.
-- 5. `comp_off_credits` — days earned by working a weekly off / holiday (pending_approval → approved → partially_used /
--    used / expired; rejected; cancelled when the request is withdrawn), one active credit per (employee, worked_on);
--    `comp_off_usages` — which credit paid for which comp-off leave (earliest expiry first), released on cancellation.
-- 6. Overlap protection: a GiST exclusion constraint on `leave_records` for active requests (PENDING, APPROVED,
--    INFO_REQUESTED). Each request occupies half-day "slots" (2 per date: first half, second half), so a FIRST_HALF and a
--    SECOND_HALF request on the same date coexist while a full day conflicts with both. Existing overlapping active rows
--    (none are expected — every API path refused overlaps — but seeds and direct SQL could have written some) are resolved
--    explicitly BEFORE the constraint is added: the weaker request (PENDING < INFO_REQUESTED < APPROVED, then the newer)
--    is CANCELLED with a decision note, its pending approval request cancelled with a timeline line, and a cancelled
--    APPROVED row queues the recompute of its past days. The migration reports how many rows it resolved.
-- 7. Self-service RLS: an employee may edit their own PENDING / INFO_REQUESTED request (type, dates, half day, reason) and
--    withdraw it; the guard trigger freezes every other column (approval stamps, decision note, employee, branch, source).
-- 8. `organization_settings.leave` — the leave settings group (contracts `leaveSettingsSchema`: compOffExpiryDays …).
-- 9. The comp-off leave type (code CO, system_key COMP_OFF, special, not offered in the ordinary apply form) for every
--    organisation; an organisation that already has a type coded CO has that type adopted as its comp-off type.
--
-- Additive and idempotent (re-applying is a no-op); bounded lock waits (hot table: leave_records). Post-verify at the end.
set lock_timeout = '5s';
set statement_timeout = '120s';
set client_min_messages = warning;

-- 1. Leave type policy ------------------------------------------------------------------------------------------------------
alter table public.leave_types
  add column if not exists requires_approval boolean not null default true,
  add column if not exists count_mode text not null default 'working',
  add column if not exists max_consecutive_days int,
  add column if not exists advance_notice_days int not null default 0,
  add column if not exists applicable_gender text not null default 'all',
  add column if not exists accrual text not null default 'none',
  add column if not exists carry_forward_max_days numeric(5,1) not null default 0,
  add column if not exists carry_forward_expiry_months int,
  add column if not exists is_special boolean not null default false,
  add column if not exists allow_half_day boolean not null default true,
  add column if not exists portal_visible boolean not null default true,
  add column if not exists system_key text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leave_types_count_mode_check') then
    alter table public.leave_types add constraint leave_types_count_mode_check check (count_mode in ('working', 'calendar'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leave_types_max_consecutive_check') then
    alter table public.leave_types add constraint leave_types_max_consecutive_check check (max_consecutive_days is null or (max_consecutive_days between 1 and 366));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leave_types_advance_notice_check') then
    alter table public.leave_types add constraint leave_types_advance_notice_check check (advance_notice_days between 0 and 365);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leave_types_applicable_gender_check') then
    alter table public.leave_types add constraint leave_types_applicable_gender_check check (applicable_gender in ('all', 'male', 'female'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leave_types_accrual_check') then
    alter table public.leave_types add constraint leave_types_accrual_check check (accrual in ('none', 'monthly'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leave_types_carry_forward_check') then
    alter table public.leave_types add constraint leave_types_carry_forward_check check (
      carry_forward_max_days >= 0 and carry_forward_max_days <= 366 and carry_forward_max_days * 2 = trunc(carry_forward_max_days * 2)
      and (carry_forward_expiry_months is null or carry_forward_expiry_months between 1 and 24));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leave_types_system_key_check') then
    alter table public.leave_types add constraint leave_types_system_key_check check (system_key is null or system_key in ('COMP_OFF'));
  end if;
end $$;
create unique index if not exists leave_types_system_key_idx on public.leave_types (organization_id, system_key) where system_key is not null;

-- 2. Leave record columns ---------------------------------------------------------------------------------------------------
alter table public.leave_records
  add column if not exists days numeric(5,1),
  add column if not exists withdrawn_at timestamptz,
  add column if not exists edited_at timestamptz;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leave_records_days_check') then
    alter table public.leave_records add constraint leave_records_days_check check (days is null or (days >= 0 and days <= 366));
  end if;
end $$;

-- 3. Allocations ------------------------------------------------------------------------------------------------------------
create table if not exists public.leave_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null,
  leave_type_id uuid not null,
  -- the employee's branch when the row was last written (RLS branch scope, like leave_records.branch_id)
  branch_id uuid,
  year int not null check (year between 2000 and 2100),
  allocated_days numeric(5,1) not null default 0 check (allocated_days >= 0 and allocated_days <= 366 and allocated_days * 2 = trunc(allocated_days * 2)),
  carried_forward_days numeric(5,1) not null default 0 check (carried_forward_days >= 0 and carried_forward_days <= 366 and carried_forward_days * 2 = trunc(carried_forward_days * 2)),
  carried_forward_expires_on date,
  opening_balance_days numeric(5,1) not null default 0 check (opening_balance_days between -366 and 366 and opening_balance_days * 2 = trunc(opening_balance_days * 2)),
  adjustment_days numeric(5,1) not null default 0 check (adjustment_days between -366 and 366 and adjustment_days * 2 = trunc(adjustment_days * 2)),
  notes text check (notes is null or length(notes) <= 1000),
  created_by uuid references public.user_profiles(id) on delete set null,
  updated_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leave_allocations_unique unique (organization_id, employee_id, leave_type_id, year),
  constraint leave_allocations_employee_fkey foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade,
  constraint leave_allocations_type_fkey foreign key (leave_type_id, organization_id) references public.leave_types(id, organization_id) on delete cascade,
  constraint leave_allocations_branch_fkey foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete set null (branch_id),
  constraint leave_allocations_cf_expiry check (carried_forward_expires_on is null or carried_forward_days > 0)
);
create index if not exists leave_allocations_year_idx on public.leave_allocations (organization_id, year, leave_type_id);
create index if not exists leave_allocations_employee_idx on public.leave_allocations (organization_id, employee_id, year);
drop trigger if exists leave_allocations_updated_at on public.leave_allocations;
create trigger leave_allocations_updated_at before update on public.leave_allocations for each row execute function app.set_updated_at();
call app.apply_tenant_policies('public.leave_allocations', 'leave.view', 'leave.manage', 'branch_id', 'employee_id', null, 'employee_id', array['leave.view_team']);

-- 4. Comment thread (append-only) -------------------------------------------------------------------------------------------
create table if not exists public.leave_request_comments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  leave_record_id uuid not null references public.leave_records(id),
  author_user_id uuid references public.user_profiles(id) on delete set null,
  body text not null check (length(btrim(body)) > 0 and length(body) <= 2000),
  kind text not null default 'comment' check (kind in ('comment', 'info_request', 'reply', 'system')),
  created_at timestamptz not null default now()
);
create index if not exists leave_request_comments_record_idx on public.leave_request_comments (organization_id, leave_record_id, created_at);
drop trigger if exists leave_request_comments_append_only on public.leave_request_comments;
create trigger leave_request_comments_append_only before update or delete on public.leave_request_comments for each row execute function app.reject_modification();

alter table public.leave_request_comments enable row level security;
-- visible wherever the leave itself is (own / team / leave.view) or where a LEAVE approval request about it is (the
-- assignee, the delegate, the requester — the approval_requests policy decides); both subqueries run under the caller's RLS
drop policy if exists leave_request_comments_select on public.leave_request_comments;
create policy leave_request_comments_select on public.leave_request_comments for select to authenticated, flowza_system using (
  exists (select 1 from public.leave_records l where l.id = leave_request_comments.leave_record_id and l.organization_id = leave_request_comments.organization_id)
  or exists (select 1 from public.approval_requests r where r.entity_type = 'LEAVE' and r.entity_id = leave_request_comments.leave_record_id and r.organization_id = leave_request_comments.organization_id)
);
drop policy if exists leave_request_comments_insert on public.leave_request_comments;
create policy leave_request_comments_insert on public.leave_request_comments for insert to authenticated with check (
  kind = 'comment' and author_user_id = (select app.uid())
  and organization_id = any ((select app.member_org_ids())::uuid[])
  and (exists (select 1 from public.leave_records l where l.id = leave_request_comments.leave_record_id and l.organization_id = leave_request_comments.organization_id)
       or exists (select 1 from public.approval_requests r where r.entity_type = 'LEAVE' and r.entity_id = leave_request_comments.leave_record_id and r.organization_id = leave_request_comments.organization_id))
);
drop policy if exists leave_request_comments_system_write on public.leave_request_comments;
create policy leave_request_comments_system_write on public.leave_request_comments for insert to flowza_system with check (organization_id = app.system_org_id());

-- 5. Comp-off credits and their usage -------------------------------------------------------------------------------------
create table if not exists public.comp_off_credits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null,
  branch_id uuid,
  worked_on date not null,
  worked_on_type text not null check (worked_on_type in ('weekly_off', 'holiday')),
  worked_minutes int not null check (worked_minutes between 0 and 1440),
  days_earned numeric(3,1) not null check (days_earned in (0.5, 1.0)),
  location text not null check (length(btrim(location)) > 0 and length(location) <= 200),
  summary text not null check (length(btrim(summary)) > 0 and length(summary) <= 1000),
  status text not null default 'pending_approval' check (status in ('pending_approval', 'approved', 'rejected', 'used', 'partially_used', 'expired', 'cancelled')),
  used_days numeric(3,1) not null default 0 check (used_days >= 0 and used_days <= days_earned),
  expires_on date,
  approval_request_id uuid references public.approval_requests(id) on delete set null,
  decision_note text check (decision_note is null or length(decision_note) <= 1000),
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint comp_off_credits_employee_fkey foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade,
  constraint comp_off_credits_branch_fkey foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete set null (branch_id),
  constraint comp_off_credits_expiry check (status not in ('approved', 'partially_used', 'used', 'expired') or expires_on is not null),
  unique (id, organization_id)
);
-- one active credit per (employee, worked day): a rejected / withdrawn request may be filed again, anything else may not
create unique index if not exists comp_off_credits_active_idx on public.comp_off_credits (organization_id, employee_id, worked_on) where status not in ('rejected', 'cancelled');
create index if not exists comp_off_credits_employee_idx on public.comp_off_credits (organization_id, employee_id, expires_on) where status in ('approved', 'partially_used');
create index if not exists comp_off_credits_pending_idx on public.comp_off_credits (organization_id, created_at) where status = 'pending_approval';
drop trigger if exists comp_off_credits_updated_at on public.comp_off_credits;
create trigger comp_off_credits_updated_at before update on public.comp_off_credits for each row execute function app.set_updated_at();
call app.apply_tenant_policies('public.comp_off_credits', 'leave.view', 'leave.manage', 'branch_id', 'employee_id', null, 'employee_id', array['leave.view_team']);
-- the employee files a request for their own worked day (PENDING, nothing used, no approval stamp); the engine and the
-- worker do the rest in the organisation's system context
drop policy if exists comp_off_credits_self_request on public.comp_off_credits;
create policy comp_off_credits_self_request on public.comp_off_credits for insert to authenticated with check (
  organization_id = any ((select app.org_ids_with_permission('leave.request'))::uuid[])
  and employee_id = any ((select app.own_employee_ids())::uuid[])
  and status = 'pending_approval' and used_days = 0 and approval_request_id is null and expires_on is null and decision_note is null
  and created_by = (select app.uid())
  and exists (select 1 from public.employees e where e.id = comp_off_credits.employee_id and e.organization_id = comp_off_credits.organization_id
              and e.deleted_at is null and e.branch_id is not distinct from comp_off_credits.branch_id)
);

create table if not exists public.comp_off_usages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null,
  branch_id uuid,
  credit_id uuid not null,
  leave_record_id uuid not null references public.leave_records(id) on delete cascade,
  days numeric(3,1) not null check (days in (0.5, 1.0)),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  constraint comp_off_usages_credit_fkey foreign key (credit_id, organization_id) references public.comp_off_credits(id, organization_id) on delete cascade,
  constraint comp_off_usages_employee_fkey foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade
);
create index if not exists comp_off_usages_leave_idx on public.comp_off_usages (organization_id, leave_record_id) where released_at is null;
create index if not exists comp_off_usages_credit_idx on public.comp_off_usages (credit_id);
call app.apply_readonly_tenant_policies('public.comp_off_usages', 'leave.view', 'branch_id', 'employee_id', 'employee_id', array['leave.view_team']);

-- 6. Overlap protection -----------------------------------------------------------------------------------------------------
-- A request's half-day slots: date d = slots 2d (first half) and 2d+1 (second half), counted from 2000-01-01.
create or replace function app.leave_slot_range(p_start date, p_end date, p_half boolean, p_part public.half_day_part) returns int4range
language sql immutable parallel safe set search_path = '' as $$
  select int4range(
    ((p_start - date '2000-01-01') * 2) + (case when p_half and p_part = 'SECOND_HALF' then 1 else 0 end),
    ((p_end - date '2000-01-01') * 2) + (case when p_half and p_part = 'FIRST_HALF' then 0 else 1 end),
    '[]')
$$;

do $$
declare
  r record;
  v_resolved int := 0;
  v_note text;
  v_day date;
begin
  if exists (select 1 from pg_constraint where conname = 'leave_records_no_overlap') then
    return; -- already protected (re-apply)
  end if;
  loop
    -- the weakest request of the first remaining conflicting pair: rank PENDING 1 < INFO_REQUESTED 2 < APPROVED 3, then the newer
    select b.id as loser_id, b.organization_id, b.employee_id, b.status::text as loser_status, b.start_date, b.end_date, a.id as keeper_id into r
    from (select l.*, case l.status::text when 'APPROVED' then 3 when 'INFO_REQUESTED' then 2 else 1 end as rnk,
                 app.leave_slot_range(l.start_date, l.end_date, l.is_half_day, l.half_day_part) as slots
          from public.leave_records l where l.status::text in ('PENDING', 'APPROVED', 'INFO_REQUESTED')) a
    join (select l.*, case l.status::text when 'APPROVED' then 3 when 'INFO_REQUESTED' then 2 else 1 end as rnk,
                 app.leave_slot_range(l.start_date, l.end_date, l.is_half_day, l.half_day_part) as slots
          from public.leave_records l where l.status::text in ('PENDING', 'APPROVED', 'INFO_REQUESTED')) b
      on b.organization_id = a.organization_id and b.employee_id = a.employee_id and b.id <> a.id and a.slots && b.slots
    where a.rnk > b.rnk or (a.rnk = b.rnk and (a.created_at, a.id) < (b.created_at, b.id))
    order by b.organization_id, b.created_at, b.id
    limit 1;
    exit when not found;
    v_note := left(format('Cancelled by migration 20260928000700 (leave v2): it overlapped leave %s. Please re-apply if still needed.', r.keeper_id), 1000);
    update public.leave_records set status = 'CANCELLED', decision_note = v_note, withdrawn_at = coalesce(withdrawn_at, now()) where id = r.loser_id;
    -- its pending approval request goes with it (timeline line; no hook — the leave is already cancelled)
    insert into public.approval_request_events (organization_id, request_id, kind, actor_user_id, detail)
    select q.organization_id, q.id, 'cancelled', null, jsonb_build_object('reason', v_note, 'source', 'migration')
    from public.approval_requests q where q.entity_type = 'LEAVE' and q.entity_id = r.loser_id and q.status = 'PENDING';
    update public.approval_step_actors a set decision = 'SKIPPED'
    from public.approval_steps s join public.approval_requests q on q.id = s.request_id
    where a.step_id = s.id and a.decision = 'PENDING' and q.entity_type = 'LEAVE' and q.entity_id = r.loser_id and q.status = 'PENDING';
    update public.approval_steps s set status = 'SKIPPED'
    from public.approval_requests q where q.id = s.request_id and s.status = 'PENDING' and q.entity_type = 'LEAVE' and q.entity_id = r.loser_id and q.status = 'PENDING';
    update public.approval_requests set status = 'CANCELLED', completed_at = now(), cancel_reason = v_note
    where entity_type = 'LEAVE' and entity_id = r.loser_id and status = 'PENDING';
    -- a cancelled APPROVED leave changes computed days: queue their recompute (past days only; the future computes on arrival)
    if r.loser_status = 'APPROVED' then
      for v_day in select generate_series(r.start_date, least(r.end_date, current_date), interval '1 day')::date loop
        perform jobs.enqueue('processing', 'RECOMPUTE_DAILY', r.organization_id,
          jsonb_build_object('organizationId', r.organization_id, 'employeeId', r.employee_id, 'date', v_day, 'reason', 'LEAVE_CHANGE'),
          5, now(), format('recompute:%s:%s', r.employee_id, v_day), 5, 120, 'migration-20260928000700');
      end loop;
    end if;
    v_resolved := v_resolved + 1;
  end loop;
  if v_resolved > 0 then
    raise warning 'leave v2: % overlapping active leave request(s) were cancelled before adding leave_records_no_overlap', v_resolved;
  end if;
  alter table public.leave_records add constraint leave_records_no_overlap exclude using gist (
    organization_id with =,
    employee_id with =,
    app.leave_slot_range(start_date, end_date, is_half_day, half_day_part) with &&
  ) where (status in ('PENDING', 'APPROVED', 'INFO_REQUESTED'));
end $$;

-- 7. Self-service: edit / withdraw one's own pending request -------------------------------------------------------------
drop policy if exists leave_records_self_cancel on public.leave_records;
drop policy if exists leave_records_self_update on public.leave_records;
create policy leave_records_self_update on public.leave_records for update to authenticated using (
  organization_id = any ((select app.org_ids_with_permission('leave.request'))::uuid[])
  and employee_id = any ((select app.own_employee_ids())::uuid[])
  and status in ('PENDING', 'INFO_REQUESTED')
) with check (
  organization_id = any ((select app.org_ids_with_permission('leave.request'))::uuid[])
  and employee_id = any ((select app.own_employee_ids())::uuid[])
  and status in ('PENDING', 'CANCELLED')
);

-- A user without leave.manage who reaches an update through the self-service policy may: withdraw (→ CANCELLED, status and
-- the withdrawal stamp only) or edit (→ PENDING: type, dates, half day, reason, days, edit stamp). Approval stamps, the
-- decision note, the employee, the branch, the source and the approval link are never theirs to change. Only user
-- sessions (role authenticated) are checked: system steps, the worker and admin seeds run as other roles.
create or replace function app.leave_records_self_service_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user::text <> 'authenticated' or app.has_permission(new.organization_id, 'leave.manage') then
    return new;
  end if;
  if old.status::text not in ('PENDING', 'INFO_REQUESTED') then
    raise exception 'self-service may only change a leave request that is still pending' using errcode = '42501';
  end if;
  if new.status::text = 'CANCELLED' then
    if (to_jsonb(new) - array['status', 'updated_at', 'withdrawn_at']) is distinct from (to_jsonb(old) - array['status', 'updated_at', 'withdrawn_at']) then
      raise exception 'withdrawing a leave request may change its status only' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.status::text = 'PENDING' then
    if (to_jsonb(new) - array['status', 'updated_at', 'leave_type_id', 'start_date', 'end_date', 'is_half_day', 'half_day_part', 'reason', 'days', 'edited_at'])
       is distinct from (to_jsonb(old) - array['status', 'updated_at', 'leave_type_id', 'start_date', 'end_date', 'is_half_day', 'half_day_part', 'reason', 'days', 'edited_at']) then
      raise exception 'self-service may only change the type, dates, half day and reason of a pending request' using errcode = '42501';
    end if;
    return new;
  end if;
  raise exception 'self-service may only edit or withdraw a pending leave request' using errcode = '42501';
end $$;
drop trigger if exists leave_records_self_service_guard on public.leave_records;
create trigger leave_records_self_service_guard before update on public.leave_records for each row execute function app.leave_records_self_service_guard();

-- 8. Settings group -----------------------------------------------------------------------------------------------------------
alter table public.organization_settings
  add column if not exists leave jsonb not null default '{}'::jsonb check (jsonb_typeof(leave) = 'object');

-- 9. The comp-off leave type per organisation ---------------------------------------------------------------------------------
-- adopt an existing ACTIVE type coded CO (the conventional code; `code` is citext, compared through lower() because the
-- citext operators live in the extensions schema), else create one — coded CO, or COFF when an inactive CO already exists
update public.leave_types t set system_key = 'COMP_OFF', is_special = true, portal_visible = false, annual_allowance_days = null, accrual = 'none', carry_forward_max_days = 0
where lower(t.code::text) = 'co' and t.status = 'active' and t.system_key is null
  and not exists (select 1 from public.leave_types x where x.organization_id = t.organization_id and x.system_key = 'COMP_OFF');
insert into public.leave_types (organization_id, code, name, name_ar, is_paid, color, status, requires_approval, count_mode, is_special, allow_half_day, portal_visible, system_key)
select o.id,
       case when exists (select 1 from public.leave_types x where x.organization_id = o.id and lower(x.code::text) = 'co') then 'COFF' else 'CO' end,
       'Compensatory Off', 'إجازة تعويضية', true, '#6941c6', 'active', true, 'working', true, true, false, 'COMP_OFF'
from public.organizations o
where not exists (select 1 from public.leave_types x where x.organization_id = o.id and x.system_key = 'COMP_OFF')
on conflict do nothing;

-- Safety net: every public table keeps RLS on.
do $$
declare t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname in ('leave_allocations', 'leave_request_comments', 'comp_off_credits', 'comp_off_usages') and not c.relrowsecurity loop
    execute format('alter table public.%I enable row level security', t.relname);
  end loop;
end $$;

-- Post-verify: fail the migration rather than leave half a state.
do $$
declare v_missing text;
begin
  select string_agg(c, ', ') into v_missing from unnest(array['requires_approval', 'count_mode', 'max_consecutive_days', 'advance_notice_days', 'applicable_gender', 'accrual', 'carry_forward_max_days', 'carry_forward_expiry_months', 'is_special', 'allow_half_day', 'portal_visible', 'system_key']) c
  where not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'leave_types' and column_name = c);
  if v_missing is not null then raise exception 'leave_types columns missing: %', v_missing; end if;
  select string_agg(c, ', ') into v_missing from unnest(array['days', 'withdrawn_at', 'edited_at']) c
  where not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'leave_records' and column_name = c);
  if v_missing is not null then raise exception 'leave_records columns missing: %', v_missing; end if;
  if not exists (select 1 from pg_constraint where conname = 'leave_records_no_overlap' and contype = 'x') then raise exception 'leave_records_no_overlap missing'; end if;
  select string_agg(t, ', ') into v_missing from unnest(array['leave_allocations', 'leave_request_comments', 'comp_off_credits', 'comp_off_usages']) t
  where not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = t and c.relrowsecurity);
  if v_missing is not null then raise exception 'tables missing or without RLS: %', v_missing; end if;
  select string_agg(p, ', ') into v_missing from unnest(array['leave_allocations_select', 'leave_allocations_insert', 'leave_request_comments_select', 'leave_request_comments_insert', 'comp_off_credits_select', 'comp_off_credits_self_request', 'comp_off_usages_select', 'comp_off_usages_system_write', 'leave_records_self_update']) p
  where not exists (select 1 from pg_policies where schemaname = 'public' and policyname = p);
  if v_missing is not null then raise exception 'policies missing: %', v_missing; end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'leave_request_comments' and cmd in ('UPDATE', 'DELETE', 'ALL') and 'authenticated' = any (roles)) then
    raise exception 'leave_request_comments must not be updatable or deletable by clients';
  end if;
  if exists (select 1 from public.organizations o where not exists (select 1 from public.leave_types t where t.organization_id = o.id and t.system_key = 'COMP_OFF')) then
    raise exception 'an organisation has no comp-off leave type';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organization_settings' and column_name = 'leave') then
    raise exception 'organization_settings.leave missing';
  end if;
end $$;
