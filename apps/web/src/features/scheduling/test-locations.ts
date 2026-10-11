import type { LocationDto, LocationLevelDto, LocationLevelRole } from '@flowza/contracts';

/*
 * Test data (no application imports): an organisation with the CORPORATE structure — Headquarters → Branch → Site → Floor —
 * shared by the policy, coverage and muster tests. Muscat HQ holds Branch 1 (Riyadh time, to tell the branch's clock from the
 * organisation's) and Branch 2; Branch 1 has Site A (with Floor 2) and Site B.
 */

const T = '2026-10-10T00:00:00Z';
export const BR1 = 'b1000000-0000-4000-8000-000000000001';
export const BR2 = 'b2000000-0000-4000-8000-000000000002';
export const N_HQ = 'c0000000-0000-4000-8000-0000000000a1';
export const N_B1 = 'c0000000-0000-4000-8000-0000000000b1';
export const N_B2 = 'c0000000-0000-4000-8000-0000000000b2';
export const N_SA = 'c0000000-0000-4000-8000-0000000000c1';
export const N_SB = 'c0000000-0000-4000-8000-0000000000c2';
export const N_F2 = 'c0000000-0000-4000-8000-0000000000d2';

const level = (id: string, position: number, role: LocationLevelRole, name: string, nameAr: string): LocationLevelDto => ({ id, organizationId: 'org-1', position, role, name, nameAr, icon: 'other', locationCount: 0, createdAt: T, updatedAt: T });
export const LEVELS: LocationLevelDto[] = [level('l-hq', 1, 'group', 'Headquarters', 'المقر الرئيسي'), level('l-br', 2, 'branch', 'Branch', 'فرع'), level('l-site', 3, 'place', 'Site', 'موقع'), level('l-floor', 4, 'place', 'Floor', 'طابق')];
/** Only the branch level: an organisation without a hierarchy (today's behaviour). */
export const BRANCH_ONLY_LEVELS: LocationLevelDto[] = [level('l-br', 1, 'branch', 'Branch', 'فرع')];

const node = (id: string, parentId: string | null, levelId: string, role: LocationLevelRole, name: string, path: string[], extra: Partial<LocationDto> = {}): LocationDto => ({
  id, organizationId: 'org-1', levelId, role, parentId, branchId: null, code: name.toUpperCase().replace(/\W+/g, '-'), name, nameAr: null, latitude: null, longitude: null,
  path, depth: path.length, status: 'active', employeeCount: 0, deviceCount: 0, childCount: 0, createdAt: T, updatedAt: T, ...extra,
});
export const NODES: LocationDto[] = [
  node(N_HQ, null, 'l-hq', 'group', 'Muscat HQ', [N_HQ], { nameAr: 'المقر الرئيسي بمسقط' }),
  node(N_B1, N_HQ, 'l-br', 'branch', 'Branch 1', [N_HQ, N_B1], { branchId: BR1 }),
  node(N_B2, N_HQ, 'l-br', 'branch', 'Branch 2', [N_HQ, N_B2], { branchId: BR2 }),
  node(N_SA, N_B1, 'l-site', 'place', 'Site A', [N_HQ, N_B1, N_SA], { branchId: BR1, nameAr: 'الموقع أ' }),
  node(N_SB, N_B1, 'l-site', 'place', 'Site B', [N_HQ, N_B1, N_SB], { branchId: BR1 }),
  node(N_F2, N_SA, 'l-floor', 'place', 'Floor 2', [N_HQ, N_B1, N_SA, N_F2], { branchId: BR1 }),
];
/** Without a hierarchy every branch is a top-level node. */
export const BRANCH_ONLY_NODES: LocationDto[] = [
  node(N_B1, null, 'l-br', 'branch', 'Branch 1', [N_B1], { branchId: BR1 }),
  node(N_B2, null, 'l-br', 'branch', 'Branch 2', [N_B2], { branchId: BR2 }),
];

const branch = (id: string, code: string, name: string, timezone: string) => ({ id, organizationId: 'org-1', code, name, nameAr: null, countryCode: 'OM', city: null, address: {}, timezone, latitude: null, longitude: null, geofenceRadiusM: null, status: 'active', createdAt: T, updatedAt: T });
export const BRANCHES = [branch(BR1, 'B1', 'Branch 1', 'Asia/Riyadh'), branch(BR2, 'B2', 'Branch 2', 'Asia/Muscat')];

/** GET routes of the location tree for `mockGet` (the levels and the nodes envelopes). */
export function locationRoutes(levels: LocationLevelDto[] = LEVELS, nodes: LocationDto[] = NODES): Record<string, unknown> {
  return { '/orgs/org-1/location-levels': { data: levels }, '/orgs/org-1/locations': { data: nodes } };
}
