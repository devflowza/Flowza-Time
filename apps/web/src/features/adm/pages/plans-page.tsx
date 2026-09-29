import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, Skeleton } from '@/components/ui';
import { fmtNumber } from '@/lib/format';
import { usePlans } from '@/features/platform/api';

function PlansTab() {
  const { t } = useTranslation('platform');
  const q = usePlans();
  if (q.isLoading) return <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-56" />)}</div>;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {(q.data ?? []).map((p) => (
        <Card key={p.id} className={!p.isActive ? 'opacity-60' : undefined}>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div><CardTitle>{p.name}</CardTitle><CardDescription className="font-mono text-xs" dir="ltr">{p.key}</CardDescription></div>
            {p.isActive ? <Badge variant="success">{t('plans.active')}</Badge> : <Badge variant="neutral">{t('plans.inactive')}</Badge>}
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {p.description ? <p className="text-muted-foreground">{p.description}</p> : null}
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('plans.limits')}</p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">{Object.entries(p.limits).map(([k, v]) => <div key={k} className="contents"><dt className="font-mono text-muted-foreground" dir="ltr">{k}</dt><dd className="tnum" dir="ltr">{typeof v === 'number' ? fmtNumber(v) : String(v)}</dd></div>)}</dl>
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('plans.prices')}</p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">{Object.entries(p.prices).map(([k, v]) => <div key={k} className="contents"><dt className="font-mono text-muted-foreground" dir="ltr">{k}</dt><dd className="tnum" dir="ltr">{typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}</dd></div>)}</dl>
            </div>
            {p.features.length ? <div className="flex flex-wrap gap-1">{p.features.map((f) => <Badge key={f} variant="secondary" className="font-mono text-[11px] font-normal" dir="ltr">{f}</Badge>)}</div> : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function AdmPlansPage() {
  const { t } = useTranslation('adm');
  return (
    <div className="page-container">
      <PageHeader title={t('plansPage.title')} description={t('plansPage.subtitle')} />
      <PlansTab />
    </div>
  );
}
