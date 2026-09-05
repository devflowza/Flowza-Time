import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PeriodLockInput, RecalculateInput } from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';
import type { AttendanceEventDto, DailyRecord, MonthlyRow, PeriodLockDto, RawPage, RecalcAccepted, RecalculationDto, RecordDetail } from './types';

export type ListQuery = Record<string, string | number | boolean | undefined>;
export type DailyPage = PageEnvelope<DailyRecord> & { meta: { byStatus?: Record<string, number> } };
export type MonthlyPage = PageEnvelope<MonthlyRow> & { meta: { month?: string; days?: string[] } };

const RECORDS = 'attendance-records';

export function useDailyAttendance(query: ListQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'attendance-daily', query), queryFn: () => api.get<DailyPage>(`/orgs/${orgId}/attendance/daily`, query), placeholderData: keepPreviousData, enabled });
}
export function useMonthlyAttendance(query: ListQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'attendance-monthly', query), queryFn: () => api.get<MonthlyPage>(`/orgs/${orgId}/attendance/monthly`, query), placeholderData: keepPreviousData, enabled, staleTime: 30_000 });
}
export function useAttendanceRecord(id: string | null) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.detail(orgId, RECORDS, id ?? ''), queryFn: async () => (await api.get<Envelope<RecordDetail>>(`/orgs/${orgId}/attendance/records/${id}`)).data, enabled: !!id });
}
/** Events of one employee in a date range (≤ 62 days, branch timezone). */
export function useAttendanceEvents(params: { employeeId?: string | null; from?: string; to?: string }, enabled = true) {
  const orgId = useOrgId();
  const ok = !!params.employeeId && !!params.from && !!params.to;
  return useQuery({ queryKey: qk.list(orgId, 'attendance-events', params), queryFn: async () => (await api.get<Envelope<AttendanceEventDto[]>>(`/orgs/${orgId}/attendance/events`, { employeeId: params.employeeId ?? undefined, from: params.from, to: params.to })).data, enabled: enabled && ok, staleTime: 10_000 });
}
export function useRawTransactions(query: ListQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'attendance-raw', query), queryFn: () => api.get<RawPage>(`/orgs/${orgId}/attendance/raw`, query), placeholderData: keepPreviousData, enabled });
}
export function useRecalculations(query: ListQuery) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, 'attendance-recalculations', query),
    queryFn: () => api.get<PageEnvelope<RecalculationDto>>(`/orgs/${orgId}/attendance/recalculations`, query),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.data.some((r) => r.status === 'QUEUED' || r.status === 'RUNNING') ? 5_000 : false),
  });
}
export function usePeriodLocks(query: ListQuery) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'attendance-periods', query), queryFn: async () => (await api.get<Envelope<PeriodLockDto[]>>(`/orgs/${orgId}/attendance/periods`, query)).data, placeholderData: keepPreviousData });
}

export function useAttendanceMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const inv = (entity: string) => qc.invalidateQueries({ queryKey: qk.entity(orgId, entity) });
  const requeueRaw = useMutation({ mutationFn: async (id: string) => (await api.post<Envelope<{ id: string; processingStatus: string }>>(`/orgs/${orgId}/attendance/raw/${id}/requeue`)).data, onSuccess: () => inv('attendance-raw') });
  const recalculate = useMutation({ mutationFn: async (input: RecalculateInput) => (await api.post<Envelope<RecalcAccepted>>(`/orgs/${orgId}/attendance/recalculate`, input, { idempotencyKey: crypto.randomUUID() })).data, onSuccess: () => inv('attendance-recalculations') });
  const invalidateLocks = () => { void inv('attendance-periods'); void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'payroll-periods') }); };
  const lockPeriod = useMutation({ mutationFn: async (input: PeriodLockInput) => (await api.post<Envelope<PeriodLockDto>>(`/orgs/${orgId}/attendance/periods/lock`, input)).data, onSuccess: invalidateLocks });
  const unlockPeriod = useMutation({ mutationFn: async ({ id, reason }: { id: string; reason: string }) => (await api.post<Envelope<PeriodLockDto>>(`/orgs/${orgId}/attendance/periods/${id}/unlock`, { reason })).data, onSuccess: invalidateLocks });
  return { requeueRaw, recalculate, lockPeriod, unlockPeriod };
}

/** Invalidate everything derived from daily records (after corrections / recalculations). */
export function useInvalidateAttendance() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  return () => { for (const e of ['attendance-daily', 'attendance-monthly', RECORDS, 'attendance-events']) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
}
