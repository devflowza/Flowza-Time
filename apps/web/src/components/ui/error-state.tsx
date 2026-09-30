import { AlertTriangle, Hourglass } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError, isFeatureUnavailableError, isNetworkError, networkFailureReason } from '@/lib/api-client';
import { Button } from './button';

const NETWORK_HINT_KEYS = {
  OFFLINE: 'common.network.offlineHint',
  UNREACHABLE: 'common.network.unreachableHint',
  BLOCKED: 'common.network.blockedHint',
  UNKNOWN: 'common.offlineHint',
} as const;

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  // A screen that calls an endpoint the running API does not serve yet (web released ahead of the API) is not broken:
  // say it is on its way, without the alarm colours or a request id nobody needs to report.
  if (isFeatureUnavailableError(error)) {
    return (
      <div role="status" className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-10 text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-accent text-brand-700"><Hourglass className="size-6" aria-hidden /></div>
        <h3 className="text-sm font-semibold">{t('common.featureUnavailable')}</h3>
        <p className="mt-1 max-w-md text-xs text-muted-foreground">{t('common.featureUnavailableHint')}</p>
        {onRetry ? <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>{t('common.checkAgain')}</Button> : null}
      </div>
    );
  }
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  const message = error instanceof ApiError ? error.message : t('common.error');
  // Nothing reached the API, so there is no request id to quote — asking for one that is always "—" sends the reader
  // looking for a support ticket that cannot exist. What to do instead depends on why (NetworkFailureReason): a security
  // rule in front of the API is not the reader's connection, and telling them to check it sends them the wrong way.
  const hint = isNetworkError(error) ? t(NETWORK_HINT_KEYS[networkFailureReason(error) ?? 'UNKNOWN']) : t('common.errorHint', { requestId: requestId ?? '—' });
  return (
    <div role="alert" className="flex flex-col items-center justify-center rounded-lg border border-destructive/30 bg-red-50/40 px-6 py-10 text-center dark:bg-red-950/20">
      <AlertTriangle className="mb-3 size-8 text-destructive" aria-hidden />
      <h3 className="text-sm font-semibold">{message}</h3>
      <p className="mt-1 max-w-md text-xs text-muted-foreground">{hint}</p>
      {onRetry ? <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>{t('common.retry')}</Button> : null}
    </div>
  );
}
