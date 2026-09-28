-- FlowZa Time · 20260928000450 · Flowza Finance connector — review fixes (HR portal Prompt 9 review, /tmp/p9-review.md)
--
-- 1. Provider row flowza_finance gains the optional config field `syncFrom` (the connector's start date). Values generated with
--    definitionToRow(FLOWZA_FINANCE_DEFINITION); registry.test.ts reads this file after 20260928000400 and pins the row.
-- 2. finance_pushed_events — the push LEDGER (review D4 / D11). The push used to walk attendance_events by a (created_at, id)
--    keyset: `created_at` is the INSERTING transaction's start time, so an event committed after the keyset had moved past it was
--    never pushed. Each run now scans a window [position − 15 min overlap, now − settle] and pushes the events of that window that
--    are NOT in this ledger, then records them here; a late commit inside the overlap is therefore still pushed, and a punch is
--    never sent twice by FlowZa Time. Rows are pruned after 2 days (and never while they are inside the overlap window).
--    RLS exactly like finance_sync_state: readable with device.view, written only by the system context of the same
--    organisation, INSERT/UPDATE/DELETE revoked from authenticated (a client write raises).
-- 3. finance_sync_state: `push_position_at` (the window anchor; last_pushed_event_* become informational), and the poison-batch
--    counters `push_retry_event_id` / `push_retry_attempts` (review D3: a 2xx answer with per-punch errors does not advance; the
--    same batch is retried and skipped only after 5 attempts, with an alert).
-- 4. Existing connectors: a push-only connector is not pull-capable (review D6: `devices.capabilities.attendancePull = false`,
--    auto-sync off), and every connector gets a start date (30 days before it was created) so the new lower bound never
--    drops punches that were already in scope.
--
-- Additive; one small backfill of connector rows (one per organisation). No enum value is added and no index is built on a hot
-- table, so the whole file also runs as ONE transaction (the hosted apply). Bounded lock wait.
set lock_timeout = '5s';
set statement_timeout = '120s';
set client_min_messages = warning;

-- 1. provider row ------------------------------------------------------------------------------------------------------------
insert into public.device_providers (key, vendor, name, description, integration_type, status, capabilities, config_schema, throttling, verification_status, docs_url, sort_order) values
  ('flowza_finance', 'FlowZa', 'Flowza Finance connector', 'Attendance connector to Flowza Finance (HR+): pulls Finance punches through attendance-export and pushes FlowZa Time punches to attendance-ingest, authenticated by one Finance virtual device (serial + token).',
    'VENDOR_CLOUD_PULL', 'beta',
    '{"attendancePull":true,"attendancePush":false,"employeePush":false,"employeePull":false,"employeeDelete":false,"fingerprint":false,"face":false,"card":false,"pin":false,"deviceStatus":true,"remoteRestart":false,"webhooks":false,"devicePush":false,"biometricTemplatePush":false}',
    '{"fields":[{"key":"baseUrl","label":"Finance functions base URL","type":"url","required":false,"secret":false,"default":"https://ucjtxdmklhhhvayirwqe.supabase.co/functions/v1","help":"https://<project>.supabase.co/functions/v1 — attendance-export and attendance-ingest live under it."},{"key":"deviceSerial","label":"Finance device serial","type":"text","required":true,"secret":false,"help":"Serial of the virtual device registered in Finance (FLOWZA-TIME-<company code>)."},{"key":"token","label":"Finance push token","type":"password","required":true,"secret":true,"help":"Push token shown on the Finance device; whoever holds serial + token can read and write that organisation''s punches."},{"key":"direction","label":"Direction","type":"select","required":false,"secret":false,"options":["pull","push","both"],"default":"both"},{"key":"pinKey","label":"Employee identity sent as PIN","type":"select","required":false,"secret":false,"options":["employee_number","device_user_id","card_number"],"default":"employee_number","help":"Finance maps PIN = employee number unless a PIN mapping says otherwise."},{"key":"pollMinutes","label":"Poll interval (min)","type":"number","required":false,"secret":false,"default":10,"help":"5–60 minutes between pulls and pushes."},{"key":"syncFrom","label":"Synchronise from","type":"text","required":false,"secret":false,"help":"YYYY-MM-DD in the connector timezone (default: 30 days before the connector was set up). Punches before it are never synchronised; the first pull and the first push start there."}]}',
    '{"maxConcurrentPerDevice":1,"maxConcurrentPerAccount":2,"requestsPerMinute":60}', 'REPORTED', null, 5)
on conflict (key) do update set vendor = excluded.vendor, name = excluded.name, description = excluded.description, integration_type = excluded.integration_type,
  status = excluded.status, capabilities = excluded.capabilities, config_schema = excluded.config_schema, throttling = excluded.throttling,
  verification_status = excluded.verification_status, docs_url = excluded.docs_url, sort_order = excluded.sort_order, updated_at = now();

-- 2. push ledger --------------------------------------------------------------------------------------------------------------
create table if not exists public.finance_pushed_events (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  device_id uuid not null,
  -- attendance_events.id (no FK: the events table is partitioned on punched_at and the ledger is pruned after 2 days)
  event_id uuid not null,
  pushed_at timestamptz not null default now(),
  -- pushed = Finance acknowledged it; no_pin = the employee has no value in the configured PIN field (skipped, counted);
  -- poison_skipped = Finance kept reporting per-punch errors for its batch 5 times and the batch was skipped (alerted)
  outcome text not null default 'pushed' check (outcome in ('pushed', 'no_pin', 'poison_skipped')),
  primary key (device_id, event_id),
  constraint finance_pushed_events_device_org_fkey foreign key (device_id, organization_id) references public.devices(id, organization_id) on delete cascade
);
comment on table public.finance_pushed_events is 'Flowza Finance connector push ledger: attendance events already handled by the push (pushed, skipped for a missing PIN, or skipped as a poison batch). Pruned after 2 days. System-written; read with device.view.';
create index if not exists finance_pushed_events_prune_idx on public.finance_pushed_events (device_id, pushed_at);
create index if not exists finance_pushed_events_org_idx on public.finance_pushed_events (organization_id);
call app.apply_readonly_tenant_policies('public.finance_pushed_events', 'device.view');
-- The schema default privileges grant authenticated insert/update/delete; take them back so a client write raises rather than
-- filtering to zero rows (the ledger is the worker's, never the browser's).
revoke insert, update, delete on public.finance_pushed_events from authenticated;

-- 3. push window anchor + poison-batch counters --------------------------------------------------------------------------------
alter table public.finance_sync_state add column if not exists push_position_at timestamptz;
alter table public.finance_sync_state add column if not exists push_retry_event_id uuid;
alter table public.finance_sync_state add column if not exists push_retry_attempts int not null default 0;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'finance_sync_state_push_retry_attempts_check') then
    alter table public.finance_sync_state add constraint finance_sync_state_push_retry_attempts_check check (push_retry_attempts >= 0);
  end if;
end $$;
comment on column public.finance_sync_state.push_position_at is 'Push window anchor: every eligible event created up to this instant has been examined; the next run scans from 15 minutes before it (late commits) and skips what finance_pushed_events already holds.';
comment on column public.finance_sync_state.push_retry_event_id is 'First event of a batch Finance answered with per-punch errors; retried until push_retry_attempts reaches 5, then skipped.';
comment on column public.finance_sync_state.last_pushed_event_id is 'Last event the push handled — delivered, or skipped for a missing PIN or as a poison batch (informational since 20260928000450; the push position is push_position_at).';
-- continuity for connectors that already pushed under the keyset of 20260928000400 (local databases only: not yet hosted)
update public.finance_sync_state set push_position_at = last_pushed_event_at where push_position_at is null and last_pushed_event_at is not null;

-- 4. existing connectors ------------------------------------------------------------------------------------------------------
update public.devices
   set capabilities = coalesce(capabilities, '{}'::jsonb) || jsonb_build_object('attendancePull', coalesce(config->>'direction', 'both') <> 'push'),
       auto_sync_enabled = auto_sync_enabled and coalesce(config->>'direction', 'both') <> 'push'
 where provider_key = 'flowza_finance'
   and ((capabilities->>'attendancePull')::boolean is distinct from (coalesce(config->>'direction', 'both') <> 'push')
        or (auto_sync_enabled and coalesce(config->>'direction', 'both') = 'push'));
update public.devices
   set config = coalesce(config, '{}'::jsonb) || jsonb_build_object('syncFrom', to_char((created_at at time zone timezone)::date - 30, 'YYYY-MM-DD'))
 where provider_key = 'flowza_finance' and not (coalesce(config, '{}'::jsonb) ? 'syncFrom');

-- Safety net (new tables must have RLS).
do $$
declare r record;
begin
  for r in select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p') and n.nspname in ('public', 'audit') and not c.relrowsecurity
             and c.relname not like '%\_default' and c.relname !~ '_\d{6}$'
  loop
    raise exception 'table %.% has no RLS', r.nspname, r.relname;
  end loop;
end $$;

-- Post-verify.
do $$
begin
  if not exists (select 1 from public.device_providers where key = 'flowza_finance' and config_schema->'fields' @> '[{"key":"syncFrom"}]') then raise exception 'flowza_finance provider row lacks syncFrom'; end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_pushed_events' and policyname = 'finance_pushed_events_system_write') then raise exception 'finance_pushed_events system write policy missing'; end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_pushed_events' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL') and 'authenticated' = any (roles)) then raise exception 'finance_pushed_events must have no client write policy'; end if;
  if has_table_privilege('authenticated', 'public.finance_pushed_events', 'insert') or has_table_privilege('authenticated', 'public.finance_pushed_events', 'update')
     or has_table_privilege('authenticated', 'public.finance_pushed_events', 'delete') then raise exception 'authenticated must not hold write privileges on finance_pushed_events'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'finance_sync_state' and column_name = 'push_position_at') then raise exception 'finance_sync_state.push_position_at missing'; end if;
  if exists (select 1 from public.devices where provider_key = 'flowza_finance' and coalesce(config->>'direction', 'both') = 'push' and ((capabilities->>'attendancePull')::boolean is distinct from false or auto_sync_enabled)) then
    raise exception 'a push-only Flowza Finance connector is still pull-capable';
  end if;
end $$;
