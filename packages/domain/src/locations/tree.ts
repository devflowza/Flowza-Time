/**
 * Location hierarchy rules (docs/locations.md §1) — pure. The database enforces the same rules (migration 20261010000100:
 * the shape trigger, the deferred level check, the composite place keys); the API calls these first so the caller gets a
 * precise validation message instead of a constraint error.
 */
import type { LocationLevelIcon, LocationLevelRole, LocationTemplate } from '@flowza/contracts';
import { LOCATION_LEVELS_MAX } from '@flowza/contracts';

export interface TreeLevel { id: string; position: number; role: LocationLevelRole }
export interface TreeNode {
  id: string;
  parentId: string | null;
  levelId: string;
  role: LocationLevelRole;
  branchId: string | null;
  status?: string;
}

// ----- levels ------------------------------------------------------------------------------------------------------------------

export type LevelListProblem = 'EMPTY' | 'TOO_MANY' | 'NO_BRANCH_LEVEL' | 'MANY_BRANCH_LEVELS' | 'GAPS' | 'GROUP_BELOW_BRANCH' | 'PLACE_ABOVE_BRANCH';

/** What is wrong with a level list (empty = well formed): 1..n contiguous, one branch level, groups above it, places below. */
export function levelListProblems(levels: readonly TreeLevel[]): LevelListProblem[] {
  const out: LevelListProblem[] = [];
  if (levels.length === 0) return ['EMPTY'];
  if (levels.length > LOCATION_LEVELS_MAX) out.push('TOO_MANY');
  const branches = levels.filter((l) => l.role === 'branch');
  if (branches.length === 0) out.push('NO_BRANCH_LEVEL');
  if (branches.length > 1) out.push('MANY_BRANCH_LEVELS');
  const positions = levels.map((l) => l.position).sort((a, b) => a - b);
  if (positions.some((p, i) => p !== i + 1)) out.push('GAPS');
  const branchPos = branches[0]?.position;
  if (branchPos !== undefined) {
    if (levels.some((l) => l.role === 'group' && l.position > branchPos)) out.push('GROUP_BELOW_BRANCH');
    if (levels.some((l) => l.role === 'place' && l.position < branchPos)) out.push('PLACE_ABOVE_BRANCH');
  }
  return out;
}

export function branchLevelOf<T extends TreeLevel>(levels: readonly T[]): T {
  const l = levels.find((x) => x.role === 'branch');
  if (!l) throw new Error('The organisation has no branch level');
  return l;
}

/**
 * The role a level inserted at `position` (1 … n + 1) takes: at or above the branch level's current position it lands above
 * the branch level (a group level); below it, a place level.
 */
export function roleForNewLevel(levels: readonly TreeLevel[], position: number): 'group' | 'place' {
  return position <= branchLevelOf(levels).position ? 'group' : 'place';
}

/** The levels whose position changes when one is inserted at `position` (they move one down). */
export function positionsAfterInsert(levels: readonly TreeLevel[], position: number): Array<{ id: string; position: number }> {
  return levels.filter((l) => l.position >= position).map((l) => ({ id: l.id, position: l.position + 1 }));
}

/** The levels whose position changes when `id` is deleted (they move one up). */
export function positionsAfterDelete(levels: readonly TreeLevel[], id: string): Array<{ id: string; position: number }> {
  const gone = levels.find((l) => l.id === id);
  if (!gone) return [];
  return levels.filter((l) => l.position > gone.position).map((l) => ({ id: l.id, position: l.position - 1 }));
}

export interface TemplateLevelPlan {
  /** The organisation's branch level keeps its id (its branches' nodes point at it) and takes the template's name / position. */
  branch: { id: string; position: number; name: string; nameAr: string; icon: LocationLevelIcon };
  /** Every other existing level goes (the template applies only while no group / place location exists). */
  deleteIds: string[];
  insert: Array<{ position: number; role: 'group' | 'place'; name: string; nameAr: string; icon: LocationLevelIcon }>;
}

/** How to turn the current level list into the template's. */
export function templateLevelPlan(current: readonly TreeLevel[], template: LocationTemplate): TemplateLevelPlan {
  const branchLevel = branchLevelOf(current);
  const branchIndex = template.levels.findIndex((l) => l.role === 'branch');
  const tb = template.levels[branchIndex];
  if (!tb) throw new Error(`Template ${template.key} has no branch level`);
  return {
    branch: { id: branchLevel.id, position: branchIndex + 1, name: tb.name, nameAr: tb.nameAr, icon: tb.icon },
    deleteIds: current.filter((l) => l.role !== 'branch').map((l) => l.id),
    insert: template.levels.flatMap((l, i) => (l.role === 'branch' ? [] : [{ position: i + 1, role: l.role as 'group' | 'place', name: l.name, nameAr: l.nameAr, icon: l.icon }])),
  };
}

// ----- placement ---------------------------------------------------------------------------------------------------------------

export type PlacementProblem =
  | 'PLACE_AT_TOP'            // a place must sit under its branch or another place
  | 'NOT_DEEPER'              // the child's level must be below the parent's
  | 'GROUP_UNDER_NON_GROUP'   // group nodes sit under group nodes (or at the top)
  | 'BRANCH_UNDER_NON_GROUP'  // branch nodes sit under a group node (or at the top)
  | 'PLACE_UNDER_GROUP'       // a place sits under a branch or a place
  | 'CYCLE'                   // a node cannot move under itself or its descendants
  | 'PARENT_ARCHIVED';        // nothing new goes under an archived node

export interface PlacementParent { id: string; role: LocationLevelRole; levelPosition: number; path: readonly string[]; status?: string }

/** Why a node of `role` on a level at `levelPosition` cannot sit under `parent` (null = it can). `selfId` for a move. */
export function placementProblem(args: { role: LocationLevelRole; levelPosition: number; parent: PlacementParent | null; selfId?: string }): PlacementProblem | null {
  const { role, levelPosition, parent, selfId } = args;
  if (!parent) return role === 'place' ? 'PLACE_AT_TOP' : null;
  if (selfId && parent.path.includes(selfId)) return 'CYCLE';
  if (parent.status === 'archived') return 'PARENT_ARCHIVED';
  if (role === 'group' && parent.role !== 'group') return 'GROUP_UNDER_NON_GROUP';
  if (role === 'branch' && parent.role !== 'group') return 'BRANCH_UNDER_NON_GROUP';
  if (role === 'place' && parent.role === 'group') return 'PLACE_UNDER_GROUP';
  if (parent.levelPosition >= levelPosition) return 'NOT_DEEPER';
  return null;
}

/** The levels a new child of `parent` may use (null = a top-level node): deeper than the parent, of a fitting kind. */
export function childLevelsFor<T extends TreeLevel>(levels: readonly T[], parent: { role: LocationLevelRole; levelPosition: number } | null): T[] {
  return levels.filter((l) => l.role !== 'branch' && placementProblem({ role: l.role, levelPosition: l.position, parent: parent ? { id: '', path: [], ...parent } : null }) === null)
    .sort((a, b) => a.position - b.position);
}

// ----- tree walks --------------------------------------------------------------------------------------------------------------

function childrenIndex<T extends { id: string; parentId: string | null }>(nodes: readonly T[]): Map<string | null, T[]> {
  const out = new Map<string | null, T[]>();
  for (const n of nodes) { const list = out.get(n.parentId) ?? []; list.push(n); out.set(n.parentId, list); }
  return out;
}

/** The node and every node below it (ids). */
export function subtreeIds<T extends { id: string; parentId: string | null }>(nodes: readonly T[], rootId: string): string[] {
  const children = childrenIndex(nodes);
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue; // defensive: the database refuses cycles
    seen.add(id); out.push(id);
    for (const c of children.get(id) ?? []) stack.push(c.id);
  }
  return out;
}

/** The ancestors of a node, root first (the node itself excluded). */
export function ancestorsOf<T extends { id: string; parentId: string | null }>(nodes: readonly T[], id: string): T[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: T[] = [];
  let cursor = byId.get(id)?.parentId ?? null;
  for (let hops = 0; cursor && hops < 64; hops++) {
    const n = byId.get(cursor);
    if (!n) break;
    out.unshift(n);
    cursor = n.parentId;
  }
  return out;
}

/** Sum of a per-node count over each node's subtree. */
export function rollUp<T extends { id: string; parentId: string | null }>(nodes: readonly T[], direct: ReadonlyMap<string, number>): Map<string, number> {
  const children = childrenIndex(nodes);
  const out = new Map<string, number>();
  const visit = (id: string, guard: Set<string>): number => {
    const known = out.get(id);
    if (known !== undefined) return known;
    if (guard.has(id)) return 0;
    guard.add(id);
    let sum = direct.get(id) ?? 0;
    for (const c of children.get(id) ?? []) sum += visit(c.id, guard);
    out.set(id, sum);
    return sum;
  };
  for (const n of nodes) visit(n.id, new Set());
  return out;
}

/**
 * The label of a place below its branch: the names from the branch's first child down to the place, e.g. "Site A › Floor 2".
 * A branch / group node is labelled by its own name.
 */
export function placeLabel<T extends { id: string; parentId: string | null; role: LocationLevelRole; name: string }>(nodes: ReadonlyMap<string, T>, id: string, separator = ' › '): string | null {
  const node = nodes.get(id);
  if (!node) return null;
  if (node.role !== 'place') return node.name;
  const names: string[] = [];
  let cursor: T | undefined = node;
  for (let hops = 0; cursor && cursor.role === 'place' && hops < 64; hops++) {
    names.unshift(cursor.name);
    cursor = cursor.parentId ? nodes.get(cursor.parentId) : undefined;
  }
  return names.join(separator);
}

// ----- codes -------------------------------------------------------------------------------------------------------------------

/**
 * A code for a location named `name`, unique among `taken` (case-insensitive): letters / digits of the name upper-cased and
 * joined by "-", at most 32 characters (codeSchema), suffixed -2, -3… on a clash. Falls back to "LOC" for a name without
 * Latin letters or digits (e.g. Arabic only).
 */
export function deriveLocationCode(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((c) => c.toLowerCase()));
  const base = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28).replace(/-+$/, '') || 'LOC';
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error('No free location code');
}
