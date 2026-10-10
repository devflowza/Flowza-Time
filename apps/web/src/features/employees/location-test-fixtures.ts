import type { BranchDto, LocationDto, LocationLevelDto, LocationLevelRole } from '@flowza/contracts';

/**
 * A location tree for the feature tests that wire locations into devices, employees, geofences, members, the dashboard and
 * reports (docs/locations.md). Plain data — like ./test-mocks.ts this imports nothing from the application. Spread
 * `locationRoutes()` into a `mockGet` route table:
 *
 *   Muscat HQ (group)              Southern Region (group)
 *   ├─ Branch 1 → Site A → Floor 2  └─ Branch 3
 *   └─ Branch 2 → Site X
 *
 * Ids are GUIDs because the contract schemas validate them.
 */
const T = '2026-10-10T00:00:00Z';
const ORG = 'org-1';

export const BRANCH_1 = 'b0000000-0000-4000-8000-000000000001';
export const BRANCH_2 = 'b0000000-0000-4000-8000-000000000002';
export const BRANCH_3 = 'b0000000-0000-4000-8000-000000000003';

export const LOC = {
  hq: 'a0000000-0000-4000-8000-0000000000a1',
  south: 'a0000000-0000-4000-8000-0000000000a2',
  branch1: 'a0000000-0000-4000-8000-0000000000b1',
  branch2: 'a0000000-0000-4000-8000-0000000000b2',
  branch3: 'a0000000-0000-4000-8000-0000000000b3',
  siteA: 'a0000000-0000-4000-8000-0000000000c1',
  floor2: 'a0000000-0000-4000-8000-0000000000c2',
  siteX: 'a0000000-0000-4000-8000-0000000000c3',
} as const;

const level = (id: string, position: number, role: LocationLevelRole, name: string, nameAr: string): LocationLevelDto => ({
  id, organizationId: ORG, position, role, name, nameAr, icon: 'other', locationCount: 0, createdAt: T, updatedAt: T,
});
const L_GROUP = level('c0000000-0000-4000-8000-000000000001', 1, 'group', 'Region', 'إقليم');
const L_BRANCH = level('c0000000-0000-4000-8000-000000000002', 2, 'branch', 'Branch', 'فرع');
const L_SITE = level('c0000000-0000-4000-8000-000000000003', 3, 'place', 'Site', 'موقع');
const L_FLOOR = level('c0000000-0000-4000-8000-000000000004', 4, 'place', 'Floor', 'طابق');

/** Region → Branch → Site → Floor: group and place levels. */
export const LEVELS: LocationLevelDto[] = [L_GROUP, L_BRANCH, L_SITE, L_FLOOR];
/** Today's behaviour (the SIMPLE template): the branch level alone — no location UI anywhere. */
export const SIMPLE_LEVELS: LocationLevelDto[] = [{ ...L_BRANCH, position: 1 }];
/** Regions above the branches but nothing inside them: filters, no place fields. */
export const GROUP_LEVELS: LocationLevelDto[] = [L_GROUP, L_BRANCH];

const node = (id: string, parentId: string | null, lvl: LocationLevelDto, name: string, extra: Partial<LocationDto> = {}): LocationDto => ({
  id, organizationId: ORG, levelId: lvl.id, role: lvl.role, parentId, branchId: null, code: name.toUpperCase().replace(/\W+/g, '-'), name, nameAr: null,
  latitude: null, longitude: null, path: [], depth: 0, status: 'active', employeeCount: 0, deviceCount: 0, childCount: 0, createdAt: T, updatedAt: T, ...extra,
});

export const NODES: LocationDto[] = [
  node(LOC.hq, null, L_GROUP, 'Muscat HQ'),
  node(LOC.south, null, L_GROUP, 'Southern Region'),
  node(LOC.branch1, LOC.hq, L_BRANCH, 'Branch 1', { branchId: BRANCH_1 }),
  node(LOC.branch2, LOC.hq, L_BRANCH, 'Branch 2', { branchId: BRANCH_2 }),
  node(LOC.branch3, LOC.south, L_BRANCH, 'Branch 3', { branchId: BRANCH_3 }),
  node(LOC.siteA, LOC.branch1, L_SITE, 'Site A', { branchId: BRANCH_1, nameAr: 'الموقع أ' }),
  node(LOC.floor2, LOC.siteA, L_FLOOR, 'Floor 2', { branchId: BRANCH_1 }),
  node(LOC.siteX, LOC.branch2, L_SITE, 'Site X', { branchId: BRANCH_2 }),
];
/** The same branches without regions or places (what a SIMPLE organisation's tree holds). */
export const SIMPLE_NODES: LocationDto[] = NODES.filter((n) => n.role === 'branch').map((n) => ({ ...n, parentId: null, levelId: SIMPLE_LEVELS[0]!.id }));

/** GET /location-levels and GET /locations for a `mockGet` route table. */
export function locationRoutes(levels: LocationLevelDto[] = LEVELS, nodes: LocationDto[] = NODES): Record<string, unknown> {
  return { [`/orgs/${ORG}/location-levels`]: { data: levels }, [`/orgs/${ORG}/locations`]: { data: nodes } };
}

export const branchRow = (id: string, name: string, code = name.toUpperCase().replace(/\W+/g, '')): BranchDto => ({
  id, organizationId: ORG, code, name, nameAr: null, countryCode: 'OM', city: null, address: {}, timezone: 'Asia/Muscat', latitude: null, longitude: null,
  geofenceRadiusM: null, contact: {}, weeklyOffDays: null, holidayCalendarId: null, status: 'active', createdAt: T, updatedAt: T,
});
/** Branch rows matching the tree's branch nodes. */
export const BRANCHES: BranchDto[] = [branchRow(BRANCH_1, 'Branch 1'), branchRow(BRANCH_2, 'Branch 2'), branchRow(BRANCH_3, 'Branch 3')];
