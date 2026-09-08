import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError, isNetworkError } from '@/lib/api-client';
import { Button } from './button';

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  const message = error instanceof ApiError ? error.message : t('common.error');
  // Nothing reached the server, so there is no request id to quote — asking for one that is always "—" sends the
  // reader looking for a support ticket that cannot exist.
  const hint = isNetworkError(error) ? t('common.offlineHint') : t('common.errorHint', { requestId: requestId ?? '—' });
  return (
    <div role="alert" className="flex flex-col items-center justify-center rounded-lg border border-destructive/30 bg-red-50/40 px-6 py-10 text-center dark:bg-red-950/20">
      <AlertTriangle className="mb-3 size-8 text-destructive" aria-hidden />
      <h3 className="text-sm font-semibold">{message}</h3>
      <p className="mt-1 max-w-md text-xs text-muted-foreground">{hint}</p>
      {onRetry ? <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>{t('common.retry')}</Button> : null}
    </div>
  );
}
