import type { LocationLevelRole } from '@flowza/contracts';
import { resolveLocationFilter, type LocationFilter, type Trx } from '@flowza/database';
import { errors, type AppError } from '@flowza/shared';

/*
 * Place references and `locationId` filters (docs/locations.md §2, ADR-009) for the services that point into the location
 * tree: devices (`devices.location_id`), employees (`employees.work_location_id`), geofences (`geofences.location_id`), the
 * dashboard and reports. Every read runs under whatever context the caller's transaction carries — row security decides
 * which nodes a member sees (group nodes, and the nodes of their branches) — and the database enforces the reference rules
 * again (composite keys `(location_id, branch_id, organization_id)`, `app.place_reference_guard`).
 */

/** The nil uuid: an `in (…)` list that matches no row, so an empty selection never widens to "everything". */
export const NO_ROWS = '00000000-0000-0000-0000-000000000000';

export interface LocationNode { id: string; role: LocationLevelRole; branchId: string | null; status: string }

/** The location as the caller sees it (RLS): null when it is unknown, of another organisation or outside their branches. */
export async function readLocation(trx: Trx, organizationId: string, locationId: string): Promise<LocationNode | null> {
  const node = await trx.selectFrom('locations').select(['id', 'role', 'branchId', 'status']).where('organizationId', '=', organizationId).where('id', '=', locationId).executeTakeFirst();
  return node ?? null;
}

const issue = (path: string, message: string) => ({ issues: [{ path, message }] });

/**
 * Why `node` cannot be the place of a row of `branchId` (the row's branch AFTER the change), or null when it can: it must be
 * visible, a PLACE (never a group or branch node), not archived, and of that branch — a row without a branch has no place.
 */
export function placeReferenceError(node: LocationNode | null | undefined, branchId: string | null | undefined, path = 'locationId'): AppError | null {
  if (!node) return errors.validation('Location not found.', issue(path, 'Unknown location'));
  if (node.role !== 'place' || !node.branchId) return errors.validation('Choose a place (a site, building, floor, zone…), not a group or a branch.', issue(path, 'Not a place'));
  if (node.status === 'archived') return errors.validation('This location is archived.', issue(path, 'Archived'));
  if (!branchId) return errors.validation('A location needs a branch: choose the branch first.', issue(path, 'Needs a branch'));
  if (node.branchId !== branchId) return errors.validation('This location belongs to another branch: choose a place of the same branch.', issue(path, 'Another branch'));
  return null;
}

/** Validates a place reference before it is written (VALIDATION_ERROR naming `path`; the database refuses the same again). */
export async function assertPlaceOfBranch(trx: Trx, organizationId: string, locationId: string, branchId: string | null | undefined, path = 'locationId'): Promise<void> {
  const err = placeReferenceError(await readLocation(trx, organizationId, locationId), branchId, path);
  if (err) throw err;
}

/** A location a request names as a parameter (any kind of node) must be visible to the caller: VALIDATION_ERROR otherwise. */
export async function assertLocationVisible(trx: Trx, organizationId: string, locationId: string, path = 'locationId'): Promise<void> {
  if (!(await readLocation(trx, organizationId, locationId))) throw errors.validation('Location not found.', issue(path, 'Unknown location'));
}

/** What a `locationId` filter leaves of a list, combined with the caller's branch scope. */
export interface LocationScope {
  /** Rows must belong to one of these branches; null = no branch restriction. Never empty: nothing selected is `[NO_ROWS]`. */
  branchIds: string[] | null;
  /** A place filter: rows must point at the place or a place below it (work / device / fence location); null = no place restriction. */
  placeIds: string[] | null;
}

/**
 * A location filter intersected with a branch scope (`branchFilter`'s result: null = every branch): a group / branch node →
 * its branches ∩ scope; a place → its branch ∩ scope, and the place's subtree. An empty intersection selects nothing.
 */
export function narrowByLocation(filter: LocationFilter, scope: readonly string[] | null): LocationScope {
  const wanted = filter.kind === 'places' ? [filter.branchId] : [...new Set(filter.branchIds)];
  const allowed = scope ? new Set(scope) : null;
  const branchIds = allowed ? wanted.filter((id) => allowed.has(id)) : wanted;
  if (branchIds.length === 0) return { branchIds: [NO_ROWS], placeIds: filter.kind === 'places' ? [NO_ROWS] : null };
  return { branchIds, placeIds: filter.kind === 'places' ? [...filter.placeIds] : null };
}

/**
 * The `locationId` filter of a list (docs/locations.md §2) resolved under the caller's RLS and combined with their branch
 * scope; NOT_FOUND when the caller cannot see the location. Without a location the scope passes through unchanged.
 */
export async function locationScope(trx: Trx, organizationId: string, locationId: string | null | undefined, scope: string[] | null): Promise<LocationScope> {
  if (!locationId) return { branchIds: scope, placeIds: null };
  return narrowByLocation(await resolveLocationFilter(trx, organizationId, locationId), scope);
}
