import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Building2 } from 'lucide-react';
import type { DashboardBranchRow } from '@flowza/contracts';
import { ErrorState, Skeleton } from '@/components/ui';
import { fmtNumber } from '@/lib/format';
import { pct } from '../model';
import { ViewAllLink, WidgetCard, WidgetEmpty } from './widget-card';

/** Branches ranked by attendance rate. The API scopes rows to the caller's branches, so a branch manager sees theirs. */
export function BranchesCard({ rows, loading, error, onRetry, canManage, className, limit = 8 }: { rows: DashboardBranchRow[] | undefined; loading: boolean; error: unknown; onRetry: () => void; canManage: boolean; className?: string; limit?: number }) {
  const { t } = useTranslation('dashboard');
  const ranked = useMemo(() => [...(rows ?? [])].map((r) => ({ ...r, rate: pct(r.present, r.employees) })).sort((a, b) => b.rate - a.rate || b.employees - a.employees).slice(0, limit), [rows, limit]);
  return (
    <WidgetCard title={t('branches.title')} subtitle={t('branches.subtitle')} icon={Building2} className={className} action={canManage ? <ViewAllLink to="/organization" label={t('approvals.viewAll')} /> : null}>
      {error ? <ErrorState error={error} onRetry={onRetry} /> : loading && !rows ? (
        <div className="space-y-3" aria-busy>{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}</div>
      ) : ranked.length === 0 ? (
        <WidgetEmpty icon={Building2} title={t('branches.empty')} hint={t('branches.emptyHint')} />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="pb-2 pe-2 text-start font-medium">#</th>
              <th scope="col" className="pb-2 pe-2 text-start font-medium">{t('branches.branch')}</th>
              <th scope="col" className="pb-2 pe-2 text-end font-medium whitespace-nowrap">{t('branches.presentTotal')}</th>
              <th scope="col" className="pb-2 text-start font-medium">{t('branches.rate')}</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((r, i) => (
              <tr key={r.branchId} className="border-t">
                <td className="py-2 pe-2 align-middle"><span className="tnum inline-flex size-6 items-center justify-center rounded-md bg-accent text-xs font-semibold text-brand-700 dark:text-brand-300">{i + 1}</span></td>
                <td className="py-2 pe-2 align-middle"><p className="truncate font-medium">{r.branchName}</p><p className="font-mono text-[11px] text-muted-foreground" dir="ltr">{r.branchCode}</p></td>
                <td className="tnum py-2 pe-2 text-end align-middle whitespace-nowrap">{fmtNumber(r.present)} / {fmtNumber(r.employees)}</td>
                <td className="py-2 align-middle">
                  <div className="flex items-center gap-2">
                    <span className="tnum w-9 shrink-0 text-end text-xs font-medium">{r.rate}%</span>
                    <div className="h-2 min-w-16 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={r.rate} aria-label={r.branchName}>
                      <div className="bar-fill h-full rounded-full transition-[width] duration-500" style={{ width: `${r.rate}%` }} />
                    </div>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </WidgetCard>
  );
}
