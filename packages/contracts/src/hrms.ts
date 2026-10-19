import { z } from 'zod';
import { EMPLOYMENT_STATUSES, EMPLOYMENT_TYPES, GENDERS, IMPORT_STATUSES } from './enums.js';
import { codeSchema, isoDateTimeSchema, uuidSchema } from './common.js';

/*
 * HR system (HRMS) integration and the import kinds it shares with the import page (docs/integrations/hrms.md).
 *
 * An HR system — Mawred Plus (Oman's government HR system) or any other — pushes employees and organisational units to
 * `POST /api/v1/inbound/hrms/{employees|org-units}` with an organisation API key. Each batch becomes an import job of the
 * same pipeline as a file uploaded on the import page (validated rows → EXECUTE_IMPORT in the worker), so a batch and a
 * spreadsheet obey exactly the same rules. The HR system's field names are translated by a mapping the administrator
 * edits in Settings → HR system (a preset is only the starting point).
 */

/** What an import creates or updates: employees (by employee number) or organisational units (departments, by code). */
export const IMPORT_KINDS = ['EMPLOYEES', 'ORG_UNITS'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/** Where an import came from: a file uploaded by a person, or a batch an HR system sent with an API key. */
export const IMPORT_SOURCES = ['upload', 'hrms'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/** Org-unit statuses an import may set (archiving stays a deliberate action on the department page: children / employees). */
export const ORG_UNIT_IMPORT_STATUSES = ['active', 'inactive'] as const;

/** One organisational unit (department) of an import: upserted by `code`; the parent is linked by its code in a second pass. */
export const orgUnitImportRowSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).optional(),
  parentCode: codeSchema.optional(),
  branchCode: codeSchema.optional(),
  managerEmployeeNumber: codeSchema.optional(),
  status: z.enum(ORG_UNIT_IMPORT_STATUSES).optional(),
});
export type OrgUnitImportRow = z.infer<typeof orgUnitImportRowSchema>;
/** Column headers of the org-unit template. */
export const ORG_UNIT_IMPORT_COLUMNS = ['code', 'name', 'nameAr', 'parentCode', 'branchCode', 'managerEmployeeNumber', 'status'] as const;
export const ORG_UNIT_IMPORT_REQUIRED_COLUMNS = ['code', 'name'] as const;

// ---------------------------------------------------------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------------------------------------------------------

/** FlowZa fields an HR system's employee record can be mapped to (the import columns, plus the Arabic name and civil ID). */
export const HRMS_EMPLOYEE_FIELDS = [
  'employeeNumber', 'civilId', 'firstName', 'middleName', 'lastName', 'displayName', 'displayNameAr', 'gender', 'dateOfBirth', 'nationalityCode',
  'email', 'phone', 'joiningDate', 'exitDate', 'employmentStatus', 'employmentType', 'branchCode', 'departmentCode', 'designationCode',
  'managerEmployeeNumber', 'deviceUserId', 'cardNumber',
] as const;
export type HrmsEmployeeField = (typeof HRMS_EMPLOYEE_FIELDS)[number];
/** FlowZa fields an HR system's organisational unit can be mapped to. */
export const HRMS_ORG_UNIT_FIELDS = ORG_UNIT_IMPORT_COLUMNS;
export type HrmsOrgUnitField = (typeof HRMS_ORG_UNIT_FIELDS)[number];

export const HRMS_PRESETS = ['generic', 'mawred_plus'] as const;
export type HrmsPreset = (typeof HRMS_PRESETS)[number];

/** A field name of the HR system's records (the key of the JSON object it sends). */
export const hrmsSourceFieldSchema = z.string().trim().min(1).max(64).regex(/^[^\s<>"'`]+$/, 'No spaces or quotes');
/** A value of the HR system (an Arabic or English status / gender label) translated to a FlowZa value. */
const hrmsSourceValueSchema = z.string().trim().min(1).max(64);
/** At most this many entries per mapping (an HR record rarely has more than ~40 fields). */
export const HRMS_MAPPING_MAX = 80;

/*
 * Stored as LISTS of { source, target } pairs, not as objects keyed by the source name: the database client camel-cases the
 * keys of JSON objects it reads (`employee_no` would come back as `employeeNo`), and an HR system's names are whatever it uses.
 */
const pairsOf = <T extends readonly [string, ...string[]]>(source: z.ZodString, targets: T) => z.array(z.object({ source, target: z.enum(targets) })).max(HRMS_MAPPING_MAX)
  .refine((pairs) => new Set(pairs.map((p) => p.source.toLowerCase())).size === pairs.length, { message: 'Each source name may appear once' });

export const hrmsEmployeeMappingSchema = pairsOf(hrmsSourceFieldSchema, HRMS_EMPLOYEE_FIELDS);
export const hrmsOrgUnitMappingSchema = pairsOf(hrmsSourceFieldSchema, HRMS_ORG_UNIT_FIELDS);
export const hrmsStatusMappingSchema = pairsOf(hrmsSourceValueSchema, EMPLOYMENT_STATUSES);
export const hrmsGenderMappingSchema = pairsOf(hrmsSourceValueSchema, GENDERS);
export const hrmsEmploymentTypeMappingSchema = pairsOf(hrmsSourceValueSchema, EMPLOYMENT_TYPES);
export type HrmsMappingPair<T extends string = string> = { source: string; target: T };
/** Source name → FlowZa field (the in-memory form a preset is written in and the mapping is applied with). */
export type HrmsEmployeeMapping = Record<string, HrmsEmployeeField>;
export type HrmsOrgUnitMapping = Record<string, HrmsOrgUnitField>;

export interface HrmsPresetDefinition {
  employeeMapping: HrmsEmployeeMapping;
  orgUnitMapping: HrmsOrgUnitMapping;
  statusMapping: Record<string, (typeof EMPLOYMENT_STATUSES)[number]>;
  genderMapping: Record<string, (typeof GENDERS)[number]>;
  employmentTypeMapping: Record<string, (typeof EMPLOYMENT_TYPES)[number]>;
}

/**
 * Starting mappings per preset. `generic` expects FlowZa's own field names (an empty mapping: names are matched as they are).
 * `mawred_plus` is a STARTING POINT built from the fields an Omani government HR record typically carries (civil ID, employee
 * number, Arabic and English names, organisational unit code, job title, hire date, employment status). Mawred Plus does not
 * publish its export field names, so every organisation checks the names its own Mawred Plus extract or middleware uses and
 * edits the mapping (docs/integrations/hrms.md §3).
 */
export const HRMS_PRESET_DEFINITIONS: Readonly<Record<HrmsPreset, HrmsPresetDefinition>> = {
  generic: { employeeMapping: {}, orgUnitMapping: {}, statusMapping: {}, genderMapping: {}, employmentTypeMapping: {} },
  mawred_plus: {
    employeeMapping: {
      CivilID: 'civilId', EmployeeNo: 'employeeNumber',
      FirstNameEn: 'firstName', MiddleNameEn: 'middleName', LastNameEn: 'lastName', FullNameEn: 'displayName', FullNameAr: 'displayNameAr',
      Gender: 'gender', BirthDate: 'dateOfBirth', NationalityCode: 'nationalityCode', Email: 'email', MobileNo: 'phone',
      HireDate: 'joiningDate', ServiceEndDate: 'exitDate', EmploymentStatus: 'employmentStatus', ContractType: 'employmentType',
      WorkLocationCode: 'branchCode', OrgUnitCode: 'departmentCode', JobTitleCode: 'designationCode', ManagerEmployeeNo: 'managerEmployeeNumber',
    },
    orgUnitMapping: {
      UnitCode: 'code', UnitNameEn: 'name', UnitNameAr: 'nameAr', ParentUnitCode: 'parentCode', WorkLocationCode: 'branchCode', UnitHeadEmployeeNo: 'managerEmployeeNumber',
    },
    statusMapping: {
      Active: 'active', 'على رأس العمل': 'active', 'On Leave': 'on_leave', 'في إجازة': 'on_leave', Suspended: 'suspended', 'موقوف': 'suspended',
      Terminated: 'terminated', 'منتهية خدماته': 'terminated', Retired: 'terminated', 'متقاعد': 'terminated', Resigned: 'resigned', 'مستقيل': 'resigned',
    },
    genderMapping: { M: 'male', Male: 'male', 'ذكر': 'male', F: 'female', Female: 'female', 'أنثى': 'female' },
    employmentTypeMapping: { Permanent: 'full_time', 'دائم': 'full_time', Contract: 'contract', 'عقد': 'contract', Temporary: 'temporary', 'مؤقت': 'temporary', Trainee: 'intern', 'متدرب': 'intern' },
  },
};

/**
 * `organization_settings.integrations.hrms` — read through `organizationSettingsSchema` (defaults filled in), written ONLY by
 * `PUT /orgs/:orgId/integrations/hrms` (`integration.manage`), which replaces this key and leaves the rest of the group alone.
 * An empty list means "the preset's list" (`effectiveHrmsMapping`).
 */
export const hrmsIntegrationSettingsSchema = z.object({
  /** Off: the inbound endpoints refuse every batch (403), whatever the API keys. */
  enabled: z.boolean().default(false),
  preset: z.enum(HRMS_PRESETS).default('generic'),
  employeeMapping: hrmsEmployeeMappingSchema.default([]),
  orgUnitMapping: hrmsOrgUnitMappingSchema.default([]),
  statusMapping: hrmsStatusMappingSchema.default([]),
  genderMapping: hrmsGenderMappingSchema.default([]),
  employmentTypeMapping: hrmsEmploymentTypeMappingSchema.default([]),
  /** Branch of a NEW employee whose record names none (an HR system often has no notion of FlowZa's branches). */
  defaultBranchCode: codeSchema.nullable().default(null),
});
export type HrmsIntegrationSettings = z.output<typeof hrmsIntegrationSettingsSchema>;
export const DEFAULT_HRMS_SETTINGS: HrmsIntegrationSettings = hrmsIntegrationSettingsSchema.parse({});

/** Effective settings from whatever the row holds (never throws: a malformed stored value falls back to the defaults). */
export function resolveHrmsSettings(raw: unknown): HrmsIntegrationSettings {
  const parsed = hrmsIntegrationSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_HRMS_SETTINGS;
}

const toRecord = <T extends string>(pairs: ReadonlyArray<HrmsMappingPair<T>>): Record<string, T> => Object.fromEntries(pairs.map((p) => [p.source, p.target]));
const toPairs = <T extends string>(record: Readonly<Record<string, T>>): Array<HrmsMappingPair<T>> => Object.entries(record).map(([source, target]) => ({ source, target }));

/** The mapping in force: the stored one, or the preset's when the administrator kept none (per list). */
export function effectiveHrmsMapping(s: HrmsIntegrationSettings): HrmsPresetDefinition {
  const preset = HRMS_PRESET_DEFINITIONS[s.preset];
  const pick = <T extends string>(stored: ReadonlyArray<HrmsMappingPair<T>>, fallback: Record<string, T>): Record<string, T> => (stored.length > 0 ? toRecord(stored) : fallback);
  return {
    employeeMapping: pick(s.employeeMapping, preset.employeeMapping),
    orgUnitMapping: pick(s.orgUnitMapping, preset.orgUnitMapping),
    statusMapping: pick(s.statusMapping, preset.statusMapping),
    genderMapping: pick(s.genderMapping, preset.genderMapping),
    employmentTypeMapping: pick(s.employmentTypeMapping, preset.employmentTypeMapping),
  };
}

/** A preset as editable lists (what Settings → HR system fills the editor with when a preset is chosen). */
export function hrmsPresetPairs(preset: HrmsPreset): Pick<HrmsIntegrationSettings, 'employeeMapping' | 'orgUnitMapping' | 'statusMapping' | 'genderMapping' | 'employmentTypeMapping'> {
  const d = HRMS_PRESET_DEFINITIONS[preset];
  return { employeeMapping: toPairs(d.employeeMapping), orgUnitMapping: toPairs(d.orgUnitMapping), statusMapping: toPairs(d.statusMapping), genderMapping: toPairs(d.genderMapping), employmentTypeMapping: toPairs(d.employmentTypeMapping) };
}

/** PUT body: the whole configuration (a replacement — `enabled` and `preset` are required, so `{}` is refused). */
export const hrmsIntegrationInputSchema = hrmsIntegrationSettingsSchema.extend({
  enabled: z.boolean(),
  preset: z.enum(HRMS_PRESETS),
});
export type HrmsIntegrationInput = z.input<typeof hrmsIntegrationInputSchema>;

// ---------------------------------------------------------------------------------------------------------------------------
// API keys (machine access for integrations)
// ---------------------------------------------------------------------------------------------------------------------------

/** `hrms:write` sends batches (and reads their status); `hrms:read` only reads the status of batches. */
export const API_KEY_SCOPES = ['hrms:write', 'hrms:read'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export const API_KEY_MAX_DAYS = 730;
export const API_KEY_DEFAULT_DAYS = 365;
/** At most this many keys that are not revoked per organisation (expired ones count until they are revoked). */
export const API_KEYS_MAX_ACTIVE = 20;

export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length),
  /** Days until the key stops working (1–730; default 365). Keys always expire: rotate before the date. */
  expiresInDays: z.number().int().min(1).max(API_KEY_MAX_DAYS).default(API_KEY_DEFAULT_DAYS),
});
export type ApiKeyCreateInput = z.input<typeof apiKeyCreateSchema>;

export const API_KEY_STATUSES = ['active', 'expired', 'revoked'] as const;
export const apiKeyDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  /** The public part of the key (`fzk_xxxxxxxx`), enough to recognise it; the secret is never shown again. */
  prefix: z.string(),
  scopes: z.array(z.enum(API_KEY_SCOPES)),
  status: z.enum(API_KEY_STATUSES),
  lastUsedAt: isoDateTimeSchema.nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
  revokedAt: isoDateTimeSchema.nullable(),
  createdBy: uuidSchema.nullable(),
  createdByName: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type ApiKeyDto = z.infer<typeof apiKeyDtoSchema>;
/** The create response: the only time the full key (`secret`) is ever returned. */
export const apiKeyCreatedDtoSchema = apiKeyDtoSchema.extend({ secret: z.string() });
export type ApiKeyCreatedDto = z.infer<typeof apiKeyCreatedDtoSchema>;

// ---------------------------------------------------------------------------------------------------------------------------
// Inbound batches
// ---------------------------------------------------------------------------------------------------------------------------

/** At most this many records per batch; send more as several batches. */
export const HRMS_BATCH_MAX = 500;
const hrmsScalarSchema = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);
/** One record of the HR system, in its own field names (translated with the organisation's mapping). */
export const hrmsRecordSchema = z.record(z.string().trim().min(1).max(64), hrmsScalarSchema)
  .refine((r) => Object.keys(r).length <= HRMS_MAPPING_MAX, { message: `At most ${HRMS_MAPPING_MAX} fields per record` });
export const hrmsBatchSchema = z.object({
  records: z.array(hrmsRecordSchema).min(1).max(HRMS_BATCH_MAX),
  /** The HR system's own reference for the batch (shown in FlowZa next to it). */
  reference: z.string().trim().max(120).optional(),
});
export type HrmsBatchInput = z.infer<typeof hrmsBatchSchema>;

/** 202 answer to a batch: the queue job that applies it and the batch to poll. */
export const hrmsBatchAcceptedDtoSchema = z.object({
  jobId: z.string(),
  status: z.literal('QUEUED'),
  batchId: uuidSchema,
  kind: z.enum(IMPORT_KINDS),
  totalRows: z.number().int(),
  validRows: z.number().int(),
  errorRows: z.number().int(),
});
export type HrmsBatchAcceptedDto = z.infer<typeof hrmsBatchAcceptedDtoSchema>;

export const hrmsBatchStatusDtoSchema = z.object({
  batchId: uuidSchema,
  kind: z.enum(IMPORT_KINDS),
  status: z.enum(IMPORT_STATUSES),
  reference: z.string().nullable(),
  totalRows: z.number().int(),
  validRows: z.number().int(),
  errorRows: z.number().int(),
  importedRows: z.number().int(),
  summary: z.record(z.string(), z.unknown()).nullable(),
  /** The rows that were refused or failed (record number = position in the batch, from 1), at most 200. */
  errors: z.array(z.object({ rowNo: z.number().int(), status: z.string(), field: z.string().nullable(), message: z.string() })),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type HrmsBatchStatusDto = z.infer<typeof hrmsBatchStatusDtoSchema>;

/** The HRMS card of Settings: the configuration plus what an administrator needs to wire the HR system. */
export const hrmsIntegrationDtoSchema = hrmsIntegrationSettingsSchema.extend({
  /** The inbound base URL (`…/api/v1/inbound/hrms`). */
  endpoint: z.string(),
});
export type HrmsIntegrationDto = z.infer<typeof hrmsIntegrationDtoSchema>;

/** A recent batch (import job with source `hrms`) for the Settings card. */
export const hrmsBatchListItemSchema = z.object({
  id: uuidSchema,
  kind: z.enum(IMPORT_KINDS),
  status: z.enum(IMPORT_STATUSES),
  reference: z.string().nullable(),
  apiKeyPrefix: z.string().nullable(),
  totalRows: z.number().int(),
  validRows: z.number().int(),
  errorRows: z.number().int(),
  importedRows: z.number().int(),
  createdAt: isoDateTimeSchema,
});
export type HrmsBatchListItem = z.infer<typeof hrmsBatchListItemSchema>;
