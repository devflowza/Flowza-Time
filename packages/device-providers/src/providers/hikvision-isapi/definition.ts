import { defineProvider } from '../../definition.js';

export const HIKVISION_ISAPI_KEY = 'hikvision_isapi';

/**
 * Hikvision access-control / face terminals (MinMoe DS-K1T3xx/6xx, DS-K1A …) driven directly over their ISAPI HTTP API with
 * HTTP Digest (docs/device-integrations.md §2.2, part (b) of the recommended hybrid): the worker pulls events through
 * `AccessControl/AcsEvent` (keyed on the device's own event `serialNo`) and manages users through `AccessControl/UserInfo`.
 * The complement of `hikvision_push` (the device posting events to FlowZa); a site can use both.
 *
 * Reachability: the worker calls the terminal, so the device URL must be an https endpoint the egress guard accepts (public host
 * with a trusted certificate, e.g. behind a reverse proxy / VPN gateway). Terminals ship with self-signed certificates.
 *
 * Capabilities: `face` / `fingerprint` / `card` describe what the terminal VERIFIES (AcsEvent minor codes map to them); only the
 * card number is enrolled through the API (best-effort) — face pictures and fingerprint templates are never pushed
 * (`biometricTemplatePush: false`), PINs are not managed (`pin: false`), and the `httpHosts` event subscription is not configured
 * by this provider (`webhooks: false`; use `hikvision_push`).
 *
 * Status `beta` / `REPORTED`: implemented against the publicly reported ISAPI shapes and tested end-to-end against an in-process
 * mock terminal (./mock-server.ts); field names, page cap and error sub-codes await a bench terminal.
 */
export const HIKVISION_ISAPI_DEFINITION = defineProvider({
  key: HIKVISION_ISAPI_KEY,
  vendor: 'Hikvision',
  name: 'Hikvision ISAPI (device HTTP API)',
  description: 'Direct device API (HTTP Digest) for Hikvision access-control terminals reachable from the FlowZa worker over https (public address, VPN gateway or reverse proxy). Pulls authentication events through AcsEvent search and manages users (and card numbers) through UserInfo; device info, clock and remote restart through ISAPI System.',
  integrationType: 'LAN',
  status: 'beta',
  capabilities: {
    attendancePull: true, attendancePush: false, employeePush: true, employeePull: true, employeeDelete: true,
    fingerprint: true, face: true, card: true, pin: false, deviceStatus: true, remoteRestart: true, webhooks: false, devicePush: false, biometricTemplatePush: false,
  },
  configSchema: {
    fields: [
      { key: 'baseUrl', label: 'Device URL', type: 'url', required: true, secret: false, help: 'https://<host>[:port] of the terminal\'s web service as seen from FlowZa (public host with a trusted certificate — terminals ship self-signed).' },
      { key: 'username', label: 'Username', type: 'text', required: true, secret: false, help: 'A device user allowed to use ISAPI (admin or an operator with access-control rights).' },
      { key: 'password', label: 'Password', type: 'password', secret: true, required: true, help: 'Terminals lock the account for about 30 minutes after repeated failures: FlowZa never retries a rejected password.' },
    ],
  },
  // One call at a time per terminal (embedded web server); every ISAPI exchange is two HTTP requests (Digest challenge + answer).
  throttling: { maxConcurrentPerDevice: 1, requestsPerMinute: 120 },
  verificationStatus: 'REPORTED',
  docsUrl: 'https://www.hikvision.com/en/support/download/sdk/',
});
