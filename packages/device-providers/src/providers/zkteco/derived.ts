import { defineProvider } from '../../definition.js';
import type { DevicePushProtocolHandler, ProviderDefinition } from '../../types.js';
import { ZKTecoPushProvider } from './provider.js';

/**
 * ZKTeco-derived brands (docs/device-integrations.md §2.5, §2.6). eSSL and FingerTec terminals carry ZKTeco's PUSH/ADMS
 * ("iclock") firmware, so they run on exactly the same code path as `zkteco_push`: the shared `iclock` handler parses what
 * the device posts, and employee/restart operations are queued as the same protocol commands. They are `beta` for the same
 * reason `zkteco_push` is: implemented and tested end to end against recorded protocol traffic, awaiting the hardware
 * checklist (§6.6). FingerTec stays `UNVERIFIED`: which FingerTec firmware pushes iclock directly (vs AWDMS middleware) is
 * not yet captured.
 */
const ICLOCK_CAPABILITIES = {
  attendancePull: false, attendancePush: true, employeePush: true, employeePull: true, employeeDelete: true,
  fingerprint: true, face: true, card: true, pin: true, deviceStatus: true, remoteRestart: true, webhooks: false, devicePush: true, biometricTemplatePush: false,
} as const;

export const ESSL_PUSH_DEFINITION = defineProvider({
  key: 'essl_push', vendor: 'eSSL', name: 'eSSL devices (PUSH/ADMS-compatible)',
  description: 'eSSL terminals (X990, K90 Pro, MB160, F22, AI-Face series) are ZKTeco-derived and speak the same ADMS/iclock push protocol: set the device\'s Cloud Server / ADMS address to the FlowZa push URL. Attendance arrives in real time; employees are pushed as queued commands.',
  integrationType: 'DEVICE_PUSH', status: 'beta',
  capabilities: ICLOCK_CAPABILITIES,
  configSchema: { fields: [
    { key: 'serialNumber', label: 'Device serial number', type: 'text', required: true, secret: false },
    { key: 'commKey', label: 'Comm key (device menu)', type: 'password', secret: true, required: false },
    { key: 'pushInterval', label: 'Push interval (s)', type: 'number', default: 30, required: false, secret: false },
  ] },
  throttling: { maxConcurrentPerDevice: 1 }, verificationStatus: 'REPORTED', docsUrl: 'https://esslsecurity.com',
});

export const FINGERTEC_PUSH_DEFINITION = defineProvider({
  key: 'fingertec_push', vendor: 'FingerTec', name: 'FingerTec devices (Webster/PUSH-compatible)',
  description: 'FingerTec terminals with ZKTeco-derived push firmware (Webster/ADMS server setting): point the device at the FlowZa push URL. Attendance arrives in real time; employees are pushed as queued commands. Models that only talk to AWDMS middleware are not covered.',
  integrationType: 'DEVICE_PUSH', status: 'beta',
  capabilities: ICLOCK_CAPABILITIES,
  configSchema: { fields: [
    { key: 'serialNumber', label: 'Device serial number', type: 'text', required: true, secret: false },
    { key: 'pushInterval', label: 'Push interval (s)', type: 'number', default: 30, required: false, secret: false },
  ] },
  throttling: { maxConcurrentPerDevice: 1 }, verificationStatus: 'UNVERIFIED', docsUrl: 'https://www.fingertec.com',
});

/** Options for ZKTeco-derived brands: share the `protocol` instance so the registry sees one iclock handler. */
export interface DerivedPushOptions { clock?: () => Date; protocol?: DevicePushProtocolHandler }

function derived(definition: ProviderDefinition, options: DerivedPushOptions): ConstructorParameters<typeof ZKTecoPushProvider>[0] {
  return { definition, mode: 'beta', ...(options.clock ? { clock: options.clock } : {}), ...(options.protocol ? { protocol: options.protocol } : {}) };
}

export class EsslPushProvider extends ZKTecoPushProvider { constructor(options: DerivedPushOptions = {}) { super(derived(ESSL_PUSH_DEFINITION, options)); } }
export class FingerTecPushProvider extends ZKTecoPushProvider { constructor(options: DerivedPushOptions = {}) { super(derived(FINGERTEC_PUSH_DEFINITION, options)); } }
