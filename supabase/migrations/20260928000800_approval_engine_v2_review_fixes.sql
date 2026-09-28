-- Approval engine v2 — fixes of the adversarial review (docs/hr-portal/reviews/02-approval-engine-v2-review.md).
--
-- 1. Organisation dates. `app.org_date_at(org, instant)` / `app.org_today(org)`: THE definition of "today" for delegation
--    windows — the organisation's local date (organizations.timezone). RLS, the inbox / "mine" queries, the actionable
--    counts and the engine all use it (review P2-1: RLS and the inbox used the database's UTC date while the engine used
--    the organisation's, so a delegate could see an item they could not decide, or decide one they could not see).
-- 2. Read rules (review P0-2 + P1-5). Every read branch of approval_requests — organisation-wide key, requester, subject,
--    team, assignee / delegate — is ANDed with the caller's CURRENT memberships (`app.member_org_ids()`: active
--    memberships, the org's system context, a live platform grant). A suspended or removed member, an ex-requester or a
--    suspended delegator reads nothing. The assignee branch is `app.approval_request_assigned(id, org, type)`: a per-row
--    boolean over indexed columns (a seat on any level, a v1 level naming the caller, or the pending seat of somebody who
--    delegates to the caller today) for an active member of THAT organisation — no array of every historical assignment
--    across every tenant. Steps, actors, events and delegations get the same membership AND (organisation-leading
--    indexes added so a read never scans another tenant).
-- 3. `approval_step_actors.on_behalf_of_user_id`: the seat an organisation-wide approver's override or an escalated
--    approver decided FOR — a decision fills exactly one pending seat (review P0-1 / P2-13, Finance B-91 "one row per
--    call"); the engine evaluates the level by its mode instead of settling it outright.
-- 4. Self-approval is not configurable (review P0-3): every workflow's `allow_self_approval` is cleared (the change is
--    audited) and a CHECK keeps it false. The column stays (additive).
-- 5. `applies_to` is canonical (review P2-8): sorted, de-duplicated, lower-cased id arrays, empty lists dropped — on write
--    (trigger) and in the uniqueness index expression, so reordered or repeated ids can no longer create a second active
--    default workflow. Existing rows are canonicalised; active defaults that turn out to be duplicates once canonical are
--    deactivated (the oldest stays), each with an audit row.
-- 6. Closed requests keep no PENDING level (review P2-10): v1 requests closed before the engine migration kept PENDING
--    steps / actors (and the v2 migration stamped `activated_at` on levels they never reached); they become SKIPPED, the
--    never-reached levels lose the invented activation time, and the timeline is untouched.
-- 7. "Actionable" (review P2-11 / P1-6): `app.approval_actionable_request_ids(org)` — the caller's pending seats on the
--    current level (their own seat, a stamped delegate seat whose delegation is still in force, an escalation seat, or the
--    pending seat of somebody who delegates to them today) — is the ONE definition behind the inbox's "Mine" queue, the
--    dashboard's pending count and /me's `approvals.actionable`; `app.approval_inbox_summary()` gives /me every
--    membership's count and whether a delegation to the caller is in force today, in one indexed query.
-- 8. `app.approval_delegate_of(org, delegator, type)`: the colleague a delegator's work goes to today — the same rule as the
--    engine's delegation map (type-specific beats blanket, newest wins, the delegator is still an active member).
--
-- Additive and idempotent (every object is created if missing or replaced); runs in one transaction; bounded lock waits.
-- Never edits 20260928000200.
set lock_timeout = '5s';
set statement_timeout = '120s';
set client_min_messages = warning;

-- 1. Organisation dates ---------------------------------------------------------------------------------------------------
create or replace function app.org_date_at(p_org uuid, p_at timestamptz) returns date
language sql stable security definer set search_path = ''
as $$
  select (p_at at time zone coalesce((select o.timezone from public.organizations o where o.id = p_org), 'UTC'))::date
$$;
comment on function app.org_date_at(uuid, timestamptz) is 'The organisation''s local calendar date at an instant (organizations.timezone; UTC when unknown).';
create or replace function app.org_today(p_org uuid) returns date
language sql stable security definer set search_path = ''
as $$
  select app.org_date_at(p_org, now())
$$;
comment on function app.org_today(uuid) is 'Today in the organisation''s timezone — the one definition of "today" for approval delegation windows (RLS, inbox, engine).';
grant execute on function app.org_date_at(uuid, timestamptz), app.org_today(uuid) to authenticated, flowza_system, flowza_api, flowza_worker;

-- 2. Delegation, assignment and actionable helpers --------------------------------------------------------------------------
create index if not exists approval_delegations_delegate_window_idx on public.approval_delegations (delegate_user_id, organization_id, starts_on, ends_on) where is_active;

-- The delegate of `p_delegator` for `p_entity_type` today (organisation date): a type-specific delegation beats a blanket
-- one, the newest wins; nobody when the delegator is no longer an active member of the organisation.
create or replace function app.approval_delegate_of(p_org uuid, p_delegator uuid, p_entity_type public.approval_entity) returns uuid
language sql stable security definer set search_path = ''
as $$
  select d.delegate_user_id
  from public.approval_delegations d
  where d.organization_id = p_org and d.delegator_user_id = p_delegator and d.is_active
    and app.org_today(p_org) between d.starts_on and d.ends_on
    and (d.entity_types is null or p_entity_type = any (d.entity_types))
    and exists (select 1 from public.org_memberships dm where dm.organization_id = p_org and dm.user_id = p_delegator and dm.status = 'active')
  order by (d.entity_types is not null) desc, d.created_at desc, d.id
  limit 1
$$;

-- Is the caller assigned to the request (a seat or decision on any level, a v1 level naming them, or today the pending seat
-- of somebody who delegates to them)? Only for an ACTIVE member of the request's organisation. Evaluated per row by the
-- approval_requests read rule, so every lookup is on an indexed column of THIS request; plpgsql so the plans are cached.
create or replace function app.approval_request_assigned(p_request_id uuid, p_org_id uuid, p_entity_type public.approval_entity) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := app.uid();
begin
  if v_uid is null or p_request_id is null or p_org_id is null then
    return false;
  end if;
  if not exists (select 1 from public.org_memberships m where m.organization_id = p_org_id and m.user_id = v_uid and m.status = 'active') then
    return false;
  end if;
  if exists (select 1 from public.approval_steps s join public.approval_step_actors a on a.step_id = s.id
             where s.request_id = p_request_id and a.user_id = v_uid) then
    return true;
  end if;
  if exists (select 1 from public.approval_steps s where s.request_id = p_request_id and s.approver_user_id = v_uid) then
    return true;
  end if;
  -- delegations: only look at the request's pending seats when a delegation to the caller is in force today at all
  if exists (select 1 from public.approval_delegations d
             where d.delegate_user_id = v_uid and d.organization_id = p_org_id and d.is_active
               and app.org_today(p_org_id) between d.starts_on and d.ends_on) then
    return exists (select 1 from public.approval_steps s join public.approval_step_actors a on a.step_id = s.id
                   where s.request_id = p_request_id and a.decision = 'PENDING'
                     and app.approval_delegate_of(p_org_id, a.user_id, p_entity_type) = v_uid);
  end if;
  return false;
end $$;
comment on function app.approval_request_assigned(uuid, uuid, public.approval_entity) is 'Approval read rule, assignee branch: the caller (an active member of the organisation) holds or held a seat on the request, or covers a pending seat through a delegation in force today (organisation date).';

-- Requests of `p_org` waiting for the caller on their CURRENT level: their own pending seat (a stamped delegate seat only
-- while that delegation is still in force; an escalation seat included), or the pending seat of somebody who delegates to
-- them today. Nothing for a non-member. Driven by the caller's own pending actor rows (indexed), never by the tenant size.
create or replace function app.approval_actionable_request_ids(p_org uuid) returns setof uuid
language sql stable security definer set search_path = ''
as $$
  with me as (
    select app.uid() as uid
    where exists (select 1 from public.org_memberships m where m.organization_id = p_org and m.user_id = app.uid() and m.status = 'active')
  )
  select s.request_id
  from me
  join public.approval_step_actors a on a.user_id = me.uid and a.organization_id = p_org and a.decision = 'PENDING'
  join public.approval_steps s on s.id = a.step_id and s.status = 'PENDING'
  join public.approval_requests r on r.id = s.request_id and r.status = 'PENDING' and r.current_step = s.step_no
  where a.via_delegation_of is null or app.approval_delegate_of(p_org, a.via_delegation_of, r.entity_type) = me.uid
  union
  select s.request_id
  from me
  join public.approval_delegations d on d.delegate_user_id = me.uid and d.organization_id = p_org and d.is_active
  join public.approval_step_actors a on a.organization_id = p_org and a.user_id = d.delegator_user_id and a.decision = 'PENDING'
  join public.approval_steps s on s.id = a.step_id and s.status = 'PENDING'
  join public.approval_requests r on r.id = s.request_id and r.status = 'PENDING' and r.current_step = s.step_no
  where app.org_today(p_org) between d.starts_on and d.ends_on
    and app.approval_delegate_of(p_org, a.user_id, r.entity_type) = me.uid
$$;
comment on function app.approval_actionable_request_ids(uuid) is 'The requests of an organisation waiting for the caller on their current level — the inbox "Mine" queue, the dashboard count and /me approvals.actionable.';

-- /me: per active membership of the caller, how many requests wait for them and whether a delegation to them is in force today.
create or replace function app.approval_inbox_summary() returns table (organization_id uuid, actionable integer, delegated_to_me boolean)
language sql stable security definer set search_path = ''
as $$
  select m.organization_id,
         (select count(*)::integer from app.approval_actionable_request_ids(m.organization_id)) as actionable,
         exists (select 1 from public.approval_delegations d
                 where d.delegate_user_id = m.user_id and d.organization_id = m.organization_id and d.is_active
                   and app.org_today(m.organization_id) between d.starts_on and d.ends_on
                   and exists (select 1 from public.org_memberships dm where dm.organization_id = d.organization_id and dm.user_id = d.delegator_user_id and dm.status = 'active')) as delegated_to_me
  from public.org_memberships m
  where m.user_id = app.uid() and m.status = 'active'
$$;
comment on function app.approval_inbox_summary() is 'Per active membership of the caller: actionable approvals (app.approval_actionable_request_ids) and whether a delegation to the caller is in force today.';

-- The v1-era helper is no longer used by any policy; kept (additive) but scoped to ACTIVE memberships and indexed branches.
create or replace function app.approval_assigned_request_ids() returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(distinct x.request_id), '{}'::uuid[])
  from (
    select s.request_id
    from public.approval_step_actors a
    join public.approval_steps s on s.id = a.step_id
    join public.org_memberships m on m.organization_id = a.organization_id and m.user_id = a.user_id and m.status = 'active'
    where a.user_id = app.uid()
    union all
    select s.request_id
    from public.approval_steps s
    join public.org_memberships m on m.organization_id = s.organization_id and m.user_id = s.approver_user_id and m.status = 'active'
    where s.approver_user_id = app.uid()
    union all
    select s.request_id
    from public.approval_delegations d
    join public.org_memberships m on m.organization_id = d.organization_id and m.user_id = d.delegate_user_id and m.status = 'active'
    join public.approval_step_actors a on a.organization_id = d.organization_id and a.user_id = d.delegator_user_id and a.decision = 'PENDING'
    join public.approval_steps s on s.id = a.step_id
    join public.approval_requests r on r.id = s.request_id
    where d.delegate_user_id = app.uid() and d.is_active and app.org_today(d.organization_id) between d.starts_on and d.ends_on
      and app.approval_delegate_of(d.organization_id, a.user_id, r.entity_type) = app.uid()
  ) x
$$;

grant execute on function app.approval_delegate_of(uuid, uuid, public.approval_entity), app.approval_request_assigned(uuid, uuid, public.approval_entity),
  app.approval_actionable_request_ids(uuid), app.approval_inbox_summary(), app.approval_assigned_request_ids() to authenticated, flowza_system, flowza_api, flowza_worker;

-- 3. The seat an override / escalated decision fills ------------------------------------------------------------------------
alter table public.approval_step_actors add column if not exists on_behalf_of_user_id uuid references public.user_profiles(id) on delete set null;
comment on column public.approval_step_actors.on_behalf_of_user_id is 'The seat an organisation-wide approver''s override or an escalated approver decided for: one decision fills one pending seat (Finance B-91).';

-- indexes for the read rules and the actionable queries (organisation-leading where a tenant is scanned)
create index if not exists approval_step_actors_user_step_idx on public.approval_step_actors (user_id, step_id);
create index if not exists approval_steps_org_request_idx on public.approval_steps (organization_id, request_id);
create index if not exists approval_request_events_org_request_idx on public.approval_request_events (organization_id, request_id);

-- 4. Read rules (RLS) -------------------------------------------------------------------------------------------------------
drop policy if exists approval_requests_select on public.approval_requests;
create policy approval_requests_select on public.approval_requests for select to authenticated, flowza_system using (
  organization_id = any ((select app.member_org_ids())::uuid[])
  and (
    (organization_id = any ((select app.org_ids_with_any_permission(array['attendance.view', 'leave.view', 'approval.manage']))::uuid[])
      and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or branch_id is null or branch_id = any ((select app.allowed_branch_ids())::uuid[])))
    or requested_by = (select app.uid())
    or employee_id = any ((select app.own_employee_ids())::uuid[])
    or (organization_id = any ((select app.org_ids_with_any_permission(array['attendance.view_team', 'leave.view_team']))::uuid[])
        and employee_id = any ((select app.team_employee_ids())::uuid[]))
    or app.approval_request_assigned(id, organization_id, entity_type)
  )
);

drop policy if exists approval_steps_select on public.approval_steps;
create policy approval_steps_select on public.approval_steps for select to authenticated, flowza_system using (
  organization_id = any ((select app.member_org_ids())::uuid[])
  and exists (select 1 from public.approval_requests r where r.id = approval_steps.request_id)
);

drop policy if exists approval_step_actors_select on public.approval_step_actors;
create policy approval_step_actors_select on public.approval_step_actors for select to authenticated, flowza_system using (
  organization_id = any ((select app.member_org_ids())::uuid[])
  and exists (select 1 from public.approval_steps s where s.id = approval_step_actors.step_id)
);

drop policy if exists approval_request_events_select on public.approval_request_events;
create policy approval_request_events_select on public.approval_request_events for select to authenticated, flowza_system using (
  organization_id = any ((select app.member_org_ids())::uuid[])
  and exists (select 1 from public.approval_requests r where r.id = approval_request_events.request_id)
);

drop policy if exists approval_delegations_select on public.approval_delegations;
create policy approval_delegations_select on public.approval_delegations for select to authenticated, flowza_system using (
  organization_id = any ((select app.member_org_ids())::uuid[])
  and (delegator_user_id = (select app.uid()) or delegate_user_id = (select app.uid())
       or organization_id = any ((select app.org_ids_with_permission('approval.manage'))::uuid[]))
);

-- 5. Self-approval is not configurable --------------------------------------------------------------------------------------
with cleared as (
  update public.approval_workflows w set allow_self_approval = false where w.allow_self_approval
  returning w.id, w.organization_id, w.branch_id, w.name
)
insert into audit.logs (organization_id, actor_type, actor_label, action, entity_type, entity_id, branch_id, old_value, new_value, reason)
select c.organization_id, 'SYSTEM', 'migration 20260928000800', 'approval_workflow.self_approval_removed', 'approval_workflow', c.id::text, c.branch_id,
       jsonb_build_object('allowSelfApproval', true, 'name', c.name), jsonb_build_object('allowSelfApproval', false),
       'Self-approval is no longer configurable: the person a request is about never decides it (the organisation owner excepted, logged).'
from cleared c;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'approval_workflows_no_self_approval') then
    alter table public.approval_workflows add constraint approval_workflows_no_self_approval check (allow_self_approval = false);
  end if;
end $$;

-- 6. Canonical applies_to ---------------------------------------------------------------------------------------------------
create or replace function app.approval_applies_to_canonical(p jsonb) returns jsonb
language sql immutable set search_path = ''
as $$
  select coalesce(
    (select jsonb_object_agg(k.key, (select jsonb_agg(v.id order by v.id collate "C") from (select distinct lower(e) as id from jsonb_array_elements_text(p -> k.key) e) v))
     from unnest(array['branchIds', 'departmentIds']) as k(key)
     where jsonb_typeof(p -> k.key) = 'array' and jsonb_array_length(p -> k.key) > 0),
    '{}'::jsonb)
$$;
comment on function app.approval_applies_to_canonical(jsonb) is 'Canonical approval workflow applies_to: {branchIds?, departmentIds?} as sorted, distinct, lower-cased ids; empty lists dropped.';

create or replace function app.approval_workflows_canonical_applies_to() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.applies_to := app.approval_applies_to_canonical(new.applies_to);
  return new;
end $$;
drop trigger if exists approval_workflows_canonical_applies_to on public.approval_workflows;
create trigger approval_workflows_canonical_applies_to before insert or update of applies_to on public.approval_workflows
  for each row execute function app.approval_workflows_canonical_applies_to();

-- active defaults that are the same workflow once canonical: keep the oldest, deactivate the newer ones (audited)
with ranked as (
  select w.id,
         row_number() over (partition by w.organization_id, w.entity_type, coalesce(w.branch_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(w.min_units, -1), app.approval_applies_to_canonical(w.applies_to)
                            order by w.created_at, w.id) as rn,
         first_value(w.id) over (partition by w.organization_id, w.entity_type, coalesce(w.branch_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(w.min_units, -1), app.approval_applies_to_canonical(w.applies_to)
                                 order by w.created_at, w.id) as kept_id
  from public.approval_workflows w
  where w.is_default and w.status = 'active'
), deactivated as (
  update public.approval_workflows w set status = 'inactive'
  from ranked r where r.id = w.id and r.rn > 1
  returning w.id, w.organization_id, w.branch_id, w.name, r.kept_id
)
insert into audit.logs (organization_id, actor_type, actor_label, action, entity_type, entity_id, branch_id, old_value, new_value, reason)
select d.organization_id, 'SYSTEM', 'migration 20260928000800', 'approval_workflow.duplicate_deactivated', 'approval_workflow', d.id::text, d.branch_id,
       jsonb_build_object('status', 'active', 'name', d.name), jsonb_build_object('status', 'inactive', 'duplicateOf', d.kept_id),
       'Duplicate of an older active default workflow once appliesTo is canonical (same organisation, request type, branch, tier and applies-to).'
from deactivated d;

update public.approval_workflows w set applies_to = app.approval_applies_to_canonical(w.applies_to)
where w.applies_to is distinct from app.approval_applies_to_canonical(w.applies_to);

create unique index if not exists approval_workflows_default_v3_idx on public.approval_workflows
  (organization_id, entity_type, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(min_units, -1), md5(app.approval_applies_to_canonical(applies_to)::text))
  where is_default and status = 'active';
-- the text-keyed index of 20260928000200 is superseded by the canonical one (it let [A,B] and [B,A] coexist)
drop index if exists public.approval_workflows_default_v2_idx;

-- 7. Closed requests keep no PENDING level ----------------------------------------------------------------------------------
update public.approval_step_actors a set decision = 'SKIPPED'
from public.approval_steps s, public.approval_requests r
where a.step_id = s.id and r.id = s.request_id and r.status <> 'PENDING' and a.decision = 'PENDING';
update public.approval_steps s
set status = 'SKIPPED', activated_at = case when s.step_no > r.current_step then null else s.activated_at end
from public.approval_requests r
where r.id = s.request_id and r.status <> 'PENDING' and s.status = 'PENDING';

-- 8. Post-verify --------------------------------------------------------------------------------------------------------------
do $$
declare v_count int;
begin
  -- every read rule of the approval family is scoped to the caller's current memberships
  select count(*) into v_count from pg_policies
  where schemaname = 'public' and cmd = 'SELECT' and 'authenticated' = any (roles)
    and tablename in ('approval_requests', 'approval_steps', 'approval_step_actors', 'approval_request_events', 'approval_delegations')
    and qual like '%member_org_ids%';
  if v_count <> 5 then raise exception 'approval read rules: % of 5 carry the membership predicate', v_count; end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename like 'approval%' and (qual like '%approval_assigned_request_ids%' or coalesce(with_check, '') like '%approval_assigned_request_ids%')) then
    raise exception 'an approval policy still builds the array of every assignment';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'approval_requests' and policyname = 'approval_requests_select'
                 and qual like '%approval_request_assigned%' and qual like '%team_employee_ids%' and qual like '%own_employee_ids%' and qual like '%requested_by%') then
    raise exception 'approval_requests read rule lost a branch';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('approval_requests', 'approval_steps', 'approval_step_actors', 'approval_request_events', 'approval_delegations')
             and 'authenticated' = any (roles) and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')) then
    raise exception 'the approval family must not be client-writable';
  end if;
  -- self-approval
  if not exists (select 1 from pg_constraint where conname = 'approval_workflows_no_self_approval') then raise exception 'self-approval CHECK missing'; end if;
  if exists (select 1 from public.approval_workflows where allow_self_approval) then raise exception 'a workflow still allows self-approval'; end if;
  -- canonical applies_to
  if exists (select 1 from public.approval_workflows where applies_to is distinct from app.approval_applies_to_canonical(applies_to)) then raise exception 'a workflow applies_to is not canonical'; end if;
  if app.approval_applies_to_canonical('{"branchIds":["B","a","B"],"departmentIds":[]}'::jsonb) <> '{"branchIds":["a","b"]}'::jsonb then raise exception 'applies_to canonicalisation is wrong'; end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'approval_workflows_default_v3_idx' and indexdef like '%approval_applies_to_canonical%') then raise exception 'canonical default index missing'; end if;
  if exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'approval_workflows_default_v2_idx') then raise exception 'the text-keyed default index survived'; end if;
  -- closed requests
  if exists (select 1 from public.approval_steps s join public.approval_requests r on r.id = s.request_id where r.status <> 'PENDING' and s.status = 'PENDING') then
    raise exception 'a closed request still has a PENDING level';
  end if;
  if exists (select 1 from public.approval_step_actors a join public.approval_steps s on s.id = a.step_id join public.approval_requests r on r.id = s.request_id where r.status <> 'PENDING' and a.decision = 'PENDING') then
    raise exception 'a closed request still has a PENDING approver';
  end if;
  -- the seat column and the helpers
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'approval_step_actors' and column_name = 'on_behalf_of_user_id') then
    raise exception 'approval_step_actors.on_behalf_of_user_id missing';
  end if;
  if app.org_date_at('00000000-0000-0000-0000-000000000000'::uuid, '2026-09-27 23:30+00'::timestamptz) <> date '2026-09-27' then raise exception 'org_date_at fallback is not UTC'; end if;
  select count(*) into v_count from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'app' and p.proname in ('org_today', 'org_date_at', 'approval_delegate_of', 'approval_request_assigned', 'approval_actionable_request_ids', 'approval_inbox_summary') and p.prosecdef;
  if v_count <> 6 then raise exception 'approval helpers missing or not security definer (%/6)', v_count; end if;
  -- indexes the read rules rely on
  select count(*) into v_count from pg_indexes where schemaname = 'public'
    and indexname in ('approval_step_actors_user_step_idx', 'approval_steps_org_request_idx', 'approval_request_events_org_request_idx', 'approval_delegations_delegate_window_idx');
  if v_count <> 4 then raise exception 'approval read-rule indexes missing (%/4)', v_count; end if;
end $$;
