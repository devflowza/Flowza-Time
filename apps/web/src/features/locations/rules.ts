import { LOCATION_LEVELS_MAX, type LocationDto, type LocationLevelDto, type LocationTemplate } from '@flowza/contracts';
import { ancestorsOf, depthFirst, type LocationTreeIndex } from './tree';

/*
 * The location rules the screens need before asking the server (docs/locations.md §1). The database and the API enforce the
 * same rules (packages/domain/src/locations/tree.ts); these only decide what to offer, so a refusal stays the exception.
 * Pure.
 */

// ----- levels ------------------------------------------------------------------------------------------------------------------

/** Whether one more level fits (at most LOCATION_LEVELS_MAX). */
export function canAddLevel(levels: readonly LocationLevelDto[]): boolean {
  return levels.length < LOCATION_LEVELS_MAX;
}

/**
 * The role a level inserted at `position` (1 … n + 1) takes — the server derives it the same way: at or above the branch
 * level's current position it lands above the branch level (a group level), below it a place level.
 */
export function roleForNewLevel(levels: readonly LocationLevelDto[], position: number): 'group' | 'place' {
  const branch = levels.find((l) => l.role === 'branch');
  return branch && position > branch.position ? 'place' : 'group';
}

export interface LevelInsertionPoint {
  position: number;
  role: 'group' | 'place';
  /** The level that will sit directly above the new one (null = it becomes the top level). */
  above: LocationLevelDto | null;
  /** The level that will sit directly below it (null = it becomes the bottom level). */
  below: LocationLevelDto | null;
}

/** Every position a new level can take, top first, with its neighbours and the role it gets there. */
export function levelInsertionPoints(levels: readonly LocationLevelDto[]): LevelInsertionPoint[] {
  const sorted = [...levels].sort((a, b) => a.position - b.position);
  return Array.from({ length: sorted.length + 1 }, (_, i) => ({ position: i + 1, role: roleForNewLevel(sorted, i + 1), above: sorted[i - 1] ?? null, below: sorted[i] ?? null }));
}

/** Why a level cannot be deleted (null = it can): the branch level never goes; a level goes only once no location uses it. */
export function levelDeleteBlock(level: LocationLevelDto): 'BRANCH_LEVEL' | 'IN_USE' | null {
  if (level.role === 'branch') return 'BRANCH_LEVEL';
  return level.locationCount > 0 ? 'IN_USE' : null;
}

// ----- templates ---------------------------------------------------------------------------------------------------------------

/**
 * Group or place locations exist — archived ones included (the level counts carry them): a template, which replaces every
 * level but the branch level, is refused by the server until they are gone.
 */
export function hasStructureLocations(index: Pick<LocationTreeIndex, 'levels' | 'nodes'>): boolean {
  return index.levels.some((l) => l.role !== 'branch' && l.locationCount > 0) || index.nodes.some((n) => n.role !== 'branch');
}

/** The organisation's levels follow the template: the same kinds with the same icons, top first (names may have changed since). */
export function isCurrentTemplate(levels: readonly LocationLevelDto[], template: LocationTemplate): boolean {
  const sorted = [...levels].sort((a, b) => a.position - b.position);
  return sorted.length === template.levels.length && sorted.every((l, i) => template.levels[i]?.role === l.role && template.levels[i]?.icon === l.icon);
}

// ----- placement ---------------------------------------------------------------------------------------------------------------

/**
 * The levels a new child of `parent` (null = the top of the tree) may use: deeper than the parent's, of the fitting kind —
 * group levels at the top and under a group, place levels under a branch or a place. Branch nodes are never added here (they
 * come with the branches), and nothing new goes under an archived node.
 */
export function childLevelsFor(index: LocationTreeIndex, parent: LocationDto | null): LocationLevelDto[] {
  if (!parent) return index.levels.filter((l) => l.role === 'group');
  if (parent.status === 'archived') return [];
  const parentLevel = index.levelsById.get(parent.levelId);
  if (!parentLevel) return [];
  const kind = parent.role === 'group' ? 'group' : 'place';
  return index.levels.filter((l) => l.role === kind && l.position > parentLevel.position);
}

/**
 * The levels a node may be re-levelled to: its own kind, below its parent's level and above every child's level. Always
 * holds the node's current level when the data is consistent.
 */
export function relevelOptions(index: LocationTreeIndex, node: LocationDto): LocationLevelDto[] {
  if (node.role === 'branch') return index.levels.filter((l) => l.id === node.levelId);
  const parent = node.parentId ? index.byId.get(node.parentId) : undefined;
  const floor = parent ? (index.levelsById.get(parent.levelId)?.position ?? 0) : 0;
  const ceiling = (index.children.get(node.id) ?? []).reduce((m, c) => Math.min(m, index.levelsById.get(c.levelId)?.position ?? Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
  return index.levels.filter((l) => l.role === node.role && l.position > floor && l.position < ceiling);
}

/** The node and every node below it that the caller can see. */
export function subtreeOf(index: LocationTreeIndex, id: string): Set<string> {
  return new Set([id, ...depthFirst(index, id).map((r) => r.node.id)]);
}

/**
 * Whether `candidate` may become the parent of `node` (a move): an active node on a higher level, outside the node's own
 * subtree, of the fitting kind — a group for a group or a branch node, the node's branch or a place for a place (another
 * branch is offered too: the server refuses it only while something refers to the place). `subtree` = subtreeOf(node).
 */
export function canBeParentOf(index: LocationTreeIndex, node: LocationDto, candidate: LocationDto, subtree: ReadonlySet<string> = subtreeOf(index, node.id)): boolean {
  if (candidate.status === 'archived' || subtree.has(candidate.id) || candidate.path.includes(node.id)) return false;
  const nodePosition = index.levelsById.get(node.levelId)?.position;
  const candidatePosition = index.levelsById.get(candidate.levelId)?.position;
  if (nodePosition === undefined || candidatePosition === undefined || candidatePosition >= nodePosition) return false;
  return node.role === 'place' ? candidate.role === 'branch' || candidate.role === 'place' : candidate.role === 'group';
}

// ----- search ------------------------------------------------------------------------------------------------------------------

/** Lower case, without Latin accents or Arabic diacritics (tashkeel), so "zone" finds "Zóne" and "موقع" finds "مَوقِع". */
export function searchKey(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ًͯ-ٰٟ]/g, '').toLowerCase().trim();
}

export interface TreeSearch {
  /** Nodes whose text matches. */
  matches: Set<string>;
  /** The matches and their ancestors (what the filtered tree shows). */
  visible: Set<string>;
}

/** The nodes a search shows: every node whose text (`textOf`: names, code…) contains the query, plus its ancestors; null = no query. */
export function searchTree(index: LocationTreeIndex, query: string, textOf: (node: LocationDto) => readonly (string | null | undefined)[]): TreeSearch | null {
  const q = searchKey(query);
  if (!q) return null;
  const matches = new Set<string>();
  const visible = new Set<string>();
  for (const node of index.nodes) {
    if (!textOf(node).some((s) => !!s && searchKey(s).includes(q))) continue;
    matches.add(node.id);
    visible.add(node.id);
    for (const a of ancestorsOf(index, node.id)) visible.add(a.id);
  }
  return { matches, visible };
}
