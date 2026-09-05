import { defineProvider } from '../../definition.js';

export const ZKTECO_PUSH_KEY = 'zkteco_push';

export const ZKTECO_PUSH_DEFINITION = defineProvider({
  key: ZKTECO_PUSH_KEY,
  vendor: 'ZKTeco',
  name: 'ZKTeco PUSH / ADMS protocol',
  description: 'Device-initiated HTTP push protocol (ADMS / "Cloud Server Setting" on the device). The device posts attendance to FlowZa and polls for user commands.',
  integrationType: 'DEVICE_PUSH',
  status: 'beta',
  capabilities: {
    attendancePull: false, attendancePush: true, employeePush: true, employeePull: true, employeeDelete: true,
    fingerprint: true, face: true, card: true, pin: true, deviceStatus: true, remoteRestart: true, webhooks: false, devicePush: true, biometricTemplatePush: false,
  },
  configSchema: {
    fields: [
      { key: 'serialNumber', label: 'Device serial number', type: 'text', required: true, secret: false },
      { key: 'commKey', label: 'Comm key (device menu)', type: 'password', secret: true, required: false },
      { key: 'pushInterval', label: 'Push interval (s)', type: 'number', default: 30, required: false, secret: false },
    ],
  },
  throttling: { maxConcurrentPerDevice: 1 },
  verificationStatus: 'REPORTED',
  docsUrl: 'https://www.zkteco.com',
});
