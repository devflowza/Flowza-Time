import i18n from '@/lib/i18n';
import { ApiError } from '@/lib/api-client';
import { toast, toastError } from '@/lib/toast';

export const PERIOD_LOCKED = 'PERIOD_LOCKED';

export const isPeriodLockedError = (err: unknown): err is ApiError => err instanceof ApiError && err.code === PERIOD_LOCKED;

/**
 * `toastError` that explains a PERIOD_LOCKED (409) rejection: corrections, leave and recalculations inside a locked period are
 * refused by the API until the lock is lifted (Attendance → Period locks). Pass `navigate` to offer a link to the locks tab.
 */
export function toastMutationError(err: unknown, navigate?: (to: string) => void): void {
  if (!isPeriodLockedError(err)) { toastError(err); return; }
  toast.error(i18n.t('attendance:periodLocked.title'), {
    description: `${i18n.t('attendance:periodLocked.hint')}${err.requestId ? ` (${err.requestId})` : ''}`,
    action: navigate ? { label: i18n.t('attendance:periodLocked.view'), onClick: () => navigate('/attendance?tab=periods') } : undefined,
  });
}
