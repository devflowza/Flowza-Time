import i18n from '@/lib/i18n';
import { toast } from '@/lib/toast';

/** 202 responses: show "Queued" with a link to the job page (/sync/:jobId) so long operations are followable. */
export function toastJobQueued(jobId: string, navigate: (to: string) => void, description?: string) {
  toast.success(i18n.t('common.queued'), {
    description: description ?? i18n.t('common.queuedHint'),
    action: { label: i18n.t('employees:jobs.view'), onClick: () => navigate(`/sync/${jobId}`) },
  });
}
