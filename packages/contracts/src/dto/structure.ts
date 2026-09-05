import { z } from 'zod';
import { RECORD_STATUSES } from '../enums.js';
import { addressSchema, codeSchema, contactSchema, countryCodeSchema, isoDateTimeSchema, paginationQuerySchema, timezoneSchema, uuidSchema, weeklyOffDaysSchema } from '../common.js';

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
/** PATCH bodies: all optional, no creation defaults (a `.partial()` of the input schema would reset status/timezone/level). */
export const updateBranchSchema = z.object({
  code: codeSchema.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  nameAr: z.string().trim().max(120).nullable().optional(),
  countryCode: countryCodeSchema.optional(),
  city: z.string().trim().max(100).nullable().optional(),
  address: addressSchema.optional(),
  timezone: timezoneSchema.optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  geofenceRadiusM: z.number().int().min(10).max(5000).nullable().optional(),
  contact: contactSchema.optional(),
  weeklyOffDays: weeklyOffDaysSchema.nullable().optional(),
  holidayCalendarId: uuidSchema.nullable().optional(),
  status: z.enum(RECORD_STATUSES).optional(),
});
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;
export const updateDepartmentSchema = z.object({
  code: codeSchema.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  nameAr: z.string().trim().max(120).nullable().optional(),
  branchId: uuidSchema.nullable().optional(),
  parentId: uuidSchema.nullable().optional(),
  managerEmployeeId: uuidSchema.nullable().optional(),
  status: z.enum(RECORD_STATUSES).optional(),
});
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
export const updateDesignationSchema = z.object({
  code: codeSchema.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  nameAr: z.string().trim().max(120).nullable().optional(),
  level: z.number().int().min(0).max(100).optional(),
  status: z.enum(RECORD_STATUSES).optional(),
});
export type UpdateDesignationInput = z.infer<typeof updateDesignationSchema>;
export const updateTeamSchema = z.object({
  code: z.string().trim().min(1).max(32).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  branchId: uuidSchema.nullable().optional(),
  leadEmployeeId: uuidSchema.nullable().optional(),
  memberIds: z.array(uuidSchema).max(500).optional(),
  status: z.enum(RECORD_STATUSES).optional(),
});
