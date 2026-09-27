-- FlowZa Time · demo tenant seed · Majan Gulf Trading & Contracting LLC · step 3b: employee self-service portal
--
-- Gives employee@flowza.ai (Priya Sharma, MG-1012, Software Engineer) a full self-service history for the /my portal:
--   · yearly allowances on the leave types, so the portal shows balances (AL 30, CL 6, EL 6, PTL 7, HJ 15, ML 98 days);
--   · her own leave requests in every state — approved with HR's note, rejected with a reason, withdrawn, and two
--     pending requests that HR sees on the Leave page (approve / reject);
--   · her own attendance correction requests through the "Line manager → HR" workflow (pending, rejected, withdrawn);
--   · in-app notifications for her (decisions, welcome) and for HR (new requests), and the matching audit trail.
--
-- Runs after 03_leave.sql and BEFORE 04_attendance.sql: approved full-day leave suppresses punches, and the only new
-- approved leave here is in the future (1 Oct 2026), so it never lands on a day that already has terminal punches.
-- Past additions are rejected / withdrawn requests only, which the attendance engine ignores. Idempotent (fixed ids,
-- upserts; append-only tables use `on conflict do nothing` / not-exists guards). Needs migration 20260927000100.
set client_min_messages = warning;

create or replace function pg_temp.sid(p text) returns uuid language sql immutable as
$$ select extensions.uuid_generate_v5('27bfe270-5dea-4587-aec3-0f5c23113261'::uuid, p) $$;

do $$
declare
  org uuid := '27bfe270-5dea-4587-aec3-0f5c23113261';
  tz text := 'Asia/Muscat';
  hradmin_id uuid := pg_temp.sid('user:hradmin@flowza.ai');
  priya_user uuid := pg_temp.sid('user:employee@flowza.ai');
  hr_role uuid := '10000000-0000-0000-0000-000000000003';
  priya uuid; priya_branch uuid;
  c record;
begin
  select e.id, e.branch_id into priya, priya_branch from public.employees e where e.organization_id = org and e.employee_number = 'MG-1012';
  if priya is null then raise exception 'MG-1012 not found: run 02_people.sql first'; end if;

  ---------------------------------------------------------------------------------------------------------------------
  -- 1. Yearly allowances (Oman Labour Law 53/2023 where it sets one); the others are tracked by usage only
  ---------------------------------------------------------------------------------------------------------------------
  update public.leave_types t set annual_allowance_days = a.days
  from (values ('AL', 30.0), ('CL', 6.0), ('EL', 6.0), ('PTL', 7.0), ('HJ', 15.0), ('ML', 98.0)) as a(code, days)
  where t.organization_id = org and t.code = a.code;

  -- HR's notes on the two approved requests already in 03_leave.sql
  update public.leave_records set decision_note = 'Get well soon, Priya.' where id = pg_temp.sid('leave:MG-1012:SL:2026-04-07');
  update public.leave_records set decision_note = 'Happy Onam! Handover to the IT team is confirmed.' where id = pg_temp.sid('leave:MG-1012:AL:2026-08-23');

  ---------------------------------------------------------------------------------------------------------------------
  -- 2. Priya's own requests (created_by = her login, as the portal does)
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.leave_records (id, organization_id, employee_id, branch_id, leave_type_id, start_date, end_date, is_half_day, half_day_part, status, source, reason, decision_note, approved_by, approved_at, created_by, created_at, updated_at)
  select pg_temp.sid('leave:MG-1012:' || v.code || ':' || v.s), org, priya, priya_branch, pg_temp.sid('leave-type:' || v.code), v.s::date, v.e::date, v.half, v.part::public.half_day_part,
         v.status::public.leave_status, 'INTERNAL', v.reason, v.note,
         case when v.status = 'APPROVED' then hradmin_id end,
         case when v.status = 'APPROVED' then v.decided::timestamptz end,
         priya_user, v.asked::timestamptz, coalesce(v.decided, v.asked)::timestamptz
  from (values
    -- type, start, end, half, part, status, reason, HR note, requested at, decided / withdrawn at
    ('AL', '2026-05-24', '2026-05-28', false, null, 'CANCELLED', 'Trip to Goa with friends', null, '2026-05-03 10:12+04', '2026-05-06 18:40+04'),
    ('AL', '2026-06-14', '2026-06-15', false, null, 'REJECTED', 'Long weekend at Jebel Akhdar', 'Release week for the ERP upgrade — please pick dates after 25 June.', '2026-05-31 09:05+04', '2026-06-01 11:20+04'),
    ('CL', '2026-10-01', '2026-10-01', false, null, 'APPROVED', 'Moving to a new flat in Al Khuwair', 'Approved — good luck with the move!', '2026-09-21 08:47+04', '2026-09-22 10:05+04'),
    ('CL', '2026-10-06', '2026-10-06', true, 'SECOND_HALF', 'PENDING', 'Indian Embassy appointment – passport renewal (afternoon)', null, '2026-09-24 13:30+04', null),
    ('AL', '2026-11-08', '2026-11-12', false, null, 'PENDING', 'Diwali with family in Mumbai', null, '2026-09-25 16:02+04', null)
  ) as v(code, s, e, half, part, status, reason, note, asked, decided)
  on conflict (id) do update set start_date = excluded.start_date, end_date = excluded.end_date, is_half_day = excluded.is_half_day, half_day_part = excluded.half_day_part,
    status = excluded.status, reason = excluded.reason, decision_note = excluded.decision_note, approved_by = excluded.approved_by, approved_at = excluded.approved_at, updated_at = now();

  ---------------------------------------------------------------------------------------------------------------------
  -- 3. Her correction requests through the workflow (MG-1010 has no login → step 1 falls back to the HR Admin role)
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.approval_workflows (id, organization_id, entity_type, name, branch_id, steps, is_default, status, created_at)
  values (pg_temp.sid('workflow:corrections'), org, 'ATTENDANCE_CORRECTION', 'Line manager → HR', null,
          jsonb_build_array(jsonb_build_object('order', 1, 'approverType', 'MANAGER'), jsonb_build_object('order', 2, 'approverType', 'ROLE', 'roleId', hr_role)), true, 'active', '2026-02-16 09:00:00+04')
  on conflict (id) do nothing;

  for c in
    select * from (values
      -- day, punch (Muscat), direction, status, reason, decision comment, requested at, decided at
      ('2026-09-22'::date, '17:25'::time, 'PUNCH_OUT', 'PENDING', 'Forgot to punch out — left at 17:25 after the release call', null, '2026-09-23 08:32+04'::timestamptz, null::timestamptz),
      ('2026-08-10'::date, '07:58'::time, 'PUNCH_IN', 'REJECTED', 'The terminal did not read my face at 07:58 — please add my punch-in', 'The terminal log shows a successful punch at 08:14; the late minutes stand.', '2026-08-10 12:15+04', '2026-08-11 09:40+04'),
      ('2026-07-06'::date, '17:05'::time, 'PUNCH_OUT', 'CANCELLED', 'Punch-out missing for Monday', 'Withdrawn: the punch was there — the terminal synced late.', '2026-07-07 08:20+04', '2026-07-07 11:02+04')
    ) as x(d, t, dir, status, reason, comment, asked, decided)
  loop
    insert into public.approval_requests (id, organization_id, workflow_id, entity_type, entity_id, branch_id, employee_id, current_step, status, requested_by, completed_at, created_at)
    values (pg_temp.sid('approval:MG-1012:self:' || c.d), org, pg_temp.sid('workflow:corrections'), 'ATTENDANCE_CORRECTION', pg_temp.sid('correction:MG-1012:self:' || c.d), priya_branch, priya,
            1, c.status::public.approval_status, priya_user, c.decided, c.asked)
    on conflict (id) do nothing;

    insert into public.attendance_corrections (id, organization_id, employee_id, branch_id, attendance_date, type, proposed_punched_at, proposed_event_type, reason, requested_by, status, approval_request_id, rejection_reason, created_at)
    values (pg_temp.sid('correction:MG-1012:self:' || c.d), org, priya, priya_branch, c.d, 'ADD_PUNCH', (c.d + c.t) at time zone tz, c.dir::public.attendance_event_type, c.reason, priya_user,
            c.status::public.correction_status, pg_temp.sid('approval:MG-1012:self:' || c.d), case when c.status <> 'PENDING' then c.comment end, c.asked)
    on conflict (id) do nothing;

    insert into public.approval_steps (id, organization_id, request_id, step_no, approver_type, approver_role_id, approver_user_id, status, acted_by, acted_at, comment)
    values
      (pg_temp.sid('approval-step:MG-1012:self:' || c.d || ':1'), org, pg_temp.sid('approval:MG-1012:self:' || c.d), 1, 'ROLE', hr_role, null,
       c.status::public.approval_status, case when c.status = 'REJECTED' then hradmin_id end, case when c.status = 'REJECTED' then c.decided end, case when c.status = 'REJECTED' then c.comment end),
      (pg_temp.sid('approval-step:MG-1012:self:' || c.d || ':2'), org, pg_temp.sid('approval:MG-1012:self:' || c.d), 2, 'ROLE', hr_role, null,
       case when c.status = 'PENDING' then 'PENDING' else 'CANCELLED' end::public.approval_status, null, null, null)
    on conflict (id) do nothing;
  end loop;

  ---------------------------------------------------------------------------------------------------------------------
  -- 4. Notifications (Priya: decisions + welcome; HR: the two open requests) and the audit trail
  ---------------------------------------------------------------------------------------------------------------------
  insert into public.notifications (id, organization_id, user_id, category, type, title, body, data, link, read_at, created_at)
  values
    (pg_temp.sid('notif:priya:welcome'), org, priya_user, 'SYSTEM', 'system.welcome', 'Your self-service portal is ready',
      'See your attendance, leave balance and requests under My workspace.', '{}'::jsonb, '/my', null, '2026-09-20 08:00+04'),
    (pg_temp.sid('notif:priya:leave-onam'), org, priya_user, 'APPROVAL', 'leave.approved', 'Leave approved: Annual Leave',
      '2026-08-23 → 2026-08-27 · Happy Onam! Handover to the IT team is confirmed.', jsonb_build_object('aggregateId', pg_temp.sid('leave:MG-1012:AL:2026-08-23')), '/my/leave', '2026-08-04 09:00+04', '2026-08-03 13:20+04'),
    (pg_temp.sid('notif:priya:leave-jebel'), org, priya_user, 'APPROVAL', 'leave.rejected', 'Leave not approved: Annual Leave',
      '2026-06-14 → 2026-06-15 · Release week for the ERP upgrade — please pick dates after 25 June.', jsonb_build_object('aggregateId', pg_temp.sid('leave:MG-1012:AL:2026-06-14')), '/my/leave', '2026-06-01 12:00+04', '2026-06-01 11:20+04'),
    (pg_temp.sid('notif:priya:correction-aug'), org, priya_user, 'APPROVAL', 'attendance.correction_rejected', 'Correction rejected',
      'The terminal log shows a successful punch at 08:14; the late minutes stand.', jsonb_build_object('aggregateId', pg_temp.sid('correction:MG-1012:self:2026-08-10')), '/my/attendance?tab=corrections', '2026-08-11 10:15+04', '2026-08-11 09:40+04'),
    (pg_temp.sid('notif:priya:leave-move'), org, priya_user, 'APPROVAL', 'leave.approved', 'Leave approved: Casual Leave',
      '2026-10-01 → 2026-10-01 · Approved — good luck with the move!', jsonb_build_object('aggregateId', pg_temp.sid('leave:MG-1012:CL:2026-10-01')), '/my/leave', null, '2026-09-22 10:05+04'),
    (pg_temp.sid('notif:hr:priya-embassy'), org, hradmin_id, 'APPROVAL', 'leave.requested', 'Leave request from Priya Sharma',
      'Casual Leave · 2026-10-06 → 2026-10-06', jsonb_build_object('aggregateId', pg_temp.sid('leave:MG-1012:CL:2026-10-06')), '/leave?status=PENDING', null, '2026-09-24 13:30+04'),
    (pg_temp.sid('notif:hr:priya-diwali'), org, hradmin_id, 'APPROVAL', 'leave.requested', 'Leave request from Priya Sharma',
      'Annual Leave · 2026-11-08 → 2026-11-12', jsonb_build_object('aggregateId', pg_temp.sid('leave:MG-1012:AL:2026-11-08')), '/leave?status=PENDING', null, '2026-09-25 16:02+04')
  on conflict (id) do nothing;

  insert into audit.logs (organization_id, actor_user_id, actor_type, actor_label, action, entity_type, entity_id, branch_id, old_value, new_value, reason, request_id, created_at)
  select org, a.actor, 'USER', a.label, a.action, a.entity_type, a.entity_id, priya_branch, a.old_value, a.new_value, null, 'seed-' || left(md5(a.action || a.entity_id || a.at::text), 12), a.at
  from (values
    (priya_user, 'Priya Sharma', 'leave.requested', 'leave_record', pg_temp.sid('leave:MG-1012:AL:2026-05-24')::text, null::jsonb, '{"leaveType":"AL","startDate":"2026-05-24","endDate":"2026-05-28"}'::jsonb, '2026-05-03 10:12+04'::timestamptz),
    (priya_user, 'Priya Sharma', 'leave.withdrawn', 'leave_record', pg_temp.sid('leave:MG-1012:AL:2026-05-24')::text, '{"status":"PENDING"}'::jsonb, '{"status":"CANCELLED"}'::jsonb, '2026-05-06 18:40+04'),
    (priya_user, 'Priya Sharma', 'leave.requested', 'leave_record', pg_temp.sid('leave:MG-1012:AL:2026-06-14')::text, null, '{"leaveType":"AL","startDate":"2026-06-14","endDate":"2026-06-15"}'::jsonb, '2026-05-31 09:05+04'),
    (hradmin_id, 'Fatma Al Balushi', 'leave.updated', 'leave_record', pg_temp.sid('leave:MG-1012:AL:2026-06-14')::text, '{"status":"PENDING"}'::jsonb, '{"status":"REJECTED"}'::jsonb, '2026-06-01 11:20+04'),
    (priya_user, 'Priya Sharma', 'leave.requested', 'leave_record', pg_temp.sid('leave:MG-1012:CL:2026-10-01')::text, null, '{"leaveType":"CL","startDate":"2026-10-01","endDate":"2026-10-01"}'::jsonb, '2026-09-21 08:47+04'),
    (hradmin_id, 'Fatma Al Balushi', 'leave.updated', 'leave_record', pg_temp.sid('leave:MG-1012:CL:2026-10-01')::text, '{"status":"PENDING"}'::jsonb, '{"status":"APPROVED"}'::jsonb, '2026-09-22 10:05+04'),
    (priya_user, 'Priya Sharma', 'leave.requested', 'leave_record', pg_temp.sid('leave:MG-1012:CL:2026-10-06')::text, null, '{"leaveType":"CL","startDate":"2026-10-06","endDate":"2026-10-06","isHalfDay":true}'::jsonb, '2026-09-24 13:30+04'),
    (priya_user, 'Priya Sharma', 'leave.requested', 'leave_record', pg_temp.sid('leave:MG-1012:AL:2026-11-08')::text, null, '{"leaveType":"AL","startDate":"2026-11-08","endDate":"2026-11-12"}'::jsonb, '2026-09-25 16:02+04'),
    (priya_user, 'Priya Sharma', 'attendance.correction_submitted', 'attendance_correction', pg_temp.sid('correction:MG-1012:self:2026-09-22')::text, null, '{"type":"ADD_PUNCH","attendanceDate":"2026-09-22"}'::jsonb, '2026-09-23 08:32+04')
  ) as a(actor, label, action, entity_type, entity_id, old_value, new_value, at)
  where not exists (select 1 from audit.logs l where l.organization_id = org and l.action = a.action and l.entity_id = a.entity_id and l.created_at = a.at);
end $$;

select 'employee portal' as step, status, count(*) from public.leave_records l join public.employees e on e.id = l.employee_id
where l.organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261' and e.employee_number = 'MG-1012' group by status order by status;
