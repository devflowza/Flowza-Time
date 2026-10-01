-- FlowZa Time · 20261001000300 · User limit: the one rule for a tenant's licensed users and their cap.
--
-- FlowZa Time is sold per user — a licensed employee (docs/pricing.md). A platform admin sets how many users a tenant may
-- have (`subscriptions.seats`, written only through PATCH /platform/orgs/:id/subscription); the tenant can never change it.
-- The API caps every path that adds an active employee (create, re-activation, bulk status, import) and both the super-admin
-- portal and the tenant show the usage as "used / limit".
--
--  1. `app.org_user_limits(uuid[])` — per organisation: users in use (employees not deleted and not terminated / resigned)
--     and the effective limit with where it comes from, in this order:
--       `override` an `entitlements` row for `employees` in force now (disabled ⇒ 0; enabled without a value ⇒ no limit)
--       `seats`    the users set on the subscription by a platform admin (whatever the subscription status)
--       `plan`     the plan's `limits.employees`, while the subscription is live (trialing / active / past_due)
--       null       no limit configured
--     Counts only, never a row of an employee. Callers: platform admins (tenants list, tenant page), the platform context,
--     and the system context of that one organisation (the API, after its own permission check). Organisations the caller
--     may not see are silently dropped, as in `app.org_module_states`.
--
-- Additive and idempotent, one transaction; no table is touched (a function only).

set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

create or replace function app.org_user_limits(p_org_ids uuid[])
returns table (organization_id uuid, used bigint, user_limit int, limit_source text)
language sql stable security definer set search_path = '' as $$
  select o.id,
    (select count(*) from public.employees e
      where e.organization_id = o.id and e.deleted_at is null and e.employment_status not in ('terminated', 'resigned')),
    case
      when ov.organization_id is not null then case when ov.enabled then least(floor(ov.limit_value), 2147483647)::int else 0 end
      when s.seats is not null then s.seats
      when s.status in ('trialing', 'active', 'past_due') and jsonb_typeof(p.limits -> 'employees') = 'number'
        then least(floor((p.limits ->> 'employees')::numeric), 2147483647)::int
    end,
    case
      when ov.organization_id is not null then 'override'
      when s.seats is not null then 'seats'
      when s.status in ('trialing', 'active', 'past_due') and jsonb_typeof(p.limits -> 'employees') = 'number' then 'plan'
    end
  from public.organizations o
  left join public.subscriptions s on s.organization_id = o.id
  left join public.plans p on p.id = s.plan_id
  left join lateral (
    select en.organization_id, en.enabled, en.limit_value from public.entitlements en
    where en.organization_id = o.id and en.key = 'employees' and en.effective_from <= now() and (en.effective_to is null or en.effective_to > now())
    order by en.effective_from desc limit 1
  ) ov on true
  where o.id = any (p_org_ids)
    and (app.is_platform_admin() or app.is_platform_context() or o.id = app.system_org_id())
$$;
comment on function app.org_user_limits(uuid[]) is
  'Licensed users in use (active employees) and the effective user limit (override › subscription seats › plan limits.employees) per organisation. Platform admins, the platform context and the system context of the organisation only; others are silently dropped.';
revoke all on function app.org_user_limits(uuid[]) from public, anon;
grant execute on function app.org_user_limits(uuid[]) to authenticated, flowza_system;

comment on column public.subscriptions.seats is
  'Licensed users (active employees) the tenant may have and pays for — set by a platform admin only; null = the plan''s employee limit. Caps every path that adds an active employee (app.org_user_limits).';

-- self-check: the function exists, is guarded, and pins its search_path
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'app' and p.proname = 'org_user_limits' and p.prosecdef
                   and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""')) then
    raise exception 'org_user_limits: missing or not SECURITY DEFINER with a pinned search_path';
  end if;
  if has_function_privilege('anon', 'app.org_user_limits(uuid[])', 'execute') then
    raise exception 'org_user_limits: anon may execute it';
  end if;
end $$;
