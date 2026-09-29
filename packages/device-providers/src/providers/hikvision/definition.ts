import { defineProvider } from '../../definition.js';

export const HIKVISION_PUSH_KEY = 'hikvision_push';

/**
 * Hikvision access-control / face terminals (MinMoe DS-K1T3xx/6xx/9xx, DS-K1A, DS-K1T8xx …) configured to post their events to
 * FlowZa over ISAPI "HTTP Listening" (a.k.a. HTTP host / alarm server). The device initiates every request, so it works behind
 * NAT without a VPN and punches arrive within seconds. Attendance only: users are enrolled on the device (or Hik-Central) with the
 * Employee ID that matches FlowZa's `device_user_id`; pushing users needs ISAPI calls *to* the device (see `hikvision_isapi`).
 */
export const HIKVISION_PUSH_DEFINITION = defineProvider({
  key: HIKVISION_PUSH_KEY,
  vendor: 'Hikvision',
  name: 'Hikvision ISAPI event push (HTTP Listening)',
  description: 'Real-time push from Hikvision face/card/fingerprint terminals (MinMoe DS-K1T series and other ISAPI access-control devices): the device posts every access-control event to FlowZa over HTTP Listening. No VPN or port forwarding needed. Employees are enrolled on the device with Employee ID = FlowZa device user id.',
  integrationType: 'DEVICE_PUSH',
  status: 'beta',
  capabilities: {
    attendancePull: false, attendancePush: true, employeePush: false, employeePull: false, employeeDelete: false,
    fingerprint: true, face: true, card: true, pin: true, deviceStatus: true, remoteRestart: false, webhooks: false, devicePush: true, biometricTemplatePush: false,
  },
  configSchema: {
    fields: [
      { key: 'serialNumber', label: 'Device serial number', type: 'text', required: true, secret: false, help: 'Printed on the device label and shown under System → Device Information (letters, digits and "-" only). It becomes part of the push URL.' },
    ],
  },
  throttling: { maxConcurrentPerDevice: 1 },
  verificationStatus: 'REPORTED',
  docsUrl: 'https://www.hikvision.com/en/support/download/sdk/',
});
