import { useMemo } from 'react';
import { useServerTable } from '@/hooks/use-server-table';

/** `useServerTable` for pages that also keep a `tab` search param: the tab is excluded from the API query. */
export function useTabTable(defaults?: Parameters<typeof useServerTable>[0]) {
  const table = useServerTable(defaults);
  const query = useMemo(() => { const { tab: _tab, ...rest } = table.query as Record<string, string | number | undefined>; return rest; }, [table.query]);
  return { ...table, query };
}
