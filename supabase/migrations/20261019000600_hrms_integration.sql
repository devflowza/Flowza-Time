-- FlowZa Time · 20261019000600 · HR system (HRMS) integration: organisation API keys, org-unit imports, HRMS batches.
--
-- Customer requirement (Oman): "Integration with the Mawred Plus system to update employee data and organisational units".
-- An HR system pushes employees and organisational units to /api/v1/inbound/hrms/* with an organisation API key; each batch is
-- an import job of the existing import pipeline (validated rows → EXECUTE_IMPORT in the worker), so a spreadsheet uploaded on
-- the import page and a batch from the HR system follow the same rules (docs/integrations/hrms.md).
--
--  1. import_jobs: a second kind (ORG_UNITS = departments by code), where the import came from (`upload` | `hrms`), the API key
--     that sent a batch, the HR system's batch reference, and a durable Idempotency-Key per organisation (a retried batch is
--     answered with the batch it already created instead of being applied twice).
--  2. api_keys (table since 20260905001300, unused until now): readable / writable with `integration.manage` (was
--     organization.manage), who revoked a key, a lookup index on the public prefix, and the one function the inbound endpoint
--     uses to find a key by its prefix BEFORE it knows the organisation (platform context only, returns the prefix's rows).
--
-- Every statement is idempotent (re-applying the file is a no-op). import_jobs / api_keys are small, cold tables: no
-- CONCURRENTLY index is needed.

set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. import_jobs
-- ---------------------------------------------------------------------------------------------------------------------------
alter table public.import_jobs drop constraint if exists import_jobs_type_check;
alter table public.import_jobs add constraint import_jobs_type_check check (type in ('EMPLOYEES', 'ORG_UNITS'));

alter table public.import_jobs add column if not exists source text not null default 'upload';
alter table public.import_jobs drop constraint if exists import_jobs_source_check;
alter table public.import_jobs add constraint import_jobs_source_check check (source in ('upload', 'hrms'));

alter table public.import_jobs add column if not exists api_key_id uuid;
alter table public.import_jobs add column if not exists reference text;
alter table public.import_jobs drop constraint if exists import_jobs_reference_length;
alter table public.import_jobs add constraint import_jobs_reference_length check (reference is null or length(reference) <= 120);
alter table public.import_jobs add column if not exists idempotency_key text;
alter table public.import_jobs drop constraint if exists import_jobs_idempotency_key_length;
alter table public.import_jobs add constraint import_jobs_idempotency_key_length check (idempotency_key is null or length(idempotency_key) <= 128);
alter table public.import_jobs add column if not exists request_hash text;

comment on column public.import_jobs.source is 'upload = the import page; hrms = a batch an HR system sent with an organisation API key (docs/integrations/hrms.md).';
comment on column public.import_jobs.idempotency_key is 'Idempotency-Key of an HRMS batch: a retry with the same key and body is answered with this batch, a different body is refused (409).';

-- the key that sent a batch, in the same organisation (composite key: a batch can never point at another tenant's key)
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.api_keys'::regclass and conname = 'api_keys_id_organization_id_key') then
    alter table public.api_keys add constraint api_keys_id_organization_id_key unique (id, organization_id);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.import_jobs'::regclass and conname = 'import_jobs_api_key_fk') then
    alter table public.import_jobs add constraint import_jobs_api_key_fk foreign key (api_key_id, organization_id)
      references public.api_keys (id, organization_id) on delete set null (api_key_id);
  end if;
end $$;
create index if not exists import_jobs_api_key_fk_idx on public.import_jobs (api_key_id, organization_id) where api_key_id is not null;
create unique index if not exists import_jobs_idempotency_key_uniq on public.import_jobs (organization_id, idempotency_key) where idempotency_key is not null;
create index if not exists import_jobs_org_source_idx on public.import_jobs (organization_id, source, created_at desc);

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. api_keys
-- ---------------------------------------------------------------------------------------------------------------------------
alter table public.api_keys add column if not exists revoked_by uuid references public.user_profiles(id) on delete set null;
create index if not exists api_keys_revoked_by_fk_idx on public.api_keys (revoked_by) where revoked_by is not null;
create index if not exists api_keys_key_prefix_idx on public.api_keys (key_prefix);

comment on table public.api_keys is 'Organisation API keys for machine integrations (HRMS inbound). Only the sha256 of the key is stored; the key is shown once at creation. Managed with integration.manage.';

-- integration.manage reads and writes the keys (the HRMS card of Settings); the policies are regenerated by the generator
call app.apply_tenant_policies('public.api_keys', 'integration.manage', 'integration.manage');

-- The inbound endpoint knows only the key it was given: it finds the candidate rows by the key's public prefix in the PLATFORM
-- context (the organisation is not known yet), compares the sha256 in the application with timingSafeEqual, and continues in
-- the organisation's system context. Nothing else of the table is reachable from the platform context.
create or replace function app.api_key_candidates(p_prefix text)
returns table (id uuid, organization_id uuid, key_hash text, scopes text[], expires_at timestamptz, revoked_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select k.id, k.organization_id, k.key_hash, k.scopes, k.expires_at, k.revoked_at
    from public.api_keys k
   where app.is_platform_context()
     and p_prefix ~ '^fzk_[A-Za-z0-9]{8}$'
     and k.key_prefix = p_prefix
   order by k.created_at
   limit 5
$$;
comment on function app.api_key_candidates(text) is 'HRMS inbound: the API keys carrying a public prefix (platform context only; at most 5 rows). The caller compares the hash itself.';
revoke execute on function app.api_key_candidates(text) from public, anon, authenticated;
grant execute on function app.api_key_candidates(text) to flowza_system;
