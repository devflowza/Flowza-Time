-- FlowZa Time · 20260929000100 · Hikvision ISAPI event push provider (MinMoe real-time attendance)
--
-- 1. Provider row hikvision_push — a mirror of packages/device-providers HIKVISION_PUSH_DEFINITION (pinned by registry.test.ts;
--    values generated with definitionToRow). DEVICE_PUSH: the terminal posts every access-control event to
--    /device-push/hikvision/~<push token>/<serial> over "HTTP Listening", so punches arrive in real time with no VPN.
-- 2. Model rows for the MinMoe face terminal families most customers run (REPORTED: verify per firmware on hardware).
-- 3. Feature flag provider_hikvision_push, default ON. The generic provider_hikvision flag (default OFF) keeps hiding the
--    placeholder ISAPI-pull / Hik-Partner Pro providers: the API resolves provider flags most-specific-prefix first.
--
-- Additive reference data only; no table DDL.
set lock_timeout = '5s';
set statement_timeout = '60s';
set client_min_messages = warning;

-- 1. provider -------------------------------------------------------------------------------------------------------------------
insert into public.device_providers (key, vendor, name, description, integration_type, status, capabilities, config_schema, throttling, verification_status, docs_url, sort_order) values
  ('hikvision_push', 'Hikvision', 'Hikvision ISAPI event push (HTTP Listening)', 'Real-time push from Hikvision face/card/fingerprint terminals (MinMoe DS-K1T series and other ISAPI access-control devices): the device posts every access-control event to FlowZa over HTTP Listening. No VPN or port forwarding needed. Employees are enrolled on the device with Employee ID = FlowZa device user id.',
    'DEVICE_PUSH', 'beta',
    '{"attendancePull":false,"attendancePush":true,"employeePush":false,"employeePull":false,"employeeDelete":false,"fingerprint":true,"face":true,"card":true,"pin":true,"deviceStatus":true,"remoteRestart":false,"webhooks":false,"devicePush":true,"biometricTemplatePush":false}',
    '{"fields":[{"key":"serialNumber","label":"Device serial number","type":"text","required":true,"secret":false,"help":"Printed on the device label and shown under System → Device Information (letters, digits and \"-\" only). It becomes part of the push URL."}]}',
    '{"maxConcurrentPerDevice":1,"maxConcurrentPerAccount":4,"requestsPerMinute":120}', 'REPORTED', 'https://www.hikvision.com/en/support/download/sdk/', 19)
on conflict (key) do update set vendor = excluded.vendor, name = excluded.name, description = excluded.description, integration_type = excluded.integration_type,
  status = excluded.status, capabilities = excluded.capabilities, config_schema = excluded.config_schema, throttling = excluded.throttling,
  verification_status = excluded.verification_status, docs_url = excluded.docs_url, sort_order = excluded.sort_order, updated_at = now();

-- 2. models ---------------------------------------------------------------------------------------------------------------------
insert into public.device_models (provider_key, vendor, model, family, capabilities, verification, notes) values
  ('hikvision_push', 'Hikvision', 'MinMoe DS-K1T341 / DS-K1T342 / DS-K1T343 series', 'MinMoe face terminal (value)', '{"fingerprint":true,"face":true,"card":true}', 'REPORTED',
   'Face + card (+ fingerprint on …F/…MF variants). Enable HTTP Listening (Network → Network Service → HTTP(S) Listening), JSON format. Fingerprint depends on the variant.'),
  ('hikvision_push', 'Hikvision', 'MinMoe DS-K1T671 / DS-K1T673 / DS-K1T680 series', 'MinMoe face terminal (pro)', '{"fingerprint":true,"face":true,"card":true}', 'REPORTED',
   'Face + card (+ fingerprint on …F variants), attendance status keys supported. Enable HTTP Listening, JSON format; turn picture upload off to save bandwidth.'),
  ('hikvision_push', 'Hikvision', 'Other ISAPI access-control terminal (DS-K1T/DS-K1A)', 'Access control terminal', '{"fingerprint":true,"face":true,"card":true}', 'REPORTED',
   'Any Hikvision access-control terminal whose web UI offers HTTP Listening / HTTP host notification. Verify per model and firmware.')
on conflict (provider_key, model) do update set family = excluded.family, capabilities = excluded.capabilities, verification = excluded.verification, notes = excluded.notes;

-- 3. feature flag -----------------------------------------------------------------------------------------------------------------
insert into public.feature_flags (key, description, default_enabled, rollout_percentage) values
  ('provider_hikvision_push', 'Show the Hikvision event-push (HTTP Listening) provider in the device wizard; overrides provider_hikvision for this provider', true, 100)
on conflict (key) do update set description = excluded.description;
