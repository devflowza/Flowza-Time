-- FlowZa Time · 20261013000200 · Overtime is recorded in exact minutes.
--
-- Reported: overtime came out in half hours / hours, and the first half hour after the shift end was never counted. Two
-- causes, one of them in stored data:
--
--  1. The engine deducted the rule set's threshold ("OT starts after") from the overtime and kept whole minimum blocks
--     only: 105 min after the shift end under a 30-min threshold and 30-min blocks recorded 60, and 38 min recorded none.
--     attendance-engine/1.5.0 (packages/domain finaliseOvertime) counts overtime from its first minute once it reaches the
--     threshold and the minimum, which now only decide WHETHER a day earns overtime. No data to migrate for that.
--  2. Rule sets saved while the column defaults of 20260905001000 applied, and the demo tenants seeded with the same
--     values, still round overtime DOWN to 15 minutes. This migration sets that rounding to none (exact minutes, the
--     contract default since 20261001000100) on every rule set that still rounds, bumps their version (the editor's
--     concurrency token) and writes one SYSTEM audit entry per rule set with the value it had. An organisation that wants
--     rounded overtime selects it again in the policy editor (Schedule → Policies → Overtime).
--
-- Stored daily records keep their figures until they are recalculated (Attendance → Recalculate, or any change that
-- triggers one): the engine never rewrites history on its own.
--
-- Idempotent (a second run finds no rule set that rounds), one transaction. Touches only the rule sets that round.

set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

with rounding as (
  select id, overtime_rounding_minutes, version from public.attendance_rule_sets where overtime_rounding_minutes <> 0 for update
), changed as (
  update public.attendance_rule_sets rs
     set overtime_rounding_minutes = 0, version = rs.version + 1
    from rounding r
   where rs.id = r.id
  returning rs.id, rs.organization_id, rs.branch_id, rs.name, r.overtime_rounding_minutes as old_rounding, r.version as old_version, rs.version as new_version
)
insert into audit.logs (organization_id, actor_type, actor_label, action, entity_type, entity_id, branch_id, old_value, new_value, reason)
select c.organization_id, 'SYSTEM', 'migration 20261013000200', 'attendance.rule_set_updated', 'attendance_rule_set', c.id::text, c.branch_id,
       jsonb_build_object('name', c.name, 'overtimeRoundingMinutes', c.old_rounding, 'version', c.old_version),
       jsonb_build_object('name', c.name, 'overtimeRoundingMinutes', 0, 'version', c.new_version),
       'Overtime is recorded in exact minutes (attendance-engine 1.5.0): the overtime rounding of the policy is removed.'
from changed c;

comment on column public.attendance_rule_sets.overtime_rounding_minutes is
  'Optional rounding of regular overtime, DOWN to this many minutes. 0 (the default) = exact minutes.';
comment on column public.attendance_rule_sets.overtime_start_after_minutes is
  'Regular overtime is earned only when the minutes worked past the shift end reach this; it then counts from the first minute (engine 1.5.0). 0 = every minute.';
comment on column public.attendance_rule_sets.overtime_min_block_minutes is
  'Regular overtime shorter than this is discarded; longer overtime counts minute for minute (engine 1.5.0, not whole blocks). 0 = no minimum.';
