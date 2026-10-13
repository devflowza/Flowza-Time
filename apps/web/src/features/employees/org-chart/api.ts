import { useInfiniteQuery, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { ORG_CHART_PAGE_SIZE, type OrgChartFilter, type OrgChartNodeDto, type OrgChartPathDto } from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';
import { EMPLOYEES_ENTITY, idSegment, ORG_CHART_ENTITY } from '../api';

/**
 * What one read of the chart asks for (GET /orgs/:orgId/org-chart): the direct reports of a manager, the heads of the chart,
 * or the people who are not on it yet. Every level sits under `qk.list(orgId, 'org-chart', …)`, so invalidating the
 * `org-chart` entity (every employee mutation does) refreshes all of them — expanded levels keep their pages.
 */
export type OrgChartScope = { managerId: string } | { view: 'top' } | { view: 'unassigned'; search?: string };
export type OrgChartLevelPage = PageEnvelope<OrgChartNodeDto>;

/** Branch / department filter of the chart's set; empty values are left out of the request and the key. */
export function cleanFilters(filters: OrgChartFilter): OrgChartFilter {
  return { ...(filters.branchId ? { branchId: filters.branchId } : {}), ...(filters.departmentId ? { departmentId: filters.departmentId } : {}) };
}

function levelParams(scope: OrgChartScope, filters: OrgChartFilter) {
  const search = 'search' in scope ? scope.search?.trim() || undefined : undefined;
  return 'managerId' in scope ? { managerId: scope.managerId, ...cleanFilters(filters) } : { view: scope.view, ...(search ? { search } : {}), ...cleanFilters(filters) };
}

/** One level of the chart, paginated at ORG_CHART_PAGE_SIZE: `fetchNextPage()` is the "Show more" of that level. */
export function useOrgChartLevel(scope: OrgChartScope, filters: OrgChartFilter, enabled = true) {
  const orgId = useOrgId();
  const params = levelParams(scope, filters);
  return useInfiniteQuery({
    queryKey: qk.list(orgId, ORG_CHART_ENTITY, params),
    queryFn: ({ pageParam }) => api.get<OrgChartLevelPage>(`/orgs/${orgId}/org-chart`, { ...params, page: pageParam, pageSize: ORG_CHART_PAGE_SIZE }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.meta.page * last.meta.pageSize < last.meta.total ? last.meta.page + 1 : undefined),
    enabled,
  });
}

/** The cards of a level, every page loaded so far. */
export function levelNodes(data: InfiniteData<OrgChartLevelPage> | undefined): OrgChartNodeDto[] {
  return data?.pages.flatMap((p) => p.data) ?? [];
}

/** GET /orgs/:orgId/org-chart/path/:employeeId as query options (the page fetches it imperatively to focus a person). */
export function orgChartPathQuery(orgId: string, employeeId: string, filters: OrgChartFilter) {
  const f = cleanFilters(filters);
  return {
    queryKey: [...qk.detail(orgId, ORG_CHART_ENTITY, employeeId), 'path', f] as const,
    // one path segment, whatever the id holds: a crafted `?focus=` must never steer the request to another route
    queryFn: async () => (await api.get<Envelope<OrgChartPathDto>>(`/orgs/${orgId}/org-chart/path/${idSegment(employeeId)}`, f)).data,
    staleTime: 0,
    retry: false,
  };
}

/**
 * Every card the chart shows right now (the open levels, the heads, the Unassigned panel), by id. The drag-and-drop guard reads
 * it to refuse a drop on somebody's own (shown) team before asking the server, which checks cycles again anyway.
 *
 * Only the levels on screen count: a collapsed team, or a level cached under an earlier branch / department filter, is not
 * refetched when a change invalidates the chart and would still claim somebody's old manager. When a person sits in more
 * than one shown level (an Unassigned search and the panel's count), the most recently fetched copy wins.
 */
export function loadedOrgChartNodes(qc: QueryClient, orgId: string): Map<string, OrgChartNodeDto> {
  const out = new Map<string, OrgChartNodeDto>();
  const shown = qc.getQueryCache().findAll({ queryKey: qk.list(orgId, ORG_CHART_ENTITY), type: 'active' })
    .sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt);
  for (const query of shown) {
    for (const node of levelNodes(query.state.data as InfiniteData<OrgChartLevelPage> | undefined)) out.set(node.id, node);
  }
  return out;
}

interface NamedPerson { id: string; displayName: string; displayNameAr?: string | null }
const isNamedPerson = (v: unknown): v is NamedPerson =>
  typeof v === 'object' && v !== null && typeof (v as NamedPerson).id === 'string' && typeof (v as NamedPerson).displayName === 'string';

/**
 * The people this session has already read (the org chart's levels and the employee lists, any filter), by id — to name the
 * employees an API refusal points at by id only. Names do not go stale the way reporting lines do, so every cached level counts.
 */
export function cachedPeople(qc: QueryClient, orgId: string): Map<string, NamedPerson> {
  const out = new Map<string, NamedPerson>();
  const add = (v: unknown) => { if (isNamedPerson(v)) out.set(v.id, v); };
  for (const [, data] of qc.getQueriesData<InfiniteData<OrgChartLevelPage>>({ queryKey: qk.list(orgId, ORG_CHART_ENTITY) })) {
    for (const p of data?.pages ?? []) if (Array.isArray(p?.data)) p.data.forEach(add);
  }
  for (const [, data] of qc.getQueriesData<{ data?: unknown }>({ queryKey: qk.list(orgId, EMPLOYEES_ENTITY) })) {
    if (Array.isArray(data?.data)) data.data.forEach(add);
  }
  return out;
}

/** The managers above `employeeId` on the loaded chart (primary line, nearest first), with a guard against loops. */
export function managersAbove(nodes: Map<string, OrgChartNodeDto>, employeeId: string): string[] {
  const out: string[] = [];
  let current = nodes.get(employeeId)?.managerEmployeeId ?? null;
  while (current && !out.includes(current) && current !== employeeId) {
    out.push(current);
    current = nodes.get(current)?.managerEmployeeId ?? null;
  }
  return out;
}

/** Whether `employeeId` sits below `managerId` on the loaded chart (primary line). */
export function isInTeamOf(nodes: Map<string, OrgChartNodeDto>, employeeId: string, managerId: string): boolean {
  return managersAbove(nodes, employeeId).includes(managerId);
}
