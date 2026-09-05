import { useTranslation } from 'react-i18next';
import { History } from 'lucide-react';
import { Badge, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useOrgTimezone } from '@/features/me/use-me';
import { useEmployeeHistory } from '../../api';
import { EmploymentStatusBadge } from '../employee-badges';

export function HistoryTab({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation('employees');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const q = useEmployeeHistory(employeeId);
  if (q.isLoading) return <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}</div>;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data || q.data.length === 0) return <EmptyState icon={History} title={t('history.empty')} description={t('history.emptyHint')} />;
  return (
    <ol className="relative space-y-4 border-s-2 border-border ps-6">
      {q.data.map((h, i) => (
        <li key={h.id} className="relative">
          <span className={`absolute -start-[31px] top-1.5 size-3.5 rounded-full border-2 border-card ${i === 0 ? 'bg-primary' : 'bg-muted-foreground/50'}`} aria-hidden />
          <div className="rounded-lg border bg-card p-4 shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium tnum">{fmtDate(h.effectiveFrom)} → {h.effectiveTo ? fmtDate(h.effectiveTo) : <Badge variant="success">{t('history.current')}</Badge>}</p>
              <div className="flex items-center gap-2"><EmploymentStatusBadge status={h.employmentStatus} /><Badge variant="outline">{t(`employmentType.${h.employmentType}`)}</Badge></div>
            </div>
            <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div><dt className="text-xs text-muted-foreground">{tc('common.branch')}</dt><dd>{h.branchName ?? '—'}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{tc('common.department')}</dt><dd>{h.departmentName ?? '—'}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('fields.designation')}</dt><dd>{h.designationName ?? '—'}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('fields.manager')}</dt><dd>{h.managerName ?? '—'}</dd></div>
            </dl>
            {h.reason ? <p className="mt-2 text-sm text-muted-foreground">{t('history.reason')}: {h.reason}</p> : null}
            <p className="mt-2 text-xs text-muted-foreground tnum">{t('history.recorded', { at: fmtDateTime(h.createdAt, tz) })}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
