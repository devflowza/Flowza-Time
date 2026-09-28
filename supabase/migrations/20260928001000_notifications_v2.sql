-- Notifications & reminders (HR portal Prompt 8). Additive and idempotent; runs as ONE transaction (the hosted apply and the
-- local runner wrap each file), bounded lock waits. Nothing here uses the enum values it adds (a new enum value cannot be
-- used in the transaction that adds it).
--
-- 1. `notification_category` gains LEAVE and REPORTS (user preferences are kept per organisation × category × channel;
--    the catalogue in @flowza/contracts assigns every notification type a category). Existing notifications keep the
--    category they were written with.
-- 2. `notifications.in_app` (default true): a notice written only as the record of an e-mail (the recipient switched the
--    category's in-app notices off, or the event asked for e-mail only) is stored with `in_app = false` (and read), so the
--    e-mail has its content and the trail — the inbox lists `in_app` rows only.
-- 3. `notification_deliveries.next_attempt_at`: e-mail retries back off (the worker's DELIVER_NOTIFICATIONS batch).
-- 4. Retention (worker task notifications.retention, daily): partial indexes that let the purge walk read notifications and
--    settled deliveries per organisation without scanning (domain_events already has (organization_id, occurred_at)).
-- 5. `missing_punch_reminders`: one row per employee-day that got the missing check-out reminder (worker task
--    attendance.missing-punch-reminder) — the idempotency ledger. System context of the organisation only.
-- 6. `notification_preferences`: own rows only, and a row can only be written for an organisation the caller is an active
--    member of (the old ALL policy let a user write rows for any organisation id). The system context reads its own
--    organisation's rows only (it read every organisation's).
-- 7. `organization_settings`: the notifications group is written with `notification.manage` (declared since 1600, enforced
--    by nothing until now), every other group with `organization.manage` — RLS admits either key for INSERT / UPDATE and a
--    BEFORE trigger checks each group that actually changes; DELETE keeps `organization.manage`. Migrations and the
--    system / platform contexts are not members and are not checked.
-- 8. `app.organization_notification_settings(org)`: the notifications group for the outbox relay, which runs in the platform
--    context (organization_settings is not on the platform whitelist; this exposes one group, to system contexts only).
-- 9. `notifications` / `notification_deliveries` system policies are scoped to the context's own organisation (they
--    admitted any organisation); the relay keeps its platform-context policies.
--
-- Runbook (large hosted tables): the two indexes of step 4 are built in the migration's transaction under lock_timeout 5s
-- (a busy table fails fast rather than blocking writers). If `notifications` / `notification_deliveries` are large, build
-- them first out of band with `create index concurrently if not exists …` (same names, same definitions); the statements
-- below are then no-ops.
set lock_timeout = '5s';
set statement_timeout = '120s';
set client_min_messages = warning;

-- 1. Categories ---------------------------------------------------------------------------------------------------------------
alter type public.notification_category add value if not exists 'LEAVE';
alter type public.notification_category add value if not exists 'REPORTS';

-- 2. In-app flag --------------------------------------------------------------------------------------------------------------
alter table public.notifications add column if not exists in_app boolean not null default true;
comment on column public.notifications.in_app is 'False for a notice stored only as the record of its e-mail (in-app off for its category, or the event asked for e-mail only); the inbox lists in_app rows only.';

-- 3. Delivery back-off --------------------------------------------------------------------------------------------------------
alter table public.notification_deliveries add column if not exists next_attempt_at timestamptz;
comment on column public.notification_deliveries.next_attempt_at is 'Earliest time of the next e-mail attempt after a failure (exponential back-off); null = due now.';

-- 4. Retention indexes --------------------------------------------------------------------------------------------------------
create index if not exists notifications_org_read_created_idx on public.notifications (organization_id, created_at) where read_at is not null;
create index if not exists notification_deliveries_org_settled_idx on public.notification_deliveries (organization_id, created_at) where status <> 'pending';

-- 5. Missing check-out reminder ledger -----------------------------------------------------------------------------------------
create table if not exists public.missing_punch_reminders (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null,
  attendance_date date not null,
  due_at timestamptz not null,
  reminded_at timestamptz not null default now(),
  recipients int not null default 0 check (recipients >= 0),
  primary key (organization_id, employee_id, attendance_date),
  constraint missing_punch_reminders_employee_fkey foreign key (employee_id, organization_id) references public.employees (id, organization_id) on delete cascade
);
comment on table public.missing_punch_reminders is 'One row per employee-day reminded of a missing check-out (idempotency of attendance.missing-punch-reminder). Written and read by the organisation''s system context only.';
create index if not exists missing_punch_reminders_org_date_idx on public.missing_punch_reminders (organization_id, attendance_date);
alter table public.missing_punch_reminders enable row level security;
revoke all on public.missing_punch_reminders from authenticated, anon;
grant select, insert, update, delete on public.missing_punch_reminders to flowza_system;
drop policy if exists missing_punch_reminders_system on public.missing_punch_reminders;
create policy missing_punch_reminders_system on public.missing_punch_reminders for all to flowza_system
  using ((select app.is_system()) and organization_id = (select app.system_org_id()))
  with check ((select app.is_system()) and organization_id = (select app.system_org_id()));

-- 6. Preferences: own rows, written for an organisation of the caller --------------------------------------------------------
drop policy if exists notification_preferences_self on public.notification_preferences;
drop policy if exists notification_preferences_self_select on public.notification_preferences;
drop policy if exists notification_preferences_self_insert on public.notification_preferences;
drop policy if exists notification_preferences_self_update on public.notification_preferences;
drop policy if exists notification_preferences_self_delete on public.notification_preferences;
create policy notification_preferences_self_select on public.notification_preferences for select to authenticated using (user_id = app.uid());
create policy notification_preferences_self_insert on public.notification_preferences for insert to authenticated
  with check (user_id = app.uid() and organization_id = any ((select app.member_org_ids())::uuid[]));
create policy notification_preferences_self_update on public.notification_preferences for update to authenticated
  using (user_id = app.uid()) with check (user_id = app.uid() and organization_id = any ((select app.member_org_ids())::uuid[]));
create policy notification_preferences_self_delete on public.notification_preferences for delete to authenticated using (user_id = app.uid());
drop policy if exists notification_preferences_system on public.notification_preferences;
create policy notification_preferences_system on public.notification_preferences for select to flowza_system
  using ((select app.is_system()) and organization_id = (select app.system_org_id()));

-- 7. Settings: the notifications group needs notification.manage, every other group organization.manage -------------------
drop policy if exists organization_settings_write on public.organization_settings;
drop policy if exists organization_settings_insert on public.organization_settings;
drop policy if exists organization_settings_update on public.organization_settings;
drop policy if exists organization_settings_delete on public.organization_settings;
create policy organization_settings_insert on public.organization_settings for insert to authenticated, flowza_system
  with check (organization_id = any ((select app.org_ids_with_permission('organization.manage'))::uuid[]) or organization_id = any ((select app.org_ids_with_permission('notification.manage'))::uuid[]));
create policy organization_settings_update on public.organization_settings for update to authenticated, flowza_system
  using (organization_id = any ((select app.org_ids_with_permission('organization.manage'))::uuid[]) or organization_id = any ((select app.org_ids_with_permission('notification.manage'))::uuid[]))
  with check (organization_id = any ((select app.org_ids_with_permission('organization.manage'))::uuid[]) or organization_id = any ((select app.org_ids_with_permission('notification.manage'))::uuid[]));
create policy organization_settings_delete on public.organization_settings for delete to authenticated, flowza_system
  using (organization_id = any ((select app.org_ids_with_permission('organization.manage'))::uuid[]));

-- Each group that changes is checked against its own key. Every column except the key and the bookkeeping ones is a group,
-- so a group added later is covered (organization.manage) without touching this function.
create or replace function app.organization_settings_group_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_new jsonb := to_jsonb(new);
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  v_key text;
  v_value jsonb;
begin
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
comment on function app.organization_settings_group_guard() is 'organization_settings: a member changing the notifications group needs notification.manage, any other group organization.manage (HR portal Prompt 8).';
drop trigger if exists organization_settings_group_guard on public.organization_settings;
create trigger organization_settings_group_guard before insert or update on public.organization_settings for each row execute function app.organization_settings_group_guard();

-- 8. The relay's read of the notifications group --------------------------------------------------------------------------------
create or replace function app.organization_notification_settings(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not app.is_system() then raise exception 'system context required' using errcode = '42501'; end if;
  return coalesce((select s.notifications from public.organization_settings s where s.organization_id = p_org), '{}'::jsonb);
end $$;
comment on function app.organization_notification_settings(uuid) is 'The notifications settings group of one organisation, for the outbox relay (platform / system contexts only).';
revoke execute on function app.organization_notification_settings(uuid) from public, authenticated, anon;
grant execute on function app.organization_notification_settings(uuid) to flowza_system, flowza_worker, flowza_api;

-- 9. System policies scoped to the context's own organisation ---------------------------------------------------------------------
drop policy if exists notifications_system on public.notifications;
create policy notifications_system on public.notifications for all to flowza_system
  using ((select app.is_system()) and organization_id = (select app.system_org_id()))
  with check ((select app.is_system()) and organization_id = (select app.system_org_id()));
drop policy if exists notification_deliveries_system on public.notification_deliveries;
create policy notification_deliveries_system on public.notification_deliveries for all to flowza_system
  using ((select app.is_system()) and organization_id = (select app.system_org_id()))
  with check ((select app.is_system()) and organization_id = (select app.system_org_id()));

-- Post-verify ---------------------------------------------------------------------------------------------------------------------
do $$
begin
  if (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' and t.typname = 'notification_category' and e.enumlabel in ('LEAVE', 'REPORTS')) <> 2 then
    raise exception 'notification_category is missing LEAVE / REPORTS';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'notifications' and column_name = 'in_app') then raise exception 'notifications.in_app missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'notification_deliveries' and column_name = 'next_attempt_at') then raise exception 'notification_deliveries.next_attempt_at missing'; end if;
  if not (select relrowsecurity from pg_class where oid = 'public.missing_punch_reminders'::regclass) then raise exception 'missing_punch_reminders without RLS'; end if;
  if has_table_privilege('authenticated', 'public.missing_punch_reminders', 'select') then raise exception 'missing_punch_reminders readable by clients'; end if;
  if exists (select 1 from pg_policy where polrelid = 'public.notification_preferences'::regclass and polname = 'notification_preferences_self') then raise exception 'the old preferences ALL policy survived'; end if;
  if exists (select 1 from pg_policy where polrelid = 'public.organization_settings'::regclass and polname = 'organization_settings_write') then raise exception 'the old settings ALL policy survived'; end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.organization_settings'::regclass and tgname = 'organization_settings_group_guard') then raise exception 'settings group guard missing'; end if;
  if has_function_privilege('authenticated', 'app.organization_notification_settings(uuid)', 'execute') then raise exception 'organization_notification_settings executable by clients'; end if;
end $$;
