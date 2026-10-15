import { useCallback } from 'react';
import { useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';

/**
 * A branch's IANA zone (a room, its meetings and its entries live in the branch's time), else the organisation's — also when the
 * viewer cannot read the branches.
 */
export function useBranchZone(): (branchId: string | null | undefined) => string {
  const orgTz = useOrgTimezone();
  const branches = useBranchOptions(true);
  const byId = branches.byId;
  return useCallback((branchId) => (branchId ? byId.get(branchId)?.timezone : undefined) ?? orgTz, [byId, orgTz]);
}
