-- FlowZa Time · Hikvision test tenant seed · step 1/5: Enterprise plan, 100-user limit, every module on
--
-- Target: organisation 78a5a348-69b6-4c51-8d72-3697f72c50f0 ("Hikvision", HR Admin login reddyprem1311@gmail.com,
-- owner prem@flowza.ai). Idempotent; runs on the admin connection (see README.md in this folder).
--
-- What an admin would do in /adm → Tenant: Subscription → Enterprise, User limit → 100, Modules → "Back to plan" for the
-- five modules switched off for testing on 1 Oct. Every change is audited on the tenant like the admin panel does.
set client_min_messages = warning;

do $$
declare
  org uuid := '78a5a348-69b6-4c51-8d72-3697f72c50f0';
  ent uuid := (select id from public.plans where key = 'enterprise');
  label text := 'Demo data seed (supabase/seeds/hikvision-tenant), requested by prem@flowza.ai';
  old_sub jsonb;
  old_mods jsonb;
begin
  if ent is null then raise exception 'enterprise plan missing'; end if;
  if not exists (select 1 from public.organizations where id = org and company_code = 'HIKVISION') then raise exception 'tenant not found'; end if;

  select jsonb_build_object('planKey', p.key, 'status', s.status, 'seats', s.seats, 'billingCycle', s.billing_cycle, 'trialEndsAt', s.trial_ends_at)
    into old_sub from public.subscriptions s join public.plans p on p.id = s.plan_id where s.organization_id = org;

  if old_sub ->> 'planKey' is distinct from 'enterprise' or (old_sub ->> 'seats') is distinct from '100' then
    update public.subscriptions set
      plan_id = ent, status = 'active', seats = 100, billing_cycle = 'yearly', trial_ends_at = null,
      current_period_start = '2026-10-01 00:00:00+04', current_period_end = '2027-10-01 00:00:00+04', cancel_at = null, updated_at = now()
    where organization_id = org;

    insert into audit.logs (organization_id, actor_type, actor_label, action, entity_type, entity_id, old_value, new_value, reason)
    values (org, 'SYSTEM', label, 'organization.subscription_changed', 'subscription', org, old_sub,
            jsonb_build_object('planKey', 'enterprise', 'status', 'active', 'seats', 100, 'billingCycle', 'yearly', 'trialEndsAt', null),
            'Enterprise demo: Enterprise plan with a user limit of 100');
  end if;

  update public.organizations set status = 'active', updated_at = now() where id = org and status = 'trial';

  -- the five "testing" overrides (self_service, geofences, leave, payroll, finance_integration off) → back to the plan
  select coalesce(jsonb_agg(jsonb_build_object('module', module_key, 'enabled', enabled, 'reason', reason) order by module_key), '[]'::jsonb)
    into old_mods from public.organization_modules where organization_id = org;
  if jsonb_array_length(old_mods) > 0 then
    delete from public.organization_modules where organization_id = org;
    insert into audit.logs (organization_id, actor_type, actor_label, action, entity_type, entity_id, old_value, new_value, reason)
    values (org, 'SYSTEM', label, 'organization.modules_changed', 'organization_modules', org, jsonb_build_object('overrides', old_mods),
            jsonb_build_object('overrides', '[]'::jsonb), 'Enterprise demo: every module back to the plan (all modules on)');
  end if;
end $$;

select 'plan' as step, p.key as plan, s.status, s.seats, o.status as org_status,
  (select count(*) from public.organization_modules m where m.organization_id = s.organization_id) as module_overrides,
  array_to_string(p.modules, ', ') as modules
from public.subscriptions s join public.plans p on p.id = s.plan_id join public.organizations o on o.id = s.organization_id
where s.organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0';
