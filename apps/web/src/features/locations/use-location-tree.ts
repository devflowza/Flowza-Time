import { useCallback, useMemo } from 'react';
import type { LocationDto, LocationLevelDto } from '@flowza/contracts';
import { useLocalName } from '@/lib/local-name';
import { useLocationLevels, useLocations } from './api';
import { indexLocations, pathLabel, type LocationTreeIndex } from './tree';

export interface LocationTree extends LocationTreeIndex {
  isLoading: boolean;
  /** A refetch is in flight (e.g. after a write, or while switching to the list with archived locations). */
  isFetching: boolean;
  /** The levels' or the locations' load error, if either failed. */
  error: unknown;
  /** Reload both lists (an error state's retry). */
  refetch: () => void;
  /** A node's name in the UI language (its Arabic name in Arabic when it has one). */
  nameOf: (node: LocationDto) => string;
  /** A level's name in the UI language. */
  levelName: (levelOrId: LocationLevelDto | string | null | undefined) => string;
  /** A node's path ("Muscat HQ › Branch 1 › Site A"); `fromBranch` starts below the branch for a place. */
  labelOf: (id: string | null | undefined, opts?: { fromBranch?: boolean }) => string;
}

/** The organisation's levels and locations, indexed, with localised names. Empty (and harmless) without branch.view. */
export function useLocationTree(opts: { includeArchived?: boolean; enabled?: boolean } = {}): LocationTree {
  const levels = useLocationLevels(opts.enabled ?? true);
  const locations = useLocations(opts);
  const local = useLocalName();
  const index = useMemo(() => indexLocations(locations.data ?? [], levels.data ?? []), [locations.data, levels.data]);
  const nameOf = useCallback((n: LocationDto) => local(n.name, n.nameAr), [local]);
  const levelName = useCallback((l: LocationLevelDto | string | null | undefined) => {
    const level = typeof l === 'string' ? index.levelsById.get(l) : l;
    return level ? local(level.name, level.nameAr) : '';
  }, [index, local]);
  const labelOf = useCallback((id: string | null | undefined, o?: { fromBranch?: boolean }) => (id ? pathLabel(index, id, nameOf, o) : ''), [index, nameOf]);
  const { refetch: refetchLevels } = levels;
  const { refetch: refetchLocations } = locations;
  const refetch = useCallback(() => { void refetchLevels(); void refetchLocations(); }, [refetchLevels, refetchLocations]);
  const isLoading = levels.isLoading || locations.isLoading;
  const isFetching = levels.isFetching || locations.isFetching;
  const error: unknown = levels.error ?? locations.error ?? null;
  // one object per change of the data or the language, so callers can memoise on it
  return useMemo(
    () => ({ ...index, isLoading, isFetching, error, refetch, nameOf, levelName, labelOf }),
    [index, isLoading, isFetching, error, refetch, nameOf, levelName, labelOf],
  );
}
