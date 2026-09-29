import { toast } from 'sonner';
import { ApiError, isFeatureUnavailableError } from './api-client';
import i18n from './i18n';

export function toastError(err: unknown) {
  // not a failure to report: the action's endpoint is not deployed yet (see FEATURE_UNAVAILABLE)
  if (isFeatureUnavailableError(err)) toast.info(i18n.t('common.featureUnavailable'), { description: i18n.t('common.featureUnavailableHint') });
  else if (err instanceof ApiError) toast.error(err.message, { description: err.requestId ? `Request ${err.requestId}` : undefined });
  else toast.error(i18n.t('common.error'));
}
export function toastQueued() { toast.success(i18n.t('common.queued'), { description: i18n.t('common.queuedHint') }); }
export { toast };
