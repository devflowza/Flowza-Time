import { useTranslation } from 'react-i18next';
import { CreditCard } from 'lucide-react';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { fmtDateTime, fmtNumber } from '@/lib/format';
import { useActiveMembership, useOrgTimezone } from '@/features/me/use-me';
import { useSubscription } from '../api';
import { SectionSkeleton, SectionError } from '../components/settings-section';

const TONE: Record<string, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = { active: 'success', trialing: 'info', past_due: 'warning', cancelled: 'danger', expired: 'neutral' };

export default function SubscriptionSection() {
  const { t } = useTranslation('settings');
  const tz = useOrgTimezone();
  const membership = useActiveMembership();
  const q = useSubscription();
  if (q.isLoading) return <SectionSkeleton />;
  const missing = q.isError && q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403);
  if (q.isError && !missing) return <SectionError error={q.error} onRetry={() => void q.refetch()} />;
  const sub = q.data;
  return (
    <>
      <Card>
        <CardHeader><CardTitle>{t('subscription.title')}</CardTitle><CardDescription>{t('subscription.hint')}</CardDescription></CardHeader>
        <CardContent>
          {!sub ? <EmptyState icon={CreditCard} title={t('subscription.unavailable')} description={t('subscription.unavailableHint', { status: membership?.organization.status ?? '—' })} /> : (
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div><dt className="text-xs text-muted-foreground">{t('subscription.plan')}</dt><dd className="text-lg font-semibold">{sub.planName}</dd><dd className="font-mono text-xs text-muted-foreground" dir="ltr">{sub.planKey}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('subscription.status')}</dt><dd><Badge variant={TONE[sub.status] ?? 'neutral'} dot>{t(`subscription.statuses.${sub.status}`, { defaultValue: sub.status })}</Badge></dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('subscription.trialEnds')}</dt><dd className="tnum">{fmtDateTime(sub.trialEndsAt, tz)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('subscription.periodEnd')}</dt><dd className="tnum">{fmtDateTime(sub.currentPeriodEnd, tz)}</dd></div>
            </dl>
          )}
        </CardContent>
      </Card>
      {sub?.limits && Object.keys(sub.limits).length > 0 ? (
        <Card>
          <CardHeader><CardTitle>{t('subscription.limits')}</CardTitle><CardDescription>{t('subscription.limitsHint')}</CardDescription></CardHeader>
          <CardContent>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Object.entries(sub.limits).map(([k, v]) => { const used = sub.usage?.[k]; const limit = typeof v === 'number' ? v : null; const pct = limit && typeof used === 'number' ? Math.min(100, Math.round((used / limit) * 100)) : null; return (
                <li key={k} className="rounded-md border p-3">
                  <div className="flex items-center justify-between text-sm"><span className="font-medium">{t(`subscription.limitKeys.${k}`, { defaultValue: k })}</span><span className="tnum text-muted-foreground">{typeof used === 'number' ? `${fmtNumber(used)} / ` : ''}{limit !== null ? fmtNumber(limit) : String(v)}</span></div>
                  {pct !== null ? <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className={pct >= 90 ? 'h-full bg-destructive' : 'h-full bg-primary'} style={{ width: `${pct}%` }} aria-hidden /></div> : null}
                </li>
              ); })}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      {sub?.features && sub.features.length > 0 ? <Card><CardHeader><CardTitle>{t('subscription.features')}</CardTitle></CardHeader><CardContent className="flex flex-wrap gap-1.5">{sub.features.map((f) => <Badge key={f} variant="secondary">{f}</Badge>)}</CardContent></Card> : null}
    </>
  );
}
