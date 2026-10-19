-- FlowZa Time · 20261019000400 · Attendance alerts: the once-per-employee-day ledger of the automatic attendance notices.
--
-- Customer requirements ("lateness and early departure notifications", "automatic handling of absence", "missing check-ins",
-- "weekly thank-you messages"): the worker tells an employee (and, per the organisation's settings, their direct manager)
-- about a late arrival, an early departure, an absence and its excuse deadline, a missing check-in after the shift start,
-- and thanks committed employees once a week. A day is recomputed many times; each notice must go out ONCE. This table is
-- the idempotency ledger: one row per (organisation, employee, date, kind), claimed with ON CONFLICT DO NOTHING in the same
-- transaction as the domain event, exactly like `missing_punch_reminders` (20260928001000).
--
--   kind              alert_date
--   LATE_ARRIVAL      the attendance date
--   EARLY_DEPARTURE   the attendance date
--   ABSENCE           the attendance date (the absence notice, with the excuse deadline)
--   ABSENCE_REMINDER  the attendance date (the reminder the day before the excuse deadline)
--   MISSING_CHECK_IN  the attendance date
--   APPRECIATION      the first day of the seven days reviewed (weekly thank-you message)
--
-- Written by the organisation's system context only (no client write privilege, the security gate's restrictive denials);
-- readable with attendance.view (branch scope does not apply: no branch column) and by the employee for their own rows.
-- Additive and idempotent; a new, empty table (no lock on a hot table).
set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

create table if not exists public.attendance_alerts (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null,
  alert_date date not null,
  kind text not null check (kind in ('LATE_ARRIVAL', 'EARLY_DEPARTURE', 'ABSENCE', 'ABSENCE_REMINDER', 'MISSING_CHECK_IN', 'APPRECIATION')),
  sent_at timestamptz not null default now(),
  -- how many logins the notice was addressed to (0: the employee has no login / nobody to tell — the day is still settled)
  recipients int not null default 0 check (recipients >= 0),
  primary key (organization_id, employee_id, alert_date, kind),
  constraint attendance_alerts_employee_fkey foreign key (employee_id, organization_id) references public.employees (id, organization_id) on delete cascade
);
comment on table public.attendance_alerts is 'One row per employee-day and kind of automatic attendance notice (late arrival, early departure, absence, its reminder, missing check-in, weekly appreciation) — the idempotency ledger of the worker. Written by the organisation''s system context only.';
-- the sweep's lookups and the purge walk by organisation, kind and date
create index if not exists attendance_alerts_org_kind_date_idx on public.attendance_alerts (organization_id, kind, alert_date);

-- RLS forced, tenant key immutable, no data API, no client write (the read-only generator of the security gate)
call app.apply_readonly_tenant_policies('public.attendance_alerts', 'attendance.view', null, 'employee_id');

-- Post-verify
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.attendance_alerts'::regclass) then
    raise exception 'attendance_alerts without RLS';
  end if;
  if has_table_privilege('authenticated', 'public.attendance_alerts', 'insert') or has_table_privilege('authenticated', 'public.attendance_alerts', 'update')
     or has_table_privilege('authenticated', 'public.attendance_alerts', 'delete') then
    raise exception 'attendance_alerts must be written by the system context only';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'attendance_alerts' and policyname = 'attendance_alerts_system_write') then
    raise exception 'attendance_alerts: the system context cannot write its ledger';
  end if;
end $$;
