import { z } from 'zod';
import { CONNECTION_STATUSES, DEVICE_STATUSES, INTEGRATION_TYPES, PROVIDER_STATUSES, PUNCH_DIRECTIONS, RAW_SOURCES, VERIFICATION_METHODS, VERIFICATION_STATUSES } from './enums.js';
import { codeSchema, isoDateTimeSchema, jsonObjectSchema, timezoneSchema, uuidSchema } from './common.js';

/** Capability matrix exposed by providers/models/devices (§12). Unknown keys default to false. */
export const deviceCapabilitiesSchema = z.object({
  attendancePull: z.boolean().default(false),
  attendancePush: z.boolean().default(false),
  employeePush: z.boolean().default(false),
  employeePull: z.boolean().default(false),
  employeeDelete: z.boolean().default(false),
  fingerprint: z.boolean().default(false),
  face: z.boolean().default(false),
  card: z.boolean().default(false),
  pin: z.boolean().default(false),
  deviceStatus: z.boolean().default(false),
  remoteRestart: z.boolean().default(false),
  webhooks: z.boolean().default(false),
  devicePush: z.boolean().default(false),
  biometricTemplatePush: z.boolean().default(false),
});
export type DeviceCapabilities = z.infer<typeof deviceCapabilitiesSchema>;
export const CAPABILITY_KEYS = Object.keys(deviceCapabilitiesSchema.shape) as (keyof DeviceCapabilities)[];

/** Declarative description of the fields a provider needs at registration; drives the wizard. */
export const providerConfigFieldSchema = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
  label: z.string(),
  type: z.enum(['text', 'password', 'number', 'url', 'select', 'boolean']),
  required: z.boolean().default(false),
  secret: z.boolean().default(false),
  options: z.array(z.string()).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  help: z.string().optional(),
});
export type ProviderConfigField = z.infer<typeof providerConfigFieldSchema>;
export const providerConfigSchemaSchema = z.object({ fields: z.array(providerConfigFieldSchema) });
export type ProviderConfigSchema = z.infer<typeof providerConfigSchemaSchema>;

export const providerThrottlingSchema = z.object({
  maxConcurrentPerDevice: z.number().int().min(1).default(1),
  maxConcurrentPerAccount: z.number().int().min(1).default(4),
  requestsPerMinute: z.number().int().min(1).default(120),
}).partial();
export type ProviderThrottling = z.infer<typeof providerThrottlingSchema>;

export const deviceProviderDtoSchema = z.object({
  key: z.string(),
  vendor: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  integrationType: z.enum(INTEGRATION_TYPES),
  status: z.enum(PROVIDER_STATUSES),
  capabilities: deviceCapabilitiesSchema,
  configSchema: providerConfigSchemaSchema,
  verificationStatus: z.enum(VERIFICATION_STATUSES),
  docsUrl: z.string().nullable(),
});
export type DeviceProviderDto = z.infer<typeof deviceProviderDtoSchema>;

export const deviceModelDtoSchema = z.object({
  id: uuidSchema,
  providerKey: z.string(),
  vendor: z.string(),
  model: z.string(),
  family: z.string().nullable(),
  capabilities: deviceCapabilitiesSchema.partial(),
  verification: z.enum(VERIFICATION_STATUSES),
  notes: z.string().nullable(),
});
export type DeviceModelDto = z.infer<typeof deviceModelDtoSchema>;

export const createDeviceSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(120),
  branchId: uuidSchema,
  providerKey: z.string().min(1).max(64),
  modelId: uuidSchema.optional(),
  manufacturer: z.string().trim().min(1).max(80),
  modelName: z.string().trim().max(120).optional(),
  serialNumber: z.string().trim().max(120).optional(),
  timezone: timezoneSchema.optional(),
  endpointUrl: z.url().optional(),
  /** Non-secret + secret config values keyed by provider config field. Secrets are split out server-side. */
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  offlineThresholdMinutes: z.number().int().min(1).max(1440).optional(),
  autoSyncEnabled: z.boolean().optional(),
  syncIntervalMinutes: z.number().int().min(1).max(1440).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  notes: z.string().max(2000).optional(),
});
export type CreateDeviceInput = z.infer<typeof createDeviceSchema>;
export const updateDeviceSchema = createDeviceSchema.omit({ providerKey: true, config: true }).partial().extend({ status: z.enum(DEVICE_STATUSES).optional() });
export type UpdateDeviceInput = z.infer<typeof updateDeviceSchema>;
export const testConnectionSchema = z.object({
  providerKey: z.string().min(1),
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  /** When testing an existing device without re-entering secrets. */
  deviceId: uuidSchema.optional(),
});
export type TestConnectionInput = z.infer<typeof testConnectionSchema>;

export const deviceDtoSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  branchId: uuidSchema,
  branchName: z.string().optional(),
  code: z.string(),
  name: z.string(),
  providerKey: z.string(),
  providerName: z.string().optional(),
  modelId: uuidSchema.nullable(),
  manufacturer: z.string(),
  modelName: z.string().nullable(),
  serialNumber: z.string().nullable(),
  timezone: z.string(),
  integrationType: z.enum(INTEGRATION_TYPES),
  endpointUrl: z.string().nullable(),
  config: jsonObjectSchema,
  capabilities: deviceCapabilitiesSchema,
  status: z.enum(DEVICE_STATUSES),
  connectionStatus: z.enum(CONNECTION_STATUSES),
  lastHeartbeatAt: isoDateTimeSchema.nullable(),
  lastAttendanceSyncAt: isoDateTimeSchema.nullable(),
  lastEmployeeSyncAt: isoDateTimeSchema.nullable(),
  lastSuccessfulCommunicationAt: isoDateTimeSchema.nullable(),
  lastErrorCode: z.string().nullable(),
  lastError: z.string().nullable(),
  firmwareVersion: z.string().nullable(),
  offlineThresholdMinutes: z.number().int(),
  autoSyncEnabled: z.boolean(),
  syncIntervalMinutes: z.number().int(),
  employeeCount: z.number().int().optional(),
  tags: z.array(z.string()),
  maskedCredentials: jsonObjectSchema.optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type DeviceDto = z.infer<typeof deviceDtoSchema>;

/** Vendor-neutral raw transaction as produced by any provider (§21). */
export const rawTransactionSchema = z.object({
  providerTransactionId: z.string().max(200).nullable(),
  deviceEmployeeId: z.string().min(1).max(64),
  punchedAt: isoDateTimeSchema,
  deviceLocalTime: z.string().max(64).nullable().optional(),
  verificationMethod: z.enum(VERIFICATION_METHODS).default('unknown'),
  direction: z.enum(PUNCH_DIRECTIONS).default('unknown'),
  rawPayload: jsonObjectSchema.default({}),
});
export type RawTransaction = z.infer<typeof rawTransactionSchema>;

export const ingestRawBatchSchema = z.object({
  source: z.enum(RAW_SOURCES),
  syncJobId: uuidSchema.nullable().optional(),
  transactions: z.array(rawTransactionSchema).max(5000),
});
export type IngestRawBatch = z.infer<typeof ingestRawBatchSchema>;

/** Employee representation understood by devices (§34). No biometric templates by default. */
export const deviceEmployeeSchema = z.object({
  deviceUserId: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  cardNumber: z.string().max(64).nullable().optional(),
  pin: z.string().max(16).nullable().optional(),
  privilege: z.enum(['user', 'admin']).default('user'),
  enabled: z.boolean().default(true),
  photoUrl: z.url().nullable().optional(),
  /** Opaque vendor fields (never templates). */
  extra: jsonObjectSchema.default({}),
});
export type DeviceEmployee = z.infer<typeof deviceEmployeeSchema>;
