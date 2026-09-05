import { z } from 'zod';
import { IMPORT_STATUSES } from '../enums.js';
import { isoDateTimeSchema, jsonObjectSchema, paginationQuerySchema, uuidSchema } from '../common.js';

export const IMPORT_ROW_STATUSES = ['valid', 'invalid', 'imported', 'skipped', 'failed'] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

/** JSON upload body (alternative to multipart/form-data with a `file` field). */
export const importUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  /** Base64-encoded file content (CSV). */
  contentBase64: z.string().min(1).max(20 * 1024 * 1024),
  options: z.object({
    /** Update existing employees matched by employee number instead of reporting them as duplicates. */
    updateExisting: z.boolean().default(false),
    autoAssignDeviceUserId: z.boolean().default(true),
  }).partial().default({}),
});
export type ImportUploadInput = z.infer<typeof importUploadSchema>;

export const importRowErrorSchema = z.object({ field: z.string().nullable(), message: z.string() });
export type ImportRowError = z.infer<typeof importRowErrorSchema>;

export const importJobRowDtoSchema = z.object({
  id: z.string(),
  rowNo: z.number().int(),
  data: jsonObjectSchema,
  errors: z.array(importRowErrorSchema),
  status: z.enum(IMPORT_ROW_STATUSES),
  entityId: uuidSchema.nullable(),
});
export type ImportJobRowDto = z.infer<typeof importJobRowDtoSchema>;

export const importJobDtoSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  type: z.string(),
  originalFilename: z.string().nullable(),
  status: z.enum(IMPORT_STATUSES),
  totalRows: z.number().int(),
  validRows: z.number().int(),
  errorRows: z.number().int(),
  importedRows: z.number().int(),
  options: jsonObjectSchema,
  summary: jsonObjectSchema.nullable(),
  error: z.string().nullable(),
  queueJobId: z.string().nullable(),
  requestedBy: uuidSchema.nullable(),
  requestedByName: z.string().nullable().optional(),
  confirmedBy: uuidSchema.nullable(),
  confirmedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  /** First rows (max 50) returned on upload and on detail. */
  preview: z.array(importJobRowDtoSchema).optional(),
});
export type ImportJobDto = z.infer<typeof importJobDtoSchema>;

export const importJobListQuerySchema = paginationQuerySchema.extend({ status: z.enum(IMPORT_STATUSES).optional() });
export const importJobRowsQuerySchema = paginationQuerySchema.extend({ status: z.enum(IMPORT_ROW_STATUSES).optional() });
