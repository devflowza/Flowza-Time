import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateReportScheduleInput, ReportDeliveryDto, ReportRecipientOptionsDto, ReportRunNowResultDto, ReportScheduleDto, ReportShareResultDto, ShareReportInput, UpdateReportScheduleInput,
} from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';
import type { ListQuery } from './api';

/** Report sharing and schedules (HR portal Prompt 6a): schedules CRUD + run now, Send now, the delivery trail, the recipient picker. */
const SCHEDULES = 'report-schedules';
const DELIVERIES = 'report-deliveries';

export function useReportSchedules(query: ListQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, SCHEDULES, query), queryFn: () => api.get<PageEnvelope<ReportScheduleDto>>(`/orgs/${orgId}/report-schedules`, query), placeholderData: keepPreviousData, enabled });
}
/** The delivery trail; polls every 5 s while a delivery is still queued. */
export function useReportDeliveries(query: ListQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, DELIVERIES, query),
    queryFn: () => api.get<PageEnvelope<ReportDeliveryDto>>(`/orgs/${orgId}/report-deliveries`, query),
    placeholderData: keepPreviousData, enabled,
    refetchInterval: (q) => (q.state.data?.data.some((d) => d.status === 'queued') ? 5_000 : false),
  });
}
export function useReportRecipients(enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'report-recipients', {}), queryFn: async () => (await api.get<Envelope<ReportRecipientOptionsDto>>(`/orgs/${orgId}/report-recipients`)).data, enabled, staleTime: 60_000 });
}

export function useScheduleMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: qk.entity(orgId, SCHEDULES) }); void qc.invalidateQueries({ queryKey: qk.entity(orgId, DELIVERIES) }); void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'reports') }); };
  const create = useMutation({ mutationFn: async (input: CreateReportScheduleInput) => (await api.post<Envelope<ReportScheduleDto>>(`/orgs/${orgId}/report-schedules`, input, { idempotencyKey: crypto.randomUUID() })).data, onSuccess: invalidate });
  const update = useMutation({ mutationFn: async ({ id, input }: { id: string; input: UpdateReportScheduleInput }) => (await api.patch<Envelope<ReportScheduleDto>>(`/orgs/${orgId}/report-schedules/${id}`, input)).data, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => api.delete<void>(`/orgs/${orgId}/report-schedules/${id}`), onSuccess: invalidate });
  const runNow = useMutation({ mutationFn: async (id: string) => (await api.post<Envelope<ReportRunNowResultDto>>(`/orgs/${orgId}/report-schedules/${id}/run-now`, undefined, { idempotencyKey: crypto.randomUUID() })).data, onSuccess: invalidate });
  const share = useMutation({ mutationFn: async (input: ShareReportInput) => (await api.post<Envelope<ReportShareResultDto>>(`/orgs/${orgId}/reports/share`, input, { idempotencyKey: crypto.randomUUID() })).data, onSuccess: invalidate });
  return { create, update, remove, runNow, share };
}
