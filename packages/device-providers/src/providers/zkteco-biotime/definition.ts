import { defineProvider } from '../../definition.js';

export const ZKTECO_BIOTIME_KEY = 'zkteco_biotime';

/** BioTime 8.0 API User Manual (2020-06-15) — the VERIFIED_OFFICIAL_DOC source of every endpoint this adapter calls. */
export const ZKTECO_BIOTIME_DOCS_URL = 'https://s3.ap-southeast-1.amazonaws.com/zkteco.co.th/files/20230917/BioTime%208.0%20API%20User%20Manual-20200615.pdf';

/**
 * ZKTeco ZKBio Time / BioTime REST API (docs/device-integrations.md §2.1). One FlowZa device = one customer-hosted BioTime server
 * (optionally narrowed to ONE terminal with `terminalSn`). Everything used is in the BioTime 8.0 API manual: token login
 * (`/jwt-api-token-auth/`, fallback `/api-token-auth/`), `/iclock/api/transactions/`, `/iclock/api/terminals/` and
 * `/personnel/api/employees/`. The manual documents no restart command, no template endpoint and no webhooks, so those stay false.
 * Status `beta` / `REPORTED`: implemented and tested against a faithful mock server; awaiting a live 8.x / 9.x server.
 */
export const ZKTECO_BIOTIME_DEFINITION = defineProvider({
  key: ZKTECO_BIOTIME_KEY,
  vendor: 'ZKTeco',
  name: 'ZKBio Time / BioTime REST API',
  description: 'Pulls attendance transactions and manages employees through a customer-hosted ZKBio Time / BioTime server (JWT or token login). The server must be reachable over https; BioTime 9.x reportedly needs the API licence.',
  integrationType: 'ON_PREM_SERVER_API',
  status: 'beta',
  capabilities: {
    attendancePull: true, attendancePush: false, employeePush: true, employeePull: true, employeeDelete: true,
    fingerprint: false, face: false, card: true, pin: true, deviceStatus: true, remoteRestart: false, webhooks: false, devicePush: false, biometricTemplatePush: false,
  },
  configSchema: {
    fields: [
      { key: 'baseUrl', label: 'Server URL', type: 'url', required: true, secret: false, help: 'https://biotime.example.com:8090 — the BioTime web server, reachable from FlowZa (public IP, reverse proxy or VPN).' },
      { key: 'username', label: 'Username', type: 'text', required: true, secret: false, help: 'A BioTime system user allowed to use the API (read transactions/terminals, manage employees).' },
      { key: 'password', label: 'Password', type: 'password', required: true, secret: true },
      { key: 'terminalSn', label: 'Terminal serial number', type: 'text', required: false, secret: false, help: 'Optional: only pull punches of this terminal (and report its status). Empty = every terminal on the server.' },
      { key: 'departmentId', label: 'Department id for new employees', type: 'number', required: false, secret: false, help: 'BioTime department id assigned to employees FlowZa creates (required to push new employees).' },
      { key: 'areaId', label: 'Area id for new employees', type: 'number', required: false, secret: false, help: 'BioTime area id assigned to employees FlowZa creates; the area decides which terminals receive them (required to push new employees).' },
      { key: 'pageSize', label: 'Page size', type: 'number', required: false, secret: false, default: 200, help: 'Rows per API page (1–1000).' },
      { key: 'lateArrivalHours', label: 'Late upload window (hours)', type: 'number', required: false, secret: false, default: 24, help: 'Every pull re-reads this many hours before the last scanned time, catching punches terminals upload late (1–168).' },
    ],
  },
  throttling: { maxConcurrentPerDevice: 1, maxConcurrentPerAccount: 2, requestsPerMinute: 120 },
  verificationStatus: 'REPORTED',
  docsUrl: ZKTECO_BIOTIME_DOCS_URL,
});
