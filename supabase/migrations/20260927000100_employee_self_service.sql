-- Employee self-service portal (/my): apply for leave, cancel a pending request, ask for an attendance correction.
--
-- 1. Two permissions, granted to every system role (every member linked to an employee record is also an employee):
--      leave.request                  apply for and cancel own leave
--      attendance.request_correction  ask for a correction to own attendance (routed through the approval workflow)
--    Custom roles are untouched; an administrator adds the permissions where wanted.
-- 2. RLS for the self-service writes. The generated tenant policies only let leave.manage / attendance.correct holders
--    write; these additional permissive policies admit exactly the self-service shapes and nothing else:
--      - leave_types:   active types are readable with leave.request (the apply form needs the list);
--      - leave_records: insert a PENDING, unapproved request for one's own employee record, on its own branch;
--                       update one's own PENDING request to CANCELLED (a guard trigger freezes every other column);
--      - attendance_corrections: insert a PENDING request for one's own employee record, requested by oneself.
--    Reads of own rows already work through the self column of the generated policies (app.own_employee_ids()).
-- 3. leave_types.annual_allowance_days: days per calendar year an employee may take (null = not tracked). The portal
--    shows used / pending / remaining against it; it informs, it never blocks (HR decides).
-- 4. leave_records.decision_note: HR's comment when approving or rejecting a request, shown to the employee.
--
-- Additive; no backfill. Bounded lock wait (hot-table rule).
set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

insert into public.permissions (key, category, description, sort_order) values
  ('leave.request',                 'leave',      'Apply for and cancel own leave (self-service)', 77),
  ('attendance.request_correction', 'attendance', 'Request corrections to own attendance (self-service)', 88)
on conflict (key) do update set category = excluded.category, description = excluded.description, sort_order = excluded.sort_order;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join (values ('leave.request'), ('attendance.request_correction')) as p(key)
where r.organization_id is null and r.is_system
on conflict do nothing;

alter table public.leave_types
  add column if not exists annual_allowance_days numeric(5,1) check (annual_allowance_days is null or (annual_allowance_days >= 0 and annual_allowance_days <= 366));

alter table public.leave_records
  add column if not exists decision_note text check (decision_note is null or length(decision_note) <= 1000);

-- leave types: the apply form lists the active ones -------------------------------------------------------------------
drop policy if exists leave_types_self_service_select on public.leave_types;
create policy leave_types_self_service_select on public.leave_types for select to authenticated using (
  status = 'active' and organization_id = any ((select app.org_ids_with_permission('leave.request'))::uuid[])
);

-- leave records: apply (insert PENDING) and cancel (PENDING → CANCELLED) for one's own employee record ---------------
drop policy if exists leave_records_self_request on public.leave_records;
create policy leave_records_self_request on public.leave_records for insert to authenticated with check (
  organization_id = any ((select app.org_ids_with_permission('leave.request'))::uuid[])
  and employee_id = any ((select app.own_employee_ids())::uuid[])
  and status = 'PENDING' and source = 'INTERNAL' and approved_by is null and approved_at is null and decision_note is null
  and created_by = (select app.uid())
  and exists (select 1 from public.employees e where e.id = leave_records.employee_id and e.organization_id = leave_records.organization_id
              and e.deleted_at is null and e.branch_id is not distinct from leave_records.branch_id)
);

drop policy if exists leave_records_self_cancel on public.leave_records;
create policy leave_records_self_cancel on public.leave_records for update to authenticated using (
  organization_id = any ((select app.org_ids_with_permission('leave.request'))::uuid[])
  and employee_id = any ((select app.own_employee_ids())::uuid[])
  and status = 'PENDING'
) with check (
  organization_id = any ((select app.org_ids_with_permission('leave.request'))::uuid[])
  and employee_id = any ((select app.own_employee_ids())::uuid[])
  and status = 'CANCELLED'
);

-- A user without leave.manage who reaches an update through the self-cancel policy may change the status only.
-- Only user sessions (role authenticated) are checked: system steps, the worker and admin seeds run as other roles.
create or replace function app.leave_records_self_service_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user::text <> 'authenticated' or app.has_permission(new.organization_id, 'leave.manage') then
    return new;
  end if;
  if old.status <> 'PENDING' or new.status <> 'CANCELLED'
     or (to_jsonb(new) - array['status', 'updated_at']) is distinct from (to_jsonb(old) - array['status', 'updated_at']) then
    raise exception 'self-service may only cancel a pending leave request' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists leave_records_self_service_guard on public.leave_records;
create trigger leave_records_self_service_guard before update on public.leave_records for each row execute function app.leave_records_self_service_guard();

-- attendance corrections: request (insert PENDING) for one's own employee record ---------------------------------------
-- Routing to approvers and cancellation run as a system step in the API after the service-level checks.
drop policy if exists attendance_corrections_self_request on public.attendance_corrections;
create policy attendance_corrections_self_request on public.attendance_corrections for insert to authenticated with check (
  organization_id = any ((select app.org_ids_with_permission('attendance.request_correction'))::uuid[])
  and employee_id = any ((select app.own_employee_ids())::uuid[])
  and status = 'PENDING' and requested_by = (select app.uid()) and approval_request_id is null
  and applied_event_id is null and applied_at is null
  and exists (select 1 from public.employees e where e.id = attendance_corrections.employee_id and e.organization_id = attendance_corrections.organization_id
              and e.deleted_at is null and e.branch_id = attendance_corrections.branch_id)
);
