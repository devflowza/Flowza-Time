import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { Download, Eye } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Badge, Button } from '@/components/ui';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useOrgId, useOrgTimezone } from '@/features/me/use-me';
import { JobStatusBadge } from '@/features/attendance/components/badges';
import '@/features/reports/schedules-i18n';
import { fetchReportFile, openSignedUrl, useMyReports, type ReportDto } from '@/features/reports/api';
import { ReportViewerDialog, type ViewableReport } from '@/features/reports/components/report-viewer';

function periodOf(p: ReportDto['parameters']): string {
  if (p.month) return fmtDate(`${p.month}-01`, 'MMMM yyyy');
  if (p.from) return p.to && p.to !== p.from ? `${fmtDate(p.from)} → ${fmtDate(p.to)}` : fmtDate(p.from);
  return '—';
}

/**
 * /my/reports — the attendance reports about the signed-in employee that HR or a manager sent them ("Send to…" or a schedule,
 * each employee receiving the report about themselves). View in place or download; the API admits only copies about the caller.
 * `?view=<id>` is the link of the "report shared with you" notification (in-app and e-mail).
 */
export default function MyReportsPage() {
  const { t } = useTranslation('reports');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const orgId = useOrgId();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const q = useMyReports({ page, pageSize });
  // ?view=<id> keeps the viewer open while it is in the URL; closing the viewer removes it
  const [params, setParams] = useSearchParams();
  const urlView = params.get('view');
  const [picked, setViewing] = useState<ViewableReport | null>(null);
  const viewing = picked ?? (urlView ? { id: urlView } : null);
  const closeViewer = () => { setViewing(null); if (urlView) setParams((prev) => { const n = new URLSearchParams(prev); n.delete('view'); return n; }, { replace: true }); };
  const download = async (r: ReportDto) => {
    try {
      const res = await fetchReportFile(orgId, { id: r.id, disposition: 'attachment' });
      openSignedUrl(res.url, res.fileName);
      toast.success(t('list.downloadStarted'), { description: t('list.linkExpires', { seconds: res.expiresInSeconds }) });
    } catch (e) { toastError(e); }
  };
  const ready = (r: ReportDto) => r.status === 'COMPLETED' && !(r.expiresAt && Date.parse(r.expiresAt) < (q.dataUpdatedAt || 0));
  const columns = useMemo<ColumnDef<ReportDto, unknown>[]>(() => [
    { id: 'type', header: t('list.type'), cell: ({ row }) => <p className="font-medium">{t(`types.${row.original.reportType}.name`, { defaultValue: row.original.reportType })}</p> },
    { id: 'period', header: t('mine.period'), cell: ({ row }) => <span className="text-sm tnum">{periodOf(row.original.parameters)}</span> },
    { id: 'format', header: t('request.format'), cell: ({ row }) => <Badge variant="outline" className="uppercase">{row.original.format}</Badge> },
    { id: 'status', header: tc('common.status'), cell: ({ row }) => <JobStatusBadge status={row.original.status === 'COMPLETED' && !ready(row.original) ? 'EXPIRED' : row.original.status} /> },
    { id: 'received', header: t('mine.received'), cell: ({ row }) => <span className="text-xs text-muted-foreground tnum">{fmtDateTime(row.original.createdAt, tz)}</span> },
    { id: 'actions', header: '', cell: ({ row }) => (ready(row.original) ? (
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="outline" onClick={() => setViewing(row.original)}><Eye /> {t('list.view')}</Button>
        <Button size="sm" onClick={() => void download(row.original)}><Download /> {t('list.download')}</Button>
      </div>
    ) : null) },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, tc, tz, q.dataUpdatedAt]);
  return (
    <div className="page-container space-y-5">
      <PageHeader title={t('mine.title')} description={t('mine.subtitle')} />
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
        isLoading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} emptyTitle={t('mine.empty')} emptyDescription={t('mine.emptyHint')}
        renderCard={(r) => (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{t(`types.${r.reportType}.name`, { defaultValue: r.reportType })}</span><JobStatusBadge status={r.status} /></div>
            <p className="text-xs text-muted-foreground tnum">{periodOf(r.parameters)} · {fmtDateTime(r.createdAt, tz)}</p>
            {ready(r) ? <div className="flex gap-1"><Button size="sm" variant="outline" onClick={() => setViewing(r)}><Eye /> {t('list.view')}</Button><Button size="sm" onClick={() => void download(r)}><Download /> {t('list.download')}</Button></div> : null}
          </div>
        )}
      />
      <ReportViewerDialog report={viewing} onClose={closeViewer} />
    </div>
  );
}
