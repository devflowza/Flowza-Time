import { DateTime } from 'luxon';
import type { DeviceCapabilities, DeviceEmployee } from '@flowza/contracts';
import { notImplemented, unsupported } from '../../errors.js';
import { ProviderError, type AttendancePullResult, type ConnectionResult, type DeviceEmployeePage, type DeviceInfo, type DeviceOperationResult, type DeviceProvider, type DevicePushProtocolHandler, type DeviceStatus, type PageCursor, type ProviderContext, type ProviderDefinition, type SyncCursor } from '../../types.js';
import { ZKTECO_PUSH_DEFINITION } from './definition.js';
import { createZkPushProtocol, type ZkPushProtocolOptions } from './push-protocol.js';

export const PUSH_NOT_VERIFIED_MESSAGE = 'Push devices are verified when the device contacts FlowZa';
const DEFAULT_RECENT_WINDOW_SECONDS = 300;

export interface ZKTecoPushProviderOptions {
  /** Override for ZKTeco-derived brands (eSSL, FingerTec) that reuse the protocol under their own key. */
  definition?: ProviderDefinition;
  /** `placeholder` = protocol handler is exposed but every provider operation throws NOT_IMPLEMENTED (unverified hardware). */
  mode?: 'beta' | 'placeholder';
  clock?: () => Date;
  protocol?: DevicePushProtocolHandler;
  protocolOptions?: ZkPushProtocolOptions;
}

/**
 * DEVICE_PUSH provider: the device talks to FlowZa, never the other way round. Outbound operations are therefore
 * translated into protocol commands (`DeviceOperationResult.async = true`, commands in `details.commands`) which the
 * API/worker persist in `device_commands`; the device fetches them on its next `getrequest` poll.
 * `ctx.config.lastSeenAt` (ISO, maintained by the push route) is the only signal of liveness.
 */
export class ZKTecoPushProvider implements DeviceProvider {
  readonly definition: ProviderDefinition;
  readonly pushProtocol: DevicePushProtocolHandler;
  readonly mode: 'beta' | 'placeholder';
  private readonly clock: () => Date;

  constructor(options: ZKTecoPushProviderOptions = {}) {
    this.definition = options.definition ?? ZKTECO_PUSH_DEFINITION;
    this.mode = options.mode ?? 'beta';
    this.clock = options.clock ?? (() => new Date());
    this.pushProtocol = options.protocol ?? createZkPushProtocol(options.protocolOptions);
  }

  private guard(): void {
    if (this.mode === 'placeholder') throw notImplemented(this.definition.name);
  }

  private lastSeen(ctx: ProviderContext): { lastSeenAt: string | undefined; ageSeconds: number | undefined; recent: boolean } {
    const raw = ctx.config.lastSeenAt;
    if (typeof raw !== 'string') return { lastSeenAt: undefined, ageSeconds: undefined, recent: false };
    const seen = DateTime.fromISO(raw, { setZone: true });
    if (!seen.isValid) return { lastSeenAt: undefined, ageSeconds: undefined, recent: false };
    const now = DateTime.fromJSDate(this.clock());
    const ageSeconds = Math.max(0, Math.round(now.diff(seen, 'seconds').seconds));
    const interval = typeof ctx.config.pushInterval === 'number' && ctx.config.pushInterval > 0 ? ctx.config.pushInterval * 3 : DEFAULT_RECENT_WINDOW_SECONDS;
    return { lastSeenAt: seen.toUTC().toISO({ suppressMilliseconds: true }) ?? undefined, ageSeconds, recent: ageSeconds <= Math.max(interval, DEFAULT_RECENT_WINDOW_SECONDS) };
  }

  private queued(op: Parameters<DevicePushProtocolHandler['buildCommands']>[0], message: string, deviceUserId?: string): DeviceOperationResult {
    const commands = this.pushProtocol.buildCommands(op);
    return { ok: true, async: true, ...(deviceUserId !== undefined ? { deviceUserId } : {}), message, details: { commands, protocolKey: this.pushProtocol.protocolKey } };
  }

  async testConnection(ctx: ProviderContext): Promise<ConnectionResult> {
    this.guard();
    const seen = this.lastSeen(ctx);
    if (!seen.recent) return { ok: false, message: PUSH_NOT_VERIFIED_MESSAGE, latencyMs: 0, details: { lastSeenAt: seen.lastSeenAt ?? null } };
    return { ok: true, message: `Device contacted FlowZa ${seen.ageSeconds}s ago`, latencyMs: 0, deviceInfo: { serialNumber: ctx.serialNumber ?? undefined }, details: { lastSeenAt: seen.lastSeenAt } };
  }

  async getDeviceInfo(ctx: ProviderContext): Promise<DeviceInfo> {
    this.guard();
    const serial = ctx.serialNumber ?? (typeof ctx.config.serialNumber === 'string' ? ctx.config.serialNumber : undefined);
    return { ...(serial !== undefined ? { serialNumber: serial } : {}), extra: { note: 'Device information is reported by the device itself on handshake/heartbeat (see push route).' } };
  }

  async getCapabilities(_ctx: ProviderContext): Promise<DeviceCapabilities> {
    this.guard();
    return { ...this.definition.capabilities };
  }

  async getDeviceStatus(ctx: ProviderContext): Promise<DeviceStatus> {
    this.guard();
    const seen = this.lastSeen(ctx);
    return { online: seen.recent, ...(seen.lastSeenAt !== undefined ? { lastSeenAt: seen.lastSeenAt } : {}), details: { ageSeconds: seen.ageSeconds ?? null } };
  }

  async pullAttendance(_ctx: ProviderContext, _cursor: SyncCursor | null): Promise<AttendancePullResult> {
    this.guard();
    throw unsupported('pullAttendance', 'attendance is pushed by the device (DEVICE_PUSH); nothing to pull');
  }

  async listEmployees(_ctx: ProviderContext, _page: PageCursor): Promise<DeviceEmployeePage> {
    this.guard();
    // Returning an empty page would look like "the device has no users" — a lie. The user list arrives asynchronously
    // as OPERLOG USER lines after the device executes DATA QUERY USERINFO, so callers must queue that command instead.
    throw new ProviderError('UNSUPPORTED', 'Push devices report users asynchronously: queue the QUERY_USERS command (details.commands) and read employees from the OPERLOG push', {
      retryable: false,
      details: { async: true, commands: this.pushProtocol.buildCommands({ type: 'QUERY_USERS' }), protocolKey: this.pushProtocol.protocolKey },
    });
  }

  async upsertEmployee(_ctx: ProviderContext, employee: DeviceEmployee): Promise<DeviceOperationResult> {
    this.guard();
    return this.queued({ type: 'UPSERT_EMPLOYEE', employee }, 'Queued DATA UPDATE USERINFO; applied when the device next polls', employee.deviceUserId);
  }

  async deleteEmployee(_ctx: ProviderContext, deviceUserId: string): Promise<DeviceOperationResult> {
    this.guard();
    return this.queued({ type: 'DELETE_EMPLOYEE', deviceUserId }, 'Queued DATA DELETE USERINFO; applied when the device next polls', deviceUserId);
  }

  async restart(_ctx: ProviderContext): Promise<DeviceOperationResult> {
    this.guard();
    return this.queued({ type: 'RESTART' }, 'Queued REBOOT; applied when the device next polls');
  }
}
