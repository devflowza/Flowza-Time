-- Manager workspace + HR admin parity — fixes of the adversarial review (docs/hr-portal/reviews/05-manager-workspace-review.md).
--
-- ONE definition of "waiting for you": `app.approval_actionable_request_ids(org)` — the inbox "Mine" queue, /me
-- `approvals.actionable`, the dashboard count, the team pending counts / board / leave card, the topbar chip and the sidebar
-- badge all read it — now agrees with the engine's own rule (`assessDecider`) on who may decide a request's current level:
--
--   P1-3  a secondary manager's STAND-IN seat (`resolution_path = 'secondary'`, `via_delegation_of` = the primary — seated by
--         the portal for reasons, regularisations and shift swaps) is the caller's own seat for EVERY entity type. It comes from
--         the reporting line, not from a delegation, so it never lapses with one (it used to be dropped unless a delegation from
--         the primary happened to be in force — decidable, but listed and counted nowhere).
--   P2-1  a request ABOUT the caller (the subject by the submit snapshot or the CURRENT membership link, or a co-subject — a
--         swap's colleague) is never "waiting for" them; neither is a request they FILED when they would reach it only as a
--         delegate (the requester decides only through a seat of their own). The organisation's owner is the one exception
--         (the engine lets them decide, logged `sod_owner_bypass`).
--   O3    four-eyes: one person approves at most ONE level of a request (directly or as a delegate). A level after one the caller
--         already approved is not waiting for them (the engine refuses them and drops their seats when the level opens); the
--         owner keeps a logged override and is still listed.
--   P2-2  follows from P1-3: the stand-in seat is counted here, in a SECURITY DEFINER function, so a secondary manager whose
--         role carries no team key (the reasons are invisible to them under RLS) still sees their decidable items in the badge.
--
-- The invitation lookup (review P1-2) needs no new index: `invitations_token_hash_key` (unique constraint on token_hash) and
-- `invitations_delivery_token_hash_key` (unique partial index) already exist — the post-verify block asserts both, so the
-- API's equality lookup can never silently degrade to a scan.
--
-- Additive and idempotent (CREATE OR REPLACE keeps the function's ACL), one transaction, bounded lock waits. Never edits
-- 20260928000900 or any earlier file. No table, no policy, no data change.
set lock_timeout = '5s';
set statement_timeout = '120s';
set client_min_messages = warning;

create or replace function app.approval_actionable_request_ids(p_org uuid) returns setof uuid
language sql stable security definer set search_path = ''
as $$
  with me as (
    select m.user_id as uid, m.employee_id, (ro.key = 'owner') as is_owner
    from public.org_memberships m
    join public.roles ro on ro.id = m.role_id
    where m.organization_id = p_org and m.user_id = app.uid() and m.status = 'active'
  ),
  seats as (
    -- (1) the caller's own pending rows on the current level: their own seat, the reporting line's stand-in seat (secondary
    -- manager on the primary's seat — `secondary`, never lapses), an escalation seat, or a delegate row stamped at submit while
    -- that delegation is still in force (organisation date, delegator still active)
    select s.request_id, (a.via_delegation_of is not null and a.resolution_path is distinct from 'secondary') as as_delegate
    from me
    join public.approval_step_actors a on a.user_id = me.uid and a.organization_id = p_org and a.decision = 'PENDING'
    join public.approval_steps s on s.id = a.step_id and s.status = 'PENDING'
    join public.approval_requests r on r.id = s.request_id and r.status = 'PENDING' and r.current_step = s.step_no
    where a.via_delegation_of is null
       or a.resolution_path = 'secondary'
       or app.approval_delegate_of(p_org, a.via_delegation_of, r.entity_type) = me.uid
    union all
    -- (2) the pending seat of somebody who delegates to the caller today
    select s.request_id, true
    from me
    join public.approval_delegations d on d.delegate_user_id = me.uid and d.organization_id = p_org and d.is_active
    join public.approval_step_actors a on a.organization_id = p_org and a.user_id = d.delegator_user_id and a.decision = 'PENDING'
    join public.approval_steps s on s.id = a.step_id and s.status = 'PENDING'
    join public.approval_requests r on r.id = s.request_id and r.status = 'PENDING' and r.current_step = s.step_no
    where app.org_today(p_org) between d.starts_on and d.ends_on
      and app.approval_delegate_of(p_org, a.user_id, r.entity_type) = me.uid
  )
  select distinct seats.request_id
  from seats
  join public.approval_requests r on r.id = seats.request_id and r.organization_id = p_org
  cross join me
  where me.is_owner
     -- null-safe: a request with no subject user / requester (an employee without a login) must not read as "about the caller"
     or not coalesce((
       -- segregation of duties: nobody decides a request about themselves (snapshot or current link; co-subjects too)
       r.subject_user_id = me.uid
       or (me.employee_id is not null and r.employee_id = me.employee_id)
       or me.uid = any (coalesce(r.co_subject_user_ids, '{}'::uuid[]))
       or (me.employee_id is not null and me.employee_id = any (coalesce(r.co_subject_employee_ids, '{}'::uuid[])))
       -- the requester decides only through a seat of their own, never as somebody's delegate
       or (seats.as_delegate and r.requested_by = me.uid)
       -- four-eyes: one person approves at most one level of a request
       or exists (select 1 from public.approval_steps ps
                  join public.approval_step_actors pa on pa.step_id = ps.id and pa.user_id = me.uid and pa.decision = 'APPROVED'
                  where ps.organization_id = p_org and ps.request_id = r.id and ps.step_no < r.current_step)
     ), false)
$$;
comment on function app.approval_actionable_request_ids(uuid) is 'The requests of an organisation waiting for the caller on their current level — the inbox "Mine" queue, the dashboard count, /me approvals.actionable and the team badge: own seats (stand-in seats of the reporting line included, for every entity type), delegate seats in force today, escalation seats; never a request about the caller, never one they filed reached as a delegate, never a level after one they approved (four-eyes) — the owner excepted, as in the engine.';

-- post-verify: the definition carries every rule, the ACL did not move, the invitation hash lookups stay indexed
do $$
declare
  v_def text := pg_get_functiondef('app.approval_actionable_request_ids(uuid)'::regprocedure);
begin
  if v_def not like '%resolution_path = ''secondary''%' then raise exception 'actionable set: stand-in seats are not counted'; end if;
  if v_def not like '%co_subject_user_ids%' or v_def not like '%subject_user_id = me.uid%' then raise exception 'actionable set: requests about the caller are not excluded'; end if;
  if v_def not like '%ps.step_no < r.current_step%' then raise exception 'actionable set: the four-eyes rule is missing'; end if;
  if v_def not like '%not coalesce((%' then raise exception 'actionable set: the exclusion is not null-safe (a request without a subject user would vanish)'; end if;
  if not has_function_privilege('authenticated', 'app.approval_actionable_request_ids(uuid)', 'execute') then raise exception 'actionable set: authenticated lost execute'; end if;
  if not has_function_privilege('flowza_api', 'app.approval_actionable_request_ids(uuid)', 'execute') then raise exception 'actionable set: flowza_api lost execute'; end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'invitations' and indexdef like '%UNIQUE%(token_hash)%') then
    raise exception 'invitations: token_hash has no unique index (the token lookup would scan)';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'invitations' and indexdef like '%UNIQUE%(delivery_token_hash)%') then
    raise exception 'invitations: delivery_token_hash has no unique index (the token lookup would scan)';
  end if;
end $$;
