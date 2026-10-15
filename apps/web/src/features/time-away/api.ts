import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { TimeAwayKind, TimeAwayRequestDto, TimeAwayStatus, TimeAwaySummaryRowDto } from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';

/*
 * The HR side of time away (docs/time-away.md): GET /orgs/:orgId/time-away/summary (monthly totals per employee from the
 * calculated days) and GET /orgs/:orgId/time-away (the requests). Organisation-wide with attendance.view (branch scope applies);
 * a line manager with attendance.view_team only sees their team — the API narrows the scope itself.
 */

/** The entity the portal's time-away mutations invalidate too, so a decision shows here at once. */
export const TIME_AWAY = 'time-away';

export interface TimeAwaySummaryQuery { month: string; branchId?: string | undefined; departmentId?: string | undefined }
export function useTimeAwaySummary(query: TimeAwaySummaryQuery) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, TIME_AWAY, { summary: true, ...query }),
    queryFn: async () => (await api.get<Envelope<TimeAwaySummaryRowDto[]>>(`/orgs/${orgId}/time-away/summary`, { ...query })).data,
    placeholderData: keepPreviousData, staleTime: 30_000,
  });
}

export interface TimeAwayListQuery {
  from: string; to: string; status?: TimeAwayStatus | undefined; kind?: TimeAwayKind | undefined; employeeId?: string | undefined; branchId?: string | undefined; page: number; pageSize: number;
}
export function useTimeAwayRequests(query: TimeAwayListQuery) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, TIME_AWAY, query),
    queryFn: () => api.get<PageEnvelope<TimeAwayRequestDto>>(`/orgs/${orgId}/time-away`, { ...query }),
    placeholderData: keepPreviousData, staleTime: 30_000,
  });
}
