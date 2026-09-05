import { z } from 'zod';
import { isoDateTimeSchema, paginationQuerySchema, uuidSchema } from '../common.js';

export const auditLogQuerySchema = paginationQuerySchema.extend({
  entityType: z.string().trim().max(64).optional(),
  entityId: z.string().trim().max(128).optional(),
  actorUserId: uuidSchema.optional(),
  action: z.string().trim().max(64).optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  branchId: uuidSchema.optional(),
});
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

export const auditLogDtoSchema = z.object({
  id: z.string(),
  organizationId: uuidSchema.nullable(),
  actorUserId: uuidSchema.nullable(),
  actorType: z.string(),
  actorLabel: z.string().nullable(),
  actorName: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  branchId: uuidSchema.nullable(),
  oldValue: z.unknown().nullable(),
  newValue: z.unknown().nullable(),
  reason: z.string().nullable(),
  ip: z.string().nullable(),
  requestId: z.string().nullable(),
  jobId: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type AuditLogDto = z.infer<typeof auditLogDtoSchema>;
