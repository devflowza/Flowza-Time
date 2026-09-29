import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, ErrorState, Input, Skeleton } from '@/components/ui';
import { useDebounced } from '@/hooks/use-debounced';
import { usePlatformActivity } from '../api';
import { ActivityList } from '../components/activity-list';
import { Pager } from '../components/pager';

export default function AdmActivityPage() {
  const { t } = useTranslation('adm');
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const debounced = useDebounced(action, 300);
  const q = usePlatformActivity(useMemo(() => ({ page, pageSize: 50, action: debounced.trim() || undefined }), [page, debounced]));
  return (
    <div className="page-container">
      <PageHeader title={t('activity.title')} description={t('activity.subtitle')} />
      <Card>
        <CardContent className="space-y-3 pt-4">
          <Input value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} placeholder={t('activity.filterAction')} aria-label={t('activity.filterAction')} className="h-8 max-w-xs" dir="ltr" />
          {q.isLoading ? <Skeleton className="h-64 w-full" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <ActivityList entries={q.data?.data ?? []} empty={t('activity.empty')} />}
          {(q.data?.meta.totalPages ?? 1) > 1 ? <Pager page={page} total={q.data?.meta.totalPages ?? 1} onPage={setPage} /> : null}
        </CardContent>
      </Card>
    </div>
  );
}
