import { z } from 'zod';
import { ORG_STATUSES, SUBSCRIPTION_STATUSES } from '../enums.js';
import { booleanQuerySchema, emailSchema, isoDateTimeSchema, paginationQuerySchema, uuidSchema } from '../common.js';
import { organizationDtoSchema } from '../organizations.js';
import { BILLING_CYCLES, subscriptionQuoteSchema } from './billing.js';

export const platformOrgListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(ORG_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
  planKey: z.string().trim().max(64).optional(),
  subscriptionStatus: z.enum(SUBSCRIPTION_STATUSES).optional(),
  /** Only tenants whose trial ends within this many days (dashboard "trials ending soon"). */
  trialEndingWithinDays: z.coerce.number().int().min(1).max(365).optional(),
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
  /** Platform account management (super-admin portal): account manager and tags — never shown to the tenant. */
  account: z.object({ accountManagerUserId: uuidSchema.nullable(), accountManagerEmail: z.string().nullable(), tags: z.array(z.string()) }).optional(),
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
  /**
   * Required for write grants: the second platform administrator, who must APPROVE the grant in their own session
   * (POST /platform/access-grants/:id/approve) before it starts — naming them approves nothing.
   */
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
  /** When the second approver approved a write grant (null for read grants and while pending). */
  approvedAt: isoDateTimeSchema.nullable(),
  /** A write grant waiting for its second approver: it grants nothing yet; its window starts on approval. */
  pendingApproval: z.boolean(),
  /** The caller is the named approver of this pending grant. */
  canApprove: z.boolean(),
  /** Requested duration of a pending write grant (hours), applied on approval. */
  requestedHours: z.number().int().nullable(),
  startsAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  revokedAt: isoDateTimeSchema.nullable(),
  active: z.boolean(),
  createdAt: isoDateTimeSchema,
});
/** A pending write grant must be approved within this many hours of its request, or it lapses. */
export const ACCESS_GRANT_APPROVAL_WINDOW_HOURS = 24;
export type AccessGrantDto = z.infer<typeof accessGrantDtoSchema>;

export const accessGrantListQuerySchema = paginationQuerySchema.extend({
  organizationId: uuidSchema.optional(),
  activeOnly: booleanQuerySchema.default(false),
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

// ------------------------------------------------------------------------------------------------------------------------------
// Super-admin portal (/adm) — migration 20260929000400
// ------------------------------------------------------------------------------------------------------------------------------

export const PLATFORM_ADMIN_LEVELS = ['support', 'admin', 'owner'] as const;
export type PlatformAdminLevel = (typeof PLATFORM_ADMIN_LEVELS)[number];

/** PATCH /platform/orgs/:id/subscription — at least one field besides the reason. Dates are ISO date-times, null clears. */
export const updateSubscriptionSchema = z.object({
  planKey: z.string().trim().min(1).max(64).optional(),
  status: z.enum(SUBSCRIPTION_STATUSES).optional(),
  trialEndsAt: isoDateTimeSchema.nullable().optional(),
  currentPeriodEnd: isoDateTimeSchema.nullable().optional(),
  cancelAt: isoDateTimeSchema.nullable().optional(),
  /** Billing cycle of the subscription (modules, plans & billing — migration 20260929000600). */
  billingCycle: z.enum(BILLING_CYCLES).optional(),
  /** Licensed users (active employees) the tenant pays for; null = the plan's employee limit. */
  seats: z.number().int().min(1).max(100_000).nullable().optional(),
  reason: z.string().trim().min(3).max(500),
}).refine((v) => v.planKey !== undefined || v.status !== undefined || v.trialEndsAt !== undefined || v.currentPeriodEnd !== undefined || v.cancelAt !== undefined
  || v.billingCycle !== undefined || v.seats !== undefined, {
  message: 'Change at least one field of the subscription.',
});
export type UpdateSubscriptionInput = z.infer<typeof updateSubscriptionSchema>;

export const platformSubscriptionDtoSchema = z.object({
  planKey: z.string(),
  planName: z.string(),
  status: z.enum(SUBSCRIPTION_STATUSES),
  trialEndsAt: isoDateTimeSchema.nullable(),
  currentPeriodStart: isoDateTimeSchema.nullable(),
  currentPeriodEnd: isoDateTimeSchema.nullable(),
  cancelAt: isoDateTimeSchema.nullable(),
  billingCycle: z.enum(BILLING_CYCLES),
  seats: z.number().int().nullable(),
  includedUsers: z.number().int().nullable(),
  isCustom: z.boolean(),
  /** Price of one billing cycle before VAT (null for custom / free plans). */
  price: subscriptionQuoteSchema.nullable(),
  updatedAt: isoDateTimeSchema.nullable(),
});
export type PlatformSubscriptionDto = z.infer<typeof platformSubscriptionDtoSchema>;

const tagSchema = z.string().trim().toLowerCase().min(1).max(40).regex(/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u, 'Letters, digits, space - _ . only');

/** PUT /platform/orgs/:id/account — the platform's account management of a tenant (never visible to the tenant). */
export const putTenantAccountSchema = z.object({
  accountManagerUserId: uuidSchema.nullable().optional(),
  tags: z.array(tagSchema).max(20).optional(),
});
export type PutTenantAccountInput = z.infer<typeof putTenantAccountSchema>;

export const tenantAccountDtoSchema = z.object({
  organizationId: uuidSchema,
  accountManager: z.object({ userId: uuidSchema, email: z.string(), fullName: z.string() }).nullable(),
  tags: z.array(z.string()),
  updatedAt: isoDateTimeSchema.nullable(),
});
export type TenantAccountDto = z.infer<typeof tenantAccountDtoSchema>;

export const createTenantNoteSchema = z.object({ body: z.string().trim().min(1).max(4000) });
export type CreateTenantNoteInput = z.infer<typeof createTenantNoteSchema>;
export const tenantNoteDtoSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  authorUserId: uuidSchema,
  authorLabel: z.string().nullable(),
  body: z.string(),
  createdAt: isoDateTimeSchema,
});
export type TenantNoteDto = z.infer<typeof tenantNoteDtoSchema>;

/** A member of a tenant as the platform console sees it (directory data only). */
export const platformMembershipDtoSchema = z.object({
  membershipId: uuidSchema,
  organizationId: uuidSchema,
  organizationName: z.string(),
  companyCode: z.string(),
  organizationStatus: z.enum(ORG_STATUSES),
  userId: uuidSchema,
  email: z.string(),
  fullName: z.string(),
  roleKey: z.string(),
  roleName: z.string(),
  status: z.string(),
  joinedAt: isoDateTimeSchema.nullable(),
  lastLoginAt: isoDateTimeSchema.nullable(),
  mfaEnrolled: z.boolean(),
});
export type PlatformMembershipDto = z.infer<typeof platformMembershipDtoSchema>;

export const platformInvitationDtoSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  roleName: z.string(),
  expiresAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  expired: z.boolean(),
});
export type PlatformInvitationDto = z.infer<typeof platformInvitationDtoSchema>;

export const platformOrgMembersDtoSchema = z.object({
  members: z.array(platformMembershipDtoSchema),
  /** Pending invitations (not accepted, not revoked). */
  invitations: z.array(platformInvitationDtoSchema),
});
export type PlatformOrgMembersDto = z.infer<typeof platformOrgMembersDtoSchema>;

/** An audit entry written by a platform administrator (GET /platform/activity). */
export const platformAuditEntryDtoSchema = z.object({
  id: z.string(),
  organizationId: uuidSchema.nullable(),
  organizationName: z.string().nullable(),
  actorUserId: uuidSchema.nullable(),
  actorLabel: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  oldValue: z.unknown().nullable(),
  newValue: z.unknown().nullable(),
  reason: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type PlatformAuditEntryDto = z.infer<typeof platformAuditEntryDtoSchema>;

export const platformActivityQuerySchema = paginationQuerySchema.extend({
  organizationId: uuidSchema.optional(),
  actorUserId: uuidSchema.optional(),
  action: z.string().trim().max(100).optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
});

export const platformUserListQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  platformAdmin: booleanQuerySchema.optional(),
});

export const platformUserDtoSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  fullName: z.string(),
  status: z.string(),
  mfaEnrolled: z.boolean(),
  lastLoginAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  platformAdminLevel: z.enum(PLATFORM_ADMIN_LEVELS).nullable(),
  platformAdminStatus: z.string().nullable(),
  membershipCount: z.number().int(),
});
export type PlatformUserDto = z.infer<typeof platformUserDtoSchema>;

export const platformUserDetailDtoSchema = platformUserDtoSchema.extend({
  memberships: z.array(platformMembershipDtoSchema),
});
export type PlatformUserDetailDto = z.infer<typeof platformUserDetailDtoSchema>;

export const platformAdminDtoSchema = z.object({
  userId: uuidSchema,
  email: z.string(),
  fullName: z.string(),
  level: z.enum(PLATFORM_ADMIN_LEVELS),
  status: z.enum(['active', 'disabled']),
  mfaEnrolled: z.boolean(),
  lastLoginAt: isoDateTimeSchema.nullable(),
  grantedByEmail: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  isSelf: z.boolean(),
});
export type PlatformAdminDto = z.infer<typeof platformAdminDtoSchema>;

/** POST /platform/admins — the person must already have a FlowZa Time account (they signed up or were invited once). */
export const createPlatformAdminSchema = z.object({
  email: emailSchema,
  level: z.enum(PLATFORM_ADMIN_LEVELS).default('support'),
});
export type CreatePlatformAdminInput = z.infer<typeof createPlatformAdminSchema>;
/** PATCH /platform/admins/:userId — no defaults (a PATCH must not reset omitted fields). */
export const updatePlatformAdminSchema = z.object({
  level: z.enum(PLATFORM_ADMIN_LEVELS).optional(),
  status: z.enum(['active', 'disabled']).optional(),
}).refine((v) => v.level !== undefined || v.status !== undefined, { message: 'Change the level or the status.' });
export type UpdatePlatformAdminInput = z.infer<typeof updatePlatformAdminSchema>;

/** GET /platform/overview — the super-admin dashboard. */
export const platformOverviewDtoSchema = z.object({
  time: isoDateTimeSchema,
  organizations: z.object({ total: z.number().int(), byStatus: z.record(z.string(), z.number().int()), newLast30Days: z.number().int() }),
  subscriptions: z.object({
    byStatus: z.record(z.string(), z.number().int()),
    byPlan: z.array(z.object({ planKey: z.string(), planName: z.string(), count: z.number().int() })),
  }),
  totals: z.object({ users: z.number().int(), employees: z.number().int(), devices: z.number().int(), branches: z.number().int(), memberships: z.number().int() }),
  platformAdmins: z.number().int(),
  activeGrants: z.number().int(),
  pendingGrants: z.number().int(),
  trialsEndingSoon: z.array(z.object({ id: uuidSchema, displayName: z.string(), companyCode: z.string(), trialEndsAt: isoDateTimeSchema })),
  recentOrganizations: z.array(z.object({ id: uuidSchema, displayName: z.string(), companyCode: z.string(), status: z.enum(ORG_STATUSES), planName: z.string().nullable(), createdAt: isoDateTimeSchema })),
  recentActivity: z.array(platformAuditEntryDtoSchema),
});
export type PlatformOverviewDto = z.infer<typeof platformOverviewDtoSchema>;
