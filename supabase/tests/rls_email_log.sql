-- E-mail activity log (migration 20260930000500): the triggers on invitations / notification_deliveries keep one message per
-- e-mail and an append-only timeline; the provider-event function records delivery events in the platform context only and
-- is idempotent; members holding audit.view with access to every branch read their organisation's log, nobody else reads it
-- and nobody writes it. Self-contained on top of rls_isolation.sql's committed fixtures: every block rolls back.
\set QUIET on
\set ON_ERROR_STOP on
set client_min_messages = warning;

create or replace function pg_temp.assert_eq(actual bigint, expected bigint, label text) returns void language plpgsql as $$
begin
  if actual is distinct from expected then raise exception 'ASSERT FAILED: % — expected %, got %', label, expected, actual; end if;
  raise notice 'ok: % (%)', label, actual;
end $$;
create or replace function pg_temp.assert_text(actual text, expected text, label text) returns void language plpgsql as $$
begin
  if actual is distinct from expected then raise exception 'ASSERT FAILED: % — expected %, got %', label, expected, actual; end if;
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
-- Fixtures (superuser, inside each block): a queued invitation in A and in B, a notification of emp-a with an e-mail and an
-- in-app delivery.
create or replace function pg_temp.mail_fixtures() returns void language plpgsql as $$
begin
  insert into public.invitations (id, organization_id, email, role_id, all_branches, token_hash, expires_at, delivery_status) values
    ('0a000000-0000-0000-0000-0000000007a1', '0a000000-0000-0000-0000-000000000000', 'invitee-a@test.local', '10000000-0000-0000-0000-000000000008', true, repeat('7', 64), now() + interval '7 days', 'queued'),
    ('0b000000-0000-0000-0000-0000000007b1', '0b000000-0000-0000-0000-000000000000', 'invitee-b@test.local', '10000000-0000-0000-0000-000000000008', true, repeat('8', 64), now() + interval '7 days', 'queued');
  insert into public.notifications (id, organization_id, user_id, category, type, title) values
    ('0a000000-0000-0000-0000-0000000007c1', '0a000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000003', 'ATTENDANCE', 'punch.missing_out', 'Missing check-out');
  insert into public.notification_deliveries (organization_id, notification_id, channel, status) values
    ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000007c1', 'EMAIL', 'pending'),
    ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000007c1', 'IN_APP', 'pending');
end $$;
create or replace function pg_temp.as_platform() returns void language plpgsql as $$
begin
  perform set_config('role', 'flowza_system', true);
  perform set_config('request.jwt.claims', '{"role":"flowza_system","scope":"platform"}', true);
end $$;
grant execute on all functions in schema pg_temp to public;
set client_min_messages = notice;

-- ---------- the pipeline: one message per e-mail, its timeline, never a failed business write ----------
begin;
select pg_temp.mail_fixtures();
select pg_temp.assert_eq((select count(*) from public.email_messages where invitation_id = '0a000000-0000-0000-0000-0000000007a1' and status = 'queued' and recipient = 'invitee-a@test.local' and kind = 'invitation'), 1, 'a queued invitation is logged as a queued e-mail');
select pg_temp.assert_eq((select count(*) from public.email_events e join public.email_messages m on m.id = e.message_id where m.invitation_id = '0a000000-0000-0000-0000-0000000007a1' and e.event = 'queued'), 1, '...with a queued event');
select pg_temp.assert_eq((select count(*) from public.email_messages m join public.notification_deliveries d on d.id = m.notification_delivery_id
  where d.notification_id = '0a000000-0000-0000-0000-0000000007c1' and m.status = 'queued' and m.recipient = 'emp-a@test.local' and m.recipient_user_id = 'a0000000-0000-0000-0000-000000000003'
    and m.subject = 'Missing check-out' and m.category = 'punch.missing_out'), 1, 'an e-mail delivery is logged with its recipient, subject and type');
select pg_temp.assert_eq((select count(*) from public.email_messages m join public.notification_deliveries d on d.id = m.notification_delivery_id where d.channel <> 'EMAIL'), 0, 'in-app deliveries are not e-mails');

update public.invitations set delivery_status = 'retrying', delivery_attempts = 1, delivery_last_error = 'email send failed: rate limited', delivery_next_attempt_at = now() + interval '30 seconds'
where id = '0a000000-0000-0000-0000-0000000007a1';
select pg_temp.assert_eq((select count(*) from public.email_messages where invitation_id = '0a000000-0000-0000-0000-0000000007a1' and status = 'retrying' and attempts = 1
  and last_error = 'email send failed: rate limited' and next_attempt_at is not null), 1, 'a failed attempt moves the message to retrying with the reason');
update public.invitations set delivery_attempts = 2, delivery_last_error = 'email send failed: rate limited again' where id = '0a000000-0000-0000-0000-0000000007a1';
select pg_temp.assert_eq((select count(*) from public.email_events e join public.email_messages m on m.id = e.message_id where m.invitation_id = '0a000000-0000-0000-0000-0000000007a1' and e.event = 'attempt_failed'), 2, 'every failed attempt is an event');
update public.invitations set delivery_token_hash = repeat('9', 64), delivery_sent_at = now() where id = '0a000000-0000-0000-0000-0000000007a1';
select pg_temp.assert_eq((select count(*) from public.email_events e join public.email_messages m on m.id = e.message_id where m.invitation_id = '0a000000-0000-0000-0000-0000000007a1'), 3, 'a change of no delivery column logs nothing');
update public.invitations set delivery_status = 'sent', delivery_attempts = 3, delivery_provider = 'resend', delivery_message_id = 'msg-a-1', delivery_last_error = null, delivery_next_attempt_at = null
where id = '0a000000-0000-0000-0000-0000000007a1';
select pg_temp.assert_eq((select count(*) from public.email_messages where invitation_id = '0a000000-0000-0000-0000-0000000007a1' and status = 'sent' and provider = 'resend'
  and provider_message_id = 'msg-a-1' and sent_at is not null and last_error is null and attempts = 3), 1, 'the sent e-mail carries the provider and its message id');
update public.invitations set revoked_at = now() where id = '0b000000-0000-0000-0000-0000000007b1';
select pg_temp.assert_eq((select count(*) from public.email_messages where invitation_id = '0b000000-0000-0000-0000-0000000007b1' and status = 'skipped' and last_error = 'invitation_revoked'), 1, 'an invitation revoked before its e-mail went out: skipped');
update public.invitations set revoked_at = now() where id = '0a000000-0000-0000-0000-0000000007a1';
select pg_temp.assert_eq((select count(*) from public.email_messages where invitation_id = '0a000000-0000-0000-0000-0000000007a1' and status = 'sent'), 1, 'revoking after the e-mail was sent keeps it sent');

update public.notification_deliveries set attempts = 1, error = 'timeout', next_attempt_at = now() + interval '5 minutes' where notification_id = '0a000000-0000-0000-0000-0000000007c1' and channel = 'EMAIL';
select pg_temp.assert_eq((select count(*) from public.email_messages m join public.notification_deliveries d on d.id = m.notification_delivery_id where d.notification_id = '0a000000-0000-0000-0000-0000000007c1' and m.status = 'retrying' and m.last_error = 'timeout'), 1, 'a notification e-mail that failed once is retrying');
update public.notification_deliveries set status = 'sent', provider = 'resend', provider_message_id = 'msg-n-1', attempts = 2, error = null, sent_at = now(), next_attempt_at = null
where notification_id = '0a000000-0000-0000-0000-0000000007c1' and channel = 'EMAIL';
select pg_temp.assert_eq((select count(*) from public.email_messages where provider_message_id = 'msg-n-1' and status = 'sent' and attempts = 2), 1, 'the notification e-mail is sent');

select pg_temp.assert_raises($q$ update public.email_events set detail = 'rewritten' $q$, 'the timeline is append-only');
select pg_temp.assert_raises($q$ select app.record_email_provider_event('resend', 'msg-a-1', 'delivered', now(), null, 'evt-0') $q$, 'provider events need the platform context');

-- the webhook, as the API records it
select pg_temp.as_platform();
select pg_temp.assert_text(app.record_email_provider_event('resend', 'msg-a-1', 'delivered', now(), null, 'evt-1'), 'recorded', 'a delivery event is recorded');
select pg_temp.assert_text(app.record_email_provider_event('resend', 'msg-a-1', 'delivered', now(), null, 'evt-1'), 'duplicate', 'the same provider event twice is recorded once');
select pg_temp.assert_text(app.record_email_provider_event('resend', 'msg-unknown', 'delivered', now(), null, 'evt-2'), 'unknown_message', 'an event for a message nobody sent is not recorded');
select pg_temp.assert_text(app.record_email_provider_event('resend', 'msg-a-1', 'sent', now(), null, 'evt-3'), 'ignored', 'events outside the vocabulary are ignored');
select pg_temp.assert_text(app.record_email_provider_event('console', 'msg-a-1', 'bounced', now(), null, 'evt-4'), 'unknown_message', 'the message id is matched per provider');
select pg_temp.assert_text(app.record_email_provider_event('resend', 'msg-a-1', 'opened', now(), null, 'evt-5'), 'recorded', 'the first open is recorded');
select pg_temp.assert_text(app.record_email_provider_event('resend', 'msg-a-1', 'opened', now(), null, 'evt-6'), 'duplicate', 'later opens are not');
select pg_temp.assert_text(app.record_email_provider_event('resend', 'msg-n-1', 'bounced', now(), 'Mailbox does not exist', 'evt-7'), 'recorded', 'a bounce is recorded');
reset role;
select pg_temp.assert_eq((select count(*) from public.email_messages where provider_message_id = 'msg-a-1' and status = 'delivered' and delivered_at is not null and opened_at is not null), 1, 'the invitation e-mail reads delivered and opened');
select pg_temp.assert_eq((select count(*) from public.email_messages where provider_message_id = 'msg-n-1' and status = 'bounced' and bounced_at is not null and last_error = 'Mailbox does not exist'), 1, 'the notification e-mail reads bounced, with the reason');
select pg_temp.assert_eq((select count(*) from public.email_events where provider_event_id is not null), 3, 'three provider events in the timelines');
select pg_temp.assert_eq((select count(*) from public.email_events e join public.email_messages m on m.id = e.message_id where m.organization_id is distinct from e.organization_id), 0, 'every event carries its message''s organisation');

-- a re-queued invitation e-mail starts over; its timeline keeps the history
update public.invitations set revoked_at = null, delivery_status = 'failed', delivery_last_error = 'email send failed: bad address' where id = '0b000000-0000-0000-0000-0000000007b1';
update public.invitations set delivery_status = 'queued', delivery_attempts = 0, delivery_last_error = null where id = '0b000000-0000-0000-0000-0000000007b1';
select pg_temp.assert_eq((select count(*) from public.email_messages where invitation_id = '0b000000-0000-0000-0000-0000000007b1' and status = 'queued' and last_error is null and attempts = 0), 1, 'a re-queued e-mail is queued again');
select pg_temp.assert_eq((select count(*) from public.email_events e join public.email_messages m on m.id = e.message_id where m.invitation_id = '0b000000-0000-0000-0000-0000000007b1'), 4, '...after queued, skipped and failed');
-- deleting the source deletes its log (retention follows the source)
delete from public.notification_deliveries where notification_id = '0a000000-0000-0000-0000-0000000007c1';
select pg_temp.assert_eq((select count(*) from public.email_messages where provider_message_id = 'msg-n-1'), 0, 'the log of a purged delivery goes with it');
rollback;

-- ---------- readers: org-wide audit viewers of the organisation only ----------
begin;
select pg_temp.mail_fixtures();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.email_messages), 2, 'owner A reads organisation A''s e-mails');
select pg_temp.assert_eq((select count(*) from public.email_messages where organization_id <> '0a000000-0000-0000-0000-000000000000'), 0, '...and no other organisation''s');
select pg_temp.assert_eq((select count(*) from public.email_events), 2, 'owner A reads the timelines of organisation A');
select pg_temp.assert_raises($q$ insert into public.email_messages (organization_id, invitation_id, category, recipient) values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000007a1', 'invitation', 'forged@test.local') $q$, 'clients cannot write the log');
select pg_temp.assert_raises($q$ update public.email_messages set status = 'delivered' $q$, 'clients cannot change the log');
select pg_temp.assert_raises($q$ delete from public.email_events $q$, 'clients cannot delete the timeline');
select pg_temp.assert_raises($q$ select app.record_email_provider_event('resend', 'x', 'delivered', now(), null, 'evt-x') $q$, 'clients cannot record provider events');
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000007","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.email_messages), 2, 'the auditor of A reads the log');
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.email_messages), 0, 'an employee without audit.view reads nothing, not even their own e-mail');
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.email_messages), 1, 'owner B reads organisation B''s e-mail only');
reset role;
-- a branch-restricted member holding audit.view: the log spans every branch, so nothing
update public.org_memberships set role_id = '10000000-0000-0000-0000-000000000006' where id = '0a000000-0000-0000-0000-0000000000a2';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select pg_temp.assert_eq((select count(*) from public.email_messages), 0, 'a branch-restricted audit viewer reads nothing');
reset role;
-- the system context of A reads A's log only and cannot write it
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system","org_id":"0a000000-0000-0000-0000-000000000000"}', true);
select pg_temp.assert_eq((select count(*) from public.email_messages), 2, 'the system context of A reads A''s log');
select pg_temp.assert_eq((select count(*) from public.email_messages where organization_id <> '0a000000-0000-0000-0000-000000000000'), 0, '...only');
select pg_temp.assert_raises($q$ insert into public.email_events (organization_id, message_id, event) select organization_id, id, 'delivered' from public.email_messages limit 1 $q$, 'the system context does not write the log directly');
reset role;
rollback;

\echo 'rls_email_log: all assertions passed'
