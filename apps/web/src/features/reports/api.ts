import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateReportRequest, ReportFormat, ReportRequestDto, ReportTypeDefinition } from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';

export type ListQuery = Record<string, string | number | boolean | undefined>;
export type ReportTypeDef = ReportTypeDefinition & { allowed: boolean | null };
export type ReportDto = ReportRequestDto & { branchId?: string | null; jobId?: string | null; startedAt?: string | null };
export type ReportAccepted = ReportDto & { jobId: string | null; status: 'QUEUED' };
export interface DownloadResult { url: string; expiresInSeconds: number; fileName: string; disposition?: ReportDisposition }
/** `attachment` downloads the file under the report's name; `inline` returns a URL the browser shows in place (the viewer). */
export type ReportDisposition = 'inline' | 'attachment';
export type FileRequest = string | { id: string; disposition?: ReportDisposition };

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
  const download = useMutation({ mutationFn: (req: FileRequest) => fetchReportFile(orgId, req) });
  return { create, cancel, download };
}

/**
 * A short-lived signed URL for a report file, minted through the caller's own session (the API re-checks access each time). An
 * employee's own copy (a report about them shared with them) goes through the same endpoint.
 */
export async function fetchReportFile(orgId: string, req: FileRequest): Promise<DownloadResult> {
  const { id, disposition = 'attachment' } = typeof req === 'string' ? { id: req } : req;
  return (await api.get<Envelope<DownloadResult>>(`/orgs/${orgId}/reports/${id}/download`, { disposition })).data;
}

/** The reports about the signed-in employee that were shared with them (the portal's "My reports"). */
export function useMyReports(query: ListQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, 'my-reports', query),
    queryFn: () => api.get<PageEnvelope<ReportDto>>(`/orgs/${orgId}/me/reports`, query),
    placeholderData: keepPreviousData,
    enabled,
    refetchInterval: (q) => (q.state.data?.data.some((r) => ACTIVE.has(r.status)) ? 5_000 : false),
  });
}

/** Open a short-lived signed URL in a new tab (anchor click keeps popup blockers happy after an async call). */
export function openSignedUrl(url: string, fileName?: string) {
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener'; if (fileName) a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
}

/** `late_report-2026-09-29.pdf` → { reportType: 'late_report', format: 'pdf' } (the API's file-name convention). */
export function fileFacts(fileName: string | undefined): { reportType?: string; format?: ReportFormat } {
  const m = fileName ? /^(.+)-\d{4}-\d{2}-\d{2}\.(pdf|csv|xlsx)$/.exec(fileName) : null;
  return m ? { reportType: m[1], format: m[2] as ReportFormat } : {};
}
