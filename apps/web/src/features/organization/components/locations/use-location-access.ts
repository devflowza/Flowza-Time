import { useMemo } from 'react';
import { useActiveMembership, useCan } from '@/features/me/use-me';

/**
 * What the member may change in Organisation → Locations (docs/locations.md §6). UI gating only: RLS and the API decide.
 * - `structure`: the levels, templates, group locations and where a branch sits — `branch.manage` with every branch.
 * - `placesOf(branch)`: the sites / floors / zones of a branch — `branch.manage` with that branch in the member's scope.
 * - `branchOf(branch)`: the branch record itself (Edit branch) — the same scope as its places.
 */
export interface LocationAccess {
  structure: boolean;
  placesOf: (branchId: string | null | undefined) => boolean;
  branchOf: (branchId: string | null | undefined) => boolean;
  /** branch.manage, whatever the scope (to tell a scoped manager why the structure is read-only). */
  manage: boolean;
}

export function useLocationAccess(): LocationAccess {
  const can = useCan();
  const membership = useActiveMembership();
  const manage = can('branch.manage');
  const everyBranch = !!membership?.allBranches;
  const branchIds = membership?.branchIds;
  return useMemo(() => {
    const inScope = (branchId: string | null | undefined) => manage && (everyBranch || (!!branchId && !!branchIds?.includes(branchId)));
    return { structure: manage && everyBranch, placesOf: inScope, branchOf: inScope, manage };
  }, [manage, everyBranch, branchIds]);
}
