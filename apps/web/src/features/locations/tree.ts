import type { LocationDto, LocationLevelDto, LocationLevelRole } from '@flowza/contracts';

/** The location tree indexed for pickers, filters and the Locations tab. Pure. */
export interface LocationTreeIndex {
  nodes: LocationDto[];
  byId: Map<string, LocationDto>;
  /** Children by parent id (null = the top level), siblings ordered by name. */
  children: Map<string | null, LocationDto[]>;
  levels: LocationLevelDto[];
  levelsById: Map<string, LocationLevelDto>;
  /** The node of each branch, by branch id. */
  branchNodeOf: Map<string, LocationDto>;
  branchLevel: LocationLevelDto | null;
  hasGroupLevels: boolean;
  hasPlaceLevels: boolean;
}

export function indexLocations(nodes: readonly LocationDto[], levels: readonly LocationLevelDto[]): LocationTreeIndex {
  const sortedLevels = [...levels].sort((a, b) => a.position - b.position);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string | null, LocationDto[]>();
  for (const n of nodes) {
    // a node whose parent the caller cannot see (another branch's place under a visible group, an archived parent left out)
    // is shown at the top rather than lost
    const key = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    const list = children.get(key) ?? [];
    list.push(n);
    children.set(key, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
  const branchNodeOf = new Map(nodes.filter((n) => n.role === 'branch' && n.branchId).map((n) => [n.branchId!, n]));
  return {
    nodes: [...nodes], byId, children, levels: sortedLevels, levelsById: new Map(sortedLevels.map((l) => [l.id, l])), branchNodeOf,
    branchLevel: sortedLevels.find((l) => l.role === 'branch') ?? null,
    hasGroupLevels: sortedLevels.some((l) => l.role === 'group'),
    hasPlaceLevels: sortedLevels.some((l) => l.role === 'place'),
  };
}

/** The tree depth-first (parents before children), each row with its depth below `rootId` (0 = a child of the root / the top). */
export function depthFirst(index: LocationTreeIndex, rootId: string | null = null): Array<{ node: LocationDto; depth: number }> {
  const out: Array<{ node: LocationDto; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const n of index.children.get(parent) ?? []) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push({ node: n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(rootId, 0);
  return out;
}

/** The ancestors of a node, root first (the node excluded). */
export function ancestorsOf(index: LocationTreeIndex, id: string): LocationDto[] {
  const out: LocationDto[] = [];
  let cursor = index.byId.get(id)?.parentId ?? null;
  for (let hops = 0; cursor && hops < 64; hops++) {
    const n = index.byId.get(cursor);
    if (!n) break;
    out.unshift(n);
    cursor = n.parentId;
  }
  return out;
}

/**
 * A node's path as text, e.g. "Muscat HQ › Branch 1 › Site A". `fromBranch`: start below the branch (a place's label in a
 * branch-scoped form: "Site A › Floor 2"). `name` localises each node (useLocalName).
 */
export function pathLabel(index: LocationTreeIndex, id: string, name: (n: LocationDto) => string, opts: { fromBranch?: boolean; separator?: string } = {}): string {
  const node = index.byId.get(id);
  if (!node) return '';
  let chain = [...ancestorsOf(index, id), node];
  if (opts.fromBranch) {
    const b = chain.findIndex((n) => n.role === 'branch');
    if (b >= 0 && node.role === 'place') chain = chain.slice(b + 1);
  }
  return chain.map(name).join(opts.separator ?? ' › ');
}

/** The places of a branch, depth-first, with their depth below the branch node (0 = directly under it). */
export function placesOfBranch(index: LocationTreeIndex, branchId: string): Array<{ node: LocationDto; depth: number }> {
  const branchNode = index.branchNodeOf.get(branchId);
  return branchNode ? depthFirst(index, branchNode.id).filter((r) => r.node.role === 'place') : [];
}

/** Every node of a role, depth-first with its depth in the tree. */
export function nodesOfRole(index: LocationTreeIndex, role: LocationLevelRole): Array<{ node: LocationDto; depth: number }> {
  return depthFirst(index).filter((r) => r.node.role === role);
}
