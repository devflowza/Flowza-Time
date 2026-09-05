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
