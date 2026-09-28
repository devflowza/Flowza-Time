-- FlowZa Time · 20260928000600 · HR attendance workspace parity (HR portal Prompt 6a)
--
-- Report sharing and schedules (Finance parity ATT-107…ATT-110, without Finance's §9 quirks):
--
-- 1. report_schedules — one row per saved schedule: report type + format + filters (the report's own parameters minus the
--    period, which the period rule derives), cadence monthly (run_day 1–28) or weekly (run_day 0=Sun…6=Sat) at run_time in
--    the ORGANISATION's timezone, period rule previous_month | month_to_date | previous_week | custom (the last complete
--    cut-off period: from day of one month → an earlier to day of the next), recipients { userIds[], roleKeys[] } and
--    channels in_app / email.
--    RLS: read with report.view, write with report.schedule, both branch scoped on branch_id (= filters.branchId, so a
--    branch-scoped holder only ever sees / edits schedules of their branches or organisation-wide ones they may read).
--    A platform-context SELECT lets the scheduler find due schedules across organisations (ids + next_run_at only are used).
-- 2. report_deliveries — the per-recipient trail of every send-now and scheduled run: which recipient got which report
--    request (generated under THAT recipient's own access scope by the worker), through which channels, or why the recipient
--    was skipped. Unique (organization_id, run_key, recipient_user_id) makes a re-run of the same occurrence a no-op.
--    RLS: read by report.schedule holders (they manage distribution) and by the recipient; written by the system context
--    only — no client write policy and no client write grant, so a client write RAISES instead of silently touching nothing.
-- 3. report_requests gains a unique (id, organization_id) so deliveries reference their report request with a composite FK.
--
-- Additive; idempotent (re-applying is a no-op); bounded lock wait (hot-table rule). No backfill.
set lock_timeout = '5s';
set statement_timeout = '120s';
set client_min_messages = warning;

-- 1. report_schedules ------------------------------------------------------------------------------------------------------
create table if not exists public.report_schedules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  report_type text not null check (report_type ~ '^[a-z_]{3,64}$'),
  format public.report_format not null default 'pdf',
  -- the report's parameters without the period (branchId, departmentId, employeeIds, leaveTypeCode, employmentStatus, scope, locale)
  filters jsonb not null default '{}'::jsonb check (jsonb_typeof(filters) = 'object' and octet_length(filters::text) <= 65536),
  -- = filters.branchId, denormalised for the RLS branch scope; null = organisation-wide
  branch_id uuid,
  cadence text not null check (cadence in ('monthly', 'weekly')),
  run_day int not null,
  run_time time not null default '07:00',
  period_rule text not null check (period_rule in ('previous_month', 'month_to_date', 'previous_week', 'custom')),
  custom_from_day int check (custom_from_day between 1 and 28),
  custom_to_day int check (custom_to_day between 1 and 28),
  -- { "userIds": [uuid…] (≤ 50), "roleKeys": [text…] (≤ 10) }; resolved to active members at every run
  recipients jsonb not null default '{}'::jsonb check (jsonb_typeof(recipients) = 'object'),
  channels text[] not null default '{in_app,email}',
  is_active boolean not null default true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_status text check (last_status in ('success', 'partial', 'failed', 'skipped')),
  last_error text check (last_error is null or length(last_error) <= 2000),
  last_summary jsonb,
  created_by uuid references public.user_profiles(id) on delete set null,
  updated_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint report_schedules_id_org_key unique (id, organization_id),
  constraint report_schedules_branch_fkey foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete cascade,
  constraint report_schedules_run_day_check check ((cadence = 'monthly' and run_day between 1 and 28) or (cadence = 'weekly' and run_day between 0 and 6)),
  constraint report_schedules_cadence_period_check check (
    (cadence = 'monthly' and period_rule in ('previous_month', 'month_to_date', 'custom'))
    or (cadence = 'weekly' and period_rule in ('previous_week', 'month_to_date'))),
  -- custom = from day of the previous month → an EARLIER day of the run month (a payroll cut-off such as 26 → 25)
  constraint report_schedules_custom_days_check check (
    ((period_rule = 'custom') = (custom_from_day is not null and custom_to_day is not null))
    and (custom_from_day is null or custom_to_day is null or custom_from_day > custom_to_day)),
  constraint report_schedules_channels_check check (cardinality(channels) between 1 and 2 and channels <@ array['in_app', 'email']::text[]),
  constraint report_schedules_recipients_shape_check check (
    jsonb_typeof(coalesce(recipients -> 'userIds', '[]'::jsonb)) = 'array' and jsonb_array_length(coalesce(recipients -> 'userIds', '[]'::jsonb)) <= 50
    and jsonb_typeof(coalesce(recipients -> 'roleKeys', '[]'::jsonb)) = 'array' and jsonb_array_length(coalesce(recipients -> 'roleKeys', '[]'::jsonb)) <= 10),
  constraint report_schedules_next_run_check check (not is_active or next_run_at is not null)
);
comment on table public.report_schedules is 'Saved report schedules (HR portal Prompt 6a): monthly/weekly runs in the organisation timezone; every recipient receives the report generated under their own access scope. Read report.view, write report.schedule.';
create index if not exists report_schedules_org_idx on public.report_schedules (organization_id, created_at desc);
create index if not exists report_schedules_due_idx on public.report_schedules (next_run_at) where is_active;
drop trigger if exists report_schedules_updated_at on public.report_schedules;
create trigger report_schedules_updated_at before update on public.report_schedules for each row execute function app.set_updated_at();

call app.apply_tenant_policies('public.report_schedules', 'report.view', 'report.schedule', 'branch_id');
drop policy if exists report_schedules_platform_ctx on public.report_schedules;
create policy report_schedules_platform_ctx on public.report_schedules for select to flowza_system using ((select app.is_platform_context()));

-- 3. composite key on report_requests for the deliveries FK ---------------------------------------------------------------
create unique index if not exists report_requests_id_org_idx on public.report_requests (id, organization_id);

-- 2. report_deliveries ------------------------------------------------------------------------------------------------------
create table if not exists public.report_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  schedule_id uuid,
  -- occurrence key: `schedule:<id>:<from>..<to>@<scheduled for>`, `manual:<uuid>` (run now) or `send:<uuid>` (send now)
  run_key text not null check (length(run_key) between 3 and 200),
  mode text not null check (mode in ('schedule', 'manual', 'send_now')),
  report_type text not null check (report_type ~ '^[a-z_]{3,64}$'),
  format public.report_format not null,
  period_from date,
  period_to date,
  recipient_user_id uuid not null references public.user_profiles(id) on delete cascade,
  sent_by uuid references public.user_profiles(id) on delete set null,
  channels text[] not null default '{in_app,email}',
  -- the access scope the report was generated under: { kind: ORGANIZATION|BRANCHES|TEAM, branchCount?, employeeCount? }
  scope jsonb not null default '{}'::jsonb check (jsonb_typeof(scope) = 'object'),
  status text not null default 'queued' check (status in ('queued', 'delivered', 'skipped', 'failed')),
  skip_reason text check (skip_reason is null or length(skip_reason) <= 200),
  error text check (error is null or length(error) <= 2000),
  report_request_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  delivered_at timestamptz,
  constraint report_deliveries_schedule_fkey foreign key (schedule_id, organization_id) references public.report_schedules(id, organization_id) on delete set null (schedule_id),
  constraint report_deliveries_request_fkey foreign key (report_request_id, organization_id) references public.report_requests(id, organization_id) on delete set null (report_request_id),
  constraint report_deliveries_channels_check check (cardinality(channels) between 1 and 2 and channels <@ array['in_app', 'email']::text[]),
  constraint report_deliveries_period_check check (period_from is null or period_to is null or period_to >= period_from),
  constraint report_deliveries_run_recipient_key unique (organization_id, run_key, recipient_user_id)
);
comment on table public.report_deliveries is 'Per-recipient trail of shared and scheduled reports (HR portal Prompt 6a). System-written; read by report.schedule holders and the recipient.';
create index if not exists report_deliveries_org_idx on public.report_deliveries (organization_id, created_at desc);
create index if not exists report_deliveries_schedule_idx on public.report_deliveries (organization_id, schedule_id, created_at desc) where schedule_id is not null;
create index if not exists report_deliveries_request_idx on public.report_deliveries (report_request_id) where report_request_id is not null;
create index if not exists report_deliveries_recipient_idx on public.report_deliveries (recipient_user_id, created_at desc);
drop trigger if exists report_deliveries_updated_at on public.report_deliveries;
create trigger report_deliveries_updated_at before update on public.report_deliveries for each row execute function app.set_updated_at();

alter table public.report_deliveries enable row level security;
drop policy if exists report_deliveries_select on public.report_deliveries;
create policy report_deliveries_select on public.report_deliveries for select to authenticated, flowza_system using (
  organization_id = any ((select app.org_ids_with_permission('report.schedule'))::uuid[]) or recipient_user_id = (select app.uid())
);
drop policy if exists report_deliveries_system_write on public.report_deliveries;
create policy report_deliveries_system_write on public.report_deliveries for all to flowza_system using (organization_id = app.system_org_id()) with check (organization_id = app.system_org_id());
-- The schema default privileges grant authenticated insert/update/delete; take them back so a client write raises rather than
-- filtering to zero rows (the trail is the worker's and the API's system step's, never the browser's).
revoke insert, update, delete on public.report_deliveries from authenticated;

-- Safety net (new tables must have RLS).
do $$
declare r record;
begin
  for r in select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p') and n.nspname in ('public', 'audit') and not c.relrowsecurity
             and c.relname not like '%\_default' and c.relname !~ '_\d{6}$'
  loop
    raise exception 'table %.% has no RLS', r.nspname, r.relname;
  end loop;
end $$;

-- Post-verify: the pieces the API, the worker and the web rely on.
do $$
begin
  if not exists (select 1 from public.permissions where key = 'report.schedule') then raise exception 'report.schedule missing (migration 20260928000100)'; end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'report_schedules' and policyname in ('report_schedules_select', 'report_schedules_insert', 'report_schedules_update', 'report_schedules_delete', 'report_schedules_platform_ctx')) <> 5 then
    raise exception 'report_schedules policies incomplete';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'report_schedules' and policyname = 'report_schedules_insert' and with_check like '%report.schedule%') then raise exception 'report_schedules write policy must require report.schedule'; end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'report_schedules' and policyname = 'report_schedules_select' and qual like '%report.view%') then raise exception 'report_schedules read policy must require report.view'; end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'report_deliveries' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL') and 'authenticated' = any (roles)) then raise exception 'report_deliveries must have no client write policy'; end if;
  if has_table_privilege('authenticated', 'public.report_deliveries', 'insert') or has_table_privilege('authenticated', 'public.report_deliveries', 'update')
     or has_table_privilege('authenticated', 'public.report_deliveries', 'delete') then raise exception 'authenticated must not hold write privileges on report_deliveries'; end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'report_requests_id_org_idx') then raise exception 'report_requests (id, organization_id) index missing'; end if;
end $$;
