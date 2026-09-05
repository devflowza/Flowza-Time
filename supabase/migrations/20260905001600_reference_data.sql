-- FlowZa Time · 1600 · reference data: permissions, system roles, device providers, plans, feature flags
set client_min_messages = warning;

insert into public.permissions (key, category, description, sort_order) values
  ('dashboard.view',            'dashboard',    'View dashboards', 10),
  ('organization.view',         'organization', 'View organisation profile and settings', 20),
  ('organization.manage',       'organization', 'Manage organisation profile, settings, subscription, integrations', 21),
  ('user.view',                 'users',        'View users and memberships', 30),
  ('user.manage',               'users',        'Invite, update, suspend users; assign roles and branches', 31),
  ('role.manage',               'users',        'Create and edit custom roles', 32),
  ('branch.view',               'structure',    'View branches', 40),
  ('branch.manage',             'structure',    'Create and edit branches', 41),
  ('department.view',           'structure',    'View departments, designations and teams', 42),
  ('department.manage',         'structure',    'Manage departments, designations and teams', 43),
  ('employee.view',             'employees',    'View employees', 50),
  ('employee.view_sensitive',   'employees',    'View identity documents and sensitive personal data', 51),
  ('employee.create',           'employees',    'Create employees', 52),
  ('employee.update',           'employees',    'Update employees and employment history', 53),
  ('employee.delete',           'employees',    'Archive/delete employees', 54),
  ('employee.import',           'employees',    'Import employees from files', 55),
  ('employee.export',           'employees',    'Export employee data', 56),
  ('device.view',               'devices',      'View devices, groups, sync jobs and logs', 60),
  ('device.create',             'devices',      'Register devices', 61),
  ('device.update',             'devices',      'Edit device settings', 62),
  ('device.manage',             'devices',      'Manage credentials, groups, disable/decommission devices', 63),
  ('device.sync',               'devices',      'Trigger attendance/employee synchronisation and reconciliation', 64),
  ('shift.view',                'shifts',       'View shifts, patterns and assignments', 70),
  ('shift.manage',              'shifts',       'Create and edit shifts and patterns', 71),
  ('shift.assign',              'shifts',       'Assign shifts to employees, teams, departments, branches', 72),
  ('holiday.view',              'calendar',     'View holidays', 73),
  ('holiday.manage',            'calendar',     'Manage holiday calendars', 74),
  ('leave.view',                'leave',        'View leave records', 75),
  ('leave.manage',              'leave',        'Record and approve leave', 76),
  ('attendance.view',           'attendance',   'View processed attendance', 80),
  ('attendance.view_own',       'attendance',   'View own attendance (self-service)', 81),
  ('attendance.view_raw',       'attendance',   'View raw device transactions', 82),
  ('attendance.correct',        'attendance',   'Submit attendance corrections', 83),
  ('attendance.approve',        'attendance',   'Approve or reject corrections and requests', 84),
  ('attendance.manage_rules',   'attendance',   'Manage attendance rule sets', 85),
  ('attendance.recalculate',    'attendance',   'Trigger attendance recalculation', 86),
  ('attendance.lock_period',    'attendance',   'Lock and unlock attendance periods', 87),
  ('payroll.view',              'payroll',      'View payroll period summaries', 90),
  ('payroll.finalize',          'payroll',      'Finalise payroll periods', 91),
  ('report.view',               'reports',      'Request and download own reports', 100),
  ('report.manage',             'reports',      'View all reports in the organisation', 101),
  ('report.export',             'reports',      'Export reports and data', 102),
  ('audit.view',                'audit',        'View audit logs', 110),
  ('notification.manage',       'notifications','Manage organisation notification settings', 120)
on conflict (key) do update set category = excluded.category, description = excluded.description, sort_order = excluded.sort_order;

-- System roles (organization_id null). Organisations may clone them into custom roles.
insert into public.roles (id, organization_id, key, name, description, is_system) values
  ('10000000-0000-0000-0000-000000000001', null, 'owner',            'Organisation Owner',  'Full access to the organisation', true),
  ('10000000-0000-0000-0000-000000000002', null, 'org_admin',        'Organisation Admin',  'Administers users, settings, devices and HR data', true),
  ('10000000-0000-0000-0000-000000000003', null, 'hr_admin',         'HR Admin',            'Manages employees, shifts, attendance and reports', true),
  ('10000000-0000-0000-0000-000000000004', null, 'hr_user',          'HR User',             'Day-to-day HR operations without destructive rights', true),
  ('10000000-0000-0000-0000-000000000005', null, 'branch_manager',   'Branch Manager',      'Manages attendance for assigned branches only', true),
  ('10000000-0000-0000-0000-000000000006', null, 'attendance_admin', 'Attendance Admin',    'Manages devices, synchronisation and attendance rules', true),
  ('10000000-0000-0000-0000-000000000007', null, 'payroll',          'Payroll / Finance',   'Read-only attendance and payroll summaries', true),
  ('10000000-0000-0000-0000-000000000008', null, 'employee',         'Employee',            'Self-service access to own attendance', true)
on conflict (id) do update set name = excluded.name, description = excluded.description;

-- owner: everything
insert into public.role_permissions (role_id, permission_key) select '10000000-0000-0000-0000-000000000001', key from public.permissions on conflict do nothing;
-- org_admin: everything except payroll.finalize
insert into public.role_permissions (role_id, permission_key) select '10000000-0000-0000-0000-000000000002', key from public.permissions where key not in ('payroll.finalize') on conflict do nothing;
-- hr_admin
insert into public.role_permissions (role_id, permission_key) select '10000000-0000-0000-0000-000000000003', unnest(array[
  'dashboard.view','organization.view','user.view','branch.view','department.view','department.manage',
  'employee.view','employee.view_sensitive','employee.create','employee.update','employee.delete','employee.import','employee.export',
  'device.view','device.sync','shift.view','shift.manage','shift.assign','holiday.view','holiday.manage','leave.view','leave.manage',
  'attendance.view','attendance.view_raw','attendance.correct','attendance.approve','attendance.manage_rules','attendance.recalculate','attendance.lock_period',
  'payroll.view','report.view','report.manage','report.export','audit.view']) on conflict do nothing;
-- hr_user
insert into public.role_permissions (role_id, permission_key) select '10000000-0000-0000-0000-000000000004', unnest(array[
  'dashboard.view','organization.view','branch.view','department.view','employee.view','employee.create','employee.update','employee.import',
  'device.view','device.sync','shift.view','shift.assign','holiday.view','leave.view','leave.manage',
  'attendance.view','attendance.correct','report.view','report.export']) on conflict do nothing;
-- branch_manager (branch scope applied through membership)
insert into public.role_permissions (role_id, permission_key) select '10000000-0000-0000-0000-000000000005', unnest(array[
  'dashboard.view','organization.view','branch.view','department.view','employee.view','employee.update','device.view','device.sync',
  'shift.view','shift.assign','holiday.view','leave.view','leave.manage','attendance.view','attendance.correct','attendance.approve','report.view','report.export']) on conflict do nothing;
-- attendance_admin
insert into public.role_permissions (role_id, permission_key) select '10000000-0000-0000-0000-000000000006', unnest(array[
  'dashboard.view','organization.view','branch.view','department.view','employee.view','employee.update',
  'device.view','device.create','device.update','device.manage','device.sync','shift.view','shift.manage','shift.assign','holiday.view','holiday.manage',
  'attendance.view','attendance.view_raw','attendance.correct','attendance.approve','attendance.manage_rules','attendance.recalculate','report.view','report.export','audit.view']) on conflict do nothing;
-- payroll
insert into public.role_permissions (role_id, permission_key) select '10000000-0000-0000-0000-000000000007', unnest(array[
  'dashboard.view','organization.view','branch.view','department.view','employee.view','shift.view','holiday.view','leave.view',
  'attendance.view','payroll.view','payroll.finalize','report.view','report.export']) on conflict do nothing;
-- employee (self-service; row visibility comes from own_employee_ids)
insert into public.role_permissions (role_id, permission_key) select '10000000-0000-0000-0000-000000000008', unnest(array['attendance.view_own','holiday.view']) on conflict do nothing;

-- Device providers: mirror of packages/device-providers registry. Capabilities are declared per provider
-- and marked with a verification status; placeholder providers refuse to operate (§135).
insert into public.device_providers (key, vendor, name, description, integration_type, status, capabilities, config_schema, throttling, verification_status, docs_url, sort_order) values
  ('mock', 'FlowZa', 'Mock device (simulator)', 'Simulated device for development and tests. Supports every capability and can inject latency, failures, duplicates and offline periods.',
    'VENDOR_CLOUD_PULL', 'available',
    '{"attendancePull":true,"attendancePush":false,"employeePush":true,"employeePull":true,"employeeDelete":true,"fingerprint":true,"face":true,"card":true,"pin":true,"deviceStatus":true,"remoteRestart":true,"webhooks":true,"devicePush":true,"biometricTemplatePush":false}',
    '{"fields":[{"key":"scenario","label":"Scenario","type":"select","required":true,"secret":false,"options":["healthy","flaky","offline","slow","duplicates","unknown_employees","large_batches","auth_failed","rate_limited"],"default":"healthy"},{"key":"employeeCount","label":"Simulated employees","type":"number","required":false,"secret":false,"default":25},{"key":"seed","label":"Random seed","type":"number","required":false,"secret":false,"default":42,"help":"Same seed + config = same transaction stream."},{"key":"transactionsPerEmployeePerDay","label":"Punches per employee per day","type":"number","required":false,"secret":false,"default":0,"help":"0 = deterministic mix of 2–4 punches."},{"key":"startDate","label":"Stream start date (YYYY-MM-DD)","type":"text","required":false,"secret":false,"help":"Defaults to 30 days before the first pull. The sync cursor pins the start date it was created with; rewind the cursor to re-anchor."},{"key":"latencyMs","label":"Latency (ms, \"slow\" scenario)","type":"number","required":false,"secret":false,"default":2000},{"key":"apiKey","label":"API key (simulated)","type":"password","required":false,"secret":true,"help":"Must be \"valid\" in the auth_failed scenario."},{"key":"webhookSecret","label":"Webhook signing secret (simulated)","type":"password","required":false,"secret":true}]}',
    '{"maxConcurrentPerDevice":1,"maxConcurrentPerAccount":10,"requestsPerMinute":600}', 'VERIFIED', null, 1),
  ('zkteco_push', 'ZKTeco', 'ZKTeco PUSH / ADMS protocol', 'Device-initiated HTTP push protocol (ADMS / "Cloud Server Setting" on the device). The device posts attendance to FlowZa and polls for user commands.',
    'DEVICE_PUSH', 'beta',
    '{"attendancePull":false,"attendancePush":true,"employeePush":true,"employeePull":true,"employeeDelete":true,"fingerprint":true,"face":true,"card":true,"pin":true,"deviceStatus":true,"remoteRestart":true,"webhooks":false,"devicePush":true,"biometricTemplatePush":false}',
    '{"fields":[{"key":"serialNumber","label":"Device serial number","type":"text","required":true},{"key":"commKey","label":"Comm key (device menu)","type":"password","secret":true,"required":false},{"key":"pushInterval","label":"Push interval (s)","type":"number","default":30}]}',
    '{"maxConcurrentPerDevice":1}', 'REPORTED', 'https://www.zkteco.com', 10),
  ('zkteco_biotime', 'ZKTeco', 'ZKBio Time / BioTime REST API', 'Pull attendance transactions and manage employees through a customer-hosted ZKBio Time server (token auth).',
    'ON_PREM_SERVER_API', 'placeholder',
    '{"attendancePull":true,"employeePush":true,"employeePull":true,"employeeDelete":true,"fingerprint":false,"face":false,"card":true,"pin":true,"deviceStatus":true,"remoteRestart":false,"webhooks":false,"devicePush":false,"biometricTemplatePush":false}',
    '{"fields":[{"key":"baseUrl","label":"Server URL","type":"url","required":true},{"key":"username","label":"Username","type":"text","required":true},{"key":"password","label":"Password","type":"password","secret":true,"required":true}]}',
    '{"maxConcurrentPerAccount":2,"requestsPerMinute":120}', 'REPORTED', 'https://www.zkteco.com', 11),
  ('hikvision_isapi', 'Hikvision', 'Hikvision ISAPI (device HTTP API)', 'Direct device API (digest auth) for access-control terminals reachable from the worker (VPN/public IP). Events via AcsEvent search; users via UserInfo.',
    'LAN', 'placeholder',
    '{"attendancePull":true,"employeePush":true,"employeePull":true,"employeeDelete":true,"fingerprint":true,"face":true,"card":true,"pin":false,"deviceStatus":true,"remoteRestart":true,"webhooks":true,"devicePush":false,"biometricTemplatePush":true}',
    '{"fields":[{"key":"baseUrl","label":"Device URL","type":"url","required":true},{"key":"username","label":"Username","type":"text","required":true},{"key":"password","label":"Password","type":"password","secret":true,"required":true}]}',
    '{"maxConcurrentPerDevice":1,"requestsPerMinute":60}', 'REPORTED', 'https://www.hikvision.com/en/support/download/sdk/', 20),
  ('hikvision_hpp', 'Hikvision', 'Hik-Partner Pro OpenAPI', 'Vendor-cloud API for Hik-Connect/Hik-Partner Pro managed devices (partner credentials required).',
    'VENDOR_CLOUD_PULL', 'placeholder',
    '{"attendancePull":true,"employeePush":false,"employeePull":false,"employeeDelete":false,"deviceStatus":true,"webhooks":true,"devicePush":false}',
    '{"fields":[{"key":"appKey","label":"App key","type":"text","required":true},{"key":"appSecret","label":"App secret","type":"password","secret":true,"required":true},{"key":"region","label":"Region","type":"select","options":["global","eu","us","sg"],"default":"global"}]}',
    '{"maxConcurrentPerAccount":2,"requestsPerMinute":60}', 'UNVERIFIED', 'https://www.hikvision.com', 21),
  ('suprema_biostar2', 'Suprema', 'Suprema BioStar 2 API', 'REST API of a customer-hosted BioStar 2 server (session login). Events and users are managed through the server.',
    'ON_PREM_SERVER_API', 'placeholder',
    '{"attendancePull":true,"employeePush":true,"employeePull":true,"employeeDelete":true,"fingerprint":true,"face":true,"card":true,"pin":true,"deviceStatus":true,"remoteRestart":false,"webhooks":false,"devicePush":false,"biometricTemplatePush":true}',
    '{"fields":[{"key":"baseUrl","label":"BioStar 2 URL","type":"url","required":true},{"key":"loginId","label":"Login ID","type":"text","required":true},{"key":"password","label":"Password","type":"password","secret":true,"required":true}]}',
    '{"maxConcurrentPerAccount":2,"requestsPerMinute":120}', 'REPORTED', 'https://www.supremainc.com', 30),
  ('anviz_crosschex_cloud', 'Anviz', 'Anviz CrossChex Cloud API', 'Vendor-cloud API (OAuth-style token) for CrossChex Cloud / Anviz One managed devices.',
    'VENDOR_CLOUD_PULL', 'placeholder',
    '{"attendancePull":true,"employeePush":true,"employeePull":true,"employeeDelete":true,"fingerprint":false,"face":false,"card":true,"pin":true,"deviceStatus":true,"remoteRestart":false,"webhooks":false,"devicePush":false,"biometricTemplatePush":false}',
    '{"fields":[{"key":"apiKey","label":"API key","type":"text","required":true},{"key":"apiSecret","label":"API secret","type":"password","secret":true,"required":true},{"key":"region","label":"Region","type":"select","options":["global","eu","us","cn"],"default":"global"}]}',
    '{"maxConcurrentPerAccount":2,"requestsPerMinute":60}', 'REPORTED', 'https://www.anviz.com', 40),
  ('essl_push', 'eSSL', 'eSSL devices (PUSH/ADMS-compatible)', 'eSSL terminals are ZKTeco-derived and speak the same device push protocol; handled by the ZKTeco PUSH protocol handler with an eSSL profile.',
    'DEVICE_PUSH', 'placeholder',
    '{"attendancePush":true,"employeePush":true,"employeePull":true,"employeeDelete":true,"fingerprint":true,"face":true,"card":true,"deviceStatus":true,"devicePush":true}',
    '{"fields":[{"key":"serialNumber","label":"Device serial number","type":"text","required":true},{"key":"commKey","label":"Comm key","type":"password","secret":true,"required":false}]}',
    '{"maxConcurrentPerDevice":1}', 'UNVERIFIED', 'https://esslsecurity.com', 50),
  ('fingertec_push', 'FingerTec', 'FingerTec devices (Webster/PUSH-compatible)', 'FingerTec terminals use a ZKTeco-derived push protocol (Webster). Requires hardware verification.',
    'DEVICE_PUSH', 'placeholder',
    '{"attendancePush":true,"employeePush":true,"employeePull":true,"employeeDelete":true,"fingerprint":true,"face":true,"card":true,"deviceStatus":true,"devicePush":true}',
    '{"fields":[{"key":"serialNumber","label":"Device serial number","type":"text","required":true}]}',
    '{"maxConcurrentPerDevice":1}', 'UNVERIFIED', 'https://www.fingertec.com', 60),
  ('matrix_cosec', 'Matrix Comsec', 'Matrix COSEC (CENTRA/VYOM API)', 'Integration through the COSEC server API. Requires Matrix API documentation/licence.',
    'ON_PREM_SERVER_API', 'placeholder',
    '{"attendancePull":true,"employeePush":true,"employeePull":true,"employeeDelete":true,"deviceStatus":true}',
    '{"fields":[{"key":"baseUrl","label":"COSEC server URL","type":"url","required":true},{"key":"username","label":"Username","type":"text","required":true},{"key":"password","label":"Password","type":"password","secret":true,"required":true}]}',
    '{"maxConcurrentPerAccount":2}', 'UNVERIFIED', 'https://www.matrixaccesscontrol.com', 70),
  ('nitgen', 'NITGEN', 'NITGEN (access manager / SDK)', 'Integration through NITGEN server software or SDK. Requires vendor documentation.',
    'ON_PREM_SERVER_API', 'placeholder',
    '{"attendancePull":true,"employeePush":true,"employeePull":true,"deviceStatus":true}',
    '{"fields":[{"key":"baseUrl","label":"Server URL","type":"url","required":true},{"key":"apiKey","label":"API key","type":"password","secret":true,"required":true}]}',
    '{"maxConcurrentPerAccount":2}', 'UNVERIFIED', 'https://www.nitgen.com', 80)
on conflict (key) do update set vendor = excluded.vendor, name = excluded.name, description = excluded.description, integration_type = excluded.integration_type,
  status = excluded.status, capabilities = excluded.capabilities, config_schema = excluded.config_schema, throttling = excluded.throttling,
  verification_status = excluded.verification_status, docs_url = excluded.docs_url, sort_order = excluded.sort_order, updated_at = now();

insert into public.device_models (provider_key, vendor, model, family, capabilities, verification, notes) values
  ('mock', 'FlowZa', 'SIM-100', 'Simulator', '{"fingerprint":true,"face":true,"card":true}', 'VERIFIED', 'Simulated fingerprint + face + card terminal'),
  ('mock', 'FlowZa', 'SIM-200-FACE', 'Simulator', '{"fingerprint":false,"face":true,"card":true}', 'VERIFIED', 'Simulated face-only terminal (no fingerprint capability)'),
  ('zkteco_push', 'ZKTeco', 'Generic PUSH-capable terminal', 'ADMS/PUSH firmware', '{"fingerprint":true,"face":true,"card":true}', 'REPORTED', 'Any ZKTeco terminal with PUSH SDK firmware (e.g. F18/F22/K40/MB/uFace/SpeedFace families). Verify per model on hardware.'),
  ('hikvision_isapi', 'Hikvision', 'DS-K1T series (ISAPI)', 'Access control terminals', '{"fingerprint":true,"face":true,"card":true}', 'REPORTED', 'ISAPI AccessControl capability varies by firmware; verify per model.'),
  ('suprema_biostar2', 'Suprema', 'BioStation 2 / 3, BioLite N2, FaceStation 2/F2 (via BioStar 2)', 'BioStar 2 managed', '{"fingerprint":true,"face":true,"card":true}', 'REPORTED', 'Capabilities depend on the device managed by BioStar 2.'),
  ('anviz_crosschex_cloud', 'Anviz', 'CrossChex Cloud managed terminals', 'Cloud managed', '{"fingerprint":true,"face":true,"card":true}', 'REPORTED', 'Cloud-side API only; biometric enrolment happens on device.')
on conflict (provider_key, model) do update set capabilities = excluded.capabilities, verification = excluded.verification, notes = excluded.notes;

insert into public.plans (id, key, name, description, prices, limits, features, sort_order) values
  ('20000000-0000-0000-0000-000000000001', 'trial', 'Trial', '14-day evaluation', '{}', '{"employees":50,"devices":3,"branches":2,"users":5,"storage_mb":512,"api_calls_month":20000,"raw_retention_days":180}', '{"reports_basic"}', 1),
  ('20000000-0000-0000-0000-000000000002', 'starter', 'Starter', 'Small businesses', '{}', '{"employees":100,"devices":5,"branches":3,"users":10,"storage_mb":2048,"api_calls_month":100000,"raw_retention_days":730}', '{"reports_basic","notifications_email"}', 2),
  ('20000000-0000-0000-0000-000000000003', 'business', 'Business', 'Multi-branch organisations', '{}', '{"employees":1000,"devices":50,"branches":25,"users":50,"storage_mb":20480,"api_calls_month":1000000,"raw_retention_days":1095}', '{"reports_basic","reports_advanced","notifications_email","api_access"}', 3),
  ('20000000-0000-0000-0000-000000000004', 'enterprise', 'Enterprise', 'Large organisations, 500+ devices', '{}', '{"employees":100000,"devices":5000,"branches":5000,"users":5000,"storage_mb":1048576,"api_calls_month":100000000,"raw_retention_days":3650}', '{"reports_basic","reports_advanced","notifications_email","api_access","sso","customer_webhooks","payroll_export"}', 4)
on conflict (key) do update set name = excluded.name, description = excluded.description, limits = excluded.limits, features = excluded.features;

insert into public.feature_flags (key, description, default_enabled, rollout_percentage) values
  ('advanced_reports', 'Advanced report types (department/branch comparison, trends)', false, 0),
  ('arabic_ui', 'Arabic (RTL) user interface', true, 100),
  ('provider_hikvision', 'Enable Hikvision providers in the device wizard', false, 0),
  ('provider_suprema', 'Enable Suprema providers in the device wizard', false, 0),
  ('provider_anviz', 'Enable Anviz providers in the device wizard', false, 0),
  ('provider_zkteco_push', 'Enable ZKTeco PUSH protocol provider', true, 100),
  ('payroll_export', 'Payroll period summaries and export', true, 100),
  ('mobile_attendance', 'Mobile/PWA attendance (future)', false, 0),
  ('employee_self_service', 'Employee self-service portal (future)', false, 0),
  ('customer_webhooks', 'Outbound webhooks to customer systems (future)', false, 0),
  ('biometric_template_sync', 'Allow pushing biometric templates between devices (requires legal review)', false, 0)
on conflict (key) do update set description = excluded.description;
