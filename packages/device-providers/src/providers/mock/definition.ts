import { defineProvider } from '../../definition.js';

export const MOCK_SCENARIOS = ['healthy', 'flaky', 'offline', 'slow', 'duplicates', 'unknown_employees', 'large_batches', 'auth_failed', 'rate_limited'] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

export const MOCK_PROVIDER_KEY = 'mock';

export const MOCK_DEFINITION = defineProvider({
  key: MOCK_PROVIDER_KEY,
  vendor: 'FlowZa',
  name: 'Mock device (simulator)',
  description: 'Simulated device for development and tests. Supports every capability and can inject latency, failures, duplicates and offline periods.',
  integrationType: 'VENDOR_CLOUD_PULL',
  status: 'available',
  capabilities: {
    attendancePull: true, attendancePush: false, employeePush: true, employeePull: true, employeeDelete: true,
    fingerprint: true, face: true, card: true, pin: true, deviceStatus: true, remoteRestart: true, webhooks: true, devicePush: true, biometricTemplatePush: false,
  },
  configSchema: {
    fields: [
      { key: 'scenario', label: 'Scenario', type: 'select', options: [...MOCK_SCENARIOS], default: 'healthy', required: true, secret: false },
      { key: 'employeeCount', label: 'Simulated employees', type: 'number', default: 25, required: false, secret: false },
      { key: 'seed', label: 'Random seed', type: 'number', default: 42, required: false, secret: false, help: 'Same seed + config = same transaction stream.' },
      { key: 'transactionsPerEmployeePerDay', label: 'Punches per employee per day', type: 'number', default: 0, required: false, secret: false, help: '0 = deterministic mix of 2–4 punches.' },
      { key: 'startDate', label: 'Stream start date (YYYY-MM-DD)', type: 'text', required: false, secret: false, help: 'Defaults to 30 days before today.' },
      { key: 'latencyMs', label: 'Latency (ms, "slow" scenario)', type: 'number', default: 2000, required: false, secret: false },
      { key: 'apiKey', label: 'API key (simulated)', type: 'password', secret: true, required: false, help: 'Must be "valid" in the auth_failed scenario.' },
      { key: 'webhookSecret', label: 'Webhook signing secret (simulated)', type: 'password', secret: true, required: false },
    ],
  },
  throttling: { maxConcurrentPerDevice: 1, maxConcurrentPerAccount: 10, requestsPerMinute: 600 },
  verificationStatus: 'VERIFIED',
});
