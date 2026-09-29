-- Catalogue-driven security invariants (HR portal Prompt 10 — security & quality gate; migration 20260928001100).
--
-- Nothing here names a feature: every check is generated from the catalogue, so a table, partition, policy or function added
-- later is held to the same rules without anybody remembering to add a test. Run LAST by supabase/tests/run-rls-tests.sh, as
-- superuser, on top of the fixtures the other suites committed. Every probe that writes runs in a transaction that rolls back.
--
--  I1  every table of public / audit has RLS enabled; tenant tables (an organization_id column; partitions through their
--      parent) have it FORCED when their owner could bypass it
--  I2  every tenant table has a permissive SELECT policy, no policy for anon / PUBLIC, no privilege for anon / PUBLIC
--  I3  every tenant table has an index whose first column is organization_id; every foreign key of a tenant table has a covering
--      index (the key columns lead an index, in any order)
--  I4  every tenant table carries `organization_id_immutable` (and it fires: a generated probe moves one row of each table)
--  I5  every table of public / audit refuses the PostgREST / pg_graphql login (`<table>_no_data_api`, asserted behaviourally by
--      rls_data_api.sql, which runs connected as `authenticator`)
--  I6  partitions are storage: RLS on, no privilege for anon / authenticated / flowza_system (reached through their parent only)
--  I7  system-written ("RPC-write-only") tables: no client write privilege, no permissive client write policy, the three
--      restrictive `_deny_client_*` policies — and a member holding every permission is refused every write, behaviourally
--  I8  privilege ⇒ policy: a client write privilege on a table of public is backed by a permissive client policy for that
--      command (a latent privilege re-opens the table the day somebody adds a permissive policy)
--  I9  SECURITY DEFINER functions: search_path pinned, not executable by PUBLIC / anon (allow-list with a reason)
--  I10 the schemas that are not RLS-protected (jobs) are unreachable for anon / authenticated (no USAGE)
--  X1  generated cross-tenant probe: org A's rows are cloned into a second organisation; a member of org A holding EVERY
--      permission (custom role, all branches, linked to a line manager) reads 0 of that organisation's rows in every tenant
--      table, updates / deletes 0 of them, and every insert of such a row is refused by row security; the system context of
--      org A reads 0 of them too
--  X2  self-addressed probe: the same clone with every user reference pointed at the probing member — a user who is NOT a member
--      of an organisation reads none of its rows, even the ones addressed to them
\set QUIET on
\pset tuples_only on
\pset format unaligned
\set ON_ERROR_STOP on
set client_min_messages = warning;

create or replace function pg_temp.invariant(label text, offenders text[]) returns void language plpgsql as $$
begin
  if coalesce(cardinality(offenders), 0) > 0 then
    raise exception 'INVARIANT FAILED: % — % offender(s): %', label, cardinality(offenders), array_to_string(offenders, ', ');
  end if;
  raise notice 'ok: %', label;
end $$;

-- Allow-lists. Every entry carries its reason; an entry that no longer matches anything fails the suite (stale allow-lists hide
-- regressions). Owned-elsewhere entries name the fix in flight.
create temp table p10_allow (kind text not null, subject text not null, reason text not null, primary key (kind, subject)) on commit preserve rows;
-- Kinds: `no_rls` (I1), `latent_privilege` (I8), `secdef_public` (I9), `system_scope` (X1, system context), `self_addressed`
-- (X2). The tables without RLS (jobs.queue, jobs.queue_archive: the job queue of the service logins) live outside public /
-- audit and are held by I10 instead: no USAGE on their schema for anon / authenticated.
insert into p10_allow (kind, subject, reason) values
  -- owned by Prompt 8 fix (in flight): the outbox policies of domain_events are being replaced (8-P0-1, client inserts);
  -- domain_events_system (`app.is_system() OR organization_id = app.system_org_id()`, WITH CHECK `app.is_system()`) lets
  -- any organisation's system context read and write every organisation's events — scope it to app.system_org_id() there
  ('system_scope', 'domain_events', 'owned by Prompt 8 fix (in flight): domain_events_system is not scoped to the system context''s organisation');

create temp table p10_seen (kind text not null, subject text not null, primary key (kind, subject)) on commit preserve rows;
create or replace function pg_temp.allowed(p_kind text, p_subject text) returns boolean language plpgsql as $$
begin
  if exists (select 1 from p10_allow where kind = p_kind and subject = p_subject) then
    insert into p10_seen values (p_kind, p_subject) on conflict do nothing;
    return true;
  end if;
  return false;
end $$;

-- A policy binds a role when it is for PUBLIC or for a role whose privileges that role has (restrictive denials of the gate are
-- for flowza_client, which authenticated and anon inherit)
create or replace function pg_temp.binds(p_roles oid[], p_role text) returns boolean language sql stable as $$
  select p_roles @> array[0::oid] or exists (select 1 from unnest(p_roles) r where pg_has_role(p_role, r, 'usage'))
$$;

-- The catalogue: tenant tables (public / audit, an organization_id column, parents of partitions only)
create temp view p10_tenant as
  select c.oid, n.nspname, c.relname, format('%I.%I', n.nspname, c.relname) as qname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
         (r.rolsuper or r.rolbypassrls) as owner_bypasses
  from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_roles r on r.oid = c.relowner
  where n.nspname in ('public', 'audit') and c.relkind in ('r', 'p') and not c.relispartition
    and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped);

-- The tables the API / worker write in the system context only (migration 20260928001100 §5 + the earlier service-write-only
-- tables). A table leaves this list only together with a migration that gives clients a reviewed write path.
create temp table p10_rpc_only (relname text primary key) on commit preserve rows;
insert into p10_rpc_only values
  ('approval_requests'), ('approval_steps'), ('approval_step_actors'), ('approval_request_events'), ('approval_delegations'),
  ('approval_email_tokens'), ('approval_digest_runs'),
  ('attendance_day_marks'), ('leave_records'), ('leave_allocations'), ('comp_off_credits'), ('comp_off_usages'), ('leave_year_closes'),
  ('attendance_daily_records'), ('attendance_daily_record_history'), ('attendance_period_summaries'), ('attendance_events'),
  ('attendance_raw_transactions'),
  ('notification_deliveries'), ('missing_punch_reminders'), ('report_deliveries'), ('finance_sync_state'), ('finance_pushed_events'),
  ('device_commands'), ('device_logs'), ('device_credentials'), ('pending_devices'), ('sync_attempts'), ('sync_cursors'), ('sync_logs'),
  ('provider_circuit_states'), ('provider_webhook_events'), ('usage_quotas'), ('usage_records'), ('platform_access_grants'),
  -- earlier prompts: service-write-only already (portal attendance review 20260928000840, HR workspace 20260928000820)
  ('attendance_notes'), ('attendance_regularisation_requests'), ('employee_attendance_grants'), ('selfie_checkins'),
  ('shift_swap_requests'), ('geofences'), ('geofence_assignments'),
  -- modules, plans & billing (20260929000600): written by the system context after requirePlatformAdmin only
  ('organization_modules'), ('billing_invoices'), ('billing_payments');
grant select on p10_tenant, p10_rpc_only, p10_allow, p10_seen to public;
grant insert on p10_seen to public;
set client_min_messages = notice;

-- ---------- I1 · I2 · I3 · I4 · I5 (structure) ----------
select pg_temp.invariant('I1 every table of public / audit has RLS enabled',
  (select array_agg(format('%I.%I', n.nspname, c.relname) order by 1) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'audit') and c.relkind in ('r', 'p') and not c.relrowsecurity
     and not pg_temp.allowed('no_rls', format('%I.%I', n.nspname, c.relname))));
select pg_temp.invariant('I1 tenant tables force RLS (owner can bypass it)',
  (select array_agg(qname order by 1) from p10_tenant where owner_bypasses and not relforcerowsecurity));
-- FORCE binds the table owner only, and superusers / BYPASSRLS roles are never bound: what actually protects the data is that
-- no application login owns a table (the services connect as flowza_api / flowza_worker and are always subject to RLS)
select pg_temp.invariant('I1 no table of public / audit is owned by an application or client role',
  (select array_agg(format('%I.%I → %s', n.nspname, c.relname, pg_get_userbyid(c.relowner)) order by 1) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'audit') and c.relkind in ('r', 'p', 'v', 'm')
     and pg_get_userbyid(c.relowner) in ('flowza_api', 'flowza_worker', 'flowza_system', 'authenticated', 'anon', 'authenticator', 'service_role')));
select pg_temp.invariant('I2 every tenant table has a permissive SELECT policy',
  (select array_agg(qname order by 1) from p10_tenant t
   where not exists (select 1 from pg_policy p where p.polrelid = t.oid and p.polpermissive and p.polcmd in ('r', '*'))));
select pg_temp.invariant('I2 no PERMISSIVE tenant-table policy applies to anon or PUBLIC (restrictive denials may)',
  (select array_agg(t.qname || '.' || p.polname order by 1) from p10_tenant t join pg_policy p on p.polrelid = t.oid
   where p.polpermissive and pg_temp.binds(p.polroles, 'anon')));
select pg_temp.invariant('I2 anon and PUBLIC hold no privilege on a table of public / audit',
  (select array_agg(format('%I.%I', n.nspname, c.relname) order by 1) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'audit') and c.relkind in ('r', 'p', 'v', 'm')
     and (has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate,references,trigger')
          or exists (select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x where x.grantee = 0))));
select pg_temp.invariant('I3 every tenant table has an organization_id-leading index',
  (select array_agg(qname order by 1) from p10_tenant t
   where not exists (select 1 from pg_index i join pg_attribute a on a.attrelid = t.oid and a.attnum = i.indkey[0]
                     where i.indrelid = t.oid and a.attname = 'organization_id')));
select pg_temp.invariant('I3 every foreign key of a tenant table has a covering index',
  (select array_agg(t.qname || '.' || k.conname order by 1) from p10_tenant t join pg_constraint k on k.conrelid = t.oid and k.contype = 'f'
   where not exists (
     select 1 from pg_index i where i.indrelid = t.oid and i.indnkeyatts >= cardinality(k.conkey)
       and (select array_agg(x order by x) from unnest((i.indkey::int2[])[0:cardinality(k.conkey) - 1]) x) = (select array_agg(x order by x) from unnest(k.conkey) x))));
select pg_temp.invariant('I4 every tenant table carries the organization_id_immutable trigger',
  (select array_agg(qname order by 1) from p10_tenant t
   where not exists (select 1 from pg_trigger g join pg_proc f on f.oid = g.tgfoid
                     where g.tgrelid = t.oid and g.tgname = 'organization_id_immutable' and g.tgenabled in ('O', 'A')
                       and f.oid = 'app.forbid_tenant_key_change()'::regprocedure and (g.tgtype & 16) <> 0 and (g.tgtype & 2) <> 0)));
select pg_temp.invariant('I5 every table of public / audit refuses the data API login (restrictive <table>_no_data_api)',
  (select array_agg(format('%I.%I', n.nspname, c.relname) order by 1) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'audit') and c.relkind in ('r', 'p') and not c.relispartition and c.relrowsecurity
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid and not p.polpermissive and p.polcmd = '*'
                     and p.polname like '%\_no\_data\_api' and pg_get_expr(p.polqual, p.polrelid) like '%authenticator%'
                     and pg_get_expr(p.polwithcheck, p.polrelid) like '%authenticator%'
                     and pg_temp.binds(p.polroles, 'authenticated') and pg_temp.binds(p.polroles, 'anon'))));

-- ---------- I6 partitions ----------
select pg_temp.invariant('I6 partitions have RLS on and no privilege for anon / authenticated / flowza_system / PUBLIC',
  (select array_agg(format('%I.%I', n.nspname, c.relname) order by 1) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'audit') and c.relispartition and c.relkind in ('r', 'p')
     and (not c.relrowsecurity
          or has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate')
          or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete,truncate')
          or has_table_privilege('flowza_system', c.oid, 'select,insert,update,delete,truncate')
          or exists (select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x where x.grantee = 0))));
select pg_temp.invariant('I6 app.ensure_month_partitions locks the partitions it creates',
  case when pg_get_functiondef('app.ensure_month_partitions(regclass, date, int)'::regprocedure) like '%app.lock_partition%' then null else array['app.ensure_month_partitions'] end);

-- ---------- I7 system-written tables (structure) ----------
select pg_temp.invariant('I7 the system-written tables exist (the list is not stale)',
  (select array_agg(relname order by 1) from p10_rpc_only o where to_regclass('public.' || o.relname) is null));
select pg_temp.invariant('I7 system-written tables: no client write privilege (table or column)',
  (select array_agg(o.relname || ':' || v.priv order by 1) from p10_rpc_only o cross join (values ('insert'), ('update'), ('delete')) v(priv)
   where to_regclass('public.' || o.relname) is not null
     and (has_table_privilege('authenticated', ('public.' || o.relname)::regclass, v.priv)
          or (v.priv <> 'delete' and has_any_column_privilege('authenticated', ('public.' || o.relname)::regclass, v.priv)))));
select pg_temp.invariant('I7 system-written tables: no permissive client write policy',
  (select array_agg(o.relname || '.' || p.polname order by 1) from p10_rpc_only o join pg_policy p on p.polrelid = to_regclass('public.' || o.relname)
   where p.polpermissive and p.polcmd in ('a', 'w', 'd', '*')
     and pg_temp.binds(p.polroles, 'authenticated')));
select pg_temp.invariant('I7 system-written tables: the three restrictive client-write denials, binding authenticated',
  (select array_agg(o.relname order by 1) from p10_rpc_only o
   where to_regclass('public.' || o.relname) is not null
     and (select count(*) from pg_policy p where p.polrelid = to_regclass('public.' || o.relname) and not p.polpermissive
            and p.polname in (o.relname || '_deny_client_insert', o.relname || '_deny_client_update', o.relname || '_deny_client_delete')
            and pg_temp.binds(p.polroles, 'authenticated')) <> 3));
select pg_temp.invariant('I7 any table carrying a client-write denial holds no matching client privilege or permissive policy',
  (select array_agg(c.relname || ':' || v.priv order by 1)
   from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
   join (values ('insert', 'a'), ('update', 'w'), ('delete', 'd')) v(priv, cmd) on p.polname = c.relname || '_deny_client_' || v.priv
   where n.nspname = 'public' and not p.polpermissive
     and ((has_table_privilege('authenticated', c.oid, v.priv) or (v.priv <> 'delete' and has_any_column_privilege('authenticated', c.oid, v.priv))
           and not (c.relname = 'notifications' and v.priv = 'update'))
          or exists (select 1 from pg_policy q where q.polrelid = c.oid and q.polpermissive and q.polcmd in (v.cmd::"char", '*')
                     and pg_temp.binds(q.polroles, 'authenticated')))));

-- ---------- I8 privilege ⇒ policy ----------
select pg_temp.invariant('I8 every client write privilege on a table of public is backed by a permissive client policy',
  (select array_agg(c.relname || ':' || v.priv order by 1)
   from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join (values ('insert', 'a'), ('update', 'w'), ('delete', 'd')) v(priv, cmd)
   where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
     and (has_table_privilege('authenticated', c.oid, v.priv) or (v.priv <> 'delete' and has_any_column_privilege('authenticated', c.oid, v.priv)))
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polpermissive and p.polcmd in (v.cmd::"char", '*')
                     and pg_temp.binds(p.polroles, 'authenticated'))
     and not pg_temp.allowed('latent_privilege', c.relname || ':' || v.priv)));

-- ---------- I9 SECURITY DEFINER ----------
select pg_temp.invariant('I9 SECURITY DEFINER functions pin search_path',
  (select array_agg(p.oid::regprocedure::text order by 1) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%' and c not like '%$user%' and c not like '%pg\_temp%')));
select pg_temp.invariant('I9 SECURITY DEFINER functions are not executable by PUBLIC / anon',
  (select array_agg(p.oid::regprocedure::text order by 1) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')
     and (has_function_privilege('anon', p.oid, 'execute') or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0))
     and not pg_temp.allowed('secdef_public', p.oid::regprocedure::text)));
-- the migration-only procedures stay out of every application role's reach
select pg_temp.invariant('I9 migration-only procedures are not executable by application roles',
  (select array_agg(p.oid::regprocedure::text || '→' || r.rolname order by 1)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join (select rolname from pg_roles where rolname in ('authenticated', 'flowza_system', 'flowza_api', 'flowza_worker', 'anon')) r
   where n.nspname = 'app' and p.proname in ('apply_tenant_policies', 'apply_readonly_tenant_policies', 'deny_client_writes', 'deny_data_api', 'force_rls',
                                             'enforce_tenant_table', 'lock_partition', 'make_system_write_only')
     and has_function_privilege(r.rolname, p.oid, 'execute')));

-- ---------- I10 schemas without RLS ----------
select pg_temp.invariant('I10 schemas holding tables without RLS grant no USAGE to anon / authenticated',
  (select array_agg(distinct n.nspname || '→' || r.rolname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated')) r
   where c.relkind in ('r', 'p') and not c.relrowsecurity and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast', 'extensions')
     and n.nspname not like 'pg\_%' and n.nspname not in ('auth', 'storage', 'realtime', 'supabase_migrations', 'vault', 'graphql', 'graphql_public', 'net', 'cron', 'pgsodium')
     and has_schema_privilege(r.rolname, n.oid, 'usage')));

-- ---------- X1 · X2 · I4 · I7 (behaviour): generated probes over clones of org A ----------
-- org A = the isolation fixtures' organisation; B = a second organisation holding clones of org A's rows (ids remapped
-- consistently, users remapped to a ghost user); C = a third organisation whose clones address every user reference to the
-- probing member (who is not a member of C).
create or replace function pg_temp.clone_org(p_from uuid, p_to uuid, p_salt text, p_user uuid, p_skip text[], p_limit int) returns table (tbl text, cloned bigint, note text)
language plpgsql as $$
declare
  r record;
  v_cols text; v_exprs text; v_n bigint; v_attempt int;
begin
  perform set_config('session_replication_role', 'replica', true); -- clones only: foreign keys and triggers are not the subject
  for r in select t.oid, t.qname, t.relname from p10_tenant t where t.relname <> all (p_skip) order by t.qname loop
    -- attempt 1 copies text keys as they are; attempt 2 (a key collided with the target's own rows) suffixes them
    for v_attempt in 1..2 loop
      select string_agg(quote_ident(a.attname), ', ' order by a.attnum),
             string_agg(case
               when a.attname = 'organization_id' then quote_literal(p_to) || '::uuid'
               when a.atttypid = 'uuid'::regtype then format('pg_temp.remap(%I, %L, %L)', a.attname, p_salt, p_user)
               when a.atttypid = 'uuid[]'::regtype then format('array(select pg_temp.remap(e, %L, %L) from unnest(%I) e)', p_salt, p_user, a.attname)
               -- a text key (a code, a device user id, a token hash) must not collide with the target organisation's own rows
               when v_attempt = 2 and (a.atttypid in ('text'::regtype, 'varchar'::regtype) or format_type(a.atttypid, null) like '%citext')
                    -- (only in a unique key that no remapped uuid column already makes distinct)
                    and exists (select 1 from pg_index i where i.indrelid = r.oid and i.indisunique and a.attnum = any (i.indkey)
                                and not exists (select 1 from pg_attribute u where u.attrelid = r.oid and u.attnum = any (i.indkey)
                                                and u.atttypid = 'uuid'::regtype and u.attname <> 'organization_id'))
                 then format('case when %1$I::text ~ ''^[0-9a-f]{64}$'' then encode(sha256(convert_to(%1$I::text || %2$L, ''UTF8'')), ''hex'') else %1$I || %3$L end',
                             a.attname, p_salt, '_' || replace(p_salt, ':', ''))
               else quote_ident(a.attname) end, ', ' order by a.attnum)
        into v_cols, v_exprs
      from pg_attribute a
      where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity = '';
      begin
        execute format('insert into %s (%s) select %s from %s where organization_id = %L limit %s', r.qname, v_cols, v_exprs, r.qname, p_from, p_limit);
        get diagnostics v_n = row_count;
        tbl := r.qname; cloned := v_n; note := null; return next;
        exit;
      exception when others then
        if v_attempt = 2 then tbl := r.qname; cloned := 0; note := sqlerrm; return next; end if;
      end;
    end loop;
  end loop;
  perform set_config('session_replication_role', 'origin', true);
end $$;

-- the ids of org A's rows (every uuid of a primary or unique key) and the users: remapped consistently in every column that
-- holds them (a user becomes a distinct ghost, or the probing member when p_user is given)
create temp table p10_ids (id uuid primary key) on commit delete rows;
grant select on p10_ids to public;
create or replace function pg_temp.remap(v uuid, p_salt text, p_user uuid) returns uuid language sql stable as $$
  select case
    when v is null then null
    when exists (select 1 from p10_ids i where i.id = v) then md5(v::text || p_salt)::uuid
    when exists (select 1 from public.user_profiles u where u.id = v) then coalesce(p_user, md5(v::text || p_salt || ':user')::uuid)
    else v end
$$;

-- a tenant table with no row of the probed organisation gets one synthesized row (NOT NULL columns without a default get a
-- value of their type — a literal a single-column CHECK names first, then a plain one; user references become p_user or a
-- ghost; a reference to another tenant table points at that table's row of the same organisation when there is one)
create or replace function pg_temp.synthesize(p_org uuid, p_user uuid, p_skip text[]) returns table (tbl text, note text)
language plpgsql as $$
declare
  r record; col record;
  v_found boolean; v_cols text[]; v_vals text[]; v_lit text; v_attempt int; v_err text; v_n int; v_ref record; v_checks text; v_filled boolean;
begin
  perform set_config('session_replication_role', 'replica', true);
  for r in select t.oid, t.qname, t.relname from p10_tenant t where t.relname <> all (p_skip) order by t.qname loop
    execute format('select exists (select 1 from %s where organization_id = %L)', r.qname, p_org) into v_found;
    continue when v_found;
    for v_attempt in 1..3 loop
      v_cols := '{}'; v_vals := '{}'; v_n := 0; v_filled := false;
      for col in
        select a.attname, a.atttypid, a.attnum, format_type(a.atttypid, a.atttypmod) as typ, ty.typtype, ty.typcategory,
               exists (select 1 from pg_attrdef d where d.adrelid = r.oid and d.adnum = a.attnum) as has_default, a.attnotnull
        from pg_attribute a join pg_type ty on ty.oid = a.atttypid
        where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity = ''
        order by a.attnum
      loop
        v_n := v_n + 1;
        v_lit := null;
        -- what the table's CHECK constraints on this column look for (a dotted name, a year, an array)
        select string_agg(pg_get_constraintdef(k.oid), ' ') into v_checks
        from pg_constraint k where k.conrelid = r.oid and k.contype = 'c' and col.attnum = any (k.conkey);
        if col.attname = 'organization_id' then
          v_lit := quote_literal(p_org) || '::uuid';
        elsif col.has_default or not col.attnotnull then
          -- a nullable user reference still points at the probed user (the self-addressed probe needs it)
          if p_user is not null and col.atttypid = 'uuid'::regtype and exists (
               select 1 from pg_constraint k where k.conrelid = r.oid and k.contype = 'f' and k.conkey = array[col.attnum]::int2[]
                 and k.confrelid in ('public.user_profiles'::regclass, 'auth.users'::regclass)) then
            v_lit := quote_literal(p_user) || '::uuid';
          -- attempt 3: the first nullable reference a CHECK names (one-of-two targets) is filled
          elsif v_attempt = 3 and not v_filled and not col.has_default and col.atttypid = 'uuid'::regtype and v_checks is not null then
            v_filled := true;
            select k.confrelid::regclass::text as reftable, (select attname from pg_attribute where attrelid = k.confrelid and attnum = k.confkey[1]) as refcol
              into v_ref
            from pg_constraint k where k.conrelid = r.oid and k.contype = 'f' and col.attnum = any (k.conkey) and k.confrelid <> 'public.organizations'::regclass
            order by cardinality(k.conkey) limit 1;
            v_lit := case when v_ref.reftable is not null then format('coalesce((select %I from %s where organization_id = %L limit 1), gen_random_uuid())', v_ref.refcol, v_ref.reftable, p_org)
                          else 'gen_random_uuid()' end;
          else
            continue;
          end if;
        else
          if v_attempt = 1 then
            select (regexp_match(pg_get_constraintdef(k.oid), '''([^''^$\\]*)''::'))[1] into v_lit
            from pg_constraint k where k.conrelid = r.oid and k.contype = 'c' and k.conkey = array[col.attnum]::int2[] limit 1;
            if v_lit is not null then v_lit := quote_literal(v_lit) || '::' || col.typ; end if;
          end if;
          if v_lit is null and col.atttypid = 'uuid'::regtype then
            select k.confrelid::regclass::text as reftable, (select attname from pg_attribute where attrelid = k.confrelid and attnum = k.confkey[1]) as refcol,
                   exists (select 1 from pg_attribute x where x.attrelid = k.confrelid and x.attname = 'organization_id') as ref_tenant
              into v_ref
            from pg_constraint k where k.conrelid = r.oid and k.contype = 'f' and col.attnum = any (k.conkey) and k.confrelid <> 'public.organizations'::regclass
            order by cardinality(k.conkey) limit 1;
            if v_ref.reftable in ('user_profiles', 'public.user_profiles', 'auth.users') then
              v_lit := coalesce(quote_literal(p_user) || '::uuid', 'gen_random_uuid()');
            elsif v_ref.reftable is not null and v_ref.ref_tenant then
              v_lit := format('coalesce((select %I from %s where organization_id = %L limit 1), gen_random_uuid())', v_ref.refcol, v_ref.reftable, p_org);
            elsif v_ref.reftable is not null then
              v_lit := format('coalesce((select %I from %s limit 1), gen_random_uuid())', v_ref.refcol, v_ref.reftable);
            else
              v_lit := 'gen_random_uuid()';
            end if;
          end if;
          if v_lit is null then
            v_lit := case
              when col.typtype = 'e' then quote_literal((select enumlabel from pg_enum where enumtypid = col.atttypid order by enumsortorder limit 1)) || '::' || col.typ
              when col.typcategory = 'A' then '''{}'''
              when (col.atttypid in ('text'::regtype, 'varchar'::regtype, 'bpchar'::regtype) or col.typ like '%citext') and v_attempt = 1 then quote_literal('p10-' || v_n)
              when (col.atttypid in ('text'::regtype, 'varchar'::regtype, 'bpchar'::regtype) or col.typ like '%citext') and coalesce(v_checks, '') like '%\\.%' then quote_literal('probe.value')
              when col.atttypid in ('text'::regtype, 'varchar'::regtype, 'bpchar'::regtype) or col.typ like '%citext' then quote_literal('probe_value')
              when col.typcategory = 'N' and coalesce(v_checks, '') ~ '\m[12][0-9]{3}\M' then '2026'
              when col.typcategory = 'N' then '1'
              when col.atttypid = 'bool'::regtype then 'false'
              when col.atttypid = 'date'::regtype then format('current_date + %s', v_n)
              when col.atttypid in ('timestamptz'::regtype, 'timestamp'::regtype) then format('now() + interval ''%s hours''', v_n)
              when col.atttypid = 'time'::regtype then quote_literal(format('%s:00', 6 + v_n % 12))
              when col.atttypid = 'interval'::regtype then '''1 hour'''
              when col.atttypid in ('jsonb'::regtype, 'json'::regtype) and coalesce(v_checks, '') like '%array%' then '''[{}]'''
              when col.atttypid in ('jsonb'::regtype, 'json'::regtype) then '''{}'''
              when col.atttypid = 'daterange'::regtype then '''[2026-01-01,2026-01-02)'''
              when col.atttypid = 'tstzrange'::regtype then '''[2026-01-01 00:00+00,2026-01-02 00:00+00)'''
              when col.atttypid = 'inet'::regtype then '''127.0.0.1'''
              when col.atttypid = 'bytea'::regtype then '''\x00'''
              else null end;
          end if;
        end if;
        v_cols := v_cols || quote_ident(col.attname);
        v_vals := v_vals || coalesce(v_lit, 'null');
      end loop;
      begin
        execute format('insert into %s (%s) values (%s)', r.qname, array_to_string(v_cols, ', '), array_to_string(v_vals, ', '));
        tbl := r.qname; note := null; return next;
        exit;
      exception when others then
        v_err := sqlerrm;
        if v_attempt = 3 then tbl := r.qname; note := v_err; return next; end if;
      end;
    end loop;
  end loop;
  perform set_config('session_replication_role', 'origin', true);
end $$;

begin;
insert into public.organizations (id, company_code, legal_name, display_name) values
  ('0e000000-0000-0000-0000-000000000000', 'TEST-P10C', 'Probe Org C LLC', 'Probe Org C');
insert into auth.users (id, email) values ('0d000000-0000-0000-0000-000000000002', 'probe@test.local');
insert into public.user_profiles (id, email, full_name) values ('0d000000-0000-0000-0000-000000000002', 'probe@test.local', 'Probe');
-- tables the fixtures leave empty in org A get one synthesized row there first: the clones then carry them to B and C, and the
-- probe's own organisation shows it CAN read them (the positive control of every zero below)
-- (a workflow's steps are validated structurally, beyond what the synthesizer can guess: one written by hand)
insert into public.approval_workflows (organization_id, entity_type, name, steps, status)
  values ('0a000000-0000-0000-0000-000000000000', 'ATTENDANCE_CORRECTION', 'Probe workflow', '[{"order":1,"approverType":"MANAGER","mode":"ANY"}]', 'active');
-- (a billing payment must match its invoice's organisation and ISO currency: an invoice and its payment written by hand)
insert into public.billing_invoices (id, organization_id, invoice_number, currency, subtotal, tax_rate, tax_amount, total)
  values ('0a000000-0000-0000-0000-0000000008b1', '0a000000-0000-0000-0000-000000000000', 'PROBE-2026-00001', 'OMR', 100, 5, 5, 105);
insert into public.billing_payments (organization_id, invoice_id, amount, currency, method)
  values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000008b1', 50, 'OMR', 'bank_transfer');
create temp table p10_synth_a on commit drop as select * from pg_temp.synthesize('0a000000-0000-0000-0000-000000000000', null, array[]::text[]);
do $$
declare r record;
begin
  for r in
    select distinct t.qname, a.attname from p10_tenant t
    join pg_index i on i.indrelid = t.oid and (i.indisunique or i.indisexclusion)
    join pg_attribute a on a.attrelid = t.oid and a.attnum = any (i.indkey) and a.atttypid = 'uuid'::regtype and a.attname <> 'organization_id'
  loop
    execute format('insert into p10_ids select distinct x.%I from %s x where x.organization_id = %L and x.%I is not null
                      and not exists (select 1 from public.user_profiles u where u.id = x.%I) on conflict do nothing',
                   r.attname, r.qname, '0a000000-0000-0000-0000-000000000000', r.attname, r.attname);
  end loop;
end $$;
-- B's user references become ghosts (nobody); the probe user is a member of org A only
create temp table p10_clone_b on commit drop as select * from pg_temp.clone_org('0a000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-000000000000', ':p10b', null, array[]::text[], 200);
-- C: membership-defining rows are not cloned (they would make the probe a member of C, which is not the question asked)
-- one row per table (every user reference of it becomes the probe, so a second row could collide on a per-user unique key)
create temp table p10_clone_c on commit drop as select * from pg_temp.clone_org('0a000000-0000-0000-0000-000000000000', '0e000000-0000-0000-0000-000000000000', ':p10c', '0d000000-0000-0000-0000-000000000002', array['org_memberships', 'platform_access_grants'], 1);
select pg_temp.invariant('X0 every tenant table with org A rows was cloned (probe coverage)',
  (select array_agg(tbl || ' (' || note || ')' order by 1) from p10_clone_b where note is not null));
-- whatever could not be cloned: one synthesized row in B and in C
create temp table p10_synth_b on commit drop as select * from pg_temp.synthesize('0b000000-0000-0000-0000-000000000000', null, array[]::text[]);
create temp table p10_synth_c on commit drop as select * from pg_temp.synthesize('0e000000-0000-0000-0000-000000000000', '0d000000-0000-0000-0000-000000000002', array['org_memberships', 'platform_access_grants']);
-- the probe: a custom role holding EVERY permission, all branches, linked to e4 (line manager of e1) — the widest member of A
insert into public.roles (id, organization_id, key, name) values ('0a000000-0000-0000-0000-0000000009ff', '0a000000-0000-0000-0000-000000000000', 'probe_all', 'Probe: every permission');
set local session_replication_role = replica;
insert into public.role_permissions (role_id, permission_key) select '0a000000-0000-0000-0000-0000000009ff', key from public.permissions;
set local session_replication_role = origin;
insert into public.org_memberships (organization_id, user_id, role_id, status, all_branches, employee_id) values
  ('0a000000-0000-0000-0000-000000000000', '0d000000-0000-0000-0000-000000000002', '0a000000-0000-0000-0000-0000000009ff', 'active', true, null);
-- (e4 is linked to manager-a; the probe borrows the team through a second employee of A that manages e2)
insert into public.employees (id, organization_id, employee_number, first_name, last_name, display_name, joining_date, branch_id, device_user_id)
  values ('0a000000-0000-0000-0000-0000000009e1', '0a000000-0000-0000-0000-000000000000', 'PROBE-1', 'Probe', 'Manager', 'Probe Manager', '2025-01-01', '0a000000-0000-0000-0000-00000000000b', 'probe-1');
update public.org_memberships set employee_id = '0a000000-0000-0000-0000-0000000009e1' where user_id = '0d000000-0000-0000-0000-000000000002';
update public.employees set secondary_manager_employee_id = '0a000000-0000-0000-0000-0000000009e1' where id = '0a000000-0000-0000-0000-0000000000e2';
create temp table p10_rowcount (tbl text primary key, rows_a bigint, rows_b bigint, rows_c bigint) on commit drop;
do $$
declare r record; a bigint; b bigint; c bigint;
begin
  for r in select qname from p10_tenant loop
    execute format('select count(*) filter (where organization_id = %L), count(*) filter (where organization_id = %L), count(*) filter (where organization_id = %L) from %s',
                   '0a000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-000000000000', '0e000000-0000-0000-0000-000000000000', r.qname) into a, b, c;
    insert into p10_rowcount values (r.qname, a, b, c);
  end loop;
end $$;
grant select on p10_rowcount, p10_clone_b, p10_clone_c to public;
-- coverage: every tenant table holds rows of org B, so every one is probed. A new table the synthesizer cannot fill (a CHECK
-- it cannot guess) fails here — add one hand-written row for it next to the approval workflow above.
select pg_temp.invariant(format('X0 the probes reach every tenant table (%s of %s hold rows of org B)',
    (select count(*) from p10_rowcount where rows_b > 0), (select count(*) from p10_rowcount)),
  (select array_agg(c.tbl || coalesce(' — ' || s.note, '') order by c.tbl) from p10_rowcount c left join p10_synth_b s on s.tbl = c.tbl where c.rows_b = 0));

-- I4 (behaviour): moving any row of any tenant table to another organisation is refused by the trigger itself (other BEFORE
-- UPDATE triggers of the table are disabled for the probe, so the answer is the immutability trigger's own)
do $$
declare
  r record; g record; v_err text; v_bad text[] := '{}'; v_probed int := 0;
begin
  for r in select t.qname, t.oid from p10_tenant t join p10_rowcount c on c.tbl = t.qname where c.rows_a > 0 or c.rows_b > 0 loop
    begin
      for g in select tgname from pg_trigger where tgrelid = r.oid and not tgisinternal and tgname <> 'organization_id_immutable' and (tgtype & 2) <> 0 and (tgtype & 16) <> 0 loop
        execute format('alter table %s disable trigger %I', r.qname, g.tgname);
      end loop;
      begin
        execute format('update %s set organization_id = case when organization_id = %L then %L::uuid else %L::uuid end where (tableoid, ctid) = (select tableoid, ctid from %s where organization_id in (%L, %L) limit 1)',
                       r.qname, '0a000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000000000',
                       r.qname, '0a000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-000000000000');
        v_bad := v_bad || (r.qname || ' (moved)');
      exception when others then
        get stacked diagnostics v_err = message_text;
        if v_err not like 'organization_id of % is immutable%' then v_bad := v_bad || (r.qname || ' (' || v_err || ')'); end if;
      end;
      v_probed := v_probed + 1;
      raise exception using errcode = 'P0100', message = 'undo the trigger toggles';
    exception when sqlstate 'P0100' then null;
    end;
  end loop;
  perform pg_temp.invariant(format('I4 (behaviour) no row of the %s probed tenant tables moves to another organisation', v_probed), v_bad);
end $$;

-- X1 as the probe (a member of org A holding every permission): nothing of org B is readable
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"0d000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
do $$
declare
  r record; v_n bigint;
  v_read text[] := '{}'; v_write text[] := '{}'; v_probed int := 0; v_visible_a int := 0; v_unreadable text[] := '{}';
begin
  if app.uid() is distinct from '0d000000-0000-0000-0000-000000000002'::uuid then raise exception 'probe identity not in effect'; end if;
  if not ('0a000000-0000-0000-0000-000000000000' = any (app.member_org_ids())) or '0b000000-0000-0000-0000-000000000000' = any (app.member_org_ids()) then
    raise exception 'probe membership is not what the probe assumes';
  end if;
  for r in select t.qname, c.rows_a, c.rows_b from p10_tenant t join p10_rowcount c on c.tbl = t.qname order by 1 loop
    if r.rows_b > 0 then v_probed := v_probed + 1; end if;
    begin
      execute format('select count(*) from %s where organization_id = %L', r.qname, '0b000000-0000-0000-0000-000000000000') into v_n;
      if v_n > 0 then v_read := v_read || format('%s (%s rows)', r.qname, v_n); end if;
      execute format('select count(*) from %s where organization_id = %L', r.qname, '0a000000-0000-0000-0000-000000000000') into v_n;
      if v_n > 0 then v_visible_a := v_visible_a + 1; else v_unreadable := v_unreadable || r.qname; end if;
    exception when insufficient_privilege then v_unreadable := v_unreadable || r.qname; -- not readable at all by clients: nothing leaks
    end;
  end loop;
  perform pg_temp.invariant(format('X1 a member of org A holding every permission reads 0 rows of org B in every tenant table (%s tables hold B rows; the probe reads org A rows in %s — the others are not readable by this member — system-only, or addressed to another user: %s)',
    v_probed, v_visible_a, coalesce(array_to_string(v_unreadable, ', '), 'none')), v_read);
end $$;
reset role;

-- X1 (blind writes): an UPDATE / DELETE with no WHERE clause reads no column, so only the UPDATE / DELETE policies decide which
-- rows it reaches (a filtered statement is also gated by the SELECT policies, which hides a broken write policy). The probe runs
-- one of each on every tenant table, triggers and foreign keys off (replica), and org B's rows must come out untouched.
do $$
declare
  r record; v_col text; v_before text; v_after text; v_a_before text; v_a_after text; v_bad text[] := '{}'; v_nocol text[] := '{}'; v_reached_a int := 0;
begin
  for r in select t.qname, t.oid from p10_tenant t join p10_rowcount c on c.tbl = t.qname where c.rows_b > 0 order by 1 loop
    -- the column the blind update rewrites to its default: updated_at, else another defaulted column, else a nullable one —
    -- never part of a key
    select quote_ident(a.attname) into v_col
    from pg_attribute a
    where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity = '' and a.attname <> 'organization_id'
      and not exists (select 1 from pg_index i where i.indrelid = r.oid and (i.indisunique or i.indisexclusion) and a.attnum = any (i.indkey))
      and (exists (select 1 from pg_attrdef d where d.adrelid = r.oid and d.adnum = a.attnum) or not a.attnotnull)
    order by (a.attname = 'updated_at') desc, exists (select 1 from pg_attrdef d where d.adrelid = r.oid and d.adnum = a.attnum) desc, a.attnum
    limit 1;
    execute format('select string_agg(x::text, '','' order by x::text) from (select ctid as x from %s where organization_id = %L) s', r.qname, '0b000000-0000-0000-0000-000000000000') into v_before;
    execute format('select string_agg(x::text, '','' order by x::text) from (select ctid as x from %s where organization_id = %L) s', r.qname, '0a000000-0000-0000-0000-000000000000') into v_a_before;
    begin
      perform set_config('session_replication_role', 'replica', true);
      perform set_config('role', 'authenticated', true);
      perform set_config('request.jwt.claims', '{"sub":"0d000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
      if v_col is not null then
        begin execute format('update %s set %s = default', r.qname, v_col); exception when others then null; end;
      else
        v_nocol := v_nocol || r.qname;
      end if;
      begin execute format('delete from %s', r.qname); exception when others then null; end;
      perform set_config('role', 'none', true);
      execute format('select string_agg(x::text, '','' order by x::text) from (select ctid as x from %s where organization_id = %L) s', r.qname, '0b000000-0000-0000-0000-000000000000') into v_after;
      if v_after is distinct from v_before then v_bad := v_bad || r.qname; end if;
      -- positive control: the same statements did reach the probe's own organisation where its keys allow it
      execute format('select string_agg(x::text, '','' order by x::text) from (select ctid as x from %s where organization_id = %L) s', r.qname, '0a000000-0000-0000-0000-000000000000') into v_a_after;
      if v_a_after is distinct from v_a_before then v_reached_a := v_reached_a + 1; end if;
      raise exception using errcode = 'P0100', message = 'undo the probe';
    exception when sqlstate 'P0100' then null;
    end;
  end loop;
  perform pg_temp.invariant(format('X1 blind UPDATE / DELETE statements of the probe leave every org B row untouched (the same statements changed org A rows in %s tables)', v_reached_a), v_bad);
  if v_reached_a < 20 then raise exception 'INVARIANT FAILED: the blind-write probe reached org A in only % tables — it is not exercising the write policies', v_reached_a; end if;
  if cardinality(v_nocol) > 0 then raise notice 'X1 note: no column to rewrite blindly in % (the DELETE probe still ran)', array_to_string(v_nocol, ', '); end if;
end $$;

-- X1 (insert): a row of org B written by the probe is refused by row security (or by the missing privilege) — never stored
do $$
declare
  r record; g record; v_row jsonb; v_cols text; v_err text; v_state text; v_bad text[] := '{}'; v_other text[] := '{}'; v_probed int := 0;
begin
  for r in select t.qname, t.oid from p10_tenant t join p10_rowcount c on c.tbl = t.qname where c.rows_b > 0 order by 1 loop
    execute format('select to_jsonb(x) from %s x where organization_id = %L limit 1', r.qname, '0b000000-0000-0000-0000-000000000000') into v_row;
    -- a fresh primary key where it is a uuid, so the answer is not a duplicate key
    select v_row || coalesce(jsonb_object_agg(a.attname, gen_random_uuid()), '{}') into v_row
    from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
    where i.indrelid = r.oid and i.indisprimary and a.atttypid = 'uuid'::regtype and a.attname <> 'organization_id';
    v_probed := v_probed + 1;
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
    from pg_attribute a where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity = '';
    begin
      -- other BEFORE INSERT triggers (validation, guards) are disabled for the probe: the answer must be row security's
      for g in select tgname from pg_trigger where tgrelid = r.oid and not tgisinternal and (tgtype & 2) <> 0 and (tgtype & 4) <> 0 loop
        execute format('alter table %s disable trigger %I', r.qname, g.tgname);
      end loop;
      perform set_config('role', 'authenticated', true);
      perform set_config('request.jwt.claims', '{"sub":"0d000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
      begin
        execute format('insert into %s (%s) select %s from jsonb_populate_record(null::%s, %L)', r.qname, v_cols, v_cols, r.qname, v_row);
        v_bad := v_bad || r.qname;
      exception when others then
        get stacked diagnostics v_err = message_text, v_state = returned_sqlstate;
        if v_state <> '42501' then v_other := v_other || format('%s (%s %s)', r.qname, v_state, v_err); end if;
      end;
      raise exception using errcode = 'P0100', message = 'undo the probe';
    exception when sqlstate 'P0100' then null;
    end;
  end loop;
  perform pg_temp.invariant(format('X1 an insert of an org B row by the probe is refused in every one of the %s tenant tables probed', v_probed), v_bad);
  perform pg_temp.invariant('X1 ...by row security or the missing privilege (42501), not by an unrelated error', v_other);
end $$;

-- X1 (system context): the system context of org A reads nothing of org B either
set local role flowza_system;
select set_config('request.jwt.claims', '{"role":"flowza_system","org_id":"0a000000-0000-0000-0000-000000000000"}', true);
do $$
declare r record; v_n bigint; v_read text[] := '{}';
begin
  for r in select t.qname, t.relname from p10_tenant t join p10_rowcount c on c.tbl = t.qname where c.rows_b > 0 order by 1 loop
    begin
      execute format('select count(*) from %s where organization_id = %L', r.qname, '0b000000-0000-0000-0000-000000000000') into v_n;
      if v_n > 0 and not pg_temp.allowed('system_scope', r.relname) then v_read := v_read || format('%s (%s rows)', r.qname, v_n); end if;
    exception when insufficient_privilege then null;
    end;
  end loop;
  perform pg_temp.invariant('X1 the system context of org A reads 0 rows of org B in every tenant table', v_read);
end $$;
reset role;

-- X2 as the probe: rows of org C addressed to the probe (every user reference points at them) stay invisible — they are not a
-- member of C
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"0d000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
do $$
declare r record; v_n bigint; v_read text[] := '{}'; v_probed int := 0;
begin
  for r in select t.qname, t.relname from p10_tenant t join p10_rowcount c on c.tbl = t.qname where c.rows_c > 0 order by 1 loop
    v_probed := v_probed + 1;
    begin
      execute format('select count(*) from %s where organization_id = %L', r.qname, '0e000000-0000-0000-0000-000000000000') into v_n;
      if v_n > 0 and not pg_temp.allowed('self_addressed', r.relname) then v_read := v_read || format('%s (%s rows)', r.qname, v_n); end if;
    exception when insufficient_privilege then null;
    end;
  end loop;
  perform pg_temp.invariant(format('X2 a user reads none of the rows addressed to them in an organisation they are not a member of (%s tables probed)', v_probed), v_read);
end $$;
reset role;

-- I7 (behaviour): the widest member of A is refused every client write on the system-written tables
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"0d000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
do $$
declare r record; v_bad text[] := '{}';
begin
  for r in select 'public.' || relname as qname from p10_rpc_only order by 1 loop
    -- each statement needs the write privilege and nothing else (no read of the table, identity columns left to their default)
    begin execute format('insert into %s (organization_id) select null::uuid where false', r.qname); v_bad := v_bad || (r.qname || ':insert');
    exception when insufficient_privilege then null; end;
    begin execute format('update %s set organization_id = null where false', r.qname); v_bad := v_bad || (r.qname || ':update');
    exception when insufficient_privilege then null; end;
    begin execute format('delete from %s where false', r.qname); v_bad := v_bad || (r.qname || ':delete');
    exception when insufficient_privilege then null; end;
  end loop;
  perform pg_temp.invariant('I7 (behaviour) a member holding every permission is refused every write on the system-written tables', v_bad);
end $$;
reset role;
select pg_temp.invariant('allow-lists used by the probes are not stale',
  (select array_agg(a.kind || ':' || a.subject order by 1) from p10_allow a
   where a.kind in ('self_addressed', 'system_scope') and not exists (select 1 from p10_seen s where s.kind = a.kind and s.subject = a.subject)));
rollback;

-- no allow-list entry may outlive what it excuses
select pg_temp.invariant('allow-lists of the catalogue checks are not stale',
  (select array_agg(a.kind || ':' || a.subject order by 1) from p10_allow a
   where a.kind not in ('self_addressed', 'system_scope') and not exists (select 1 from p10_seen s where s.kind = a.kind and s.subject = a.subject)));
