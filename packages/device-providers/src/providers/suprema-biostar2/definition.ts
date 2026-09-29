import { defineProvider } from '../../definition.js';

export const SUPREMA_BIOSTAR2_KEY = 'suprema_biostar2';

/**
 * Suprema BioStar 2 / BioStar X REST API (docs/device-integrations.md §2.3). The "device" is the customer's BioStar server: FlowZa
 * logs in (`POST /api/login` → `bs-session-id`), polls `POST /api/events/search` with an event-id cursor and manages server users
 * (`/api/users`), which BioStar then distributes to its terminals. Optionally restricted to one terminal (`deviceId`).
 *
 * Capabilities are what the documented REST surface lets us prove:
 *  - attendance pull, employee pull/push/delete and a status probe (`GET /api/devices`): official Postman collection;
 *  - fingerprint / face / card / pin: punches made with these credentials are recognised from the event sub-codes (G-SDK event
 *    table). `card` stays false because pushing a card number means creating a BioStar card object of the right type/Wiegand format
 *    (`POST /api/cards`) and assigning it — not modelled; the card number of a pushed employee is reported as not applied;
 *  - no remote restart (no reboot endpoint in the collection), no webhooks (BioStar has none; its WebSocket stream is undocumented),
 *    never biometric templates.
 * Status `beta` / `REPORTED`: implemented and tested against a faithful in-process mock of the documented API; no hardware run yet.
 * TLS: BioStar ships a self-signed certificate. Verification is NEVER disabled — the customer must install a publicly trusted
 * certificate on the BioStar server (or front it with a reverse proxy that has one).
 */
export const SUPREMA_BIOSTAR2_DEFINITION = defineProvider({
  key: SUPREMA_BIOSTAR2_KEY,
  vendor: 'Suprema',
  name: 'Suprema BioStar 2 API',
  description: 'REST API of a customer-hosted BioStar 2 / BioStar X server (session login). Polls authentication events by event id and manages server users, which BioStar distributes to its terminals. Requires an HTTPS address with a publicly trusted certificate.',
  integrationType: 'ON_PREM_SERVER_API',
  status: 'beta',
  capabilities: {
    attendancePull: true, attendancePush: false, employeePush: true, employeePull: true, employeeDelete: true,
    fingerprint: true, face: true, card: false, pin: true, deviceStatus: true, remoteRestart: false, webhooks: false, devicePush: false, biometricTemplatePush: false,
  },
  configSchema: {
    fields: [
      { key: 'baseUrl', label: 'BioStar 2 URL', type: 'url', required: true, secret: false, help: 'https://biostar.example.com[:port] — must present a publicly trusted certificate (the default self-signed one is refused); use a reverse proxy if needed.' },
      { key: 'loginId', label: 'Login ID', type: 'text', required: true, secret: false, help: 'A dedicated BioStar operator for FlowZa (User + Monitoring read, User write). Its sessions are reused; other logins of the same operator may be signed out.' },
      { key: 'password', label: 'Password', type: 'password', required: true, secret: true },
      { key: 'deviceId', label: 'BioStar device ID (optional)', type: 'text', required: false, secret: false, help: 'Restrict events and status to one terminal (the numeric device ID shown in BioStar). Leave empty to read every terminal of the server.' },
    ],
  },
  throttling: { maxConcurrentPerDevice: 1, maxConcurrentPerAccount: 2, requestsPerMinute: 120 },
  verificationStatus: 'REPORTED',
  docsUrl: 'https://github.com/supremainc/docs/tree/main/static/specs',
});
