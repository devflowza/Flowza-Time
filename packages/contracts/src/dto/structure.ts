import { z } from 'zod';
import { RECORD_STATUSES } from '../enums.js';
import { addressSchema, contactSchema, isoDateTimeSchema, paginationQuerySchema, uuidSchema } from '../common.js';

/** Shared list filters for structure entities (branches, departments, designations, teams). */
export const structureListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(RECORD_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
  branchId: uuidSchema.optional(),
});
export type StructureListQuery = z.infer<typeof structureListQuerySchema>;

export const branchDtoSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  code: z.string(),
  name: z.string(),
  nameAr: z.string().nullable(),
  countryCode: z.string(),
  city: z.string().nullable(),
  address: addressSchema,
  timezone: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  geofenceRadiusM: z.number().int().nullable(),
  contact: contactSchema,
  weeklyOffDays: z.array(z.number()).nullable(),
  holidayCalendarId: uuidSchema.nullable(),
  status: z.enum(RECORD_STATUSES),
  employeeCount: z.number().int().optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type BranchDto = z.infer<typeof branchDtoSchema>;

export const departmentDtoSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  code: z.string(),
  name: z.string(),
  nameAr: z.string().nullable(),
  branchId: uuidSchema.nullable(),
  branchName: z.string().nullable().optional(),
  parentId: uuidSchema.nullable(),
  managerEmployeeId: uuidSchema.nullable(),
  managerName: z.string().nullable().optional(),
  status: z.enum(RECORD_STATUSES),
  employeeCount: z.number().int().optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type DepartmentDto = z.infer<typeof departmentDtoSchema>;

export const designationDtoSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  code: z.string(),
  name: z.string(),
  nameAr: z.string().nullable(),
  level: z.number().int(),
  status: z.enum(RECORD_STATUSES),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type DesignationDto = z.infer<typeof designationDtoSchema>;

export const teamMemberDtoSchema = z.object({
  employeeId: uuidSchema,
  employeeNumber: z.string(),
  displayName: z.string(),
  addedAt: isoDateTimeSchema,
});
export const teamDtoSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  code: z.string(),
  name: z.string(),
  branchId: uuidSchema.nullable(),
  branchName: z.string().nullable().optional(),
  leadEmployeeId: uuidSchema.nullable(),
  leadName: z.string().nullable().optional(),
  status: z.enum(RECORD_STATUSES),
  memberCount: z.number().int(),
  members: z.array(teamMemberDtoSchema).optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type TeamDto = z.infer<typeof teamDtoSchema>;
export const updateTeamSchema = z.object({
  code: z.string().trim().min(1).max(32).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  branchId: uuidSchema.nullable().optional(),
  leadEmployeeId: uuidSchema.nullable().optional(),
  memberIds: z.array(uuidSchema).max(500).optional(),
  status: z.enum(RECORD_STATUSES).optional(),
});
