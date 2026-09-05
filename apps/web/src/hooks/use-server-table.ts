import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

export interface ServerTableState { page: number; pageSize: number; sort: string | undefined; order: 'asc' | 'desc'; filters: Record<string, string> }

/**
 * Table state (page, pageSize, sort, filters) synchronised with the URL so views are shareable and the back button works.
 * Filters are any additional query params except the reserved ones.
 */
export function useServerTable(defaults: Partial<ServerTableState> = {}) {
  const [params, setParams] = useSearchParams();
  const state = useMemo<ServerTableState>(() => {
    const filters: Record<string, string> = {};
    for (const [k, v] of params.entries()) if (!['page', 'pageSize', 'sort', 'order'].includes(k) && v !== '') filters[k] = v;
    return {
      page: Number(params.get('page') ?? defaults.page ?? 1),
      pageSize: Number(params.get('pageSize') ?? defaults.pageSize ?? 25),
      sort: params.get('sort') ?? defaults.sort,
      order: (params.get('order') as 'asc' | 'desc' | null) ?? defaults.order ?? 'asc',
      filters: { ...(defaults.filters ?? {}), ...filters },
    };
  }, [params, defaults.page, defaults.pageSize, defaults.sort, defaults.order, defaults.filters]);

  const update = useCallback((patch: Partial<ServerTableState>, resetPage = true) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (patch.page !== undefined) next.set('page', String(patch.page));
      if (patch.pageSize !== undefined) next.set('pageSize', String(patch.pageSize));
      if (patch.sort !== undefined) { if (patch.sort) next.set('sort', patch.sort); else next.delete('sort'); }
      if (patch.order !== undefined) next.set('order', patch.order);
      if (patch.filters) {
        for (const [k, v] of Object.entries(patch.filters)) { if (v === '' || v === undefined || v === null) next.delete(k); else next.set(k, String(v)); }
        if (resetPage && patch.page === undefined) next.set('page', '1');
      }
      return next;
    }, { replace: true });
  }, [setParams]);

  const setFilter = useCallback((key: string, value: string | undefined) => update({ filters: { [key]: value ?? '' } }), [update]);
  const clearFilters = useCallback(() => setParams((prev) => { const n = new URLSearchParams(); const ps = prev.get('pageSize'); if (ps) n.set('pageSize', ps); return n; }, { replace: true }), [setParams]);
  const toggleSort = useCallback((column: string) => {
    if (state.sort !== column) update({ sort: column, order: 'asc' }, false);
    else if (state.order === 'asc') update({ order: 'desc' }, false);
    else update({ sort: '', order: 'asc' }, false);
  }, [state.sort, state.order, update]);

  /** Query object to pass straight to the API client. */
  const query = useMemo(() => ({ page: state.page, pageSize: state.pageSize, sort: state.sort, order: state.order, ...state.filters }), [state]);
  return { state, query, update, setFilter, clearFilters, toggleSort, setPage: (page: number) => update({ page }, false), setPageSize: (pageSize: number) => update({ pageSize, page: 1 }, false) };
}
