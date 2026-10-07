import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SelfShiftChangeInput, ShiftChangeOptionsDto, ShiftChangeRequestDto, ShiftChangeStatus } from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';
import { SELF } from '@/features/portal/api';

/**
 * Shift change requests (Enterprise, module shift_requests). The employee's hooks live under the portal's `self-service` query
 * entity, so a decision in the approvals inbox (which invalidates it) refreshes them; the HR list has its own entity and is
 * refetched whenever the Shifts page mounts it.
 */
const HR_ENTITY = 'shift-change-requests';

export function useMyShiftChanges(enabled = true, status?: ShiftChangeStatus) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, SELF, { view: 'shift-changes', status }),
    queryFn: async () => (await api.get<Envelope<ShiftChangeRequestDto[]>>(`/orgs/${orgId}/me/shift-changes`, { status })).data,
    staleTime: 30_000, enabled,
  });
}

/** The active shifts one may ask for and the shift the employee works on `date` (null = nothing to ask yet). */
export function useShiftChangeOptions(date: string | null) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, SELF, { view: 'shift-change-options', date }),
    queryFn: async () => (await api.get<Envelope<ShiftChangeOptionsDto>>(`/orgs/${orgId}/me/shift-changes/options`, { date: date ?? undefined })).data,
    enabled: !!date, placeholderData: keepPreviousData, staleTime: 60_000,
  });
}

export function useShiftChangeMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  // the portal views, the approvals views the request lands in, and the HR list
  const invalidate = () => { for (const e of [SELF, HR_ENTITY, 'approvals-mine', 'approvals-inbox', 'approval-request']) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
  const create = useMutation({ mutationFn: async (input: SelfShiftChangeInput) => (await api.post<Envelope<ShiftChangeRequestDto>>(`/orgs/${orgId}/me/shift-changes`, input)).data, onSuccess: invalidate });
  const cancel = useMutation({ mutationFn: async (id: string) => (await api.post<Envelope<ShiftChangeRequestDto>>(`/orgs/${orgId}/me/shift-changes/${id}/cancel`, {})).data, onSuccess: invalidate });
  return { create, cancel };
}

export type ShiftChangeListQuery = Record<string, string | number | undefined>;
/** GET /shift-change-requests — HR (attendance.view, branch scope) and line managers (their team), paginated. */
export function useShiftChangeRequests(query: ShiftChangeListQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, HR_ENTITY, query),
    queryFn: () => api.get<PageEnvelope<ShiftChangeRequestDto>>(`/orgs/${orgId}/shift-change-requests`, query),
    placeholderData: keepPreviousData, enabled,
  });
}
