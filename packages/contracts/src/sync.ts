import { z } from 'zod';
import { SYNC_ITEM_STATUSES, SYNC_JOB_TYPES, SYNC_STATUSES, SYNC_TRIGGERS } from './enums.js';
import { isoDateTimeSchema, paginationQuerySchema, uuidSchema } from './common.js';

export const syncAttendanceRequestSchema = z.object({
  deviceIds: z.array(uuidSchema).max(1000).optional(),
  branchId: uuidSchema.optional(),
  groupId: uuidSchema.optional(),
  all: z.boolean().default(false),
  /** Force a full re-pull from the provider's earliest cursor (reconciliation). */
  fullResync: z.boolean().default(false),
}).refine((v) => v.all || v.branchId || v.groupId || (v.deviceIds && v.deviceIds.length > 0), { message: 'Specify devices, a branch, a group, or all' });
export type SyncAttendanceRequest = z.infer<typeof syncAttendanceRequestSchema>;

export const syncEmployeesRequestSchema = z.object({
  employeeIds: z.array(uuidSchema).max(5000).optional(),
  branchId: uuidSchema.optional(),
  deviceIds: z.array(uuidSchema).max(1000).optional(),
  all: z.boolean().default(false),
  /** Also remove employees that should no longer exist on the device. */
  removeStale: z.boolean().default(false),
}).refine((v) => v.all || v.branchId || (v.employeeIds && v.employeeIds.length > 0) || (v.deviceIds && v.deviceIds.length > 0), { message: 'Specify employees, devices, a branch, or all' });
export type SyncEmployeesRequest = z.infer<typeof syncEmployeesRequestSchema>;

export const syncJobDtoSchema = z.object({
  id: uuidSchema,
  jobType: z.enum(SYNC_JOB_TYPES),
  trigger: z.enum(SYNC_TRIGGERS),
  scope: z.record(z.string(), z.unknown()),
  status: z.enum(SYNC_STATUSES),
  priority: z.number().int(),
  itemsTotal: z.number().int(),
  itemsSuccess: z.number().int(),
  itemsFailed: z.number().int(),
  itemsPending: z.number().int(),
  itemsOffline: z.number().int(),
  itemsUnsupported: z.number().int(),
  recordsIngested: z.number().int(),
  requestedBy: uuidSchema.nullable(),
  requestedByName: z.string().nullable().optional(),
  correlationId: z.string(),
  errorCode: z.string().nullable(),
  error: z.string().nullable(),
  summary: z.record(z.string(), z.unknown()).nullable(),
  queuedAt: isoDateTimeSchema.nullable(),
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type SyncJobDto = z.infer<typeof syncJobDtoSchema>;

export const syncJobItemDtoSchema = z.object({
  id: uuidSchema,
  syncJobId: uuidSchema,
  deviceId: uuidSchema.nullable(),
  deviceName: z.string().nullable().optional(),
  deviceCode: z.string().nullable().optional(),
  employeeId: uuidSchema.nullable(),
  employeeNumber: z.string().nullable().optional(),
  employeeName: z.string().nullable().optional(),
  operation: z.enum(SYNC_JOB_TYPES),
  status: z.enum(SYNC_ITEM_STATUSES),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  nextAttemptAt: isoDateTimeSchema.nullable(),
  lastErrorCode: z.string().nullable(),
  lastError: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  recordsIngested: z.number().int(),
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
});
export type SyncJobItemDto = z.infer<typeof syncJobItemDtoSchema>;

export const syncJobListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(SYNC_STATUSES).optional(),
  jobType: z.enum(SYNC_JOB_TYPES).optional(),
  deviceId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
});

/** Realtime broadcast payloads (channel org:<id>:sync). */
export const syncProgressEventSchema = z.object({
  type: z.literal('sync.progress'),
  jobId: uuidSchema,
  status: z.enum(SYNC_STATUSES),
  itemsTotal: z.number().int(),
  itemsSuccess: z.number().int(),
  itemsFailed: z.number().int(),
  itemsPending: z.number().int(),
  itemsOffline: z.number().int(),
  itemsUnsupported: z.number().int(),
  recordsIngested: z.number().int(),
  at: isoDateTimeSchema,
});
export type SyncProgressEvent = z.infer<typeof syncProgressEventSchema>;
export const deviceStatusEventSchema = z.object({
  type: z.literal('device.status'),
  deviceId: uuidSchema,
  connectionStatus: z.string(),
  lastHeartbeatAt: isoDateTimeSchema.nullable(),
  at: isoDateTimeSchema,
});
export type DeviceStatusEvent = z.infer<typeof deviceStatusEventSchema>;
export const realtimeEventSchema = z.discriminatedUnion('type', [syncProgressEventSchema, deviceStatusEventSchema]);
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

/** Domain event names emitted to the outbox (§83). */
export const DOMAIN_EVENT_TYPES = [
  'employee.created', 'employee.updated', 'employee.deleted', 'employee.imported',
  'device.created', 'device.updated', 'device.online', 'device.offline', 'device.credentials_changed',
  'sync.queued', 'sync.completed', 'sync.failed', 'sync.item_failed',
  'attendance.created', 'attendance.updated', 'attendance.correction_submitted', 'attendance.correction_approved', 'attendance.correction_rejected',
  'approval.pending', 'report.ready', 'report.failed', 'subscription.limit_reached',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];
