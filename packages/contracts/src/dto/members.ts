import { z } from 'zod';
import { MEMBERSHIP_STATUSES } from '../enums.js';
import { emailSchema, isoDateTimeSchema, paginationQuerySchema, uuidSchema } from '../common.js';
import { PERMISSIONS } from '../permissions.js';

export const memberListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(MEMBERSHIP_STATUSES).optional(),
  roleId: uuidSchema.optional(),
  search: z.string().trim().max(100).optional(),
});
export type MemberListQuery = z.infer<typeof memberListQuerySchema>;

export const memberDtoSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  userId: uuidSchema,
  email: z.string(),
  fullName: z.string(),
  avatarPath: z.string().nullable(),
  roleId: uuidSchema,
  roleKey: z.string(),
  roleName: z.string(),
  status: z.enum(MEMBERSHIP_STATUSES),
  allBranches: z.boolean(),
  branchIds: z.array(uuidSchema),
  branchNames: z.array(z.string()).optional(),
  employeeId: uuidSchema.nullable(),
  employeeNumber: z.string().nullable().optional(),
  lastLoginAt: isoDateTimeSchema.nullable(),
  joinedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type MemberDto = z.infer<typeof memberDtoSchema>;

export const invitationDtoSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  email: z.string(),
  roleId: uuidSchema,
  roleName: z.string().optional(),
  allBranches: z.boolean(),
  branchIds: z.array(uuidSchema),
  invitedBy: uuidSchema.nullable(),
  invitedByName: z.string().nullable().optional(),
  expiresAt: isoDateTimeSchema,
  acceptedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  /** Present only in the response of the request that created the invitation. */
  token: z.string().optional(),
  /** Present when the invitee already had an account and a membership was created directly. */
  membershipId: uuidSchema.nullable().optional(),
});
export type InvitationDto = z.infer<typeof invitationDtoSchema>;

export const acceptInvitationSchema = z.object({ token: z.string().min(16).max(256) });
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

export const permissionDtoSchema = z.object({
  key: z.enum(PERMISSIONS),
  category: z.string(),
  description: z.string(),
  sortOrder: z.number().int(),
});
export type PermissionDto = z.infer<typeof permissionDtoSchema>;

export const roleDtoSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema.nullable(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  permissions: z.array(z.string()),
  memberCount: z.number().int().optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type RoleDto = z.infer<typeof roleDtoSchema>;
export const updateRoleSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(300).nullable().optional(),
  permissions: z.array(z.enum(PERMISSIONS)).min(1).optional(),
});
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

export const updateMeSchema = z.object({
  fullName: z.string().trim().min(1).max(160).optional(),
  locale: z.enum(['en', 'ar']).optional(),
});
export type UpdateMeInput = z.infer<typeof updateMeSchema>;

export const userProfileDtoSchema = z.object({
  id: uuidSchema,
  email: emailSchema.or(z.string()),
  fullName: z.string(),
  avatarPath: z.string().nullable(),
  locale: z.string(),
  mfaEnrolled: z.boolean(),
  status: z.string(),
  lastLoginAt: isoDateTimeSchema.nullable(),
});
export type UserProfileDto = z.infer<typeof userProfileDtoSchema>;
