import { DateTime } from 'luxon';
import type { DeviceCapabilities, DeviceEmployee } from '@flowza/contracts';
import { unsupported } from '../../errors.js';
import type { AttendancePullResult, ConnectionResult, DeviceEmployeePage, DeviceInfo, DeviceOperationResult, DeviceProvider, DevicePushProtocolHandler, DeviceStatus, PageCursor, ProviderContext, ProviderDefinition, SyncCursor } from '../../types.js';
import { HIKVISION_PUSH_DEFINITION } from './definition.js';
import { createHikvisionPushProtocol } from './push-protocol.js';

export const HIKVISION_PUSH_NOT_VERIFIED_MESSAGE = 'Hikvision push devices are verified when the device posts its first event to FlowZa';
/** Event-only devices are silent between punches, so "recently seen" is judged over a long window. */
const RECENT_WINDOW_SECONDS = 24 * 3600;

export interface HikvisionPushProviderOptions { clock?: () => Date; protocol?: DevicePushProtocolHandler }

/**
 * DEVICE_PUSH provider for Hikvision HTTP Listening. The device talks to FlowZa, never the other way round, and the channel is
 * one-way: there is no command poll, so user management and restart are honestly UNSUPPORTED (capabilities say so).
 * `ctx.config.lastSeenAt` (ISO, maintained by the push route on every post) is the only liveness signal.
 */
export class HikvisionPushProvider implements DeviceProvider {
  readonly definition: ProviderDefinition = HIKVISION_PUSH_DEFINITION;
  readonly pushProtocol: DevicePushProtocolHandler;
  private readonly clock: () => Date;

  constructor(options: HikvisionPushProviderOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.pushProtocol = options.protocol ?? createHikvisionPushProtocol();
  }

  private lastSeen(ctx: ProviderContext): { lastSeenAt: string | undefined; ageSeconds: number | undefined } {
    const raw = ctx.config.lastSeenAt;
    if (typeof raw !== 'string') return { lastSeenAt: undefined, ageSeconds: undefined };
    const seen = DateTime.fromISO(raw, { setZone: true });
    if (!seen.isValid) return { lastSeenAt: undefined, ageSeconds: undefined };
    const ageSeconds = Math.max(0, Math.round(DateTime.fromJSDate(this.clock()).diff(seen, 'seconds').seconds));
    return { lastSeenAt: seen.toUTC().toISO({ suppressMilliseconds: true }) ?? undefined, ageSeconds };
  }

  async testConnection(ctx: ProviderContext): Promise<ConnectionResult> {
    const seen = this.lastSeen(ctx);
    if (seen.ageSeconds === undefined || seen.ageSeconds > RECENT_WINDOW_SECONDS) return { ok: false, message: HIKVISION_PUSH_NOT_VERIFIED_MESSAGE, latencyMs: 0, details: { lastSeenAt: seen.lastSeenAt ?? null } };
    return { ok: true, message: `Device posted to FlowZa ${seen.ageSeconds}s ago`, latencyMs: 0, deviceInfo: { serialNumber: ctx.serialNumber ?? undefined }, details: { lastSeenAt: seen.lastSeenAt } };
  }

  async getDeviceInfo(ctx: ProviderContext): Promise<DeviceInfo> {
    const serial = ctx.serialNumber ?? (typeof ctx.config.serialNumber === 'string' ? ctx.config.serialNumber : undefined);
    return { ...(serial !== undefined ? { serialNumber: serial } : {}), extra: { note: 'HTTP Listening carries events only; model and firmware are entered on the device record.' } };
  }

  async getCapabilities(_ctx: ProviderContext): Promise<DeviceCapabilities> {
    return { ...this.definition.capabilities };
  }

  async getDeviceStatus(ctx: ProviderContext): Promise<DeviceStatus> {
    const seen = this.lastSeen(ctx);
    const online = seen.ageSeconds !== undefined && seen.ageSeconds <= RECENT_WINDOW_SECONDS;
    return { online, ...(seen.lastSeenAt !== undefined ? { lastSeenAt: seen.lastSeenAt } : {}), details: { ageSeconds: seen.ageSeconds ?? null } };
  }

  async pullAttendance(_ctx: ProviderContext, _cursor: SyncCursor | null): Promise<AttendancePullResult> {
    throw unsupported('pullAttendance', 'events are pushed by the device over HTTP Listening; nothing to pull');
  }

  async listEmployees(_ctx: ProviderContext, _page: PageCursor): Promise<DeviceEmployeePage> {
    throw unsupported('listEmployees', 'HTTP Listening is one-way; read users on the device or in Hik-Central');
  }

  async upsertEmployee(_ctx: ProviderContext, _employee: DeviceEmployee): Promise<DeviceOperationResult> {
    throw unsupported('upsertEmployee', 'enrol the employee on the device with Employee ID = FlowZa device user id');
  }

  async deleteEmployee(_ctx: ProviderContext, _deviceUserId: string): Promise<DeviceOperationResult> {
    throw unsupported('deleteEmployee', 'remove the user on the device or in Hik-Central');
  }
}
