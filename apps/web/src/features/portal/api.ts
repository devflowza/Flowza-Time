import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SelfAttendanceMonthDto, SelfLeaveDto, SelfLeaveRecordDto, SelfLeaveRequestInput, SelfOverviewDto, SelfProfileDto } from '@flowza/contracts';
import { api, type Envelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';

/** Query-key entity for everything under /orgs/:orgId/me (the caller's own employee record). */
export const SELF = 'self-service';

export function useSelfOverview() {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, SELF, { view: 'overview' }), queryFn: async () => (await api.get<Envelope<SelfOverviewDto>>(`/orgs/${orgId}/me/overview`)).data, staleTime: 30_000 });
}
export function useSelfProfile() {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, SELF, { view: 'profile' }), queryFn: async () => (await api.get<Envelope<SelfProfileDto>>(`/orgs/${orgId}/me/profile`)).data, staleTime: 5 * 60_000 });
}
export function useSelfAttendance(month: string) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, SELF, { view: 'attendance', month }), queryFn: async () => (await api.get<Envelope<SelfAttendanceMonthDto>>(`/orgs/${orgId}/me/attendance`, { month })).data, placeholderData: keepPreviousData, staleTime: 30_000 });
}
export function useSelfLeave(year: number) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, SELF, { view: 'leave', year }), queryFn: async () => (await api.get<Envelope<SelfLeaveDto>>(`/orgs/${orgId}/me/leave`, { year })).data, placeholderData: keepPreviousData, staleTime: 30_000 });
}

export function useSelfLeaveMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { for (const e of [SELF, 'leave-records', 'approvals-inbox', 'approval-request', 'approvals-mine']) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
  const apply = useMutation({ mutationFn: async (input: SelfLeaveRequestInput) => (await api.post<Envelope<SelfLeaveRecordDto>>(`/orgs/${orgId}/me/leave`, input, { idempotencyKey: crypto.randomUUID() })).data, onSuccess: invalidate });
  const withdraw = useMutation({ mutationFn: async (id: string) => (await api.post<Envelope<SelfLeaveRecordDto>>(`/orgs/${orgId}/me/leave/${id}/cancel`)).data, onSuccess: invalidate });
  return { apply, withdraw };
}
