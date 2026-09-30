import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Banknote, Building2, Clock, Cpu, KeyRound, Plus, Receipt, ShieldCheck, TrendingUp, TriangleAlert, UserRound, Users } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Button, Card, CardContent, CardHeader, CardTitle, ErrorState, Skeleton, StatCard } from '@/components/ui';
import { fmtDateTime, fmtMoney, fmtNumber, fmtRelative } from '@/lib/format';
import { CreateOrgDialog } from '@/features/platform/components/create-org-dialog';
import { OrgStatusBadge } from '@/features/platform/components/org-status-badge';
import { usePlatformOverview } from '../api';
import { useBillingSummary } from '../billing-api';
import { ActivityList } from '../components/activity-list';

function Bars({ rows }: { rows: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.label} className="space-y-1">
          <div className="flex items-center justify-between text-sm"><span className="truncate">{r.label}</span><span className="tnum text-muted-foreground">{fmtNumber(r.value)}</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-brand-600" style={{ width: `${(r.value / max) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

/** Revenue at a glance (the Billing page's figures): monthly recurring revenue, outstanding and overdue invoices. */
function RevenueStrip() {
  const { t } = useTranslation('adm');
  const navigate = useNavigate();
  const q = useBillingSummary();
  const s = q.data;
  if (q.isError) return null;
  const c = s?.currency ?? 'OMR';
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="revenue-strip">
      <StatCard loading={!s} label={t('billing.kpi.mrr')} value={fmtMoney(s?.mrr ?? 0, c)} icon={TrendingUp} tone="success" onClick={() => navigate('/adm/billing')} />
      <StatCard loading={!s} label={t('billing.kpi.arr')} value={fmtMoney(s?.arr ?? 0, c)} icon={Banknote} onClick={() => navigate('/adm/billing')} />
      <StatCard loading={!s} label={t('billing.kpi.outstanding')} value={fmtMoney(s?.outstanding ?? 0, c)} icon={Receipt} tone={(s?.outstanding ?? 0) > 0 ? 'warning' : 'default'} onClick={() => navigate('/adm/billing?tab=invoices')} />
      <StatCard loading={!s} label={t('billing.kpi.overdue')} value={fmtNumber(s?.overdueInvoices ?? 0)} icon={TriangleAlert} tone={(s?.overdueInvoices ?? 0) > 0 ? 'danger' : 'default'} hint={s ? fmtMoney(s.overdueAmount, c) : undefined} onClick={() => navigate('/adm/billing?tab=invoices')} />
    </div>
  );
}

export default function AdmDashboardPage() {
  const { t } = useTranslation('adm');
  const { t: tp } = useTranslation('platform');
  const navigate = useNavigate();
  const q = usePlatformOverview();
  const [creating, setCreating] = useState(false);
  const o = q.data;
  return (
    <div className="page-container space-y-5">
      <PageHeader title={t('dashboard.title')} description={t('dashboard.subtitle')} actions={<Button size="sm" onClick={() => setCreating(true)}><Plus /> {t('dashboard.newTenant')}</Button>} />
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard loading={!o} label={t('dashboard.tenants')} value={fmtNumber(o?.organizations.total ?? 0)} icon={Building2} hint={t('dashboard.tenantsHint', { count: o?.organizations.newLast30Days ?? 0 })} onClick={() => navigate('/adm/tenants')} />
            <StatCard loading={!o} label={t('dashboard.activeSubs')} value={fmtNumber(o?.subscriptions.byStatus['active'] ?? 0)} icon={ShieldCheck} tone="success" hint={`${t('dashboard.trialing')}: ${fmtNumber(o?.subscriptions.byStatus['trialing'] ?? 0)}`} onClick={() => navigate('/adm/tenants?subscriptionStatus=active')} />
            <StatCard loading={!o} label={t('dashboard.users')} value={fmtNumber(o?.totals.users ?? 0)} icon={UserRound} onClick={() => navigate('/adm/users')} />
            <StatCard loading={!o} label={t('dashboard.employees')} value={fmtNumber(o?.totals.employees ?? 0)} icon={Users} tone="info" />
            <StatCard loading={!o} label={t('dashboard.devices')} value={fmtNumber(o?.totals.devices ?? 0)} icon={Cpu} />
            <StatCard loading={!o} label={t('dashboard.admins')} value={fmtNumber(o?.platformAdmins ?? 0)} icon={ShieldCheck} onClick={() => navigate('/adm/team')} />
            <StatCard loading={!o} label={t('dashboard.grants')} value={fmtNumber(o?.activeGrants ?? 0)} icon={KeyRound} tone={(o?.activeGrants ?? 0) > 0 ? 'warning' : 'default'} hint={o?.pendingGrants ? t('dashboard.pendingGrants', { count: o.pendingGrants }) : undefined} onClick={() => navigate('/adm/grants')} />
            <StatCard loading={!o} label={t('dashboard.trialsSoon')} value={fmtNumber(o?.trialsEndingSoon.length ?? 0)} icon={Clock} tone={(o?.trialsEndingSoon.length ?? 0) > 0 ? 'warning' : 'default'} onClick={() => navigate('/adm/tenants?subscriptionStatus=trialing&sort=trialEndsAt')} />
          </div>
          <RevenueStrip />
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader className="flex-row items-center justify-between space-y-0"><CardTitle>{t('dashboard.recentTenants')}</CardTitle><Button variant="link" size="sm" asChild><Link to="/adm/tenants">{t('dashboard.viewAll')}</Link></Button></CardHeader>
              <CardContent>
                {!o ? <Skeleton className="h-40 w-full" /> : (
                  <ul className="divide-y">
                    {o.recentOrganizations.map((r) => (
                      <li key={r.id}><Link to={`/adm/tenants/${r.id}`} className="flex items-center gap-3 py-2.5 hover:bg-muted/40">
                        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{r.displayName}</p><p className="truncate text-xs text-muted-foreground"><span className="font-mono" dir="ltr">{r.companyCode}</span>{r.planName ? ` · ${r.planName}` : ''}</p></div>
                        <OrgStatusBadge status={r.status} />
                        <span className="hidden w-28 text-end text-xs text-muted-foreground tnum sm:block">{fmtRelative(r.createdAt)}</span>
                      </Link></li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>{t('dashboard.trialsSoon')}</CardTitle></CardHeader>
              <CardContent>
                {!o ? <Skeleton className="h-40 w-full" /> : o.trialsEndingSoon.length === 0 ? <p className="text-sm text-muted-foreground">{t('dashboard.trialsSoonEmpty')}</p> : (
                  <ul className="divide-y">
                    {o.trialsEndingSoon.map((r) => (
                      <li key={r.id}><Link to={`/adm/tenants/${r.id}?tab=subscription`} className="flex items-center justify-between gap-2 py-2.5 hover:bg-muted/40">
                        <span className="truncate text-sm font-medium">{r.displayName}</span>
                        <span className="shrink-0 text-xs text-amber-700 dark:text-amber-400 tnum" title={fmtDateTime(r.trialEndsAt, 'UTC')}>{t('dashboard.endsIn', { when: fmtRelative(r.trialEndsAt) })}</span>
                      </Link></li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>{t('dashboard.byPlan')}</CardTitle></CardHeader>
              <CardContent>{!o ? <Skeleton className="h-32 w-full" /> : <Bars rows={o.subscriptions.byPlan.map((p) => ({ label: p.planName, value: p.count }))} />}</CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>{t('dashboard.byStatus')}</CardTitle></CardHeader>
              <CardContent>{!o ? <Skeleton className="h-32 w-full" /> : <Bars rows={Object.entries(o.organizations.byStatus).map(([k, v]) => ({ label: tp(`status.${k}`, { defaultValue: k }), value: v }))} />}</CardContent>
            </Card>
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0"><CardTitle>{t('dashboard.recentActivity')}</CardTitle><Button variant="link" size="sm" asChild><Link to="/adm/activity">{t('dashboard.viewAll')}</Link></Button></CardHeader>
              <CardContent>{!o ? <Skeleton className="h-32 w-full" /> : <ActivityList entries={o.recentActivity} empty={t('dashboard.activityEmpty')} compact />}</CardContent>
            </Card>
          </div>
        </>
      )}
      {creating ? <CreateOrgDialog open onOpenChange={(v) => !v && setCreating(false)} /> : null}
    </div>
  );
}
