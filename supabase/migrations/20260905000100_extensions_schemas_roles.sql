-- FlowZa Time · 0100 · extensions, schemas, application roles, common trigger functions
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists btree_gist with schema extensions;

create schema if not exists app;      -- authorization helpers + utilities
create schema if not exists jobs;     -- background job queue
create schema if not exists audit;    -- append-only audit log
create schema if not exists secrets;  -- encrypted credentials access functions

-- Application roles ---------------------------------------------------------------------------
-- flowza_system: role assumed by the worker (and by the API for system steps) for ONE organisation
--                per transaction via request.jwt.claims = {"role":"flowza_system","org_id":"..."}.
-- flowza_api / flowza_worker: login roles used by the services (passwords set out of band).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'flowza_system') then
    create role flowza_system nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'flowza_api') then
    create role flowza_api login noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'flowza_worker') then
    create role flowza_worker login noinherit;
  end if;
end $$;
grant authenticated to flowza_api;
grant flowza_system to flowza_api;
grant flowza_system to flowza_worker;

grant usage on schema public, app, extensions to authenticated, flowza_system, flowza_api, flowza_worker;
grant usage on schema jobs, audit, secrets to flowza_system, flowza_api, flowza_worker;
revoke all on schema jobs, audit, secrets from anon, authenticated;

-- Common trigger functions --------------------------------------------------------------------
create or replace function app.set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create or replace function app.reject_modification() returns trigger language plpgsql as $$
begin
  raise exception 'table % is append-only', tg_table_name using errcode = 'P0001';
end $$;

create or replace function app.is_valid_timezone(tz text) returns boolean language sql immutable as $$
  select tz is not null and exists (select 1 from pg_timezone_names where name = tz)
$$;

-- pg_timezone_names is not immutable-safe for CHECK constraints in strict theory, but names are stable;
-- we use it as a domain-level guard in triggers instead of CHECK to keep pg_dump/restore safe.
create or replace function app.validate_timezone_column() returns trigger language plpgsql as $$
begin
  if new.timezone is not null and not app.is_valid_timezone(new.timezone) then
    raise exception 'invalid timezone %', new.timezone using errcode = '22023';
  end if;
  return new;
end $$;

comment on schema app is 'FlowZa authorization helpers and utilities (RLS building blocks).';
comment on schema jobs is 'FlowZa background job queue (see ADR-006).';
comment on schema audit is 'FlowZa append-only audit log.';
comment on schema secrets is 'FlowZa encrypted credential access (see ADR-003).';
