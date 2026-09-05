import { z } from 'zod';
import { MEMBERSHIP_STATUSES, ORG_STATUSES, RECORD_STATUSES } from './enums.js';
import { addressSchema, codeSchema, contactSchema, countryCodeSchema, currencyCodeSchema, emailSchema, isoDateTimeSchema, timezoneSchema, uuidSchema, weeklyOffDaysSchema } from './common.js';
import { PERMISSIONS } from './permissions.js';

export const organizationDtoSchema = z.object({
  id: uuidSchema,
  companyCode: z.string(),
  legalName: z.string(),
  displayName: z.string(),
  countryCode: z.string(),
  timezone: z.string(),
  currencyCode: z.string(),
  locale: z.string(),
  weeklyOffDays: z.array(z.number()),
  logoPath: z.string().nullable(),
  logoUrl: z.string().nullable().optional(),
  contact: contactSchema,
  address: addressSchema,
  status: z.enum(ORG_STATUSES),
  createdAt: isoDateTimeSchema,
});
export type OrganizationDto = z.infer<typeof organizationDtoSchema>;

export const createOrganizationSchema = z.object({
  companyCode: codeSchema,
  legalName: z.string().trim().min(2).max(200),
  displayName: z.string().trim().min(2).max(120),
  countryCode: countryCodeSchema.default('OM'),
  timezone: timezoneSchema.default('Asia/Muscat'),
  currencyCode: currencyCodeSchema.default('OMR'),
  locale: z.enum(['en', 'ar']).default('en'),
  weeklyOffDays: weeklyOffDaysSchema.default([5, 6]),
  contact: contactSchema.default({}),
  address: addressSchema.default({}),
  ownerEmail: emailSchema,
  ownerFullName: z.string().trim().min(1).max(160),
  planKey: z.string().default('trial'),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export const updateOrganizationSchema = createOrganizationSchema.omit({ ownerEmail: true, ownerFullName: true, planKey: true, companyCode: true }).partial();

export const organizationSettingsSchema = z.object({
  general: z.object({
    dateFormat: z.enum(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD']).default('DD/MM/YYYY'),
    timeFormat: z.enum(['24h', '12h']).default('24h'),
    firstDayOfWeek: z.number().int().min(0).max(6).default(0),
    calendar: z.enum(['gregorian', 'hijri_secondary']).default('gregorian'),
  }).partial().default({}),
  attendance: z.object({
    defaultShiftId: uuidSchema.nullable().optional(),
    processingDelaySeconds: z.number().int().min(0).max(3600).default(30),
    payrollPeriod: z.enum(['calendar_month', 'custom_cutoff']).default('calendar_month'),
    payrollCutoffDay: z.number().int().min(1).max(28).default(25),
    allowSelfServiceCorrections: z.boolean().default(false),
  }).partial().default({}),
  sync: z.object({
    defaultIntervalMinutes: z.number().int().min(1).max(1440).default(5),
    adaptivePolling: z.boolean().default(true),
    offlineThresholdMinutes: z.number().int().min(1).max(1440).default(15),
    autoPushNewEmployees: z.boolean().default(true),
    reconciliationIntervalHours: z.number().int().min(1).max(168).default(24),
  }).partial().default({}),
  notifications: z.object({
    deviceOffline: z.boolean().default(true),
    syncFailed: z.boolean().default(true),
    approvalPending: z.boolean().default(true),
    reportReady: z.boolean().default(true),
    dailyDigest: z.boolean().default(false),
  }).partial().default({}),
  security: z.object({
    mfaRequired: z.boolean().default(false),
    sessionIdleMinutes: z.number().int().min(5).max(1440).default(480),
    allowedEmailDomains: z.array(z.string().min(3)).max(20).default([]),
    exportRequiresReason: z.boolean().default(false),
  }).partial().default({}),
  integrations: z.object({}).partial().default({}),
});
export type OrganizationSettings = z.infer<typeof organizationSettingsSchema>;
export const SETTINGS_GROUPS = ['general', 'attendance', 'sync', 'notifications', 'security', 'integrations'] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

export const branchInputSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).optional(),
  countryCode: countryCodeSchema.default('OM'),
  city: z.string().trim().max(100).optional(),
  address: addressSchema.default({}),
  timezone: timezoneSchema.default('Asia/Muscat'),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  geofenceRadiusM: z.number().int().min(10).max(5000).optional(),
  contact: contactSchema.default({}),
  weeklyOffDays: weeklyOffDaysSchema.nullable().optional(),
  holidayCalendarId: uuidSchema.nullable().optional(),
  status: z.enum(RECORD_STATUSES).default('active'),
});
export type BranchInput = z.infer<typeof branchInputSchema>;

export const departmentInputSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).optional(),
  branchId: uuidSchema.nullable().optional(),
  parentId: uuidSchema.nullable().optional(),
  managerEmployeeId: uuidSchema.nullable().optional(),
  status: z.enum(RECORD_STATUSES).default('active'),
});
export const designationInputSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).optional(),
  level: z.number().int().min(0).max(100).default(0),
  status: z.enum(RECORD_STATUSES).default('active'),
});
export const teamInputSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(120),
  branchId: uuidSchema.nullable().optional(),
  leadEmployeeId: uuidSchema.nullable().optional(),
  memberIds: z.array(uuidSchema).max(500).optional(),
});

export const inviteMemberSchema = z.object({
  email: emailSchema,
  roleId: uuidSchema,
  allBranches: z.boolean().default(true),
  branchIds: z.array(uuidSchema).max(200).default([]),
  employeeId: uuidSchema.optional(),
}).refine((v) => v.allBranches || v.branchIds.length > 0, { message: 'Select at least one branch or grant all branches', path: ['branchIds'] });
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export const updateMemberSchema = z.object({
  roleId: uuidSchema.optional(),
  status: z.enum(MEMBERSHIP_STATUSES).optional(),
  allBranches: z.boolean().optional(),
  branchIds: z.array(uuidSchema).max(200).optional(),
  employeeId: uuidSchema.nullable().optional(),
});
export const roleInputSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300).optional(),
  permissions: z.array(z.enum(PERMISSIONS)).min(1),
});
export type RoleInput = z.infer<typeof roleInputSchema>;

/** Bootstrap payload returned by GET /me. UI gating only — the server re-checks everything. */
export const meDtoSchema = z.object({
  user: z.object({ id: uuidSchema, email: z.string(), fullName: z.string(), avatarUrl: z.string().nullable(), locale: z.string(), mfaEnrolled: z.boolean(), isPlatformAdmin: z.boolean() }),
  memberships: z.array(z.object({
    membershipId: uuidSchema,
    organization: organizationDtoSchema,
    roleId: uuidSchema,
    roleKey: z.string(),
    roleName: z.string(),
    permissions: z.array(z.string()),
    allBranches: z.boolean(),
    branchIds: z.array(uuidSchema),
    employeeId: uuidSchema.nullable(),
    featureFlags: z.record(z.string(), z.boolean()),
    settings: organizationSettingsSchema,
  })),
});
export type MeDto = z.infer<typeof meDtoSchema>;
