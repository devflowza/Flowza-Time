import { defineProvider } from '../../definition.js';

export const MATRIX_COSEC_KEY = 'matrix_cosec';

/**
 * Matrix COSEC door controllers / terminals (ARGO, ARGO FACE, VEGA, DOOR V3/FMX/PVR, ARC DC200) through the documented Device API
 * (DAPI: `https://<controller>/device.cgi/...`, HTTP Basic — Digest on some firmware). docs/device-integrations.md §2.7,
 * REPORTED_SECONDARY: built from the open-source clients (Horilla `biometric/cosec.py`, pycosec) and the PUSH API vocabulary; awaiting
 * hardware. FlowZa polls the controller, so it must be reachable over the LAN/VPN from the worker.
 *
 * Capabilities are what DAPI can actually do: event pull (roll-over-count + seq-No cursor), user set/delete, a clock probe. There is
 * no "list all users" call (only a count), so employeePull is false; reboot is a PUSH-API command only, so remoteRestart is false;
 * fingerprint/face templates are never moved (card number and PIN are pushed with the user).
 */
export const MATRIX_COSEC_DEFINITION = defineProvider({
  key: MATRIX_COSEC_KEY,
  vendor: 'Matrix Comsec',
  name: 'Matrix COSEC device API (device.cgi)',
  description: 'Polls a Matrix COSEC controller/terminal (ARGO, ARGO FACE, VEGA, DOOR series) over its device API (device.cgi): attendance events by sequence number, user create/update/delete with card and PIN, clock check. The controller must be reachable from FlowZa (LAN, VPN or published https). Device user ids must be numeric (1–99999999): they are used as both COSEC user-id and reference user id.',
  integrationType: 'LAN',
  status: 'beta',
  capabilities: {
    attendancePull: true, attendancePush: false, employeePush: true, employeePull: false, employeeDelete: true,
    fingerprint: false, face: false, card: true, pin: true, deviceStatus: true, remoteRestart: false, webhooks: false, devicePush: false, biometricTemplatePush: false,
  },
  configSchema: {
    fields: [
      { key: 'baseUrl', label: 'Controller URL', type: 'url', required: true, secret: false, help: 'https://<controller address>[:port] — the device web server that answers /device.cgi.' },
      { key: 'username', label: 'Device admin username', type: 'text', required: true, secret: false, default: 'admin' },
      { key: 'password', label: 'Device admin password', type: 'password', required: true, secret: true },
    ],
  },
  throttling: { maxConcurrentPerDevice: 1, maxConcurrentPerAccount: 2, requestsPerMinute: 60 },
  verificationStatus: 'REPORTED',
  docsUrl: 'https://www.matrixaccesscontrol.com',
});
