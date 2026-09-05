import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { RECORD_STATUSES } from '@flowza/contracts';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { SearchBox } from '../search-box';

const ALL = '__all__';

export function StructureToolbar({ filters, setFilter, clearFilters, children }: { filters: Record<string, string>; setFilter: (k: string, v: string | undefined) => void; clearFilters: () => void; children?: React.ReactNode }) {
  const { t } = useTranslation('organization');
  const { t: tc } = useTranslation();
  const active = Object.keys(filters).filter((k) => k !== 'tab').length > 0;
  return (
    <>
      <SearchBox value={filters['search']} onChange={(v) => setFilter('search', v)} />
      <Select value={filters['status'] ?? ALL} onValueChange={(v) => setFilter('status', v === ALL ? undefined : v)}>
        <SelectTrigger className="h-8 w-40" aria-label={tc('common.status')}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t('filters.allStatuses')}</SelectItem>
          {RECORD_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`status.${s}`)}</SelectItem>)}
        </SelectContent>
      </Select>
      {children}
      {active ? <Button variant="ghost" size="sm" onClick={clearFilters}><X /> {tc('common.clearFilters')}</Button> : null}
    </>
  );
}
