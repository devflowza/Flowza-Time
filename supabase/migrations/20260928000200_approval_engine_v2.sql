-- Approval engine v2 — multilevel approvals with Finance parity (HR portal Prompt 2).
--
-- 1. Enums. `approver_type` gains SECONDARY_MANAGER, MANAGER_CHAIN, HR_ADMIN, DEPARTMENT_HEAD, BRANCH_MANAGER;
--    `approval_entity` gains ATTENDANCE_NOTE, SHIFT_SWAP, COMP_OFF, REGULARISATION, OVERTIME_CLAIM; `approval_status`
--    gains INVALIDATED (a request voided by a material edit of its document) and SKIPPED (a step / actor that never
--    got to decide because the level was already satisfied, rejected, cancelled or reassigned).
--    `alter type … add value` is allowed inside the runner's per-file transaction as long as the new label is not USED
--    in the same transaction (20260905002200 precedent): nothing below references a new label as a value — the CHECK
--    on the step shape compares text, and the post-verify reads pg_enum.
-- 2. Workflows keep `steps jsonb`; the step shape becomes
--      { order, approverType, roleId?, userId?, permission?, chainLevel?, mode: 'ANY'|'ALL'|'QUORUM', requiredCount?,
--        escalateAfterHours?, escalateTo?: 'NEXT_STEP'|'HR_ADMIN'|'OWNER' }
--    validated by the immutable `app.approval_steps_valid(jsonb)` (the structural minimum; `approvalWorkflowStepSchema`
--    in @flowza/contracts is the source of truth). Existing rows are normalised in place (legacy snake_case keys of the
--    first seeds, `mode: 'ANY'` where absent) BEFORE the CHECK is added. New columns: `applies_to` ({branchIds?,
--    departmentIds?}), `min_units` (tiers: a workflow applies when the request's units — leave days, overtime minutes —
--    reach it; the highest applicable minimum wins) and `allow_self_approval` (off by default).
-- 3. `approval_requests` carries the request's units / department / subject login snapshot, cancellation and
--    invalidation reasons and the "waiting for the requester's answer" marker; one PENDING request per document (older
--    duplicates are cancelled first so the partial unique index can be created on any tenant).
-- 4. `approval_steps` gains the per-level mode + quorum snapshot, the resolution trail (path/reason), the escalation
--    snapshot (due_at, escalate_to, escalated_at), the reminder stamp and the permission a ROLE step was resolved by.
--    Several eligible approvers per level live in `approval_step_actors` (one row per person, `via_delegation_of` for a
--    delegate acting for an absent or delegating approver). `approval_delegations` routes an approver's work to a
--    colleague for a date window; `approval_request_events` is the append-only timeline; `approval_email_tokens` holds
--    only the sha256 of one-click e-mail tokens; `approval_digest_runs` records the daily digest per organisation.
-- 5. RLS. Reads of requests / steps / actors / events follow ONE rule, on approval_requests: an organisation-wide key
--    (attendance.view, leave.view, approval.manage — branch scope applies) OR the assignee (a step or actor row for the
--    caller, or an active delegation from one) OR the subject (own employee record) OR the requester OR the team
--    (direct report + a team key). Steps, actors and events are readable exactly where their request is. Writes stay
--    system-context only: the API decides in a system step after its own checks (as before). Workflows are written by
--    approval.manage OR organization.manage holders. `leave_records.approval_request_id` links leave to its request.
--
-- Additive, idempotent, no destructive statement. Bounded lock waits (hot tables: leave_records, approval_*).
set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

-- 1. Enums ----------------------------------------------------------------------------------------------------------------
alter type public.approver_type add value if not exists 'SECONDARY_MANAGER';
alter type public.approver_type add value if not exists 'MANAGER_CHAIN';
alter type public.approver_type add value if not exists 'HR_ADMIN';
alter type public.approver_type add value if not exists 'DEPARTMENT_HEAD';
alter type public.approver_type add value if not exists 'BRANCH_MANAGER';
alter type public.approval_entity add value if not exists 'ATTENDANCE_NOTE';
alter type public.approval_entity add value if not exists 'SHIFT_SWAP';
alter type public.approval_entity add value if not exists 'COMP_OFF';
alter type public.approval_entity add value if not exists 'REGULARISATION';
alter type public.approval_entity add value if not exists 'OVERTIME_CLAIM';
alter type public.approval_status add value if not exists 'INVALIDATED';
alter type public.approval_status add value if not exists 'SKIPPED';

-- 2. Workflow step shape --------------------------------------------------------------------------------------------------
-- Structural minimum of `approvalWorkflowStepSchema` (@flowza/contracts): 1..5 objects; a known approverType; a known
-- mode (absent = ANY); QUORUM needs requiredCount ≥ 1; ROLE needs roleId or permission; USER needs userId; chainLevel,
-- order and escalateAfterHours are numbers; escalateTo is a known target. Anything else is the API's business.
create or replace function app.approval_steps_valid(p_steps jsonb) returns boolean
language plpgsql immutable set search_path = ''
as $$
declare
  s jsonb;
  v_type text;
  v_mode text;
begin
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' then return false; end if;
  if jsonb_array_length(p_steps) < 1 or jsonb_array_length(p_steps) > 5 then return false; end if;
  for s in select value from jsonb_array_elements(p_steps) loop
    if jsonb_typeof(s) <> 'object' then return false; end if;
    v_type := s ->> 'approverType';
    if v_type is null or v_type not in ('MANAGER', 'SECONDARY_MANAGER', 'MANAGER_CHAIN', 'HR_ADMIN', 'DEPARTMENT_HEAD', 'BRANCH_MANAGER', 'ROLE', 'USER') then return false; end if;
    v_mode := coalesce(s ->> 'mode', 'ANY');
    if v_mode not in ('ANY', 'ALL', 'QUORUM') then return false; end if;
    if v_mode = 'QUORUM' and (coalesce(jsonb_typeof(s -> 'requiredCount'), 'missing') <> 'number' or (s ->> 'requiredCount')::numeric < 1) then return false; end if;
    if v_type = 'ROLE' and coalesce(s ->> 'roleId', '') = '' and coalesce(s ->> 'permission', '') = '' then return false; end if;
    if v_type = 'USER' and coalesce(s ->> 'userId', '') = '' then return false; end if;
    if s ? 'order' and coalesce(jsonb_typeof(s -> 'order'), 'missing') <> 'number' then return false; end if;
    if s ? 'chainLevel' and (coalesce(jsonb_typeof(s -> 'chainLevel'), 'missing') <> 'number' or (s ->> 'chainLevel')::numeric < 1 or (s ->> 'chainLevel')::numeric > 10) then return false; end if;
    if s ? 'escalateAfterHours' and (coalesce(jsonb_typeof(s -> 'escalateAfterHours'), 'missing') <> 'number' or (s ->> 'escalateAfterHours')::numeric < 1) then return false; end if;
    if s ? 'escalateTo' and coalesce(s ->> 'escalateTo', '') not in ('NEXT_STEP', 'HR_ADMIN', 'OWNER') then return false; end if;
  end loop;
  return true;
exception when others then
  return false;
end $$;

alter table public.approval_workflows add column if not exists applies_to jsonb not null default '{}'::jsonb;
alter table public.approval_workflows add column if not exists min_units numeric;
alter table public.approval_workflows add column if not exists allow_self_approval boolean not null default false;

-- Normalise every existing row once: legacy snake_case keys (the first TypeScript seed wrote approver_type / role_id),
-- an explicit order, and `mode: 'ANY'` where a step has none. Idempotent: a normalised row matches none of the predicates.
update public.approval_workflows w
set steps = (
  select jsonb_agg(
    jsonb_strip_nulls(jsonb_build_object(
      'order', coalesce(case when jsonb_typeof(e.s -> 'order') = 'number' then (e.s ->> 'order')::int end, e.ord::int),
      'approverType', coalesce(e.s ->> 'approverType', e.s ->> 'approver_type', 'ROLE'),
      'roleId', coalesce(e.s ->> 'roleId', e.s ->> 'role_id'),
      'userId', coalesce(e.s ->> 'userId', e.s ->> 'user_id'),
      'permission', e.s ->> 'permission',
      'chainLevel', e.s -> 'chainLevel',
      'mode', coalesce(e.s ->> 'mode', 'ANY'),
      'requiredCount', e.s -> 'requiredCount',
      'escalateAfterHours', e.s -> 'escalateAfterHours',
      'escalateTo', e.s ->> 'escalateTo'
    )) order by e.ord)
  from jsonb_array_elements(w.steps) with ordinality as e(s, ord))
where jsonb_typeof(w.steps) = 'array'
  and exists (select 1 from jsonb_array_elements(w.steps) x where not (x ? 'mode') or x ? 'approver_type' or x ? 'role_id' or x ? 'user_id' or not (x ? 'order'));

-- Tiers need several default workflows per entity type and scope (one per threshold): the single-default index of
-- 20260905001100 gives way to one keyed on the threshold and the applies-to narrowing (identical duplicates stay refused).
drop index if exists public.approval_workflows_default_idx;
create unique index if not exists approval_workflows_default_v2_idx on public.approval_workflows
  (organization_id, entity_type, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(min_units, -1), md5(applies_to::text))
  where is_default and status = 'active';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'approval_workflows_steps_valid') then
    alter table public.approval_workflows add constraint approval_workflows_steps_valid check (app.approval_steps_valid(steps));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'approval_workflows_applies_to_object') then
    alter table public.approval_workflows add constraint approval_workflows_applies_to_object check (jsonb_typeof(applies_to) = 'object');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'approval_workflows_min_units_nonneg') then
    alter table public.approval_workflows add constraint approval_workflows_min_units_nonneg check (min_units is null or min_units >= 0);
  end if;
end $$;

-- 3. Requests ---------------------------------------------------------------------------------------------------------------
alter table public.approval_requests add column if not exists units numeric;
alter table public.approval_requests add column if not exists department_id uuid;
alter table public.approval_requests add column if not exists subject_user_id uuid references public.user_profiles(id) on delete set null;
alter table public.approval_requests add column if not exists decided_by uuid references public.user_profiles(id) on delete set null;
alter table public.approval_requests add column if not exists cancelled_by uuid references public.user_profiles(id) on delete set null;
alter table public.approval_requests add column if not exists cancel_reason text;
alter table public.approval_requests add column if not exists invalidation_reason text;
alter table public.approval_requests add column if not exists info_requested_at timestamptz;

-- one pending request per document (Finance parity): retire older duplicates, then enforce
update public.approval_requests r
set status = 'CANCELLED', completed_at = coalesce(r.completed_at, now()), cancel_reason = coalesce(r.cancel_reason, 'superseded by a newer request (approval engine v2 migration)')
where r.status = 'PENDING'
  and exists (select 1 from public.approval_requests n where n.organization_id = r.organization_id and n.entity_type = r.entity_type and n.entity_id = r.entity_id
              and n.status = 'PENDING' and (n.created_at > r.created_at or (n.created_at = r.created_at and n.id > r.id)));
create unique index if not exists approval_requests_pending_unique_idx on public.approval_requests (organization_id, entity_type, entity_id) where status = 'PENDING';
create index if not exists approval_requests_org_entity_idx on public.approval_requests (organization_id, entity_type, entity_id);
create index if not exists approval_requests_org_employee_idx on public.approval_requests (organization_id, employee_id) where employee_id is not null;
create index if not exists approval_requests_requested_by_idx on public.approval_requests (requested_by, created_at desc) where requested_by is not null;

-- 4. Steps, actors, delegations, events, tokens, digest runs ---------------------------------------------------------------
alter table public.approval_steps add column if not exists mode text not null default 'ANY';
alter table public.approval_steps add column if not exists required_count int;
alter table public.approval_steps add column if not exists resolution_path text;
alter table public.approval_steps add column if not exists resolution_reason text;
alter table public.approval_steps add column if not exists delegated_from_user_id uuid references public.user_profiles(id) on delete set null;
alter table public.approval_steps add column if not exists due_at timestamptz;
alter table public.approval_steps add column if not exists escalated_at timestamptz;
alter table public.approval_steps add column if not exists reminded_at timestamptz;
alter table public.approval_steps add column if not exists permission_key text;
alter table public.approval_steps add column if not exists escalate_to text;
alter table public.approval_steps add column if not exists escalate_after_hours int;
alter table public.approval_steps add column if not exists activated_at timestamptz;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'approval_steps_mode_check') then
    alter table public.approval_steps add constraint approval_steps_mode_check check (mode in ('ANY', 'ALL', 'QUORUM'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'approval_steps_required_count_check') then
    alter table public.approval_steps add constraint approval_steps_required_count_check check (required_count is null or required_count >= 1);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'approval_steps_escalate_to_check') then
    alter table public.approval_steps add constraint approval_steps_escalate_to_check check (escalate_to is null or escalate_to in ('NEXT_STEP', 'HR_ADMIN', 'OWNER'));
  end if;
end $$;
-- open steps of requests created before this release: the reminder clock starts at the request's creation
update public.approval_steps s set activated_at = r.created_at
from public.approval_requests r
where r.id = s.request_id and s.status = 'PENDING' and s.activated_at is null;
create index if not exists approval_steps_due_idx on public.approval_steps (due_at) where status = 'PENDING' and due_at is not null;
create index if not exists approval_steps_pending_activated_idx on public.approval_steps (activated_at) where status = 'PENDING';

create table if not exists public.approval_step_actors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  step_id uuid not null references public.approval_steps(id) on delete cascade,
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  via_delegation_of uuid references public.user_profiles(id) on delete set null,
  resolution_path text,
  decision public.approval_status not null default 'PENDING',
  decided_at timestamptz,
  comment text,
  created_at timestamptz not null default now(),
  unique (step_id, user_id)
);
create index if not exists approval_step_actors_user_pending_idx on public.approval_step_actors (user_id) where decision = 'PENDING';
create index if not exists approval_step_actors_org_step_idx on public.approval_step_actors (organization_id, step_id);

create table if not exists public.approval_delegations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  delegator_user_id uuid not null references public.user_profiles(id) on delete cascade,
  delegate_user_id uuid not null references public.user_profiles(id) on delete cascade,
  entity_types public.approval_entity[],
  starts_on date not null,
  ends_on date not null,
  is_active boolean not null default true,
  reason text,
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.user_profiles(id) on delete set null,
  constraint approval_delegations_dates check (ends_on >= starts_on),
  constraint approval_delegations_distinct check (delegate_user_id <> delegator_user_id),
  constraint approval_delegations_reason_length check (reason is null or length(reason) <= 500)
);
create index if not exists approval_delegations_org_delegator_idx on public.approval_delegations (organization_id, delegator_user_id) where is_active;
create index if not exists approval_delegations_org_delegate_idx on public.approval_delegations (organization_id, delegate_user_id) where is_active;

create table if not exists public.approval_request_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  request_id uuid not null references public.approval_requests(id) on delete cascade,
  at timestamptz not null default now(),
  actor_user_id uuid references public.user_profiles(id) on delete set null,
  kind text not null check (kind ~ '^[a-z_]+$'),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object')
);
create index if not exists approval_request_events_request_idx on public.approval_request_events (request_id, at, id);
drop trigger if exists approval_request_events_append_only on public.approval_request_events;
create trigger approval_request_events_append_only before update or delete on public.approval_request_events for each row execute function app.reject_modification();

create table if not exists public.approval_email_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  request_id uuid not null references public.approval_requests(id) on delete cascade,
  step_id uuid not null references public.approval_steps(id) on delete cascade,
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  action text not null check (action in ('APPROVE', 'REJECT')),
  token_hash text not null unique check (length(token_hash) = 64),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists approval_email_tokens_open_idx on public.approval_email_tokens (expires_at) where used_at is null;
create index if not exists approval_email_tokens_step_idx on public.approval_email_tokens (step_id, user_id);

create table if not exists public.approval_digest_runs (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  digest_date date not null,
  sent_at timestamptz not null default now(),
  recipients int not null default 0,
  primary key (organization_id, digest_date)
);

-- leave ↔ engine link (Finance parity: every leave request has a request row)
alter table public.leave_records add column if not exists approval_request_id uuid references public.approval_requests(id) on delete set null;
create index if not exists leave_records_approval_request_idx on public.leave_records (approval_request_id) where approval_request_id is not null;

-- 5. RLS --------------------------------------------------------------------------------------------------------------------
-- Requests the caller is assigned to: a step naming them, an actor row for them (a delegate stamped at submit included),
-- or a pending actor row of somebody who delegates to them today (delegations created after the request was routed).
-- SECURITY DEFINER so the requests policy can consult steps/actors without the policies referencing each other.
create or replace function app.approval_assigned_request_ids() returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(distinct s.request_id), '{}'::uuid[])
  from public.approval_steps s
  join public.approval_requests r on r.id = s.request_id
  where s.approver_user_id = app.uid()
     or exists (select 1 from public.approval_step_actors a where a.step_id = s.id and a.user_id = app.uid())
     or exists (select 1 from public.approval_step_actors a
                join public.approval_delegations d on d.organization_id = a.organization_id and d.delegator_user_id = a.user_id
                where a.step_id = s.id and a.decision = 'PENDING' and d.delegate_user_id = app.uid() and d.is_active
                  and current_date between d.starts_on and d.ends_on
                  and (d.entity_types is null or r.entity_type = any (d.entity_types)))
$$;
grant execute on function app.approval_assigned_request_ids() to authenticated, flowza_system, flowza_api, flowza_worker;

-- approval_requests: bespoke read rule (see header), system-only writes, platform scan for the reminder scheduler
drop policy if exists approval_requests_select on public.approval_requests;
drop policy if exists approval_requests_insert on public.approval_requests;
drop policy if exists approval_requests_update on public.approval_requests;
drop policy if exists approval_requests_delete on public.approval_requests;
drop policy if exists approval_requests_system_write on public.approval_requests;
drop policy if exists approval_requests_platform_ctx on public.approval_requests;
alter table public.approval_requests enable row level security;
create policy approval_requests_select on public.approval_requests for select to authenticated, flowza_system using (
  (organization_id = any ((select app.org_ids_with_any_permission(array['attendance.view', 'leave.view', 'approval.manage']))::uuid[])
    and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or branch_id is null or branch_id = any ((select app.allowed_branch_ids())::uuid[])))
  or id = any ((select app.approval_assigned_request_ids())::uuid[])
  or employee_id = any ((select app.own_employee_ids())::uuid[])
  or requested_by = (select app.uid())
  or (organization_id = any ((select app.org_ids_with_any_permission(array['attendance.view_team', 'leave.view_team']))::uuid[])
      and employee_id = any ((select app.team_employee_ids())::uuid[]))
);
create policy approval_requests_system_write on public.approval_requests for all to flowza_system using (organization_id = app.system_org_id()) with check (organization_id = app.system_org_id());
create policy approval_requests_platform_ctx on public.approval_requests for select to flowza_system using ((select app.is_platform_context()));

-- approval_steps / actors / events: readable exactly where the request is readable (the request policy is evaluated
-- inside the EXISTS as the caller)
drop policy if exists approval_steps_select on public.approval_steps;
drop policy if exists approval_steps_insert on public.approval_steps;
drop policy if exists approval_steps_update on public.approval_steps;
drop policy if exists approval_steps_delete on public.approval_steps;
drop policy if exists approval_steps_assignee on public.approval_steps;
drop policy if exists approval_steps_system_write on public.approval_steps;
drop policy if exists approval_steps_platform_ctx on public.approval_steps;
alter table public.approval_steps enable row level security;
create policy approval_steps_select on public.approval_steps for select to authenticated, flowza_system using (
  exists (select 1 from public.approval_requests r where r.id = approval_steps.request_id)
);
create policy approval_steps_system_write on public.approval_steps for all to flowza_system using (organization_id = app.system_org_id()) with check (organization_id = app.system_org_id());
create policy approval_steps_platform_ctx on public.approval_steps for select to flowza_system using ((select app.is_platform_context()));

alter table public.approval_step_actors enable row level security;
drop policy if exists approval_step_actors_select on public.approval_step_actors;
drop policy if exists approval_step_actors_system_write on public.approval_step_actors;
drop policy if exists approval_step_actors_platform_ctx on public.approval_step_actors;
create policy approval_step_actors_select on public.approval_step_actors for select to authenticated, flowza_system using (
  exists (select 1 from public.approval_steps s where s.id = approval_step_actors.step_id)
);
create policy approval_step_actors_system_write on public.approval_step_actors for all to flowza_system using (organization_id = app.system_org_id()) with check (organization_id = app.system_org_id());
create policy approval_step_actors_platform_ctx on public.approval_step_actors for select to flowza_system using ((select app.is_platform_context()));

alter table public.approval_request_events enable row level security;
drop policy if exists approval_request_events_select on public.approval_request_events;
drop policy if exists approval_request_events_system_write on public.approval_request_events;
create policy approval_request_events_select on public.approval_request_events for select to authenticated, flowza_system using (
  exists (select 1 from public.approval_requests r where r.id = approval_request_events.request_id)
);
create policy approval_request_events_system_write on public.approval_request_events for insert to flowza_system with check (organization_id = app.system_org_id());

-- delegations: own (either side) or approval.manage; system-only writes
alter table public.approval_delegations enable row level security;
drop policy if exists approval_delegations_select on public.approval_delegations;
drop policy if exists approval_delegations_system_write on public.approval_delegations;
create policy approval_delegations_select on public.approval_delegations for select to authenticated, flowza_system using (
  delegator_user_id = (select app.uid()) or delegate_user_id = (select app.uid())
  or organization_id = any ((select app.org_ids_with_permission('approval.manage'))::uuid[])
);
create policy approval_delegations_system_write on public.approval_delegations for all to flowza_system using (organization_id = app.system_org_id()) with check (organization_id = app.system_org_id());

-- tokens and digest runs: never readable by clients
revoke all on public.approval_email_tokens from authenticated;
revoke all on public.approval_digest_runs from authenticated;
alter table public.approval_email_tokens enable row level security;
drop policy if exists approval_email_tokens_system on public.approval_email_tokens;
create policy approval_email_tokens_system on public.approval_email_tokens for all to flowza_system using (organization_id = app.system_org_id()) with check (organization_id = app.system_org_id());
alter table public.approval_digest_runs enable row level security;
drop policy if exists approval_digest_runs_system on public.approval_digest_runs;
drop policy if exists approval_digest_runs_platform_ctx on public.approval_digest_runs;
create policy approval_digest_runs_system on public.approval_digest_runs for all to flowza_system using (organization_id = app.system_org_id()) with check (organization_id = app.system_org_id());
create policy approval_digest_runs_platform_ctx on public.approval_digest_runs for select to flowza_system using ((select app.is_platform_context()));

-- workflows: readable by anyone who can see approvals; written by approval.manage OR organization.manage (branch scope)
drop policy if exists approval_workflows_select on public.approval_workflows;
drop policy if exists approval_workflows_insert on public.approval_workflows;
drop policy if exists approval_workflows_update on public.approval_workflows;
drop policy if exists approval_workflows_delete on public.approval_workflows;
alter table public.approval_workflows enable row level security;
create policy approval_workflows_select on public.approval_workflows for select to authenticated, flowza_system using (
  organization_id = any ((select app.org_ids_with_any_permission(array['attendance.view', 'leave.view', 'approval.manage', 'organization.manage']))::uuid[])
  and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or branch_id is null or branch_id = any ((select app.allowed_branch_ids())::uuid[]))
);
create policy approval_workflows_insert on public.approval_workflows for insert to authenticated, flowza_system with check (
  organization_id = any ((select app.org_ids_with_any_permission(array['approval.manage', 'organization.manage']))::uuid[])
  and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or branch_id is null or branch_id = any ((select app.allowed_branch_ids())::uuid[]))
);
create policy approval_workflows_update on public.approval_workflows for update to authenticated, flowza_system using (
  organization_id = any ((select app.org_ids_with_any_permission(array['approval.manage', 'organization.manage']))::uuid[])
  and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or branch_id is null or branch_id = any ((select app.allowed_branch_ids())::uuid[]))
) with check (
  organization_id = any ((select app.org_ids_with_any_permission(array['approval.manage', 'organization.manage']))::uuid[])
  and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or branch_id is null or branch_id = any ((select app.allowed_branch_ids())::uuid[]))
);
create policy approval_workflows_delete on public.approval_workflows for delete to authenticated, flowza_system using (
  organization_id = any ((select app.org_ids_with_any_permission(array['approval.manage', 'organization.manage']))::uuid[])
  and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or branch_id is null or branch_id = any ((select app.allowed_branch_ids())::uuid[]))
);

-- 5b. attendance corrections: defence in depth for the engine (Prompt 1 review, P2) ---------------------------------------------
-- Before: `attendance_corrections_insert/update/delete` were `attendance.correct AND branch` for authenticated AND the system
-- role, so a line manager (attendance.correct, no organisation-wide attendance.view) could INSERT a correction for a
-- non-report — or an APPROVED one — straight through RLS, and UPDATE a pending correction to APPROVED / APPLIED without any
-- approval request (or rewrite its proposed punch after the approver looked at it). Now, for the client role:
--   INSERT  status PENDING, nothing applied, no approval request yet, filed by the caller, and the employee is in reach:
--           organisation-wide attendance.view (branch scope applies), a direct report (app.team_employee_ids()), or oneself.
--           (`attendance_corrections_self_request` from 20260927000100 stays: attendance.request_correction, own record.)
--   UPDATE  none. Every status change (approve / reject / cancel / apply) is written by the approval engine or the worker in
--   DELETE  system context; the API withdraws through POST …/cancel. The web never talks to PostgREST for corrections.
-- The system context keeps org-scoped write access through its own policies. A later `app.apply_tenant_policies` call on
-- this table would recreate the permissive policies: the RLS suite (supabase/tests/rls_approvals.sql) fails if it does.
drop policy if exists attendance_corrections_insert on public.attendance_corrections;
drop policy if exists attendance_corrections_update on public.attendance_corrections;
drop policy if exists attendance_corrections_delete on public.attendance_corrections;
drop policy if exists attendance_corrections_system_insert on public.attendance_corrections;
drop policy if exists attendance_corrections_system_update on public.attendance_corrections;
drop policy if exists attendance_corrections_system_delete on public.attendance_corrections;
create policy attendance_corrections_insert on public.attendance_corrections for insert to authenticated with check (
  organization_id = any ((select app.org_ids_with_permission('attendance.correct'))::uuid[])
  and (organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or branch_id is null or branch_id = any ((select app.allowed_branch_ids())::uuid[]))
  and status = 'PENDING' and requested_by = (select app.uid()) and approval_request_id is null and applied_event_id is null and applied_at is null
  and (
    organization_id = any ((select app.org_ids_with_permission('attendance.view'))::uuid[])
    or employee_id = any ((select app.team_employee_ids())::uuid[])
    or employee_id = any ((select app.own_employee_ids())::uuid[])
  )
);
create policy attendance_corrections_system_insert on public.attendance_corrections for insert to flowza_system with check (organization_id = app.system_org_id());
create policy attendance_corrections_system_update on public.attendance_corrections for update to flowza_system using (organization_id = app.system_org_id()) with check (organization_id = app.system_org_id());
create policy attendance_corrections_system_delete on public.attendance_corrections for delete to flowza_system using (organization_id = app.system_org_id());

-- 6. Safety net + post-verify ------------------------------------------------------------------------------------------------
do $$
declare r record; v_count int;
begin
  for r in select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p') and n.nspname in ('public', 'audit') and not c.relrowsecurity
             and c.relname not like '%\_default' and c.relname !~ '_\d{6}$'
  loop
    raise exception 'table %.% has no RLS', r.nspname, r.relname;
  end loop;
  select count(*) into v_count from pg_enum where enumtypid = 'public.approver_type'::regtype
    and enumlabel in ('SECONDARY_MANAGER', 'MANAGER_CHAIN', 'HR_ADMIN', 'DEPARTMENT_HEAD', 'BRANCH_MANAGER');
  if v_count <> 5 then raise exception 'approver_type labels missing (%/5)', v_count; end if;
  select count(*) into v_count from pg_enum where enumtypid = 'public.approval_entity'::regtype
    and enumlabel in ('ATTENDANCE_NOTE', 'SHIFT_SWAP', 'COMP_OFF', 'REGULARISATION', 'OVERTIME_CLAIM');
  if v_count <> 5 then raise exception 'approval_entity labels missing (%/5)', v_count; end if;
  select count(*) into v_count from pg_enum where enumtypid = 'public.approval_status'::regtype and enumlabel in ('INVALIDATED', 'SKIPPED');
  if v_count <> 2 then raise exception 'approval_status labels missing'; end if;
  if not exists (select 1 from pg_constraint where conname = 'approval_workflows_steps_valid') then raise exception 'steps CHECK missing'; end if;
  if exists (select 1 from public.approval_workflows where not app.approval_steps_valid(steps)) then raise exception 'a workflow row fails the step shape'; end if;
  select count(*) into v_count from pg_tables where schemaname = 'public'
    and tablename in ('approval_step_actors', 'approval_delegations', 'approval_request_events', 'approval_email_tokens', 'approval_digest_runs') and rowsecurity;
  if v_count <> 5 then raise exception 'new approval tables without RLS (%/5)', v_count; end if;
  select count(*) into v_count from pg_policies where schemaname = 'public' and tablename = 'approval_requests' and policyname = 'approval_requests_select' and qual like '%approval_assigned_request_ids%' and qual like '%team_employee_ids%' and qual like '%own_employee_ids%';
  if v_count <> 1 then raise exception 'approval_requests read rule missing a branch'; end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('approval_requests', 'approval_steps') and roles::text like '%authenticated%' and cmd in ('INSERT', 'UPDATE', 'DELETE')) then
    raise exception 'approval_requests/steps must not be client-writable';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'leave_records' and column_name = 'approval_request_id') then
    raise exception 'leave_records.approval_request_id missing';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'approval_requests_pending_unique_idx') then raise exception 'pending unique index missing'; end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'approval_workflows_default_v2_idx') then raise exception 'tier-aware default index missing'; end if;
  -- corrections: the client can only file PENDING corrections in reach, and never change or delete one
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'attendance_corrections' and roles::text like '%authenticated%' and cmd in ('UPDATE', 'DELETE', 'ALL')) then
    raise exception 'attendance_corrections must not be client-updatable or deletable';
  end if;
  select count(*) into v_count from pg_policies where schemaname = 'public' and tablename = 'attendance_corrections' and cmd = 'INSERT' and roles::text like '%authenticated%'
    and (with_check not like '%''PENDING''%' or with_check not like '%app.uid()%');
  if v_count <> 0 then raise exception 'a client INSERT policy on attendance_corrections admits a non-PENDING row or another requester'; end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'attendance_corrections' and policyname = 'attendance_corrections_insert' and with_check like '%team_employee_ids%' and with_check like '%own_employee_ids%') then
    raise exception 'attendance_corrections_insert lost its reach predicate';
  end if;
end $$;
