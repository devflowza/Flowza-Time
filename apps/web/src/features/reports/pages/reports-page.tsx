import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { Ban, Download, RefreshCw, X } from 'lucide-react';
import { REPORT_STATUSES, REPORT_TYPES } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Badge, Button, ConfirmDialog, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { useServerTable } from '@/hooks/use-server-table';
import { fmtDate, fmtDateTime, fmtNumber } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useOrgTimezone } from '@/features/me/use-me';
import { JobStatusBadge } from '@/features/attendance/components/badges';
import { openSignedUrl, useReportMutations, useReports, type ReportDto } from '../api';
import { ReportRequestPanel } from '../components/report-request-panel';

const ALL = '__all__';
const fmtBytes = (n: number | null) => (n === null ? '—' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);

function paramsSummary(p: ReportDto['parameters'], t: (k: string, o?: Record<string, unknown>) => string): string {
  const parts: string[] = [];
  if (p.month) parts.push(fmtDate(`${p.month}-01`, 'MMM yyyy'));
  else if (p.from) parts.push(p.to && p.to !== p.from ? `${fmtDate(p.from)} → ${fmtDate(p.to)}` : fmtDate(p.from));
  if (p.employeeIds?.length) parts.push(t('list.nEmployees', { count: p.employeeIds.length }));
  if (p.branchId) parts.push(t('list.oneBranch'));
  return parts.join(' · ') || '—';
}

/** /reports — request panel + "My reports" (auto-refresh while queued/running; download via signed URL). */
export default function ReportsPage() {
  const { t } = useTranslation('reports');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const table = useServerTable();
  const f = table.state.filters;
  const query = useMemo(() => ({ page: table.state.page, pageSize: table.state.pageSize, status: f['status'], reportType: f['reportType'] }), [table.state.page, table.state.pageSize, f]);
  const q = useReports(query);
  const { cancel, download } = useReportMutations();
  const [cancelling, setCancelling] = useState<ReportDto | null>(null);
  const hasFilters = !!f['status'] || !!f['reportType'];
  const now = q.dataUpdatedAt || 0; // pure: re-evaluated on every refetch (the list polls while reports run)
  const isExpired = (r: ReportDto) => r.status === 'EXPIRED' || (!!r.expiresAt && new Date(r.expiresAt).getTime() < now);
  const doDownload = (r: ReportDto) => download.mutate(r.id, { onSuccess: (res) => { openSignedUrl(res.url, res.fileName); toast.success(t('list.downloadStarted'), { description: t('list.linkExpires', { seconds: res.expiresInSeconds }) }); }, onError: toastError });

  const columns = useMemo<ColumnDef<ReportDto, unknown>[]>(() => [
    { id: 'type', header: t('list.type'), enableSorting: false, cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{t(`types.${row.original.reportType}.name`, { defaultValue: row.original.reportType })}</p><p className="text-xs text-muted-foreground tnum">{paramsSummary(row.original.parameters, t as unknown as (k: string, o?: Record<string, unknown>) => string)}</p></div> },
    { id: 'format', header: t('request.format'), enableSorting: false, cell: ({ row }) => <Badge variant="outline" className="uppercase">{row.original.format}</Badge> },
    { id: 'status', header: tc('common.status'), enableSorting: false, cell: ({ row }) => <div className="flex flex-col gap-0.5">{isExpired(row.original) && row.original.status === 'COMPLETED' ? <JobStatusBadge status="EXPIRED" /> : <JobStatusBadge status={row.original.status} />}{row.original.error ? <span className="max-w-[220px] truncate text-[11px] text-destructive" title={row.original.error}>{row.original.error}</span> : null}</div> },
    { id: 'rows', header: t('list.rows'), enableSorting: false, cell: ({ row }) => <span className="text-xs tnum">{row.original.rowCount === null ? '—' : fmtNumber(row.original.rowCount)}{row.original.fileSizeBytes !== null ? <span className="text-muted-foreground"> · {fmtBytes(row.original.fileSizeBytes)}</span> : null}</span> },
    { id: 'requested', header: t('list.requested'), enableSorting: false, cell: ({ row }) => <div className="text-xs"><p>{row.original.requestedByName ?? '—'}</p><p className="text-muted-foreground tnum">{fmtDateTime(row.original.createdAt, tz)}</p></div> },
    { id: 'expires', header: t('list.expires'), enableSorting: false, cell: ({ row }) => <span className="text-xs text-muted-foreground tnum">{row.original.expiresAt ? fmtDateTime(row.original.expiresAt, tz) : '—'}</span> },
    { id: 'actions', header: '', enableSorting: false, cell: ({ row }) => {
      const r = row.original;
      return (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {r.status === 'COMPLETED' && !isExpired(r) ? <Button size="sm" onClick={() => doDownload(r)} loading={download.isPending && download.variables === r.id}><Download /> {tc('common.download')}</Button> : null}
          {r.status === 'QUEUED' ? <Button size="sm" variant="ghost" onClick={() => setCancelling(r)}><Ban /> {t('list.cancel')}</Button> : null}
          {isExpired(r) && r.status !== 'FAILED' ? <span className="text-xs text-muted-foreground">{t('list.expiredHint')}</span> : null}
        </div>
      );
    } },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, tc, tz, download.isPending, download.variables]);

  return (
    <div className="page-container space-y-5">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <ReportRequestPanel onQueued={() => table.update({ filters: { status: '', reportType: '' } })} />
      <section className="space-y-3">
        <div className="flex items-center justify-between"><h2 className="text-base font-semibold">{t('list.title')}</h2><Button variant="ghost" size="sm" onClick={() => void q.refetch()} loading={q.isFetching}><RefreshCw /> {tc('common.refresh')}</Button></div>
        <DataTable
          columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
          onPageChange={table.setPage} onPageSizeChange={table.setPageSize} isLoading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} storageKey="reports"
          emptyTitle={t('list.empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('list.emptyHint')}
          toolbar={
            <>
              <Select value={f['status'] ?? ALL} onValueChange={(v) => table.setFilter('status', v === ALL ? undefined : v)}>
                <SelectTrigger className="h-8 w-36" aria-label={tc('common.status')}><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value={ALL}>{t('list.allStatuses')}</SelectItem>{REPORT_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`status.${s}`)}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={f['reportType'] ?? ALL} onValueChange={(v) => table.setFilter('reportType', v === ALL ? undefined : v)}>
                <SelectTrigger className="h-8 w-48" aria-label={t('list.type')}><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value={ALL}>{t('list.allTypes')}</SelectItem>{REPORT_TYPES.map((s) => <SelectItem key={s} value={s}>{t(`types.${s}.name`)}</SelectItem>)}</SelectContent>
              </Select>
              {hasFilters ? <Button variant="ghost" size="sm" onClick={table.clearFilters}><X /> {tc('common.clearFilters')}</Button> : null}
            </>
          }
          renderCard={(r) => <div className="space-y-1"><div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{t(`types.${r.reportType}.name`, { defaultValue: r.reportType })}</span><JobStatusBadge status={isExpired(r) && r.status === 'COMPLETED' ? 'EXPIRED' : r.status} /></div><p className="text-xs text-muted-foreground tnum">{fmtDateTime(r.createdAt, tz)}</p>{r.status === 'COMPLETED' && !isExpired(r) ? <Button size="sm" onClick={(e) => { e.stopPropagation(); doDownload(r); }}><Download /> {tc('common.download')}</Button> : null}</div>}
        />
      </section>
      <ConfirmDialog open={!!cancelling} onOpenChange={(o) => !o && setCancelling(null)} title={t('list.cancelTitle')} description={t('list.cancelHint')} confirmLabel={t('list.cancel')} destructive loading={cancel.isPending}
        onConfirm={() => { if (!cancelling) return; cancel.mutate(cancelling.id, { onSuccess: () => { toast.success(t('list.cancelled')); setCancelling(null); }, onError: toastError }); }} />
    </div>
  );
}
