-- Notifications RLS (HR portal Prompt 8, migration 20260928001000): a member reads and writes only their OWN notification
-- preferences, and writes them only for an organisation they are an active member of; notifications are the recipient's own;
-- e-mail deliveries and the missing check-out ledger are invisible to clients; the notifications settings group needs
-- notification.manage (every other group organization.manage); the relay's settings reader is system-only; a system context
-- reads / writes its own organisation's rows only; nothing crosses tenants. Self-contained on top of rls_isolation.sql's
-- committed fixtures: every block inserts its own rows and rolls back, so nothing is committed.
\set QUIET on
\set ON_ERROR_STOP on
set client_min_messages = warning;

create or replace function pg_temp.assert_eq(actual bigint, expected bigint, label text) returns void language plpgsql as $$
begin
  if actual <> expected then raise exception 'ASSERT FAILED: % — expected %, got %', label, expected, actual; end if;
  raise notice 'ok: % (%)', label, actual;
end $$;
create or replace function pg_temp.assert_raises(sqltext text, label text) returns void language plpgsql as $$
begin
  begin
    execute sqltext;
  exception when others then
    raise notice 'ok: % (raised %)', label, sqlerrm; return;
  end;
  raise exception 'ASSERT FAILED: % — expected an error', label;
end $$;
create or replace function pg_temp.assert_rows(sqltext text, expected bigint, label text) returns void language plpgsql as $$
declare n bigint;
begin
  execute sqltext; get diagnostics n = row_count;
  if n <> expected then raise exception 'ASSERT FAILED: % — expected % affected rows, got %', label, expected, n; end if;
  raise notice 'ok: % (% rows)', label, n;
end $$;
-- Fixtures (run as superuser inside each block): settings rows for A and B, a preference and a notification (+ delivery) for
-- owner A, emp-a (A) and owner B, and a missing check-out ledger row in each organisation.
create or replace function pg_temp.ntf_fixtures() returns void language plpgsql as $$
begin
  insert into public.organization_settings (organization_id) values ('0a000000-0000-0000-0000-000000000000'), ('0b000000-0000-0000-0000-000000000000') on conflict do nothing;
  insert into public.notification_preferences (user_id, organization_id, category, channel, enabled) values
    ('a0000000-0000-0000-0000-000000000001', '0a000000-0000-0000-0000-000000000000', 'DEVICE', 'EMAIL', false),
    ('a0000000-0000-0000-0000-000000000003', '0a000000-0000-0000-0000-000000000000', 'ATTENDANCE', 'EMAIL', false),
    ('b0000000-0000-0000-0000-000000000001', '0b000000-0000-0000-0000-000000000000', 'DEVICE', 'EMAIL', false);
  insert into public.notifications (id, organization_id, user_id, category, type, title) values
    ('0a000000-0000-0000-0000-0000000008a1', '0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000001', 'DEVICE', 'device.offline', 'Owner A'),
    ('0a000000-0000-0000-0000-0000000008a3', '0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000003', 'ATTENDANCE', 'punch.missing_out', 'Emp A'),
    ('0b000000-0000-0000-0000-0000000008b1', '0b000000-0000-0000-0000-000000000000', 'b0000000-0000-0000-0000-000000000001', 'DEVICE', 'device.offline', 'Owner B');
  insert into public.notification_deliveries (organization_id, notification_id, channel, status) values
    ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000008a1', 'EMAIL', 'pending'),
    ('0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000008b1', 'EMAIL', 'pending');
  insert into public.missing_punch_reminders (organization_id, employee_id, attendance_date, due_at, recipients) values
    ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '2026-09-15', '2026-09-15T15:00:00Z', 1),
    ('0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '2026-09-15', '2026-09-15T15:00:00Z', 1);
end $$;
grant execute on all functions in schema pg_temp to public;
set client_min_messages = notice;

-- ---------- emp-a (org A, role employee: no settings key) ----------
begin;
select pg_temp.ntf_fixtures();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.notification_preferences), 1, 'a member reads only their own preferences');
select pg_temp.assert_eq((select count(*) from public.notification_preferences where user_id <> 'a0000000-0000-0000-0000-000000000003'), 0, 'nobody else''s preferences are visible (same or other tenant)');
select pg_temp.assert_rows($q$ insert into public.notification_preferences (user_id, organization_id, category, channel, enabled) values ('a0000000-0000-0000-0000-000000000003', '0a000000-0000-0000-0000-000000000000', 'LEAVE', 'EMAIL', false) $q$, 1, 'a member writes their own preference for their organisation');
select pg_temp.assert_raises($q$ insert into public.notification_preferences (user_id, organization_id, category, channel, enabled) values ('a0000000-0000-0000-0000-000000000001', '0a000000-0000-0000-0000-000000000000', 'LEAVE', 'EMAIL', false) $q$, 'a member cannot write somebody else''s preference');
select pg_temp.assert_raises($q$ insert into public.notification_preferences (user_id, organization_id, category, channel, enabled) values ('a0000000-0000-0000-0000-000000000003', '0b000000-0000-0000-0000-000000000000', 'LEAVE', 'EMAIL', false) $q$, 'a member cannot keep preferences for an organisation they do not belong to');
select pg_temp.assert_rows($q$ update public.notification_preferences set enabled = true where category = 'ATTENDANCE' $q$, 1, 'a member updates their own preference');
select pg_temp.assert_rows($q$ update public.notification_preferences set enabled = true where user_id = 'a0000000-0000-0000-0000-000000000001' $q$, 0, 'a member cannot update somebody else''s preference');
select pg_temp.assert_raises($q$ update public.notification_preferences set organization_id = '0b000000-0000-0000-0000-000000000000' where category = 'ATTENDANCE' $q$, 'a member cannot move a preference to another organisation');
select pg_temp.assert_raises($q$ update public.notification_preferences set user_id = 'a0000000-0000-0000-0000-000000000001' where category = 'ATTENDANCE' $q$, 'a member cannot hand a preference to somebody else');
select pg_temp.assert_rows($q$ delete from public.notification_preferences where user_id = 'b0000000-0000-0000-0000-000000000001' $q$, 0, 'a member cannot delete another tenant''s preference');
select pg_temp.assert_rows($q$ delete from public.notification_preferences where category = 'LEAVE' $q$, 1, 'a member deletes their own preference');
select pg_temp.assert_eq((select count(*) from public.notifications), 1, 'a member reads only their own notifications');
select pg_temp.assert_rows($q$ update public.notifications set read_at = now() where id = '0a000000-0000-0000-0000-0000000008a1' $q$, 0, 'a member cannot mark somebody else''s notification');
select pg_temp.assert_raises($q$ insert into public.notifications (organization_id, user_id, category, type, title) values ('0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000003', 'SYSTEM', 'x', 'forged') $q$, 'clients cannot write notifications');
select pg_temp.assert_eq((select count(*) from public.notification_deliveries), 0, 'e-mail deliveries are invisible to clients');
select pg_temp.assert_raises($q$ insert into public.notification_deliveries (organization_id, notification_id, channel, status) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000008a3', 'EMAIL', 'pending') $q$, 'clients cannot queue e-mail deliveries');
select pg_temp.assert_raises($q$ select count(*) from public.missing_punch_reminders $q$, 'the missing check-out ledger is not readable by clients');
select pg_temp.assert_rows($q$ update public.organization_settings set notifications = '{"leaveUpdates": false}'::jsonb where organization_id = '0a000000-0000-0000-0000-000000000000' $q$, 0, 'a member without a settings key changes no settings');
select pg_temp.assert_raises($q$ select app.organization_notification_settings('0a000000-0000-0000-0000-000000000000') $q$, 'the relay''s settings reader is not callable by clients');
rollback;

-- ---------- Owner A (holds organization.manage and notification.manage) ----------
begin;
select pg_temp.ntf_fixtures();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.notification_preferences), 1, 'owner A reads only their own preferences');
select pg_temp.assert_eq((select count(*) from public.notification_preferences where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'owner A sees nothing of tenant B''s preferences');
select pg_temp.assert_rows($q$ update public.notification_preferences set enabled = true where organization_id = '0b000000-0000-0000-0000-000000000000' $q$, 0, 'owner A cannot change tenant B''s preferences');
select pg_temp.assert_eq((select count(*) from public.notifications where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, 'owner A sees no tenant B notification');
select pg_temp.assert_rows($q$ update public.organization_settings set notifications = '{"leaveUpdates": false, "missingPunchReminderHours": 3}'::jsonb where organization_id = '0a000000-0000-0000-0000-000000000000' $q$, 1, 'owner A writes the notifications group (notification.manage)');
select pg_temp.assert_rows($q$ update public.organization_settings set notifications = '{}'::jsonb where organization_id = '0b000000-0000-0000-0000-000000000000' $q$, 0, 'owner A cannot touch tenant B''s settings');
rollback;

-- ---------- A custom role: organization.manage without notification.manage, and notification.manage alone ----------
begin;
select pg_temp.ntf_fixtures();
insert into public.roles (id, organization_id, key, name, is_system) values
  ('0a000000-0000-0000-0000-0000000008c1', '0a000000-0000-0000-0000-000000000000', 'settings_only', 'Settings only', false),
  ('0a000000-0000-0000-0000-0000000008c2', '0a000000-0000-0000-0000-000000000000', 'notifications_only', 'Notifications only', false);
-- granted as owner A (a custom role only receives keys its author holds)
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
insert into public.role_permissions (role_id, permission_key) values
  ('0a000000-0000-0000-0000-0000000008c1', 'organization.view'), ('0a000000-0000-0000-0000-0000000008c1', 'organization.manage'),
  ('0a000000-0000-0000-0000-0000000008c2', 'organization.view'), ('0a000000-0000-0000-0000-0000000008c2', 'notification.manage');
update public.org_memberships set role_id = '0a000000-0000-0000-0000-0000000008c1' where id = '0a000000-0000-0000-0000-0000000000a7';
update public.org_memberships set role_id = '0a000000-0000-0000-0000-0000000008c2' where id = '0a000000-0000-0000-0000-0000000000a2';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000007","role":"authenticated"}', true);
select pg_temp.assert_raises($q$ update public.organization_settings set notifications = '{"leaveUpdates": false}'::jsonb where organization_id = '0a000000-0000-0000-0000-000000000000' $q$, 'organization.manage alone cannot change the notifications group');
select pg_temp.assert_rows($q$ update public.organization_settings set sync = '{"defaultIntervalMinutes": 10}'::jsonb where organization_id = '0a000000-0000-0000-0000-000000000000' $q$, 1, 'organization.manage still writes the other groups');
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select pg_temp.assert_rows($q$ update public.organization_settings set notifications = '{"leaveUpdates": false}'::jsonb where organization_id = '0a000000-0000-0000-0000-000000000000' $q$, 1, 'notification.manage writes the notifications group');
select pg_temp.assert_raises($q$ update public.organization_settings set security = '{"mfaRequired": true}'::jsonb where organization_id = '0a000000-0000-0000-0000-000000000000' $q$, 'notification.manage cannot change another group');
select pg_temp.assert_raises($q$ update public.organization_settings set notifications = '{"leaveUpdates": true}'::jsonb, security = '{"mfaRequired": true}'::jsonb where organization_id = '0a000000-0000-0000-0000-000000000000' $q$, 'a write touching another group is refused as a whole');
select pg_temp.assert_rows($q$ delete from public.organization_settings where organization_id = '0a000000-0000-0000-0000-000000000000' $q$, 0, 'notification.manage cannot delete the settings row');
rollback;

-- ---------- System context of org A (the worker): its own organisation only ----------
begin;
select pg_temp.ntf_fixtures();
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system","org_id":"0a000000-0000-0000-0000-000000000000"}', true);
select pg_temp.assert_eq((select count(*) from public.notification_preferences), 2, 'system context for org A reads A preferences only');
select pg_temp.assert_eq((select count(*) from public.notifications), 2, 'system context for org A reads A notifications only');
select pg_temp.assert_eq((select count(*) from public.notification_deliveries), 1, 'system context for org A reads A deliveries only');
select pg_temp.assert_raises($q$ insert into public.notifications (organization_id, user_id, category, type, title) values ('0b000000-0000-0000-0000-000000000000', 'b0000000-0000-0000-0000-000000000001', 'SYSTEM', 'x', 'cross-tenant') $q$, 'system context for org A cannot write B notifications');
select pg_temp.assert_eq((select count(*) from public.missing_punch_reminders), 1, 'system context for org A reads its own reminder ledger');
select pg_temp.assert_rows($q$ insert into public.missing_punch_reminders (organization_id, employee_id, attendance_date, due_at) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e3', '2026-09-16', now()) $q$, 1, 'system context for org A records a reminder');
select pg_temp.assert_raises($q$ insert into public.missing_punch_reminders (organization_id, employee_id, attendance_date, due_at) values ('0b000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-0000000000e1', '2026-09-16', now()) $q$, 'system context for org A cannot write B''s ledger');
select pg_temp.assert_rows($q$ delete from public.missing_punch_reminders where organization_id = '0b000000-0000-0000-0000-000000000000' $q$, 0, 'system context for org A cannot prune B''s ledger');
select pg_temp.assert_eq((select (app.organization_notification_settings('0a000000-0000-0000-0000-000000000000') is not null)::int), 1, 'the relay''s settings reader answers a system context');
rollback;

-- ---------- Platform context (the outbox relay): deliveries across tenants, never the ledger ----------
begin;
select pg_temp.ntf_fixtures();
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system","scope":"platform"}', true);
select pg_temp.assert_eq((select count(*) from public.notification_deliveries), 2, 'the platform relay sees every organisation''s deliveries');
select pg_temp.assert_eq((select count(*) from public.missing_punch_reminders), 0, 'the platform context does not read the reminder ledger');
rollback;
