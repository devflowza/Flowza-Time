import { useTranslation } from 'react-i18next';
import type { SyncItemStatus, SyncJobDto, SyncJobType, SyncStatus, SyncTrigger } from '@flowza/contracts';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/utils';
import { fmtNumber } from '@/lib/format';

type Tone = 'success' | 'info' | 'warning' | 'neutral' | 'danger';
const JOB_TONE: Record<SyncStatus, Tone> = { PENDING: 'neutral', QUEUED: 'info', RUNNING: 'info', SUCCESS: 'success', PARTIAL_SUCCESS: 'warning', FAILED: 'danger', RETRYING: 'warning', CANCELLED: 'neutral' };
const ITEM_TONE: Record<SyncItemStatus, Tone> = { PENDING: 'neutral', QUEUED: 'info', RUNNING: 'info', SUCCESS: 'success', FAILED: 'danger', RETRYING: 'warning', OFFLINE: 'warning', UNSUPPORTED: 'neutral', CANCELLED: 'neutral', SKIPPED: 'neutral' };

export function SyncStatusBadge({ status }: { status: SyncStatus }) {
  const { t } = useTranslation('sync');
  return <Badge variant={JOB_TONE[status]} dot className={cn(status === 'RUNNING' && 'animate-pulse')}>{t(`status.${status}`)}</Badge>;
}
export function SyncItemStatusBadge({ status }: { status: SyncItemStatus }) {
  const { t } = useTranslation('sync');
  return <Badge variant={ITEM_TONE[status]} dot>{t(`itemStatus.${status}`)}</Badge>;
}
export function JobTypeLabel({ type }: { type: SyncJobType }) {
  const { t } = useTranslation('sync');
  return <span className="font-medium">{t(`jobType.${type}`)}</span>;
}
export function TriggerBadge({ trigger }: { trigger: SyncTrigger }) {
  const { t } = useTranslation('sync');
  return <Badge variant="outline">{t(`trigger.${trigger}`)}</Badge>;
}

/** Stacked bar: success / failed / pending over itemsTotal, with a compact numeric legend. */
export function JobProgress({ job, compact = false }: { job: Pick<SyncJobDto, 'itemsTotal' | 'itemsSuccess' | 'itemsFailed' | 'itemsPending' | 'itemsOffline' | 'itemsUnsupported'>; compact?: boolean }) {
  const { t } = useTranslation('sync');
  const total = Math.max(job.itemsTotal, 1);
  const pct = (n: number) => `${Math.min(100, Math.round((n / total) * 100))}%`;
  const failed = job.itemsFailed + job.itemsOffline;
  const done = job.itemsSuccess + failed + job.itemsUnsupported;
  const label = t('progress.label', { done, total: job.itemsTotal });
  return (
    <div className={cn('min-w-[140px]', compact ? 'space-y-0.5' : 'space-y-1')} data-testid="job-progress">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={job.itemsTotal} aria-valuenow={done} aria-label={label}>
        <div className="bg-emerald-500 transition-[width]" style={{ width: pct(job.itemsSuccess) }} data-testid="progress-success" />
        <div className="bg-red-500 transition-[width]" style={{ width: pct(failed) }} data-testid="progress-failed" />
        <div className="bg-slate-400/60 transition-[width]" style={{ width: pct(job.itemsUnsupported) }} data-testid="progress-unsupported" />
      </div>
      <div className={cn('flex flex-wrap gap-x-2 text-muted-foreground tnum', compact ? 'text-[11px]' : 'text-xs')}>
        <span className="text-emerald-700 dark:text-emerald-300">{fmtNumber(job.itemsSuccess)} {t('progress.success')}</span>
        {failed > 0 ? <span className="text-red-700 dark:text-red-300">{fmtNumber(failed)} {t('progress.failed')}</span> : null}
        {job.itemsPending > 0 ? <span>{fmtNumber(job.itemsPending)} {t('progress.pending')}</span> : null}
        <span className="ms-auto">{label}</span>
      </div>
    </div>
  );
}
