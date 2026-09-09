-- FlowZa Time · demo tenant seed · Majan Gulf Trading & Contracting LLC · step 5/5: notifications and audit trail
--
-- A handful of in-app notifications and audit entries so the bell, the audit page and the Audit Trail report are not
-- empty on first open. Append-only tables use `on conflict do nothing` / fixed ids. Must run after 04_attendance.sql.
set client_min_messages = warning;

create or replace function pg_temp.sid(p text) returns uuid language sql immutable as
$$ select extensions.uuid_generate_v5('27bfe270-5dea-4587-aec3-0f5c23113261'::uuid, p) $$;

do $$
declare
  org uuid := '27bfe270-5dea-4587-aec3-0f5c23113261';
  owner_id uuid := '82f009ce-9248-4550-b030-896746ef2e73';
  hradmin_id uuid := pg_temp.sid('user:hradmin@flowza.ai');
  hruser_id uuid := pg_temp.sid('user:hruser@flowza.ai');
  attadmin_id uuid := pg_temp.sid('user:attadmin@flowza.ai');
  tz text := 'Asia/Muscat';
  yday date := (now() at time zone 'Asia/Muscat')::date - 1;
begin
  insert into public.notifications (id, organization_id, user_id, category, type, title, body, data, link, read_at, created_at)
  values
    (pg_temp.sid('notif:nzw-offline'), org, attadmin_id, 'DEVICE', 'device.offline', 'Device offline: Nizwa Branch Terminal (NZW-D01)',
      'No heartbeat for more than 30 minutes. Last seen ' || to_char(now() - interval '26 hours', 'DD Mon HH24:MI') || '.', jsonb_build_object('deviceCode', 'NZW-D01', 'branch', 'NZW'), '/devices', null, now() - interval '25 hours 30 minutes'),
    (pg_temp.sid('notif:nzw-offline-owner'), org, owner_id, 'DEVICE', 'device.offline', 'Device offline: Nizwa Branch Terminal (NZW-D01)',
      'No heartbeat for more than 30 minutes.', jsonb_build_object('deviceCode', 'NZW-D01', 'branch', 'NZW'), '/devices', now() - interval '20 hours', now() - interval '25 hours 30 minutes'),
    (pg_temp.sid('notif:approvals-hr'), org, hradmin_id, 'APPROVAL', 'approval.pending', 'Correction awaiting your approval',
      'Two punch-out corrections are waiting for the HR step.', jsonb_build_object('count', 2), '/approvals', null, ((yday) + time '09:12') at time zone tz),
    (pg_temp.sid('notif:report-owner'), org, owner_id, 'SYSTEM', 'report.ready', 'Monthly Attendance Report is ready',
      'August 2026 · all branches · PDF', jsonb_build_object('reportType', 'monthly_attendance', 'format', 'pdf'), '/reports', ((yday - 3) + time '08:05') at time zone tz, ((yday - 3) + time '08:02') at time zone tz),
    (pg_temp.sid('notif:digest-hr'), org, hradmin_id, 'ATTENDANCE', 'attendance.daily_digest', 'Yesterday at a glance',
      '47 present · 2 absent · 3 late · 1 on leave · 1 missing punch-out', jsonb_build_object('date', yday), '/attendance', null, ((yday + 1) + time '07:30') at time zone tz),
    (pg_temp.sid('notif:welcome-att'), org, attadmin_id, 'SYSTEM', 'system.welcome', 'Welcome to FlowZa Time',
      'Seven terminals are registered. Enrol new joiners from the Devices page.', '{}'::jsonb, '/devices', '2026-02-16 10:00:00+04', '2026-02-16 09:05:00+04')
  on conflict (id) do nothing;

  insert into audit.logs (organization_id, actor_user_id, actor_type, actor_label, action, entity_type, entity_id, branch_id, old_value, new_value, reason, request_id, created_at)
  select org, a.actor, 'USER', a.label, a.action, a.entity_type, a.entity_id, null, a.old_value, a.new_value, a.reason, 'seed-' || left(md5(a.action || a.entity_id), 12), a.at
  from (values
    (owner_id,    'Hamad Al Busaidi',  'organization.updated',   'organization',  org::text,                                        '{"displayName":"Acme Industries"}'::jsonb, '{"displayName":"Majan Gulf","legalName":"Majan Gulf Trading & Contracting LLC"}'::jsonb, 'Company details completed after onboarding', '2026-02-16 09:20:00+04'::timestamptz),
    (owner_id,    'Hamad Al Busaidi',  'leave_type.seeded',      'leave_type',    'defaults',                                       null, '{"created":["AL","CL","SL","EL","SPL","ML","NP","SD"]}'::jsonb, null, '2026-02-16 09:22:00+04'),
    (hradmin_id,  'Fatma Al Balushi',  'employee.imported',      'import_job',    pg_temp.sid('import:2026-02-16')::text,           null, '{"rows":53,"imported":53,"skipped":0,"file":"majan-staff-list-feb2026.xlsx"}'::jsonb, 'Initial staff list from the HR spreadsheet', '2026-02-16 11:45:00+04'),
    (attadmin_id, 'Zainab Al Zadjali', 'device.registered',      'device',        pg_temp.sid('device:MCT-HQ-D01')::text,           null, '{"code":"MCT-HQ-D01","providerKey":"zkteco_push","model":"SpeedFace-V5L"}'::jsonb, null, '2026-02-16 14:10:00+04'),
    (attadmin_id, 'Zainab Al Zadjali', 'device.registered',      'device',        pg_temp.sid('device:MCT-HQ-D02')::text,           null, '{"code":"MCT-HQ-D02","providerKey":"zkteco_push","model":"uFace 800"}'::jsonb, null, '2026-02-16 14:25:00+04'),
    (attadmin_id, 'Zainab Al Zadjali', 'device.registered',      'device',        pg_temp.sid('device:DQM-D01')::text,              null, '{"code":"DQM-D01","providerKey":"zkteco_push","model":"SpeedFace-V4L"}'::jsonb, null, '2026-02-18 10:05:00+04'),
    (hradmin_id,  'Fatma Al Balushi',  'shift.created',          'shift',         pg_temp.sid('shift:OFFICE')::text,                null, '{"code":"OFFICE","startTime":"08:00","endTime":"17:00"}'::jsonb, null, '2026-02-16 12:00:00+04'),
    (hradmin_id,  'Fatma Al Balushi',  'attendance.rule_set_created', 'attendance_rule_set', pg_temp.sid('rules:company')::text,    null, '{"name":"Company standard","graceInMinutes":10,"ramadanMode":{"enabled":true,"from":"2026-02-18","to":"2026-03-19"}}'::jsonb, null, '2026-02-16 12:15:00+04'),
    (hradmin_id,  'Fatma Al Balushi',  'employee.transferred',   'employee',      pg_temp.sid('emp:MG-2003')::text,                 '{"branch":"MCT-HQ"}'::jsonb, '{"branch":"SOH","effectiveFrom":"2026-06-01"}'::jsonb, 'Sales coverage for Al Batinah', '2026-05-28 10:30:00+04'),
    (hradmin_id,  'Fatma Al Balushi',  'employee.exited',        'employee',      pg_temp.sid('emp:MG-1026')::text,                 '{"employmentStatus":"active"}'::jsonb, '{"employmentStatus":"resigned","exitDate":"2026-07-31"}'::jsonb, 'Resignation accepted — relocating', '2026-07-31 16:05:00+04'),
    (hruser_id,   'Aisha Al Rawahi',   'leave.recorded',         'leave_record',  pg_temp.sid('leave:MG-1017:ML:2026-06-01')::text, null, '{"leaveType":"ML","startDate":"2026-06-01","endDate":"2026-09-06"}'::jsonb, null, '2026-04-17 10:15:00+04'),
    (hruser_id,   'Aisha Al Rawahi',   'leave.recorded',         'leave_record',  pg_temp.sid('leave:MG-1015:HJ:2026-05-17')::text, null, '{"leaveType":"HJ","startDate":"2026-05-17","endDate":"2026-05-31"}'::jsonb, null, '2026-03-18 10:15:00+04')
  ) as a(actor, label, action, entity_type, entity_id, old_value, new_value, reason, at)
  where not exists (select 1 from audit.logs l where l.organization_id = org and l.action = a.action and l.entity_id = a.entity_id and l.created_at = a.at);
end $$;

select 'extras' as step,
  (select count(*) from public.notifications where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261') as notifications,
  (select count(*) from audit.logs where organization_id = '27bfe270-5dea-4587-aec3-0f5c23113261') as audit_rows;
