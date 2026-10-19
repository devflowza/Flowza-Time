-- FlowZa Time · 20261019000200 · Working-hours policies: flexible start, grace mode, approved working hours, recurring holidays.
--
-- Customer requirements "Flexible working hours", "Grace margin", "Approved working hours" and "Official holidays"
-- (attendance-engine/1.5.0, packages/domain calculate.ts):
--
--  1. shifts.flex_start_minutes — a FIXED shift's flexible start band: the employee may start any time from the shift start to
--     start + band without being late and the expected end moves with the start (07:00–14:00 with 120: in at 08:30 → expected
--     out 15:30). 0 = a plain fixed shift (every existing shift); a FLEXIBLE shift always stores 0.
--  2. attendance_rule_sets.grace_mode — 'deduct' (the grace is taken off a late arrival / early departure: every existing rule
--     set, the engine ≤ 1.4.0 behaviour) or 'tolerance' (within the grace nothing counts, beyond it every minute from the
--     scheduled time).
--  3. attendance_rule_sets.special_periods — approved / seasonal working hours ("circulars"): [{name, reference?, from, to,
--     startTime?, endTime?, scheduledMinutes?, appliesTo}], at most 20, validated (no overlap) by @flowza/contracts
--     specialPeriodsSchema; they take precedence over ramadan_mode on the dates both cover.
--  4. holidays.recurs_yearly — the holiday falls on the same Gregorian date every year; "Copy to next year" and the yearly
--     rollover repeat it.
--  5. holiday_calendars.auto_rollover / holidays.rolled_over_at — from 1 December (organisation time) the worker task
--     `holidays.rollover` creates next year's occurrence of every recurring holiday of a calendar with auto_rollover, once per
--     holiday: `rolled_over_at` is the ledger, so an occurrence HR deletes from next year is not brought back, and a recurring
--     holiday added later in December is still rolled over the next day.
--
-- Idempotent, one transaction. Additive only: new columns with constant defaults (metadata-only in PG ≥ 11) and CHECK
-- constraints on small configuration tables; no backfill, no index.

set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

-- 1. flexible start band ------------------------------------------------------------------------------------------------------
alter table public.shifts add column if not exists flex_start_minutes int not null default 0;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.shifts'::regclass and conname = 'shifts_flex_start_minutes_check') then
    alter table public.shifts add constraint shifts_flex_start_minutes_check
      check (flex_start_minutes between 0 and 240 and (type = 'FIXED' or flex_start_minutes = 0));
  end if;
end $$;
comment on column public.shifts.flex_start_minutes is
  'FIXED only: flexible start band in minutes after the start — start anywhere in it without being late; the expected end moves with the start (engine 1.5.0). 0 = off.';

-- 2. + 3. grace mode, approved working hours ------------------------------------------------------------------------------
alter table public.attendance_rule_sets add column if not exists grace_mode text not null default 'deduct';
alter table public.attendance_rule_sets add column if not exists special_periods jsonb not null default '[]'::jsonb;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.attendance_rule_sets'::regclass and conname = 'attendance_rule_sets_grace_mode_check') then
    alter table public.attendance_rule_sets add constraint attendance_rule_sets_grace_mode_check check (grace_mode in ('deduct', 'tolerance'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.attendance_rule_sets'::regclass and conname = 'attendance_rule_sets_special_periods_check') then
    alter table public.attendance_rule_sets add constraint attendance_rule_sets_special_periods_check
      check (jsonb_typeof(special_periods) = 'array' and jsonb_array_length(special_periods) <= 20);
  end if;
end $$;
comment on column public.attendance_rule_sets.grace_mode is
  'deduct: the grace is taken off a late arrival / early departure (default). tolerance: within the grace nothing counts, beyond it every minute from the scheduled time (engine 1.5.0).';
comment on column public.attendance_rule_sets.special_periods is
  'Approved / seasonal working hours ("circulars"): [{name, reference?, from, to, startTime?, endTime?, scheduledMinutes?, appliesTo}] — @flowza/contracts specialPeriodsSchema; precedence over ramadan_mode.';

-- 4. recurring holidays -------------------------------------------------------------------------------------------------------
alter table public.holidays add column if not exists recurs_yearly boolean not null default false;
alter table public.holidays add column if not exists rolled_over_at timestamptz;
comment on column public.holidays.recurs_yearly is
  'Same Gregorian date every year (National Day…): copied by "Copy to next year" and the yearly rollover. Moon-sighted holidays are not recurring.';
comment on column public.holidays.rolled_over_at is
  'When the next year''s occurrence of this recurring holiday was created (or found) by the rollover or "Copy to next year" — the rollover''s ledger.';

-- 5. yearly rollover ------------------------------------------------------------------------------------------------------------
alter table public.holiday_calendars add column if not exists auto_rollover boolean not null default true;
comment on column public.holiday_calendars.auto_rollover is
  'From 1 December (organisation time) next year''s occurrence of every recurring holiday is created in this calendar, once per holiday (worker task holidays.rollover).';
