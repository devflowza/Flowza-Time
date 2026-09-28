-- The data API is closed (security gate 20260928001100, ADR-001 §49): PostgREST and pg_graphql log in as `authenticator` and
-- switch to `authenticated`; every table of public then returns no row and takes no write, whatever the caller holds — the
-- same caller who, through the API (login flowza_api), reads and writes their organisation. Generated from the catalogue.
-- Run by run-rls-tests.sh connected as `authenticator`, after the other suites committed their fixtures. Rolls back.
\set QUIET on
\set ON_ERROR_STOP on
\pset tuples_only on
set client_min_messages = notice;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
do $$
declare
  r record; v_n bigint; v_col text;
  v_rows text[] := '{}'; v_writes text[] := '{}'; v_tables int := 0; v_err text;
begin
  if session_user <> 'authenticator' then raise exception 'run this suite connected as authenticator (session_user is %)', session_user; end if;
  if app.uid() is distinct from 'a0000000-0000-0000-0000-000000000001'::uuid then raise exception 'the owner''s claims are not in effect'; end if;
  -- the caller is org A's owner: through the API they read every employee of A (rls_isolation.sql asserts 6)
  if not ('0a000000-0000-0000-0000-000000000000' = any (app.member_org_ids())) then raise exception 'owner A is not a member of org A'; end if;
  for r in select format('%I.%I', n.nspname, c.relname) as q, c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition order by 1 loop
    v_tables := v_tables + 1;
    begin
      execute format('select count(*) from %s', r.q) into v_n;
      if v_n > 0 then v_rows := v_rows || format('%s (%s rows)', r.q, v_n); end if;
    exception when insufficient_privilege then null;
    end;
    select quote_ident(a.attname) into v_col from pg_attribute a where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity = '' order by a.attnum limit 1;
    begin
      execute format('update %s set %s = %s', r.q, v_col, v_col);
      get diagnostics v_n = row_count;
      if v_n > 0 then v_writes := v_writes || format('%s (updated %s)', r.q, v_n); end if;
    exception when insufficient_privilege then null;
    end;
    begin
      execute format('delete from %s', r.q);
      get diagnostics v_n = row_count;
      if v_n > 0 then v_writes := v_writes || format('%s (deleted %s)', r.q, v_n); end if;
    exception when insufficient_privilege then null; when foreign_key_violation then v_writes := v_writes || format('%s (a delete reached rows)', r.q);
    end;
  end loop;
  if cardinality(v_rows) > 0 then raise exception 'DATA API OPEN: rows readable through the data API login: %', array_to_string(v_rows, ', '); end if;
  raise notice 'ok: the data API login reads no row of any of the % tables of public', v_tables;
  if cardinality(v_writes) > 0 then raise exception 'DATA API OPEN: rows written through the data API login: %', array_to_string(v_writes, ', '); end if;
  raise notice 'ok: the data API login updates / deletes no row of any table of public';
  -- inserts the owner may make through the API are refused here
  begin
    insert into public.branches (organization_id, code, name) values ('0a000000-0000-0000-0000-000000000000', 'API-X', 'Through PostgREST');
    raise exception 'DATA API OPEN: a branch was inserted through the data API login';
  exception when insufficient_privilege then raise notice 'ok: a branch insert through the data API login is refused';
  end;
  begin
    insert into public.employees (organization_id, employee_number, first_name, last_name, display_name, joining_date, branch_id, device_user_id)
    values ('0a000000-0000-0000-0000-000000000000', 'API-1', 'Api', 'Rest', 'Api Rest', '2025-01-01', '0a000000-0000-0000-0000-00000000000b', 'api-1');
    raise exception 'DATA API OPEN: an employee was inserted through the data API login';
  exception when insufficient_privilege then raise notice 'ok: an employee insert through the data API login is refused';
  end;
  begin
    insert into public.attendance_corrections (organization_id, employee_id, branch_id, attendance_date, type, proposed_punched_at, reason, requested_by, status)
    values ('0a000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-0000000000e1', '0a000000-0000-0000-0000-00000000000b', '2026-09-05', 'ADD_PUNCH', '2026-09-05 04:00+00', 'PostgREST', 'a0000000-0000-0000-0000-000000000001', 'PENDING');
    raise exception 'DATA API OPEN: a correction was filed through the data API login';
  exception when insufficient_privilege then raise notice 'ok: a correction filed through the data API login is refused';
  end;
end $$;
rollback;
