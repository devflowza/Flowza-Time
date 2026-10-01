-- FlowZa Time · 20261001000100 · Overtime counts the time worked after the shift end ("when an employee checks out after their
-- scheduled shift end time, the additional time should be considered overtime and should appear in the overview").
--
-- Until now regular overtime on a fixed shift was the work beyond the scheduled minutes, outside the shift hours, minus a
-- 30-minute threshold, rounded down to 15 minutes in whole 30-minute blocks — so a check-out up to an hour after the shift
-- end earned nothing, and a late arrival who stayed late earned nothing at all. The engine (attendance-engine/1.2.0) now
-- counts the minutes worked after the expected end (and before the start with count_early_in_as_overtime); the stricter
-- rule — only the part beyond the scheduled minutes, so a late arrival making up time after the end earns none — is a rule
-- set switch:
--
--  1. attendance_rule_sets.overtime_requires_scheduled_hours. Rule sets saved before this migration keep the result they
--     produced (true: added with that default, a metadata-only change that rewrites no row and fires no trigger); a new rule
--     set starts with false, the contract default.
--  2. The column defaults of the overtime threshold, minimum block and rounding follow the contract defaults (0: every minute
--     after the shift end counts). Existing rule sets keep their stored values; an organisation without a rule set runs on the
--     contract defaults (packages/contracts DEFAULT_ATTENDANCE_RULES).
--
-- Idempotent, one transaction. Additive: one column, three column defaults.

set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

alter table public.attendance_rule_sets add column if not exists overtime_requires_scheduled_hours boolean not null default true;
alter table public.attendance_rule_sets alter column overtime_requires_scheduled_hours set default false;
comment on column public.attendance_rule_sets.overtime_requires_scheduled_hours is
  'Regular overtime only beyond the scheduled minutes (a late arrival making up the time after the shift end earns none). Off: every minute worked after the shift end counts.';

alter table public.attendance_rule_sets alter column overtime_start_after_minutes set default 0;
alter table public.attendance_rule_sets alter column overtime_min_block_minutes set default 0;
alter table public.attendance_rule_sets alter column overtime_rounding_minutes set default 0;
