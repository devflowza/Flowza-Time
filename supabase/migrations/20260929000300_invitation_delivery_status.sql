-- Invitation e-mail delivery status (users & roles: "send the invitation, retry when it fails, show the status").
--
-- The worker already e-mails every invitation (SEND_INVITATION_EMAIL, 5 attempts with exponential backoff), but the only
-- trace of it on the row was `delivery_sent_at`: a send that was still retrying, or that had given up, looked the same as one
-- that was never attempted, and an administrator had no way to try again short of issuing a new invitation. The row now
-- carries the delivery state the worker writes on every attempt:
--
--   delivery_status          none (no e-mail queued) | queued | retrying (an attempt failed, the queue retries) | sent | failed
--                            (every attempt failed, or the provider refused the message) — an administrator can queue it again
--   delivery_attempts        attempts made by the current e-mail job (reset when an administrator queues it again)
--   delivery_last_error      the provider's reason for the last failed attempt (never a token; cut to 500 characters)
--   delivery_last_attempt_at when the worker last tried
--   delivery_next_attempt_at when the queue will try again (approximate: the queue adds jitter), while `retrying`
--   delivery_provider        which mailer accepted the message ('resend'; 'console' means e-mail is not configured)
--
-- Backfill: an invitation the worker already sent is `sent`; every other row keeps `none` (its job, if any, has finished or
-- will write its own state when it runs).
--
-- Idempotent and one transaction. Additive: new nullable / defaulted columns (a constant default is a catalogue-only change).

set lock_timeout = '5s';
set statement_timeout = '120s';
set client_min_messages = warning;

alter table public.invitations add column if not exists delivery_status text not null default 'none';
alter table public.invitations add column if not exists delivery_attempts int not null default 0;
alter table public.invitations add column if not exists delivery_last_error text;
alter table public.invitations add column if not exists delivery_last_attempt_at timestamptz;
alter table public.invitations add column if not exists delivery_next_attempt_at timestamptz;
alter table public.invitations add column if not exists delivery_provider text;

comment on column public.invitations.delivery_status is 'E-mail delivery of the invitation: none | queued | retrying | sent | failed (written by the SEND_INVITATION_EMAIL worker job).';
comment on column public.invitations.delivery_attempts is 'Attempts made by the current invitation e-mail job.';
comment on column public.invitations.delivery_last_error is 'Why the last e-mail attempt failed (provider message, no secrets, at most 500 characters).';
comment on column public.invitations.delivery_next_attempt_at is 'Approximately when the queue retries the e-mail (while delivery_status = retrying).';
comment on column public.invitations.delivery_provider is 'The mailer that accepted the e-mail: resend | console (console = e-mail delivery is not configured).';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invitations_delivery_shape' and conrelid = 'public.invitations'::regclass) then
    alter table public.invitations add constraint invitations_delivery_shape check (
      delivery_status in ('none', 'queued', 'retrying', 'sent', 'failed')
      and delivery_attempts between 0 and 100
      and (delivery_last_error is null or char_length(delivery_last_error) <= 500)
      and (delivery_provider is null or char_length(delivery_provider) <= 40)
    );
  end if;
end $$;

update public.invitations set delivery_status = 'sent' where delivery_sent_at is not null and delivery_status = 'none';

-- post-verify ------------------------------------------------------------------------------------------------------------------
do $$
declare
  v_count int;
begin
  select count(*) into v_count from information_schema.columns
  where table_schema = 'public' and table_name = 'invitations'
    and column_name in ('delivery_status', 'delivery_attempts', 'delivery_last_error', 'delivery_last_attempt_at', 'delivery_next_attempt_at', 'delivery_provider');
  if v_count <> 6 then raise exception 'invitations: % of 6 delivery columns present', v_count; end if;
  if not exists (select 1 from pg_constraint where conname = 'invitations_delivery_shape' and conrelid = 'public.invitations'::regclass) then
    raise exception 'invitations_delivery_shape missing';
  end if;
  if not exists (select 1 from pg_class where oid = 'public.invitations'::regclass and relrowsecurity) then raise exception 'invitations lost row level security'; end if;
  if has_table_privilege('anon', 'public.invitations', 'select') then raise exception 'anon can read invitations'; end if;
end $$;
