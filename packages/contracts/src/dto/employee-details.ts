import { z } from 'zod';
import { DEVICE_EMPLOYEE_SYNC_STATUSES, EMPLOYMENT_STATUSES, EMPLOYMENT_TYPES, IDENTITY_DOCUMENT_TYPES } from '../enums.js';
import { isoDateSchema, isoDateTimeSchema, uuidSchema } from '../common.js';

export const employmentHistoryDtoSchema = z.object({
  id: uuidSchema,
  employeeId: uuidSchema,
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.nullable(),
  branchId: uuidSchema,
  branchName: z.string().nullable().optional(),
  departmentId: uuidSchema.nullable(),
  departmentName: z.string().nullable().optional(),
  designationId: uuidSchema.nullable(),
  designationName: z.string().nullable().optional(),
  managerEmployeeId: uuidSchema.nullable(),
  managerName: z.string().nullable().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  employmentStatus: z.enum(EMPLOYMENT_STATUSES),
  reason: z.string().nullable(),
  createdBy: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type EmploymentHistoryDto = z.infer<typeof employmentHistoryDtoSchema>;

export const employeeDeviceStateDtoSchema = z.object({
  id: uuidSchema,
  deviceId: uuidSchema,
  deviceCode: z.string(),
  deviceName: z.string(),
  branchId: uuidSchema.nullable(),
  connectionStatus: z.string(),
  deviceUserId: z.string(),
  syncStatus: z.enum(DEVICE_EMPLOYEE_SYNC_STATUSES),
  desired: z.boolean(),
  lastSyncAt: isoDateTimeSchema.nullable(),
  lastSuccessAt: isoDateTimeSchema.nullable(),
  lastErrorCode: z.string().nullable(),
  lastError: z.string().nullable(),
  fingerprintCount: z.number().int(),
  faceEnrolled: z.boolean(),
  cardEnrolled: z.boolean(),
  updatedAt: isoDateTimeSchema,
});
export type EmployeeDeviceStateDto = z.infer<typeof employeeDeviceStateDtoSchema>;

export const identityDocumentDtoSchema = z.object({
  id: uuidSchema,
  employeeId: uuidSchema,
  type: z.enum(IDENTITY_DOCUMENT_TYPES),
  number: z.string(),
  issuingCountry: z.string().nullable(),
  issuedAt: isoDateSchema.nullable(),
  expiresAt: isoDateSchema.nullable(),
  filePath: z.string().nullable(),
  notes: z.string().nullable(),
  createdBy: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type IdentityDocumentDto = z.infer<typeof identityDocumentDtoSchema>;

export const deleteEmployeeSchema = z.object({
  exitDate: isoDateSchema.optional(),
  reason: z.string().max(500).optional(),
});
export type DeleteEmployeeInput = z.infer<typeof deleteEmployeeSchema>;
