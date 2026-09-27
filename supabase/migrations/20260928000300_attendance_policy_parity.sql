-- Attendance policy parity and engine flags — HR portal Prompt 3.
--
-- 1. `attendance_day_marks`: a reviewed verdict on one employee-day that the engine folds into the daily record as
--    flags (UNEXCUSED / EXCUSED / LOP / PAY_EFFECT). Written by the day-close sweep (source SWEEP), a note review
--    (NOTE_REVIEW, Prompt 4), HR by hand (HR) or another system flow (SYSTEM). Rows are never edited or deleted — a
--    wrong mark is REVOKED (revoked_at / revoked_by / revoke_reason) and a new one written; a trigger enforces exactly
--    that, so the mark trail is as reproducible as the corrections trail. At most one ACTIVE mark per (employee, date,
--    kind) — partial unique index. `pay_effect_days` ∈ {0, 0.5, 1}: mandatory (> 0) for LOP / PAY_EFFECT, informative
--    for UNEXCUSED (the weight the policy assessed), always 0 for EXCUSED.
--    RLS through the tenant policy generator: read with `attendance.view` (branch scope), own rows (employee_id), or the
--    team key `attendance.view_team` for direct reports; write with `attendance.approve` (branch scope). The worker
--    writes in the organisation's system context like every other attendance table.
-- 2. `attendance_period_summaries` gains the payroll read model of the marks: `lop_days` (Σ 0.5 / 1 per LOP day),
--    `unexcused_days`, `excused_days`, and `non_working_day_work_minutes` (work recorded on weekly offs / holidays).
--    FlowZa Time exports the figures; it never prices them (it is not payroll).
-- 3. `organization_settings.attendance` gains nested policy groups (contracts: attendanceSettingsSchema). One
--    deliberate data step: organisations that existed before this migration get `nonWorkingDay.action = 'overtime'`
--    when they never configured the key, because that is what their attendance engine did until now (weekly-off /
--    holiday work counted as overtime per the rule set's switches). New organisations start with the documented
--    default `record` (minutes kept, no overtime). Nothing else is backfilled.
--
-- Additive, idempotent; bounded lock waits (hot tables: attendance_period_summaries, organization_settings).
set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

-- 1. Day marks -------------------------------------------------------------------------------------------------------------
create table if not exists public.attendance_day_marks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null,
  attendance_date date not null,
  branch_id uuid, -- the employee's branch on the date (RLS branch scope); null when unknown
  kind text not null check (kind in ('UNEXCUSED', 'EXCUSED', 'LOP', 'PAY_EFFECT')),
  pay_effect_days numeric(3,1) not null default 0 check (pay_effect_days in (0, 0.5, 1.0)),
  source text not null check (source in ('SWEEP', 'NOTE_REVIEW', 'HR', 'SYSTEM')),
  source_id uuid, -- the note / request / run the mark came from (no FK: those tables arrive with later prompts)
  reason text check (reason is null or length(reason) <= 1000),
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.user_profiles(id) on delete set null,
  revoke_reason text check (revoke_reason is null or length(revoke_reason) <= 1000),
  constraint attendance_day_marks_employee_fkey foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade,
  constraint attendance_day_marks_branch_fkey foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete set null (branch_id),
  constraint attendance_day_marks_pay_effect_by_kind check (
    (kind in ('LOP', 'PAY_EFFECT') and pay_effect_days > 0) or kind = 'UNEXCUSED' or (kind = 'EXCUSED' and pay_effect_days = 0)
  ),
  constraint attendance_day_marks_revocation_shape check (revoked_at is not null or (revoked_by is null and revoke_reason is null))
);
create unique index if not exists attendance_day_marks_active_idx on public.attendance_day_marks (organization_id, employee_id, attendance_date, kind) where revoked_at is null;
create index if not exists attendance_day_marks_employee_date_idx on public.attendance_day_marks (organization_id, employee_id, attendance_date desc);
create index if not exists attendance_day_marks_org_date_idx on public.attendance_day_marks (organization_id, attendance_date, branch_id) where revoked_at is null;
create index if not exists attendance_day_marks_source_idx on public.attendance_day_marks (source_id) where source_id is not null;

-- Append-only with revocation: only the three revocation columns may change, once, from unrevoked to revoked.
create or replace function app.protect_attendance_day_marks() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'attendance_day_marks are append-only; revoke the mark instead' using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - array['revoked_at', 'revoked_by', 'revoke_reason']) is distinct from (to_jsonb(old) - array['revoked_at', 'revoked_by', 'revoke_reason']) then
    raise exception 'attendance_day_marks are immutable; only the revocation columns may change' using errcode = 'P0001';
  end if;
  if old.revoked_at is not null then
    raise exception 'a revoked attendance day mark cannot be changed' using errcode = 'P0001';
  end if;
  if new.revoked_at is null then
    return new; -- a no-op update (nothing changed); harmless
  end if;
  return new;
end $$;
drop trigger if exists attendance_day_marks_protect on public.attendance_day_marks;
create trigger attendance_day_marks_protect before update or delete on public.attendance_day_marks for each row execute function app.protect_attendance_day_marks();

call app.apply_tenant_policies('public.attendance_day_marks', 'attendance.view', 'attendance.approve', 'branch_id', 'employee_id', null, 'employee_id', array['attendance.view_team']);

-- 2. Period summaries: the payroll read model of the marks ------------------------------------------------------------------
alter table public.attendance_period_summaries
  add column if not exists lop_days numeric(6,1) not null default 0 check (lop_days >= 0),
  add column if not exists unexcused_days int not null default 0 check (unexcused_days >= 0),
  add column if not exists excused_days int not null default 0 check (excused_days >= 0),
  add column if not exists non_working_day_work_minutes int not null default 0 check (non_working_day_work_minutes >= 0);

-- 3. Settings: keep the historical overtime behaviour for organisations that pre-date the switch --------------------------
update public.organization_settings
set attendance = attendance || jsonb_build_object('nonWorkingDay', jsonb_build_object('action', 'overtime'))
where not (attendance ? 'nonWorkingDay');

-- 4. Post-verify (fails the migration rather than leaving a half-applied state) ----------------------------------------------
do $$
declare v_count int;
begin
  if to_regclass('public.attendance_day_marks') is null then raise exception 'attendance_day_marks missing'; end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'attendance_day_marks_active_idx') then raise exception 'active-mark unique index missing'; end if;
  if not exists (select 1 from pg_trigger where tgname = 'attendance_day_marks_protect' and tgrelid = 'public.attendance_day_marks'::regclass) then raise exception 'day-mark protect trigger missing'; end if;
  select count(*) into v_count from pg_policies where schemaname = 'public' and tablename = 'attendance_day_marks';
  if v_count <> 4 then raise exception 'expected 4 tenant policies on attendance_day_marks, found %', v_count; end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'attendance_day_marks' and policyname = 'attendance_day_marks_select' and qual like '%team_employee_ids%' and qual like '%own_employee_ids%') then
    raise exception 'attendance_day_marks select policy lacks the self / team predicates';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'attendance_day_marks' and policyname = 'attendance_day_marks_insert' and with_check like '%attendance.approve%') then
    raise exception 'attendance_day_marks insert policy is not keyed on attendance.approve';
  end if;
  select count(*) into v_count from information_schema.columns
  where table_schema = 'public' and table_name = 'attendance_period_summaries' and column_name in ('lop_days', 'unexcused_days', 'excused_days', 'non_working_day_work_minutes');
  if v_count <> 4 then raise exception 'attendance_period_summaries policy-parity columns missing (% of 4)', v_count; end if;
  if exists (select 1 from public.organization_settings where not (attendance ? 'nonWorkingDay')) then raise exception 'organization_settings.attendance.nonWorkingDay backfill incomplete'; end if;
end $$;
