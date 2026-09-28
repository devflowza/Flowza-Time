-- Leave v2 review fixes (HR portal Prompt 7; adversarial review docs/hr-portal/reviews/07-leave-v2-review.md).
--
-- 1. P0-2 — the person a row is about never writes it from a client session. A BEFORE INSERT/UPDATE/DELETE trigger on
--    `leave_records`, `comp_off_credits` and `leave_allocations` (SECURITY DEFINER, pinned search_path) refuses, for an
--    AUTHENTICATED session (the API's user context and PostgREST alike — never the organisation's system context the API's
--    validated system steps and the worker run in), any write to a row whose employee is one of the caller's own employee
--    records (`app.own_employee_ids()`, the live membership link):
--      - leave: everything except the self-service withdrawal of a request that is still undecided (PENDING /
--        INFO_REQUESTED → CANCELLED, the status and the withdrawal stamp only). Deciding it (status, approval stamps,
--        decision note), its `days`, its dates or type, cancelling decided leave, inserting or deleting it — all refused:
--        the API does them after its own checks (segregation of duties, validation, recompute) in the system context;
--      - comp-off credits: every write (creating a credit, its status, days, expiry, usage);
--      - allocations: every write.
--    Holders of `leave.manage` are NOT exempt: RLS lets them write their branch's rows, and without this guard that
--    included their own decision, credits and allocation (review RLS-1…4). Acting on OTHER employees is unchanged.
-- 2. P2-10 — employees no longer insert leave rows or comp-off credits directly: the self-service insert policies
--    `leave_records_self_request` and `comp_off_credits_self_request` are removed. Every create goes through the API, which
--    validates it (applicability, half days, locked periods, overlap, balances) and writes it in the system context. The
--    self-service withdrawal policy (`leave_records_self_update` + its guard) stays.
-- 3. B-41 (P1-3) — `leave_types.applicable_employment_types text[]`: the employment types a type applies to (null = all),
--    from the employees' `employment_type` vocabulary. One applicability rule (gender AND employment type) is used by the
--    portal, the API, the unexcused-day charger, the year close and allocation generation.
-- 4. P2-2 — `leave_year_closes`: one ledger row per (organisation, closed year), written by the year-close job in the
--    organisation's system context when it completes (the org-local date it ran on + its summary). The scheduler enqueues
--    the close of the previous year on every tick from 1 January (org local) until a row says it ran AFTER that year ended.
--
-- Additive and idempotent: the named policies are dropped / the trigger function replaced, nothing else is removed; a second
-- apply is a no-op. Bounded lock waits; post-verify at the end.
set lock_timeout = '5s';
set statement_timeout = '120s';
set client_min_messages = warning;

-- 1. The subject guard ----------------------------------------------------------------------------------------------------
create or replace function app.leave_subject_write_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_own uuid[];
  v_mine boolean := false;
begin
  -- `current_setting('role')` is the SET ROLE of the session even inside this SECURITY DEFINER function (current_user would
  -- be the owner): `authenticated` = a user session (PostgREST, the API's user context); the system context and the worker
  -- run as flowza_system, migrations and seeds as the owner.
  if coalesce(current_setting('role', true), '') <> 'authenticated' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  v_own := app.own_employee_ids();
  if tg_op in ('UPDATE', 'DELETE') and old.employee_id = any (v_own) then v_mine := true; end if;
  if tg_op in ('INSERT', 'UPDATE') and new.employee_id = any (v_own) then v_mine := true; end if;
  if not v_mine then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- the one own write a client session may make: withdrawing a request that is still undecided (status + the stamp only).
  -- Nested: `old.status` exists on leave_records only (plpgsql does not short-circuit one expression).
  if tg_table_name = 'leave_records' and tg_op = 'UPDATE' then
    if old.status::text in ('PENDING', 'INFO_REQUESTED') and new.status::text = 'CANCELLED'
       and (to_jsonb(new) - array['status', 'updated_at', 'withdrawn_at']) = (to_jsonb(old) - array['status', 'updated_at', 'withdrawn_at']) then
      return new;
    end if;
  end if;
  raise exception 'you cannot % your own % from a client session; it goes through the API (segregation of duties)',
    lower(tg_op), replace(tg_table_name, '_', ' ') using errcode = '42501';
end $$;
revoke all on function app.leave_subject_write_guard() from public;

drop trigger if exists leave_records_subject_guard on public.leave_records;
create trigger leave_records_subject_guard before insert or update or delete on public.leave_records
  for each row execute function app.leave_subject_write_guard();
drop trigger if exists comp_off_credits_subject_guard on public.comp_off_credits;
create trigger comp_off_credits_subject_guard before insert or update or delete on public.comp_off_credits
  for each row execute function app.leave_subject_write_guard();
drop trigger if exists leave_allocations_subject_guard on public.leave_allocations;
create trigger leave_allocations_subject_guard before insert or update or delete on public.leave_allocations
  for each row execute function app.leave_subject_write_guard();

-- 2. No direct self-service inserts ---------------------------------------------------------------------------------------
drop policy if exists leave_records_self_request on public.leave_records;
drop policy if exists comp_off_credits_self_request on public.comp_off_credits;

-- 3. Applicability by employment type (B-41) ------------------------------------------------------------------------------
alter table public.leave_types add column if not exists applicable_employment_types text[];
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leave_types_applicable_employment_types_check') then
    alter table public.leave_types add constraint leave_types_applicable_employment_types_check check (
      applicable_employment_types is null
      or (cardinality(applicable_employment_types) between 1 and 5
          and applicable_employment_types <@ array['full_time', 'part_time', 'contract', 'intern', 'temporary']::text[]));
  end if;
end $$;
-- the comp-off type is for everyone (it is redeemed from credits the employee earned)
update public.leave_types set applicable_employment_types = null where system_key = 'COMP_OFF' and applicable_employment_types is not null;

-- 4. Year-close ledger (P2-2) -----------------------------------------------------------------------------------------------
create table if not exists public.leave_year_closes (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  from_year int not null check (from_year between 2000 and 2100),
  -- the organisation-local date the close last ran on: the scheduler's catch-up stops once it is after 31 December of from_year
  ran_on date not null,
  ran_at timestamptz not null default now(),
  job_id text check (job_id is null or length(job_id) <= 100),
  requested_by uuid references public.user_profiles(id) on delete set null,
  summary jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  primary key (organization_id, from_year)
);
call app.apply_readonly_tenant_policies('public.leave_year_closes', 'leave.view');
drop policy if exists leave_year_closes_platform_ctx on public.leave_year_closes;
create policy leave_year_closes_platform_ctx on public.leave_year_closes for select to flowza_system using ((select app.is_platform_context()));

-- Post-verify: fail the migration rather than leave half a state.
do $$
declare v_missing text;
begin
  select string_agg(t, ', ') into v_missing from unnest(array['leave_records_subject_guard', 'comp_off_credits_subject_guard', 'leave_allocations_subject_guard']) t
  where not exists (select 1 from pg_trigger where tgname = t and not tgisinternal);
  if v_missing is not null then raise exception 'subject guard triggers missing: %', v_missing; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'leave_subject_write_guard' and p.prosecdef
                 and exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%')) then
    raise exception 'app.leave_subject_write_guard must be SECURITY DEFINER with a pinned search_path';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and policyname in ('leave_records_self_request', 'comp_off_credits_self_request')) then
    raise exception 'the direct self-service insert policies must be gone';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'leave_types' and column_name = 'applicable_employment_types') then
    raise exception 'leave_types.applicable_employment_types missing';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'leave_year_closes' and c.relrowsecurity) then
    raise exception 'leave_year_closes missing or without RLS';
  end if;
  select string_agg(p, ', ') into v_missing from unnest(array['leave_year_closes_select', 'leave_year_closes_system_write', 'leave_year_closes_platform_ctx']) p
  where not exists (select 1 from pg_policies where schemaname = 'public' and policyname = p);
  if v_missing is not null then raise exception 'policies missing: %', v_missing; end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'leave_year_closes' and 'authenticated' = any (roles) and cmd <> 'SELECT') then
    raise exception 'leave_year_closes must not be writable by clients';
  end if;
end $$;
