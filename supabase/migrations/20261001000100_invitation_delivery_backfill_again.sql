-- FlowZa Time · 20261001000100 · Invitations e-mailed by the old worker after 20260930000500 ran.
--
-- 20260930000500 marked every invitation the pre-20260929000300 worker had e-mailed (delivery_status 'none', delivery_sent_at
-- stamped) as 'sent' and seeded the e-mail log from them. But the API and worker on Fly stayed on that older build until the
-- deploy of 2026-10-01 07:48 UTC (the web had the new build since 2026-09-30), so invitations issued in between were again
-- created 'none' by the old API and e-mailed by the old worker without a status: they read "Not e-mailed" to the API's
-- resend check and are missing from the e-mail log, although the e-mail went out (delivery_sent_at, and the audit trail's
-- member.invitation_emailed with the provider's message id).
--
-- The same backfill as 20260930000500 §4, repeated with the invitations' e-mail-log trigger switched off for its duration:
-- the trigger would otherwise log these e-mails as sent "now" instead of when they were sent. Every statement is a no-op on
-- rows already backfilled, so the file is idempotent; on a fresh database it changes nothing.

set lock_timeout = '5s';
set statement_timeout = '300s';
set client_min_messages = warning;

alter table public.invitations disable trigger invitations_email_log;

-- (a) the invitations: sent, with the provider and message id the worker wrote to the audit trail
update public.invitations set delivery_status = 'sent' where delivery_status = 'none' and delivery_sent_at is not null;
with emailed as (
  select distinct on (a.entity_id) a.entity_id, a.new_value ->> 'provider' as provider, a.new_value ->> 'messageId' as message_id
  from audit.logs a
  where a.action = 'member.invitation_emailed' and a.entity_type = 'invitation' and a.entity_id is not null
  order by a.entity_id, a.created_at desc
)
update public.invitations i
set delivery_provider = coalesce(i.delivery_provider, left(e.provider, 40)), delivery_message_id = coalesce(i.delivery_message_id, left(e.message_id, 200))
from emailed e
where e.entity_id = i.id::text and i.delivery_status = 'sent' and (i.delivery_provider is null or i.delivery_message_id is null);

-- (b) their e-mail log entries, with the real timestamps
insert into public.email_messages (organization_id, invitation_id, category, recipient, status, provider, provider_message_id, attempts, created_at,
  last_attempt_at, sent_at)
select i.organization_id, i.id, 'invitation', left(i.email::text, 320), 'sent', left(i.delivery_provider, 40), left(i.delivery_message_id, 200),
  least(greatest(i.delivery_attempts, 0), 100), i.created_at, i.delivery_last_attempt_at, i.delivery_sent_at
from public.invitations i
where i.delivery_status = 'sent'
on conflict (invitation_id) do nothing;

-- (c) their timelines: queued when created, sent when the worker sent them
insert into public.email_events (organization_id, message_id, event, occurred_at, attempt, detail)
select s.organization_id, s.message_id, s.event, s.occurred_at, s.attempt, s.detail
from (
  select m.organization_id, m.id as message_id, 'queued' as event, m.created_at as occurred_at, null::int as attempt, null::text as detail, 1 as step
  from public.email_messages m
  where m.invitation_id is not null
  union all
  select m.organization_id, m.id, 'sent', greatest(coalesce(m.sent_at, m.created_at), m.created_at), m.attempts, m.provider, 2
  from public.email_messages m
  where m.invitation_id is not null and m.status = 'sent'
) s
where not exists (select 1 from public.email_events e where e.message_id = s.message_id)
order by s.occurred_at, s.step;

alter table public.invitations enable trigger invitations_email_log;

-- post-verify --------------------------------------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.invitations where delivery_status = 'none' and delivery_sent_at is not null) then
    raise exception 'invitations e-mailed but not marked sent remain';
  end if;
  if exists (select 1 from public.invitations i where i.delivery_status = 'sent' and not exists (select 1 from public.email_messages m where m.invitation_id = i.id)) then
    raise exception 'sent invitations missing from the e-mail log';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'invitations_email_log' and tgrelid = 'public.invitations'::regclass and tgenabled = 'O') then
    raise exception 'invitations_email_log must be enabled again';
  end if;
end $$;
