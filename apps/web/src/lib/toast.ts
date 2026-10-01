import { toast } from 'sonner';
import { ApiError, isFeatureUnavailableError } from './api-client';
import i18n from './i18n';

/**
 * The tenant's user limit refused the change (402 ENTITLEMENT_EXCEEDED, `details.reason = USER_LIMIT_REACHED`): the message in
 * the reader's language — "Maximum users reached (20 of 20)…" — or null for any other error.
 */
export function userLimitErrorMessage(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.code !== 'ENTITLEMENT_EXCEEDED' || err.details?.['reason'] !== 'USER_LIMIT_REACHED') return null;
  const limit = Number(err.details['limit']); const used = Number(err.details['used']); const adding = Number(err.details['adding'] ?? 1);
  if (!Number.isFinite(limit) || !Number.isFinite(used)) return err.message;
  return used >= limit
    ? i18n.t('userLimit.errorReached', { used, limit })
    : i18n.t('userLimit.errorNotEnough', { remaining: limit - used, limit, adding });
}

export function toastError(err: unknown) {
  const userLimit = userLimitErrorMessage(err);
  // not a failure to report: the action's endpoint is not deployed yet (see FEATURE_UNAVAILABLE)
  if (isFeatureUnavailableError(err)) toast.info(i18n.t('common.featureUnavailable'), { description: i18n.t('common.featureUnavailableHint') });
  else if (userLimit !== null) toast.error(i18n.t('userLimit.reachedTitle'), { description: userLimit });
  else if (err instanceof ApiError) toast.error(err.message, { description: err.requestId ? `Request ${err.requestId}` : undefined });
  else toast.error(i18n.t('common.error'));
}
export function toastQueued() { toast.success(i18n.t('common.queued'), { description: i18n.t('common.queuedHint') }); }
export { toast };
