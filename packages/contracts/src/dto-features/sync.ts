import { z } from 'zod';
import { SYNC_ITEM_STATUSES } from '../enums.js';
import { paginationQuerySchema, uuidSchema } from '../common.js';

export const syncDeviceScopeSchema = z.object({
  deviceIds: z.array(uuidSchema).max(1000).optional(),
  branchId: uuidSchema.optional(),
  groupId: uuidSchema.optional(),
  all: z.boolean().default(false),
}).refine((v) => v.all || v.branchId || v.groupId || (v.deviceIds && v.deviceIds.length > 0), { message: 'Specify devices, a branch, a group, or all' });
export type SyncDeviceScope = z.infer<typeof syncDeviceScopeSchema>;

export const syncHealthCheckRequestSchema = syncDeviceScopeSchema;
export const syncReconcileRequestSchema = z.object({
  deviceIds: z.array(uuidSchema).max(1000).optional(),
  branchId: uuidSchema.optional(),
  groupId: uuidSchema.optional(),
  all: z.boolean().default(false),
  /** Create repair jobs (push/delete) for the differences found. */
  repair: z.boolean().default(false),
}).refine((v) => v.all || v.branchId || v.groupId || (v.deviceIds && v.deviceIds.length > 0), { message: 'Specify devices, a branch, a group, or all' });
export type SyncReconcileRequest = z.infer<typeof syncReconcileRequestSchema>;

export const syncJobItemsQuerySchema = paginationQuerySchema.extend({ status: z.enum(SYNC_ITEM_STATUSES).optional(), deviceId: uuidSchema.optional() });
export const reconciliationQuerySchema = z.object({ branchId: uuidSchema.optional(), deviceId: uuidSchema.optional() });

/**
 * 202 body for every sync-job-creating endpoint. `jobId` is the user-facing sync_jobs id. Items whose work is already in flight
 * (same dedupe key, e.g. a manual pull while the scheduled pull runs) are recorded as SKIPPED and covered by the running job;
 * when every item was skipped the job is already `SUCCESS` and nothing new was queued.
 */
export interface SyncJobAcceptedDto { jobId: string; status: 'QUEUED' | 'SUCCESS'; message: string; itemsTotal: number; itemsQueued: number; itemsSkipped: number; deviceCount: number }

export interface DeviceReconciliationDto {
  deviceId: string;
  deviceCode: string;
  deviceName: string;
  branchId: string;
  syncJobId: string | null;
  itemId: string | null;
  status: string | null;
  finishedAt: string | null;
  summary: Record<string, unknown> | null;
}
