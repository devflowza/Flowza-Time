import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { DashboardBranchRow, DashboardSummary, DashboardTrendPoint } from '@flowza/contracts';
import { api, type Envelope } from '@/lib/api-client';
import { useOrgId } from '@/features/me/use-me';

export const dashboardKeys = {
  all: (orgId: string) => ['dashboard', orgId] as const,
  summary: (orgId: string, date: string) => ['dashboard', orgId, 'summary', date] as const,
  trends: (orgId: string, from: string, to: string) => ['dashboard', orgId, 'trends', from, to] as const,
  branches: (orgId: string, date: string) => ['dashboard', orgId, 'branches', date] as const,
};

/** Today's counts (or any past day's). Polled every minute — the dashboard is the screen people leave open. */
export function useDashboardSummary(date: string) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: dashboardKeys.summary(orgId, date),
    queryFn: async () => (await api.get<Envelope<DashboardSummary>>(`/orgs/${orgId}/dashboard/summary`, { date })).data,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}

/** One point per day of the window, inclusive. The API caps the window at 92 days. */
export function useDashboardTrends(from: string, to: string) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: dashboardKeys.trends(orgId, from, to),
    queryFn: async () => (await api.get<Envelope<DashboardTrendPoint[]>>(`/orgs/${orgId}/dashboard/trends`, { from, to })).data,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
}

/** Per-branch counts for a day, limited to the caller's branch scope by the API. */
export function useDashboardBranches(date: string) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: dashboardKeys.branches(orgId, date),
    queryFn: async () => (await api.get<Envelope<DashboardBranchRow[]>>(`/orgs/${orgId}/dashboard/branches`, { date })).data,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}
