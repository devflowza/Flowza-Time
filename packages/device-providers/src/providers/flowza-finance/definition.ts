import { FINANCE_DEFAULT_BASE_URL, FINANCE_PIN_KEYS, FINANCE_POLL_MINUTES, FINANCE_SYNC_DIRECTIONS, FLOWZA_FINANCE_PROVIDER_KEY } from '@flowza/contracts';
import { defineProvider } from '../../definition.js';

export const FLOWZA_FINANCE_KEY = FLOWZA_FINANCE_PROVIDER_KEY;

/**
 * Flowza Finance connector (docs/integrations/flowza-finance.md). Not a terminal: one virtual device per organisation that
 * (a) PULLS Finance's own punches through the `attendance-export` Edge Function and (b) PUSHES FlowZa Time punches to
 * `attendance-ingest`, both authenticated with the serial + push token of the Finance `attendance_devices` row.
 *
 * Capabilities are deliberately narrow: attendance pull + a status probe. Employees are never pushed to Finance (Finance maps
 * PINs to its own employees), nothing can be restarted, and the connector is not a push protocol — it is polled like a cloud API.
 * Status `beta` / `REPORTED`: the contract is implemented and tested against a mock Finance server; the live round trip against the
 * Finance project is the Prompt-12 verification.
 */
export const FLOWZA_FINANCE_DEFINITION = defineProvider({
  key: FLOWZA_FINANCE_KEY,
  vendor: 'FlowZa',
  name: 'Flowza Finance connector',
  description: 'Attendance connector to Flowza Finance (HR+): pulls Finance punches through attendance-export and pushes FlowZa Time punches to attendance-ingest, authenticated by one Finance virtual device (serial + token).',
  integrationType: 'VENDOR_CLOUD_PULL',
  status: 'beta',
  capabilities: {
    attendancePull: true, attendancePush: false, employeePush: false, employeePull: false, employeeDelete: false,
    fingerprint: false, face: false, card: false, pin: false, deviceStatus: true, remoteRestart: false, webhooks: false, devicePush: false, biometricTemplatePush: false,
  },
  configSchema: {
    fields: [
      { key: 'baseUrl', label: 'Finance functions base URL', type: 'url', required: false, secret: false, default: FINANCE_DEFAULT_BASE_URL, help: 'https://<project>.supabase.co/functions/v1 — attendance-export and attendance-ingest live under it.' },
      { key: 'deviceSerial', label: 'Finance device serial', type: 'text', required: true, secret: false, help: 'Serial of the virtual device registered in Finance (FLOWZA-TIME-<company code>).' },
      { key: 'token', label: 'Finance push token', type: 'password', required: true, secret: true, help: 'Push token shown on the Finance device; whoever holds serial + token can read and write that organisation\'s punches.' },
      { key: 'direction', label: 'Direction', type: 'select', options: [...FINANCE_SYNC_DIRECTIONS], default: 'both', required: false, secret: false },
      { key: 'pinKey', label: 'Employee identity sent as PIN', type: 'select', options: [...FINANCE_PIN_KEYS], default: 'employee_number', required: false, secret: false, help: 'Finance maps PIN = employee number unless a PIN mapping says otherwise.' },
      { key: 'pollMinutes', label: 'Poll interval (min)', type: 'number', default: FINANCE_POLL_MINUTES.default, required: false, secret: false, help: '5–60 minutes between pulls and pushes.' },
    ],
  },
  throttling: { maxConcurrentPerDevice: 1, maxConcurrentPerAccount: 2, requestsPerMinute: 60 },
  verificationStatus: 'REPORTED',
});
