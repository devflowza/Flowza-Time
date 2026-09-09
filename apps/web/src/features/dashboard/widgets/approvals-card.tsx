import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { CalendarOff, ChevronRight, ClipboardCheck, Clock } from 'lucide-react';
import { Badge, ErrorState } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { useApprovalInbox } from '@/features/approvals/api';
import { ViewAllLink, WidgetCard, WidgetEmpty, WidgetRowsSkeleton } from './widget-card';

/** The caller's approval inbox, newest first; the count badge is the organisation-wide figure from the summary. */
export function ApprovalsCard({ pending, enabled, className }: { pending: number | undefined; enabled: boolean; className?: string }) {
  const { t } = useTranslation('dashboard');
  const { t: ta } = useTranslation('approvals');
  const { t: tt } = useTranslation('attendance');
  const q = useApprovalInbox({ page: 1, pageSize: 5 }, enabled);
  const items = q.data?.data ?? [];
  return (
    <WidgetCard
      title={t('approvals.title')} icon={ClipboardCheck} className={className}
      action={<>{pending ? <Badge variant="danger" className="tnum">{pending}</Badge> : null}<ViewAllLink to="/approvals" label={t('approvals.viewAll')} /></>}
      bodyClassName="px-3"
    >
      {q.isError ? <div className="px-2"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div> : q.isLoading ? <div className="px-2"><WidgetRowsSkeleton rows={2} /></div> : items.length === 0 ? (
        <div className="px-2"><WidgetEmpty icon={ClipboardCheck} title={t('approvals.empty')} hint={t('approvals.emptyHint')} /></div>
      ) : (
        <ul className="divide-y">
          {items.map((i) => {
            const c = i.correction;
            const leave = i.entityType === 'LEAVE';
            const title = c ? tt(`correctionType.${c.type}`, { defaultValue: c.type }) : ta(`entity.${i.entityType}`, { defaultValue: i.entityType });
            return (
              <li key={i.stepId}>
                <Link to="/approvals" className="flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-muted/60">
                  <span className={leave ? 'flex size-9 shrink-0 items-center justify-center rounded-lg bg-chart-leave/12 text-chart-leave' : 'flex size-9 shrink-0 items-center justify-center rounded-lg bg-chart-late/12 text-chart-late'}>
                    {leave ? <CalendarOff className="size-4" aria-hidden /> : <Clock className="size-4" aria-hidden />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{c?.employeeName ?? i.requestedByName ?? '—'}</span>
                  </span>
                  <span className="tnum shrink-0 text-xs text-muted-foreground">{c ? fmtDate(c.attendanceDate) : fmtDate(i.createdAt.slice(0, 10))}</span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetCard>
  );
}
