import { z } from 'zod';
import { ORG_STATUSES, SUBSCRIPTION_STATUSES } from '../enums.js';
import { isoDateTimeSchema, paginationQuerySchema, uuidSchema } from '../common.js';
import { organizationDtoSchema } from '../organizations.js';

export const platformOrgListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(ORG_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
});

export const platformOrganizationDtoSchema = organizationDtoSchema.extend({
  legalHold: z.boolean(),
  regionCell: z.string(),
  subscription: z.object({
    planKey: z.string(),
    planName: z.string(),
    status: z.enum(SUBSCRIPTION_STATUSES),
    trialEndsAt: isoDateTimeSchema.nullable(),
    currentPeriodEnd: isoDateTimeSchema.nullable(),
  }).nullable(),
  counts: z.object({ employees: z.number().int(), devices: z.number().int(), branches: z.number().int(), users: z.number().int() }).optional(),
  updatedAt: isoDateTimeSchema,
});
export type PlatformOrganizationDto = z.infer<typeof platformOrganizationDtoSchema>;

export const updateOrganizationStatusSchema = z.object({
  status: z.enum(ORG_STATUSES),
  reason: z.string().trim().min(3).max(500),
});

export const createAccessGrantSchema = z.object({
  organizationId: uuidSchema,
  /** Defaults to the calling platform admin. */
  platformAdminUserId: uuidSchema.optional(),
  accessLevel: z.enum(['read', 'write']).default('read'),
  reason: z.string().trim().min(10).max(1000),
  ticketRef: z.string().trim().max(100).optional(),
  /** Duration in hours (default 8, max 72 — enforced by the database as well). */
  hours: z.number().int().min(1).max(72).default(8),
  /** Required for write grants (second approver). */
  approvedBy: uuidSchema.optional(),
});
export type CreateAccessGrantInput = z.infer<typeof createAccessGrantSchema>;

export const accessGrantDtoSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  organizationName: z.string().nullable().optional(),
  platformAdminUserId: uuidSchema,
  platformAdminEmail: z.string().nullable().optional(),
  accessLevel: z.enum(['read', 'write']),
  reason: z.string(),
  ticketRef: z.string().nullable(),
  grantedBy: uuidSchema.nullable(),
  approvedBy: uuidSchema.nullable(),
  startsAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  revokedAt: isoDateTimeSchema.nullable(),
  active: z.boolean(),
  createdAt: isoDateTimeSchema,
});
export type AccessGrantDto = z.infer<typeof accessGrantDtoSchema>;

export const accessGrantListQuerySchema = paginationQuerySchema.extend({
  organizationId: uuidSchema.optional(),
  activeOnly: z.coerce.boolean().default(false),
});

export const planDtoSchema = z.object({
  id: uuidSchema,
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  prices: z.record(z.string(), z.unknown()),
  limits: z.record(z.string(), z.unknown()),
  features: z.array(z.string()),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
});
export type PlanDto = z.infer<typeof planDtoSchema>;

export const featureFlagDtoSchema = z.object({
  key: z.string(),
  description: z.string(),
  defaultEnabled: z.boolean(),
  rolloutPercentage: z.number().int(),
  updatedAt: isoDateTimeSchema,
});
export type FeatureFlagDto = z.infer<typeof featureFlagDtoSchema>;
export const upsertFeatureFlagSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  description: z.string().trim().min(1).max(300).optional(),
  defaultEnabled: z.boolean().optional(),
  rolloutPercentage: z.number().int().min(0).max(100).optional(),
});
export const putFeatureFlagsSchema = z.object({ flags: z.array(upsertFeatureFlagSchema).min(1).max(100) });
export const putOrgFeatureFlagsSchema = z.object({
  /** flag key → enabled; null removes the organisation override (falls back to the default). */
  flags: z.record(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/), z.boolean().nullable()),
});
export const orgFeatureFlagDtoSchema = z.object({
  key: z.string(),
  description: z.string(),
  defaultEnabled: z.boolean(),
  override: z.boolean().nullable(),
  effective: z.boolean(),
});
export type OrgFeatureFlagDto = z.infer<typeof orgFeatureFlagDtoSchema>;

export const platformHealthDtoSchema = z.object({
  time: isoDateTimeSchema,
  queue: z.array(z.object({ queueName: z.string(), status: z.string(), count: z.number().int(), oldestRunAt: isoDateTimeSchema.nullable() })),
  organizations: z.record(z.string(), z.number().int()),
  platformAdmins: z.number().int(),
  activeGrants: z.number().int(),
});
export type PlatformHealthDto = z.infer<typeof platformHealthDtoSchema>;

/** Response of POST /platform/orgs. */
export const createOrganizationResultSchema = z.object({
  organization: organizationDtoSchema,
  ownerMembershipId: uuidSchema.nullable(),
  /** Set when the owner had no account yet: an invitation was created instead of a membership. */
  invitation: z.object({ id: uuidSchema, email: z.string(), token: z.string(), expiresAt: isoDateTimeSchema }).nullable(),
});
export type CreateOrganizationResult = z.infer<typeof createOrganizationResultSchema>;
