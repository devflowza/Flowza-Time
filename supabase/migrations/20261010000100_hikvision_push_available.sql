-- FlowZa Time · 20261010000100 · Hikvision event push leaves beta
--
-- hikvision_push was seeded as 'beta' (20260929000100) because it had been built from public ISAPI descriptions with no hardware
-- run. A real MinMoe terminal (serial GN6733356, Hikvision test tenant) has since been posting its punches over HTTP Listening to
-- the hosted project, so the provider is promoted to 'available' and the device list stops labelling every Hikvision terminal
-- "Beta". Verification stays REPORTED: the model rows still say "verify per firmware".
--
-- The row is a mirror of packages/device-providers HIKVISION_PUSH_DEFINITION (values generated with definitionToRow);
-- registry.test.ts reads this file after 20260929000200 and pins it. Reference data only; no table DDL.
set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

insert into public.device_providers (key, vendor, name, description, integration_type, status, capabilities, config_schema, throttling, verification_status, docs_url, sort_order) values
  ('hikvision_push', 'Hikvision', 'Hikvision ISAPI event push (HTTP Listening)', 'Real-time push from Hikvision face/card/fingerprint terminals (MinMoe DS-K1T series and other ISAPI access-control devices): the device posts every access-control event to FlowZa over HTTP Listening. No VPN or port forwarding needed. Employees are enrolled on the device with Employee ID = FlowZa device user id.',
    'DEVICE_PUSH', 'available',
    '{"attendancePull":false,"attendancePush":true,"employeePush":false,"employeePull":false,"employeeDelete":false,"fingerprint":true,"face":true,"card":true,"pin":true,"deviceStatus":true,"remoteRestart":false,"webhooks":false,"devicePush":true,"biometricTemplatePush":false}',
    '{"fields":[{"key":"serialNumber","label":"Device serial number","type":"text","required":true,"secret":false,"help":"Printed on the device label and shown under System → Device Information (letters, digits and \"-\" only). It becomes part of the push URL."}]}',
    '{"maxConcurrentPerDevice":1,"maxConcurrentPerAccount":4,"requestsPerMinute":120}', 'REPORTED', 'https://www.hikvision.com/en/support/download/sdk/', 19)
on conflict (key) do update set vendor = excluded.vendor, name = excluded.name, description = excluded.description, integration_type = excluded.integration_type,
  status = excluded.status, capabilities = excluded.capabilities, config_schema = excluded.config_schema, throttling = excluded.throttling,
  verification_status = excluded.verification_status, docs_url = excluded.docs_url, sort_order = excluded.sort_order, updated_at = now();
