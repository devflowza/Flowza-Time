import i18n from '@/lib/i18n';
import { toast } from '@/lib/toast';

export interface JobToastOptions {
  /**
   * Where "View" takes the user. Defaults to the sync job page (`/sync/:jobId`), which is right for *sync* jobs
   * (`sync_jobs` ids). Recalculation, report and payroll 202s carry **queue** job ids that the sync page cannot show —
   * those callers pass the page that tracks their work (e.g. `/attendance?tab=recalc`, `/reports`) or `null` for no link.
   */
  to?: string | null;
  actionLabel?: string;
}

/** 202 responses: show "Queued" with a link to the page where the work can be followed. */
export function toastJobQueued(jobId: string, navigate: (to: string) => void, description?: string, opts: JobToastOptions = {}) {
  const to = opts.to === undefined ? `/sync/${jobId}` : opts.to;
  toast.success(i18n.t('common.queued'), {
    description: description ?? i18n.t('common.queuedHint'),
    ...(to ? { action: { label: opts.actionLabel ?? i18n.t('employees:jobs.view'), onClick: () => navigate(to) } } : {}),
  });
}
