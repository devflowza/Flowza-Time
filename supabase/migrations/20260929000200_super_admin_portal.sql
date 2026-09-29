-- FlowZa Time · 20260929000200 · Super-admin portal (/adm) — the platform console's own records and read models.
--
-- The web app gains a separate administration portal at /adm (its own sign-in, layout and pages, modelled on the Flowza
-- Finance /adm portal). Everything it shows about tenants that is NOT the tenant's own data lives here:
--
--  1. `platform_tenant_accounts` — one row per organisation carrying the platform's account-management fields: the
--     platform administrator who manages the account and free-form tags ("enterprise", "pilot", …). Platform-only: a
--     tenant never reads it (no member policy), the platform console reads it as a platform admin, and the API writes it
--     in the organisation's system context after `requirePlatformAdmin`, auditing every change on the organisation.
--  2. `platform_tenant_notes` — internal notes about a tenant ("called the owner about renewal"). Append-only (a wrong note
--     is followed by a correcting one, like audit entries); the author is recorded by id and e-mail, without a foreign key,
--     for the same reason audit.logs has none: removing a user must neither fail nor rewrite history.
--  3. `app.platform_org_counts(uuid[])` — employees / terminals / branches / active members per organisation, for the
--     dashboard and the tenants list. A platform admin holds no tenant permission without an access grant (docs/go-live.md
--     §6), so these are counts only, computed by a SECURITY DEFINER function that refuses anyone who is not an active
--     platform admin. Terminals exclude the Flowza Finance connector and the self-service punch device (platform plumbing,
--     not device seats) — the same rule as GET /platform/orgs/:id.
--  4. `app.platform_memberships(uuid[], uuid)` — memberships with the member's name, e-mail and role, by user or by
--     organisation, for the users directory and a tenant's Members tab. Directory data only (no employee record, no
--     attendance); refused to anyone who is not an active platform admin, and refused without a filter so it never dumps
--     the whole platform in one call.
--  5. `audit_logs_platform_admin_actions` — a platform admin reads the audit entries OF PLATFORM ADMINISTRATORS across all
--     organisations (the platform activity page). Those entries are already visible to each tenant (they are written on
--     the organisation); what a tenant's own users did stays behind `audit.view` of that tenant, as before.
--
-- Additive and idempotent; one transaction; the tables are empty and new, the one index on audit.logs is partial (platform
-- administrator entries only — a handful of rows).

set lock_timeout = '5s';
set statement_timeout = '120s';
set client_min_messages = warning;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Account management of a tenant (platform-only)
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.platform_tenant_accounts (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  account_manager_user_id uuid references public.platform_admins(user_id) on delete set null,
  tags text[] not null default '{}' check (cardinality(tags) <= 20),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.platform_tenant_accounts is 'Platform-only account management of a tenant (account manager, tags). Never readable by tenant members; written by the API in the organisation''s system context after requirePlatformAdmin, audited on the organisation.';
create index if not exists platform_tenant_accounts_manager_idx on public.platform_tenant_accounts (account_manager_user_id);
drop trigger if exists platform_tenant_accounts_updated_at on public.platform_tenant_accounts;
create trigger platform_tenant_accounts_updated_at before update on public.platform_tenant_accounts for each row execute function app.set_updated_at();

revoke all on public.platform_tenant_accounts from authenticated, anon;
grant select on public.platform_tenant_accounts to authenticated;
grant select, insert, update on public.platform_tenant_accounts to flowza_system;
drop policy if exists platform_tenant_accounts_platform_read on public.platform_tenant_accounts;
create policy platform_tenant_accounts_platform_read on public.platform_tenant_accounts for select to authenticated
  using ((select app.is_platform_admin()));
drop policy if exists platform_tenant_accounts_system on public.platform_tenant_accounts;
create policy platform_tenant_accounts_system on public.platform_tenant_accounts for all to flowza_system
  using ((select app.is_system()) and organization_id = (select app.system_org_id()))
  with check ((select app.is_system()) and organization_id = (select app.system_org_id()));
call app.enforce_tenant_table('public.platform_tenant_accounts');

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Internal notes about a tenant (platform-only, append-only)
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.platform_tenant_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  author_user_id uuid not null,
  author_label text,
  body text not null check (length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now()
);
comment on table public.platform_tenant_notes is 'Internal platform notes about a tenant. Append-only (updates refused; rows leave only with their organisation). Never readable by tenant members.';
create index if not exists platform_tenant_notes_org_created_idx on public.platform_tenant_notes (organization_id, created_at desc);
drop trigger if exists platform_tenant_notes_append_only on public.platform_tenant_notes;
create trigger platform_tenant_notes_append_only before update on public.platform_tenant_notes for each row execute function app.reject_modification();

revoke all on public.platform_tenant_notes from authenticated, anon;
grant select on public.platform_tenant_notes to authenticated;
grant select, insert on public.platform_tenant_notes to flowza_system;
drop policy if exists platform_tenant_notes_platform_read on public.platform_tenant_notes;
create policy platform_tenant_notes_platform_read on public.platform_tenant_notes for select to authenticated
  using ((select app.is_platform_admin()));
drop policy if exists platform_tenant_notes_system_read on public.platform_tenant_notes;
create policy platform_tenant_notes_system_read on public.platform_tenant_notes for select to flowza_system
  using ((select app.is_system()) and organization_id = (select app.system_org_id()));
drop policy if exists platform_tenant_notes_system_insert on public.platform_tenant_notes;
create policy platform_tenant_notes_system_insert on public.platform_tenant_notes for insert to flowza_system
  with check ((select app.is_system()) and organization_id = (select app.system_org_id()));
call app.enforce_tenant_table('public.platform_tenant_notes');

-- ---------------------------------------------------------------------------------------------------------------------------
-- 3. Fleet counts per organisation (platform admins only; counts, never rows)
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function app.platform_org_counts(p_org_ids uuid[] default null)
returns table (organization_id uuid, employees bigint, devices bigint, branches bigint, users bigint)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not app.is_platform_admin() then
    raise exception 'platform administrator access required' using errcode = '42501';
  end if;
  return query
  select o.id,
    (select count(*) from public.employees e where e.organization_id = o.id and e.deleted_at is null),
    (select count(*) from public.devices d where d.organization_id = o.id and d.status <> 'decommissioned'
       and d.provider_key not in ('flowza_finance', 'self_service')),
    (select count(*) from public.branches b where b.organization_id = o.id and b.status <> 'archived'),
    (select count(*) from public.org_memberships m where m.organization_id = o.id and m.status = 'active')
  from public.organizations o
  where p_org_ids is null or o.id = any (p_org_ids);
end $$;
comment on function app.platform_org_counts(uuid[]) is 'Employees / terminals / branches / active members per organisation (all when null). Platform admins only (42501 otherwise); counts, never rows.';
revoke execute on function app.platform_org_counts(uuid[]) from public, anon;
grant execute on function app.platform_org_counts(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 4. Memberships directory (platform admins only; by user and/or by organisation)
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function app.platform_memberships(p_user_ids uuid[] default null, p_org_id uuid default null)
returns table (
  membership_id uuid, organization_id uuid, organization_name text, company_code text, organization_status public.org_status,
  user_id uuid, email text, full_name text, role_id uuid, role_key text, role_name text, status public.membership_status,
  joined_at timestamptz, created_at timestamptz, last_login_at timestamptz, mfa_enrolled boolean
)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not app.is_platform_admin() then
    raise exception 'platform administrator access required' using errcode = '42501';
  end if;
  if p_user_ids is null and p_org_id is null then
    raise exception 'a user or an organisation filter is required' using errcode = '22023';
  end if;
  return query
  select m.id, o.id, o.display_name, o.company_code::text, o.status,
         p.id, p.email::text, p.full_name, r.id, r.key, r.name, m.status,
         m.joined_at, m.created_at, p.last_login_at, p.mfa_enrolled
  from public.org_memberships m
  join public.organizations o on o.id = m.organization_id
  join public.user_profiles p on p.id = m.user_id
  join public.roles r on r.id = m.role_id
  where (p_user_ids is null or m.user_id = any (p_user_ids))
    and (p_org_id is null or m.organization_id = p_org_id)
  order by o.display_name, p.email;
end $$;
comment on function app.platform_memberships(uuid[], uuid) is 'Memberships with member name, e-mail and role, filtered by users and/or organisation (a filter is required). Platform admins only (42501 otherwise); directory data, no employee or attendance rows.';
revoke execute on function app.platform_memberships(uuid[], uuid) from public, anon;
grant execute on function app.platform_memberships(uuid[], uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 5. Platform activity: platform administrators' own audit entries, across organisations
-- ---------------------------------------------------------------------------------------------------------------------------
drop policy if exists audit_logs_platform_admin_actions on audit.logs;
create policy audit_logs_platform_admin_actions on audit.logs for select to authenticated
  using (actor_type = 'PLATFORM_ADMIN' and (select app.is_platform_admin()));
create index if not exists audit_logs_platform_admin_time_idx on audit.logs (created_at desc) where actor_type = 'PLATFORM_ADMIN';

-- ---------------------------------------------------------------------------------------------------------------------------
-- post-verify
-- ---------------------------------------------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid in ('public.platform_tenant_accounts'::regclass, 'public.platform_tenant_notes'::regclass)
             and p.polpermissive and pg_get_expr(p.polqual, p.polrelid) not like '%is_platform_admin%' and pg_get_expr(p.polqual, p.polrelid) not like '%is_system%'
             and p.polcmd in ('r', '*')) then
    raise exception 'super-admin portal: a read policy of the platform tables is not limited to platform admins / the system context';
  end if;
  if has_table_privilege('authenticated', 'public.platform_tenant_accounts', 'insert,update,delete')
     or has_table_privilege('authenticated', 'public.platform_tenant_notes', 'insert,update,delete') then
    raise exception 'super-admin portal: clients must not write the platform tables';
  end if;
  if has_function_privilege('anon', 'app.platform_org_counts(uuid[])', 'execute')
     or has_function_privilege('anon', 'app.platform_memberships(uuid[], uuid)', 'execute') then
    raise exception 'super-admin portal: anon can execute a platform function';
  end if;
end $$;
