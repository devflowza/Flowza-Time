import { MUSTER_STATES, type LocationMusterEntryDto, type MusterState, type MusterTotals } from '@flowza/contracts';
import type { LocationTreeIndex } from '@/features/locations/tree';

/*
 * The muster list ("on site now", Enterprise advanced_scheduling — docs/locations.md §4): display helpers of
 * /attendance/muster. The API is the authority on who is where; these only order, filter and colour what it returns. Pure,
 * except the remembered location (browser storage, every access guarded).
 */

/** The tenant palette's chart tokens per state (docs/design.md §11): a style change recolours the tiles and badges. */
export const MUSTER_TONE: Record<MusterState, { chip: string; dot: string; bar: string }> = {
  on_site: { chip: 'bg-chart-present/12 text-chart-present', dot: 'bg-chart-present', bar: 'bg-chart-present' },
  on_break: { chip: 'bg-chart-late/12 text-chart-late', dot: 'bg-chart-late', bar: 'bg-chart-late' },
  left: { chip: 'bg-chart-leave/12 text-chart-leave', dot: 'bg-chart-leave', bar: 'bg-chart-leave' },
  // direction unknown (a plain PUNCH): neutral
  seen: { chip: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground/60', bar: 'bg-muted-foreground/50' },
};

/** Everyone the totals count (each employee is in exactly one state). */
export const musterTotal = (totals: MusterTotals): number => MUSTER_STATES.reduce((n, s) => n + (totals[s] ?? 0), 0);

export type MusterSort = 'employee' | 'state' | 'time' | 'terminal' | 'place';
const STATE_RANK = new Map<MusterState, number>(MUSTER_STATES.map((s, i) => [s, i]));
const byName = (a: LocationMusterEntryDto, b: LocationMusterEntryDto) => a.displayName.localeCompare(b.displayName) || a.employeeNumber.localeCompare(b.employeeNumber);

/** Sorted copy: by the column (state = on site, on break, left, seen), then by name. */
export function sortMusterEntries(entries: readonly LocationMusterEntryDto[], sort: MusterSort, order: 'asc' | 'desc'): LocationMusterEntryDto[] {
  const dir = order === 'asc' ? 1 : -1;
  const primary = (a: LocationMusterEntryDto, b: LocationMusterEntryDto): number => {
    switch (sort) {
      case 'state': return (STATE_RANK.get(a.state) ?? 99) - (STATE_RANK.get(b.state) ?? 99);
      case 'time': return a.punchedAt.localeCompare(b.punchedAt);
      case 'terminal': return a.deviceName.localeCompare(b.deviceName);
      case 'place': return a.locationName.localeCompare(b.locationName);
      default: return 0;
    }
  };
  return [...entries].sort((a, b) => dir * (primary(a, b) || byName(a, b)));
}

/** The entries of a state (null = all) whose name or employee number contains the search text. */
export function filterMusterEntries(entries: readonly LocationMusterEntryDto[], state: MusterState | null, search: string): LocationMusterEntryDto[] {
  const q = search.trim().toLocaleLowerCase();
  return entries.filter((e) => (!state || e.state === state) && (!q || e.displayName.toLocaleLowerCase().includes(q) || e.employeeNumber.toLocaleLowerCase().includes(q)));
}

// ---- the location the page opens on -------------------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const storageKey = (orgId: string, userId: string) => `flowza.muster.location.${orgId}.${userId}`;

/** The location this viewer last looked at in this organisation (null when storage is unavailable or empty). */
export function readRememberedLocation(orgId: string, userId: string): string | null {
  try { return window.localStorage.getItem(storageKey(orgId, userId)); } catch { return null; }
}
/** Remember the location for the next visit; storage may be unavailable (private mode, blocked site data). */
export function rememberLocation(orgId: string, userId: string, locationId: string): void {
  try { window.localStorage.setItem(storageKey(orgId, userId), locationId); } catch { /* the page works without it */ }
}

/** The first branch node in tree order (depth-first, siblings by name), stopping as soon as it is found. */
function firstBranch(children: LocationTreeIndex['children']): string | null {
  const stack = [...(children.get(null) ?? [])].reverse();
  const seen = new Set<string>();
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    if (n.role === 'branch') return n.id;
    stack.push(...[...(children.get(n.id) ?? [])].reverse());
  }
  return null;
}

/**
 * The location the page shows: the one in the address (a link or the back button), else the remembered one while it still
 * exists, else the first branch of the tree, else its first node (null = nothing to show yet).
 */
export function musterLocation(index: Pick<LocationTreeIndex, 'byId' | 'children' | 'nodes'>, fromUrl: string | null, remembered: string | null): string | null {
  if (fromUrl && UUID.test(fromUrl)) return fromUrl;
  if (remembered && index.byId.has(remembered)) return remembered;
  return firstBranch(index.children) ?? index.nodes[0]?.id ?? null;
}
