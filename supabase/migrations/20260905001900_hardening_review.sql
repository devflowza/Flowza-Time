-- FlowZa Time · 1900 · hardening from the security/SRE review (docs/risks.md)
set client_min_messages = warning;

-- Vendor transaction-id resets / factory resets: track the device generation and include it in dedupe hashes.
alter table public.devices add column if not exists generation int not null default 1;
alter table public.devices add column if not exists consecutive_failures int not null default 0;
alter table public.devices add column if not exists last_clock_skew_seconds int;
alter table public.devices add column if not exists push_token_rotated_at timestamptz;

-- Raw transactions: timestamp provenance and quarantine/hold outcomes.
alter table public.attendance_raw_transactions add column if not exists assumed_timezone text;
alter table public.attendance_raw_transactions add column if not exists clock_skew_seconds int;
alter table public.attendance_raw_transactions add column if not exists device_generation int not null default 1;
alter type public.raw_processing_status add value if not exists 'quarantined';   -- implausible timestamp / skew beyond threshold
alter type public.raw_processing_status add value if not exists 'held';          -- punched inside a locked period; awaits HR decision

-- Cursor validation and operator rewind history.
alter table public.sync_cursors add column if not exists previous_cursor jsonb;
alter table public.sync_cursors add column if not exists rewound_at timestamptz;
alter table public.sync_cursors add column if not exists rewound_by uuid;
alter table public.sync_cursors add column if not exists rewind_reason text;
alter table public.sync_cursors add column if not exists invalid_since timestamptz;

-- Circuit breaker per (organisation, provider, vendor account): outage ≠ device offline.
create type public.circuit_state as enum ('closed', 'open', 'half_open');
create table public.provider_circuit_states (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider_key text not null references public.device_providers(key),
  account_key text not null default 'default',
  state public.circuit_state not null default 'closed',
  failure_count int not null default 0,
  opened_at timestamptz,
  half_open_at timestamptz,
  last_error_code text,
  last_error text,
  updated_at timestamptz not null default now(),
  unique (organization_id, provider_key, account_key)
);
create trigger provider_circuit_states_updated_at before update on public.provider_circuit_states for each row execute function app.set_updated_at();
call app.apply_readonly_tenant_policies('public.provider_circuit_states', 'device.view');
alter type public.connection_status add value if not exists 'vendor_degraded';

-- Platform privileged access: default 8h, hard max 72h; write grants record a second approver.
alter table public.platform_access_grants drop constraint if exists platform_access_grants_window;
alter table public.platform_access_grants add constraint platform_access_grants_window check (expires_at > starts_at and expires_at <= starts_at + interval '72 hours');
alter table public.platform_access_grants add column if not exists approved_by uuid references public.user_profiles(id);
alter table public.platform_access_grants add constraint platform_access_grants_write_needs_approval check (access_level = 'read' or approved_by is not null);

-- Custom roles cannot grant permissions the actor does not hold (no privilege escalation).
create or replace function app.enforce_no_privilege_escalation() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_system boolean;
begin
  select organization_id into v_org from public.roles where id = new.role_id;
  if v_org is null then
    -- system roles are reference data; only migrations/system may touch them
    if not app.is_system() and session_user not in ('postgres', 'supabase_admin') then
      raise exception 'system roles are immutable' using errcode = '42501';
    end if;
    return new;
  end if;
  v_system := app.is_system();
  if not v_system and not app.has_permission(v_org, new.permission_key) then
    raise exception 'cannot grant permission % you do not hold', new.permission_key using errcode = '42501';
  end if;
  return new;
end $$;
create trigger role_permissions_no_escalation before insert or update on public.role_permissions for each row execute function app.enforce_no_privilege_escalation();

-- Legal hold blocks retention purges for an organisation.
alter table public.organizations add column if not exists legal_hold boolean not null default false;
alter table public.organizations add column if not exists legal_hold_reason text;

-- Security contact for incident notifications (per organisation).
alter table public.organizations add column if not exists security_contact_email extensions.citext;

-- Queue table maintenance: aggressive autovacuum on the hot queue table.
alter table jobs.queue set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_cost_delay = 2);
alter table jobs.queue_archive set (autovacuum_vacuum_scale_factor = 0.05);

-- Per-organisation quotas used by the API/worker for admission control (manual syncs, imports, exports per hour/day).
create table public.usage_quotas (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  metric text not null,
  window_start timestamptz not null,
  window_seconds int not null,
  count int not null default 0,
  primary key (organization_id, metric, window_start)
);
alter table public.usage_quotas enable row level security;
create policy usage_quotas_system on public.usage_quotas for all to flowza_system using ((select app.is_system())) with check ((select app.is_system()));
create policy usage_quotas_read on public.usage_quotas for select to authenticated using (organization_id = any ((select app.org_ids_with_permission('organization.manage'))::uuid[]));

-- Safety net again (new tables must have RLS).
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
