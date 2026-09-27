-- FlowZa Time · 20260928000400 · Flowza Finance attendance connector (HR portal Prompt 9)
--
-- One credential pair — the serial + push token of a Finance virtual device (Finance `attendance_devices`, channel agent_rest) —
-- drives both directions of the sync:
--   pull : worker → Finance `attendance-export`  (Finance punches become raw transactions of the connector device)
--   push : worker → Finance `attendance-ingest`  (FlowZa Time punches — never the ones that were pulled from Finance)
--
-- 1. Permission integration.manage (Settings → Integrations) is Prompt 1's key (20260928000100: category `integrations`, granted to
--    owner + org_admin per the role matrix in docs/hr-portal/reports/01-roles-permissions.md). This migration does not redefine it
--    or widen its grants: it only makes sure the key exists (idempotent, never overwriting Prompt 1's row) and asserts it.
-- 2. Provider row flowza_finance — a mirror of packages/device-providers (pinned by registry.test.ts) — and one model row.
--    In FlowZa Time the connector is one `devices` row per organisation with provider_key = 'flowza_finance'.
-- 3. Feature flag provider_flowza_finance, default OFF: it hides the connector from the DEVICE WIZARD's provider list (the generic
--    device API refuses to create, edit, re-key or remove it anyway). The sanctioned path is Settings → Integrations, whose API
--    does not read the flag.
-- 4. sync_job_type gains PUSH_ATTENDANCE: the worker's push handler runs as an ordinary sync job item, so it shows in Sync pages.
--    (The value is not used inside this migration: PostgreSQL forbids using an enum value added in the same transaction.)
-- 5. domain_events.event_type accepts a third dotted segment for `sync.finance.failed` (3 consecutive connector failures).
-- 6. finance_sync_state — one row per connector device: the push keyset position, last pull/push, failure counters.
--    RLS: read with device.view (org level, not branch scoped: it carries counters and timestamps only); written by the system
--    context alone (apply_readonly_tenant_policies) — no client write policy and no client write grant, so a client write RAISES.
--    A platform-context select lets the scheduler find due pushes across organisations, like devices/sync_cursors.
-- 7. attendance_events (organization_id, created_at, id): the push walks events in CREATION order — `id` is a random uuid and
--    `punched_at` can be back-dated by corrections — keyed on (created_at, id) with a settle window in the worker.
--
-- Additive; no backfill. Bounded lock wait (hot-table rule).
set lock_timeout = '5s';
set statement_timeout = '120s';
set client_min_messages = warning;

-- 1. permission (owned by 20260928000100; restated with Prompt 1's exact values and `do nothing`, so it can never drift or clobber) ---
insert into public.permissions (key, category, description, sort_order) values
  ('integration.manage', 'integrations', 'Manage integrations and connectors (Finance sync, webhooks)', 25)
on conflict (key) do nothing;

-- 2. provider + model (values generated with definitionToRow(FLOWZA_FINANCE_DEFINITION)) ---------------------------------
insert into public.device_providers (key, vendor, name, description, integration_type, status, capabilities, config_schema, throttling, verification_status, docs_url, sort_order) values
  ('flowza_finance', 'FlowZa', 'Flowza Finance connector', 'Attendance connector to Flowza Finance (HR+): pulls Finance punches through attendance-export and pushes FlowZa Time punches to attendance-ingest, authenticated by one Finance virtual device (serial + token).',
    'VENDOR_CLOUD_PULL', 'beta',
    '{"attendancePull":true,"attendancePush":false,"employeePush":false,"employeePull":false,"employeeDelete":false,"fingerprint":false,"face":false,"card":false,"pin":false,"deviceStatus":true,"remoteRestart":false,"webhooks":false,"devicePush":false,"biometricTemplatePush":false}',
    '{"fields":[{"key":"baseUrl","label":"Finance functions base URL","type":"url","required":false,"secret":false,"default":"https://ucjtxdmklhhhvayirwqe.supabase.co/functions/v1","help":"https://<project>.supabase.co/functions/v1 — attendance-export and attendance-ingest live under it."},{"key":"deviceSerial","label":"Finance device serial","type":"text","required":true,"secret":false,"help":"Serial of the virtual device registered in Finance (FLOWZA-TIME-<company code>)."},{"key":"token","label":"Finance push token","type":"password","required":true,"secret":true,"help":"Push token shown on the Finance device; whoever holds serial + token can read and write that organisation''s punches."},{"key":"direction","label":"Direction","type":"select","required":false,"secret":false,"options":["pull","push","both"],"default":"both"},{"key":"pinKey","label":"Employee identity sent as PIN","type":"select","required":false,"secret":false,"options":["employee_number","device_user_id","card_number"],"default":"employee_number","help":"Finance maps PIN = employee number unless a PIN mapping says otherwise."},{"key":"pollMinutes","label":"Poll interval (min)","type":"number","required":false,"secret":false,"default":10,"help":"5–60 minutes between pulls and pushes."}]}',
    '{"maxConcurrentPerDevice":1,"maxConcurrentPerAccount":2,"requestsPerMinute":60}', 'REPORTED', null, 5)
on conflict (key) do update set vendor = excluded.vendor, name = excluded.name, description = excluded.description, integration_type = excluded.integration_type,
  status = excluded.status, capabilities = excluded.capabilities, config_schema = excluded.config_schema, throttling = excluded.throttling,
  verification_status = excluded.verification_status, docs_url = excluded.docs_url, sort_order = excluded.sort_order, updated_at = now();

insert into public.device_models (provider_key, vendor, model, family, capabilities, verification, notes) values
  ('flowza_finance', 'FlowZa', 'Flowza Finance connector', 'Integration', '{"attendancePull":true,"fingerprint":false,"face":false,"card":false}', 'REPORTED',
   'Virtual device: one per organisation, created from Settings → Integrations. Not a terminal — never a target for employee sync.')
on conflict (provider_key, model) do update set capabilities = excluded.capabilities, verification = excluded.verification, notes = excluded.notes;

-- 3. feature flag (device wizard only) ------------------------------------------------------------------------------------
insert into public.feature_flags (key, description, default_enabled, rollout_percentage) values
  ('provider_flowza_finance', 'Show the Flowza Finance connector in the device wizard (the connector is normally created from Settings → Integrations)', false, 0)
on conflict (key) do update set description = excluded.description;

-- 4. sync job type ------------------------------------------------------------------------------------------------------------
alter type public.sync_job_type add value if not exists 'PUSH_ATTENDANCE';

-- 5. three-segment domain event types --------------------------------------------------------------------------------------
alter table public.domain_events drop constraint if exists domain_events_event_type_check;
alter table public.domain_events add constraint domain_events_event_type_check check (event_type ~ '^[a-z_]+(\.[a-z_]+){1,2}$') not valid;
alter table public.domain_events validate constraint domain_events_event_type_check;

-- 6. connector state ------------------------------------------------------------------------------------------------------------
create table if not exists public.finance_sync_state (
  device_id uuid primary key references public.devices(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- push keyset position: the last attendance event delivered to Finance (created_at, id) — advanced only after a 2xx
  last_pushed_event_id uuid,
  last_pushed_event_at timestamptz,
  last_push_at timestamptz,
  last_push_count int not null default 0 check (last_push_count >= 0),
  next_push_at timestamptz,
  last_pull_at timestamptz,
  last_pull_count int not null default 0 check (last_pull_count >= 0),
  last_error text check (last_error is null or length(last_error) <= 2000),
  last_error_at timestamptz,
  consecutive_failures int not null default 0 check (consecutive_failures >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_sync_state_device_org_fkey foreign key (device_id, organization_id) references public.devices(id, organization_id) on delete cascade,
  constraint finance_sync_state_keyset_check check ((last_pushed_event_id is null) = (last_pushed_event_at is null))
);
comment on table public.finance_sync_state is 'Flowza Finance connector: per connector device push position, last pull/push and failure counters. System-written; read with device.view.';
create index if not exists finance_sync_state_org_idx on public.finance_sync_state (organization_id);
create index if not exists finance_sync_state_push_due_idx on public.finance_sync_state (next_push_at);
drop trigger if exists finance_sync_state_updated_at on public.finance_sync_state;
create trigger finance_sync_state_updated_at before update on public.finance_sync_state for each row execute function app.set_updated_at();

call app.apply_readonly_tenant_policies('public.finance_sync_state', 'device.view');
drop policy if exists finance_sync_state_platform_ctx on public.finance_sync_state;
create policy finance_sync_state_platform_ctx on public.finance_sync_state for select to flowza_system using ((select app.is_platform_context()));
-- The schema default privileges grant authenticated insert/update/delete; take them back so a client write raises rather than
-- filtering to zero rows (the state is the worker's, never the browser's).
revoke insert, update, delete on public.finance_sync_state from authenticated;

-- 7. creation-order index for the push ----------------------------------------------------------------------------------
create index if not exists attendance_events_org_created_idx on public.attendance_events (organization_id, created_at, id);

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

-- Post-verify: the pieces the worker and the API rely on.
do $$
begin
  if not exists (select 1 from public.permissions where key = 'integration.manage') then raise exception 'integration.manage missing'; end if;
  if not exists (select 1 from public.role_permissions where role_id = '10000000-0000-0000-0000-000000000001' and permission_key = 'integration.manage') then raise exception 'integration.manage not granted to the owner role (20260928000100)'; end if;
  if not exists (select 1 from public.device_providers where key = 'flowza_finance' and status = 'beta') then raise exception 'flowza_finance provider row missing'; end if;
  if not exists (select 1 from public.device_models where provider_key = 'flowza_finance') then raise exception 'flowza_finance model row missing'; end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_sync_state' and policyname = 'finance_sync_state_system_write') then raise exception 'finance_sync_state system write policy missing'; end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_sync_state' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL') and 'authenticated' = any (roles)) then raise exception 'finance_sync_state must have no client write policy'; end if;
  if has_table_privilege('authenticated', 'public.finance_sync_state', 'insert') or has_table_privilege('authenticated', 'public.finance_sync_state', 'update')
     or has_table_privilege('authenticated', 'public.finance_sync_state', 'delete') then raise exception 'authenticated must not hold write privileges on finance_sync_state'; end if;
  if not exists (select 1 from pg_constraint where conname = 'domain_events_event_type_check' and convalidated) then raise exception 'domain_events event type check not validated'; end if;
end $$;
