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
