import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import { ORG_STATUSES, SUBSCRIPTION_STATUSES, type PlatformOrganizationDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Badge, Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { useServerTable } from '@/hooks/use-server-table';
import { fmtDateTime, fmtNumber, fmtRelative } from '@/lib/format';
import { SearchBox } from '@/features/organization/components/search-box';
import { usePlans, usePlatformOrgs } from '@/features/platform/api';
import { CreateOrgDialog } from '@/features/platform/components/create-org-dialog';
import { OrgStatusBadge } from '@/features/platform/components/org-status-badge';

const ALL = '__all__';

export default function AdmTenantsPage() {
  const { t } = useTranslation('adm');
  const { t: tp } = useTranslation('platform');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const table = useServerTable({ sort: 'createdAt', order: 'desc' });
  const q = usePlatformOrgs(table.query);
  const plans = usePlans();
  const [creating, setCreating] = useState(false);
  const filters = table.state.filters;
  const hasFilters = Object.keys(filters).length > 0;
  const columns = useMemo<ColumnDef<PlatformOrganizationDto, unknown>[]>(() => [
    { id: 'displayName', header: tp('orgs.displayName'), cell: ({ row }) => (
      <div className="min-w-0">
        <p className="truncate font-medium">{row.original.displayName}</p>
        <p className="truncate text-xs text-muted-foreground"><span className="font-mono" dir="ltr">{row.original.companyCode}</span> · {row.original.legalName}</p>
      </div>
    ) },
    { id: 'status', header: tc('common.status'), cell: ({ row }) => <OrgStatusBadge status={row.original.status} /> },
    { id: 'plan', header: tp('orgs.plan'), enableSorting: false, cell: ({ row }) => row.original.subscription ? (
      <div><p className="text-sm">{row.original.subscription.planName}</p><p className="text-xs text-muted-foreground">{tp(`subscription.${row.original.subscription.status}`)}{row.original.subscription.trialEndsAt && row.original.subscription.status === 'trialing' ? ` · ${fmtRelative(row.original.subscription.trialEndsAt)}` : ''}</p></div>
    ) : <span className="text-muted-foreground">—</span> },
    { id: 'people', header: t('tenants.people'), enableSorting: false, cell: ({ row }) => row.original.counts ? (
      <div className="text-xs tnum"><p>{fmtNumber(row.original.counts.employees)} {tp('orgs.counts.employees').toLowerCase()}</p><p className="text-muted-foreground">{fmtNumber(row.original.counts.users)} {tp('orgs.counts.users').toLowerCase()} · {fmtNumber(row.original.counts.devices)} {tp('orgs.counts.devices').toLowerCase()}</p></div>
    ) : null },
    { id: 'manager', header: t('tenants.manager'), enableSorting: false, cell: ({ row }) => row.original.account?.accountManagerEmail ? <span className="text-xs" dir="ltr">{row.original.account.accountManagerEmail}</span> : <span className="text-xs text-muted-foreground">{t('tenants.unassigned')}</span> },
    { id: 'tags', header: t('tenants.tags'), enableSorting: false, cell: ({ row }) => <div className="flex max-w-[220px] flex-wrap gap-1">{(row.original.account?.tags ?? []).map((tag) => <Badge key={tag} variant="secondary" className="font-normal">{tag}</Badge>)}</div> },
    { id: 'country', header: tp('orgs.country'), enableSorting: false, cell: ({ row }) => <span className="text-xs" dir="ltr">{row.original.countryCode} · {row.original.currencyCode}</span> },
    { id: 'createdAt', header: tc('common.createdAt'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDateTime(row.original.createdAt, row.original.timezone, 'dd MMM yyyy')}</span> },
  ], [t, tp, tc]);
  const clear = () => table.update({ filters: { search: '', status: '', planKey: '', subscriptionStatus: '' } });
  return (
    <div className="page-container">
      <PageHeader title={t('tenants.title')} description={t('tenants.subtitle')} actions={<Button size="sm" onClick={() => setCreating(true)}><Plus /> {tp('orgs.create')}</Button>} />
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} sort={table.state.sort} order={table.state.order} onSort={table.toggleSort}
        isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="adm-tenants"
        onRowClick={(o) => navigate(`/adm/tenants/${o.id}`)}
        emptyTitle={hasFilters ? tc('common.noResults') : tp('orgs.empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : tp('orgs.emptyHint')}
        emptyAction={!hasFilters ? <Button onClick={() => setCreating(true)}><Plus /> {tp('orgs.create')}</Button> : undefined}
        toolbar={<>
          <SearchBox value={filters['search']} onChange={(v) => table.setFilter('search', v)} placeholder={tp('orgs.searchPlaceholder')} />
          <Select value={filters['status'] ?? ALL} onValueChange={(v) => table.setFilter('status', v === ALL ? undefined : v)}>
            <SelectTrigger className="h-8 w-36" aria-label={tc('common.status')}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={ALL}>{tp('orgs.allStatuses')}</SelectItem>{ORG_STATUSES.map((s) => <SelectItem key={s} value={s}>{tp(`status.${s}`)}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={filters['planKey'] ?? ALL} onValueChange={(v) => table.setFilter('planKey', v === ALL ? undefined : v)}>
            <SelectTrigger className="h-8 w-36" aria-label={tp('orgs.plan')}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={ALL}>{t('tenants.allPlans')}</SelectItem>{(plans.data ?? []).map((p) => <SelectItem key={p.key} value={p.key}>{p.name}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={filters['subscriptionStatus'] ?? ALL} onValueChange={(v) => table.setFilter('subscriptionStatus', v === ALL ? undefined : v)}>
            <SelectTrigger className="h-8 w-40" aria-label={t('subscription.status')}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={ALL}>{t('tenants.allSubscriptions')}</SelectItem>{SUBSCRIPTION_STATUSES.map((s) => <SelectItem key={s} value={s}>{tp(`subscription.${s}`)}</SelectItem>)}</SelectContent>
          </Select>
          {hasFilters ? <Button variant="ghost" size="sm" onClick={clear}><X /> {tc('common.clearFilters')}</Button> : null}
        </>}
        renderCard={(o) => <div className="flex items-center justify-between gap-2"><div className="min-w-0"><p className="truncate font-medium">{o.displayName}</p><p className="truncate text-xs text-muted-foreground">{o.companyCode}{o.subscription ? ` · ${o.subscription.planName}` : ''}</p></div><OrgStatusBadge status={o.status} /></div>}
      />
      {creating ? <CreateOrgDialog open onOpenChange={(v) => !v && setCreating(false)} /> : null}
    </div>
  );
}
