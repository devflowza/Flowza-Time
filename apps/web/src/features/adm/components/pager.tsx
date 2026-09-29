import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';

/** Previous / next pager for the portal's card lists (tables use DataTable's own). */
export function Pager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const { t: tc } = useTranslation();
  return (
    <div className="mt-3 flex items-center justify-end gap-2 text-xs text-muted-foreground">
      <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>{tc('common.previous')}</Button>
      <span className="tnum">{tc('common.pageOf', { page, total })}</span>
      <Button size="sm" variant="outline" disabled={page >= total} onClick={() => onPage(page + 1)}>{tc('common.next')}</Button>
    </div>
  );
}
