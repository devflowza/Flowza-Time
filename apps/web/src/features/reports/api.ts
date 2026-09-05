import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateReportRequest, ReportRequestDto, ReportTypeDefinition } from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';

export type ListQuery = Record<string, string | number | boolean | undefined>;
export type ReportTypeDef = ReportTypeDefinition & { allowed: boolean | null };
export type ReportDto = ReportRequestDto & { branchId?: string | null; jobId?: string | null; startedAt?: string | null };
export type ReportAccepted = ReportDto & { jobId: string | null; status: 'QUEUED' };
export interface DownloadResult { url: string; expiresInSeconds: number; fileName: string }

const ACTIVE = new Set(['QUEUED', 'RUNNING']);

export function useReportTypes() {
  const orgId = useOrgId();
  return useQuery({ queryKey: ['report-types', orgId], queryFn: async () => (await api.get<Envelope<ReportTypeDef[]>>('/report-types', { orgId })).data, staleTime: 10 * 60_000 });
}
/** My reports; polls every 5 s while any row is QUEUED/RUNNING (Realtime is an accelerator, polling the baseline). */
export function useReports(query: ListQuery) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, 'reports', query),
    queryFn: () => api.get<PageEnvelope<ReportDto>>(`/orgs/${orgId}/reports`, query),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.data.some((r) => ACTIVE.has(r.status)) ? 5_000 : false),
  });
}
export function useReportMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.entity(orgId, 'reports') });
  const create = useMutation({ mutationFn: async (input: CreateReportRequest) => (await api.post<Envelope<ReportAccepted>>(`/orgs/${orgId}/reports`, input, { idempotencyKey: crypto.randomUUID() })).data, onSuccess: invalidate });
  const cancel = useMutation({ mutationFn: async (id: string) => (await api.post<Envelope<ReportDto>>(`/orgs/${orgId}/reports/${id}/cancel`)).data, onSuccess: invalidate });
  const download = useMutation({ mutationFn: async (id: string) => (await api.get<Envelope<DownloadResult>>(`/orgs/${orgId}/reports/${id}/download`)).data });
  return { create, cancel, download };
}

/** Open a short-lived signed URL in a new tab (anchor click keeps popup blockers happy after an async call). */
export function openSignedUrl(url: string, fileName?: string) {
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener'; if (fileName) a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
}
