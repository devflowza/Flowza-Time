import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { SearchResult, SearchResultItem } from '@flowza/contracts';
import { api, type Envelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useActiveMembership } from '@/features/me/use-me';

/**
 * Search is organisation-scoped, but its dialog lives in the Topbar, which renders on every route inside the shell —
 * including /platform, where a platform administrator legitimately has no organisation. `useOrgId()` throws in that
 * case, and because this runs during Topbar's render the whole shell went down with it. Degrade to "no results"
 * instead: there is nothing to search until an organisation is selected.
 */
export function useSearch(q: string, enabled = true) {
  const orgId = useActiveMembership()?.organization.id ?? null;
  const term = q.trim();
  return useQuery({
    queryKey: qk.list(orgId ?? 'none', 'search', { q: term }),
    queryFn: async () => (await api.get<Envelope<SearchResult>>(`/orgs/${orgId}/search`, { q: term })).data,
    enabled: enabled && term.length > 0 && orgId !== null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export const RESULT_GROUPS = ['employees', 'devices', 'branches', 'departments'] as const;
export type ResultGroup = (typeof RESULT_GROUPS)[number];

/** Where a result navigates to. Structure rows open their tab with the search box pre-filled. */
export function resultHref(item: SearchResultItem): string {
  switch (item.type) {
    case 'employee': return `/employees/${item.id}`;
    case 'device': return `/devices/${item.id}`;
    case 'branch': return `/organization?tab=branches&search=${encodeURIComponent(item.title)}`;
    case 'department': return `/organization?tab=departments&search=${encodeURIComponent(item.title)}`;
  }
}
export function groupItems(result: SearchResult | undefined): { group: ResultGroup; items: SearchResultItem[] }[] {
  if (!result) return [];
  return RESULT_GROUPS.map((group) => ({ group, items: result[group] })).filter((g) => g.items.length > 0);
}
