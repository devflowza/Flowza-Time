import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, CheckCheck } from 'lucide-react';
import { Link } from 'react-router';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, Card, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { fmtRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useMarkRead, useNotifications } from './use-notifications';

const CATEGORY_TONE: Record<string, 'info' | 'warning' | 'danger' | 'neutral' | 'success'> = { DEVICE: 'warning', ATTENDANCE: 'info', APPROVAL: 'success', SYSTEM: 'neutral', SUBSCRIPTION: 'danger' };

export function NotificationsPage() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const q = useNotifications(page);
  const markRead = useMarkRead();
  return (
    <div className="page-container">
      <PageHeader title={t('notifications.title')} actions={<Button variant="outline" size="sm" onClick={() => markRead.mutate('all')} loading={markRead.isPending}><CheckCheck /> {t('notifications.markAllRead')}</Button>} />
      {q.isLoading ? <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
        : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        : q.data && q.data.data.length === 0 ? <EmptyState icon={Bell} title={t('notifications.empty')} description={t('notifications.emptyHint')} />
        : (
          <Card className="divide-y">
            {q.data?.data.map((n) => (
              <div key={n.id} className={cn('flex items-start gap-3 p-4', !n.readAt && 'bg-accent/40')}>
                <Badge variant={CATEGORY_TONE[n.category] ?? 'neutral'}>{n.category}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{n.link ? <Link to={n.link} className="hover:underline" onClick={() => !n.readAt && markRead.mutate(n.id)}>{n.title}</Link> : n.title}</p>
                  {n.body ? <p className="mt-0.5 text-sm text-muted-foreground">{n.body}</p> : null}
                  <p className="mt-1 text-xs text-muted-foreground">{fmtRelative(n.createdAt)}</p>
                </div>
                {!n.readAt ? <Button variant="ghost" size="sm" onClick={() => markRead.mutate(n.id)}>{t('common.confirm')}</Button> : null}
              </div>
            ))}
            {q.data && q.data.meta.totalPages > 1 ? (
              <div className="flex items-center justify-between p-3 text-sm">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t('common.previous')}</Button>
                <span className="text-muted-foreground">{t('common.pageOf', { page, total: q.data.meta.totalPages })}</span>
                <Button variant="outline" size="sm" disabled={page >= q.data.meta.totalPages} onClick={() => setPage((p) => p + 1)}>{t('common.next')}</Button>
              </div>
            ) : null}
          </Card>
        )}
    </div>
  );
}
