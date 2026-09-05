import type { Logger } from '@flowza/shared';
import type { DeviceCapabilities, DeviceEmployee, IntegrationType, ProviderConfigSchema, ProviderStatus, ProviderThrottling, RawTransaction, VerificationStatus } from '@flowza/contracts';

/** Static description of a provider: what it is, what it can do, what it needs (§11–§13). */
export interface ProviderDefinition {
  key: string;                       // 'mock', 'zkteco_push', …  (matches device_providers.key)
  vendor: string;
  name: string;
  description: string;
  integrationType: IntegrationType;
  status: ProviderStatus;            // placeholder providers must fail honestly (§135)
  capabilities: DeviceCapabilities;  // declared matrix; may be narrowed per device by getCapabilities()
  configSchema: ProviderConfigSchema;
  throttling: ProviderThrottling;
  verificationStatus: VerificationStatus;
  docsUrl?: string;
  /** Names of config fields that are secrets (stored encrypted, never returned). Derived from configSchema. */
  secretFields: string[];
}

export type ProviderErrorCode =
  | 'AUTH_FAILED' | 'DEVICE_OFFLINE' | 'RATE_LIMITED' | 'TIMEOUT' | 'UNSUPPORTED' | 'NOT_FOUND'
  | 'INVALID_CONFIG' | 'VENDOR_ERROR' | 'NOT_IMPLEMENTED' | 'PROTOCOL_ERROR' | 'CONFLICT';

/** Typed provider failure so the sync engine can apply provider-agnostic retry policy (§63). */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: ProviderErrorCode, message: string, opts: { retryable?: boolean; retryAfterMs?: number; details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = opts.retryable ?? DEFAULT_RETRYABLE[code];
    this.retryAfterMs = opts.retryAfterMs;
    this.details = opts.details;
  }
  static is(e: unknown): e is ProviderError { return e instanceof ProviderError || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'ProviderError'); }
}
export const DEFAULT_RETRYABLE: Record<ProviderErrorCode, boolean> = {
  AUTH_FAILED: false, DEVICE_OFFLINE: true, RATE_LIMITED: true, TIMEOUT: true, UNSUPPORTED: false, NOT_FOUND: false,
  INVALID_CONFIG: false, VENDOR_ERROR: true, NOT_IMPLEMENTED: false, PROTOCOL_ERROR: false, CONFLICT: false,
};

/** Everything a provider call needs. Credentials are decrypted in memory only for the duration of the call. */
export interface ProviderContext {
  organizationId: string;
  deviceId: string;
  deviceCode: string;
  timezone: string;                          // device timezone (IANA); used when the device reports local time without offset
  config: Record<string, unknown>;           // non-secret configuration
  credentials: Record<string, unknown>;      // secret configuration (decrypted)
  endpointUrl?: string | null;
  serialNumber?: string | null;
  logger: Logger;
  signal: AbortSignal;                       // carries the operation timeout
  /** Called before every outbound request so the worker can enforce per-provider throttling (§79). */
  acquire: () => Promise<void>;
}

export interface ConnectionResult { ok: boolean; message: string; latencyMs: number; deviceInfo?: Partial<DeviceInfo>; details?: Record<string, unknown> }
export interface DeviceInfo { serialNumber?: string; model?: string; firmwareVersion?: string; deviceTime?: string; userCount?: number; fingerprintCount?: number; faceCount?: number; transactionCount?: number; extra?: Record<string, unknown> }
export interface DeviceStatus { online: boolean; lastSeenAt?: string; deviceTime?: string; clockSkewSeconds?: number; details?: Record<string, unknown> }

/** Opaque, provider-defined cursor (§22). Stored as jsonb in sync_cursors. */
export type SyncCursor = Record<string, unknown>;

export interface AttendancePullResult {
  transactions: RawTransaction[];
  nextCursor: SyncCursor;
  hasMore: boolean;
  /** Provider-side metadata useful for diagnostics (page size, request id…). Never secrets. */
  meta?: Record<string, unknown>;
}

export type PageCursor = string | null;
export interface DeviceEmployeePage { employees: DeviceEmployee[]; nextCursor: PageCursor }

export interface DeviceOperationResult {
  ok: boolean;
  /** Vendor identifier confirmed by the device (may differ from what we sent). */
  deviceUserId?: string;
  message?: string;
  /** For push-protocol devices the operation is queued and completes asynchronously. */
  async?: boolean;
  details?: Record<string, unknown>;
}

// ----- Inbound: vendor webhooks -------------------------------------------------------------------
export interface WebhookRequest { headers: Record<string, string>; rawBody: string; body: unknown; query: Record<string, string>; remoteIp?: string }
export interface WebhookHandlingResult {
  accepted: boolean;
  /** Stable event id from the vendor for replay protection; null if the vendor provides none. */
  eventId: string | null;
  eventType?: string;
  /** Vendor device identifier(s) the payload refers to (serial or vendor id) so the router can map to devices. */
  vendorDeviceId?: string;
  transactions: RawTransaction[];
  deviceStatus?: DeviceStatus;
  /** HTTP response the vendor expects. */
  response: { status: number; body?: unknown; headers?: Record<string, string> };
  signatureValid: boolean | null;
}

// ----- Inbound: device push protocols (device → FlowZa) -------------------------------------------
export interface DevicePushRequest { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; rawBody: string; remoteIp?: string }
export interface DevicePushResponse { status: number; body: string; headers?: Record<string, string> }
export interface DevicePushIdentity { serialNumber: string; extra?: Record<string, unknown> }
export interface DevicePushCommand { id: string; commandType: string; payload: Record<string, unknown> }
export interface DevicePushInbound {
  kind: 'handshake' | 'attendance' | 'heartbeat' | 'command_result' | 'user_data' | 'unknown';
  transactions: RawTransaction[];
  employees?: DeviceEmployee[];
  deviceInfo?: Partial<DeviceInfo>;
  commandResults?: { commandId: string; ok: boolean; message?: string }[];
  /** Response to send when no commands are pending. */
  response: DevicePushResponse;
  /** Protocol-level facts the route may persist (e.g. ZKTeco `Stamp`, table name, line counts). Never secrets. */
  meta?: Record<string, unknown>;
}
/** Context handed to `parseInbound`; `stamps` lets stateful protocols (ZKTeco ATTLOG/OPERLOG stamps) resume. */
export interface DevicePushParseContext { timezone: string; serialNumber: string; stamps?: Record<string, string> }
/** Protocol semantics live in the provider package; apps/api only hosts the HTTP route (§E.2). */
export interface DevicePushProtocolHandler {
  readonly protocolKey: string; // path segment: /device-push/<protocolKey>/*
  identifyDevice(req: DevicePushRequest): DevicePushIdentity | null;
  parseInbound(req: DevicePushRequest, ctx: DevicePushParseContext): DevicePushInbound;
  /** Render pending outbound commands into the protocol's response format (employee push/delete…). */
  renderCommands(commands: DevicePushCommand[], ctx: { serialNumber: string }): DevicePushResponse;
  /** Translate a generic employee operation into protocol command payloads. */
  buildCommands(op: { type: 'UPSERT_EMPLOYEE'; employee: DeviceEmployee } | { type: 'DELETE_EMPLOYEE'; deviceUserId: string } | { type: 'RESTART' } | { type: 'QUERY_USERS' }): Array<{ commandType: string; payload: Record<string, unknown> }>;
}

/** The provider contract every vendor adapter implements (§11). The attendance engine never sees this. */
export interface DeviceProvider {
  readonly definition: ProviderDefinition;
  testConnection(ctx: ProviderContext): Promise<ConnectionResult>;
  getDeviceInfo(ctx: ProviderContext): Promise<DeviceInfo>;
  getCapabilities(ctx: ProviderContext): Promise<DeviceCapabilities>;
  getDeviceStatus(ctx: ProviderContext): Promise<DeviceStatus>;
  pullAttendance(ctx: ProviderContext, cursor: SyncCursor | null, opts?: { pageSize?: number; since?: string }): Promise<AttendancePullResult>;
  listEmployees(ctx: ProviderContext, page: PageCursor): Promise<DeviceEmployeePage>;
  upsertEmployee(ctx: ProviderContext, employee: DeviceEmployee): Promise<DeviceOperationResult>;
  deleteEmployee(ctx: ProviderContext, deviceUserId: string): Promise<DeviceOperationResult>;
  restart?(ctx: ProviderContext): Promise<DeviceOperationResult>;
  handleWebhook?(req: WebhookRequest, secrets: Record<string, unknown>): Promise<WebhookHandlingResult>;
  pushProtocol?: DevicePushProtocolHandler;
}

export interface ProviderRegistry {
  get(key: string): DeviceProvider;
  tryGet(key: string): DeviceProvider | undefined;
  list(): ProviderDefinition[];
  pushProtocols(): DevicePushProtocolHandler[];
  pushProtocol(protocolKey: string): DevicePushProtocolHandler | undefined;
}

export const EMPTY_CAPABILITIES: DeviceCapabilities = {
  attendancePull: false, attendancePush: false, employeePush: false, employeePull: false, employeeDelete: false,
  fingerprint: false, face: false, card: false, pin: false, deviceStatus: false, remoteRestart: false, webhooks: false, devicePush: false, biometricTemplatePush: false,
};
