import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Download, ExternalLink, FileSpreadsheet } from 'lucide-react';
import type { ReportFormat } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { useOrgId } from '@/features/me/use-me';
import { fetchReportFile, fileFacts, openSignedUrl } from '../api';
import { parseCsv } from '../csv-preview';

/** A report to view; a notification link knows only the id — the type and format are then read off the signed file's name. */
export interface ViewableReport { id: string; reportType?: string; format?: ReportFormat }


const PREVIEW_ROWS = 500;

/**
 * The report viewer: the file of a completed report shown in place — a PDF in the browser's own viewer, a CSV as a table (first
 * rows), an Excel file only as a download. The file is fetched through the reader's session every time it opens (a 5-minute signed
 * URL, access re-checked and audited by the API), so the same dialog serves the Reports page, the delivery log and the employee
 * portal's "My reports" (where the API admits only copies about the reader themselves).
 */
export function ReportViewerDialog({ report, onClose }: { report: ViewableReport | null; onClose: () => void }) {
  const { t } = useTranslation('reports');
  const orgId = useOrgId();
  const open = !!report;
  const file = useQuery({
    queryKey: ['report-file', orgId, report?.id, 'inline'],
    queryFn: () => fetchReportFile(orgId, { id: report!.id, disposition: 'inline' }),
    enabled: open && report?.format !== 'xlsx',
    staleTime: 60_000, gcTime: 0, retry: false,
  });
  const facts = fileFacts(file.data?.fileName);
  const format = report?.format ?? facts.format;
  const csv = useQuery({
    queryKey: ['report-file-csv', orgId, report?.id, file.data?.url],
    queryFn: async () => {
      const res = await fetch(file.data!.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseCsv(await res.text(), PREVIEW_ROWS);
    },
    enabled: open && format === 'csv' && !!file.data?.url,
    staleTime: 60_000, gcTime: 0, retry: false,
  });
  const download = async () => {
    if (!report) return;
    try {
      const res = await fetchReportFile(orgId, { id: report.id, disposition: 'attachment' });
      openSignedUrl(res.url, res.fileName);
      toast.success(t('list.downloadStarted'), { description: t('list.linkExpires', { seconds: res.expiresInSeconds }) });
    } catch (e) { toastError(e); }
  };
  const reportType = report?.reportType ?? facts.reportType;
  const name = reportType ? t(`types.${reportType}.name`, { defaultValue: reportType }) : t('viewer.title');

  let body: React.ReactNode;
  if (!report) body = null;
  else if (format === 'xlsx') body = <EmptyState icon={FileSpreadsheet} title={t('viewer.noPreview')} action={<Button onClick={() => void download()}><Download /> {t('viewer.download')}</Button>} />;
  else if (file.isError) body = <ErrorState error={file.error} onRetry={() => void file.refetch()} />;
  else if (!file.data) body = <div className="space-y-2" aria-label={t('viewer.loading')}><Skeleton className="h-6 w-1/3" /><Skeleton className="h-[60vh] w-full" /></div>;
  else if (format === 'pdf') body = <iframe title={t('viewer.frameTitle')} src={file.data.url} className="h-[70vh] w-full rounded-md border bg-white" data-testid="report-frame" />;
  else if (csv.isError) body = <ErrorState error={csv.error} onRetry={() => void csv.refetch()} />;
  else if (!csv.data) body = <Skeleton className="h-[60vh] w-full" />;
  else if (csv.data.rows.length === 0) body = <EmptyState title={t('viewer.empty')} />;
  else {
    const [head, ...rest] = csv.data.rows;
    body = (
      <div className="space-y-2">
        <div className="max-h-[65vh] overflow-auto rounded-md border" data-testid="report-csv">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted"><tr>{head!.map((h, i) => <th key={i} className="whitespace-nowrap px-2 py-1.5 text-start font-semibold">{h}</th>)}</tr></thead>
            <tbody>{rest.map((r, i) => <tr key={i} className="border-t">{head!.map((_, j) => <td key={j} className="whitespace-nowrap px-2 py-1 tnum">{r[j] ?? ''}</td>)}</tr>)}</tbody>
          </table>
        </div>
        {csv.data.truncated ? <p className="text-xs text-muted-foreground">{t('viewer.truncated', { count: PREVIEW_ROWS })}</p> : null}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent size="xl" className="max-w-[min(96vw,72rem)]">
        <DialogHeader>
          <DialogTitle>{name}</DialogTitle>
          <DialogDescription>{t('viewer.title')}{format ? <> · <span className="uppercase">{format}</span></> : null}</DialogDescription>
        </DialogHeader>
        {body}
        <DialogFooter className="gap-2">
          {file.data && format !== 'xlsx' ? <Button variant="outline" asChild><a href={file.data.url} target="_blank" rel="noopener noreferrer"><ExternalLink /> {t('viewer.openInTab')}</a></Button> : null}
          <Button onClick={() => void download()}><Download /> {t('viewer.download')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
