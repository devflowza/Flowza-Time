-- FlowZa Time · 20260930000500 · E-mail activity log ("the invitation says Sending… and no e-mail arrived — give us an e-mail
-- log to monitor").
--
-- Two kinds of e-mail leave FlowZa Time: invitation e-mails (worker job SEND_INVITATION_EMAIL; state on
-- public.invitations.delivery_*) and notification e-mails (DELIVER_NOTIFICATIONS; state on public.notification_deliveries).
-- Neither left a trail an administrator could read: an invitation row holds its latest state only, the delivery queue is
-- system-only, and what the provider did after accepting a message (delivered, bounced, marked as spam) was recorded nowhere.
--
--  1. public.email_messages — one row per e-mail: kind (invitation | notification), category (the notification type), recipient,
--     subject (the notice's title), status, provider + the provider's message id, attempts, the last error and when each stage
--     happened. Status: queued → retrying → sent | failed | skipped; then, from the provider's webhook, delivered | delayed |
--     bounced | complained (opened / clicked are timestamps, never a status).
--  2. public.email_events — the append-only timeline of each e-mail (queued, attempt_failed, sent, failed, skipped, delivered,
--     delayed, bounced, complained, opened, clicked, provider_failed, suppressed), idempotent on the provider's event id.
--  3. Kept by AFTER triggers on the two sources, in the transaction that changes them: every writer — the API queuing or
--     re-queuing an invitation, revoking it, the outbox relay, the worker's attempts, a future path — is logged without being
--     asked to, and a change that rolls back logs nothing. The trigger functions are SECURITY DEFINER (the log is written by
--     them only: no client or service role holds a write privilege or policy) and never fail the business write: a logging
--     error is a WARNING, the invitation / delivery change goes through.
--  4. app.record_email_provider_event(...) — the provider webhook (API, signature verified, platform context) records a
--     delivery event against the message it names. Unknown messages and repeated deliveries of an event are no-ops.
--  5. invitations.delivery_message_id — the provider's id of the invitation e-mail, written by the worker with the status.
--  6. Backfill: invitations e-mailed by a worker that predates 20260929000300 (deployed apart from the web) kept delivery_status
--     'none' with delivery_sent_at stamped — the users page showed them "Sending…" (a web build without the polling fix) or
--     "Not e-mailed"; they are 'sent', with the provider and message id that worker wrote to the audit trail. The log is seeded
--     from every invitation with an e-mail and every notification e-mail still in the queue table (90-day retention).
--
-- Read: members holding audit.view with access to every branch (the log names recipients across the organisation, whatever
-- their branch); e-mails of no organisation by platform administrators. Retention follows the sources (on delete cascade): a
-- notification e-mail leaves the log with its delivery row (notification retention job, 90 days), an invitation's with the
-- invitation.
--
-- Idempotent, one transaction. Additive: two new tables, one nullable column, three functions, two triggers.

set lock_timeout = '5s';
set statement_timeout = '300s';
set client_min_messages = warning;

-- 1. invitations.delivery_message_id ---------------------------------------------------------------------------------------------
alter table public.invitations add column if not exists delivery_message_id text;
comment on column public.invitations.delivery_message_id is 'The provider''s message id of the last invitation e-mail it accepted (links the invitation to its e-mail log entry and provider events).';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invitations_delivery_message_id_len' and conrelid = 'public.invitations'::regclass) then
    alter table public.invitations add constraint invitations_delivery_message_id_len check (delivery_message_id is null or char_length(delivery_message_id) <= 200);
  end if;
end $$;

-- 2. the log ---------------------------------------------------------------------------------------------------------------------
create table if not exists public.email_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  -- the source: exactly one of the two (kind follows from it)
  invitation_id uuid references public.invitations(id) on delete cascade,
  notification_delivery_id bigint references public.notification_deliveries(id) on delete cascade,
  kind text not null generated always as (case when invitation_id is not null then 'invitation' else 'notification' end) stored,
  category text not null check (char_length(category) between 1 and 100),
  recipient text not null check (char_length(recipient) between 1 and 320),
  recipient_user_id uuid references public.user_profiles(id) on delete set null,
  subject text check (subject is null or char_length(subject) <= 300),
  status text not null default 'queued'
    check (status in ('queued', 'retrying', 'sent', 'failed', 'skipped', 'delivered', 'delayed', 'bounced', 'complained')),
  provider text check (provider is null or char_length(provider) <= 40),
  provider_message_id text check (provider_message_id is null or char_length(provider_message_id) <= 200),
  attempts int not null default 0 check (attempts between 0 and 100),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  bounced_at timestamptz,
  complained_at timestamptz,
  constraint email_messages_source check (num_nonnulls(invitation_id, notification_delivery_id) = 1),
  constraint email_messages_invitation_key unique (invitation_id),
  constraint email_messages_delivery_key unique (notification_delivery_id)
);
comment on table public.email_messages is 'E-mail activity log: one row per invitation / notification e-mail (status, provider message id, attempts, provider delivery events). Written only by the SECURITY DEFINER triggers on invitations / notification_deliveries and app.record_email_provider_event.';
create index if not exists email_messages_org_created_idx on public.email_messages (organization_id, created_at desc);
create index if not exists email_messages_org_status_idx on public.email_messages (organization_id, status, created_at desc);
create index if not exists email_messages_provider_message_idx on public.email_messages (provider_message_id) where provider_message_id is not null;
create index if not exists email_messages_recipient_user_idx on public.email_messages (recipient_user_id) where recipient_user_id is not null;
drop trigger if exists email_messages_updated_at on public.email_messages;
create trigger email_messages_updated_at before update on public.email_messages for each row execute function app.set_updated_at();

create table if not exists public.email_events (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations(id) on delete cascade,
  message_id uuid not null references public.email_messages(id) on delete cascade,
  event text not null check (event in ('queued', 'attempt_failed', 'sent', 'failed', 'skipped', 'delivered', 'delayed', 'bounced',
                                        'complained', 'opened', 'clicked', 'provider_failed', 'suppressed')),
  occurred_at timestamptz not null default now(),
  attempt int check (attempt is null or attempt between 0 and 100),
  detail text check (detail is null or char_length(detail) <= 500),
  provider_event_id text check (provider_event_id is null or char_length(provider_event_id) <= 200),
  created_at timestamptz not null default now()
);
comment on table public.email_events is 'Append-only timeline of each e-mail of public.email_messages (pipeline steps and provider delivery events). Deleted only with its message.';
create index if not exists email_events_org_created_idx on public.email_events (organization_id, created_at desc);
create index if not exists email_events_message_idx on public.email_events (message_id, occurred_at, id);
create unique index if not exists email_events_provider_event_key on public.email_events (provider_event_id) where provider_event_id is not null;
-- append-only: no update ever; a delete happens only through the cascade of its message (retention of the source rows)
drop trigger if exists email_events_append_only on public.email_events;
create trigger email_events_append_only before update on public.email_events for each row execute function app.reject_modification();

-- RLS: org-wide audit viewers read; nobody writes through a policy (the definer functions below are the only writers)
alter table public.email_messages enable row level security;
alter table public.email_events enable row level security;
drop policy if exists email_messages_select on public.email_messages;
create policy email_messages_select on public.email_messages for select to authenticated, flowza_system using (
  (organization_id = any ((select app.org_ids_with_permission('audit.view'))::uuid[]) and organization_id = any ((select app.unrestricted_org_ids())::uuid[]))
  or (organization_id is null and (select app.is_platform_admin()))
);
drop policy if exists email_events_select on public.email_events;
create policy email_events_select on public.email_events for select to authenticated, flowza_system using (
  (organization_id = any ((select app.org_ids_with_permission('audit.view'))::uuid[]) and organization_id = any ((select app.unrestricted_org_ids())::uuid[]))
  or (organization_id is null and (select app.is_platform_admin()))
);
grant select on public.email_messages, public.email_events to authenticated, flowza_system;
revoke insert, update, delete on public.email_messages, public.email_events from flowza_system;
call app.enforce_tenant_table('public.email_messages');
call app.enforce_tenant_table('public.email_events');
call app.forbid_client_writes('public.email_messages');
call app.forbid_client_writes('public.email_events');

-- 3. writers ---------------------------------------------------------------------------------------------------------------------
-- One step of an e-mail's life: the message is created on its first step, then moved; every step appends its event.
--   p_event: queued | attempt_failed | sent | failed | skipped. `queued` again (an administrator re-queued a failed invitation
--   e-mail) starts the message over; the timeline keeps what came before.
create or replace function app.email_log_step(
  p_org uuid, p_invitation_id uuid, p_delivery_id bigint, p_category text, p_recipient text, p_recipient_user_id uuid,
  p_subject text, p_event text, p_attempts int, p_detail text, p_provider text, p_provider_message_id text, p_next_attempt_at timestamptz
) returns void language plpgsql set search_path = '' as $$
declare
  v_id uuid;
  v_status text := case p_event when 'attempt_failed' then 'retrying' else p_event end;
  v_attempts int := least(greatest(coalesce(p_attempts, 0), 0), 100);
  v_detail text := left(nullif(btrim(p_detail), ''), 500);
begin
  if p_invitation_id is not null then
    select m.id into v_id from public.email_messages m where m.invitation_id = p_invitation_id for update;
  else
    select m.id into v_id from public.email_messages m where m.notification_delivery_id = p_delivery_id for update;
  end if;
  if v_id is null then
    insert into public.email_messages (organization_id, invitation_id, notification_delivery_id, category, recipient, recipient_user_id, subject, status,
      provider, provider_message_id, attempts, last_error, last_attempt_at, next_attempt_at, sent_at)
    values (p_org, p_invitation_id, p_delivery_id, left(p_category, 100), left(p_recipient, 320), p_recipient_user_id, left(p_subject, 300), v_status,
      case when v_status = 'sent' then left(p_provider, 40) end, case when v_status = 'sent' then left(p_provider_message_id, 200) end,
      v_attempts, case when v_status in ('retrying', 'failed', 'skipped') then v_detail end,
      case when p_event in ('attempt_failed', 'sent', 'failed') then now() end, case when v_status = 'retrying' then p_next_attempt_at end,
      case when v_status = 'sent' then now() end)
    returning id into v_id;
  elsif v_status = 'queued' then
    update public.email_messages set status = 'queued', attempts = v_attempts, last_error = null, next_attempt_at = null, provider = null, provider_message_id = null,
      sent_at = null, delivered_at = null, opened_at = null, clicked_at = null, bounced_at = null, complained_at = null
    where id = v_id;
  elsif v_status = 'sent' then
    update public.email_messages set status = 'sent', attempts = v_attempts, last_error = null, next_attempt_at = null, last_attempt_at = now(), sent_at = now(),
      provider = left(p_provider, 40), provider_message_id = left(p_provider_message_id, 200), recipient = left(p_recipient, 320)
    where id = v_id;
  elsif v_status = 'skipped' then
    update public.email_messages set status = 'skipped', last_error = v_detail, next_attempt_at = null where id = v_id;
  else -- retrying | failed
    update public.email_messages set status = v_status, attempts = v_attempts, last_error = v_detail, last_attempt_at = now(),
      next_attempt_at = case when v_status = 'retrying' then p_next_attempt_at end
    where id = v_id;
  end if;
  insert into public.email_events (organization_id, message_id, event, attempt, detail)
  values (p_org, v_id, p_event, case when p_event in ('attempt_failed', 'sent', 'failed') then v_attempts end,
          case when p_event = 'sent' then left(p_provider, 40) else v_detail end);
end $$;
comment on function app.email_log_step(uuid, uuid, bigint, text, text, uuid, text, text, int, text, text, text, timestamptz) is
  'E-mail activity log: one pipeline step of an e-mail (called by the source-table triggers only).';

-- invitations: queued on issue / re-queue, attempt_failed / failed / sent from the worker, skipped when the invitation is revoked
-- or accepted while its e-mail is still waiting (the job then sends nothing)
create or replace function app.email_log_invitation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_event text;
  v_detail text;
begin
  if tg_op = 'INSERT' then
    if new.delivery_status = 'queued' then v_event := 'queued'; end if;
  else
    if new.delivery_status is distinct from old.delivery_status or new.delivery_attempts is distinct from old.delivery_attempts then
      v_event := case
        when new.delivery_status = 'queued' and old.delivery_status is distinct from 'queued' then 'queued'
        when new.delivery_status = 'retrying' then 'attempt_failed'
        when new.delivery_status = 'failed' and old.delivery_status is distinct from 'failed' then 'failed'
        when new.delivery_status = 'sent' and old.delivery_status is distinct from 'sent' then 'sent'
      end;
    end if;
    if v_event is null and new.delivery_status in ('queued', 'retrying')
       and ((old.revoked_at is null and new.revoked_at is not null) or (old.accepted_at is null and new.accepted_at is not null)) then
      v_event := 'skipped';
      v_detail := case when new.revoked_at is not null then 'invitation_revoked' else 'invitation_accepted' end;
    end if;
  end if;
  if v_event is null then return null; end if;
  begin
    perform app.email_log_step(new.organization_id, new.id, null, 'invitation', new.email::text, null, null, v_event, new.delivery_attempts,
      coalesce(v_detail, new.delivery_last_error), new.delivery_provider, new.delivery_message_id, new.delivery_next_attempt_at);
  exception when others then
    raise warning 'email log: invitation % step % not recorded: %', new.id, v_event, sqlerrm;
  end;
  return null;
end $$;

-- notification e-mails: queued when the relay creates the delivery, then the worker's attempts (pending with more attempts = a
-- failed attempt that will be retried), sent / failed / skipped
create or replace function app.email_log_notification_delivery() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_event text;
  v_user uuid;
  v_type text;
  v_title text;
  v_email text;
begin
  if tg_op = 'INSERT' then
    v_event := case new.status::text when 'pending' then 'queued' else new.status::text end;
  elsif new.status is distinct from old.status or new.attempts is distinct from old.attempts then
    v_event := case
      when new.status::text = 'pending' and new.attempts > old.attempts then 'attempt_failed'
      when new.status::text = 'pending' and old.status::text <> 'pending' then 'queued'
      when new.status::text in ('sent', 'failed', 'skipped') and new.status is distinct from old.status then new.status::text
    end;
  end if;
  if v_event is null then return null; end if;
  begin
    select n.user_id, n.type, n.title, u.email::text into v_user, v_type, v_title, v_email
    from public.notifications n left join public.user_profiles u on u.id = n.user_id
    where n.id = new.notification_id;
    perform app.email_log_step(new.organization_id, null, new.id, coalesce(nullif(v_type, ''), 'notification'), coalesce(nullif(v_email, ''), '—'),
      v_user, v_title, v_event, new.attempts, new.error, new.provider, new.provider_message_id, new.next_attempt_at);
  exception when others then
    raise warning 'email log: notification delivery % step % not recorded: %', new.id, v_event, sqlerrm;
  end;
  return null;
end $$;

-- the provider's delivery events (webhook; API, platform context). Returns recorded | duplicate | unknown_message | ignored.
--   p_event: delivered | delayed | bounced | complained | opened | clicked | provider_failed | suppressed
create or replace function app.record_email_provider_event(p_provider text, p_message_id text, p_event text, p_occurred_at timestamptz, p_detail text, p_event_id text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_msg public.email_messages%rowtype;
  v_at timestamptz := least(coalesce(p_occurred_at, now()), now() + interval '5 minutes');
  v_detail text := left(nullif(btrim(p_detail), ''), 500);
  v_event_id text := left(nullif(btrim(p_event_id), ''), 200);
begin
  if not app.is_platform_context() then raise exception 'platform context required' using errcode = '42501'; end if;
  if p_event is null or p_event not in ('delivered', 'delayed', 'bounced', 'complained', 'opened', 'clicked', 'provider_failed', 'suppressed') then return 'ignored'; end if;
  if p_provider is null or p_message_id is null or btrim(p_message_id) = '' then return 'ignored'; end if;
  select m.* into v_msg from public.email_messages m
  where m.provider_message_id = left(p_message_id, 200) and m.provider = left(p_provider, 40)
  order by m.created_at desc limit 1 for update;
  if not found then return 'unknown_message'; end if;
  if v_event_id is not null and exists (select 1 from public.email_events e where e.provider_event_id = v_event_id) then return 'duplicate'; end if;
  -- opens and clicks: the first one tells the story; every later one is noise
  if (p_event = 'opened' and v_msg.opened_at is not null) or (p_event = 'clicked' and v_msg.clicked_at is not null) then return 'duplicate'; end if;
  insert into public.email_events (organization_id, message_id, event, occurred_at, detail, provider_event_id)
  values (v_msg.organization_id, v_msg.id, p_event, v_at, v_detail, v_event_id)
  on conflict (provider_event_id) where provider_event_id is not null do nothing;
  if not found then return 'duplicate'; end if;
  update public.email_messages set
    status = case
      when p_event = 'bounced' then 'bounced'
      when p_event = 'complained' then 'complained'
      when p_event in ('provider_failed', 'suppressed') and status in ('sent', 'delayed') then 'failed'
      when p_event = 'delivered' and status in ('sent', 'delayed') then 'delivered'
      when p_event = 'delayed' and status = 'sent' then 'delayed'
      else status end,
    delivered_at = case when p_event = 'delivered' then coalesce(delivered_at, v_at) else delivered_at end,
    bounced_at = case when p_event = 'bounced' then coalesce(bounced_at, v_at) else bounced_at end,
    complained_at = case when p_event = 'complained' then coalesce(complained_at, v_at) else complained_at end,
    opened_at = case when p_event = 'opened' then coalesce(opened_at, v_at) else opened_at end,
    clicked_at = case when p_event = 'clicked' then coalesce(clicked_at, v_at) else clicked_at end,
    last_error = case when p_event in ('bounced', 'complained', 'provider_failed', 'suppressed', 'delayed') then coalesce(v_detail, last_error) else last_error end
  where id = v_msg.id;
  return 'recorded';
end $$;
comment on function app.record_email_provider_event(text, text, text, timestamptz, text, text) is
  'E-mail activity log: records a provider delivery event (webhook, signature verified by the API) against the message it names. Platform context only.';

revoke all on function app.email_log_step(uuid, uuid, bigint, text, text, uuid, text, text, int, text, text, text, timestamptz) from public, anon, authenticated, flowza_system, flowza_api, flowza_worker;
revoke all on function app.email_log_invitation() from public, anon, authenticated, flowza_system, flowza_api, flowza_worker;
revoke all on function app.email_log_notification_delivery() from public, anon, authenticated, flowza_system, flowza_api, flowza_worker;
revoke all on function app.record_email_provider_event(text, text, text, timestamptz, text, text) from public, anon, authenticated, flowza_api, flowza_worker;
grant execute on function app.record_email_provider_event(text, text, text, timestamptz, text, text) to flowza_system;

-- 4. backfill (before the triggers: the seed carries the real timestamps, not the migration's) -------------------------------------
-- (a) invitations the pre-20260929000300 worker e-mailed: sent, with the provider and message id it wrote to the audit trail
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

-- (b) the log: every invitation that has an e-mail, every notification e-mail still in the queue table
insert into public.email_messages (organization_id, invitation_id, category, recipient, status, provider, provider_message_id, attempts, last_error,
  created_at, last_attempt_at, next_attempt_at, sent_at)
select i.organization_id, i.id, 'invitation', left(i.email::text, 320),
  case when i.delivery_status in ('queued', 'retrying') and (i.revoked_at is not null or i.accepted_at is not null) then 'skipped' else i.delivery_status end,
  case when i.delivery_status = 'sent' then left(i.delivery_provider, 40) end, case when i.delivery_status = 'sent' then left(i.delivery_message_id, 200) end,
  least(greatest(i.delivery_attempts, 0), 100),
  case when i.delivery_status in ('queued', 'retrying') and i.revoked_at is not null then 'invitation_revoked'
       when i.delivery_status in ('queued', 'retrying') and i.accepted_at is not null then 'invitation_accepted'
       when i.delivery_status in ('retrying', 'failed') then left(i.delivery_last_error, 500) end,
  i.created_at, i.delivery_last_attempt_at, case when i.delivery_status = 'retrying' and i.revoked_at is null and i.accepted_at is null then i.delivery_next_attempt_at end,
  case when i.delivery_status = 'sent' then i.delivery_sent_at end
from public.invitations i
where i.delivery_status <> 'none'
on conflict (invitation_id) do nothing;

insert into public.email_messages (organization_id, notification_delivery_id, category, recipient, recipient_user_id, subject, status, provider,
  provider_message_id, attempts, last_error, created_at, last_attempt_at, next_attempt_at, sent_at)
select d.organization_id, d.id, left(coalesce(nullif(n.type, ''), 'notification'), 100), left(coalesce(nullif(u.email::text, ''), '—'), 320), n.user_id,
  left(n.title, 300),
  case when d.status::text = 'pending' then case when d.attempts > 0 then 'retrying' else 'queued' end else d.status::text end,
  left(d.provider, 40), left(d.provider_message_id, 200), least(greatest(d.attempts, 0), 100), left(d.error, 500),
  d.created_at, case when d.attempts > 0 then coalesce(d.sent_at, d.created_at) end,
  case when d.status::text = 'pending' and d.attempts > 0 then d.next_attempt_at end, d.sent_at
from public.notification_deliveries d
join public.notifications n on n.id = d.notification_id
left join public.user_profiles u on u.id = n.user_id
where d.channel::text = 'EMAIL'
on conflict (notification_delivery_id) do nothing;

-- (c) their timelines: queued when created, then where they stand
insert into public.email_events (organization_id, message_id, event, occurred_at, attempt, detail)
select s.organization_id, s.message_id, s.event, s.occurred_at, s.attempt, s.detail
from (
  select m.organization_id, m.id as message_id, 'queued' as event, m.created_at as occurred_at, null::int as attempt, null::text as detail, 1 as step
  from public.email_messages m
  union all
  select m.organization_id, m.id, case m.status when 'retrying' then 'attempt_failed' else m.status end,
    greatest(coalesce(case when m.status = 'sent' then m.sent_at end, m.last_attempt_at, m.created_at), m.created_at),
    case when m.status in ('retrying', 'sent', 'failed') then m.attempts end,
    case when m.status = 'sent' then m.provider else m.last_error end, 2
  from public.email_messages m
  where m.status <> 'queued'
) s
where not exists (select 1 from public.email_events e where e.message_id = s.message_id)
order by s.occurred_at, s.step;

-- 5. the triggers --------------------------------------------------------------------------------------------------------------
drop trigger if exists invitations_email_log on public.invitations;
create trigger invitations_email_log after insert or update of delivery_status, delivery_attempts, revoked_at, accepted_at on public.invitations
  for each row execute function app.email_log_invitation();
drop trigger if exists notification_deliveries_email_log on public.notification_deliveries;
create trigger notification_deliveries_email_log after insert or update of status, attempts on public.notification_deliveries
  for each row when (new.channel::text = 'EMAIL') execute function app.email_log_notification_delivery();

-- post-verify --------------------------------------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_class where oid = 'public.email_messages'::regclass and relrowsecurity) then raise exception 'email_messages without RLS'; end if;
  if not exists (select 1 from pg_class where oid = 'public.email_events'::regclass and relrowsecurity) then raise exception 'email_events without RLS'; end if;
  if has_table_privilege('authenticated', 'public.email_messages', 'insert') or has_table_privilege('authenticated', 'public.email_messages', 'update')
     or has_table_privilege('authenticated', 'public.email_events', 'insert') or has_table_privilege('flowza_system', 'public.email_messages', 'insert')
     or has_table_privilege('flowza_system', 'public.email_events', 'insert') then
    raise exception 'the e-mail log must not be writable by client or service roles';
  end if;
  if has_table_privilege('anon', 'public.email_messages', 'select') or has_table_privilege('anon', 'public.email_events', 'select') then raise exception 'anon can read the e-mail log'; end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'email_messages' and policyname = 'email_messages_select' and qual like '%audit.view%') then
    raise exception 'email_messages read policy must require audit.view';
  end if;
  if has_function_privilege('authenticated', 'app.record_email_provider_event(text, text, text, timestamptz, text, text)', 'execute') then
    raise exception 'record_email_provider_event must not be executable by authenticated';
  end if;
  if (select count(*) from pg_trigger where tgname in ('invitations_email_log', 'notification_deliveries_email_log') and not tgisinternal) <> 2 then raise exception 'e-mail log triggers missing'; end if;
  if exists (select 1 from public.invitations where delivery_status = 'none' and delivery_sent_at is not null) then raise exception 'invitations e-mailed but not marked sent remain'; end if;
end $$;
