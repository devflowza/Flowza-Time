import { useMemo, useState } from 'react';
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Activity, Cpu, FolderKanban, HeartPulse, Plus, RefreshCw, Users, WifiOff, X, CircleHelp, AlertTriangle } from 'lucide-react';
import { CONNECTION_STATUSES, DEVICE_STATUSES, type SyncJobAcceptedDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Button, ConfirmDialog, EmptyState, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, StatCard, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, FormField } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { useServerTable } from '@/hooks/use-server-table';
import { fmtNumber, fmtRelative } from '@/lib/format';
import { toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { SearchBox } from '@/features/organization/components/search-box';
import { useSyncMutations } from '@/features/sync/api';
import { toastJobAccepted } from '@/features/sync/job-toast';
import { useDeviceSummary, useDevices, useGroupMutations, useGroupOptions, useProviders, type DeviceRow } from '../api';
import { ConnectionBadge, DeviceStatusBadge, ProviderStatusBadge, TagChips } from '../components/device-badges';
import { PendingDevicesPanel } from '../components/pending-devices-panel';

const ALL = '__all__';
type BulkKind = 'sync-attendance' | 'sync-employees' | 'health-check' | 'assign-group';

export default function DevicesListPage() {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const can = useCan();
  const table = useServerTable({ sort: 'name' });
  const q = useDevices(table.query);
  const branches = useBranchOptions();
  const providers = useProviders();
  const groups = useGroupOptions();
  const sync = useSyncMutations();
  const groupMut = useGroupMutations();
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [bulk, setBulk] = useState<{ kind: BulkKind; ids: string[] } | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const filters = table.state.filters;
  // fleet counts come from the server (branch-scoped like the list) — a page of the list must never be aggregated client-side
  const summary = useDeviceSummary({ branchId: filters['branchId'] });
  const hasFilters = Object.keys(filters).length > 0;
  const providerNames = useMemo(() => new Map((providers.data ?? []).map((p) => [p.key, p])), [providers.data]);

  const counts = useMemo(() => {
    const by = summary.data?.byConnectionStatus ?? {};
    const n = (k: string) => by[k] ?? 0;
    return { online: n('online'), offline: n('offline') + n('error'), degraded: n('degraded') + n('vendor_degraded'), unknown: n('unknown'), stale: summary.data?.staleHeartbeats ?? 0 };
  }, [summary.data]);

  const columns = useMemo<ColumnDef<DeviceRow, unknown>[]>(() => [
    { id: 'name', accessorKey: 'name', header: tc('common.name'), cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.name}</p><p className="truncate font-mono text-xs text-muted-foreground" dir="ltr">{row.original.code}</p></div> },
    { id: 'model', header: t('columns.model'), enableSorting: false, cell: ({ row }) => <div className="min-w-0"><p className="truncate">{row.original.manufacturer}</p><p className="truncate text-xs text-muted-foreground">{row.original.modelName ?? '—'}</p></div> },
    { id: 'branch', header: tc('common.branch'), cell: ({ row }) => row.original.branchName ?? '—' },
    { id: 'connectionStatus', accessorKey: 'connectionStatus', header: t('columns.connection'), cell: ({ row }) => <ConnectionBadge status={row.original.connectionStatus} lastHeartbeatAt={row.original.lastHeartbeatAt} /> },
    { id: 'status', accessorKey: 'status', header: tc('common.status'), cell: ({ row }) => <DeviceStatusBadge status={row.original.status} /> },
    { id: 'lastAttendanceSyncAt', header: t('columns.lastAttendanceSync'), enableSorting: false, cell: ({ row }) => <span className="text-xs tnum" title={row.original.lastAttendanceSyncAt ?? ''}>{fmtRelative(row.original.lastAttendanceSyncAt)}</span> },
    { id: 'lastEmployeeSyncAt', header: t('columns.lastEmployeeSync'), enableSorting: false, cell: ({ row }) => <span className="text-xs tnum" title={row.original.lastEmployeeSyncAt ?? ''}>{fmtRelative(row.original.lastEmployeeSyncAt)}</span> },
    { id: 'employees', header: t('columns.employees'), enableSorting: false, cell: ({ row }) => <span className="tnum">{fmtNumber(row.original.employeeCount ?? 0)}</span>, size: 90 },
    { id: 'provider', header: t('columns.provider'), cell: ({ row }) => { const p = providerNames.get(row.original.providerKey); return <div className="flex flex-wrap items-center gap-1"><span className="text-xs">{row.original.providerName ?? p?.name ?? row.original.providerKey}</span>{p ? <ProviderStatusBadge status={p.status} /> : null}</div>; } },
    { id: 'tags', header: t('fields.tags'), enableSorting: false, cell: ({ row }) => <TagChips tags={row.original.tags} /> },
  ], [t, tc, providerNames]);

  const runBulk = () => {
    if (!bulk) return;
    const done = (r: SyncJobAcceptedDto) => { toastJobAccepted(r, navigate); setBulk(null); setSelection({}); };
    const opts = { onError: toastError };
    if (bulk.kind === 'sync-attendance') sync.syncAttendance.mutate({ deviceIds: bulk.ids, all: false, fullResync: false }, { ...opts, onSuccess: done });
    if (bulk.kind === 'sync-employees') sync.syncEmployees.mutate({ deviceIds: bulk.ids, all: false, removeStale: false }, { ...opts, onSuccess: done });
    if (bulk.kind === 'health-check') sync.healthCheck.mutate({ deviceIds: bulk.ids, all: false }, { ...opts, onSuccess: done });
    if (bulk.kind === 'assign-group' && groupId) groupMut.addMembers.mutate({ id: groupId, deviceIds: bulk.ids }, { ...opts, onSuccess: () => { setBulk(null); setSelection({}); } });
  };
  const bulkPending = sync.syncAttendance.isPending || sync.syncEmployees.isPending || sync.healthCheck.isPending || groupMut.addMembers.isPending;

  const toolbar = (
    <>
      <SearchBox value={filters['search']} onChange={(v) => table.setFilter('search', v)} placeholder={t('list.searchPlaceholder')} />
      <Combobox value={filters['branchId'] ?? null} onChange={(v) => table.setFilter('branchId', v ?? undefined)} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-44" />
      <Select value={filters['status'] ?? ALL} onValueChange={(v) => table.setFilter('status', v === ALL ? undefined : v)}>
        <SelectTrigger className="h-8 w-36" aria-label={tc('common.status')}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value={ALL}>{t('list.allStatuses')}</SelectItem>{DEVICE_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`deviceStatus.${s}`)}</SelectItem>)}</SelectContent>
      </Select>
      <Select value={filters['connectionStatus'] ?? ALL} onValueChange={(v) => table.setFilter('connectionStatus', v === ALL ? undefined : v)}>
        <SelectTrigger className="h-8 w-40" aria-label={t('columns.connection')}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value={ALL}>{t('list.allConnections')}</SelectItem>{CONNECTION_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`connection.${s}`)}</SelectItem>)}</SelectContent>
      </Select>
      <Select value={filters['providerKey'] ?? ALL} onValueChange={(v) => table.setFilter('providerKey', v === ALL ? undefined : v)}>
        <SelectTrigger className="h-8 w-44" aria-label={t('columns.provider')}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value={ALL}>{t('list.allProviders')}</SelectItem>{(providers.data ?? []).map((p) => <SelectItem key={p.key} value={p.key}>{p.name}</SelectItem>)}</SelectContent>
      </Select>
      <Combobox value={filters['groupId'] ?? null} onChange={(v) => table.setFilter('groupId', v ?? undefined)} options={groups.options} loading={groups.isLoading} clearable placeholder={t('groups.group')} className="h-8 w-40" />
      <SearchBox id="tag-filter" value={filters['tag']} onChange={(v) => table.setFilter('tag', v)} placeholder={t('list.tagPlaceholder')} className="relative w-36" />
      {hasFilters ? <Button variant="ghost" size="sm" onClick={table.clearFilters}><X /> {tc('common.clearFilters')}</Button> : null}
    </>
  );

  const isTrulyEmpty = q.data?.meta.total === 0 && !hasFilters;

  return (
    <div className="page-container space-y-4">
      <PageHeader title={t('title')} description={q.data ? t('list.subtitle', { count: q.data.meta.total }) : undefined} actions={
        <>
          <Button variant="outline" size="sm" onClick={() => navigate('/devices/groups')}><FolderKanban /> {t('groups.title')}</Button>
          {can('device.create') ? <Button size="sm" onClick={() => navigate('/devices/new')}><Plus /> {t('list.register')}</Button> : null}
        </>
      } />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={t('summary.online')} value={fmtNumber(counts.online)} icon={Activity} tone="success" loading={summary.isLoading} onClick={() => table.setFilter('connectionStatus', 'online')} />
        <StatCard label={t('summary.offline')} value={fmtNumber(counts.offline)} icon={WifiOff} tone={counts.offline > 0 ? 'danger' : 'default'} loading={summary.isLoading} onClick={() => table.setFilter('connectionStatus', 'offline')} />
        <StatCard label={t('summary.degraded')} value={fmtNumber(counts.degraded)} icon={AlertTriangle} tone={counts.degraded > 0 ? 'warning' : 'default'} loading={summary.isLoading} onClick={() => table.setFilter('connectionStatus', 'degraded')} />
        <StatCard label={t('summary.unknown')} value={fmtNumber(counts.unknown)} icon={CircleHelp} hint={counts.stale > 0 ? t('summary.staleHeartbeats', { count: counts.stale }) : undefined} loading={summary.isLoading} onClick={() => table.setFilter('connectionStatus', 'unknown')} />
      </div>
      {can('device.create') ? <PendingDevicesPanel /> : null}
      {isTrulyEmpty ? (
        <EmptyState icon={Cpu} title={t('list.empty')} description={t('list.emptyHint')} action={can('device.create') ? <Button onClick={() => navigate('/devices/new')}><Plus /> {t('list.register')}</Button> : undefined} />
      ) : (
        <DataTable
          columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
          onPageChange={table.setPage} onPageSizeChange={table.setPageSize} sort={table.state.sort} order={table.state.order} onSort={table.toggleSort}
          isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="devices"
          getRowId={(d) => d.id} selection={can('device.sync') || can('device.manage') ? selection : undefined} onSelectionChange={can('device.sync') || can('device.manage') ? setSelection : undefined}
          onRowClick={(d) => navigate(`/devices/${d.id}`)} toolbar={toolbar}
          bulkActions={(ids) => (
            <>
              {can('device.sync') ? <>
                <Button size="sm" variant="outline" onClick={() => setBulk({ kind: 'sync-attendance', ids })}><RefreshCw /> {t('actions.syncAttendance')}</Button>
                <Button size="sm" variant="outline" onClick={() => setBulk({ kind: 'sync-employees', ids })}><Users /> {t('actions.syncEmployees')}</Button>
                <Button size="sm" variant="outline" onClick={() => setBulk({ kind: 'health-check', ids })}><HeartPulse /> {t('actions.healthCheck')}</Button>
              </> : null}
              {can('device.manage') ? <Button size="sm" variant="outline" onClick={() => setBulk({ kind: 'assign-group', ids })}><FolderKanban /> {t('actions.assignGroup')}</Button> : null}
              <Button size="sm" variant="ghost" onClick={() => setSelection({})}><X /> {t('list.clearSelection')}</Button>
            </>
          )}
          renderCard={(d) => (
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1"><p className="truncate font-medium">{d.name}</p><p className="truncate text-xs text-muted-foreground">{d.code} · {d.branchName ?? '—'}</p></div>
              <ConnectionBadge status={d.connectionStatus} lastHeartbeatAt={d.lastHeartbeatAt} showRelative={false} />
            </div>
          )}
        />
      )}
      {bulk && bulk.kind !== 'assign-group' ? (
        <ConfirmDialog open onOpenChange={(o) => !o && setBulk(null)} title={t(`bulk.${bulk.kind}.title`, { count: bulk.ids.length })} description={t(`bulk.${bulk.kind}.hint`)} confirmLabel={t('bulk.queue')} loading={bulkPending} onConfirm={runBulk} />
      ) : null}
      {bulk && bulk.kind === 'assign-group' ? (
        <Dialog open onOpenChange={(o) => !o && setBulk(null)}>
          <DialogContent size="sm">
            <DialogHeader><DialogTitle>{t('bulk.assign-group.title', { count: bulk.ids.length })}</DialogTitle></DialogHeader>
            <FormField label={t('groups.group')} htmlFor="bulk-group" required hint={t('bulk.assign-group.hint')}>
              <Combobox id="bulk-group" value={groupId} onChange={setGroupId} options={groups.options} loading={groups.isLoading} placeholder={t('groups.select')} emptyText={t('groups.none')} />
            </FormField>
            <DialogFooter>
              <Button variant="outline" onClick={() => setBulk(null)}>{tc('common.cancel')}</Button>
              <Button disabled={!groupId} loading={bulkPending} onClick={runBulk}>{t('bulk.assign-group.apply')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
