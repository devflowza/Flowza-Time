import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { GitCompare, Wrench, X } from 'lucide-react';
import type { DeviceReconciliationDto, SyncItemStatus } from '@flowza/contracts';
import { SYNC_ITEM_STATUSES } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, EmptyState, ErrorState, Skeleton, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { useServerTable } from '@/hooks/use-server-table';
import { fmtDateTime, fmtNumber, fmtRelative } from '@/lib/format';
import { toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { useDeviceOptions } from '@/features/devices/api';
import { useReconciliation, useSyncMutations } from '../api';
import { SyncItemStatusBadge } from '../components/status-badges';
import { toastJobQueued } from '../job-toast';

type Confirm = { kind: 'run-all' } | { kind: 'repair-all' } | { kind: 'repair'; device: DeviceReconciliationDto } | null;
const COUNTERS = [
  { key: 'missingOnDeviceCount', label: 'cloudOnly', tone: 'warning' },
  { key: 'deviceOnlyCount', label: 'deviceOnly', tone: 'warning' },
  { key: 'differingCount', label: 'differing', tone: 'info' },
  { key: 'staleCount', label: 'stale', tone: 'neutral' },
  { key: 'unmatchedRaw', label: 'unmatched', tone: 'danger' },
  { key: 'duplicateTransactions', label: 'duplicates', tone: 'neutral' },
] as const;

const num = (v: unknown): number => (typeof v === 'number' ? v : Array.isArray(v) ? v.length : 0);
const isItemStatus = (s: string | null): s is SyncItemStatus => !!s && (SYNC_ITEM_STATUSES as readonly string[]).includes(s);

function DeviceCard({ row, tz, onRun, onRepair, busy }: { row: DeviceReconciliationDto; tz: string; onRun: () => void; onRepair: () => void; busy: boolean }) {
  const { t } = useTranslation('sync');
  const can = useCan();
  const s = row.summary ?? {};
  const issues = COUNTERS.reduce((acc, c) => acc + num(s[c.key]), 0);
  const branches = useBranchOptions();
  return (
    <Card className={cn(row.summary && issues === 0 && 'border-emerald-300/60')}>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <CardTitle className="truncate"><Link to={`/devices/${row.deviceId}`} className="hover:underline">{row.deviceName}</Link> <span className="font-mono text-xs font-normal text-muted-foreground" dir="ltr">{row.deviceCode}</span></CardTitle>
          <CardDescription>{branches.byId.get(row.branchId)?.name ?? '—'} · {row.finishedAt ? <span title={fmtDateTime(row.finishedAt, tz)} className="tnum">{t('reconciliation.lastRun', { when: fmtRelative(row.finishedAt) })}</span> : t('reconciliation.neverRun')}</CardDescription>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {isItemStatus(row.status) ? <SyncItemStatusBadge status={row.status} /> : null}
          {row.summary ? (issues === 0 ? <Badge variant="success">{t('reconciliation.inSync')}</Badge> : <Badge variant="warning" className="tnum">{t('reconciliation.issues', { count: issues })}</Badge>) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {COUNTERS.map((c) => {
            const v = num(s[c.key]);
            return (
              <Tooltip key={c.key}>
                <TooltipTrigger asChild>
                  <div className={cn('rounded-md border p-2 text-center', v > 0 && c.tone === 'danger' && 'border-red-300/60 bg-red-50/50 dark:bg-red-950/20', v > 0 && c.tone === 'warning' && 'border-amber-300/60 bg-amber-50/50 dark:bg-amber-950/20')} tabIndex={0}>
                    <dd className="text-lg font-semibold leading-tight tnum">{row.summary ? fmtNumber(v) : '—'}</dd>
                    <dt className="truncate text-[11px] text-muted-foreground">{t(`reconciliation.${c.label}`)}</dt>
                  </div>
                </TooltipTrigger>
                <TooltipContent>{t(`reconciliation.${c.label}Hint`)}</TooltipContent>
              </Tooltip>
            );
          })}
        </dl>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {row.summary ? <span className="tnum">{t('reconciliation.expected', { expected: fmtNumber(num(s['expected'])), onDevice: fmtNumber(num(s['onDevice'])) })}</span> : null}
          {row.syncJobId ? <Link to={`/sync/${row.syncJobId}`} className="text-primary hover:underline">{t('reconciliation.viewJob')}</Link> : null}
          {typeof s['repairJobId'] === 'string' ? <Link to={`/sync/${s['repairJobId']}`} className="text-primary hover:underline">{t('reconciliation.repairJob')}</Link> : null}
          {can('device.sync') ? (
            <span className="ms-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={onRun} loading={busy}><GitCompare /> {t('actions.runReconciliation')}</Button>
              <Button size="sm" variant="outline" onClick={onRepair} disabled={busy}><Wrench /> {t('actions.repair')}</Button>
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export default function ReconciliationPage() {
  const { t } = useTranslation('sync');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const can = useCan();
  const tz = useOrgTimezone();
  const table = useServerTable();
  const filters = table.state.filters;
  const q = useReconciliation({ branchId: filters['branchId'], deviceId: filters['deviceId'] });
  const branches = useBranchOptions();
  const devices = useDeviceOptions(filters['branchId']);
  const { reconcile } = useSyncMutations();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busyDevice, setBusyDevice] = useState<string | null>(null);
  const hasFilters = Object.keys(filters).length > 0;
  const rows = q.data ?? [];

  const run = (input: { deviceIds?: string[]; all?: boolean; branchId?: string; repair: boolean }, deviceId?: string) => {
    setBusyDevice(deviceId ?? null);
    reconcile.mutate({ all: false, ...input }, { onSuccess: (r) => { toastJobQueued(r.jobId, navigate, t('dialog.queued', { count: r.itemsTotal, devices: r.deviceCount })); setConfirm(null); }, onError: toastError, onSettled: () => setBusyDevice(null) });
  };
  const scopeAll = filters['branchId'] ? { branchId: filters['branchId'] } : { all: true };
  const onConfirm = () => {
    if (!confirm) return;
    if (confirm.kind === 'run-all') run({ ...scopeAll, repair: false });
    if (confirm.kind === 'repair-all') run({ ...scopeAll, repair: true });
    if (confirm.kind === 'repair') run({ deviceIds: [confirm.device.deviceId], repair: true }, confirm.device.deviceId);
  };

  return (
    <div className="page-container">
      <PageHeader title={t('reconciliation.title')} description={t('reconciliation.subtitle')} actions={can('device.sync') && rows.length > 0 ? (
        <>
          <Button variant="outline" size="sm" onClick={() => setConfirm({ kind: 'repair-all' })}><Wrench /> {t('actions.repairAll')}</Button>
          <Button size="sm" onClick={() => setConfirm({ kind: 'run-all' })}><GitCompare /> {t('actions.runAll')}</Button>
        </>
      ) : undefined} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Combobox value={filters['branchId'] ?? null} onChange={(v) => table.update({ filters: { branchId: v ?? '', deviceId: '' } })} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-44" />
        <Combobox value={filters['deviceId'] ?? null} onChange={(v) => table.setFilter('deviceId', v ?? undefined)} options={devices.options} loading={devices.isLoading} clearable placeholder={t('list.device')} className="h-8 w-44" />
        {hasFilters ? <Button variant="ghost" size="sm" onClick={table.clearFilters}><X /> {tc('common.clearFilters')}</Button> : null}
      </div>
      {q.isLoading ? <div className="grid gap-4 xl:grid-cols-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-44" />)}</div>
        : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        : rows.length === 0 ? <EmptyState icon={GitCompare} title={hasFilters ? tc('common.noResults') : t('reconciliation.empty')} description={hasFilters ? tc('common.noResultsHint') : t('reconciliation.emptyHint')} />
        : <div className="grid gap-4 xl:grid-cols-2">{rows.map((r) => <DeviceCard key={r.deviceId} row={r} tz={tz} busy={busyDevice === r.deviceId} onRun={() => run({ deviceIds: [r.deviceId], repair: false }, r.deviceId)} onRepair={() => setConfirm({ kind: 'repair', device: r })} />)}</div>}
      <ConfirmDialog open={confirm?.kind === 'run-all'} onOpenChange={(o) => !o && setConfirm(null)} title={t('reconciliation.runAllTitle')} description={t('reconciliation.runAllHint')} confirmLabel={t('actions.runAll')} loading={reconcile.isPending} onConfirm={onConfirm} />
      <ConfirmDialog open={confirm?.kind === 'repair-all'} onOpenChange={(o) => !o && setConfirm(null)} title={t('reconciliation.repairAllTitle')} description={t('reconciliation.repairAllHint')} confirmLabel={t('actions.repairAll')} destructive loading={reconcile.isPending} onConfirm={onConfirm} />
      <ConfirmDialog open={confirm?.kind === 'repair'} onOpenChange={(o) => !o && setConfirm(null)} title={confirm?.kind === 'repair' ? t('reconciliation.repairTitle', { name: confirm.device.deviceName }) : ''} description={t('reconciliation.repairHint')} confirmLabel={t('actions.repair')} destructive loading={reconcile.isPending} onConfirm={onConfirm} />
    </div>
  );
}
