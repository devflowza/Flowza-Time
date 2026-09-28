-- FlowZa Time · 20260928001100 · Security & quality gate (HR portal Prompt 10; report docs/hr-portal/reports/10-security-gate.md).
--
-- Static, SYSTEMATIC guarantees for every table, present and future (the catalogue-driven suite
-- supabase/tests/rls_invariants.sql fails CI when one of them is broken again):
--
--  1. Partitions (P0). The monthly / default partitions of attendance_events, attendance_raw_transactions, device_logs and
--     sync_logs had RLS DISABLED and inherited `authenticated=arwd` from the schema default privileges. RLS of a partitioned
--     table applies only when the PARENT is queried, and PostgREST exposes every table of `public` — so any signed-in user,
--     member of no organisation at all, could read (and write) every tenant's raw punches, events, device and sync logs by
--     naming a partition (`/rest/v1/attendance_events_202609`). Every partition now has RLS enabled (+ forced) and no
--     privilege for anon / authenticated / flowza_system: partitions are storage, reached only through their parent, whose
--     policies decide. `app.ensure_month_partitions` locks every partition it creates.
--  2. Tenant tables (every table of public / audit with an organization_id column; partitions through their parent):
--       * RLS enabled AND forced (FORCE only when the owner is a superuser or has BYPASSRLS, which it keeps as the owner of the
--         SECURITY DEFINER helpers — otherwise forcing would blind them; a WARNING names the table and the invariant suite
--         reports it);
--       * `organization_id_immutable`: a BEFORE UPDATE trigger refusing any change of organization_id (42501). The Prompt 8
--         review proved a member holding a settings key in two organisations could MOVE a row between tenants; the rule is
--         now universal (the Prompt 8 fix keeps its own guard on organization_settings);
--       * `<table>_no_data_api`: a RESTRICTIVE policy refusing every row to a PostgREST / pg_graphql session
--         (session_user = 'authenticator'). ADR-001 §49: tables are not the API. The web talks to /api/v1 only (Supabase is
--         used for Auth and Realtime broadcast); the API connects as flowza_api, the worker as flowza_worker, Storage and
--         Realtime evaluate policies under their own logins — none of them is `authenticator`. This closes, for every table
--         at once, the direct-write residuals of the phase reports (a leave withdrawn around the approval engine, a day
--         mark written for oneself, a membership or invitation carrying a role its writer does not hold, a branch column
--         chosen by the client) and the API-only column masking (DOB / phone / address of employees).
--     `app.apply_tenant_policies` / `app.apply_readonly_tenant_policies` apply all three to every table they are called on,
--     so a future tenant table gets them from the generator; the invariant suite catches a table created without it.
--  3. SECURITY DEFINER functions: EXECUTE revoked from PUBLIC / anon (explicit grants to authenticated / flowza_* stay). A
--     function created later is caught by the invariant suite (a SECURITY DEFINER function executable by PUBLIC / anon, or
--     without a pinned search_path, fails CI unless allow-listed with a reason) — the global default privilege is left alone
--     on purpose: invoker helpers and the test suites' pg_temp assertions rely on it. The migration-only procedures (policy
--     generators and helpers of this file) are revoked from every application role.
--  4. System-written tables refuse client writes explicitly (revoke + three restrictive denials, like geofences after the
--     Prompt 4 review): the approval engine's tables, attendance day marks, leave records / allocations / comp-off credits and
--     usages (the API writes them in its system step after its own checks — see the API change in the same commit), the
--     engine's outputs (daily records, history, events, raw transactions, period summaries), the notification delivery
--     queue and every other table written only by the worker / system context. attendance_corrections and
--     leave_request_comments keep their client INSERT only; notifications keep UPDATE of read_at only (column privilege).
--     The schema default privileges no longer grant authenticated INSERT / UPDATE / DELETE on new tables: a table is
--     client-writable only when a migration says so (the generator grants it with the policies it creates).
--  5. Privilege escalation through memberships / invitations: `role_permissions_no_escalation` guarded custom role
--     definitions only. `app.guard_membership_write` (org_memberships), `app.guard_membership_branch_write`
--     (membership_branches) and `app.guard_invitation_write` (invitations) refuse, from a user session: a role holding a
--     permission the writer does not hold, the owner role unless the writer is an owner, all-branch access unless the
--     writer has it, branches outside the writer's scope, creating or removing one's own membership, linking one's own login
--     to an employee record (an owner may), and changing an owner's membership unless the writer is an owner. Every change is
--     bounded by what the writer already holds, so a change about oneself can only keep or reduce access. The system context (invitation acceptance, offboarding), migrations
--     and seeds are not checked — they act for an already-authorised caller.
--  6. Indexes: an organization_id-leading index on every tenant table and a covering index on every foreign key of a tenant
--     table (the RI checks of a parent delete — an organisation, an employee, a user profile, a notification purged by the
--     retention job — scanned the child table once per row without them).
--  7. The system context is ONE organisation's (docs/security.md): ten policies of tenant tables granted the whole system
--     role with a bare `app.is_system()` — the system step of organisation A read and wrote organisation B's subscriptions,
--     entitlements, feature-flag overrides, quotas, usage, platform access grants, pending devices, provider events, report
--     requests and audit log. They now allow the platform context, rows of no organisation (unclaimed devices, unattributed
--     events, platform audit entries) and the claimed organisation's rows.
--  8. Rows addressed to a user (notifications, notification preferences, report deliveries and requests) were readable by
--     user id alone — in an organisation the user had left. The self predicates now require the membership.
--
-- Additive and idempotent (`create or replace`, `if not exists`, `drop … if exists` before re-creating the policies / triggers
-- this file owns); safe as ONE transaction (no enum value, no CONCURRENTLY — every index is built on tables that are small
-- today; the hosted runbook in the report builds none of them concurrently because the whole hosted project holds 54
-- employees). Ends with a post-verify block that fails the migration rather than leave half a state.

set lock_timeout = '5s';
set statement_timeout = '600s';
set client_min_messages = warning;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------------------------------------------------------------

-- `flowza_client`: every client-facing role (authenticated, anon) — the target of this file's RESTRICTIVE policies (the
-- data-API denial and the explicit client-write denials). Restrictive policies bind the roles that inherit the policy's role,
-- so they bind authenticated / anon sessions exactly as `to authenticated` would, while the feature policies of
-- `authenticated` stay what the feature migrations (and their re-application tests) declare. It holds no privilege.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'flowza_client') then
    create role flowza_client nologin noinherit;
  end if;
end $$;
-- `authenticated` / `anon` are NOINHERIT roles: the membership must inherit (PostgreSQL 16+), or the policies would not bind them
grant flowza_client to authenticated with inherit true, set false;
grant flowza_client to anon with inherit true, set false;

-- the tenant key never changes: a row belongs to one organisation for its whole life. A row that belongs to none yet (a
-- pending device before it is claimed, a provider webhook event before it is attributed) may be adopted — once.
create or replace function app.forbid_tenant_key_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.organization_id is not null and new.organization_id is distinct from old.organization_id then
    raise exception 'organization_id of %.% is immutable: a row never moves between organisations', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  return new;
end $$;

-- ADR-001 §49: PostgREST / pg_graphql (the `authenticator` login) are not a data API for FlowZa Time
create or replace procedure app.deny_data_api(p_table regclass)
language plpgsql set search_path = '' as $$
declare
  v_name text := p_table::text;
  v_short text := replace(replace(replace(v_name, 'public.', ''), 'audit.', 'audit_'), '.', '_');
begin
  execute format('drop policy if exists %I on %s', v_short || '_no_data_api', v_name);
  execute format('create policy %I on %s as restrictive for all to flowza_client using ((select session_user) <> %L) with check ((select session_user) <> %L)',
    v_short || '_no_data_api', v_name, 'authenticator', 'authenticator');
end $$;

-- RLS on, forced when forcing cannot blind the owner's SECURITY DEFINER helpers
create or replace procedure app.force_rls(p_table regclass)
language plpgsql set search_path = '' as $$
declare v_owner_bypasses boolean;
begin
  select (r.rolsuper or r.rolbypassrls) into v_owner_bypasses
  from pg_catalog.pg_class c join pg_catalog.pg_roles r on r.oid = c.relowner where c.oid = p_table;
  execute format('alter table %s enable row level security', p_table::text);
  if v_owner_bypasses then
    execute format('alter table %s force row level security', p_table::text);
  else
    raise warning 'app.force_rls(%): the owner is neither a superuser nor BYPASSRLS; FORCE would hide every row from the SECURITY DEFINER helpers it owns — RLS stays enabled, not forced', p_table::text;
  end if;
end $$;

-- every tenant table: RLS forced, tenant key immutable, no data API
create or replace procedure app.enforce_tenant_table(p_table regclass)
language plpgsql set search_path = '' as $$
begin
  call app.force_rls(p_table);
  if exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = p_table and a.attname = 'organization_id' and not a.attisdropped) then
    execute format('create or replace trigger organization_id_immutable before update of organization_id on %s for each row '
                   'when (old.organization_id is distinct from new.organization_id) execute function app.forbid_tenant_key_change()', p_table::text);
  end if;
  call app.deny_data_api(p_table);
end $$;

-- no client write of any kind: the privileges go, and three RESTRICTIVE denials say so explicitly (a denial an earlier
-- migration already created under the same name — app.deny_client_writes, to authenticated — is kept as it is)
create or replace procedure app.forbid_client_writes(p_table regclass)
language plpgsql set search_path = '' as $$
declare
  v_name text := p_table::text;
  v_short text := replace(replace(v_name, 'public.', ''), '.', '_');
  v_cmd text;
begin
  execute format('revoke insert, update, delete on %s from authenticated, anon', v_name);
  foreach v_cmd in array array['insert', 'update', 'delete'] loop
    if not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = p_table and p.polname = v_short || '_deny_client_' || v_cmd) then
      execute format('create policy %I on %s as restrictive for %s to flowza_client %s', v_short || '_deny_client_' || v_cmd, v_name, v_cmd,
        case v_cmd when 'insert' then 'with check (false)' when 'update' then 'using (false) with check (false)' else 'using (false)' end);
    end if;
  end loop;
end $$;

-- a partition is storage: reached through its parent only (the parent's policies decide), never directly
create or replace procedure app.lock_partition(p_partition regclass)
language plpgsql set search_path = '' as $$
begin
  call app.force_rls(p_partition);
  execute format('revoke all on %s from public, anon, authenticated, flowza_system', p_partition::text);
end $$;

-- system-written table: no client write privilege, no client write policy, three explicit restrictive denials; the system
-- context keeps (or gets) its write policy
create or replace procedure app.make_system_write_only(p_table regclass)
language plpgsql set search_path = '' as $$
declare
  v_name text := p_table::text;
  v_short text := replace(replace(v_name, 'public.', ''), '.', '_');
  r record;
begin
  for r in
    select p.polname from pg_catalog.pg_policy p
    where p.polrelid = p_table and p.polpermissive and p.polcmd in ('a', 'w', 'd', '*')
      and (p.polroles @> array[(select oid from pg_catalog.pg_roles where rolname = 'authenticated')] or p.polroles @> array[0::oid])
  loop
    execute format('drop policy %I on %s', r.polname, v_name);
  end loop;
  -- the system context keeps its own write policy (an append-only table has an INSERT-only one); one is created only when
  -- the system context wrote through the client policies just dropped
  if not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = p_table and p.polpermissive and p.polcmd in ('a', 'w', 'd', '*')
                 and p.polroles @> array[(select oid from pg_catalog.pg_roles where rolname = 'flowza_system')]) then
    execute format('create policy %I on %s for all to flowza_system using (organization_id = app.system_org_id()) with check (organization_id = app.system_org_id())',
      v_short || '_system_write', v_name);
  end if;
  call app.forbid_client_writes(p_table);
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. The policy generators apply the tenant-table rules to every table they touch (present and future)
-- ---------------------------------------------------------------------------------------------------------------------------
-- Same signatures as 20260928000100 (create or replace keeps callers unchanged); the bodies are those of 000100 plus the
-- explicit grants (the schema defaults no longer grant client writes, §4) and `app.enforce_tenant_table`.
create or replace procedure app.apply_tenant_policies(
  p_table regclass,
  p_view_perm text,
  p_write_perm text,
  p_branch_col text default null,
  p_self_col text default null,
  p_delete_perm text default null,
  p_team_col text default null,
  p_team_perms text[] default null
)
language plpgsql
as $$
declare
  v_name text := p_table::text;
  v_short text := replace(replace(v_name, 'public.', ''), '.', '_');
  v_read text;
  v_write text;
  v_branch text := 'true';
  v_self text := 'false';
  v_team text := 'false';
  v_delete_perm text := coalesce(p_delete_perm, p_write_perm);
begin
  if p_branch_col is not null then
    v_branch := format(
      '(organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or %1$I is null or %1$I = any ((select app.allowed_branch_ids())::uuid[]))',
      p_branch_col);
  end if;
  if p_self_col is not null then
    v_self := format('(%1$I = any ((select app.own_employee_ids())::uuid[]))', p_self_col);
  end if;
  if p_team_col is not null then
    if p_team_perms is null or cardinality(p_team_perms) = 0 then
      raise exception 'apply_tenant_policies(%): a team column needs at least one team permission', v_name;
    end if;
    v_team := format('(organization_id = any ((select app.org_ids_with_any_permission(%L::text[]))::uuid[]) and %I = any ((select app.team_employee_ids())::uuid[]))', p_team_perms, p_team_col);
  end if;

  v_read := format('((organization_id = any ((select app.org_ids_with_permission(%L))::uuid[]) and %s) or %s or %s)', p_view_perm, v_branch, v_self, v_team);
  v_write := format('(organization_id = any ((select app.org_ids_with_permission(%L))::uuid[]) and %s)', p_write_perm, v_branch);

  execute format('alter table %s enable row level security', v_name);
  execute format('grant select, insert, update, delete on %s to authenticated, flowza_system', v_name);
  execute format('drop policy if exists %I on %s', v_short || '_select', v_name);
  execute format('drop policy if exists %I on %s', v_short || '_insert', v_name);
  execute format('drop policy if exists %I on %s', v_short || '_update', v_name);
  execute format('drop policy if exists %I on %s', v_short || '_delete', v_name);
  execute format('create policy %I on %s for select to authenticated, flowza_system using %s', v_short || '_select', v_name, v_read);
  execute format('create policy %I on %s for insert to authenticated, flowza_system with check %s', v_short || '_insert', v_name, v_write);
  execute format('create policy %I on %s for update to authenticated, flowza_system using %s with check %s', v_short || '_update', v_name, v_write, v_write);
  execute format('create policy %I on %s for delete to authenticated, flowza_system using %s',
    v_short || '_delete', v_name,
    format('(organization_id = any ((select app.org_ids_with_permission(%L))::uuid[]) and %s)', v_delete_perm, v_branch));
  call app.enforce_tenant_table(p_table);
end $$;

-- the read-only generator is for system-written tables (audit, history, raw data, RPC-only documents): it now also takes the
-- client write privileges away with explicit denials, so such a table can never be written from a client session
create or replace procedure app.apply_readonly_tenant_policies(
  p_table regclass,
  p_view_perm text,
  p_branch_col text default null,
  p_self_col text default null,
  p_team_col text default null,
  p_team_perms text[] default null
)
language plpgsql
as $$
declare
  v_name text := p_table::text;
  v_short text := replace(replace(v_name, 'public.', ''), '.', '_');
  v_branch text := 'true';
  v_self text := 'false';
  v_team text := 'false';
begin
  if p_branch_col is not null then
    v_branch := format(
      '(organization_id = any ((select app.unrestricted_org_ids())::uuid[]) or %1$I is null or %1$I = any ((select app.allowed_branch_ids())::uuid[]))',
      p_branch_col);
  end if;
  if p_self_col is not null then
    v_self := format('(%1$I = any ((select app.own_employee_ids())::uuid[]))', p_self_col);
  end if;
  if p_team_col is not null then
    if p_team_perms is null or cardinality(p_team_perms) = 0 then
      raise exception 'apply_readonly_tenant_policies(%): a team column needs at least one team permission', v_name;
    end if;
    v_team := format('(organization_id = any ((select app.org_ids_with_any_permission(%L::text[]))::uuid[]) and %I = any ((select app.team_employee_ids())::uuid[]))', p_team_perms, p_team_col);
  end if;
  execute format('alter table %s enable row level security', v_name);
  execute format('grant select on %s to authenticated, flowza_system', v_name);
  execute format('grant insert, update, delete on %s to flowza_system', v_name);
  execute format('drop policy if exists %I on %s', v_short || '_select', v_name);
  execute format('drop policy if exists %I on %s', v_short || '_system_write', v_name);
  execute format('create policy %I on %s for select to authenticated, flowza_system using ((organization_id = any ((select app.org_ids_with_permission(%L))::uuid[]) and %s) or %s or %s)',
    v_short || '_select', v_name, p_view_perm, v_branch, v_self, v_team);
  execute format('create policy %I on %s for all to flowza_system using (organization_id = app.system_org_id()) with check (organization_id = app.system_org_id())',
    v_short || '_system_write', v_name);
  call app.forbid_client_writes(p_table);
  call app.enforce_tenant_table(p_table);
end $$;

-- the migration-only procedures are nobody's API
revoke execute on procedure app.apply_tenant_policies(regclass, text, text, text, text, text, text, text[]) from public, anon, authenticated, flowza_system, flowza_api, flowza_worker;
revoke execute on procedure app.apply_readonly_tenant_policies(regclass, text, text, text, text, text[]) from public, anon, authenticated, flowza_system, flowza_api, flowza_worker;
revoke execute on procedure app.deny_client_writes(regclass) from public, anon, authenticated, flowza_system, flowza_api, flowza_worker;
revoke execute on procedure app.forbid_client_writes(regclass) from public, anon, authenticated, flowza_system, flowza_api, flowza_worker;
revoke execute on procedure app.deny_data_api(regclass) from public, anon, authenticated, flowza_system, flowza_api, flowza_worker;
revoke execute on procedure app.force_rls(regclass) from public, anon, authenticated, flowza_system, flowza_api, flowza_worker;
revoke execute on procedure app.enforce_tenant_table(regclass) from public, anon, authenticated, flowza_system, flowza_api, flowza_worker;
revoke execute on procedure app.lock_partition(regclass) from public, anon, authenticated, flowza_system, flowza_api, flowza_worker;
revoke execute on procedure app.make_system_write_only(regclass) from public, anon, authenticated, flowza_system, flowza_api, flowza_worker;
revoke execute on function app.forbid_tenant_key_change() from public, anon;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Partitions (P0): lock every existing one; the partition maintainer locks every new one
-- ---------------------------------------------------------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select c.oid::regclass as rel from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ('public', 'audit') and c.relispartition and c.relkind in ('r', 'p')
  loop
    call app.lock_partition(r.rel);
  end loop;
end $$;

create or replace function app.ensure_month_partitions(p_table regclass, p_from date, p_months int)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_schema text; v_table text; v_start date; v_end date; v_name text; v_created int := 0; i int;
begin
  if not app.is_system() then raise exception 'system context required' using errcode = '42501'; end if;
  select n.nspname, c.relname into v_schema, v_table from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = p_table;
  if v_table not in ('attendance_raw_transactions', 'attendance_events', 'device_logs', 'sync_logs') then
    raise exception 'table % is not a managed partitioned table', v_table using errcode = '22023';
  end if;
  for i in 0 .. p_months - 1 loop
    v_start := date_trunc('month', p_from)::date + (i || ' months')::interval;
    v_end := v_start + interval '1 month';
    v_name := format('%s_%s', v_table, to_char(v_start, 'YYYYMM'));
    if to_regclass(format('%I.%I', v_schema, v_name)) is null then
      execute format('create table %I.%I partition of %I.%I for values from (%L) to (%L)', v_schema, v_name, v_schema, v_table, v_start, v_end);
      -- a new partition inherits the schema's default privileges and RLS off: lock it at once (reached through the parent only)
      call app.lock_partition(format('%I.%I', v_schema, v_name)::regclass);
      v_created := v_created + 1;
    end if;
  end loop;
  return v_created;
end $$;
revoke execute on function app.ensure_month_partitions(regclass, date, int) from public, anon, authenticated;
grant execute on function app.ensure_month_partitions(regclass, date, int) to flowza_system, flowza_worker, flowza_api;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 3. Tenant tables: RLS forced, tenant key immutable, no data API — and every other table of public / audit: no data API
-- ---------------------------------------------------------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select c.oid::regclass as rel from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ('public', 'audit') and c.relkind in ('r', 'p') and not c.relispartition
             and exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
  loop
    call app.enforce_tenant_table(r.rel);
  end loop;
  -- tables without a tenant key (organisations, profiles, memberships' branches, the permission / plan / provider catalogues,
  -- platform admins, login history): not a data API either
  for r in select c.oid::regclass as rel from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ('public', 'audit') and c.relkind in ('r', 'p') and not c.relispartition and c.relrowsecurity
             and not exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
  loop
    call app.deny_data_api(r.rel);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 4. SECURITY DEFINER hygiene
-- ---------------------------------------------------------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           where p.prosecdef and n.nspname in ('app', 'public', 'secrets', 'audit', 'jobs')
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);
  end loop;
end $$;
-- (no global `alter default privileges … revoke execute … from public`: the invariant suite gates new SECURITY DEFINER
-- functions instead, without breaking invoker helpers and pg_temp test helpers that rely on the PostgreSQL default)

-- ---------------------------------------------------------------------------------------------------------------------------
-- 5. Client writes: fail closed for new tables, explicit denials on every system-written table
-- ---------------------------------------------------------------------------------------------------------------------------
-- a new table of public is readable under RLS by default, writable by a client only when a migration grants it (the tenant
-- policy generator does, with the policies it creates)
alter default privileges in schema public revoke insert, update, delete on tables from authenticated;

do $$
declare v_table text;
begin
  foreach v_table in array array[
    -- the approval engine writes in its system step (engine.ts systemStep, the worker's reminders / escalation / digests)
    'approval_requests', 'approval_steps', 'approval_step_actors', 'approval_request_events', 'approval_delegations',
    'approval_email_tokens', 'approval_digest_runs',
    -- verdicts, leave and comp-off: written by the API's system step after its checks (segregation of duties, branch scope,
    -- the approval engine) and by the worker — never by a client session (Prompt 7 open item: a withdrawal around the engine)
    'attendance_day_marks', 'leave_records', 'leave_allocations', 'comp_off_credits', 'comp_off_usages', 'leave_year_closes',
    -- the engine's outputs and raw ledgers (worker / ingest in the system context)
    'attendance_daily_records', 'attendance_daily_record_history', 'attendance_period_summaries', 'attendance_events',
    'attendance_raw_transactions',
    -- delivery queues, ledgers and maintenance state (worker / system context)
    'notification_deliveries', 'missing_punch_reminders', 'report_deliveries', 'finance_sync_state', 'finance_pushed_events',
    'device_commands', 'device_logs', 'device_credentials', 'pending_devices', 'sync_attempts', 'sync_cursors', 'sync_logs',
    'provider_circuit_states', 'provider_webhook_events', 'usage_quotas', 'usage_records', 'platform_access_grants'
  ] loop
    call app.make_system_write_only(('public.' || v_table)::regclass);
  end loop;
end $$;

-- attendance corrections: a client INSERT stays (a PENDING request filed in one's own name, 20260928000200); approving,
-- applying and cancelling are the engine's (system step)
revoke update, delete on public.attendance_corrections from authenticated;
drop policy if exists attendance_corrections_deny_client_update on public.attendance_corrections;
drop policy if exists attendance_corrections_deny_client_delete on public.attendance_corrections;
create policy attendance_corrections_deny_client_update on public.attendance_corrections as restrictive for update to flowza_client using (false) with check (false);
create policy attendance_corrections_deny_client_delete on public.attendance_corrections as restrictive for delete to flowza_client using (false);

-- leave thread: a client adds a plain comment in its own name (append-only table — no update / delete, ever)
revoke update, delete on public.leave_request_comments from authenticated;
drop policy if exists leave_request_comments_deny_client_update on public.leave_request_comments;
drop policy if exists leave_request_comments_deny_client_delete on public.leave_request_comments;
create policy leave_request_comments_deny_client_update on public.leave_request_comments as restrictive for update to flowza_client using (false) with check (false);
create policy leave_request_comments_deny_client_delete on public.leave_request_comments as restrictive for delete to flowza_client using (false);

-- notifications: the relay writes them (platform / system context); a member only marks their own ones read
revoke insert, update, delete on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;
drop policy if exists notifications_deny_client_insert on public.notifications;
drop policy if exists notifications_deny_client_delete on public.notifications;
create policy notifications_deny_client_insert on public.notifications as restrictive for insert to flowza_client with check (false);
create policy notifications_deny_client_delete on public.notifications as restrictive for delete to flowza_client using (false);

-- A client write privilege that no permissive client policy uses is latent — row security refuses every row today, but a
-- permissive policy added later would silently re-open a table nobody meant to be client-writable (live before this file:
-- the permission catalogue, platform_admins, device_providers / device_models, DELETE on user_profiles). Revoked, for every
-- table of public; the invariant suite keeps it that way ("privilege ⇒ policy").
do $$
declare
  r record;
  v_auth oid := (select oid from pg_catalog.pg_roles where rolname = 'authenticated');
begin
  for r in
    select c.oid::regclass as rel, cmd.priv
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join (values ('a'::"char", 'insert'), ('w'::"char", 'update'), ('d'::"char", 'delete')) as cmd(polcmd, priv)
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition and c.relrowsecurity
      and has_table_privilege('authenticated', c.oid, cmd.priv)
      and not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = c.oid and p.polpermissive and p.polcmd in (cmd.polcmd, '*')
                      and (p.polroles @> array[v_auth] or p.polroles @> array[0::oid]))
  loop
    execute format('revoke %s on %s from authenticated', r.priv, r.rel);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 6. No privilege escalation through memberships, their branches and invitations
-- ---------------------------------------------------------------------------------------------------------------------------
-- The owner system role (SYSTEM_ROLE_IDS.owner in @flowza/contracts).
create or replace function app.is_org_owner(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.org_memberships m
    where m.organization_id = p_org and m.user_id = app.uid() and m.status = 'active' and m.role_id = '10000000-0000-0000-0000-000000000001'::uuid
  )
$$;
revoke execute on function app.is_org_owner(uuid) from public, anon;
grant execute on function app.is_org_owner(uuid) to authenticated, flowza_system, flowza_api, flowza_worker;

-- A role may be handed out only by somebody who holds every permission it carries (the owner role only by an owner), and only
-- when it is a system role or one of the organisation's own.
create or replace function app.assert_role_grantable(p_org uuid, p_role uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare v_missing text;
begin
  if not exists (select 1 from public.roles r where r.id = p_role and (r.organization_id is null or r.organization_id = p_org)) then
    raise exception 'unknown role for this organisation' using errcode = '42501';
  end if;
  if p_role = '10000000-0000-0000-0000-000000000001'::uuid and not app.is_org_owner(p_org) then
    raise exception 'only an owner can grant the owner role' using errcode = '42501';
  end if;
  select string_agg(rp.permission_key, ', ' order by rp.permission_key) into v_missing
  from public.role_permissions rp
  where rp.role_id = p_role and not (p_org = any (app.org_ids_with_permission(rp.permission_key)));
  if v_missing is not null then
    raise exception 'cannot assign a role with permissions you do not hold: %', v_missing using errcode = '42501';
  end if;
end $$;
revoke execute on function app.assert_role_grantable(uuid, uuid) from public, anon, authenticated;

create or replace function app.guard_membership_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_owner constant uuid := '10000000-0000-0000-0000-000000000001';
  v_actor uuid := app.uid();
  v_org uuid := coalesce(new.organization_id, old.organization_id);
begin
  -- only client sessions are checked (PostgREST is refused anyway; this is the API's user context): the organisation's
  -- system context (invitation acceptance, offboarding), migrations and seeds act for an already-authorised caller
  if coalesce(current_setting('role', true), '') <> 'authenticated' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    if old.user_id = v_actor then raise exception 'you cannot remove your own membership' using errcode = '42501'; end if;
    if old.role_id = v_owner and not app.is_org_owner(v_org) then raise exception 'only an owner can remove an owner' using errcode = '42501'; end if;
    return old;
  end if;
  -- (changing one's OWN role, status or branch scope needs no rule of its own: the rules below bound every change by what the
  -- writer already holds, so a change about oneself can only keep or reduce access — the API keeps one active owner)
  if tg_op = 'INSERT' then
    if new.user_id = v_actor then raise exception 'you cannot create your own membership' using errcode = '42501'; end if;
  else
    -- the employee link is what the "own" and team predicates read: linking oneself to a colleague's record would hand a
    -- user.manage holder that colleague's self-service rows and reports. An owner (who holds every key anyway) may link
    -- their own login to their own record
    if new.user_id = v_actor and new.employee_id is distinct from old.employee_id and not app.is_org_owner(v_org) then
      raise exception 'you cannot change the employee record your own login is linked to' using errcode = '42501';
    end if;
    if old.role_id = v_owner and not app.is_org_owner(v_org)
       and (new.role_id is distinct from old.role_id or new.status is distinct from old.status or new.all_branches is distinct from old.all_branches or new.employee_id is distinct from old.employee_id) then
      raise exception 'only an owner can change an owner''s membership' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'INSERT' or new.role_id is distinct from old.role_id then
    perform app.assert_role_grantable(new.organization_id, new.role_id);
  end if;
  if new.all_branches and (tg_op = 'INSERT' or not old.all_branches) and not (new.organization_id = any (app.unrestricted_org_ids())) then
    raise exception 'only a member with access to all branches can grant access to all branches' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function app.guard_membership_write() from public, anon;
drop trigger if exists org_memberships_no_escalation on public.org_memberships;
create trigger org_memberships_no_escalation before insert or update or delete on public.org_memberships
  for each row execute function app.guard_membership_write();

create or replace function app.guard_membership_branch_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_m record;
  v_membership uuid := case when tg_op = 'DELETE' then old.membership_id else new.membership_id end;
  v_branch uuid := case when tg_op = 'DELETE' then old.branch_id else new.branch_id end;
begin
  if coalesce(current_setting('role', true), '') <> 'authenticated' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  select m.organization_id, m.user_id, m.role_id into v_m from public.org_memberships m where m.id = v_membership;
  if not found then return case when tg_op = 'DELETE' then old else new end; end if;
  if v_m.role_id = '10000000-0000-0000-0000-000000000001'::uuid and not app.is_org_owner(v_m.organization_id) then
    raise exception 'only an owner can change an owner''s branch scope' using errcode = '42501';
  end if;
  if tg_op <> 'DELETE' and not (v_m.organization_id = any (app.unrestricted_org_ids()) or v_branch = any (app.allowed_branch_ids())) then
    raise exception 'this branch is outside your access scope' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke execute on function app.guard_membership_branch_write() from public, anon;
drop trigger if exists membership_branches_no_escalation on public.membership_branches;
create trigger membership_branches_no_escalation before insert or update or delete on public.membership_branches
  for each row execute function app.guard_membership_branch_write();

create or replace function app.guard_invitation_write() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('role', true), '') <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' or new.role_id is distinct from old.role_id then
    perform app.assert_role_grantable(new.organization_id, new.role_id);
  end if;
  if tg_op = 'INSERT' or new.all_branches is distinct from old.all_branches or new.branch_ids is distinct from old.branch_ids then
    if not (new.organization_id = any (app.unrestricted_org_ids())) then
      if new.all_branches then
        raise exception 'only a member with access to all branches can invite with access to all branches' using errcode = '42501';
      end if;
      if exists (select 1 from unnest(coalesce(new.branch_ids, '{}'::uuid[])) b where not (b = any (app.allowed_branch_ids()))) then
        raise exception 'an invited branch is outside your access scope' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end $$;
revoke execute on function app.guard_invitation_write() from public, anon;
drop trigger if exists invitations_no_escalation on public.invitations;
create trigger invitations_no_escalation before insert or update on public.invitations
  for each row execute function app.guard_invitation_write();

-- ---------------------------------------------------------------------------------------------------------------------------
-- 7. Indexes: organization_id first on every tenant table, a covering index on every foreign key of a tenant table
-- ---------------------------------------------------------------------------------------------------------------------------
-- (a) the tenant key leads an index (RLS predicates `organization_id = any (…)`, the organisation's cascade delete)
create index if not exists approval_email_tokens_organization_id_fk_idx on public.approval_email_tokens (organization_id);
create index if not exists attendance_daily_record_history_organization_id_fk_idx on public.attendance_daily_record_history (organization_id);
create index if not exists device_commands_organization_id_fk_idx on public.device_commands (organization_id);
create index if not exists device_credentials_organization_id_fk_idx on public.device_credentials (organization_id);
create index if not exists import_job_rows_organization_id_fk_idx on public.import_job_rows (organization_id);
create index if not exists notification_preferences_org_user_idx on public.notification_preferences (organization_id, user_id);
create index if not exists outbound_webhook_subscriptions_organization_id_fk_idx on public.outbound_webhook_subscriptions (organization_id);
create index if not exists pending_devices_organization_id_fk_idx on public.pending_devices (organization_id) where organization_id is not null;
create index if not exists platform_access_grants_organization_id_fk_idx on public.platform_access_grants (organization_id);
create index if not exists provider_webhook_events_organization_id_fk_idx on public.provider_webhook_events (organization_id) where organization_id is not null;
create index if not exists roles_organization_id_fk_idx on public.roles (organization_id) where organization_id is not null;
create index if not exists sync_attempts_organization_id_fk_idx on public.sync_attempts (organization_id);
create index if not exists sync_cursors_organization_id_fk_idx on public.sync_cursors (organization_id);

-- (b) every other foreign key of a tenant table (partial on nullable single-column keys: the RI lookup `col = $1` can use it)
create index if not exists approval_delegations_created_by_fk_idx on public.approval_delegations (created_by) where created_by is not null;
create index if not exists approval_delegations_delegator_user_id_fk_idx on public.approval_delegations (delegator_user_id);
create index if not exists approval_delegations_revoked_by_fk_idx on public.approval_delegations (revoked_by) where revoked_by is not null;
create index if not exists approval_email_tokens_request_id_fk_idx on public.approval_email_tokens (request_id);
create index if not exists approval_email_tokens_user_id_fk_idx on public.approval_email_tokens (user_id);
create index if not exists approval_request_events_actor_user_id_fk_idx on public.approval_request_events (actor_user_id) where actor_user_id is not null;
create index if not exists approval_requests_cancelled_by_fk_idx on public.approval_requests (cancelled_by) where cancelled_by is not null;
create index if not exists approval_requests_decided_by_fk_idx on public.approval_requests (decided_by) where decided_by is not null;
create index if not exists approval_requests_employee_id_fk_idx on public.approval_requests (employee_id) where employee_id is not null;
create index if not exists approval_requests_subject_user_id_fk_idx on public.approval_requests (subject_user_id) where subject_user_id is not null;
create index if not exists approval_requests_workflow_id_fk_idx on public.approval_requests (workflow_id) where workflow_id is not null;
create index if not exists approval_step_actors_on_behalf_of_user_id_fk_idx on public.approval_step_actors (on_behalf_of_user_id) where on_behalf_of_user_id is not null;
create index if not exists approval_step_actors_via_delegation_of_fk_idx on public.approval_step_actors (via_delegation_of) where via_delegation_of is not null;
create index if not exists approval_steps_acted_by_fk_idx on public.approval_steps (acted_by) where acted_by is not null;
create index if not exists approval_steps_delegated_from_user_id_fk_idx on public.approval_steps (delegated_from_user_id) where delegated_from_user_id is not null;
create index if not exists approval_workflows_organization_id_branch_id_fk_idx on public.approval_workflows (organization_id, branch_id);
create index if not exists attendance_corrections_approval_request_id_fk_idx on public.attendance_corrections (approval_request_id) where approval_request_id is not null;
create index if not exists attendance_corrections_employee_id_fk_idx on public.attendance_corrections (employee_id);
create index if not exists attendance_corrections_organization_id_device_id_fk_idx on public.attendance_corrections (organization_id, device_id);
create index if not exists attendance_corrections_requested_by_fk_idx on public.attendance_corrections (requested_by) where requested_by is not null;
create index if not exists attendance_daily_records_employee_id_fk_idx on public.attendance_daily_records (employee_id);
create index if not exists attendance_day_marks_created_by_fk_idx on public.attendance_day_marks (created_by) where created_by is not null;
create index if not exists attendance_day_marks_organization_id_branch_id_fk_idx on public.attendance_day_marks (organization_id, branch_id);
create index if not exists attendance_day_marks_revoked_by_fk_idx on public.attendance_day_marks (revoked_by) where revoked_by is not null;
create index if not exists attendance_notes_day_mark_id_fk_idx on public.attendance_notes (day_mark_id) where day_mark_id is not null;
create index if not exists attendance_notes_deducted_leave_record_id_fk_idx on public.attendance_notes (deducted_leave_record_id) where deducted_leave_record_id is not null;
create index if not exists attendance_notes_excused_by_fk_idx on public.attendance_notes (excused_by) where excused_by is not null;
create index if not exists attendance_notes_info_requested_by_fk_idx on public.attendance_notes (info_requested_by) where info_requested_by is not null;
create index if not exists attendance_notes_organization_id_branch_id_fk_idx on public.attendance_notes (organization_id, branch_id);
create index if not exists attendance_notes_reviewed_by_fk_idx on public.attendance_notes (reviewed_by) where reviewed_by is not null;
create index if not exists attendance_notes_submitted_by_fk_idx on public.attendance_notes (submitted_by) where submitted_by is not null;
create index if not exists attendance_period_locks_locked_by_fk_idx on public.attendance_period_locks (locked_by) where locked_by is not null;
create index if not exists attendance_period_locks_unlocked_by_fk_idx on public.attendance_period_locks (unlocked_by) where unlocked_by is not null;
create index if not exists attendance_period_summaries_employee_id_fk_idx on public.attendance_period_summaries (employee_id);
create index if not exists attendance_period_summaries_finalized_by_fk_idx on public.attendance_period_summaries (finalized_by) where finalized_by is not null;
create index if not exists attendance_recalculation_requests_requested_by_fk_idx on public.attendance_recalculation_requests (requested_by) where requested_by is not null;
create index if not exists attendance_regularisation_requests_applied_correction_id_fk_idx on public.attendance_regularisation_requests (applied_correction_id) where applied_correction_id is not null;
create index if not exists attendance_regularisation_requests_approval_request_id_fk_idx on public.attendance_regularisation_requests (approval_request_id) where approval_request_id is not null;
create index if not exists attendance_regularisation_requests_created_by_fk_idx on public.attendance_regularisation_requests (created_by) where created_by is not null;
create index if not exists attendance_regularisation_requests_decided_by_fk_idx on public.attendance_regularisation_requests (decided_by) where decided_by is not null;
create index if not exists attendance_regularisation_requests_organization_id_branc_fk_idx on public.attendance_regularisation_requests (organization_id, branch_id);
create index if not exists branches_organization_id_holiday_calendar_id_fk_idx on public.branches (organization_id, holiday_calendar_id);
create index if not exists comp_off_credits_approval_request_id_fk_idx on public.comp_off_credits (approval_request_id) where approval_request_id is not null;
create index if not exists comp_off_credits_created_by_fk_idx on public.comp_off_credits (created_by) where created_by is not null;
create index if not exists comp_off_credits_organization_id_branch_id_fk_idx on public.comp_off_credits (organization_id, branch_id);
create index if not exists comp_off_usages_leave_record_id_fk_idx on public.comp_off_usages (leave_record_id);
create index if not exists comp_off_usages_organization_id_credit_id_fk_idx on public.comp_off_usages (organization_id, credit_id);
create index if not exists comp_off_usages_organization_id_employee_id_fk_idx on public.comp_off_usages (organization_id, employee_id);
create index if not exists departments_manager_employee_id_fk_idx on public.departments (manager_employee_id) where manager_employee_id is not null;
create index if not exists departments_parent_id_fk_idx on public.departments (parent_id) where parent_id is not null;
create index if not exists device_employee_states_employee_id_fk_idx on public.device_employee_states (employee_id) where employee_id is not null;
create index if not exists device_group_members_device_id_fk_idx on public.device_group_members (device_id);
create index if not exists device_groups_organization_id_branch_id_fk_idx on public.device_groups (organization_id, branch_id);
create index if not exists devices_model_id_fk_idx on public.devices (model_id) where model_id is not null;
create index if not exists employee_attendance_grants_granted_by_fk_idx on public.employee_attendance_grants (granted_by) where granted_by is not null;
create index if not exists employee_attendance_grants_organization_id_employee_id_fk_idx on public.employee_attendance_grants (organization_id, employee_id);
create index if not exists employee_identity_documents_employee_id_fk_idx on public.employee_identity_documents (employee_id);
create index if not exists employee_provider_identities_employee_id_fk_idx on public.employee_provider_identities (employee_id);
create index if not exists employees_manager_employee_id_fk_idx on public.employees (manager_employee_id) where manager_employee_id is not null;
create index if not exists employees_organization_id_designation_id_fk_idx on public.employees (organization_id, designation_id);
create index if not exists employment_history_branch_id_fk_idx on public.employment_history (branch_id);
create index if not exists employment_history_department_id_fk_idx on public.employment_history (department_id) where department_id is not null;
create index if not exists employment_history_designation_id_fk_idx on public.employment_history (designation_id) where designation_id is not null;
create index if not exists employment_history_manager_employee_id_fk_idx on public.employment_history (manager_employee_id) where manager_employee_id is not null;
create index if not exists finance_pushed_events_organization_id_device_id_fk_idx on public.finance_pushed_events (organization_id, device_id);
create index if not exists finance_sync_state_organization_id_device_id_fk_idx on public.finance_sync_state (organization_id, device_id);
create index if not exists geofence_assignments_created_by_fk_idx on public.geofence_assignments (created_by) where created_by is not null;
create index if not exists geofence_assignments_organization_id_geofence_id_fk_idx on public.geofence_assignments (organization_id, geofence_id);
create index if not exists geofences_created_by_fk_idx on public.geofences (created_by) where created_by is not null;
create index if not exists geofences_organization_id_branch_id_fk_idx on public.geofences (organization_id, branch_id);
create index if not exists import_jobs_confirmed_by_fk_idx on public.import_jobs (confirmed_by) where confirmed_by is not null;
create index if not exists import_jobs_requested_by_fk_idx on public.import_jobs (requested_by) where requested_by is not null;
create index if not exists invitations_accepted_by_fk_idx on public.invitations (accepted_by) where accepted_by is not null;
create index if not exists invitations_invited_by_fk_idx on public.invitations (invited_by) where invited_by is not null;
create index if not exists invitations_replaced_by_id_fk_idx on public.invitations (replaced_by_id) where replaced_by_id is not null;
create index if not exists invitations_revoked_by_fk_idx on public.invitations (revoked_by) where revoked_by is not null;
create index if not exists invitations_role_id_fk_idx on public.invitations (role_id);
create index if not exists leave_allocations_created_by_fk_idx on public.leave_allocations (created_by) where created_by is not null;
create index if not exists leave_allocations_organization_id_branch_id_fk_idx on public.leave_allocations (organization_id, branch_id);
create index if not exists leave_allocations_organization_id_leave_type_id_fk_idx on public.leave_allocations (organization_id, leave_type_id);
create index if not exists leave_allocations_updated_by_fk_idx on public.leave_allocations (updated_by) where updated_by is not null;
create index if not exists leave_records_approved_by_fk_idx on public.leave_records (approved_by) where approved_by is not null;
create index if not exists leave_records_employee_id_fk_idx on public.leave_records (employee_id);
create index if not exists leave_records_organization_id_leave_type_id_fk_idx on public.leave_records (organization_id, leave_type_id);
create index if not exists leave_request_comments_author_user_id_fk_idx on public.leave_request_comments (author_user_id) where author_user_id is not null;
create index if not exists leave_request_comments_leave_record_id_fk_idx on public.leave_request_comments (leave_record_id);
create index if not exists leave_year_closes_requested_by_fk_idx on public.leave_year_closes (requested_by) where requested_by is not null;
create index if not exists notification_deliveries_notification_id_fk_idx on public.notification_deliveries (notification_id);
create index if not exists org_memberships_employee_id_fk_idx on public.org_memberships (employee_id) where employee_id is not null;
create index if not exists org_memberships_invited_by_fk_idx on public.org_memberships (invited_by) where invited_by is not null;
create index if not exists organization_feature_flags_flag_key_fk_idx on public.organization_feature_flags (flag_key);
create index if not exists pending_devices_claimed_device_id_fk_idx on public.pending_devices (claimed_device_id) where claimed_device_id is not null;
create index if not exists platform_access_grants_approved_by_fk_idx on public.platform_access_grants (approved_by) where approved_by is not null;
create index if not exists platform_access_grants_granted_by_fk_idx on public.platform_access_grants (granted_by) where granted_by is not null;
create index if not exists provider_circuit_states_provider_key_fk_idx on public.provider_circuit_states (provider_key);
create index if not exists provider_webhook_events_device_id_fk_idx on public.provider_webhook_events (device_id) where device_id is not null;
create index if not exists report_deliveries_organization_id_report_request_id_fk_idx on public.report_deliveries (organization_id, report_request_id);
create index if not exists report_deliveries_sent_by_fk_idx on public.report_deliveries (sent_by) where sent_by is not null;
create index if not exists report_schedules_created_by_fk_idx on public.report_schedules (created_by) where created_by is not null;
create index if not exists report_schedules_organization_id_branch_id_fk_idx on public.report_schedules (organization_id, branch_id);
create index if not exists report_schedules_updated_by_fk_idx on public.report_schedules (updated_by) where updated_by is not null;
create index if not exists selfie_checkins_created_by_fk_idx on public.selfie_checkins (created_by) where created_by is not null;
create index if not exists selfie_checkins_organization_id_branch_id_fk_idx on public.selfie_checkins (organization_id, branch_id);
create index if not exists selfie_checkins_reviewed_by_fk_idx on public.selfie_checkins (reviewed_by) where reviewed_by is not null;
create index if not exists shift_assignments_organization_id_shift_id_fk_idx on public.shift_assignments (organization_id, shift_id);
create index if not exists shift_assignments_organization_id_shift_pattern_id_fk_idx on public.shift_assignments (organization_id, shift_pattern_id);
create index if not exists shift_swap_requests_approval_request_id_fk_idx on public.shift_swap_requests (approval_request_id) where approval_request_id is not null;
create index if not exists shift_swap_requests_created_by_fk_idx on public.shift_swap_requests (created_by) where created_by is not null;
create index if not exists shift_swap_requests_decided_by_fk_idx on public.shift_swap_requests (decided_by) where decided_by is not null;
create index if not exists shift_swap_requests_organization_id_branch_id_fk_idx on public.shift_swap_requests (organization_id, branch_id);
create index if not exists shift_swap_requests_organization_id_requester_shift_id_fk_idx on public.shift_swap_requests (organization_id, requester_shift_id);
create index if not exists shift_swap_requests_organization_id_target_shift_id_fk_idx on public.shift_swap_requests (organization_id, target_shift_id);
create index if not exists shift_swap_requests_requester_assignment_id_fk_idx on public.shift_swap_requests (requester_assignment_id) where requester_assignment_id is not null;
create index if not exists shift_swap_requests_target_assignment_id_fk_idx on public.shift_swap_requests (target_assignment_id) where target_assignment_id is not null;
create index if not exists subscriptions_plan_id_fk_idx on public.subscriptions (plan_id);
create index if not exists sync_job_items_employee_id_fk_idx on public.sync_job_items (employee_id) where employee_id is not null;
create index if not exists sync_jobs_parent_job_id_fk_idx on public.sync_jobs (parent_job_id) where parent_job_id is not null;
create index if not exists sync_jobs_requested_by_fk_idx on public.sync_jobs (requested_by) where requested_by is not null;
create index if not exists team_members_employee_id_fk_idx on public.team_members (employee_id);
create index if not exists teams_lead_employee_id_fk_idx on public.teams (lead_employee_id) where lead_employee_id is not null;
create index if not exists teams_organization_id_branch_id_fk_idx on public.teams (organization_id, branch_id);

-- ---------------------------------------------------------------------------------------------------------------------------
-- 8. The system context is scoped to its organisation (or is the platform context)
-- ---------------------------------------------------------------------------------------------------------------------------
-- Every policy of a tenant table that lets the system role in through a bare `app.is_system()` is rewritten in place (same
-- name, roles and command): the platform context keeps its cross-tenant reach, an organisation's system context reaches its
-- own rows and rows of no organisation (the only rows a claim / attribution adopts). Rewritten policies carry
-- `system_org_id`, so a second run finds nothing left to rewrite.
do $$
declare
  r record;
  v_bare constant text := '( SELECT app.is_system() AS is_system)';
  v_scoped constant text := '((SELECT app.is_system()) AND ((SELECT app.is_platform_context()) OR organization_id IS NULL OR organization_id = (SELECT app.system_org_id())))';
begin
  for r in
    select p.polname, c.oid::regclass as rel, pg_get_expr(p.polqual, p.polrelid) as q, pg_get_expr(p.polwithcheck, p.polrelid) as w
    from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid = p.polrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'audit') and not c.relispartition
      and exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
      and p.polroles @> array[(select oid from pg_catalog.pg_roles where rolname = 'flowza_system')]
      and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) like '%' || v_bare || '%'
      and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) not like '%system_org_id%'
  loop
    execute format('alter policy %I on %s%s%s', r.polname, r.rel,
      case when r.q is not null then ' using (' || replace(r.q, v_bare, v_scoped) || ')' else '' end,
      case when r.w is not null then ' with check (' || replace(r.w, v_bare, v_scoped) || ')' else '' end);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 9. A row addressed to a user is theirs while they are a member of its organisation
-- ---------------------------------------------------------------------------------------------------------------------------
-- The self predicates below read by user id alone: a member who left (or whose membership was suspended) kept reading the
-- organisation's notices, report deliveries, report requests and preferences addressed to them — names, dates and
-- decisions of the organisation they no longer belong to. Each self term gains the membership test, in place; a policy that
-- already tests membership (or has been replaced since) is left alone, and the invariant suite (X2) proves the result.
do $$
declare
  r record;
  p record;
  v_member constant text := '(organization_id = ANY ((SELECT app.member_org_ids())::uuid[]))';
begin
  for r in select * from (values
      ('public.notifications', 'notifications_self', '(user_id = app.uid())'),
      ('public.notifications', 'notifications_self_update', '(user_id = app.uid())'),
      ('public.notification_preferences', 'notification_preferences_self_select', '(user_id = app.uid())'),
      ('public.notification_preferences', 'notification_preferences_self_delete', '(user_id = app.uid())'),
      ('public.report_deliveries', 'report_deliveries_select', '(recipient_user_id = ( SELECT app.uid() AS uid))'),
      ('public.report_requests', 'report_requests_select', '(requested_by = app.uid())')
    ) v(rel, pol, self_term)
  loop
    for p in select pg_get_expr(x.polqual, x.polrelid) as q, pg_get_expr(x.polwithcheck, x.polrelid) as w
             from pg_catalog.pg_policy x where x.polrelid = to_regclass(r.rel) and x.polname = r.pol loop
      if coalesce(p.q, '') like '%' || r.self_term || '%' and coalesce(p.q, '') not like '%member_org_ids%' then
        execute format('alter policy %I on %s using (%s)', r.pol, r.rel, replace(p.q, r.self_term, '(' || r.self_term || ' AND ' || v_member || ')'));
      end if;
      if coalesce(p.w, '') like '%' || r.self_term || '%' and coalesce(p.w, '') not like '%member_org_ids%' then
        execute format('alter policy %I on %s with check (%s)', r.pol, r.rel, replace(p.w, r.self_term, '(' || r.self_term || ' AND ' || v_member || ')'));
      end if;
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Safety net (every table keeps RLS on) and post-verify
-- ---------------------------------------------------------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p') and n.nspname in ('public', 'audit') and not c.relrowsecurity
  loop
    raise exception 'table %.% has no RLS', r.nspname, r.relname;
  end loop;
end $$;

do $$
declare
  v_bad text;
  v_table text;
begin
  -- 1. partitions: RLS on, nothing granted to a client role
  select string_agg(c.relname, ', ') into v_bad from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'audit') and c.relispartition and c.relkind in ('r', 'p')
    and (not c.relrowsecurity
         or has_table_privilege('authenticated', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'insert')
         or has_table_privilege('authenticated', c.oid, 'update') or has_table_privilege('authenticated', c.oid, 'delete')
         or has_table_privilege('anon', c.oid, 'select'));
  if v_bad is not null then raise exception 'partitions still reachable directly: %', v_bad; end if;
  -- 2. tenant tables: the immutability trigger and the data-API denial (binding authenticated through flowza_client)
  if not pg_has_role('authenticated', 'flowza_client', 'usage') or not pg_has_role('anon', 'flowza_client', 'usage') then
    raise exception 'authenticated / anon do not inherit flowza_client: the restrictive denials would not bind them';
  end if;
  select string_agg(c.relname, ', ') into v_bad from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'audit') and c.relkind in ('r', 'p') and not c.relispartition
    and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
    and (not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'organization_id_immutable' and not t.tgisinternal)
         or not exists (select 1 from pg_policy p where p.polrelid = c.oid and not p.polpermissive and p.polname like '%\_no\_data\_api'
                        and p.polroles @> array[(select oid from pg_roles where rolname = 'flowza_client')]));
  if v_bad is not null then raise exception 'tenant tables without the immutability trigger or the data-API denial: %', v_bad; end if;
  -- forced wherever the owner can bypass
  select string_agg(c.relname, ', ') into v_bad from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_roles r on r.oid = c.relowner
  where n.nspname in ('public', 'audit') and c.relkind in ('r', 'p') and not c.relispartition and not c.relforcerowsecurity and (r.rolsuper or r.rolbypassrls)
    and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped);
  if v_bad is not null then raise exception 'tenant tables whose RLS is not forced: %', v_bad; end if;
  -- 3. SECURITY DEFINER: pinned search_path, not executable by PUBLIC / anon
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.prosecdef and n.nspname in ('app', 'public', 'secrets', 'audit', 'jobs')
    and (not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%')
         or has_function_privilege('anon', p.oid, 'execute')
         or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then raise exception 'SECURITY DEFINER functions reachable by PUBLIC / anon or without a pinned search_path: %', v_bad; end if;
  -- 4. system-written tables: no client write privilege, no permissive client write policy, three denials
  foreach v_table in array array['approval_requests', 'approval_steps', 'approval_step_actors', 'approval_request_events', 'approval_delegations',
    'approval_email_tokens', 'approval_digest_runs', 'attendance_day_marks', 'leave_records', 'leave_allocations', 'comp_off_credits', 'comp_off_usages',
    'leave_year_closes', 'attendance_daily_records', 'attendance_daily_record_history', 'attendance_period_summaries', 'attendance_events',
    'attendance_raw_transactions', 'notification_deliveries', 'missing_punch_reminders', 'report_deliveries', 'finance_sync_state', 'finance_pushed_events',
    'device_commands', 'device_logs', 'device_credentials', 'pending_devices', 'sync_attempts', 'sync_cursors', 'sync_logs', 'provider_circuit_states',
    'provider_webhook_events', 'usage_quotas', 'usage_records', 'platform_access_grants', 'attendance_notes', 'attendance_regularisation_requests',
    'employee_attendance_grants', 'selfie_checkins', 'shift_swap_requests', 'geofences', 'geofence_assignments'] loop
    if has_table_privilege('authenticated', 'public.' || v_table, 'insert') or has_table_privilege('authenticated', 'public.' || v_table, 'update')
       or has_table_privilege('authenticated', 'public.' || v_table, 'delete') then
      raise exception 'authenticated must not hold a write privilege on %', v_table;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = v_table and permissive = 'PERMISSIVE' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
               and ('authenticated' = any (roles) or 'public' = any (roles))) then
      raise exception '% must have no permissive client write policy', v_table;
    end if;
    -- (the denials bind authenticated directly or through flowza_client)
    if (select count(*) from pg_policy p where p.polrelid = ('public.' || v_table)::regclass and not p.polpermissive
          and p.polname in (v_table || '_deny_client_insert', v_table || '_deny_client_update', v_table || '_deny_client_delete')
          and exists (select 1 from unnest(p.polroles) r where pg_has_role('authenticated', r, 'usage'))) <> 3 then
      raise exception '% lacks its three explicit client write denials', v_table;
    end if;
  end loop;
  -- 5a. the system context of one organisation reaches no other organisation's rows
  select string_agg(c.relname || '.' || p.polname, ', ') into v_bad
  from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'audit') and not c.relispartition
    and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
    and p.polroles @> array[(select oid from pg_roles where rolname = 'flowza_system')]
    and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) like '%app.is_system()%'
    and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) not like '%system_org_id%';
  if v_bad is not null then raise exception 'system-context policies not scoped to the organisation: %', v_bad; end if;
  -- 5. escalation guards
  if not exists (select 1 from pg_trigger where tgname = 'org_memberships_no_escalation' and not tgisinternal)
     or not exists (select 1 from pg_trigger where tgname = 'membership_branches_no_escalation' and not tgisinternal)
     or not exists (select 1 from pg_trigger where tgname = 'invitations_no_escalation' and not tgisinternal) then
    raise exception 'escalation guards missing';
  end if;
  -- 6. the generators carry the tenant-table rules for the tables of the future
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'apply_tenant_policies' and p.prosrc like '%enforce_tenant_table%')
     or not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'apply_readonly_tenant_policies' and p.prosrc like '%enforce_tenant_table%' and p.prosrc like '%forbid_client_writes%')
     or not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'ensure_month_partitions' and p.prosrc like '%lock_partition%') then
    raise exception 'the policy generators / the partition maintainer do not apply the gate';
  end if;
end $$;
