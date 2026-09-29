import { useTranslation } from 'react-i18next';
import { Building2, KeyRound, ShieldCheck } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Card, CardContent, CardHeader, CardTitle, ErrorState, Skeleton, StatCard, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { fmtDateTime, fmtNumber, fmtRelative } from '@/lib/format';
import { usePlatformHealth } from '@/features/platform/api';

function HealthTab() {
  const { t } = useTranslation('platform');
  const q = usePlatformHealth();
  if (q.isLoading) return <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20" />)}</div><Skeleton className="h-48" /></div>;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const h = q.data;
  const totalOrgs = Object.values(h.organizations).reduce((a, b) => a + b, 0);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label={t('health.organizations')} value={fmtNumber(totalOrgs)} icon={Building2} hint={Object.entries(h.organizations).map(([k, v]) => `${t(`status.${k}`, { defaultValue: k })}: ${fmtNumber(v)}`).join(' · ')} />
        <StatCard label={t('health.admins')} value={fmtNumber(h.platformAdmins)} icon={ShieldCheck} />
        <StatCard label={t('health.activeGrants')} value={fmtNumber(h.activeGrants)} icon={KeyRound} tone={h.activeGrants > 0 ? 'warning' : 'default'} />
      </div>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0"><CardTitle>{t('health.queue')}</CardTitle><span className="text-xs text-muted-foreground tnum">{t('health.asOf', { when: fmtDateTime(h.time, 'UTC', 'HH:mm:ss') })} UTC</span></CardHeader>
        <CardContent>
          {h.queue.length === 0 ? <p className="text-sm text-muted-foreground">{t('health.queueEmpty')}</p> : (
            <div className="overflow-x-auto"><Table>
              <TableHeader><TableRow><TableHead>{t('health.queueName')}</TableHead><TableHead>{t('health.jobStatus')}</TableHead><TableHead className="text-end">{t('health.count')}</TableHead><TableHead>{t('health.oldest')}</TableHead></TableRow></TableHeader>
              <TableBody>{h.queue.map((row) => (
                <TableRow key={`${row.queueName}-${row.status}`}>
                  <TableCell className="font-mono text-xs" dir="ltr">{row.queueName}</TableCell>
                  <TableCell><Badge variant={row.status === 'failed' || row.status === 'dead' ? 'danger' : row.status === 'running' ? 'info' : 'neutral'}>{row.status}</Badge></TableCell>
                  <TableCell className="text-end tnum">{fmtNumber(row.count)}</TableCell>
                  <TableCell className="text-xs tnum">{row.oldestRunAt ? fmtRelative(row.oldestRunAt) : '—'}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table></div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function AdmHealthPage() {
  const { t } = useTranslation('adm');
  return (
    <div className="page-container">
      <PageHeader title={t('healthPage.title')} description={t('healthPage.subtitle')} />
      <HealthTab />
    </div>
  );
}
