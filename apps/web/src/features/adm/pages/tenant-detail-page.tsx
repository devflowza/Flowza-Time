import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Building2, Cpu, KeyRound, Lock, Pencil, Plus, ShieldAlert, UserRound, Users } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, Skeleton, StatCard, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { fmtDateTime, fmtNumber } from '@/lib/format';
import { usePlatformOrg } from '@/features/platform/api';
import { GrantDialog } from '@/features/platform/components/grant-dialog';
import { GrantsTable } from '@/features/platform/components/grants-table';
import { OrgStatusBadge } from '@/features/platform/components/org-status-badge';
import { StatusDialog } from '@/features/platform/components/status-dialog';
import { usePlatformActivity } from '../api';
import { ActivityList } from '../components/activity-list';
import { Pager } from '../components/pager';
import { EditTenantDialog } from '../components/edit-tenant-dialog';
import { SubscriptionPanel } from '../components/subscription-panel';
import { TenantModulesPanel } from '../components/tenant-modules-panel';
import { TenantBillingPanel } from '../components/tenant-billing-panel';
import { MembersPanel, NotesPanel, OrgFeatureFlagsCard, TenantAccountCard } from '../components/tenant-panels';

const TABS = ['overview', 'subscription', 'modules', 'billing', 'members', 'flags', 'access', 'notes', 'activity'] as const;
type Tab = (typeof TABS)[number];

function Item({ label, children, ltr }: { label: string; children: React.ReactNode; ltr?: boolean }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-0.5 break-words text-sm" dir={ltr ? 'ltr' : undefined}>{children}</dd></div>;
}

function TenantActivity({ orgId }: { orgId: string }) {
  const { t } = useTranslation('adm');
  const [page, setPage] = useState(1);
  const q = usePlatformActivity(useMemo(() => ({ organizationId: orgId, page, pageSize: 25 }), [orgId, page]));
  const total = q.data?.meta.totalPages ?? 1;
  return (
    <Card>
      <CardHeader><CardTitle>{t('activity.title')}</CardTitle><CardDescription>{t('activity.tenantHint')}</CardDescription></CardHeader>
      <CardContent>
        {q.isLoading ? <Skeleton className="h-40 w-full" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <ActivityList entries={q.data?.data ?? []} empty={t('activity.empty')} showTenant={false} />}
        {total > 1 ? <Pager page={page} total={total} onPage={setPage} /> : null}
      </CardContent>
    </Card>
  );
}

export default function AdmTenantDetailPage() {
  const { t } = useTranslation('adm');
  const { t: tp } = useTranslation('platform');
  const { t: tc } = useTranslation();
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'overview';
  const q = usePlatformOrg(id);
  const [editing, setEditing] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const o = q.data;
  if (q.isLoading) return <div className="page-container space-y-4"><Skeleton className="h-8 w-72" /><Skeleton className="h-24 w-full" /><Skeleton className="h-96 w-full" /></div>;
  if (q.isError || !o) return <div className="page-container"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>;
  const contact = o.contact as Record<string, string | undefined>;
  const address = o.address as Record<string, string | undefined>;
  const addressLine = [address['line1'], address['line2'], address['city'], address['region'], address['postalCode'], address['country']].filter(Boolean).join(', ');
  return (
    <div className="page-container">
      <PageHeader
        breadcrumbs={<Link to="/adm/tenants" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="size-3 rtl:rotate-180" /> {t('tenant.back')}</Link>}
        title={o.displayName} description={`${o.legalName} · ${o.companyCode}`}
        actions={<>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil /> {t('tenant.editDetails')}</Button>
          <Button size="sm" variant="outline" onClick={() => setGrantOpen(true)}><KeyRound /> {tp('grants.create')}</Button>
          <Button size="sm" variant={o.status === 'suspended' || o.status === 'closed' ? 'default' : 'destructive'} onClick={() => setStatusOpen(true)}><ShieldAlert /> {tp('orgs.changeStatus')}</Button>
        </>}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <OrgStatusBadge status={o.status} />
        {o.legalHold ? <Badge variant="danger" className="gap-1"><Lock className="size-3" aria-hidden /> {tp('orgs.legalHold')}</Badge> : null}
        {o.subscription ? <Badge variant="secondary">{o.subscription.planName} · {tp(`subscription.${o.subscription.status}`)}</Badge> : null}
        <Badge variant="outline" className="font-mono" dir="ltr">{o.regionCell}</Badge>
      </div>
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
        <TabsList className="max-w-full overflow-x-auto">{TABS.map((tb) => <TabsTrigger key={tb} value={tb}>{t(`tenant.tabs.${tb}`)}</TabsTrigger>)}</TabsList>
        <TabsContent value="overview">
          {tab === 'overview' ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard label={tp('orgs.counts.employees')} value={fmtNumber(o.counts?.employees ?? 0)} icon={Users} />
                <StatCard label={tp('orgs.counts.devices')} value={fmtNumber(o.counts?.devices ?? 0)} icon={Cpu} />
                <StatCard label={tp('orgs.counts.branches')} value={fmtNumber(o.counts?.branches ?? 0)} icon={Building2} />
                <StatCard label={tp('orgs.counts.users')} value={fmtNumber(o.counts?.users ?? 0)} icon={UserRound} onClick={() => setParams({ tab: 'members' }, { replace: true })} />
              </div>
              <div className="grid gap-4 lg:grid-cols-3">
                <Card className="lg:col-span-2">
                  <CardHeader className="flex-row items-center justify-between space-y-0"><CardTitle>{tp('orgs.details')}</CardTitle><Button size="sm" variant="ghost" onClick={() => setEditing(true)}><Pencil /> {tc('common.edit')}</Button></CardHeader>
                  <CardContent>
                    <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                      <Item label={tp('orgs.legalName')}>{o.legalName}</Item>
                      <Item label={tp('orgs.companyCode')} ltr><span className="font-mono">{o.companyCode}</span></Item>
                      <Item label={tp('orgs.country')} ltr>{o.countryCode}</Item>
                      <Item label={tc('common.timezone')} ltr>{o.timezone}</Item>
                      <Item label={tp('orgs.currency')} ltr>{o.currencyCode}</Item>
                      <Item label={tc('common.language')}>{t(`tenant.locales.${o.locale === 'ar' ? 'ar' : 'en'}`)}</Item>
                      <Item label={t('tenant.fields.weeklyOff')}>{o.weeklyOffDays.length ? o.weeklyOffDays.map((d) => t(`tenant.days.${d}`)).join(', ') : '—'}</Item>
                      <Item label={t('tenant.contact')}>{contact['name'] || contact['email'] || contact['phone'] ? <><span className="block">{contact['name']}</span><span className="block text-xs" dir="ltr">{[contact['email'], contact['phone']].filter(Boolean).join(' · ')}</span>{contact['website'] ? <a className="block truncate text-xs text-primary hover:underline" href={contact['website']} target="_blank" rel="noreferrer noopener" dir="ltr">{contact['website']}</a> : null}</> : <span className="text-muted-foreground">{t('tenant.noContact')}</span>}</Item>
                      <Item label={t('tenant.address')}>{addressLine || <span className="text-muted-foreground">{t('tenant.noAddress')}</span>}</Item>
                      <Item label={tc('common.createdAt')}>{fmtDateTime(o.createdAt, o.timezone)}</Item>
                      <Item label={tc('common.updatedAt')}>{fmtDateTime(o.updatedAt, o.timezone)}</Item>
                      <Item label={tp('orgs.id')} ltr><span className="font-mono text-xs">{o.id}</span></Item>
                    </dl>
                  </CardContent>
                </Card>
                <TenantAccountCard orgId={o.id} />
              </div>
            </div>
          ) : null}
        </TabsContent>
        <TabsContent value="subscription">{tab === 'subscription' ? <SubscriptionPanel orgId={o.id} timezone={o.timezone} /> : null}</TabsContent>
        <TabsContent value="modules">{tab === 'modules' ? <TenantModulesPanel orgId={o.id} /> : null}</TabsContent>
        <TabsContent value="billing">{tab === 'billing' ? <TenantBillingPanel orgId={o.id} /> : null}</TabsContent>
        <TabsContent value="members">{tab === 'members' ? <MembersPanel orgId={o.id} /> : null}</TabsContent>
        <TabsContent value="flags">{tab === 'flags' ? <OrgFeatureFlagsCard orgId={o.id} /> : null}</TabsContent>
        <TabsContent value="access">
          {tab === 'access' ? (
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <div><CardTitle>{tp('grants.title')}</CardTitle><CardDescription>{tp('grants.hint')}</CardDescription></div>
                <Button size="sm" variant="outline" onClick={() => setGrantOpen(true)}><Plus /> {tp('grants.create')}</Button>
              </CardHeader>
              <CardContent><GrantsTable organizationId={o.id} /></CardContent>
            </Card>
          ) : null}
        </TabsContent>
        <TabsContent value="notes">{tab === 'notes' ? <NotesPanel orgId={o.id} /> : null}</TabsContent>
        <TabsContent value="activity">{tab === 'activity' ? <TenantActivity orgId={o.id} /> : null}</TabsContent>
      </Tabs>
      {editing ? <EditTenantDialog org={o} open onOpenChange={(v) => !v && setEditing(false)} /> : null}
      {statusOpen ? <StatusDialog orgId={o.id} current={o.status} open onOpenChange={(v) => !v && setStatusOpen(false)} /> : null}
      {grantOpen ? <GrantDialog organizationId={o.id} organizationName={o.displayName} open onOpenChange={(v) => !v && setGrantOpen(false)} /> : null}
    </div>
  );
}
