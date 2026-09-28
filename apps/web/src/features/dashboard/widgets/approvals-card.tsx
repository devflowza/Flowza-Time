import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ChevronRight, ClipboardCheck, MessageSquareText } from 'lucide-react';
import { Badge, ErrorState } from '@/components/ui';
import { fmtRelative } from '@/lib/format';
import { useApprovalInbox } from '@/features/approvals/api';
import { EntityIcon } from '@/features/approvals/components/parts';
import { usePendingCounts } from '@/features/team/api';
import { ViewAllLink, WidgetCard, WidgetEmpty, WidgetRowsSkeleton } from './widget-card';

/**
 * "Awaiting your approval" (HR portal Prompt 5): the count is team/pending-counts.total — the requests waiting for the member
 * on their level (exactly /me.approvals.actionable) plus the attendance reasons they review as the mapped line manager — and
 * the list is the five oldest requests of the inbox's "Mine" queue with how long each has waited. A line manager without an
 * approve key works them on /team (Finance B-66); an approver in the inbox.
 */
export function AwaitingApprovalCard({ enabled, approver, hasReports, className }: { enabled: boolean; approver: boolean; hasReports: boolean; className?: string }) {
  const { t } = useTranslation('dashboard');
  const { t: ta } = useTranslation('approvals');
  const counts = usePendingCounts(enabled);
  const q = useApprovalInbox({ scope: 'mine', view: 'pending', page: 1, pageSize: 5 }, enabled);
  const items = q.data?.data ?? [];
  const home = approver || !hasReports ? '/approvals' : '/team?tab=approvals';
  const total = counts.data?.total ?? 0;
  const notes = counts.data?.notes ?? 0;
  return (
    <WidgetCard
      title={t('awaiting.title')} icon={ClipboardCheck} className={className}
      action={<>{total > 0 ? <Badge variant="danger" className="tnum" data-testid="awaiting-count">{total}</Badge> : null}<ViewAllLink to={home} label={t('approvals.viewAll')} /></>}
      bodyClassName="px-3"
    >
      {q.isError ? <div className="px-2"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div> : q.isLoading ? <div className="px-2"><WidgetRowsSkeleton rows={2} /></div> : items.length === 0 && notes === 0 ? (
        <div className="px-2"><WidgetEmpty icon={ClipboardCheck} title={t('approvals.empty')} hint={t('approvals.emptyHint')} /></div>
      ) : (
        <ul className="divide-y" data-testid="awaiting-list">
          {items.map((i) => (
            <li key={i.id}>
              <Link to={approver || !hasReports ? `/approvals?request=${i.id}` : home} className="flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-muted/60">
                <EntityIcon entityType={i.entityType} className="size-9" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{ta(`entity.${i.entityType}`, { defaultValue: i.entityType })}</span>
                  <span className="block truncate text-xs text-muted-foreground">{i.employeeName ?? i.requestedByName ?? '—'}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tnum" title={i.createdAt} data-testid="awaiting-age">{fmtRelative(i.createdAt)}</span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden />
              </Link>
            </li>
          ))}
          {notes > 0 ? (
            <li>
              <Link to={hasReports ? '/team?tab=approvals' : '/attendance/notes'} className="flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-muted/60">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-chart-late/12 text-chart-late"><MessageSquareText className="size-4" aria-hidden /></span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{t('awaiting.notes', { count: notes })}</span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden />
              </Link>
            </li>
          ) : null}
        </ul>
      )}
    </WidgetCard>
  );
}
