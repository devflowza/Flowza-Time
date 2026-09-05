import { useEffect, useRef } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeviceReconciliationDto, SyncAttendanceRequest, SyncDeviceScope, SyncEmployeesRequest, SyncJobAcceptedDto, SyncJobDto, SyncJobItemDto, SyncReconcileRequest, SyncStatus } from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { supabase } from '@/lib/supabase';
import { useOrgId } from '@/features/me/use-me';

export type ListQuery = Record<string, string | number | boolean | undefined>;
export type SyncJobDetail = SyncJobDto & { branchId?: string | null; parentJobId?: string | null; items?: SyncJobItemDto[] };

const JOBS = 'sync-jobs';
const ACTIVE: readonly SyncStatus[] = ['PENDING', 'QUEUED', 'RUNNING', 'RETRYING'];
export const isActiveJob = (status: SyncStatus): boolean => ACTIVE.includes(status);

/** Paginated jobs; refetches every 10 s while any job on the page is still active. */
export function useSyncJobs(query: ListQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, JOBS, query),
    queryFn: () => api.get<PageEnvelope<SyncJobDto>>(`/orgs/${orgId}/sync/jobs`, query),
    placeholderData: keepPreviousData,
    enabled,
    refetchInterval: (q) => (q.state.data?.data.some((j) => isActiveJob(j.status)) ? 10_000 : false),
  });
}

/** One job (items are loaded separately); polls every 3 s while active — realtime signals only shorten the wait. */
export function useSyncJob(id: string | undefined) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.detail(orgId, JOBS, id ?? ''),
    queryFn: async () => (await api.get<Envelope<SyncJobDetail>>(`/orgs/${orgId}/sync/jobs/${id}`, { pageSize: 1 })).data,
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && isActiveJob(q.state.data.status) ? 3_000 : false),
  });
}

export function useSyncJobItems(id: string | undefined, query: ListQuery, active: boolean) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: [...qk.detail(orgId, JOBS, id ?? ''), 'items', query],
    queryFn: () => api.get<PageEnvelope<SyncJobItemDto>>(`/orgs/${orgId}/sync/jobs/${id}/items`, query),
    enabled: !!id,
    placeholderData: keepPreviousData,
    refetchInterval: active ? 3_000 : false,
  });
}

export function useReconciliation(query: { branchId?: string; deviceId?: string }) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'reconciliation', query), queryFn: async () => (await api.get<Envelope<DeviceReconciliationDto[]>>(`/orgs/${orgId}/sync/reconciliation`, query)).data, refetchInterval: 30_000 });
}

export function useSyncMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidateJobs = () => { void qc.invalidateQueries({ queryKey: qk.entity(orgId, JOBS) }); void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'devices') }); };
  const idem = () => ({ idempotencyKey: crypto.randomUUID() });
  const syncAttendance = useMutation({ mutationFn: async (input: SyncAttendanceRequest) => (await api.post<Envelope<SyncJobAcceptedDto>>(`/orgs/${orgId}/sync/attendance`, input, idem())).data, onSuccess: invalidateJobs });
  const syncEmployees = useMutation({ mutationFn: async (input: SyncEmployeesRequest) => (await api.post<Envelope<SyncJobAcceptedDto>>(`/orgs/${orgId}/sync/employees`, input, idem())).data, onSuccess: invalidateJobs });
  const healthCheck = useMutation({ mutationFn: async (input: SyncDeviceScope) => (await api.post<Envelope<SyncJobAcceptedDto>>(`/orgs/${orgId}/sync/health-check`, input, idem())).data, onSuccess: invalidateJobs });
  const reconcile = useMutation({ mutationFn: async (input: SyncReconcileRequest) => (await api.post<Envelope<SyncJobAcceptedDto>>(`/orgs/${orgId}/sync/reconcile`, input, idem())).data, onSuccess: () => { invalidateJobs(); void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'reconciliation') }); } });
  const cancel = useMutation({ mutationFn: async (id: string) => (await api.post<Envelope<SyncJobDto & { cancelledItems: number }>>(`/orgs/${orgId}/sync/jobs/${id}/cancel`)).data, onSuccess: invalidateJobs });
  const retryFailed = useMutation({ mutationFn: async (id: string) => (await api.post<Envelope<SyncJobAcceptedDto & { parentJobId: string }>>(`/orgs/${orgId}/sync/jobs/${id}/retry-failed`, undefined, idem())).data, onSuccess: invalidateJobs });
  return { syncAttendance, syncEmployees, healthCheck, reconcile, cancel, retryFailed };
}

/**
 * Supabase Realtime carries invalidation signals only (channel org:<orgId>:sync, private). Polling stays the baseline; a
 * signal simply triggers an earlier refetch. The subscription is removed on unmount / org change.
 */
export function useSyncRealtime(onSignal: () => void, enabled = true) {
  const orgId = useOrgId();
  const cb = useRef(onSignal);
  useEffect(() => { cb.current = onSignal; }, [onSignal]);
  useEffect(() => {
    if (!enabled) return;
    const channel = supabase.channel(`org:${orgId}:sync`, { config: { private: true } });
    channel.on('broadcast', { event: '*' }, () => cb.current()).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [orgId, enabled]);
}
