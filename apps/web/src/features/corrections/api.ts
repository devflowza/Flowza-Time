import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateCorrectionInput } from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';
import type { CorrectionDto } from '@/features/attendance/types';

export type ListQuery = Record<string, string | number | boolean | undefined>;
export type CorrectionCreated = CorrectionDto & { approval: 'AUTO_APPROVED' | 'PENDING'; approvalRequestId: string | null };
export const CORRECTIONS = 'attendance-corrections';

export function useCorrections(query: ListQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, CORRECTIONS, query), queryFn: () => api.get<PageEnvelope<CorrectionDto>>(`/orgs/${orgId}/attendance/corrections`, query), placeholderData: keepPreviousData, enabled });
}

export function useCorrectionMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { for (const e of [CORRECTIONS, 'approvals-inbox', 'attendance-records', 'attendance-daily', 'attendance-monthly']) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
  const create = useMutation({ mutationFn: async (input: CreateCorrectionInput) => (await api.post<Envelope<CorrectionCreated>>(`/orgs/${orgId}/attendance/corrections`, input, { idempotencyKey: crypto.randomUUID() })).data, onSuccess: invalidate });
  const cancel = useMutation({ mutationFn: async ({ id, reason }: { id: string; reason?: string }) => (await api.post<Envelope<CorrectionDto>>(`/orgs/${orgId}/attendance/corrections/${id}/cancel`, { reason: reason || undefined })).data, onSuccess: invalidate });
  return { create, cancel };
}
