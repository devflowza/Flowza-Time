-- Notifications review fixes (HR portal Prompt 8 review — docs/hr-portal/reviews/08-notifications-review.md). Additive and
-- idempotent; ONE transaction (the hosted apply and the local runner wrap each file); bounded lock waits. Named policies,
-- triggers and functions are replaced in place; migration 20260928001000 is not modified.
--
-- 1. 8-P0-1 (critical) — the outbox is written by the services only. `domain_events` admitted an INSERT from any
--    `authenticated` session for the member's organisation, and PostgREST exposes `public`: any signed-in member could post an
--    event (with their own JWT) that the relay turned into platform e-mails with chosen facts and working one-click links. An
--    `authenticated` INSERT is now admitted only when the SESSION user is one of the services' login roles — `flowza_api`
--    (the API: user-context emits) or `flowza_worker` — the way `app.enqueue_job` (2100) and the privilege-escalation guard
--    (1900) tell the services apart: `session_user` cannot be changed by SET ROLE, and PostgREST logs in as `authenticator`,
--    so a client JWT is refused (42501) whatever role it switches to. The system / platform contexts keep their own
--    policies (1400 / 2000). Defence in depth on the relay's other tables: a member may still mark their OWN notices read —
--    and nothing else (`notifications` UPDATE is column-granted on `read_at` only: the title, body, link and data an e-mail is
--    rendered from are the relay's); deliveries, tokens and the reminder ledger already had no client write policy.
-- 2. 8-P0-2 (high) — a settings row belongs to its organisation for good: the group guard raises on any change of
--    `organization_settings.organization_id` (every caller: members, system and platform contexts), and `authenticated`
--    loses UPDATE on that column (UPDATE is granted per column on every other column). A `notification.manage` holder can no
--    longer re-parent another organisation's row (moving its security group — and its MFA requirement — out of it). NOTE: a
--    settings group added later is a new column and needs `grant update (<column>) on public.organization_settings to
--    authenticated` in its migration (the RLS suite asserts that every column but the key is client-updatable).
-- 3. 8-P0-3 — `app.organization_notification_settings(org)` serves an organisation's system context its OWN organisation
--    only; the platform context (the outbox relay, which reads every organisation's switches) keeps reading any.
-- 4. 8-P0-5 — a one-time scrub of `notifications.data` written by the pre-Prompt-8 relay (the whole event payload: recipient
--    lists, other people's ids, free-form fields) down to what the current relay writes: the aggregate, the routing facts
--    (entityType, entityId, requestId, date, employeeId — the web's click routing reads them) and the catalogue's template
--    variables of the notice's type; a type the catalogue does not know (any more) keeps the aggregate and the routing facts
--    only. The whitelist below is `notificationDataKeys()` of @flowza/contracts at this migration (a test compares them).
--    Keyset batches of 5 000 rows; a row already within the whitelist is not touched, so a re-run changes nothing.
-- 5. 8-P2-7 — no DDL: the two partial indexes of 20260928001000 stay non-concurrent. The hosted apply runs each file as one
--    transaction (CREATE INDEX CONCURRENTLY cannot run inside one), both tables are small, and lock_timeout bounds the wait;
--    the runbook in that file (build them CONCURRENTLY out of band first on a large hosted table) stands.
set lock_timeout = '5s';
set statement_timeout = '300s';
set client_min_messages = warning;

-- 1. The outbox is written by the services only (8-P0-1) --------------------------------------------------------------------
drop policy if exists domain_events_insert on public.domain_events;
create policy domain_events_insert on public.domain_events for insert to authenticated
  with check (session_user in ('flowza_api', 'flowza_worker') and organization_id = any ((select app.member_org_ids())::uuid[]));
comment on policy domain_events_insert on public.domain_events is 'A user-context outbox write through the services only (the API / worker login roles as session user — never a PostgREST client), for an organisation of the member (notifications review 8-P0-1).';

-- a member marks their own notices read; the rest of the row is the relay's
revoke update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

-- 2. A settings row never changes organisation (8-P0-2) ---------------------------------------------------------------------
create or replace function app.organization_settings_group_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_new jsonb := to_jsonb(new);
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  v_key text;
  v_value jsonb;
begin
  -- a settings row belongs to its organisation for good (notifications review 8-P0-2) — for every caller
  if tg_op = 'UPDATE' and new.organization_id is distinct from old.organization_id then
    raise exception 'the organisation of a settings row cannot be changed' using errcode = '42501';
  end if;
  -- migrations, the system and the platform contexts are not members: RLS already scoped them, nothing to check here
  if app.uid() is null or app.is_system() then return new; end if;
  for v_key, v_value in select e.key, e.value from jsonb_each(v_new) e loop
    continue when v_key in ('organization_id', 'updated_by', 'updated_at', 'created_at');
    if tg_op = 'INSERT' then
      continue when v_value is null or v_value = 'null'::jsonb or v_value = '{}'::jsonb; -- the column default of a first write
    else
      continue when v_value is not distinct from (v_old -> v_key);
    end if;
    if v_key = 'notifications' then
      if not app.has_permission(new.organization_id, 'notification.manage') then
        raise exception 'notification.manage is required to change the notification settings' using errcode = '42501';
      end if;
    elsif not app.has_permission(new.organization_id, 'organization.manage') then
      raise exception 'organization.manage is required to change the % settings', v_key using errcode = '42501';
    end if;
  end loop;
  return new;
end $$;
comment on function app.organization_settings_group_guard() is 'organization_settings: the organisation of a row never changes (notifications review 8-P0-2); a member changing the notifications group needs notification.manage, any other group organization.manage (HR portal Prompt 8).';

-- clients update every column but the key (a table-level revoke also drops earlier column grants: re-runnable)
revoke update on public.organization_settings from authenticated;
do $$
declare v_cols text;
begin
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position) into v_cols
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'organization_settings' and c.column_name <> 'organization_id';
  execute format('grant update (%s) on public.organization_settings to authenticated', v_cols);
end $$;

-- 3. The relay reader serves a system context its own organisation (8-P0-3) ---------------------------------------------------
create or replace function app.organization_notification_settings(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not app.is_system() then raise exception 'system context required' using errcode = '42501'; end if;
  -- an organisation's system context reads its own organisation; the platform context (the outbox relay) any (is_platform_context
  -- is null — not false — when the claims carry no scope)
  if not coalesce(app.is_platform_context(), false) and p_org is distinct from app.system_org_id() then
    raise exception 'a system context reads its own organisation''s settings only' using errcode = '42501';
  end if;
  return coalesce((select s.notifications from public.organization_settings s where s.organization_id = p_org), '{}'::jsonb);
end $$;
comment on function app.organization_notification_settings(uuid) is 'The notifications settings group of one organisation, for the outbox relay: the platform context reads any organisation, an organisation''s system context its own only (notifications review 8-P0-3).';
revoke execute on function app.organization_notification_settings(uuid) from public, authenticated, anon;
grant execute on function app.organization_notification_settings(uuid) to flowza_system, flowza_worker, flowza_api;

-- 4. notifications.data down to the whitelist (8-P0-5) --------------------------------------------------------------------------
do $$
declare
  -- notificationDataKeys() of @flowza/contracts: `base` for every type, plus `types[type]`
  v_keys constant jsonb := '{"base": ["aggregateType", "aggregateId", "entityType", "entityId", "requestId", "date", "employeeId"],
 "types": {
  "approval.bypassed": ["employeeName", "stepNo", "endDate", "leaveTypeName", "leaveTypeNameAr", "summary", "reason"],
  "approval.decided": ["employeeName", "stepNo", "endDate", "leaveTypeName", "leaveTypeNameAr", "summary", "decision", "comment", "exception"],
  "approval.escalated": ["employeeName", "stepNo", "endDate", "leaveTypeName", "leaveTypeNameAr", "summary", "dueAt"],
  "approval.info_answered": ["employeeName", "stepNo", "endDate", "leaveTypeName", "leaveTypeNameAr", "summary", "comment"],
  "approval.info_requested": ["employeeName", "stepNo", "endDate", "leaveTypeName", "leaveTypeNameAr", "summary", "comment"],
  "approval.pending": ["employeeName", "stepNo", "endDate", "leaveTypeName", "leaveTypeNameAr", "summary", "reassigned"],
  "approval.reassigned": ["employeeName", "stepNo", "endDate", "leaveTypeName", "leaveTypeNameAr", "summary", "reason"],
  "approval.reminder": ["employeeName", "stepNo", "endDate", "leaveTypeName", "leaveTypeNameAr", "summary", "kind", "waitingSince", "total", "counts", "digestDate"],
  "attendance.note_decided": ["attendanceDate", "decision", "reason", "payEffectDays", "chargeOutcome", "leaveTypeCode", "leaveTypeName", "leaveTypeNameAr", "lossOfPay"],
  "attendance.note_info_requested": ["attendanceDate", "question"],
  "attendance.note_submitted": ["employeeName", "attendanceDate"],
  "attendance.punch_flagged": ["employeeName", "outcome", "reason", "geofenceName", "distanceM", "direction", "at"],
  "attendance.regularisation_decided": ["attendanceDate", "type", "decision", "comment"],
  "attendance.selfie_decided": ["decision", "reason", "at", "direction"],
  "attendance.selfie_submitted": ["employeeName", "direction", "at"],
  "attendance.unexcused_marked": ["employeeName", "dates", "count", "autoDeduct"],
  "device.offline": ["deviceName", "lastSeenAt"],
  "device.online": ["deviceName", "lastSeenAt"],
  "employee.imported": ["phase", "validRows", "imported"],
  "leave.approved": ["leaveTypeName", "leaveTypeNameAr", "startDate", "endDate", "decisionNote"],
  "leave.comment_added": ["employeeName", "leaveTypeName", "leaveTypeNameAr", "excerpt", "audience"],
  "leave.comp_off_expired": ["days", "credits", "expiredOn"],
  "leave.info_requested": ["leaveTypeName", "leaveTypeNameAr", "startDate", "endDate", "question"],
  "leave.rejected": ["leaveTypeName", "leaveTypeNameAr", "startDate", "endDate", "decisionNote"],
  "leave.requested": ["employeeName", "leaveTypeName", "leaveTypeNameAr", "startDate", "endDate"],
  "leave.year_closed": ["fromYear", "toYear", "carried", "totalDays"],
  "punch.missing_out": ["attendanceDate", "firstInAt", "expectedEndAt", "endSource", "hours"],
  "report.failed": ["reportTitle", "reportType", "error"],
  "report.ready": ["reportTitle", "reportType", "format"],
  "report.scheduled_delivery": ["reportTitle", "reportType", "mode", "periodFrom", "periodTo", "scheduleName"],
  "shift.swap_decided": ["swapDate", "decision", "comment"],
  "shift.swap_requested": ["requesterName", "swapDate", "requesterShiftName", "targetShiftName"],
  "subscription.limit_reached": ["metric", "limit"],
  "sync.completed": ["jobType", "itemsSuccess", "itemsFailed"],
  "sync.failed": ["jobType", "error"],
  "sync.finance.failed": ["direction", "consecutiveFailures", "code", "error", "reason", "punches"]
}}'::jsonb;
  v_base text[] := array(select jsonb_array_elements_text(v_keys -> 'base'));
  v_last uuid := null;
  v_ids uuid[];
  v_n bigint;
  v_scrubbed bigint := 0;
begin
  loop
    select array_agg(s.id order by s.id) into v_ids
    from (select n.id from public.notifications n where v_last is null or n.id > v_last order by n.id limit 5000) s;
    exit when v_ids is null;
    update public.notifications n
    set data = case when jsonb_typeof(n.data) = 'object' then (
        select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) from jsonb_each(n.data) e
        where e.key = any (v_base) or e.key = any (array(select jsonb_array_elements_text(coalesce(v_keys -> 'types' -> n.type, '[]'::jsonb)))))
      else '{}'::jsonb end
    where n.id = any (v_ids)
      and (jsonb_typeof(n.data) <> 'object'
        or exists (select 1 from jsonb_object_keys(n.data) k
                   where not (k = any (v_base) or k = any (array(select jsonb_array_elements_text(coalesce(v_keys -> 'types' -> n.type, '[]'::jsonb)))))));
    get diagnostics v_n = row_count;
    v_scrubbed := v_scrubbed + v_n;
    v_last := v_ids[array_length(v_ids, 1)];
  end loop;
  if v_scrubbed > 0 then raise notice 'notifications.data scrubbed to the whitelist: % rows', v_scrubbed; end if;
end $$;

-- Post-verify ---------------------------------------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_policy where polrelid = 'public.domain_events'::regclass and polname = 'domain_events_insert'
                 and pg_get_expr(polwithcheck, polrelid) ilike '%session_user%flowza_api%') then
    raise exception 'domain_events_insert does not check the session user';
  end if;
  if has_column_privilege('authenticated', 'public.notifications', 'title', 'update') or not has_column_privilege('authenticated', 'public.notifications', 'read_at', 'update') then
    raise exception 'clients must update notifications.read_at only';
  end if;
  if has_column_privilege('authenticated', 'public.organization_settings', 'organization_id', 'update') then raise exception 'clients can still move a settings row'; end if;
  if not has_column_privilege('authenticated', 'public.organization_settings', 'notifications', 'update') then raise exception 'clients lost the settings groups'; end if;
  if position('organization_id is distinct from old.organization_id' in pg_get_functiondef('app.organization_settings_group_guard()'::regprocedure)) = 0 then
    raise exception 'the settings guard does not pin the organisation';
  end if;
  if position('system_org_id' in pg_get_functiondef('app.organization_notification_settings(uuid)'::regprocedure)) = 0 then
    raise exception 'the relay settings reader is not scoped to the system context''s organisation';
  end if;
  if has_function_privilege('authenticated', 'app.organization_notification_settings(uuid)', 'execute') then raise exception 'organization_notification_settings executable by clients'; end if;
end $$;
