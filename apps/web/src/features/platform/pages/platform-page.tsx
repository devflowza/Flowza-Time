import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Activity, Building2, KeyRound, Plus, ShieldCheck, X } from 'lucide-react';
import { ORG_STATUSES, type PlatformOrganizationDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, StatCard, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { useServerTable } from '@/hooks/use-server-table';
import { fmtDateTime, fmtNumber, fmtRelative } from '@/lib/format';
import { SearchBox } from '@/features/organization/components/search-box';
import { usePlans, usePlatformHealth, usePlatformOrgs } from '../api';
import { CreateOrgDialog } from '../components/create-org-dialog';
import { GrantsTable } from '../components/grants-table';
import { OrgStatusBadge } from '../components/org-status-badge';

const ALL = '__all__';
const TABS = ['organizations', 'grants', 'plans', 'health'] as const;
type Tab = (typeof TABS)[number];

function OrganizationsTab() {
  const { t } = useTranslation('platform');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const table = useServerTable({ sort: 'createdAt', order: 'desc' });
  // the `tab` search param belongs to the page, not to the organisations query
  const { tab: _tab, ...query } = table.query as typeof table.query & { tab?: string };
  const q = usePlatformOrgs(query);
  const [creating, setCreating] = useState(false);
  const filters = table.state.filters;
  const hasFilters = Object.keys(filters).some((k) => k !== 'tab');
  const columns = useMemo<ColumnDef<PlatformOrganizationDto, unknown>[]>(() => [
    { id: 'displayName', header: t('orgs.displayName'), cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.displayName}</p><p className="truncate text-xs text-muted-foreground">{row.original.legalName}</p></div> },
    { id: 'companyCode', header: t('orgs.companyCode'), cell: ({ row }) => <span className="font-mono text-xs" dir="ltr">{row.original.companyCode}</span>, size: 110 },
    { id: 'status', header: tc('common.status'), cell: ({ row }) => <OrgStatusBadge status={row.original.status} /> },
    { id: 'plan', header: t('orgs.plan'), enableSorting: false, cell: ({ row }) => row.original.subscription ? <div><p className="text-sm">{row.original.subscription.planName}</p><p className="text-xs text-muted-foreground">{t(`subscription.${row.original.subscription.status}`)}{row.original.subscription.trialEndsAt ? ` · ${fmtRelative(row.original.subscription.trialEndsAt)}` : ''}</p></div> : <span className="text-muted-foreground">—</span> },
    { id: 'region', header: t('orgs.region'), enableSorting: false, cell: ({ row }) => <span className="font-mono text-xs" dir="ltr">{row.original.regionCell}</span> },
    { id: 'country', header: t('orgs.country'), enableSorting: false, cell: ({ row }) => <span dir="ltr">{row.original.countryCode} · {row.original.timezone}</span> },
    { id: 'createdAt', header: tc('common.createdAt'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDateTime(row.original.createdAt, row.original.timezone)}</span> },
  ], [t, tc]);
  return (
    <>
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} sort={table.state.sort} order={table.state.order} onSort={table.toggleSort}
        isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="platform-orgs"
        onRowClick={(o) => navigate(`/platform/orgs/${o.id}`)}
        emptyTitle={hasFilters ? tc('common.noResults') : t('orgs.empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('orgs.emptyHint')}
        emptyAction={!hasFilters ? <Button onClick={() => setCreating(true)}><Plus /> {t('orgs.create')}</Button> : undefined}
        toolbar={<>
          <SearchBox value={filters['search']} onChange={(v) => table.setFilter('search', v)} placeholder={t('orgs.searchPlaceholder')} />
          <Select value={filters['status'] ?? ALL} onValueChange={(v) => table.setFilter('status', v === ALL ? undefined : v)}>
            <SelectTrigger className="h-8 w-40" aria-label={tc('common.status')}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={ALL}>{t('orgs.allStatuses')}</SelectItem>{ORG_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`status.${s}`)}</SelectItem>)}</SelectContent>
          </Select>
          {hasFilters ? <Button variant="ghost" size="sm" onClick={() => table.update({ filters: { search: '', status: '' } })}><X /> {tc('common.clearFilters')}</Button> : null}
          <Button size="sm" className="ms-auto" onClick={() => setCreating(true)}><Plus /> {t('orgs.create')}</Button>
        </>}
        renderCard={(o) => <div className="flex items-center justify-between gap-2"><div className="min-w-0"><p className="truncate font-medium">{o.displayName}</p><p className="truncate text-xs text-muted-foreground">{o.companyCode}</p></div><OrgStatusBadge status={o.status} /></div>}
      />
      {creating ? <CreateOrgDialog open onOpenChange={(o) => !o && setCreating(false)} /> : null}
    </>
  );
}

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

export default function PlatformPage() {
  const { t } = useTranslation('platform');
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'organizations';
  return (
    <div className="page-container">
      <PageHeader title={t('title')} description={t('subtitle')} actions={<Badge variant="warning" className="gap-1"><Activity className="size-3" aria-hidden /> {t('audited')}</Badge>} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList className="max-w-full overflow-x-auto">{TABS.map((tb) => <TabsTrigger key={tb} value={tb}>{t(`tabs.${tb}`)}</TabsTrigger>)}</TabsList>
        <TabsContent value="organizations">{tab === 'organizations' ? <OrganizationsTab /> : null}</TabsContent>
        <TabsContent value="grants">{tab === 'grants' ? <GrantsTable /> : null}</TabsContent>
        <TabsContent value="plans">{tab === 'plans' ? <PlansTab /> : null}</TabsContent>
        <TabsContent value="health">{tab === 'health' ? <HealthTab /> : null}</TabsContent>
      </Tabs>
    </div>
  );
}
