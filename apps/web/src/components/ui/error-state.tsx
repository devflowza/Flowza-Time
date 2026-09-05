import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api-client';
import { Button } from './button';

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  const message = error instanceof ApiError ? error.message : t('common.error');
  return (
    <div role="alert" className="flex flex-col items-center justify-center rounded-lg border border-destructive/30 bg-red-50/40 px-6 py-10 text-center dark:bg-red-950/20">
      <AlertTriangle className="mb-3 size-8 text-destructive" aria-hidden />
      <h3 className="text-sm font-semibold">{message}</h3>
      <p className="mt-1 max-w-md text-xs text-muted-foreground">{t('common.errorHint', { requestId: requestId ?? '—' })}</p>
      {onRetry ? <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>{t('common.retry')}</Button> : null}
    </div>
  );
}
