import { z } from 'zod';
import { EMPLOYMENT_STATUSES, EMPLOYMENT_TYPES, GENDERS, IDENTITY_DOCUMENT_TYPES } from './enums.js';
import { codeSchema, countryCodeSchema, emailSchema, isoDateSchema, isoDateTimeSchema, jsonObjectSchema, paginationQuerySchema, phoneSchema, uuidSchema, weeklyOffDaysSchema } from './common.js';

export const deviceUserIdSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{1,32}$/, 'Device user id: letters, digits, - _ (max 32)');

export const createEmployeeSchema = z.object({
  employeeNumber: codeSchema,
  firstName: z.string().trim().min(1).max(80),
  middleName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().min(1).max(80),
  displayName: z.string().trim().min(1).max(160).optional(),
  displayNameAr: z.string().trim().max(160).optional(),
  gender: z.enum(GENDERS).default('unspecified'),
  dateOfBirth: isoDateSchema.optional(),
  nationalityCode: countryCodeSchema.optional(),
  email: emailSchema.optional(),
  phone: phoneSchema.optional(),
  joiningDate: isoDateSchema,
  employmentStatus: z.enum(EMPLOYMENT_STATUSES).default('active'),
  employmentType: z.enum(EMPLOYMENT_TYPES).default('full_time'),
  branchId: uuidSchema,
  departmentId: uuidSchema.optional(),
  designationId: uuidSchema.optional(),
  managerEmployeeId: uuidSchema.optional(),
  deviceUserId: deviceUserIdSchema.optional(), // auto-assigned when omitted
  cardNumber: z.string().trim().max(64).optional(),
  pin: z.string().regex(/^\d{4,8}$/).optional(),
  weeklyOffDays: weeklyOffDaysSchema.optional(),
  customFields: jsonObjectSchema.optional(),
});
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

export const updateEmployeeSchema = createEmployeeSchema.partial().extend({
  exitDate: isoDateSchema.nullable().optional(),
  /** When branch/department/designation/manager/type/status change, the effective date of the change (defaults to today). */
  effectiveFrom: isoDateSchema.optional(),
  changeReason: z.string().max(500).optional(),
});
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

export const employeeListQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  branchId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  designationId: uuidSchema.optional(),
  employmentStatus: z.enum(EMPLOYMENT_STATUSES).optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  managerEmployeeId: uuidSchema.optional(),
  includeDeleted: z.coerce.boolean().default(false),
});
export type EmployeeListQuery = z.infer<typeof employeeListQuerySchema>;

export const employeeDtoSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  employeeNumber: z.string(),
  firstName: z.string(),
  middleName: z.string().nullable(),
  lastName: z.string(),
  displayName: z.string(),
  displayNameAr: z.string().nullable(),
  photoPath: z.string().nullable(),
  photoUrl: z.string().nullable().optional(),
  gender: z.enum(GENDERS),
  dateOfBirth: isoDateSchema.nullable(),
  nationalityCode: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  joiningDate: isoDateSchema,
  exitDate: isoDateSchema.nullable(),
  employmentStatus: z.enum(EMPLOYMENT_STATUSES),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  branchId: uuidSchema,
  branchName: z.string().optional(),
  departmentId: uuidSchema.nullable(),
  departmentName: z.string().nullable().optional(),
  designationId: uuidSchema.nullable(),
  designationName: z.string().nullable().optional(),
  managerEmployeeId: uuidSchema.nullable(),
  managerName: z.string().nullable().optional(),
  userId: uuidSchema.nullable(),
  deviceUserId: z.string(),
  cardNumber: z.string().nullable(),
  fingerprintEnrolled: z.boolean(),
  faceEnrolled: z.boolean(),
  weeklyOffDays: z.array(z.number()).nullable(),
  customFields: jsonObjectSchema,
  deviceSyncSummary: z.object({ total: z.number(), inSync: z.number(), pending: z.number(), failed: z.number(), offline: z.number() }).optional(),
  deletedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type EmployeeDto = z.infer<typeof employeeDtoSchema>;

export const bulkEmployeeActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assign_branch'), employeeIds: z.array(uuidSchema).min(1).max(1000), branchId: uuidSchema, effectiveFrom: isoDateSchema.optional() }),
  z.object({ action: z.literal('assign_department'), employeeIds: z.array(uuidSchema).min(1).max(1000), departmentId: uuidSchema.nullable(), effectiveFrom: isoDateSchema.optional() }),
  z.object({ action: z.literal('assign_shift'), employeeIds: z.array(uuidSchema).min(1).max(1000), shiftId: uuidSchema, effectiveFrom: isoDateSchema, effectiveTo: isoDateSchema.nullable().optional() }),
  z.object({ action: z.literal('sync_devices'), employeeIds: z.array(uuidSchema).min(1).max(1000), deviceIds: z.array(uuidSchema).max(500).optional() }),
  z.object({ action: z.literal('set_status'), employeeIds: z.array(uuidSchema).min(1).max(1000), employmentStatus: z.enum(EMPLOYMENT_STATUSES), effectiveFrom: isoDateSchema.optional() }),
  z.object({ action: z.literal('export'), employeeIds: z.array(uuidSchema).max(10000).optional(), format: z.enum(['csv', 'xlsx']).default('xlsx') }),
]);
export type BulkEmployeeAction = z.infer<typeof bulkEmployeeActionSchema>;

export const identityDocumentInputSchema = z.object({
  type: z.enum(IDENTITY_DOCUMENT_TYPES),
  number: z.string().trim().min(1).max(64),
  issuingCountry: countryCodeSchema.optional(),
  issuedAt: isoDateSchema.optional(),
  expiresAt: isoDateSchema.optional(),
  notes: z.string().max(500).optional(),
});

/** CSV/XLSX import row (§44). Column headers of the downloadable template. */
export const employeeImportRowSchema = createEmployeeSchema.omit({ branchId: true, departmentId: true, designationId: true, managerEmployeeId: true }).extend({
  branchCode: codeSchema,
  departmentCode: codeSchema.optional(),
  designationCode: codeSchema.optional(),
  managerEmployeeNumber: codeSchema.optional(),
});
export type EmployeeImportRow = z.infer<typeof employeeImportRowSchema>;
export const EMPLOYEE_IMPORT_COLUMNS = ['employeeNumber', 'firstName', 'middleName', 'lastName', 'displayName', 'gender', 'dateOfBirth', 'nationalityCode', 'email', 'phone', 'joiningDate', 'employmentStatus', 'employmentType', 'branchCode', 'departmentCode', 'designationCode', 'managerEmployeeNumber', 'deviceUserId', 'cardNumber'] as const;
