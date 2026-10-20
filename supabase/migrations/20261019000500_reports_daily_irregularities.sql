-- FlowZa Time · 20261019000500 · Periodic reports on irregular cases, daily schedules and line-manager recipients
--
-- Customer requirement: "a morning report on irregular cases to each direct manager, and a monthly report for the Director
-- General". The report itself (`irregularities_report`) is a new report type — `report_requests.report_type` and
-- `report_schedules.report_type` are free text checked against a pattern, so it needs no DDL. What does:
--
-- 1. report_schedules.cadence gains `daily` (every day at run_time in the organisation's zone; run_day is stored as 0) and
--    period_rule gains `previous_day` (yesterday). A daily schedule covers yesterday or the month to date
--    (report_schedules_cadence_period_check mirrors PERIOD_RULES_BY_CADENCE in @flowza/contracts).
-- 2. recipients gains an optional boolean `lineManagers`: at every run, each active member whose employee record is the primary
--    manager of at least one active employee receives a copy about their own team only (scopeReportForRecipient, scope TEAM).
--    The shape check accepts the key only as a boolean. Who may receive what is decided by the worker per recipient, exactly
--    as for userIds / roleKeys — nothing here widens access.
--
-- No new table, column or policy; RLS on report_schedules / report_deliveries is unchanged (service-written, see 20260928000820).
-- Idempotent (drop-if-exists + add); small table, bounded lock wait. Constraints are added NOT VALID and validated separately so
-- the ACCESS EXCLUSIVE lock is held only for the catalogue change.
set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

alter table public.report_schedules drop constraint if exists report_schedules_cadence_check;
alter table public.report_schedules add constraint report_schedules_cadence_check check (cadence in ('monthly', 'weekly', 'daily')) not valid;
alter table public.report_schedules validate constraint report_schedules_cadence_check;

alter table public.report_schedules drop constraint if exists report_schedules_period_rule_check;
alter table public.report_schedules add constraint report_schedules_period_rule_check
  check (period_rule in ('previous_month', 'month_to_date', 'previous_week', 'custom', 'previous_day')) not valid;
alter table public.report_schedules validate constraint report_schedules_period_rule_check;

alter table public.report_schedules drop constraint if exists report_schedules_run_day_check;
alter table public.report_schedules add constraint report_schedules_run_day_check check (
  (cadence = 'monthly' and run_day between 1 and 28)
  or (cadence = 'weekly' and run_day between 0 and 6)
  or (cadence = 'daily' and run_day = 0)) not valid;
alter table public.report_schedules validate constraint report_schedules_run_day_check;

alter table public.report_schedules drop constraint if exists report_schedules_cadence_period_check;
alter table public.report_schedules add constraint report_schedules_cadence_period_check check (
  (cadence = 'monthly' and period_rule in ('previous_month', 'month_to_date', 'custom'))
  or (cadence = 'weekly' and period_rule in ('previous_week', 'month_to_date'))
  or (cadence = 'daily' and period_rule in ('previous_day', 'month_to_date'))) not valid;
alter table public.report_schedules validate constraint report_schedules_cadence_period_check;

alter table public.report_schedules drop constraint if exists report_schedules_recipients_line_managers_check;
alter table public.report_schedules add constraint report_schedules_recipients_line_managers_check
  check (jsonb_typeof(coalesce(recipients -> 'lineManagers', 'false'::jsonb)) = 'boolean') not valid;
alter table public.report_schedules validate constraint report_schedules_recipients_line_managers_check;

comment on table public.report_schedules is 'Saved report schedules (HR portal Prompt 6a; daily cadence and line-manager recipients 20261019000500): monthly / weekly / daily runs in the organisation timezone; every recipient receives the report generated under their own access scope (a line manager: their team). Read report.view, write report.schedule (service only).';

-- Sanity: the constraints say what the contracts say.
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.report_schedules'::regclass and conname = 'report_schedules_cadence_check' and pg_get_constraintdef(oid) like '%daily%') then
    raise exception 'report_schedules_cadence_check must allow daily';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.report_schedules'::regclass and conname = 'report_schedules_cadence_period_check' and pg_get_constraintdef(oid) like '%previous_day%') then
    raise exception 'report_schedules_cadence_period_check must allow previous_day for daily schedules';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'report_schedules' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL') and 'authenticated' = any (roles)) then
    raise exception 'report_schedules must still have no client write policy';
  end if;
end $$;
