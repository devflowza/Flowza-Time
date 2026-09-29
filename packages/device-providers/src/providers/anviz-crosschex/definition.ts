import { defineProvider } from '../../definition.js';

export const ANVIZ_CROSSCHEX_CLOUD_KEY = 'anviz_crosschex_cloud';
/** CrossChex Cloud only runs these regional API hosts (`https://api.{region}.crosschexcloud.com/`) — there is no Middle East region. */
export const ANVIZ_CROSSCHEX_REGIONS = ['us', 'eu', 'ap'] as const;
export type AnvizCrossChexRegion = (typeof ANVIZ_CROSSCHEX_REGIONS)[number];

/**
 * Anviz CrossChex Cloud Open API (docs/device-integrations.md §2.4, research level REPORTED_SECONDARY). One "device" row = one
 * CrossChex Cloud company account (optionally narrowed to one terminal serial); the terminals themselves talk to Anviz's cloud.
 *
 * Capabilities follow the research correction (§3 drift list item 1, §8 item 4) and what this adapter actually implements:
 *  - attendancePull: `attendance.record/getrecord` time-window pull — the only operation the research documents.
 *  - employeePush / employeePull / employeeDelete: FALSE — employee endpoints are UNKNOWN (community threads only).
 *  - deviceStatus: FALSE — no documented device endpoint, so terminal liveness cannot be observed through the API.
 *  - webhooks: FALSE — the webhook feature is reported but its payload/signature/retry contract is UNKNOWN and no handler exists.
 *  - card / pin / fingerprint / face: FALSE — nothing is enrolled through this API.
 * Status `beta` / `REPORTED`: implemented and tested against an in-process mock faithful to the reported contract; awaiting a live
 * CrossChex Cloud account (developer mode) to confirm paging, token lifetime and error types.
 */
export const ANVIZ_CROSSCHEX_CLOUD_DEFINITION = defineProvider({
  key: ANVIZ_CROSSCHEX_CLOUD_KEY,
  vendor: 'Anviz',
  name: 'Anviz CrossChex Cloud API',
  description: 'Pulls attendance records from a CrossChex Cloud account (Open API, api_key + api_secret → token, us/eu/ap regions). Employees, device status and webhooks are not available through the documented API.',
  integrationType: 'VENDOR_CLOUD_PULL',
  status: 'beta',
  capabilities: {
    attendancePull: true, attendancePush: false, employeePush: false, employeePull: false, employeeDelete: false,
    fingerprint: false, face: false, card: false, pin: false, deviceStatus: false, remoteRestart: false, webhooks: false, devicePush: false, biometricTemplatePush: false,
  },
  configSchema: {
    fields: [
      { key: 'apiKey', label: 'API key', type: 'text', required: true, secret: false, help: 'CrossChex Cloud → System → Developer mode → API key' },
      { key: 'apiSecret', label: 'API secret', type: 'password', required: true, secret: true, help: 'Shown once when developer mode is enabled; stored encrypted' },
      { key: 'region', label: 'Region', type: 'select', options: [...ANVIZ_CROSSCHEX_REGIONS], default: 'us', required: false, secret: false, help: 'Data centre of the CrossChex Cloud account (api.<region>.crosschexcloud.com)' },
      { key: 'deviceSerial', label: 'Device serial (optional)', type: 'text', required: false, secret: false, help: 'Only import records from this terminal serial; leave empty for every terminal of the account' },
    ],
  },
  throttling: { maxConcurrentPerAccount: 2, requestsPerMinute: 60 },
  verificationStatus: 'REPORTED',
  docsUrl: 'https://www.anviz.com',
});
