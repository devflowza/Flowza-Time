-- FlowZa Time · 20261015000400 · Daily report schedules (docs/time-away.md §6): a manager receives YESTERDAY's attendance every
-- working morning (who checked in, who was late or absent). Additive; one transaction; ends with a post-verify block.
--   cadence 'daily'   run_day is a WEEKDAY MASK (bit d = weekday d, 0 = Sunday … 6 = Saturday; 1–127): the days it runs —
--                     e.g. 31 = Sunday–Thursday, the GCC working week;
--   period 'previous_day'  the day before the run (a complete day; daily cadence only).
-- Weekly and monthly schedules are unchanged.
-- Recipients still need report.view + report.export to open a delivered report; a line manager's copy is narrowed to their
-- team (attendance.view_team → TEAM scope). The system Manager role is unchanged (no report.export): an organisation that
-- wants its managers to receive the roll call gives them a role with report.export.
set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

alter table public.report_schedules drop constraint if exists report_schedules_cadence_check;
alter table public.report_schedules add constraint report_schedules_cadence_check check (cadence in ('monthly', 'weekly', 'daily'));
alter table public.report_schedules drop constraint if exists report_schedules_period_rule_check;
alter table public.report_schedules add constraint report_schedules_period_rule_check check (period_rule in ('previous_month', 'month_to_date', 'previous_week', 'custom', 'previous_day'));
alter table public.report_schedules drop constraint if exists report_schedules_run_day_check;
alter table public.report_schedules add constraint report_schedules_run_day_check check (
  (cadence = 'monthly' and run_day between 1 and 28) or (cadence = 'weekly' and run_day between 0 and 6) or (cadence = 'daily' and run_day between 1 and 127));
alter table public.report_schedules drop constraint if exists report_schedules_cadence_period_check;
alter table public.report_schedules add constraint report_schedules_cadence_period_check check (
  (cadence = 'monthly' and period_rule in ('previous_month', 'month_to_date', 'custom'))
  or (cadence = 'weekly' and period_rule in ('previous_week', 'month_to_date'))
  or (cadence = 'daily' and period_rule = 'previous_day'));
comment on table public.report_schedules is 'Saved report schedules (HR portal Prompt 6a): monthly / weekly / daily runs in the organisation timezone; every recipient receives the report generated under their own access scope. Read report.view, write report.schedule.';

do $$
begin
  if (select count(*) from pg_constraint where conrelid = 'public.report_schedules'::regclass
        and conname in ('report_schedules_cadence_check', 'report_schedules_period_rule_check', 'report_schedules_run_day_check', 'report_schedules_cadence_period_check')) <> 4 then
    raise exception 'report_schedules: a schedule constraint is missing';
  end if;
  if (select count(*) from pg_constraint where conrelid = 'public.report_schedules'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%cadence%' and pg_get_constraintdef(oid) not like '%daily%') > 0 then
    raise exception 'report_schedules: a cadence constraint still refuses daily';
  end if;
end $$;
