-- FlowZa Time · 20260929000200 · Real device-provider adapters replace seven placeholders
--
-- 1. Provider rows — mirrors of the code definitions in packages/device-providers (generated with definitionToRow; pinned by
--    registry.test.ts). All move from `placeholder` to `beta`: implemented and tested end to end against in-process mocks of the
--    vendor APIs, awaiting hardware / live-server verification (docs/device-integrations.md §4, §6, §7).
--      zkteco_biotime        ZKBio Time / BioTime REST (JWT/token): attendance pull, employees, terminal status
--      hikvision_isapi       Hikvision ISAPI (Digest): AcsEvent pull, UserInfo employees, device info/clock, reboot
--      suprema_biostar2      BioStar 2 REST (session): event pull by id, users, device status
--      anviz_crosschex_cloud CrossChex Cloud Open API: attendance pull only (employee/device APIs are undocumented)
--      essl_push             eSSL terminals on the shared ZKTeco ADMS/iclock push handler
--      fingertec_push        FingerTec terminals on the shared ZKTeco ADMS/iclock push handler
--      matrix_cosec          re-modelled as the COSEC device API (device.cgi, LAN): event pull by sequence, user set/delete
--    hikvision_hpp and nitgen stay honest placeholders (no public API / partner signing).
-- 2. Feature flags releasing the Hikvision ISAPI, BioStar 2 and CrossChex providers: the vendor-wide provider_hikvision /
--    provider_suprema / provider_anviz flags (default OFF) keep hiding anything else of those vendors (Hik-Partner Pro); the API
--    resolves provider flags most-specific-prefix first.
--
-- Additive reference data only; no table DDL. Existing devices keep their rows (none can exist for a placeholder provider: the
-- wizard refused them).
set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

-- 1. providers -------------------------------------------------------------------------------------------------------------------
insert into public.device_providers (key, vendor, name, description, integration_type, status, capabilities, config_schema, throttling, verification_status, docs_url, sort_order) values
  ('zkteco_biotime', 'ZKTeco', 'ZKBio Time / BioTime REST API', 'Pulls attendance transactions and manages employees through a customer-hosted ZKBio Time / BioTime server (JWT or token login). The server must be reachable over https; BioTime 9.x reportedly needs the API licence.',
    'ON_PREM_SERVER_API', 'beta',
    '{"attendancePull":true,"attendancePush":false,"employeePush":true,"employeePull":true,"employeeDelete":true,"fingerprint":false,"face":false,"card":true,"pin":true,"deviceStatus":true,"remoteRestart":false,"webhooks":false,"devicePush":false,"biometricTemplatePush":false}',
    '{"fields":[{"key":"baseUrl","label":"Server URL","type":"url","required":true,"secret":false,"help":"https://biotime.example.com:8090 — the BioTime web server, reachable from FlowZa (public IP, reverse proxy or VPN)."},{"key":"username","label":"Username","type":"text","required":true,"secret":false,"help":"A BioTime system user allowed to use the API (read transactions/terminals, manage employees)."},{"key":"password","label":"Password","type":"password","required":true,"secret":true},{"key":"terminalSn","label":"Terminal serial number","type":"text","required":false,"secret":false,"help":"Optional: only pull punches of this terminal (and report its status). Empty = every terminal on the server."},{"key":"departmentId","label":"Department id for new employees","type":"number","required":false,"secret":false,"help":"BioTime department id assigned to employees FlowZa creates (required to push new employees)."},{"key":"areaId","label":"Area id for new employees","type":"number","required":false,"secret":false,"help":"BioTime area id assigned to employees FlowZa creates; the area decides which terminals receive them (required to push new employees)."},{"key":"pageSize","label":"Page size","type":"number","required":false,"secret":false,"default":200,"help":"Rows per API page (1–1000)."},{"key":"lateArrivalHours","label":"Late upload window (hours)","type":"number","required":false,"secret":false,"default":24,"help":"Every pull re-reads this many hours before the last scanned time, catching punches terminals upload late (1–168)."}]}',
    '{"maxConcurrentPerDevice":1,"maxConcurrentPerAccount":2,"requestsPerMinute":120}', 'REPORTED', 'https://s3.ap-southeast-1.amazonaws.com/zkteco.co.th/files/20230917/BioTime%208.0%20API%20User%20Manual-20200615.pdf', 11),
  ('hikvision_isapi', 'Hikvision', 'Hikvision ISAPI (device HTTP API)', 'Direct device API (HTTP Digest) for Hikvision access-control terminals reachable from the FlowZa worker over https (public address, VPN gateway or reverse proxy). Pulls authentication events through AcsEvent search and manages users (and card numbers) through UserInfo; device info, clock and remote restart through ISAPI System.',
    'LAN', 'beta',
    '{"attendancePull":true,"attendancePush":false,"employeePush":true,"employeePull":true,"employeeDelete":true,"fingerprint":true,"face":true,"card":true,"pin":false,"deviceStatus":true,"remoteRestart":true,"webhooks":false,"devicePush":false,"biometricTemplatePush":false}',
    '{"fields":[{"key":"baseUrl","label":"Device URL","type":"url","required":true,"secret":false,"help":"https://<host>[:port] of the terminal''s web service as seen from FlowZa (public host with a trusted certificate — terminals ship self-signed)."},{"key":"username","label":"Username","type":"text","required":true,"secret":false,"help":"A device user allowed to use ISAPI (admin or an operator with access-control rights)."},{"key":"password","label":"Password","type":"password","required":true,"secret":true,"help":"Terminals lock the account for about 30 minutes after repeated failures: FlowZa never retries a rejected password."}]}',
    '{"maxConcurrentPerDevice":1,"maxConcurrentPerAccount":4,"requestsPerMinute":120}', 'REPORTED', 'https://www.hikvision.com/en/support/download/sdk/', 20),
  ('suprema_biostar2', 'Suprema', 'Suprema BioStar 2 API', 'REST API of a customer-hosted BioStar 2 / BioStar X server (session login). Polls authentication events by event id and manages server users, which BioStar distributes to its terminals. Requires an HTTPS address with a publicly trusted certificate.',
    'ON_PREM_SERVER_API', 'beta',
    '{"attendancePull":true,"attendancePush":false,"employeePush":true,"employeePull":true,"employeeDelete":true,"fingerprint":true,"face":true,"card":false,"pin":true,"deviceStatus":true,"remoteRestart":false,"webhooks":false,"devicePush":false,"biometricTemplatePush":false}',
    '{"fields":[{"key":"baseUrl","label":"BioStar 2 URL","type":"url","required":true,"secret":false,"help":"https://biostar.example.com[:port] — must present a publicly trusted certificate (the default self-signed one is refused); use a reverse proxy if needed."},{"key":"loginId","label":"Login ID","type":"text","required":true,"secret":false,"help":"A dedicated BioStar operator for FlowZa (User + Monitoring read, User write). Its sessions are reused; other logins of the same operator may be signed out."},{"key":"password","label":"Password","type":"password","required":true,"secret":true},{"key":"deviceId","label":"BioStar device ID (optional)","type":"text","required":false,"secret":false,"help":"Restrict events and status to one terminal (the numeric device ID shown in BioStar). Leave empty to read every terminal of the server."}]}',
    '{"maxConcurrentPerDevice":1,"maxConcurrentPerAccount":2,"requestsPerMinute":120}', 'REPORTED', 'https://github.com/supremainc/docs/tree/main/static/specs', 30),
  ('anviz_crosschex_cloud', 'Anviz', 'Anviz CrossChex Cloud API', 'Pulls attendance records from a CrossChex Cloud account (Open API, api_key + api_secret → token, us/eu/ap regions). Employees, device status and webhooks are not available through the documented API.',
    'VENDOR_CLOUD_PULL', 'beta',
    '{"attendancePull":true,"attendancePush":false,"employeePush":false,"employeePull":false,"employeeDelete":false,"fingerprint":false,"face":false,"card":false,"pin":false,"deviceStatus":false,"remoteRestart":false,"webhooks":false,"devicePush":false,"biometricTemplatePush":false}',
    '{"fields":[{"key":"apiKey","label":"API key","type":"text","required":true,"secret":false,"help":"CrossChex Cloud → System → Developer mode → API key"},{"key":"apiSecret","label":"API secret","type":"password","required":true,"secret":true,"help":"Shown once when developer mode is enabled; stored encrypted"},{"key":"region","label":"Region","type":"select","required":false,"secret":false,"options":["us","eu","ap"],"default":"us","help":"Data centre of the CrossChex Cloud account (api.<region>.crosschexcloud.com)"},{"key":"deviceSerial","label":"Device serial (optional)","type":"text","required":false,"secret":false,"help":"Only import records from this terminal serial; leave empty for every terminal of the account"}]}',
    '{"maxConcurrentPerDevice":1,"maxConcurrentPerAccount":2,"requestsPerMinute":60}', 'REPORTED', 'https://www.anviz.com', 40),
  ('essl_push', 'eSSL', 'eSSL devices (PUSH/ADMS-compatible)', 'eSSL terminals (X990, K90 Pro, MB160, F22, AI-Face series) are ZKTeco-derived and speak the same ADMS/iclock push protocol: set the device''s Cloud Server / ADMS address to the FlowZa push URL. Attendance arrives in real time; employees are pushed as queued commands.',
    'DEVICE_PUSH', 'beta',
    '{"attendancePull":false,"attendancePush":true,"employeePush":true,"employeePull":true,"employeeDelete":true,"fingerprint":true,"face":true,"card":true,"pin":true,"deviceStatus":true,"remoteRestart":true,"webhooks":false,"devicePush":true,"biometricTemplatePush":false}',
    '{"fields":[{"key":"serialNumber","label":"Device serial number","type":"text","required":true,"secret":false},{"key":"commKey","label":"Comm key (device menu)","type":"password","required":false,"secret":true},{"key":"pushInterval","label":"Push interval (s)","type":"number","required":false,"secret":false,"default":30}]}',
    '{"maxConcurrentPerDevice":1,"maxConcurrentPerAccount":4,"requestsPerMinute":120}', 'REPORTED', 'https://esslsecurity.com', 50),
  ('fingertec_push', 'FingerTec', 'FingerTec devices (Webster/PUSH-compatible)', 'FingerTec terminals with ZKTeco-derived push firmware (Webster/ADMS server setting): point the device at the FlowZa push URL. Attendance arrives in real time; employees are pushed as queued commands. Models that only talk to AWDMS middleware are not covered.',
    'DEVICE_PUSH', 'beta',
    '{"attendancePull":false,"attendancePush":true,"employeePush":true,"employeePull":true,"employeeDelete":true,"fingerprint":true,"face":true,"card":true,"pin":true,"deviceStatus":true,"remoteRestart":true,"webhooks":false,"devicePush":true,"biometricTemplatePush":false}',
    '{"fields":[{"key":"serialNumber","label":"Device serial number","type":"text","required":true,"secret":false},{"key":"pushInterval","label":"Push interval (s)","type":"number","required":false,"secret":false,"default":30}]}',
    '{"maxConcurrentPerDevice":1,"maxConcurrentPerAccount":4,"requestsPerMinute":120}', 'UNVERIFIED', 'https://www.fingertec.com', 60),
  ('matrix_cosec', 'Matrix Comsec', 'Matrix COSEC device API (device.cgi)', 'Polls a Matrix COSEC controller/terminal (ARGO, ARGO FACE, VEGA, DOOR series) over its device API (device.cgi): attendance events by sequence number, user create/update/delete with card and PIN, clock check. The controller must be reachable from FlowZa (LAN, VPN or published https). Device user ids must be numeric (1–99999999): they are used as both COSEC user-id and reference user id.',
    'LAN', 'beta',
    '{"attendancePull":true,"attendancePush":false,"employeePush":true,"employeePull":false,"employeeDelete":true,"fingerprint":false,"face":false,"card":true,"pin":true,"deviceStatus":true,"remoteRestart":false,"webhooks":false,"devicePush":false,"biometricTemplatePush":false}',
    '{"fields":[{"key":"baseUrl","label":"Controller URL","type":"url","required":true,"secret":false,"help":"https://<controller address>[:port] — the device web server that answers /device.cgi."},{"key":"username","label":"Device admin username","type":"text","required":true,"secret":false,"default":"admin"},{"key":"password","label":"Device admin password","type":"password","required":true,"secret":true}]}',
    '{"maxConcurrentPerDevice":1,"maxConcurrentPerAccount":2,"requestsPerMinute":60}', 'REPORTED', 'https://www.matrixaccesscontrol.com', 70)

on conflict (key) do update set vendor = excluded.vendor, name = excluded.name, description = excluded.description, integration_type = excluded.integration_type,
  status = excluded.status, capabilities = excluded.capabilities, config_schema = excluded.config_schema, throttling = excluded.throttling,
  verification_status = excluded.verification_status, docs_url = excluded.docs_url, sort_order = excluded.sort_order, updated_at = now();

-- 2. feature flags ----------------------------------------------------------------------------------------------------------------
insert into public.feature_flags (key, description, default_enabled, rollout_percentage) values
  ('provider_hikvision_isapi', 'Show the Hikvision ISAPI device-API provider in the device wizard; overrides provider_hikvision for this provider', true, 100),
  ('provider_suprema_biostar2', 'Show the Suprema BioStar 2 API provider in the device wizard; overrides provider_suprema for this provider', true, 100),
  ('provider_anviz_crosschex_cloud', 'Show the Anviz CrossChex Cloud provider in the device wizard; overrides provider_anviz for this provider', true, 100)
on conflict (key) do update set description = excluded.description;
