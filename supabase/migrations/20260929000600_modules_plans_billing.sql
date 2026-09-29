-- FlowZa Time · 20260929000600 · Modules, plans & pricing, billing and platform settings (super-admin portal parity with
-- the Flowza Finance /adm portal: Modules, Plans & Pricing, Subscriptions & Billing, Platform Settings).
--
--  1. `modules` — the catalogue of switchable product modules (devices, employee self-service, web check-in & geofencing,
--     leave, manager workspace, payroll, scheduled reports, Flowza Finance integration). The core of the product —
--     employees & organisation, attendance & corrections, shifts & holidays, reports, approvals, users, settings, audit — is
--     never switchable and is not in the catalogue. `is_available` is the fleet-wide switch: off ⇒ off for every tenant.
--  2. `plans` gain `modules` (what the plan includes), `included_users`, `trial_days` and `is_custom` ("contact sales").
--     `prices` keeps its documented shape, per currency: {"OMR": {"monthly", "yearly", "extraUserMonthly", "extraUserYearly"}}.
--     A new Professional plan is the reference package: 500 OMR a year for 11 users (docs/pricing.md). Every tenant that
--     exists today keeps every module it has: Trial, Business and Enterprise include all of them, and only Starter (no
--     tenant uses it) is a subset.
--  3. `organization_modules` — the platform's per-tenant override of a module (on or off, with a reason), written by the API
--     in the organisation's system context after `requirePlatformAdmin` and audited on the organisation. No row ⇒ the plan
--     decides. A tenant reads its own rows; nobody but the system context writes them.
--  4. `app._org_module_states` / `app.org_module_states` / `app.org_module_enabled` — the ONE rule: a module is enabled
--     when it is available fleet-wide AND the subscription has not lapsed (status expired / cancelled — never inferred
--     from a date, so a trial past its end date keeps working until a platform admin decides) AND (the tenant's override,
--     else whether the plan includes it). No subscription at all ⇒ the plan cannot say no (fail open, like Flowza Finance's
--     missing core rows). `app.principal_snapshot` carries each organisation's disabled modules, so the API's module gate
--     costs no extra round trip.
--  5. `subscriptions` gain `billing_cycle` (monthly / yearly) and `seats` (licensed users; null ⇒ the plan's employee limit).
--  6. Billing: `billing_invoices` (number, period, lines, subtotal, discount, VAT, total, amount paid, status issued / paid /
--     void, seller and customer snapshots) and `billing_payments` (append-only payments and refunds). Invoice numbers come
--     from `app.next_billing_invoice_number` (per prefix and year, gap-free for committed transactions). Written only by the
--     system context after `requirePlatformAdmin`; a tenant member holding `organization.manage` reads their own.
--  7. `platform_settings` — key / value settings of the platform (name, support e-mail, billing currency, VAT rate, invoice
--     prefix, payment terms, seller and bank details). Public keys are readable by every signed-in user (a tenant's billing
--     page shows the seller and bank details); the rest by platform admins only.
--
-- Additive and idempotent (`if not exists`, `create or replace`, `drop … if exists` before re-creating what this file owns;
-- seed rows never overwrite a value an administrator already set). One transaction; ends with a post-verify block.

set lock_timeout = '5s';
set statement_timeout = '120s';
set client_min_messages = warning;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Module catalogue
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.modules (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,31}$'),
  name text not null check (length(btrim(name)) between 1 and 80),
  description text not null default '' check (length(description) <= 500),
  category text not null default 'workforce' check (category in ('workforce', 'time', 'devices', 'insights', 'integrations')),
  sort_order int not null default 100,
  is_available boolean not null default true,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.modules is 'Switchable product modules. is_available = false switches a module off for every tenant. Per-tenant overrides live in organization_modules; plans list the modules they include.';
drop trigger if exists modules_updated_at on public.modules;
create trigger modules_updated_at before update on public.modules for each row execute function app.set_updated_at();

revoke all on public.modules from authenticated, anon;
grant select on public.modules to authenticated;
grant select, insert, update on public.modules to flowza_system;
drop policy if exists modules_read on public.modules;
create policy modules_read on public.modules for select to authenticated, flowza_system using (true);
drop policy if exists modules_platform_write on public.modules;
create policy modules_platform_write on public.modules for all to flowza_system
  using ((select app.system_org_id()) = '00000000-0000-0000-0000-000000000000'::uuid)
  with check ((select app.system_org_id()) = '00000000-0000-0000-0000-000000000000'::uuid);
call app.enforce_tenant_table('public.modules');

insert into public.modules (key, name, description, category, sort_order) values
  ('devices', 'Devices & sync', 'Biometric terminals, PIN mapping, punch log, synchronisation and reconciliation.', 'devices', 10),
  ('self_service', 'Employee self-service portal', 'Employees sign in to see their attendance, requests, shift, shift swaps and profile.', 'workforce', 20),
  ('geofences', 'Web check-in & geofencing', 'Check in from the browser or a phone inside geofences, with optional selfie verification.', 'time', 30),
  ('leave', 'Leave management', 'Leave types, requests and approvals, balances, allocations, year close and the leave calendar.', 'workforce', 40),
  ('manager_workspace', 'Manager workspace', 'Line managers see their team''s attendance, leave and pending requests.', 'workforce', 50),
  ('payroll', 'Payroll', 'Payroll periods, attendance summaries and payroll-ready exports.', 'insights', 60),
  ('report_schedules', 'Scheduled reports', 'Reports delivered automatically by e-mail on a schedule, and report sharing.', 'insights', 70),
  ('finance_integration', 'Flowza Finance integration', 'Attendance synchronisation with Flowza Finance.', 'integrations', 80)
on conflict (key) do update set name = excluded.name, description = excluded.description, category = excluded.category, sort_order = excluded.sort_order
  where (public.modules.name, public.modules.description, public.modules.category, public.modules.sort_order)
        is distinct from (excluded.name, excluded.description, excluded.category, excluded.sort_order);

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Plans: modules, included users, trial days, custom pricing
-- ---------------------------------------------------------------------------------------------------------------------------
alter table public.plans add column if not exists modules text[] not null default '{}';
alter table public.plans add column if not exists included_users int;
alter table public.plans add column if not exists trial_days int not null default 0;
alter table public.plans add column if not exists is_custom boolean not null default false;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.plans'::regclass and conname = 'plans_included_users_check') then
    alter table public.plans add constraint plans_included_users_check check (included_users is null or included_users between 1 and 100000);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.plans'::regclass and conname = 'plans_trial_days_check') then
    alter table public.plans add constraint plans_trial_days_check check (trial_days between 0 and 365);
  end if;
end $$;
comment on column public.plans.modules is 'Module keys (public.modules) the plan includes. Unknown keys are refused by plans_modules_known.';
comment on column public.plans.included_users is 'Users (licensed employees) included in the base price; extra users are priced by prices.<CUR>.extraUserMonthly / extraUserYearly.';
comment on column public.plans.is_custom is 'Priced per customer ("contact sales"); prices may be empty.';

-- plans.modules holds known module keys only, de-duplicated and sorted (the database is the last line of defence)
create or replace function app.plans_modules_known() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from unnest(new.modules) k where not exists (select 1 from public.modules m where m.key = k)) then
    raise exception 'plans.modules contains an unknown module key' using errcode = '23514', constraint = 'plans_modules_known', table = 'plans', schema = 'public';
  end if;
  new.modules := coalesce((select array_agg(distinct k order by k) from unnest(new.modules) k), '{}'::text[]);
  return new;
end $$;
drop trigger if exists plans_modules_known on public.plans;
create trigger plans_modules_known before insert or update of modules on public.plans for each row execute function app.plans_modules_known();

-- the reference package (docs/pricing.md): Professional, 500 OMR a year for 11 users
insert into public.plans (id, key, name, description, prices, limits, features, sort_order, modules, included_users, trial_days)
values ('20000000-0000-0000-0000-000000000005', 'professional', 'Professional',
        'The full HR attendance suite: leave, web check-in with geofences, payroll and the manager workspace',
        '{"OMR": {"monthly": 50, "yearly": 500, "extraUserMonthly": 4, "extraUserYearly": 40}}',
        '{"employees":100,"devices":5,"branches":5,"users":110,"storage_mb":5120,"api_calls_month":250000,"raw_retention_days":1095}',
        '{"reports_basic","notifications_email","payroll_export"}', 3,
        '{devices,geofences,leave,manager_workspace,payroll,report_schedules,self_service}', 11, 0)
on conflict (key) do nothing;

-- the existing plans get prices and modules only while nobody has configured them yet (a re-run never overwrites an edit)
update public.plans set trial_days = 14, modules = (select array_agg(key order by key) from public.modules), sort_order = 1
where key = 'trial' and modules = '{}';
update public.plans set
  name = 'Starter', description = 'Attendance with terminals and employee self-service',
  prices = '{"OMR": {"monthly": 25, "yearly": 250, "extraUserMonthly": 2, "extraUserYearly": 20}}',
  limits = '{"employees":50,"devices":2,"branches":2,"users":60,"storage_mb":2048,"api_calls_month":100000,"raw_retention_days":730}',
  included_users = 11, modules = '{devices,self_service}', sort_order = 2
where key = 'starter' and prices = '{}'::jsonb;
update public.plans set
  description = 'Multi-branch organisations: everything in Professional plus the Flowza Finance integration',
  prices = '{"OMR": {"monthly": 110, "yearly": 1100, "extraUserMonthly": 3.5, "extraUserYearly": 35}}',
  included_users = 25, modules = (select array_agg(key order by key) from public.modules), sort_order = 4
where key = 'business' and prices = '{}'::jsonb;
update public.plans set is_custom = true, modules = (select array_agg(key order by key) from public.modules), sort_order = 5
where key = 'enterprise' and modules = '{}';

-- ---------------------------------------------------------------------------------------------------------------------------
-- 3. Per-tenant module overrides (platform-controlled)
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.organization_modules (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  module_key text not null references public.modules(key) on delete cascade,
  enabled boolean not null,
  reason text check (reason is null or length(btrim(reason)) between 3 and 500),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, module_key)
);
comment on table public.organization_modules is 'The platform''s per-tenant override of a module (no row = the plan decides). Written only by the system context after requirePlatformAdmin; audited on the organisation.';
create index if not exists organization_modules_module_idx on public.organization_modules (module_key);
drop trigger if exists organization_modules_updated_at on public.organization_modules;
create trigger organization_modules_updated_at before update on public.organization_modules for each row execute function app.set_updated_at();

revoke all on public.organization_modules from authenticated, anon;
grant select on public.organization_modules to authenticated;
grant select, insert, update, delete on public.organization_modules to flowza_system;
drop policy if exists organization_modules_read on public.organization_modules;
create policy organization_modules_read on public.organization_modules for select to authenticated
  using (organization_id = any ((select app.member_org_ids())::uuid[]) or (select app.is_platform_admin()));
drop policy if exists organization_modules_system on public.organization_modules;
create policy organization_modules_system on public.organization_modules for all to flowza_system
  using ((select app.is_system()) and organization_id = (select app.system_org_id()))
  with check ((select app.is_system()) and organization_id = (select app.system_org_id()));
call app.enforce_tenant_table('public.organization_modules');
call app.forbid_client_writes('public.organization_modules');

-- ---------------------------------------------------------------------------------------------------------------------------
-- 4. Subscriptions: billing cycle and seats
-- ---------------------------------------------------------------------------------------------------------------------------
alter table public.subscriptions add column if not exists billing_cycle text not null default 'yearly';
alter table public.subscriptions add column if not exists seats int;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.subscriptions'::regclass and conname = 'subscriptions_billing_cycle_check') then
    alter table public.subscriptions add constraint subscriptions_billing_cycle_check check (billing_cycle in ('monthly', 'yearly'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.subscriptions'::regclass and conname = 'subscriptions_seats_check') then
    alter table public.subscriptions add constraint subscriptions_seats_check check (seats is null or seats between 1 and 100000);
  end if;
end $$;
comment on column public.subscriptions.seats is 'Licensed users (active employees) the tenant pays for; null = the plan''s employee limit. Caps employee creation.';

-- ---------------------------------------------------------------------------------------------------------------------------
-- 5. Effective module states — the one rule
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function app._org_module_states(p_org_ids uuid[])
returns table (organization_id uuid, module_key text, enabled boolean, in_plan boolean, override boolean, available boolean, lapsed boolean)
language sql stable security definer set search_path = '' as $$
  select o.id, m.key,
         m.is_available
           and not coalesce(s.status in ('expired', 'cancelled'), false)
           and coalesce(om.enabled, p.modules is null or m.key = any (p.modules)),
         coalesce(p.modules is null or m.key = any (p.modules), true),
         om.enabled,
         m.is_available,
         coalesce(s.status in ('expired', 'cancelled'), false)
  from public.organizations o
  cross join public.modules m
  left join public.subscriptions s on s.organization_id = o.id
  left join public.plans p on p.id = s.plan_id
  left join public.organization_modules om on om.organization_id = o.id and om.module_key = m.key
  where o.id = any (p_org_ids)
$$;
comment on function app._org_module_states(uuid[]) is 'Unguarded implementation of the module rule (owner only; called by principal_snapshot and the guarded wrappers).';
revoke all on function app._org_module_states(uuid[]) from public, anon, authenticated, flowza_system, flowza_api, flowza_worker;

create or replace function app.org_module_states(p_org_ids uuid[])
returns table (organization_id uuid, module_key text, enabled boolean, in_plan boolean, override boolean, available boolean, lapsed boolean)
language sql stable security definer set search_path = '' as $$
  select s.* from app._org_module_states(array(
    select x from unnest(p_org_ids) x
    where app.is_platform_admin() or app.is_platform_context() or x = any (app.member_org_ids())
  )) s
$$;
comment on function app.org_module_states(uuid[]) is 'Effective module states of the organisations the caller may see (members, the system context of the org, the platform context, platform admins); others are silently dropped.';
revoke all on function app.org_module_states(uuid[]) from public, anon;
grant execute on function app.org_module_states(uuid[]) to authenticated, flowza_system;

create or replace function app.org_module_enabled(p_org uuid, p_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select bool_or(s.enabled) from app.org_module_states(array[p_org]) s where s.module_key = p_key
$$;
comment on function app.org_module_enabled(uuid, text) is 'Whether a module is enabled for an organisation; null when the caller may not see it or the key is unknown.';
revoke all on function app.org_module_enabled(uuid, text) from public, anon;
grant execute on function app.org_module_enabled(uuid, text) to authenticated, flowza_system;

-- principal_snapshot (latest body: 20260928000150) + `disabledModules`: {orgId: [module keys that are off]}
create or replace function app.principal_snapshot(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with admin as (
    select exists (select 1 from public.platform_admins pa where pa.user_id = p_user_id and pa.status = 'active') as is_admin
  ),
  grants as (
    select g.organization_id, g.access_level
    from public.platform_access_grants g, admin
    where admin.is_admin
      and g.platform_admin_user_id = p_user_id and g.revoked_at is null and now() >= g.starts_at and now() < g.expires_at
  ),
  member_orgs as (
    select m.organization_id from public.org_memberships m where m.user_id = p_user_id and m.status = 'active'
    union
    select organization_id from grants
  )
  select jsonb_build_object(
    'profile', (select jsonb_build_object('id', p.id, 'email', p.email, 'status', p.status) from public.user_profiles p where p.id = p_user_id),
    'isPlatformAdmin', (select is_admin from admin),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'membershipId', m.id, 'organizationId', m.organization_id, 'roleId', m.role_id, 'roleKey', r.key,
        'allBranches', m.all_branches, 'employeeId', m.employee_id,
        'permissions', coalesce((select jsonb_agg(rp.permission_key order by rp.permission_key) from public.role_permissions rp where rp.role_id = m.role_id), '[]'::jsonb),
        'branchIds', case when m.all_branches then '[]'::jsonb
                          else coalesce((select jsonb_agg(mb.branch_id) from public.membership_branches mb where mb.membership_id = m.id), '[]'::jsonb) end,
        'teamEmployeeIds', case when m.employee_id is null or not exists (
                                  select 1 from public.employees me
                                  where me.id = m.employee_id and me.organization_id = m.organization_id
                                    and me.deleted_at is null and me.employment_status not in ('terminated', 'resigned'))
                                then '[]'::jsonb
                                else coalesce((select jsonb_agg(e.id order by e.id) from public.employees e
                                               where e.organization_id = m.organization_id and e.deleted_at is null
                                                 and e.employment_status not in ('terminated', 'resigned')
                                                 and (e.manager_employee_id = m.employee_id or e.secondary_manager_employee_id = m.employee_id)), '[]'::jsonb) end
      ) order by m.created_at, m.id)
      from public.org_memberships m
      join public.roles r on r.id = m.role_id
      where m.user_id = p_user_id and m.status = 'active'), '[]'::jsonb),
    'grants', coalesce((select jsonb_agg(jsonb_build_object('organizationId', organization_id, 'accessLevel', access_level)) from grants), '[]'::jsonb),
    'allPermissions', case when (select is_admin from admin)
                           then coalesce((select jsonb_agg(k.key order by k.key) from public.permissions k), '[]'::jsonb)
                           else '[]'::jsonb end,
    'mfaRequiredOrgIds', coalesce((
      select jsonb_agg(s.organization_id) from public.organization_settings s
      where s.organization_id in (select organization_id from member_orgs) and s.security -> 'mfaRequired' = 'true'::jsonb), '[]'::jsonb),
    'disabledModules', coalesce((
      select jsonb_object_agg(d.organization_id, d.keys)
      from (select ms.organization_id, jsonb_agg(ms.module_key order by ms.module_key) as keys
            from app._org_module_states(array(select organization_id from member_orgs)) ms
            where not ms.enabled
            group by ms.organization_id) d), '{}'::jsonb)
  );
$$;
revoke all on function app.principal_snapshot(uuid) from public, anon, authenticated, flowza_system, flowza_worker;
grant execute on function app.principal_snapshot(uuid) to flowza_api;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 6. Billing: invoices and payments
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_number text not null unique check (length(invoice_number) between 3 and 40),
  status text not null default 'issued' check (status in ('issued', 'paid', 'void')),
  currency text not null default 'OMR' check (currency ~ '^[A-Z]{3}$'),
  plan_key text,
  plan_name text,
  billing_cycle text check (billing_cycle is null or billing_cycle in ('monthly', 'yearly', 'custom')),
  seats int check (seats is null or seats between 1 and 100000),
  period_start date,
  period_end date,
  lines jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),
  subtotal numeric(14, 3) not null check (subtotal >= 0),
  discount numeric(14, 3) not null default 0 check (discount >= 0),
  tax_rate numeric(5, 2) not null default 0 check (tax_rate between 0 and 100),
  tax_amount numeric(14, 3) not null default 0 check (tax_amount >= 0),
  total numeric(14, 3) not null check (total >= 0),
  amount_paid numeric(14, 3) not null default 0 check (amount_paid >= 0),
  activates_subscription boolean not null default true,
  subscription_applied_at timestamptz,
  issue_date date not null default current_date,
  due_date date,
  paid_at timestamptz,
  voided_at timestamptz,
  void_reason text check (void_reason is null or length(btrim(void_reason)) between 3 and 500),
  notes text check (notes is null or length(notes) <= 2000),
  seller jsonb not null default '{}'::jsonb check (jsonb_typeof(seller) = 'object'),
  customer jsonb not null default '{}'::jsonb check (jsonb_typeof(customer) = 'object'),
  created_by uuid,
  created_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_invoices_period_order check (period_start is null or period_end is null or period_end >= period_start),
  constraint billing_invoices_discount_le_subtotal check (discount <= subtotal),
  constraint billing_invoices_total_matches check (total = subtotal - discount + tax_amount),
  constraint billing_invoices_void_state check ((status = 'void') = (voided_at is not null)),
  constraint billing_invoices_paid_state check (status <> 'paid' or paid_at is not null)
);
comment on table public.billing_invoices is 'Invoices FlowZa issues to a tenant. Written only by the system context after requirePlatformAdmin; members holding organization.manage read their own. Financial record: never hard-deleted by the application (voided instead).';
create index if not exists billing_invoices_org_issue_idx on public.billing_invoices (organization_id, issue_date desc, invoice_number desc);
create index if not exists billing_invoices_status_idx on public.billing_invoices (status, due_date);
drop trigger if exists billing_invoices_updated_at on public.billing_invoices;
create trigger billing_invoices_updated_at before update on public.billing_invoices for each row execute function app.set_updated_at();

create table if not exists public.billing_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid not null references public.billing_invoices(id) on delete cascade,
  kind text not null default 'payment' check (kind in ('payment', 'refund')),
  amount numeric(14, 3) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  method text not null check (method in ('bank_transfer', 'card', 'cash', 'cheque', 'online', 'other')),
  reference text check (reference is null or length(reference) <= 200),
  received_on date not null default current_date,
  notes text check (notes is null or length(notes) <= 1000),
  recorded_by uuid,
  recorded_by_label text,
  created_at timestamptz not null default now()
);
comment on table public.billing_payments is 'Payments and refunds received against billing invoices. Append-only (a wrong entry is corrected by a refund or a new payment).';
create index if not exists billing_payments_org_received_idx on public.billing_payments (organization_id, received_on desc);
create index if not exists billing_payments_invoice_idx on public.billing_payments (invoice_id);
drop trigger if exists billing_payments_append_only on public.billing_payments;
create trigger billing_payments_append_only before update on public.billing_payments for each row execute function app.reject_modification();

do $$
declare t text;
begin
  foreach t in array array['public.billing_invoices', 'public.billing_payments'] loop
    execute format('revoke all on %s from authenticated, anon', t);
    execute format('grant select on %s to authenticated', t);
    execute format('grant select, insert, update on %s to flowza_system', t);
  end loop;
end $$;
drop policy if exists billing_invoices_read on public.billing_invoices;
create policy billing_invoices_read on public.billing_invoices for select to authenticated
  using (organization_id = any ((select app.org_ids_with_permission('organization.manage'))::uuid[]) or (select app.is_platform_admin()));
drop policy if exists billing_invoices_system on public.billing_invoices;
create policy billing_invoices_system on public.billing_invoices for all to flowza_system
  using ((select app.is_system()) and organization_id = (select app.system_org_id()))
  with check ((select app.is_system()) and organization_id = (select app.system_org_id()));
drop policy if exists billing_payments_read on public.billing_payments;
create policy billing_payments_read on public.billing_payments for select to authenticated
  using (organization_id = any ((select app.org_ids_with_permission('organization.manage'))::uuid[]) or (select app.is_platform_admin()));
drop policy if exists billing_payments_system on public.billing_payments;
create policy billing_payments_system on public.billing_payments for all to flowza_system
  using ((select app.is_system()) and organization_id = (select app.system_org_id()))
  with check ((select app.is_system()) and organization_id = (select app.system_org_id()));
call app.enforce_tenant_table('public.billing_invoices');
call app.enforce_tenant_table('public.billing_payments');
call app.forbid_client_writes('public.billing_invoices');
call app.forbid_client_writes('public.billing_payments');

-- a payment belongs to the invoice's organisation, in the invoice's currency
create or replace function app.billing_payment_matches_invoice() returns trigger
language plpgsql set search_path = '' as $$
declare v_org uuid; v_currency text;
begin
  select i.organization_id, i.currency into v_org, v_currency from public.billing_invoices i where i.id = new.invoice_id;
  if v_org is distinct from new.organization_id or v_currency is distinct from new.currency then
    raise exception 'a billing payment must carry its invoice''s organisation and currency' using errcode = '23514', constraint = 'billing_payments_invoice_match', table = 'billing_payments', schema = 'public';
  end if;
  return new;
end $$;
drop trigger if exists billing_payments_invoice_match on public.billing_payments;
create trigger billing_payments_invoice_match before insert on public.billing_payments for each row execute function app.billing_payment_matches_invoice();

-- invoice numbers: <PREFIX>-<YEAR>-<00001>, one counter per prefix and year (Muscat calendar year)
create table if not exists public.billing_invoice_counters (
  prefix text not null check (prefix ~ '^[A-Z][A-Z0-9]{1,9}$'),
  year int not null check (year between 2000 and 2999),
  last_number int not null default 0 check (last_number >= 0),
  primary key (prefix, year)
);
comment on table public.billing_invoice_counters is 'Invoice number counters. Reached only through app.next_billing_invoice_number (owner).';
revoke all on public.billing_invoice_counters from authenticated, anon, flowza_system;
call app.enforce_tenant_table('public.billing_invoice_counters');

create or replace function app.next_billing_invoice_number(p_prefix text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_year int := extract(year from (now() at time zone 'Asia/Muscat'))::int;
  v_n int;
begin
  if not app.is_system() then
    raise exception 'invoice numbers are issued by the system context only' using errcode = '42501';
  end if;
  if p_prefix is null or p_prefix !~ '^[A-Z][A-Z0-9]{1,9}$' then
    raise exception 'invalid invoice prefix' using errcode = '22023';
  end if;
  insert into public.billing_invoice_counters as c (prefix, year, last_number) values (p_prefix, v_year, 1)
  on conflict (prefix, year) do update set last_number = c.last_number + 1
  returning c.last_number into v_n;
  return format('%s-%s-%s', p_prefix, v_year, lpad(v_n::text, 5, '0'));
end $$;
revoke all on function app.next_billing_invoice_number(text) from public, anon, authenticated, flowza_api, flowza_worker;
grant execute on function app.next_billing_invoice_number(text) to flowza_system;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 7. Platform settings
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.platform_settings (
  key text primary key check (key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]{1,62}$'),
  value jsonb not null,
  description text not null default '' check (length(description) <= 300),
  is_public boolean not null default false,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
comment on table public.platform_settings is 'Platform key/value settings (group.name). is_public keys are readable by every signed-in user; the rest by platform admins. Written by the platform-scope system context after requirePlatformAdmin.';
drop trigger if exists platform_settings_updated_at on public.platform_settings;
create trigger platform_settings_updated_at before update on public.platform_settings for each row execute function app.set_updated_at();
revoke all on public.platform_settings from authenticated, anon;
grant select on public.platform_settings to authenticated;
grant select, insert, update on public.platform_settings to flowza_system;
drop policy if exists platform_settings_read on public.platform_settings;
create policy platform_settings_read on public.platform_settings for select to authenticated using (is_public or (select app.is_platform_admin()));
drop policy if exists platform_settings_system_read on public.platform_settings;
create policy platform_settings_system_read on public.platform_settings for select to flowza_system using ((select app.is_system()));
drop policy if exists platform_settings_platform_write on public.platform_settings;
create policy platform_settings_platform_write on public.platform_settings for all to flowza_system
  using ((select app.system_org_id()) = '00000000-0000-0000-0000-000000000000'::uuid)
  with check ((select app.system_org_id()) = '00000000-0000-0000-0000-000000000000'::uuid);
call app.enforce_tenant_table('public.platform_settings');

insert into public.platform_settings (key, value, description, is_public) values
  ('general.platform_name', '"FlowZa Time"', 'Product name shown on invoices and e-mails', true),
  ('general.support_email', '"support@flowza.ai"', 'Where tenants write about billing and support', true),
  ('billing.currency', '"OMR"', 'Currency of plans and invoices (ISO 4217)', true),
  ('billing.vat_rate', '5', 'VAT charged on invoices, in percent (Oman: 5)', true),
  ('billing.invoice_prefix', '"FZT"', 'Invoice number prefix (letters and digits, 2–10)', false),
  ('billing.payment_terms_days', '14', 'Days between issue date and due date', true),
  ('billing.seller_name', '"F & Z Capital"', 'Legal name printed on invoices', true),
  ('billing.seller_vat_number', '""', 'VAT registration number (VATIN) printed on invoices', true),
  ('billing.seller_address', '"Muscat, Sultanate of Oman"', 'Address printed on invoices', true),
  ('billing.bank_details', '""', 'Bank account for transfers, printed on invoices', true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------------------------------------
-- post-verify
-- ---------------------------------------------------------------------------------------------------------------------------
do $$
declare v_def text;
begin
  if (select count(*) from public.modules) < 8 then
    raise exception 'modules: the catalogue is incomplete';
  end if;
  -- no tenant that exists today loses a module: the plans tenants are on today (trial, business; enterprise) include all of them
  if exists (select 1 from public.plans p where p.key in ('trial', 'business', 'enterprise')
             and exists (select 1 from public.modules m where not (m.key = any (p.modules)))) then
    raise exception 'modules: trial / business / enterprise do not include every module (existing tenants would lose one)';
  end if;
  if not exists (select 1 from public.plans where key = 'professional' and included_users = 11
                 and (prices -> 'OMR' ->> 'yearly')::numeric = 500) then
    raise exception 'plans: the Professional reference package (500 OMR a year for 11 users) is missing';
  end if;
  v_def := pg_get_functiondef('app.principal_snapshot(uuid)'::regprocedure);
  if v_def not like '%disabledModules%' or v_def not like '%teamEmployeeIds%' or v_def not like '%mfaRequiredOrgIds%' then
    raise exception 'principal_snapshot lost a key';
  end if;
  if has_function_privilege('authenticated', 'app.principal_snapshot(uuid)', 'execute') or not has_function_privilege('flowza_api', 'app.principal_snapshot(uuid)', 'execute') then
    raise exception 'principal_snapshot grants differ (flowza_api only)';
  end if;
  if has_function_privilege('authenticated', 'app._org_module_states(uuid[])', 'execute') or has_function_privilege('flowza_system', 'app._org_module_states(uuid[])', 'execute')
     or has_function_privilege('flowza_api', 'app._org_module_states(uuid[])', 'execute') or has_function_privilege('anon', 'app.org_module_states(uuid[])', 'execute') then
    raise exception 'module state functions: the unguarded implementation is reachable or anon can execute the wrapper';
  end if;
  if has_function_privilege('authenticated', 'app.next_billing_invoice_number(text)', 'execute') then
    raise exception 'invoice numbers: clients can draw invoice numbers';
  end if;
  if has_table_privilege('authenticated', 'public.billing_invoices', 'insert,update,delete') or has_table_privilege('authenticated', 'public.billing_payments', 'insert,update,delete')
     or has_table_privilege('authenticated', 'public.organization_modules', 'insert,update,delete') or has_table_privilege('authenticated', 'public.modules', 'insert,update,delete')
     or has_table_privilege('authenticated', 'public.platform_settings', 'insert,update,delete') or has_table_privilege('authenticated', 'public.billing_invoice_counters', 'select,insert,update,delete') then
    raise exception 'clients must not write the module, billing or settings tables';
  end if;
end $$;
