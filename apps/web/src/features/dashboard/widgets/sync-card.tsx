import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { Badge, ErrorState } from '@/components/ui';
import { fmtRelative } from '@/lib/format';
import { useSyncJobs } from '@/features/sync/api';
import { ViewAllLink, WidgetCard, WidgetEmpty, WidgetRowsSkeleton } from './widget-card';

const TONE: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'outline'> = { PENDING: 'outline', QUEUED: 'outline', RUNNING: 'info', RETRYING: 'warning', SUCCESS: 'success', PARTIAL_SUCCESS: 'warning', FAILED: 'danger', CANCELLED: 'neutral' };

/** The newest sync jobs, for the operations layout. Links go to the job page that tracks the work. */
export function SyncCard({ enabled, className, limit = 5 }: { enabled: boolean; className?: string; limit?: number }) {
  const { t } = useTranslation('dashboard');
  const { t: ts } = useTranslation('sync');
  const q = useSyncJobs({ page: 1, pageSize: limit }, enabled);
  const jobs = q.data?.data ?? [];
  return (
    <WidgetCard title={t('sync.title')} icon={RefreshCw} className={className} action={<ViewAllLink to="/sync" label={t('sync.viewAll')} />} bodyClassName="px-3">
      {q.isError ? <div className="px-2"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div> : q.isLoading ? <div className="px-2"><WidgetRowsSkeleton rows={4} /></div> : jobs.length === 0 ? (
        <div className="px-2"><WidgetEmpty icon={RefreshCw} title={t('sync.empty')} hint={t('sync.emptyHint')} /></div>
      ) : (
        <ul className="divide-y">
          {jobs.map((j) => (
            <li key={j.id}>
              <Link to={`/sync/${j.id}`} className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-muted/60">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{ts(`jobType.${j.jobType}`, { defaultValue: j.jobType })}</span>
                  <span className="tnum block truncate text-xs text-muted-foreground">{t('sync.items', { done: j.itemsSuccess, total: j.itemsTotal })} · {fmtRelative(j.createdAt)}</span>
                </span>
                <Badge variant={TONE[j.status] ?? 'neutral'}>{ts(`status.${j.status}`, { defaultValue: j.status })}</Badge>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}
