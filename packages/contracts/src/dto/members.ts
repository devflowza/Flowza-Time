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
  /** Employee record the membership is linked to when the invitation is accepted (chosen while inviting). */
  employeeId: uuidSchema.nullable().optional(),
  employeeNumber: z.string().nullable().optional(),
  expiresAt: isoDateTimeSchema,
  acceptedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  /** Present only in the response of the request that created the invitation. */
  token: z.string().optional(),
  /** Present when the invitee already had an account and a membership was created directly. */
  membershipId: uuidSchema.nullable().optional(),
  /** When the worker last e-mailed the invitation (null until it has). */
  deliverySentAt: isoDateTimeSchema.nullable().optional(),
});
export type InvitationDto = z.infer<typeof invitationDtoSchema>;
/** Worker job that e-mails an invitation (it mints the e-mailed token and stores only its hash). */
export const INVITATION_EMAIL_JOB_TYPE = 'SEND_INVITATION_EMAIL';

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

// ----- invitations parity (HR portal Prompt 6b, Finance B-67 … B-76) -----------------------------------------------------------

/** What a token stands for, without accepting it. */
export const INVITATION_STATES = ['valid', 'accepted', 'revoked', 'expired'] as const;
export type InvitationState = (typeof INVITATION_STATES)[number];

/** POST /invitations/validate (public, rate limited): the token's state and who it is for, masked. Nothing is accepted. */
/**
 * POST /invitations/validate. Any token string up to 256 characters reaches the lookup (HR portal Prompt 5 review, P2-7): a
 * malformed token and an unknown one get the same 404 after the same work; only a body without a token string is a 400.
 */
export const validateInvitationSchema = z.object({ token: z.string().min(1).max(256) });
export type ValidateInvitationInput = z.infer<typeof validateInvitationSchema>;
export interface InvitationPreviewDto {
  state: InvitationState;
  organizationName: string;
  /** Name of the linked employee record, when the invitation carries one. */
  employeeName: string | null;
  /** The invited address with most of it hidden (`a***@e***.com`): enough to recognise, not to harvest. */
  emailMasked: string;
  expiresAt: string;
}

/** The portal (FlowZa Time login) state of one employee record. */
export const PORTAL_ACCESS_STATES = ['none', 'invited', 'active', 'suspended'] as const;
export type PortalAccessState = (typeof PORTAL_ACCESS_STATES)[number];
export interface EmployeePortalAccessDto {
  employeeId: string;
  state: PortalAccessState;
  /** The membership linked to the employee (active, invited or suspended), if any. */
  membership: { id: string; userId: string; email: string; fullName: string; roleId: string; roleName: string; status: 'invited' | 'active' | 'suspended'; lastLoginAt: string | null } | null;
  /** The pending invitation carrying this employee, if any (expired ones included, flagged). */
  invitation: { id: string; email: string; roleId: string; roleName: string | null; expiresAt: string; createdAt: string; expired: boolean } | null;
  /**
   * The addresses on the employee record an invitation could go to (HR portal Prompt 5 review, P0-2) — offered as choices,
   * NEVER as a default: people who hold `employee.update` but not `user.manage` can edit these fields, so the administrator
   * picks one knowingly, seeing where it comes from and who last changed it.
   */
  addresses: PortalAccessAddressDto[];
  /** The employee left (terminated / resigned / archived): access cannot be granted or restored. */
  employeeLeft: boolean;
}

/** Days within which a change of an address field by somebody other than the administrator is flagged. */
export const PORTAL_ADDRESS_RECENT_CHANGE_DAYS = 7;
/** A known address of the employee (work e-mail field, or the `personalEmail` custom field) and its provenance. */
export interface PortalAccessAddressDto {
  email: string;
  source: 'work' | 'personal';
  /** When the field last changed, from the audit log (null: no change recorded — e.g. seeded or imported). */
  changedAt: string | null;
  changedByUserId: string | null;
  changedByName: string | null;
  /** Changed within the last PORTAL_ADDRESS_RECENT_CHANGE_DAYS days by somebody other than the caller: confirm before inviting. */
  recentlyChangedByOther: boolean;
}

/**
 * POST /orgs/:orgId/employees/:id/portal-access/invite — the address is REQUIRED (review P0-2: the server never defaults it
 * from employee fields); role defaults to `employee`, scope to the employee's own branch.
 */
export const portalAccessInviteSchema = z.object({
  email: emailSchema,
  roleId: uuidSchema.optional(),
  /** Absent = the employee's own branch only. */
  allBranches: z.boolean().optional(),
  branchIds: z.array(uuidSchema).max(200).optional(),
});
export type PortalAccessInviteInput = z.infer<typeof portalAccessInviteSchema>;

/** Revoke / restore portal access (suspends / reactivates the linked login; the employee link stays). */
export const portalAccessChangeSchema = z.object({ reason: z.string().trim().max(500).optional() });
export type PortalAccessChangeInput = z.infer<typeof portalAccessChangeSchema>;

/** What a resend did: a fresh invitation (the old token is revoked) or a suspended login restored (Finance B-69). */
export interface PortalAccessResendResultDto { action: 'reinvited' | 'restored'; invitation: InvitationDto | null; access: EmployeePortalAccessDto }
