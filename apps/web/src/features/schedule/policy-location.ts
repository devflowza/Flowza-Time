import type { LocationDto } from '@flowza/contracts';
import type { LocationTreeIndex } from '@/features/locations/tree';

/*
 * The "where" of an attendance policy (docs/locations.md §3): nothing, a branch (`branchId`), a group location such as a region
 * or the headquarters (`locationId`, no branch) or a place such as a site, floor or zone (`locationId` + `branchId` = the
 * place's branch). The policy editor offers one Location field; these helpers translate between a picked node and the two
 * stored columns. Pure.
 */

export interface PolicyWhere { branchId: string | null; locationId: string | null }

/** The scope columns a picked location writes: a branch node names the branch, a group node the location alone, a place both. */
export function scopeOfLocation(node: Pick<LocationDto, 'id' | 'role' | 'branchId'> | null | undefined): PolicyWhere {
  if (!node) return { branchId: null, locationId: null };
  if (node.role === 'branch') return { branchId: node.branchId, locationId: null };
  if (node.role === 'group') return { branchId: null, locationId: node.id };
  return { branchId: node.branchId, locationId: node.id };
}

/** The node a stored scope shows in the Location field: its location, else its branch's node (null = organisation-wide). */
export function locationOfScope(index: Pick<LocationTreeIndex, 'branchNodeOf'>, scope: { branchId?: string | null; locationId?: string | null }): string | null {
  if (scope.locationId) return scope.locationId;
  if (scope.branchId) return index.branchNodeOf.get(scope.branchId)?.id ?? null;
  return null;
}

/**
 * The list filter a picked location becomes: a branch node filters by its branch (`branchId`, the classic branch filter), a
 * group node or a place by the location (`locationId`).
 */
export function listFilterOfLocation(node: Pick<LocationDto, 'id' | 'role' | 'branchId'> | null | undefined): { branchId?: string; locationId?: string } {
  if (!node) return {};
  if (node.role === 'branch' && node.branchId) return { branchId: node.branchId };
  return { locationId: node.id };
}

/** The names of a location chain (root first), skipping the ids the caller cannot see. */
export function chainLabel(index: Pick<LocationTreeIndex, 'byId'>, ids: readonly string[] | null | undefined, name: (n: LocationDto) => string, separator = ' › '): string {
  return (ids ?? []).flatMap((id) => { const n = index.byId.get(id); return n ? [name(n)] : []; }).join(separator);
}
