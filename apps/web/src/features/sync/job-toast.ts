import type { SyncJobAcceptedDto } from '@flowza/contracts';
import i18n from '@/lib/i18n';
import { toast, toastQueued } from '@/lib/toast';

/** 202 responses: "Queued" toast with a link to /sync/:jobId so long operations are followable (§104). */
export function toastJobQueued(jobId: string | null | undefined, navigate: (to: string) => void, description?: string) {
  if (!jobId) { toastQueued(); return; }
  toast.success(i18n.t('common.queued'), {
    description: description ?? i18n.t('common.queuedHint'),
    action: { label: i18n.t('sync:jobs.view'), onClick: () => navigate(`/sync/${jobId}`) },
  });
}

/**
 * Sync-job 202 body (`SyncJobAcceptedDto`): when every item was already covered by a running job the API answers with
 * status SUCCESS and nothing queued — say so instead of announcing a new job.
 */
export function toastJobAccepted(accepted: SyncJobAcceptedDto, navigate: (to: string) => void, description?: string) {
  if (accepted.status === 'SUCCESS' && accepted.itemsQueued === 0) {
    toast.info(i18n.t('sync:jobs.nothingQueued'), { description: i18n.t('sync:jobs.nothingQueuedHint'), action: { label: i18n.t('sync:jobs.view'), onClick: () => navigate(`/sync/${accepted.jobId}`) } });
    return;
  }
  const skipped = accepted.itemsSkipped > 0 ? i18n.t('sync:jobs.skipped', { count: accepted.itemsSkipped }) : undefined;
  toastJobQueued(accepted.jobId, navigate, [description, skipped].filter(Boolean).join(' · ') || undefined);
}
