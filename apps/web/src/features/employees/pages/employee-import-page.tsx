import { useMemo, useRef, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, CheckCircle2, Download, FileUp, ListChecks, Upload, XCircle } from 'lucide-react';
import { EMPLOYEE_IMPORT_COLUMNS, type ImportJobRowDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, ConfirmDialog, ErrorState, Label, Skeleton, StatCard } from '@/components/ui';
import { useServerTable } from '@/hooks/use-server-table';
import { fmtNumber } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useOrgId } from '@/features/me/use-me';
import { downloadImportTemplate, fileToBase64, useImportJob, useImportMutations } from '../api';
import { toastJobQueued } from '../job-toast';

const STEPS = ['template', 'upload', 'review', 'done'] as const;

export default function EmployeeImportPage() {
  const { t } = useTranslation('employees');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const orgId = useOrgId();
  const [params, setParams] = useSearchParams();
  const importId = params.get('importId') ?? undefined;
  const table = useServerTable({ pageSize: 25 });
  const invalidOnly = table.state.filters['rows'] === 'invalid';
  const job = useImportJob(importId, { page: table.state.page, pageSize: table.state.pageSize, status: invalidOnly ? 'invalid' : undefined }, false);
  const { upload, confirm, cancel } = useImportMutations();
  const [file, setFile] = useState<File | null>(null);
  const [options, setOptions] = useState({ updateExisting: false, autoAssignDeviceUserId: true });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [queuedJobId, setQueuedJobId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const detail = job.data?.data;
  const step: (typeof STEPS)[number] = queuedJobId || (detail && detail.status !== 'VALIDATED') ? 'done' : importId ? 'review' : 'upload';

  const onUpload = async () => {
    if (!file) return;
    try {
      const contentBase64 = await fileToBase64(file);
      const created = await upload.mutateAsync({ fileName: file.name, contentBase64, options });
      setParams({ importId: created.id });
    } catch (e) { toastError(e); }
  };
  const onConfirm = () => { if (!importId) return; confirm.mutate(importId, { onSuccess: (r) => { setQueuedJobId(r.jobId); setConfirmOpen(false); toastJobQueued(r.jobId, navigate, t('import.queuedHint')); }, onError: (e) => { setConfirmOpen(false); toastError(e); } }); };
  const onCancel = () => { if (!importId) return; cancel.mutate(importId, { onSuccess: () => { toast.success(t('import.cancelled')); setParams({}); }, onError: toastError }); };

  const columns = useMemo<ColumnDef<ImportJobRowDto, unknown>[]>(() => [
    { id: 'rowNo', header: '#', cell: ({ row }) => <span className="tnum text-xs text-muted-foreground">{row.original.rowNo}</span>, size: 48 },
    { id: 'status', header: tc('common.status'), cell: ({ row }) => row.original.status === 'valid' ? <Badge variant="success" dot>{t('import.rowValid')}</Badge> : <Badge variant="danger" dot>{t(`import.rowStatus.${row.original.status}`)}</Badge> },
    { id: 'employeeNumber', header: t('fields.employeeNumber'), cell: ({ row }) => <span className="font-mono text-xs" dir="ltr">{String(row.original.data['employeeNumber'] ?? '')}</span> },
    { id: 'name', header: tc('common.name'), cell: ({ row }) => `${String(row.original.data['firstName'] ?? '')} ${String(row.original.data['lastName'] ?? '')}`.trim() || '—' },
    { id: 'branchCode', header: tc('common.branch'), cell: ({ row }) => <span className="font-mono text-xs" dir="ltr">{String(row.original.data['branchCode'] ?? '')}</span> },
    { id: 'errors', header: t('import.errors'), cell: ({ row }) => row.original.errors.length === 0 ? <span className="text-xs text-muted-foreground">—</span> : (
      <ul className="space-y-0.5 text-xs text-destructive">{row.original.errors.map((e, i) => <li key={i}>{e.field ? <span className="font-mono">{e.field}: </span> : null}{e.message}</li>)}</ul>
    ) },
  ], [t, tc]);

  return (
    <div className="page-container">
      <PageHeader title={t('import.title')} description={t('import.subtitle')} breadcrumbs={<Link to="/employees" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="size-3 rtl:rotate-180" /> {t('title')}</Link>} />
      <ol className="mb-5 flex flex-wrap gap-2 text-xs" aria-label={t('import.steps')}>
        {STEPS.map((s, i) => { const idx = STEPS.indexOf(step); const state = i < idx ? 'done' : i === idx ? 'current' : 'todo'; return (
          <li key={s} aria-current={state === 'current' ? 'step' : undefined} className={cn('flex items-center gap-1.5 rounded-full border px-3 py-1', state === 'current' && 'border-primary bg-accent font-medium', state === 'done' && 'text-muted-foreground')}>
            <span className={cn('flex size-4 items-center justify-center rounded-full text-[10px]', state === 'done' ? 'bg-primary text-primary-foreground' : 'bg-muted')}>{i + 1}</span>{t(`import.step.${s}`)}
          </li>
        ); })}
      </ol>

      {step === 'upload' ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>{t('import.step.template')}</CardTitle><CardDescription>{t('import.templateHint')}</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              <Button variant="outline" loading={downloading} onClick={async () => { setDownloading(true); try { await downloadImportTemplate(orgId); } catch (e) { toastError(e); } finally { setDownloading(false); } }}><Download /> {t('import.downloadTemplate')}</Button>
              <div className="flex flex-wrap gap-1" dir="ltr">{EMPLOYEE_IMPORT_COLUMNS.map((c) => <Badge key={c} variant="outline" className="font-mono text-[10px]">{c}</Badge>)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>{t('import.step.upload')}</CardTitle><CardDescription>{t('import.uploadHint')}</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <div className={cn('flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center', file && 'border-primary bg-accent/40')}
                onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) setFile(f); }}>
                <FileUp className="size-6 text-muted-foreground" aria-hidden />
                <input ref={fileInput} id="import-file" type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                <Label htmlFor="import-file" className="cursor-pointer text-primary underline-offset-4 hover:underline">{file ? file.name : t('import.chooseFile')}</Label>
                <p className="text-xs text-muted-foreground">{t('import.fileRules')}</p>
              </div>
              <div className="space-y-2">
                <label className="flex items-start gap-2 text-sm"><Checkbox checked={options.updateExisting} onCheckedChange={(v) => setOptions((o) => ({ ...o, updateExisting: !!v }))} className="mt-0.5" /><span>{t('import.updateExisting')}<span className="block text-xs text-muted-foreground">{t('import.updateExistingHint')}</span></span></label>
                <label className="flex items-start gap-2 text-sm"><Checkbox checked={options.autoAssignDeviceUserId} onCheckedChange={(v) => setOptions((o) => ({ ...o, autoAssignDeviceUserId: !!v }))} className="mt-0.5" /><span>{t('import.autoAssign')}<span className="block text-xs text-muted-foreground">{t('import.autoAssignHint')}</span></span></label>
              </div>
              <Button disabled={!file} loading={upload.isPending} onClick={onUpload}><Upload /> {t('import.validate')}</Button>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {step === 'review' ? (
        job.isError ? <ErrorState error={job.error} onRetry={() => void job.refetch()} /> : !detail ? <div className="space-y-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-64 w-full" /></div> : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <StatCard label={t('import.totalRows')} value={fmtNumber(detail.totalRows)} icon={ListChecks} />
              <StatCard label={t('import.validRows')} value={fmtNumber(detail.validRows)} icon={CheckCircle2} tone="success" />
              <StatCard label={t('import.errorRows')} value={fmtNumber(detail.errorRows)} icon={XCircle} tone={detail.errorRows > 0 ? 'danger' : 'default'} onClick={detail.errorRows > 0 ? () => table.setFilter('rows', invalidOnly ? undefined : 'invalid') : undefined} />
            </div>
            <DataTable columns={columns} data={job.data?.data.rows} total={job.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize} onPageChange={table.setPage} onPageSizeChange={table.setPageSize}
              isLoading={job.isFetching} error={undefined}
              toolbar={<label className="flex items-center gap-2 text-sm"><Checkbox checked={invalidOnly} onCheckedChange={(v) => table.setFilter('rows', v ? 'invalid' : undefined)} /> {t('import.invalidOnly')}</label>}
              emptyTitle={t('import.noRows')} />
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-4">
              <p className="text-sm text-muted-foreground">{detail.validRows > 0 ? t('import.confirmHint', { valid: detail.validRows, invalid: detail.errorRows }) : t('import.nothingValid')}</p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={onCancel} loading={cancel.isPending}>{t('import.cancel')}</Button>
                <Button disabled={detail.validRows === 0} onClick={() => setConfirmOpen(true)}>{t('import.confirm', { count: detail.validRows })}</Button>
              </div>
            </div>
            <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} title={t('import.confirmTitle', { count: detail.validRows })} description={t('import.confirmDescription')} confirmLabel={t('import.confirmAction')} loading={confirm.isPending} onConfirm={onConfirm} />
          </div>
        )
      ) : null}

      {step === 'done' ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <CheckCircle2 className="size-10 text-emerald-600" aria-hidden />
            <h2 className="text-lg font-semibold">{detail && detail.status !== 'VALIDATED' && detail.status !== 'IMPORTING' ? t(`import.status.${detail.status}`) : t('import.queuedTitle')}</h2>
            <p className="max-w-md text-sm text-muted-foreground">{t('import.queuedHint')}</p>
            <div className="flex flex-wrap justify-center gap-2">
              {(queuedJobId ?? detail?.queueJobId) ? <Button onClick={() => navigate(`/sync/${queuedJobId ?? detail?.queueJobId}`)}>{t('jobs.view')}</Button> : null}
              <Button variant="outline" onClick={() => navigate('/employees')}>{t('import.backToList')}</Button>
              <Button variant="ghost" onClick={() => { setQueuedJobId(null); setFile(null); setParams({}); }}>{t('import.another')}</Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
