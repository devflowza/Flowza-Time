import { useCallback, useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowLeft, Ban, CheckCircle2, Clock, Database, ListChecks, Radio, RotateCw, WifiOff, XCircle } from 'lucide-react';
import { SYNC_ITEM_STATUSES, type SyncJobItemDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, ConfirmDialog, ErrorState, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, StatCard } from '@/components/ui';
import { fmtDateTime, fmtNumber, fmtRelative } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgId, useOrgTimezone } from '@/features/me/use-me';
import { isActiveJob, useSyncJob, useSyncJobItems, useSyncMutations, useSyncRealtime } from '../api';
import { fmtDuration } from '../duration';
import { JobProgress, JobTypeLabel, SyncItemStatusBadge, SyncStatusBadge, TriggerBadge } from '../components/status-badges';
import { toastJobQueued } from '../job-toast';

const ALL = '__all__';

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-0.5 truncate text-sm">{children}</dd></div>;
}

export default function SyncJobPage() {
  const { t } = useTranslation('sync');
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const can = useCan();
  const tz = useOrgTimezone();
  const orgId = useOrgId();
  const qc = useQueryClient();
  const job = useSyncJob(id);
  const active = !!job.data && isActiveJob(job.data.status);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [status, setStatus] = useState<string>(ALL);
  const items = useSyncJobItems(id, useMemo(() => ({ page, pageSize, status: status === ALL ? undefined : status }), [page, pageSize, status]), active);
  const { cancel, retryFailed } = useSyncMutations();
  const [confirm, setConfirm] = useState<'cancel' | 'retry' | null>(null);
  // Realtime signals only shorten the wait: the job + its items are refetched through the API (polling stays the baseline).
  const refetch = useCallback(() => { void qc.invalidateQueries({ queryKey: qk.detail(orgId, 'sync-jobs', id) }); }, [qc, orgId, id]);
  useSyncRealtime(refetch, active);
  const j = job.data;
  const failed = j ? j.itemsFailed + j.itemsOffline : 0;

  const columns = useMemo<ColumnDef<SyncJobItemDto, unknown>[]>(() => [
    { id: 'device', header: t('itemColumns.device'), cell: ({ row }) => row.original.deviceId ? <Link to={`/devices/${row.original.deviceId}`} className="hover:underline" onClick={(e) => e.stopPropagation()}><span className="font-medium">{row.original.deviceName ?? row.original.deviceId.slice(0, 8)}</span>{row.original.deviceCode ? <span className="ms-1 font-mono text-xs text-muted-foreground" dir="ltr">{row.original.deviceCode}</span> : null}</Link> : <span className="text-muted-foreground">—</span> },
    { id: 'employee', header: t('itemColumns.employee'), cell: ({ row }) => row.original.employeeId ? <Link to={`/employees/${row.original.employeeId}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>{row.original.employeeName ?? row.original.employeeId.slice(0, 8)}{row.original.employeeNumber ? <span className="ms-1 font-mono text-xs text-muted-foreground" dir="ltr">{row.original.employeeNumber}</span> : null}</Link> : <span className="text-muted-foreground">—</span> },
    { id: 'operation', header: t('itemColumns.operation'), cell: ({ row }) => <JobTypeLabel type={row.original.operation} /> },
    { id: 'status', header: t('itemColumns.status'), cell: ({ row }) => <div className="space-y-0.5"><SyncItemStatusBadge status={row.original.status} />{row.original.status === 'RETRYING' && row.original.nextAttemptAt ? <p className="text-[11px] text-muted-foreground tnum">{t('detail.nextAttempt', { when: fmtRelative(row.original.nextAttemptAt) })}</p> : null}</div> },
    { id: 'attempts', header: t('itemColumns.attempts'), cell: ({ row }) => <span className="text-xs tnum">{t('detail.attempts', { attempts: row.original.attempts, max: row.original.maxAttempts })}</span>, size: 90 },
    { id: 'records', header: t('itemColumns.records'), cell: ({ row }) => <span className="tnum">{fmtNumber(row.original.recordsIngested)}</span>, size: 90 },
    { id: 'lastError', header: t('itemColumns.lastError'), cell: ({ row }) => row.original.lastError ? <span className="block max-w-[320px] truncate text-xs text-destructive" title={row.original.lastError}>{row.original.lastErrorCode ? <span className="font-mono">{row.original.lastErrorCode}: </span> : null}{row.original.lastError}</span> : <span className="text-muted-foreground">—</span> },
    { id: 'duration', header: t('itemColumns.duration'), cell: ({ row }) => <span className="text-xs tnum">{row.original.startedAt ? fmtDuration(row.original.startedAt, row.original.finishedAt) : '—'}</span>, size: 90 },
  ], [t]);

  const onConfirm = () => {
    if (confirm === 'cancel') cancel.mutate(id, { onSuccess: (r) => { toast.success(t('detail.cancelled', { count: r.cancelledItems })); setConfirm(null); }, onError: toastError });
    if (confirm === 'retry') retryFailed.mutate(id, { onSuccess: (r) => { toastJobQueued(r.jobId, navigate, t('detail.retryQueued')); setConfirm(null); }, onError: toastError });
  };

  return (
    <div className="page-container">
      {job.isLoading ? <div className="space-y-4"><Skeleton className="h-8 w-72" /><Skeleton className="h-24 w-full" /><Skeleton className="h-96 w-full" /></div>
        : job.isError || !j ? <ErrorState error={job.error} onRetry={() => void job.refetch()} /> : (
          <>
            <PageHeader
              breadcrumbs={<Link to="/sync" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="size-3 rtl:rotate-180" /> {t('title')}</Link>}
              title={t(`jobType.${j.jobType}`)}
              description={j.id}
              actions={can('device.sync') ? (
                <>
                  {!active && failed > 0 ? <Button size="sm" variant="outline" onClick={() => setConfirm('retry')}><RotateCw /> {t('actions.retryFailed')}</Button> : null}
                  {active ? <Button size="sm" variant="destructive" onClick={() => setConfirm('cancel')}><Ban /> {t('actions.cancel')}</Button> : null}
                </>
              ) : undefined}
            />
            <div className="mb-4 flex flex-wrap items-center gap-2"><SyncStatusBadge status={j.status} /><TriggerBadge trigger={j.trigger} /><JobTypeLabel type={j.jobType} /></div>
            <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <StatCard label={t('detail.total')} value={fmtNumber(j.itemsTotal)} icon={ListChecks} />
              <StatCard label={t('detail.success')} value={fmtNumber(j.itemsSuccess)} icon={CheckCircle2} tone="success" />
              <StatCard label={t('detail.failed')} value={fmtNumber(j.itemsFailed)} icon={XCircle} tone={j.itemsFailed > 0 ? 'danger' : 'default'} />
              <StatCard label={t('detail.offline')} value={fmtNumber(j.itemsOffline)} icon={WifiOff} tone={j.itemsOffline > 0 ? 'warning' : 'default'} />
              <StatCard label={t('detail.pending')} value={fmtNumber(j.itemsPending)} icon={Clock} tone={j.itemsPending > 0 ? 'info' : 'default'} />
              <StatCard label={t('detail.records')} value={fmtNumber(j.recordsIngested)} icon={Database} />
            </div>
            <div className="mb-4 grid gap-4 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <CardHeader className="flex-row items-center justify-between space-y-0"><CardTitle>{t('columns.progress')}</CardTitle>{active ? <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status"><Radio className="size-3.5 animate-pulse text-emerald-600" aria-hidden /> {t('detail.polling')}</span> : null}</CardHeader>
                <CardContent className="space-y-4">
                  <JobProgress job={j} />
                  {j.error ? <div role="alert" className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50/60 p-3 text-sm dark:border-red-900 dark:bg-red-950/30"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-600" aria-hidden /><div><p className="font-medium">{j.errorCode ?? t('detail.error')}</p><p className="text-muted-foreground">{j.error}</p></div></div> : null}
                  <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <Item label={t('detail.queued')}><span className="tnum">{fmtDateTime(j.queuedAt ?? j.createdAt, tz)}</span></Item>
                    <Item label={t('detail.started')}><span className="tnum">{fmtDateTime(j.startedAt, tz)}</span></Item>
                    <Item label={t('detail.finished')}><span className="tnum">{fmtDateTime(j.finishedAt, tz)}</span></Item>
                    <Item label={t('detail.duration')}><span className="tnum">{j.startedAt ? fmtDuration(j.startedAt, j.finishedAt) : '—'}</span></Item>
                    <Item label={t('detail.requestedBy')}>{j.requestedByName ?? (j.requestedBy ? <span className="font-mono text-xs" dir="ltr">{j.requestedBy}</span> : t('list.system'))}</Item>
                    <Item label={t('detail.correlation')}><span className="font-mono text-xs" dir="ltr">{j.correlationId}</span></Item>
                    {j.parentJobId ? <Item label={t('detail.parent')}><Link to={`/sync/${j.parentJobId}`} className="font-mono text-xs text-primary hover:underline" dir="ltr">{j.parentJobId.slice(0, 8)}</Link></Item> : null}
                    <Item label={t('columns.trigger')}><TriggerBadge trigger={j.trigger} /></Item>
                  </dl>
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>{t('detail.scope')}</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap gap-1 text-xs">
                    {Object.entries(j.scope).map(([k, v]) => <Badge key={k} variant="secondary" className="font-mono font-normal" dir="ltr">{k}={Array.isArray(v) ? `[${v.length}]` : typeof v === 'object' && v !== null ? '{…}' : String(v)}</Badge>)}
                    {Object.keys(j.scope).length === 0 ? <span className="text-muted-foreground">—</span> : null}
                  </div>
                  {j.summary && Object.keys(j.summary).length > 0 ? <details className="text-xs"><summary className="cursor-pointer text-primary">{t('detail.summary')}</summary><pre dir="ltr" className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-[11px] scrollbar-thin">{JSON.stringify(j.summary, null, 2)}</pre></details> : null}
                </CardContent>
              </Card>
            </div>
            <h2 className="mb-2 text-sm font-semibold">{t('detail.items')}</h2>
            <DataTable
              columns={columns} data={items.data?.data} total={items.data?.meta.total} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
              isLoading={items.isLoading || items.isFetching} error={items.error} onRetry={() => void items.refetch()} storageKey="sync-job-items"
              emptyTitle={t('detail.itemsEmpty')} emptyDescription={t('detail.itemsEmptyHint')}
              toolbar={
                <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
                  <SelectTrigger className="h-8 w-44" aria-label={t('itemColumns.status')}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value={ALL}>{t('detail.allStatuses')}</SelectItem>{SYNC_ITEM_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`itemStatus.${s}`)}</SelectItem>)}</SelectContent>
                </Select>
              }
              renderCard={(it) => (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2"><span className="font-medium">{it.deviceName ?? it.employeeName ?? '—'}</span><SyncItemStatusBadge status={it.status} /></div>
                  <p className="text-xs text-muted-foreground"><JobTypeLabel type={it.operation} /> · {t('detail.attempts', { attempts: it.attempts, max: it.maxAttempts })}</p>
                  {it.lastError ? <p className="truncate text-xs text-destructive">{it.lastError}</p> : null}
                </div>
              )}
            />
            <ConfirmDialog open={confirm === 'cancel'} onOpenChange={(o) => !o && setConfirm(null)} title={t('detail.cancelTitle')} description={t('detail.cancelHint')} confirmLabel={t('actions.cancel')} destructive loading={cancel.isPending} onConfirm={onConfirm} />
            <ConfirmDialog open={confirm === 'retry'} onOpenChange={(o) => !o && setConfirm(null)} title={t('detail.retryTitle')} description={t('detail.retryHint')} confirmLabel={t('actions.retryFailed')} loading={retryFailed.isPending} onConfirm={onConfirm} />
          </>
        )}
    </div>
  );
}
