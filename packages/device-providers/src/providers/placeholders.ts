import type { DeviceCapabilities, DeviceEmployee } from '@flowza/contracts';
import { defineProvider } from '../definition.js';
import { notImplemented } from '../errors.js';
import type { AttendancePullResult, ConnectionResult, DeviceEmployeePage, DeviceInfo, DeviceOperationResult, DeviceProvider, DeviceStatus, PageCursor, ProviderContext, ProviderDefinition, SyncCursor } from '../types.js';
import { ZKTecoPushProvider } from './zkteco/provider.js';

/**
 * Placeholder providers (§135): registered so the wizard can show them with their config schema and documented
 * capabilities, but every operation throws ProviderError('NOT_IMPLEMENTED'). They never fake success.
 * Definitions mirror supabase/migrations/*_reference_data.sql (asserted by registry tests).
 */
export abstract class PlaceholderProvider implements DeviceProvider {
  readonly definition: ProviderDefinition;
  protected constructor(definition: ProviderDefinition) { this.definition = definition; }
  protected fail(): never { throw notImplemented(this.definition.name); }
  async testConnection(_ctx: ProviderContext): Promise<ConnectionResult> { return this.fail(); }
  async getDeviceInfo(_ctx: ProviderContext): Promise<DeviceInfo> { return this.fail(); }
  async getCapabilities(_ctx: ProviderContext): Promise<DeviceCapabilities> { return this.fail(); }
  async getDeviceStatus(_ctx: ProviderContext): Promise<DeviceStatus> { return this.fail(); }
  async pullAttendance(_ctx: ProviderContext, _cursor: SyncCursor | null): Promise<AttendancePullResult> { return this.fail(); }
  async listEmployees(_ctx: ProviderContext, _page: PageCursor): Promise<DeviceEmployeePage> { return this.fail(); }
  async upsertEmployee(_ctx: ProviderContext, _employee: DeviceEmployee): Promise<DeviceOperationResult> { return this.fail(); }
  async deleteEmployee(_ctx: ProviderContext, _deviceUserId: string): Promise<DeviceOperationResult> { return this.fail(); }
}

export const ZKTECO_BIOTIME_DEFINITION = defineProvider({
  key: 'zkteco_biotime', vendor: 'ZKTeco', name: 'ZKBio Time / BioTime REST API',
  description: 'Pull attendance transactions and manage employees through a customer-hosted ZKBio Time server (token auth).',
  integrationType: 'ON_PREM_SERVER_API', status: 'placeholder',
  capabilities: { attendancePull: true, employeePush: true, employeePull: true, employeeDelete: true, fingerprint: false, face: false, card: true, pin: true, deviceStatus: true, remoteRestart: false, webhooks: false, devicePush: false, biometricTemplatePush: false },
  configSchema: { fields: [
    { key: 'baseUrl', label: 'Server URL', type: 'url', required: true, secret: false },
    { key: 'username', label: 'Username', type: 'text', required: true, secret: false },
    { key: 'password', label: 'Password', type: 'password', secret: true, required: true },
  ] },
  throttling: { maxConcurrentPerAccount: 2, requestsPerMinute: 120 }, verificationStatus: 'REPORTED', docsUrl: 'https://www.zkteco.com',
});
export class ZKBioTimeProvider extends PlaceholderProvider { constructor() { super(ZKTECO_BIOTIME_DEFINITION); } }

export const HIKVISION_ISAPI_DEFINITION = defineProvider({
  key: 'hikvision_isapi', vendor: 'Hikvision', name: 'Hikvision ISAPI (device HTTP API)',
  description: 'Direct device API (digest auth) for access-control terminals reachable from the worker (VPN/public IP). Events via AcsEvent search; users via UserInfo.',
  integrationType: 'LAN', status: 'placeholder',
  capabilities: { attendancePull: true, employeePush: true, employeePull: true, employeeDelete: true, fingerprint: true, face: true, card: true, pin: false, deviceStatus: true, remoteRestart: true, webhooks: true, devicePush: false, biometricTemplatePush: true },
  configSchema: { fields: [
    { key: 'baseUrl', label: 'Device URL', type: 'url', required: true, secret: false },
    { key: 'username', label: 'Username', type: 'text', required: true, secret: false },
    { key: 'password', label: 'Password', type: 'password', secret: true, required: true },
  ] },
  throttling: { maxConcurrentPerDevice: 1, requestsPerMinute: 60 }, verificationStatus: 'REPORTED', docsUrl: 'https://www.hikvision.com/en/support/download/sdk/',
});
export class HikvisionIsapiProvider extends PlaceholderProvider { constructor() { super(HIKVISION_ISAPI_DEFINITION); } }

export const HIKVISION_HPP_DEFINITION = defineProvider({
  key: 'hikvision_hpp', vendor: 'Hikvision', name: 'Hik-Partner Pro OpenAPI',
  description: 'Vendor-cloud API for Hik-Connect/Hik-Partner Pro managed devices (partner credentials required).',
  integrationType: 'VENDOR_CLOUD_PULL', status: 'placeholder',
  capabilities: { attendancePull: true, employeePush: false, employeePull: false, employeeDelete: false, deviceStatus: true, webhooks: true, devicePush: false },
  configSchema: { fields: [
    { key: 'appKey', label: 'App key', type: 'text', required: true, secret: false },
    { key: 'appSecret', label: 'App secret', type: 'password', secret: true, required: true },
    { key: 'region', label: 'Region', type: 'select', options: ['global', 'eu', 'us', 'sg'], default: 'global', required: false, secret: false },
  ] },
  throttling: { maxConcurrentPerAccount: 2, requestsPerMinute: 60 }, verificationStatus: 'UNVERIFIED', docsUrl: 'https://www.hikvision.com',
});
export class HikvisionHppProvider extends PlaceholderProvider { constructor() { super(HIKVISION_HPP_DEFINITION); } }

export const SUPREMA_BIOSTAR2_DEFINITION = defineProvider({
  key: 'suprema_biostar2', vendor: 'Suprema', name: 'Suprema BioStar 2 API',
  description: 'REST API of a customer-hosted BioStar 2 server (session login). Events and users are managed through the server.',
  integrationType: 'ON_PREM_SERVER_API', status: 'placeholder',
  capabilities: { attendancePull: true, employeePush: true, employeePull: true, employeeDelete: true, fingerprint: true, face: true, card: true, pin: true, deviceStatus: true, remoteRestart: false, webhooks: false, devicePush: false, biometricTemplatePush: true },
  configSchema: { fields: [
    { key: 'baseUrl', label: 'BioStar 2 URL', type: 'url', required: true, secret: false },
    { key: 'loginId', label: 'Login ID', type: 'text', required: true, secret: false },
    { key: 'password', label: 'Password', type: 'password', secret: true, required: true },
  ] },
  throttling: { maxConcurrentPerAccount: 2, requestsPerMinute: 120 }, verificationStatus: 'REPORTED', docsUrl: 'https://www.supremainc.com',
});
export class SupremaBioStar2Provider extends PlaceholderProvider { constructor() { super(SUPREMA_BIOSTAR2_DEFINITION); } }

export const ANVIZ_CROSSCHEX_CLOUD_DEFINITION = defineProvider({
  key: 'anviz_crosschex_cloud', vendor: 'Anviz', name: 'Anviz CrossChex Cloud API',
  description: 'Vendor-cloud API (OAuth-style token) for CrossChex Cloud / Anviz One managed devices.',
  integrationType: 'VENDOR_CLOUD_PULL', status: 'placeholder',
  capabilities: { attendancePull: true, employeePush: true, employeePull: true, employeeDelete: true, fingerprint: false, face: false, card: true, pin: true, deviceStatus: true, remoteRestart: false, webhooks: false, devicePush: false, biometricTemplatePush: false },
  configSchema: { fields: [
    { key: 'apiKey', label: 'API key', type: 'text', required: true, secret: false },
    { key: 'apiSecret', label: 'API secret', type: 'password', secret: true, required: true },
    { key: 'region', label: 'Region', type: 'select', options: ['global', 'eu', 'us', 'cn'], default: 'global', required: false, secret: false },
  ] },
  throttling: { maxConcurrentPerAccount: 2, requestsPerMinute: 60 }, verificationStatus: 'REPORTED', docsUrl: 'https://www.anviz.com',
});
export class AnvizCrossChexCloudProvider extends PlaceholderProvider { constructor() { super(ANVIZ_CROSSCHEX_CLOUD_DEFINITION); } }

export const ESSL_PUSH_DEFINITION = defineProvider({
  key: 'essl_push', vendor: 'eSSL', name: 'eSSL devices (PUSH/ADMS-compatible)',
  description: 'eSSL terminals are ZKTeco-derived and speak the same device push protocol; handled by the ZKTeco PUSH protocol handler with an eSSL profile.',
  integrationType: 'DEVICE_PUSH', status: 'placeholder',
  capabilities: { attendancePush: true, employeePush: true, employeePull: true, employeeDelete: true, fingerprint: true, face: true, card: true, deviceStatus: true, devicePush: true },
  configSchema: { fields: [
    { key: 'serialNumber', label: 'Device serial number', type: 'text', required: true, secret: false },
    { key: 'commKey', label: 'Comm key', type: 'password', secret: true, required: false },
  ] },
  throttling: { maxConcurrentPerDevice: 1 }, verificationStatus: 'UNVERIFIED', docsUrl: 'https://esslsecurity.com',
});
/** ZKTeco-derived: shares the iclock protocol handler (inbound parsing) but stays a placeholder until verified on hardware. */
export class EsslPushProvider extends ZKTecoPushProvider { constructor(options: { clock?: () => Date } = {}) { super({ definition: ESSL_PUSH_DEFINITION, mode: 'placeholder', ...options }); } }

export const FINGERTEC_PUSH_DEFINITION = defineProvider({
  key: 'fingertec_push', vendor: 'FingerTec', name: 'FingerTec devices (Webster/PUSH-compatible)',
  description: 'FingerTec terminals use a ZKTeco-derived push protocol (Webster). Requires hardware verification.',
  integrationType: 'DEVICE_PUSH', status: 'placeholder',
  capabilities: { attendancePush: true, employeePush: true, employeePull: true, employeeDelete: true, fingerprint: true, face: true, card: true, deviceStatus: true, devicePush: true },
  configSchema: { fields: [{ key: 'serialNumber', label: 'Device serial number', type: 'text', required: true, secret: false }] },
  throttling: { maxConcurrentPerDevice: 1 }, verificationStatus: 'UNVERIFIED', docsUrl: 'https://www.fingertec.com',
});
export class FingerTecPushProvider extends ZKTecoPushProvider { constructor(options: { clock?: () => Date } = {}) { super({ definition: FINGERTEC_PUSH_DEFINITION, mode: 'placeholder', ...options }); } }

export const MATRIX_COSEC_DEFINITION = defineProvider({
  key: 'matrix_cosec', vendor: 'Matrix Comsec', name: 'Matrix COSEC (CENTRA/VYOM API)',
  description: 'Integration through the COSEC server API. Requires Matrix API documentation/licence.',
  integrationType: 'ON_PREM_SERVER_API', status: 'placeholder',
  capabilities: { attendancePull: true, employeePush: true, employeePull: true, employeeDelete: true, deviceStatus: true },
  configSchema: { fields: [
    { key: 'baseUrl', label: 'COSEC server URL', type: 'url', required: true, secret: false },
    { key: 'username', label: 'Username', type: 'text', required: true, secret: false },
    { key: 'password', label: 'Password', type: 'password', secret: true, required: true },
  ] },
  throttling: { maxConcurrentPerAccount: 2 }, verificationStatus: 'UNVERIFIED', docsUrl: 'https://www.matrixaccesscontrol.com',
});
export class MatrixCosecProvider extends PlaceholderProvider { constructor() { super(MATRIX_COSEC_DEFINITION); } }

export const NITGEN_DEFINITION = defineProvider({
  key: 'nitgen', vendor: 'NITGEN', name: 'NITGEN (access manager / SDK)',
  description: 'Integration through NITGEN server software or SDK. Requires vendor documentation.',
  integrationType: 'ON_PREM_SERVER_API', status: 'placeholder',
  capabilities: { attendancePull: true, employeePush: true, employeePull: true, deviceStatus: true },
  configSchema: { fields: [
    { key: 'baseUrl', label: 'Server URL', type: 'url', required: true, secret: false },
    { key: 'apiKey', label: 'API key', type: 'password', secret: true, required: true },
  ] },
  throttling: { maxConcurrentPerAccount: 2 }, verificationStatus: 'UNVERIFIED', docsUrl: 'https://www.nitgen.com',
});
export class NitgenProvider extends PlaceholderProvider { constructor() { super(NITGEN_DEFINITION); } }

/** All placeholder providers, in reference-data order. */
export function createPlaceholderProviders(options: { clock?: () => Date } = {}): DeviceProvider[] {
  return [
    new ZKBioTimeProvider(), new HikvisionIsapiProvider(), new HikvisionHppProvider(), new SupremaBioStar2Provider(), new AnvizCrossChexCloudProvider(),
    new EsslPushProvider(options), new FingerTecPushProvider(options), new MatrixCosecProvider(), new NitgenProvider(),
  ];
}
