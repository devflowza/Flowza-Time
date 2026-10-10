/**
 * Location hierarchy (docs/locations.md, ADR-009, migration 20261010000100): customer-named levels (groups above the branch
 * level, places below it) and one tree of locations per organisation — e.g. Headquarters → Branch 1, 2 → Site A, B → Floor →
 * Zone. Branch nodes are the branches themselves (name, code and status come from the branch).
 */
import { z } from 'zod';
import { RECORD_STATUSES } from '../enums.js';
import { booleanQuerySchema, codeSchema, isoDateSchema, isoDateTimeSchema, uuidSchema } from '../common.js';

export const LOCATION_LEVEL_ROLES = ['group', 'branch', 'place'] as const;
/** group = above the branch level (Headquarters, Region…), branch = the operating unit, place = inside a branch (Site, Floor, Zone…). */
export type LocationLevelRole = (typeof LOCATION_LEVEL_ROLES)[number];

/** Presentation hint of a level (mirrored by the `location_levels.icon` check constraint). */
export const LOCATION_LEVEL_ICONS = [
  'headquarters', 'region', 'country', 'city', 'branch', 'store', 'site', 'campus', 'building',
  'floor', 'zone', 'area', 'section', 'room', 'line', 'station', 'post', 'ward', 'warehouse', 'other',
] as const;
export type LocationLevelIcon = (typeof LOCATION_LEVEL_ICONS)[number];

/** At most this many levels (the database allows positions 1–8). */
export const LOCATION_LEVELS_MAX = 8;
/** At most this many ACTIVE locations (group + place nodes) per organisation — archiving one makes room again. */
export const LOCATIONS_MAX = 10_000;
/** …and at most this many in all, archived ones included (locations are archived, never deleted). */
export const LOCATIONS_TOTAL_MAX = 50_000;

// ----- levels ------------------------------------------------------------------------------------------------------------------

export const locationLevelDtoSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  /** 1 = top. */
  position: z.number().int(),
  role: z.enum(LOCATION_LEVEL_ROLES),
  name: z.string(),
  nameAr: z.string().nullable(),
  icon: z.enum(LOCATION_LEVEL_ICONS),
  /** Locations on this level (branch level: the branches), archived ones included. */
  locationCount: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type LocationLevelDto = z.infer<typeof locationLevelDtoSchema>;

const levelNameSchema = z.string().trim().min(1).max(60);
/**
 * POST /location-levels: insert a level at `position` (1 … levels + 1); the levels from there down move one place. The role
 * follows from where it lands: at or above the branch level's current position → a group level, below it → a place level.
 */
export const locationLevelInputSchema = z.object({
  name: levelNameSchema,
  nameAr: levelNameSchema.nullable().optional(),
  icon: z.enum(LOCATION_LEVEL_ICONS).optional(),
  position: z.number().int().min(1).max(LOCATION_LEVELS_MAX),
});
export type LocationLevelInput = z.infer<typeof locationLevelInputSchema>;
/** PATCH /location-levels/:id — a level is renamed freely; its role and position never change this way. */
export const updateLocationLevelSchema = z.object({
  name: levelNameSchema.optional(),
  nameAr: levelNameSchema.nullable().optional(),
  icon: z.enum(LOCATION_LEVEL_ICONS).optional(),
});
export type UpdateLocationLevelInput = z.infer<typeof updateLocationLevelSchema>;

// ----- templates ---------------------------------------------------------------------------------------------------------------

export const LOCATION_TEMPLATE_KEYS = ['SIMPLE', 'CORPORATE', 'REGIONAL', 'RETAIL', 'FACILITIES', 'MANUFACTURING', 'HEALTHCARE', 'EDUCATION', 'SECURITY_SERVICES'] as const;
export type LocationTemplateKey = (typeof LOCATION_TEMPLATE_KEYS)[number];
export interface LocationTemplateLevel { role: LocationLevelRole; icon: LocationLevelIcon; name: string; nameAr: string }
export interface LocationTemplate {
  key: LocationTemplateKey;
  /** The standard the structure follows, when there is one (shown next to the template). */
  standard: string | null;
  /** Top first; exactly one `branch` level. */
  levels: readonly LocationTemplateLevel[];
}

const L = (role: LocationLevelRole, icon: LocationLevelIcon, name: string, nameAr: string): LocationTemplateLevel => ({ role, icon, name, nameAr });
const HQ = L('group', 'headquarters', 'Headquarters', 'المقر الرئيسي');
const REGION = L('group', 'region', 'Region', 'إقليم');
const BRANCH = L('branch', 'branch', 'Branch', 'فرع');
const SITE_PLACE = L('place', 'site', 'Site', 'موقع');
const BUILDING = L('place', 'building', 'Building', 'مبنى');
const FLOOR = L('place', 'floor', 'Floor', 'طابق');
const ZONE = L('place', 'zone', 'Zone', 'منطقة');

/**
 * Starting points for the level list (docs/locations.md §1). Applying one replaces the levels while the organisation has no
 * group / place locations; every name can be changed afterwards.
 */
export const LOCATION_TEMPLATES: readonly LocationTemplate[] = [
  { key: 'SIMPLE', standard: null, levels: [BRANCH] },
  { key: 'CORPORATE', standard: null, levels: [HQ, BRANCH, SITE_PLACE, FLOOR, ZONE] },
  { key: 'REGIONAL', standard: null, levels: [HQ, REGION, BRANCH, SITE_PLACE, FLOOR, ZONE] },
  { key: 'RETAIL', standard: null, levels: [REGION, L('branch', 'store', 'Store', 'متجر'), L('place', 'section', 'Section', 'قسم')] },
  { key: 'FACILITIES', standard: 'ISO 16739 (IFC)', levels: [L('branch', 'site', 'Site', 'موقع'), BUILDING, FLOOR, ZONE] },
  { key: 'MANUFACTURING', standard: 'IEC 62264 / ISA-95', levels: [L('branch', 'site', 'Site', 'موقع'), L('place', 'area', 'Area', 'قطاع'), L('place', 'line', 'Line', 'خط إنتاج'), L('place', 'station', 'Station', 'محطة عمل')] },
  { key: 'HEALTHCARE', standard: null, levels: [L('branch', 'campus', 'Hospital', 'مستشفى'), BUILDING, FLOOR, L('place', 'ward', 'Ward', 'جناح')] },
  { key: 'EDUCATION', standard: null, levels: [L('branch', 'campus', 'Campus', 'حرم جامعي'), BUILDING, FLOOR, L('place', 'room', 'Room', 'غرفة')] },
  { key: 'SECURITY_SERVICES', standard: null, levels: [REGION, L('branch', 'site', 'Client site', 'موقع العميل'), L('place', 'post', 'Post', 'نقطة حراسة')] },
];
export function locationTemplate(key: LocationTemplateKey): LocationTemplate {
  const t = LOCATION_TEMPLATES.find((x) => x.key === key);
  if (!t) throw new Error(`Unknown location template ${key}`);
  return t;
}
/** POST /location-levels/apply-template */
export const applyLocationTemplateSchema = z.object({ template: z.enum(LOCATION_TEMPLATE_KEYS) });
export type ApplyLocationTemplateInput = z.infer<typeof applyLocationTemplateSchema>;

// ----- locations -----------------------------------------------------------------------------------------------------------------

export const locationListQuerySchema = z.object({ includeArchived: booleanQuerySchema.default(false) });
export type LocationListQuery = z.infer<typeof locationListQuerySchema>;

export const locationDtoSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  levelId: uuidSchema,
  role: z.enum(LOCATION_LEVEL_ROLES),
  parentId: uuidSchema.nullable(),
  /** Branch nodes: the branch; place nodes: their branch; group nodes: null. */
  branchId: uuidSchema.nullable(),
  /** Branch nodes carry the branch's code, name and status. */
  code: z.string(),
  name: z.string(),
  nameAr: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  /** Ids from the root to this node (inclusive). */
  path: z.array(uuidSchema),
  depth: z.number().int(),
  status: z.enum(RECORD_STATUSES),
  /** Rolled up over the subtree: branch / group nodes count every employee and device of their branches; place nodes the employees working and the devices installed in them or below. */
  employeeCount: z.number().int(),
  deviceCount: z.number().int(),
  /** Direct children visible to the caller (archived ones only when they were asked for). */
  childCount: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type LocationDto = z.infer<typeof locationDtoSchema>;
/** GET /locations/:id — the node and its ancestors (root first). */
export type LocationDetailDto = LocationDto & { ancestors: Array<Pick<LocationDto, 'id' | 'levelId' | 'role' | 'code' | 'name' | 'nameAr'>> };

const locationNameSchema = z.string().trim().min(1).max(120);
const latitudeSchema = z.number().min(-90).max(90);
const longitudeSchema = z.number().min(-180).max(180);
/**
 * POST /locations — a group node (`parentId` a group node or absent) or a place (`parentId` its branch node or a place).
 * Branch nodes come with the branches. `code` is derived from the name when omitted (unique among the siblings).
 */
export const locationInputSchema = z.object({
  levelId: uuidSchema,
  parentId: uuidSchema.nullable().optional(),
  code: codeSchema.optional(),
  name: locationNameSchema,
  nameAr: locationNameSchema.nullable().optional(),
  latitude: latitudeSchema.nullable().optional(),
  longitude: longitudeSchema.nullable().optional(),
}).refine((v) => (v.latitude == null) === (v.longitude == null), { message: 'Give both the latitude and the longitude, or neither', path: ['longitude'] });
export type LocationInput = z.infer<typeof locationInputSchema>;
/**
 * PATCH /locations/:id — rename, move (`parentId`), re-level (`levelId`, same kind), set the point, archive / restore
 * (`status`). A branch node only moves (`parentId`): its name, code and status are the branch's.
 */
export const updateLocationSchema = z.object({
  levelId: uuidSchema.optional(),
  parentId: uuidSchema.nullable().optional(),
  code: codeSchema.optional(),
  name: locationNameSchema.optional(),
  nameAr: locationNameSchema.nullable().optional(),
  latitude: latitudeSchema.nullable().optional(),
  longitude: longitudeSchema.nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
}).refine((v) => (v.latitude === undefined) === (v.longitude === undefined) && (v.latitude === null) === (v.longitude === null), { message: 'Change the latitude and the longitude together', path: ['longitude'] });
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;

/** `locationId` filter of lists and reports: a group / branch node → its branches; a place → the work / device locations in its subtree. */
export const locationFilterSchema = uuidSchema.optional();

// ----- muster (Enterprise, advanced_scheduling) ---------------------------------------------------------------------------------

export const MUSTER_STATES = ['on_site', 'on_break', 'left', 'seen'] as const;
/** From the employee's latest punch of the day: PUNCH_IN / BREAK_END = on site, BREAK_START = on break, PUNCH_OUT = left, PUNCH = seen. */
export type MusterState = (typeof MUSTER_STATES)[number];
export const locationMusterQuerySchema = z.object({ date: isoDateSchema.optional() });
export type MusterTotals = Record<MusterState, number>;
export interface LocationMusterEntryDto {
  employeeId: string; employeeNumber: string; displayName: string; branchId: string | null;
  state: MusterState; eventType: string; punchedAt: string;
  deviceId: string; deviceName: string;
  /** The place the terminal is installed in. */
  locationId: string; locationName: string;
}
export interface LocationMusterDto {
  locationId: string;
  /** The day (local date of the location's branch; of the organisation for a group node). */
  date: string;
  totals: MusterTotals;
  /** The same totals per direct child location (drill-down). */
  children: Array<{ locationId: string; name: string; nameAr: string | null; totals: MusterTotals }>;
  entries: LocationMusterEntryDto[];
  /** Terminals placed in the subtree (0 = nothing can be attributed here). */
  deviceCount: number;
}
