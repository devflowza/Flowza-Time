import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Building2, Cpu, KeyRound, Lock, Plus, RotateCcw, ShieldAlert, Users } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, Skeleton, StatCard, Switch } from '@/components/ui';
import { fmtDateTime, fmtNumber } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useOrgFeatureFlags, usePlatformMutations, usePlatformOrg } from '../api';
import { GrantDialog } from '../components/grant-dialog';
import { GrantsTable } from '../components/grants-table';
import { OrgStatusBadge } from '../components/org-status-badge';
import { StatusDialog } from '../components/status-dialog';

function Item({ label, children, ltr }: { label: string; children: React.ReactNode; ltr?: boolean }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-0.5 truncate text-sm" dir={ltr ? 'ltr' : undefined}>{children}</dd></div>;
}

function FeatureFlags({ orgId }: { orgId: string }) {
  const { t } = useTranslation('platform');
  const q = useOrgFeatureFlags(orgId);
  const { putOrgFlags } = usePlatformMutations();
  const [pending, setPending] = useState<string | null>(null);
  const set = (key: string, value: boolean | null) => {
    setPending(key);
    putOrgFlags.mutate({ id: orgId, input: { flags: { [key]: value } } }, { onSuccess: () => toast.success(t('flags.saved')), onError: toastError, onSettled: () => setPending(null) });
  };
  return (
    <Card>
      <CardHeader><CardTitle>{t('flags.title')}</CardTitle><CardDescription>{t('flags.hint')}</CardDescription></CardHeader>
      <CardContent>
        {q.isLoading ? <Skeleton className="h-32 w-full" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (q.data?.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground">{t('flags.empty')}</p> : (
          <ul className="divide-y">
            {q.data?.map((f) => (
              <li key={f.key} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm"><span className="font-mono" dir="ltr">{f.key}</span>{f.override !== null ? <Badge variant="info" className="font-normal">{t('flags.override')}</Badge> : <Badge variant="outline" className="font-normal">{t(f.defaultEnabled ? 'flags.defaultOn' : 'flags.defaultOff')}</Badge>}</p>
                  <p className="text-xs text-muted-foreground">{f.description}</p>
                </div>
                {f.override !== null ? <Button size="sm" variant="ghost" onClick={() => set(f.key, null)} disabled={pending === f.key} aria-label={t('flags.reset', { key: f.key })}><RotateCcw /> {t('flags.resetShort')}</Button> : null}
                <Switch checked={f.effective} onCheckedChange={(v) => set(f.key, v)} disabled={pending === f.key} aria-label={t('flags.toggle', { key: f.key })} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function PlatformOrgPage() {
  const { t } = useTranslation('platform');
  const { t: tc } = useTranslation();
  const { id = '' } = useParams();
  const q = usePlatformOrg(id);
  const [statusOpen, setStatusOpen] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const o = q.data;
  return (
    <div className="page-container">
      {q.isLoading ? <div className="space-y-4"><Skeleton className="h-8 w-72" /><Skeleton className="h-24 w-full" /><Skeleton className="h-96 w-full" /></div>
        : q.isError || !o ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
          <>
            <PageHeader
              breadcrumbs={<Link to="/platform" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="size-3 rtl:rotate-180" /> {t('title')}</Link>}
              title={o.displayName} description={`${o.legalName} · ${o.companyCode}`}
              actions={<>
                <Button size="sm" variant="outline" onClick={() => setGrantOpen(true)}><KeyRound /> {t('grants.create')}</Button>
                <Button size="sm" variant={o.status === 'suspended' ? 'default' : 'destructive'} onClick={() => setStatusOpen(true)}><ShieldAlert /> {t('orgs.changeStatus')}</Button>
              </>}
            />
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <OrgStatusBadge status={o.status} />
              {o.legalHold ? <Badge variant="danger" className="gap-1"><Lock className="size-3" aria-hidden /> {t('orgs.legalHold')}</Badge> : null}
              <Badge variant="outline" className="font-mono" dir="ltr">{o.regionCell}</Badge>
              {o.subscription ? <Badge variant="secondary">{o.subscription.planName} · {t(`subscription.${o.subscription.status}`)}</Badge> : null}
            </div>
            <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label={t('orgs.counts.employees')} value={fmtNumber(o.counts?.employees ?? 0)} icon={Users} />
              <StatCard label={t('orgs.counts.devices')} value={fmtNumber(o.counts?.devices ?? 0)} icon={Cpu} />
              <StatCard label={t('orgs.counts.branches')} value={fmtNumber(o.counts?.branches ?? 0)} icon={Building2} />
              <StatCard label={t('orgs.counts.users')} value={fmtNumber(o.counts?.users ?? 0)} icon={Users} />
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <Card>
                <CardHeader><CardTitle>{t('orgs.details')}</CardTitle></CardHeader>
                <CardContent>
                  <dl className="grid gap-3">
                    <Item label={t('orgs.country')} ltr>{o.countryCode}</Item>
                    <Item label={tc('common.timezone')} ltr>{o.timezone}</Item>
                    <Item label={t('orgs.currency')} ltr>{o.currencyCode}</Item>
                    <Item label={tc('common.language')} ltr>{o.locale}</Item>
                    <Item label={t('orgs.plan')}>{o.subscription ? `${o.subscription.planName} (${o.subscription.planKey})` : '—'}</Item>
                    <Item label={t('orgs.trialEnds')}>{fmtDateTime(o.subscription?.trialEndsAt, o.timezone)}</Item>
                    <Item label={t('orgs.periodEnd')}>{fmtDateTime(o.subscription?.currentPeriodEnd, o.timezone)}</Item>
                    <Item label={tc('common.createdAt')}>{fmtDateTime(o.createdAt, o.timezone)}</Item>
                    <Item label={tc('common.updatedAt')}>{fmtDateTime(o.updatedAt, o.timezone)}</Item>
                    <Item label={t('orgs.id')} ltr><span className="font-mono text-xs">{o.id}</span></Item>
                  </dl>
                </CardContent>
              </Card>
              <div className="lg:col-span-2"><FeatureFlags orgId={o.id} /></div>
              <Card className="lg:col-span-3">
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <div><CardTitle>{t('grants.title')}</CardTitle><CardDescription>{t('grants.hint')}</CardDescription></div>
                  <Button size="sm" variant="outline" onClick={() => setGrantOpen(true)}><Plus /> {t('grants.create')}</Button>
                </CardHeader>
                <CardContent><GrantsTable organizationId={o.id} /></CardContent>
              </Card>
            </div>
            {statusOpen ? <StatusDialog orgId={o.id} current={o.status} open onOpenChange={(v) => !v && setStatusOpen(false)} /> : null}
            {grantOpen ? <GrantDialog organizationId={o.id} organizationName={o.displayName} open onOpenChange={(v) => !v && setGrantOpen(false)} /> : null}
          </>
        )}
    </div>
  );
}
