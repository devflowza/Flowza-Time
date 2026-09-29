-- FlowZa Time · 20260929000300 · Device PIN mappings survive device syncs
--
-- A person maps the device user id a terminal reports with every punch (the "PIN") to an employee on one device: Devices &
-- punches → PIN mapping, Unmapped punches → Assign, the device's Employees tab and the employee's Devices tab. The mapping is
-- the device_employee_states row the normaliser reads FIRST (apps/worker/src/handlers/attendance/normalize.ts), but nothing
-- marked it as a person's decision, so the sync engine treated it as its own bookkeeping:
--   * PULL_EMPLOYEES resolves listed users through provider identities and employees.device_user_id only — a mapped PIN that is
--     neither was rewritten as a device-only row (employee_id null) and the employee's punches went back to `unmatched`;
--   * PUSH_EMPLOYEE re-pointed the employee's row to the default device user id, orphaning the PIN the person enrols with.
-- mapped_at / mapped_by mark the row as a manual mapping; the worker keeps it (sync/employees.ts) and pushes the employee under
-- the mapped id. Rows written by the unmatched-punch Assign before this migration are marked from its audit entries when the
-- row still maps the same (device, device user id) to the same employee.
--
-- device_employee_states is a small, cold table (one row per device user); both columns are nullable without a default, a
-- catalogue-only change.
set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

alter table public.device_employee_states
  add column if not exists mapped_at timestamptz,
  add column if not exists mapped_by uuid;

comment on column public.device_employee_states.mapped_at is 'Set when a person mapped this device user id to the employee (PIN mapping); device syncs keep the mapping.';
comment on column public.device_employee_states.mapped_by is 'User who mapped the device user id to the employee (no FK: the audit log is the record).';

-- Backfill from the Assign action's audit entries (entity_id = '<device id>:<device user id>'), latest decision first.
with assigned as (
  select distinct on (l.organization_id, l.new_value ->> 'deviceId', l.new_value ->> 'deviceEmployeeId')
    l.organization_id, (l.new_value ->> 'deviceId')::uuid as device_id, l.new_value ->> 'deviceEmployeeId' as device_user_id,
    (l.new_value ->> 'employeeId')::uuid as employee_id, l.actor_user_id, l.created_at
  from audit.logs l
  where l.action = 'attendance.unmatched_assigned'
    and l.new_value ->> 'deviceId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and l.new_value ->> 'employeeId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and l.new_value ? 'deviceEmployeeId'
  order by l.organization_id, l.new_value ->> 'deviceId', l.new_value ->> 'deviceEmployeeId', l.created_at desc
)
update public.device_employee_states s
set mapped_at = a.created_at, mapped_by = a.actor_user_id
from assigned a
where s.organization_id = a.organization_id and s.device_id = a.device_id and s.device_user_id = a.device_user_id
  and s.employee_id = a.employee_id and s.mapped_at is null;
