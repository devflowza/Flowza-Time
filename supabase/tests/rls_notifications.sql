-- Notifications RLS (HR portal Prompt 8, migration 20260928001000): a member reads and writes only their OWN notification
-- preferences, and writes them only for an organisation they are an active member of; notifications are the recipient's own;
-- e-mail deliveries and the missing check-out ledger are invisible to clients; the notifications settings group needs
-- notification.manage (every other group organization.manage); the relay's settings reader is system-only; a system context
-- reads / writes its own organisation's rows only; nothing crosses tenants. Self-contained on top of rls_isolation.sql's
-- committed fixtures: every block inserts its own rows and rolls back, so nothing is committed.
-- Review fixes (migration 20260928001050, blocks at the end): the outbox is written by the services' login roles only — a
-- PostgREST session (`authenticator` → `authenticated`) is refused (8-P0-1); a member marks their notices read and changes
-- nothing else of them; a settings row never changes organisation (8-P0-2, the reviewer's move + MFA probe); the relay's
-- settings reader serves a system context its own organisation (8-P0-3).
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

-- ================================================================================================================================
-- Notifications review fixes (migration 20260928001050, docs/hr-portal/reviews/08-notifications-review.md)
-- ================================================================================================================================
set client_min_messages = warning;
-- a refusal by a privilege or a row-level security policy (SQLSTATE 42501), not just any error
create or replace function pg_temp.assert_denied(sqltext text, label text) returns void language plpgsql as $$
begin
  begin
    execute sqltext;
  exception when others then
    if sqlstate <> '42501' then raise exception 'ASSERT FAILED: % — expected 42501, got % (%)', label, sqlstate, sqlerrm; end if;
    raise notice 'ok: % (denied: %)', label, sqlerrm; return;
  end;
  raise exception 'ASSERT FAILED: % — expected a 42501 refusal', label;
end $$;
grant execute on all functions in schema pg_temp to public;
set client_min_messages = notice;

-- ---------- 8-P0-1: a client cannot write the outbox; the services can ----------
-- PostgREST: the `authenticator` login switches to `authenticated` with the member's JWT (owner A — every key)
begin;
set local session authorization authenticator;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select (session_user = 'authenticator' and current_user = 'authenticated')::int), 1, '8-P0-1 the probe runs as PostgREST does (session authenticator, role authenticated)');
select pg_temp.assert_denied($q$ insert into public.domain_events (organization_id, event_type, aggregate_type, aggregate_id, payload) values ('0a000000-0000-0000-0000-000000000000', 'approval.pending', 'approval_request', '0a000000-0000-0000-0000-0000000008f1', '{"userIds": ["a0000000-0000-0000-0000-000000000005"]}') $q$, '8-P0-1 an authenticated client (PostgREST) cannot insert a domain event for its own organisation');
select pg_temp.assert_denied($q$ insert into public.domain_events (organization_id, event_type, aggregate_type, payload) values ('0a000000-0000-0000-0000-000000000000', 'subscription.limit_reached', 'organization', '{}') $q$, '8-P0-1 not even a non-configurable notice');
select pg_temp.assert_denied($q$ select count(*) from public.domain_events $q$, '8-P0-1 the outbox is not readable by clients');
rollback;
-- any other session user switching to `authenticated` (a plain employee here) is refused the same way
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select pg_temp.assert_denied($q$ insert into public.domain_events (organization_id, event_type, aggregate_type, payload) values ('0a000000-0000-0000-0000-000000000000', 'approval.decided', 'approval_request', '{"decision": "REJECTED", "comment": "verify your account"}') $q$, '8-P0-1 an authenticated session that is not a service login cannot insert a domain event');
rollback;
-- the API login (flowza_api) in a user context: emits for the member's organisation, never for another
begin;
set local session authorization flowza_api;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select pg_temp.assert_rows($q$ insert into public.domain_events (organization_id, event_type, aggregate_type, payload) values ('0a000000-0000-0000-0000-000000000000', 'attendance.note_submitted', 'attendance_note', '{}') $q$, 1, '8-P0-1 the API role (flowza_api) still emits in a user context');
select pg_temp.assert_denied($q$ insert into public.domain_events (organization_id, event_type, aggregate_type, payload) values ('0b000000-0000-0000-0000-000000000000', 'attendance.note_submitted', 'attendance_note', '{}') $q$, '8-P0-1 the API role emits only for an organisation of the member');
rollback;
-- the relay's other tables: a member marks their own notices read, and changes nothing else of them
begin;
select pg_temp.ntf_fixtures();
set local session authorization authenticator;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select pg_temp.assert_rows($q$ update public.notifications set read_at = now() where id = '0a000000-0000-0000-0000-0000000008a3' $q$, 1, '8-P0-1 a member marks their own notice read');
select pg_temp.assert_denied($q$ update public.notifications set title = 'forged', link = '/evil' where id = '0a000000-0000-0000-0000-0000000008a3' $q$, '8-P0-1 a member cannot rewrite the words of their own notice');
select pg_temp.assert_denied($q$ update public.notifications set data = '{"requestId": "0a000000-0000-0000-0000-0000000008f1"}'::jsonb where id = '0a000000-0000-0000-0000-0000000008a3' $q$, '8-P0-1 a member cannot rewrite the data of their own notice');
select pg_temp.assert_denied($q$ update public.notifications set organization_id = '0b000000-0000-0000-0000-000000000000' where id = '0a000000-0000-0000-0000-0000000008a3' $q$, '8-P0-1 a member cannot move their own notice');
select pg_temp.assert_denied($q$ insert into public.notification_deliveries (organization_id, notification_id, channel, status) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000008a3', 'EMAIL', 'pending') $q$, '8-P0-1 a member cannot queue an e-mail');
select pg_temp.assert_denied($q$ insert into public.approval_email_tokens (organization_id, request_id, step_id, user_id, action, token_hash, expires_at) values ('0a000000-0000-0000-0000-000000000000', gen_random_uuid(), gen_random_uuid(), 'a0000000-0000-0000-0000-000000000003', 'APPROVE', 'x', now()) $q$, '8-P0-1 a member cannot mint an approval link');
rollback;

-- ---------- 8-P0-2: a settings row never changes organisation (the reviewer's move + MFA probe) ----------
-- the attacker: owner of org B, and in org A a custom role with organization.view + notification.manage only
begin;
select pg_temp.ntf_fixtures();
update public.organization_settings set security = '{"mfaRequired": true, "sessionIdleMinutes": 15}'::jsonb,
  integrations = '{"flowzaFinance": {"enabled": true, "baseUrl": "https://victim-finance.example"}}'::jsonb
  where organization_id = '0a000000-0000-0000-0000-000000000000';
insert into public.roles (id, organization_id, key, name, is_system) values ('0a000000-0000-0000-0000-0000000008c3', '0a000000-0000-0000-0000-000000000000', 'notifications_admin', 'Notifications admin', false);
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
insert into public.role_permissions (role_id, permission_key) values ('0a000000-0000-0000-0000-0000000008c3', 'organization.view'), ('0a000000-0000-0000-0000-0000000008c3', 'notification.manage');
insert into public.org_memberships (id, organization_id, user_id, role_id, status, all_branches) values ('0a000000-0000-0000-0000-0000000008c4', '0a000000-0000-0000-0000-000000000000', 'b0000000-0000-0000-0000-000000000001', '0a000000-0000-0000-0000-0000000008c3', 'active', true);
select set_config('request.jwt.claims', '', true);
create temporary table p8f_mfa_before on commit drop as select app.principal_snapshot('a0000000-0000-0000-0000-000000000001') -> 'mfaRequiredOrgIds' as mfa;
grant select on p8f_mfa_before to public;
select pg_temp.assert_eq((select (mfa @> '["0a000000-0000-0000-0000-000000000000"]'::jsonb)::int from p8f_mfa_before), 1, '8-P0-2 org A requires MFA of its owner before the probe');
set local session authorization authenticator;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_raises($q$ update public.organization_settings set security = '{}'::jsonb where organization_id = '0a000000-0000-0000-0000-000000000000' $q$, '8-P0-2 notification.manage cannot write A''s security group directly');
select pg_temp.assert_rows($q$ delete from public.organization_settings where organization_id = '0b000000-0000-0000-0000-000000000000' $q$, 1, '8-P0-2 the owner of B deletes B''s own row (organization.manage there)');
select pg_temp.assert_denied($q$ update public.organization_settings set organization_id = '0b000000-0000-0000-0000-000000000000' where organization_id = '0a000000-0000-0000-0000-000000000000' $q$, '8-P0-2 a notification.manage holder cannot move A''s settings row into their own organisation');
select pg_temp.assert_denied($q$ update public.organization_settings set organization_id = '0b000000-0000-0000-0000-000000000000', notifications = '{"leaveUpdates": false}'::jsonb where organization_id = '0a000000-0000-0000-0000-000000000000' $q$, '8-P0-2 not even together with a group the holder may write');
select pg_temp.assert_eq((select count(*) from public.organization_settings where organization_id = '0b000000-0000-0000-0000-000000000000'), 0, '8-P0-2 nothing of A''s settings reached B');
select pg_temp.assert_rows($q$ update public.organization_settings set notifications = '{"leaveUpdates": false}'::jsonb where organization_id = '0a000000-0000-0000-0000-000000000000' $q$, 1, '8-P0-2 the holder still writes A''s notifications group');
reset role;
reset session authorization;
select set_config('request.jwt.claims', '', true);
select pg_temp.assert_eq((select count(*) from public.organization_settings where organization_id = '0a000000-0000-0000-0000-000000000000' and security ->> 'mfaRequired' = 'true'), 1, '8-P0-2 A keeps its settings row and its security group');
select pg_temp.assert_eq((select ((app.principal_snapshot('a0000000-0000-0000-0000-000000000001') -> 'mfaRequiredOrgIds') = (select mfa from p8f_mfa_before))::int), 1, '8-P0-2 A''s owner is still required to use MFA (the principal snapshot is unchanged)');
rollback;
-- the organisation of a settings row is fixed for every caller: the owner, a system context, the platform context
begin;
select pg_temp.ntf_fixtures();
delete from public.organization_settings where organization_id = '0b000000-0000-0000-0000-000000000000';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_denied($q$ update public.organization_settings set organization_id = '0b000000-0000-0000-0000-000000000000' where organization_id = '0a000000-0000-0000-0000-000000000000' $q$, '8-P0-2 even organization.manage cannot move a settings row');
select pg_temp.assert_rows($q$ update public.organization_settings set security = '{"mfaRequired": false}'::jsonb where organization_id = '0a000000-0000-0000-0000-000000000000' $q$, 1, '8-P0-2 organization.manage still writes every group');
reset role;
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system","org_id":"0a000000-0000-0000-0000-000000000000"}', true);
select pg_temp.assert_denied($q$ update public.organization_settings set organization_id = '0b000000-0000-0000-0000-000000000000' where organization_id = '0a000000-0000-0000-0000-000000000000' $q$, '8-P0-2 a system context cannot move a settings row');
select set_config('request.jwt.claims', '{"role":"flowza_system","scope":"platform"}', true);
reset role;
select pg_temp.assert_denied($q$ update public.organization_settings set organization_id = '0b000000-0000-0000-0000-000000000000' where organization_id = '0a000000-0000-0000-0000-000000000000' $q$, '8-P0-2 the guard pins the organisation for the table owner too');
rollback;
-- a settings group added later must be granted to clients in its migration: every column but the key is client-updatable
select pg_temp.assert_eq((select count(*) from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'organization_settings'
  and c.column_name <> 'organization_id' and not has_column_privilege('authenticated', 'public.organization_settings', c.column_name, 'update')), 0,
  '8-P0-2 every settings column but the key stays client-updatable (a new group needs its column grant)');
select pg_temp.assert_eq((select has_column_privilege('authenticated', 'public.organization_settings', 'organization_id', 'update')::int), 0, '8-P0-2 clients hold no UPDATE on organization_settings.organization_id');

-- ---------- 8-P0-3: the relay's settings reader serves a system context its own organisation ----------
begin;
select pg_temp.ntf_fixtures();
update public.organization_settings set notifications = '{"leaveUpdates": false}'::jsonb where organization_id = '0b000000-0000-0000-0000-000000000000';
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system","org_id":"0a000000-0000-0000-0000-000000000000"}', true);
select pg_temp.assert_eq((select (app.organization_notification_settings('0a000000-0000-0000-0000-000000000000') is not null)::int), 1, '8-P0-3 a system context reads its own organisation''s switches');
select pg_temp.assert_denied($q$ select app.organization_notification_settings('0b000000-0000-0000-0000-000000000000') $q$, '8-P0-3 a system context bound to A cannot read B''s switches');
select set_config('request.jwt.claims', '{"role":"flowza_system","scope":"platform"}', true);
select pg_temp.assert_eq((select (app.organization_notification_settings('0b000000-0000-0000-0000-000000000000') ->> 'leaveUpdates' = 'false')::int), 1, '8-P0-3 the platform relay still reads any organisation''s switches');
rollback;
