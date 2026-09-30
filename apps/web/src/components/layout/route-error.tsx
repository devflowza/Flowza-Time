import { useEffect, useState, type ReactNode } from 'react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, FileQuestion, RefreshCw } from 'lucide-react';
import { Button, EmptyState } from '@/components/ui';
import { canReloadForStaleChunk, isStaleChunkError, reloadForStaleChunk } from '@/lib/stale-chunk';

/**
 * Route `errorElement`. Without one, React Router shows its developer screen ("Unexpected Application Error!") to users.
 *
 * The common case is a lazy page whose chunk a deploy has since replaced (see lib/stale-chunk.ts): the page reloads once
 * by itself to load the new build, and offers a button when that already happened a moment ago and did not help.
 */
export function RouteError({ fullScreen = false, homeTo = '/' }: { fullScreen?: boolean; homeTo?: string }) {
  const error = useRouteError();
  const { t } = useTranslation();
  const stale = isStaleChunkError(error);
  const [autoReload] = useState(() => stale && canReloadForStaleChunk());

  useEffect(() => {
    if (autoReload) reloadForStaleChunk();
    else if (!stale) console.error(error);
  }, [autoReload, stale, error]);

  const reload = <Button variant={autoReload ? 'outline' : 'default'} onClick={() => window.location.reload()}>{t('common.reloadPage')}</Button>;
  const home = <Button asChild variant="outline"><Link to={homeTo}>{t('common.goHome')}</Link></Button>;

  let content: ReactNode;
  if (stale) {
    content = (
      <div role="status">
        <EmptyState icon={RefreshCw} title={t('common.appUpdated')} description={t(autoReload ? 'common.appUpdatedReloading' : 'common.appUpdatedHint')} action={reload} />
      </div>
    );
  } else if (isRouteErrorResponse(error) && error.status === 404) {
    content = <EmptyState icon={FileQuestion} title={t('common.notFound')} description={t('common.notFoundHint')} action={home} />;
  } else {
    content = (
      <div role="alert">
        <EmptyState icon={AlertTriangle} title={t('common.error')} description={t('common.pageErrorHint')} action={<div className="flex flex-wrap justify-center gap-2">{reload}{home}</div>} />
      </div>
    );
  }

  if (fullScreen) return <div className="flex min-h-screen items-center justify-center bg-background p-4"><div className="w-full max-w-lg">{content}</div></div>;
  return <div className="page-container">{content}</div>;
}
