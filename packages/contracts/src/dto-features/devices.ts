import { z } from 'zod';
import { CONNECTION_STATUSES, DEVICE_EMPLOYEE_SYNC_STATUSES, DEVICE_STATUSES, LOG_LEVELS } from '../enums.js';
import { booleanQuerySchema, codeSchema, isoDateTimeSchema, jsonObjectSchema, paginationQuerySchema, timezoneSchema, uuidSchema } from '../common.js';

/**
 * PATCH schema derived from a create schema: every field optional and *without* its default. Zod 4 `.partial()` keeps
 * `.default(...)` wrappers, so a one-field PATCH would silently reset every defaulted column (AGENTS.md "Zod 4 pitfalls").
 */
export function updateSchemaOf<T>(shape: z.ZodRawShape): z.ZodType<Partial<T>> {
  const out: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(shape)) { const inner = field instanceof z.ZodDefault ? (field as z.ZodDefault<z.ZodTypeAny>).removeDefault() : (field as z.ZodTypeAny); out[key] = inner.optional(); }
  return z.object(out) as unknown as z.ZodType<Partial<T>>;
}

/** Query for GET /device-providers: when `orgId` is given the list is filtered by that organisation's provider_* flags. */
export const deviceProvidersQuerySchema = z.object({ orgId: uuidSchema.optional() });
export const deviceModelsQuerySchema = z.object({ providerKey: z.string().min(1).max(64).optional() });

export const deviceListQuerySchema = paginationQuerySchema.extend({
  branchId: uuidSchema.optional(),
  status: z.enum(DEVICE_STATUSES).optional(),
  connectionStatus: z.enum([...CONNECTION_STATUSES, 'vendor_degraded']).optional(),
  providerKey: z.string().max(64).optional(),
  tag: z.string().max(40).optional(),
  groupId: uuidSchema.optional(),
  search: z.string().trim().max(100).optional(),
  includeDecommissioned: booleanQuerySchema.default(false),
});
export type DeviceListQuery = z.infer<typeof deviceListQuerySchema>;

export const deleteDeviceQuerySchema = z.object({ decommission: booleanQuerySchema.default(false) });

/** Fleet summary query — same branch scoping as the list. */
export const deviceSummaryQuerySchema = z.object({ branchId: uuidSchema.optional(), includeDecommissioned: booleanQuerySchema.default(false) });
export type DeviceSummaryQuery = z.infer<typeof deviceSummaryQuerySchema>;
/** Counts for list headers / dashboards; keys of `byConnectionStatus` are CONNECTION_STATUSES (+ 'vendor_degraded'), of `byStatus` DEVICE_STATUSES. */
export const deviceSummaryDtoSchema = z.object({
  total: z.number().int(),
  byConnectionStatus: z.record(z.string(), z.number().int()),
  byStatus: z.record(z.string(), z.number().int()),
  /** active devices without any heartbeat in the last 24 hours (or never seen) */
  staleHeartbeats: z.number().int(),
});
export type DeviceSummaryDto = z.infer<typeof deviceSummaryDtoSchema>;

/** Secret config fields keyed by provider config field (validated against the provider's `secretFields`). */
export const deviceCredentialsInputSchema = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), z.union([z.string().max(4096), z.number(), z.boolean()]))
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one credential field' });
export type DeviceCredentialsInput = z.infer<typeof deviceCredentialsInputSchema>;

export const deviceLogQuerySchema = paginationQuerySchema.extend({
  level: z.enum(LOG_LEVELS).optional(),
  event: z.string().max(80).optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
});
export const deviceCommandQuerySchema = paginationQuerySchema.extend({ status: z.enum(['pending', 'sent', 'acked', 'failed', 'expired']).optional() });
export const deviceEmployeeQuerySchema = paginationQuerySchema.extend({
  syncStatus: z.enum(DEVICE_EMPLOYEE_SYNC_STATUSES).optional(),
  desired: booleanQuerySchema.optional(),
  search: z.string().trim().max(100).optional(),
});

export const deviceGroupInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  branchId: uuidSchema.nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
});
export type DeviceGroupInput = z.infer<typeof deviceGroupInputSchema>;
export const deviceGroupMembersSchema = z.object({ deviceIds: z.array(uuidSchema).min(1).max(500) });

export const pendingDevicesQuerySchema = z.object({ serialNumber: z.string().trim().min(1).max(120).optional() });
export const claimPendingDeviceSchema = z.object({
  branchId: uuidSchema,
  name: z.string().trim().min(1).max(120),
  code: codeSchema,
  timezone: timezoneSchema.optional(),
  modelId: uuidSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});
export type ClaimPendingDeviceInput = z.infer<typeof claimPendingDeviceSchema>;

export const deviceGroupDtoSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  branchId: uuidSchema.nullable(),
  branchName: z.string().nullable().optional(),
  color: z.string().nullable(),
  deviceCount: z.number().int(),
  deviceIds: z.array(uuidSchema).optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type DeviceGroupDto = z.infer<typeof deviceGroupDtoSchema>;

export const pendingDeviceDtoSchema = z.object({
  id: uuidSchema,
  providerKey: z.string(),
  serialNumber: z.string(),
  claimCode: z.string(),
  organizationId: uuidSchema.nullable(),
  firstSeenAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
  remoteIp: z.string().nullable(),
  deviceInfo: jsonObjectSchema,
  claimedDeviceId: uuidSchema.nullable(),
});
export type PendingDeviceDto = z.infer<typeof pendingDeviceDtoSchema>;

export const deviceLogDtoSchema = z.object({
  id: z.string(),
  deviceId: uuidSchema,
  level: z.enum(LOG_LEVELS),
  event: z.string(),
  message: z.string().nullable(),
  details: jsonObjectSchema.nullable(),
  jobId: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type DeviceLogDto = z.infer<typeof deviceLogDtoSchema>;

export const deviceCommandDtoSchema = z.object({
  id: uuidSchema,
  deviceId: uuidSchema,
  sequence: z.string(),
  commandType: z.string(),
  payload: jsonObjectSchema,
  status: z.enum(['pending', 'sent', 'acked', 'failed', 'expired']),
  syncJobItemId: uuidSchema.nullable(),
  result: jsonObjectSchema.nullable(),
  createdAt: isoDateTimeSchema,
  sentAt: isoDateTimeSchema.nullable(),
  ackedAt: isoDateTimeSchema.nullable(),
  expiresAt: isoDateTimeSchema,
});
export type DeviceCommandDto = z.infer<typeof deviceCommandDtoSchema>;

/** Returned once by POST /devices, /pending/:id/claim and /push-token/rotate — the token is never retrievable again. */
export interface DevicePushCredentials { pushToken: string; pushUrl: string | null; webhookUrl: string | null }

export interface TestConnectionResultDto {
  ok: boolean;
  message: string;
  latencyMs: number;
  code: string | null;
  retryable: boolean;
  deviceInfo: Record<string, unknown> | null;
  details: Record<string, unknown> | null;
  usedStoredCredentials: boolean;
}

// ----- device user (PIN) ↔ employee mapping -----------------------------------------------------------------------------
// The normaliser resolves a punch's `device_employee_id` in three steps (docs/attendance-engine.md): per-device state →
// per-provider identity → the employee's organisation-wide `device_user_id`. Punches whose PIN matches none of them land
// in `unmatched` and never become attendance. These shapes drive the screen that lists those PINs and links them.

/** How far a link reaches. DEVICE = this device only; PROVIDER = every device of the same vendor in the organisation. */
export const DEVICE_USER_LINK_SCOPES = ['DEVICE', 'PROVIDER'] as const;
export type DeviceUserLinkScope = (typeof DEVICE_USER_LINK_SCOPES)[number];

export const unmappedDeviceUsersQuerySchema = paginationQuerySchema.extend({
  branchId: uuidSchema.optional(),
  deviceId: uuidSchema.optional(),
  /** `punches` = only PINs seen in unmatched raw transactions, `enrolled` = only PINs enrolled on a device with no employee. */
  origin: z.enum(['all', 'punches', 'enrolled']).default('all'),
  search: z.string().trim().max(100).optional(),
});
export type UnmappedDeviceUsersQuery = z.infer<typeof unmappedDeviceUsersQuerySchema>;

/** One unknown PIN on one device: what the device reports about it and how much attendance is waiting behind it. */
export const unmappedDeviceUserDtoSchema = z.object({
  deviceId: uuidSchema,
  deviceName: z.string(),
  deviceCode: z.string(),
  branchId: uuidSchema.nullable(),
  providerKey: z.string(),
  deviceUserId: z.string(),
  /** Name the device holds for the PIN, when the employee list was pulled from it (never a biometric template). */
  deviceUserName: z.string().nullable(),
  /** true when a `device_employee_states` row exists for the PIN with no employee (enrolled on the device, unknown here). */
  enrolledOnDevice: z.boolean(),
  unmatchedPunches: z.number().int(),
  firstPunchAt: isoDateTimeSchema.nullable(),
  lastPunchAt: isoDateTimeSchema.nullable(),
});
export type UnmappedDeviceUserDto = z.infer<typeof unmappedDeviceUserDtoSchema>;

export const linkDeviceUserSchema = z.object({
  deviceUserId: z.string().trim().min(1).max(64),
  employeeId: uuidSchema,
  scope: z.enum(DEVICE_USER_LINK_SCOPES).default('DEVICE'),
  /** Re-queue the PIN's `unmatched` punches so the engine replays them into attendance (default true). */
  requeueUnmatched: z.boolean().default(true),
});
export type LinkDeviceUserInput = z.infer<typeof linkDeviceUserSchema>;

export const unlinkDeviceUserSchema = z.object({
  deviceUserId: z.string().trim().min(1).max(64),
  scope: z.enum(DEVICE_USER_LINK_SCOPES).default('DEVICE'),
});
export type UnlinkDeviceUserInput = z.infer<typeof unlinkDeviceUserSchema>;

export const deviceUserLinkResultSchema = z.object({
  deviceId: uuidSchema,
  deviceUserId: z.string(),
  employeeId: uuidSchema.nullable(),
  scope: z.enum(DEVICE_USER_LINK_SCOPES),
  /** raw punches moved back to `pending` for the normaliser. */
  requeued: z.number().int(),
});
export type DeviceUserLinkResult = z.infer<typeof deviceUserLinkResultSchema>;
