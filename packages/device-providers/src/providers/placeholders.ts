import type { DeviceCapabilities, DeviceEmployee } from '@flowza/contracts';
import { defineProvider } from '../definition.js';
import { notImplemented } from '../errors.js';
import type { AttendancePullResult, ConnectionResult, DeviceEmployeePage, DeviceInfo, DeviceOperationResult, DeviceProvider, DeviceStatus, PageCursor, ProviderContext, ProviderDefinition, SyncCursor } from '../types.js';

/**
 * Placeholder providers (§135): registered so the wizard can show them with their config schema and documented
 * capabilities, but every operation throws ProviderError('NOT_IMPLEMENTED'). They never fake success.
 * Only the two integrations that cannot be built from public material remain here (docs/device-integrations.md §2.2, §2.8):
 * Hik-Partner Pro needs partner credentials and its request signing, NITGEN exposes no API at all (a bridge agent is needed).
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
export function createPlaceholderProviders(): DeviceProvider[] {
  return [new HikvisionHppProvider(), new NitgenProvider()];
}
