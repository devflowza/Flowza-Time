import { sql } from 'kysely';
import type { LocationLevelRole } from '@flowza/contracts';
import { placeLabel } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { Trx } from '../context.js';
import { uuidArray } from '../attendance/policy.js';

/*
 * Location tree reads (docs/locations.md, migration 20261010000100) shared by the API services and the worker: the tree
 * itself, what a `locationId` filter selects, and the labels of places. They run under whatever context the caller
 * established — row security decides which nodes a member sees (group nodes, and the nodes of their branches).
 */

const containsNode = (id: string) => sql<boolean>`path @> array[${id}]::uuid[]`;

export interface LocationRow {
  id: string; organizationId: string; levelId: string; role: LocationLevelRole; parentId: string | null; branchId: string | null;
  /** Branch nodes: the branch's code, name and status. */
  code: string; name: string; nameAr: string | null; status: 'active' | 'inactive' | 'archived';
  latitude: number | null; longitude: number | null; path: string[]; depth: number; createdAt: Date; updatedAt: Date;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * The organisation's locations the caller may see, parents before children (by depth). Without `includeArchived` an
 * archived node and everything below it are left out (a branch counts as archived when the branch is).
 */
export async function loadLocationTree(trx: Trx, organizationId: string, opts: { includeArchived?: boolean } = {}): Promise<LocationRow[]> {
  const rows = await trx.selectFrom('locations as l')
    .leftJoin('branches as b', (j) => j.onRef('b.id', '=', 'l.branchId').onRef('b.organizationId', '=', 'l.organizationId'))
    .select(['l.id', 'l.organizationId', 'l.levelId', 'l.role', 'l.parentId', 'l.branchId', 'l.code', 'l.name', 'l.nameAr', 'l.status', 'l.latitude', 'l.longitude', 'l.path', 'l.depth', 'l.createdAt', 'l.updatedAt',
      'b.code as branchCode', 'b.name as branchName', 'b.nameAr as branchNameAr', 'b.status as branchStatus'])
    .where('l.organizationId', '=', organizationId)
    .orderBy('l.depth').orderBy('l.id')
    .execute();
  const out: LocationRow[] = rows.map((r) => {
    const branchNode = r.role === 'branch';
    return {
      id: r.id, organizationId: r.organizationId, levelId: r.levelId, role: r.role, parentId: r.parentId, branchId: r.branchId,
      code: String((branchNode ? r.branchCode : r.code) ?? ''), name: (branchNode ? r.branchName : r.name) ?? '', nameAr: (branchNode ? r.branchNameAr : r.nameAr) ?? null,
      status: (branchNode ? r.branchStatus ?? 'archived' : r.status) as LocationRow['status'],
      latitude: num(r.latitude), longitude: num(r.longitude), path: uuidArray(r.path) ?? [r.id], depth: Number(r.depth ?? 1), createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
  });
  if (opts.includeArchived) return out;
  const archived = new Set(out.filter((n) => n.status === 'archived').map((n) => n.id));
  return out.filter((n) => !n.path.some((id) => archived.has(id)));
}

export type LocationFilter =
  /** A group or branch node: the branches at or below it (those the caller may see). */
  | { kind: 'branches'; locationId: string; branchIds: string[] }
  /** A place: the place and every place below it, all in one branch. */
  | { kind: 'places'; locationId: string; branchId: string; placeIds: string[] };

/** What a `locationId` filter selects (docs/locations.md §2). NOT_FOUND when the caller cannot see the location. */
export async function resolveLocationFilter(trx: Trx, organizationId: string, locationId: string): Promise<LocationFilter> {
  const node = await trx.selectFrom('locations').select(['id', 'role', 'branchId']).where('organizationId', '=', organizationId).where('id', '=', locationId).executeTakeFirst();
  if (!node) throw errors.notFound('Location', locationId);
  if (node.role === 'place' && node.branchId) {
    const rows = await trx.selectFrom('locations').select('id').where('organizationId', '=', organizationId).where(containsNode(locationId)).execute();
    return { kind: 'places', locationId, branchId: node.branchId, placeIds: rows.map((r) => r.id) };
  }
  if (node.role === 'branch' && node.branchId) return { kind: 'branches', locationId, branchIds: [node.branchId] };
  const rows = await trx.selectFrom('locations').select('branchId').where('organizationId', '=', organizationId).where('role', '=', 'branch').where(containsNode(locationId)).execute();
  return { kind: 'branches', locationId, branchIds: rows.flatMap((r) => (r.branchId ? [r.branchId] : [])) };
}

/**
 * Labels of locations: a place by its path below its branch ("Site A › Floor 2"), a group node by its name. Unknown /
 * invisible ids are left out.
 */
export async function locationLabels(trx: Trx, organizationId: string, ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))];
  if (wanted.length === 0) return new Map();
  const nodes = await trx.selectFrom('locations').select(['id', 'path']).where('organizationId', '=', organizationId).where('id', 'in', wanted).execute();
  const related = [...new Set(nodes.flatMap((n) => uuidArray(n.path) ?? [n.id]))];
  if (related.length === 0) return new Map();
  const rows = await trx.selectFrom('locations').select(['id', 'parentId', 'role', 'name', 'code']).where('organizationId', '=', organizationId).where('id', 'in', related).execute();
  const byId = new Map(rows.map((r) => [r.id, { id: r.id, parentId: r.parentId, role: r.role, name: r.name ?? String(r.code ?? '') }]));
  const out = new Map<string, string>();
  for (const id of wanted) {
    const label = placeLabel(byId, id);
    if (label) out.set(id, label);
  }
  return out;
}
