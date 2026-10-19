import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { DashboardBranchRow, DashboardDepartmentRow, DashboardMonthToDate, DashboardSummary, DashboardTrendPoint } from '@flowza/contracts';
import { api, type Envelope } from '@/lib/api-client';
import { useOrgId } from '@/features/me/use-me';

export const dashboardKeys = {
  all: (orgId: string) => ['dashboard', orgId] as const,
  summary: (orgId: string, date: string, locationId: string | null = null) => ['dashboard', orgId, 'summary', date, locationId] as const,
  trends: (orgId: string, from: string, to: string, locationId: string | null = null) => ['dashboard', orgId, 'trends', from, to, locationId] as const,
  branches: (orgId: string, date: string) => ['dashboard', orgId, 'branches', date] as const,
  departments: (orgId: string, date: string, locationId: string | null = null) => ['dashboard', orgId, 'departments', date, locationId] as const,
  monthToDate: (orgId: string, date: string, locationId: string | null = null) => ['dashboard', orgId, 'month-to-date', date, locationId] as const,
};

/** `locationId` (docs/locations.md): a region / branch → its branches; a place → the employees working in it or below. Absent = everything in scope. */
const withLocation = <Q extends Record<string, string>>(query: Q, locationId: string | null | undefined): Q & { locationId?: string } => (locationId ? { ...query, locationId } : query);

/** Today's counts (or any past day's). Polled every minute — the dashboard is the screen people leave open. */
export function useDashboardSummary(date: string, locationId: string | null = null) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: dashboardKeys.summary(orgId, date, locationId),
    queryFn: async () => (await api.get<Envelope<DashboardSummary>>(`/orgs/${orgId}/dashboard/summary`, withLocation({ date }, locationId))).data,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}

/** One point per day of the window, inclusive. The API caps the window at 92 days. */
export function useDashboardTrends(from: string, to: string, locationId: string | null = null) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: dashboardKeys.trends(orgId, from, to, locationId),
    queryFn: async () => (await api.get<Envelope<DashboardTrendPoint[]>>(`/orgs/${orgId}/dashboard/trends`, withLocation({ from, to }, locationId))).data,
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

/** The day's attendance per department in the caller's scope (statistics, 2026-10-19). */
export function useDashboardDepartments(date: string, locationId: string | null = null, enabled = true) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: dashboardKeys.departments(orgId, date, locationId),
    queryFn: async () => (await api.get<Envelope<DashboardDepartmentRow[]>>(`/orgs/${orgId}/dashboard/departments`, withLocation({ date }, locationId))).data,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** The month's indicators from the 1st to `date` (statistics, 2026-10-19); they move slowly, so a five-minute refresh. */
export function useDashboardMonthToDate(date: string, locationId: string | null = null, enabled = true) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: dashboardKeys.monthToDate(orgId, date, locationId),
    queryFn: async () => (await api.get<Envelope<DashboardMonthToDate>>(`/orgs/${orgId}/dashboard/month-to-date`, withLocation({ date }, locationId))).data,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    placeholderData: keepPreviousData,
    enabled,
  });
}
