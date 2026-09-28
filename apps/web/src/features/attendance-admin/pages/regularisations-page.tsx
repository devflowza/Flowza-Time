import { useMemo, useState } from 'react';
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check, CheckCircle2, Download, X, XCircle } from 'lucide-react';
import { REGULARISATION_STATUSES, REGULARISATION_TYPES, type RegularisationAdminDecision, type RegularisationAdminItemDto, type RegularisationBulkResultDto, type RegularisationStatus } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Combobox, DateRange } from '@/components/forms';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtTime } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgId, useOrgTimezone } from '@/features/me/use-me';
import { SearchBox } from '@/features/organization/components/search-box';
import { useBranchOptions, useDepartmentOptions } from '@/features/organization/lookups';
import { useServerTable } from '@/hooks/use-server-table';
import { saveTextFile } from '@/features/attendance/workspace-api';
import { AA_NS } from '../i18n';
import { fetchRegularisationsCsv, useRegularisationAccess, useRegularisationDecisions, useRegularisationsAdmin } from '../api';
import { decidable, presentFilters } from '../model';

const ALL = '__all';
const STATUS_TONE: Record<RegularisationStatus, 'warning' | 'success' | 'danger' | 'neutral'> = { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'neutral' };
const FILTER_KEYS = ['status', 'type', 'from', 'to', 'branchId', 'departmentId', 'search'] as const;

type Deciding = { kind: RegularisationAdminDecision; rows: RegularisationAdminItemDto[] } | null;

/** Approve / reject one or several regularisations; rejecting needs a comment (the API enforces it too). */
function DecideDialog({ deciding, onClose, onBulkResult }: { deciding: Deciding; onClose: () => void; onBulkResult: (r: RegularisationBulkResultDto, rows: RegularisationAdminItemDto[]) => void }) {
  const { t } = useTranslation(AA_NS);
  const { t: tc } = useTranslation();
  const { decide, bulkDecide } = useRegularisationDecisions();
  const [comment, setComment] = useState('');
  const reject = deciding?.kind === 'reject';
  const rows = deciding?.rows ?? [];
  const bulk = rows.length > 1;
  const missing = reject && comment.trim().length === 0;
  const override = rows.some((r) => r.approval?.decideVia === 'override');
  const submit = () => {
    if (!deciding || missing || rows.length === 0) return;
    const c = comment.trim() || undefined;
    if (!bulk) {
      const r = rows[0]!;
      decide.mutate({ id: r.id, decision: deciding.kind, comment: c, stepNo: r.approval?.currentStep ?? undefined }, {
        onSuccess: (res) => { toast.success(res.status === 'rejected' ? t('regs.done.rejected') : res.advanced ? t('regs.done.advanced') : t('regs.done.approved')); onClose(); },
        onError: toastError,
      });
      return;
    }
    bulkDecide.mutate({ items: rows.map((r) => ({ id: r.id, stepNo: r.approval?.currentStep ?? undefined })), decision: deciding.kind, comment: c }, {
      onSuccess: (res) => { onBulkResult(res, rows); onClose(); },
      onError: toastError,
    });
  };
  const title = bulk ? t(reject ? 'regs.decide.bulkRejectTitle' : 'regs.decide.bulkApproveTitle', { count: rows.length }) : t(reject ? 'regs.decide.rejectTitle' : 'regs.decide.approveTitle');
  return (
    <Dialog open={!!deciding} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{t('regs.decide.hint')}</DialogDescription></DialogHeader>
        {!bulk && rows[0] ? (
          <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
            <p className="font-medium">{rows[0].employeeName} <span className="font-mono text-xs text-muted-foreground" dir="ltr">{rows[0].employeeNumber}</span></p>
            <p className="text-xs text-muted-foreground">{fmtDate(rows[0].attendanceDate, 'EEE dd MMM yyyy')} · {t(`regs.types.${rows[0].type}`)}</p>
            <p className="text-xs" dir="auto">{rows[0].reason}</p>
          </div>
        ) : null}
        {override ? <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100" role="note">{t('regs.decide.override')}</p> : null}
        <FormField label={t('regs.decide.comment')} htmlFor="reg-comment" required={reject} optional={!reject}>
          <Textarea id="reg-comment" rows={3} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('regs.decide.commentPlaceholder')} aria-invalid={missing || undefined} />
          {missing ? <p className="text-xs text-muted-foreground">{t('regs.decide.commentRequired')}</p> : null}
        </FormField>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
          <Button type="button" variant={reject ? 'destructive' : 'default'} disabled={missing} loading={decide.isPending || bulkDecide.isPending} onClick={submit}>{reject ? <><X /> {t('regs.actions.reject')}</> : <><Check /> {t('regs.actions.approve')}</>}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One line per item of a bulk decision: what was decided, what moved to the next level, and what was refused and why. */
function BulkResultDialog({ result, onClose }: { result: { res: RegularisationBulkResultDto; rows: RegularisationAdminItemDto[] } | null; onClose: () => void }) {
  const { t } = useTranslation(AA_NS);
  const { t: tc } = useTranslation();
  const byId = new Map((result?.rows ?? []).map((r) => [r.id, r]));
  return (
    <Dialog open={!!result} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('regs.bulk.resultTitle')}</DialogTitle><DialogDescription>{result ? t('regs.bulk.result', { succeeded: result.res.succeeded, failed: result.res.failed }) : null}</DialogDescription></DialogHeader>
        <ul className="max-h-80 divide-y overflow-y-auto rounded-md border" data-testid="bulk-results">
          {(result?.res.results ?? []).map((r) => { const row = byId.get(r.id); return (
            <li key={r.id} className="flex items-start gap-2 p-2.5 text-sm" data-ok={r.ok}>
              {r.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden /> : <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />}
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{row?.employeeName ?? r.id} <span className="text-xs font-normal text-muted-foreground tnum">{row ? fmtDate(row.attendanceDate) : ''}</span></span>
                <span className="block text-xs text-muted-foreground">{r.ok ? (r.advanced ? t('regs.bulk.advanced') : t('regs.bulk.decided')) : `${t('regs.bulk.refused')}: ${r.message ?? r.code ?? ''}`}</span>
              </span>
            </li>
          ); })}
        </ul>
        <DialogFooter><Button onClick={onClose}>{tc('common.close')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * /attendance/regularisations — HR's regularisation register (HR portal Prompt 6b): filters, the current approval level and
 * its approvers, the applied correction, and decisions ALWAYS through the approval engine (single and bulk, per-item
 * authorisation and result; a reject needs a comment). CSV with report.export (escaped and audited by the API). RLS keeps a
 * branch-scoped approver to their branches.
 */
export default function RegularisationsPage() {
  const { t } = useTranslation(AA_NS);
  const { t: tc } = useTranslation();
  const orgId = useOrgId();
  const tz = useOrgTimezone();
  const can = useCan();
  const access = useRegularisationAccess();
  const table = useServerTable({ pageSize: 25 });
  const f = table.state.filters;
  const branches = useBranchOptions();
  const departments = useDepartmentOptions(f['branchId'] ?? null);
  const filters = useMemo(() => presentFilters(FILTER_KEYS, f), [f]);
  const query = useMemo(() => ({ page: table.state.page, pageSize: table.state.pageSize, sort: table.state.sort, order: table.state.order, ...filters }), [table.state, filters]);
  const q = useRegularisationsAdmin(query);
  const [selection, setSelection] = useState<RowSelectionState>({});
  const selectionKey = JSON.stringify(query);
  const [selectionFor, setSelectionFor] = useState(selectionKey);
  if (selectionFor !== selectionKey) { setSelectionFor(selectionKey); setSelection({}); }
  const [deciding, setDeciding] = useState<Deciding>(null);
  const [bulkResult, setBulkResult] = useState<{ res: RegularisationBulkResultDto; rows: RegularisationAdminItemDto[] } | null>(null);
  const [exporting, setExporting] = useState(false);
  const tzOf = useMemo(() => (branchId: string | null) => (branchId ? branches.byId.get(branchId)?.timezone : undefined) ?? tz, [branches.byId, tz]);
  const hasFilters = Object.keys(filters).length > 0;
  const exportCsv = () => {
    setExporting(true);
    fetchRegularisationsCsv(orgId, filters).then((file) => { saveTextFile(file); toast.success(t('regs.exported', { count: file.rowCount })); }).catch(toastError).finally(() => setExporting(false));
  };
  const pickRows = (ids: string[]) => (q.data?.data ?? []).filter((r) => ids.includes(r.id));

  const columns = useMemo<ColumnDef<RegularisationAdminItemDto, unknown>[]>(() => [
    { id: 'employeeName', header: t('regs.columns.employee'), enableSorting: true, cell: ({ row }) => { const r = row.original; return <div className="min-w-[160px]"><p className="font-medium">{r.employeeName}</p><p className="text-xs text-muted-foreground"><span className="font-mono" dir="ltr">{r.employeeNumber}</span>{r.branchName ? ` · ${r.branchName}` : ''}{r.departmentName ? ` · ${r.departmentName}` : ''}</p></div>; } },
    { id: 'attendanceDate', header: t('regs.columns.date'), enableSorting: true, cell: ({ row }) => <span className="whitespace-nowrap tnum">{fmtDate(row.original.attendanceDate, 'EEE dd MMM yyyy')}</span> },
    { id: 'type', header: t('regs.columns.type'), enableSorting: true, cell: ({ row }) => <span className="text-sm">{t(`regs.types.${row.original.type}`)}</span> },
    { id: 'proposed', header: t('regs.columns.proposed'), cell: ({ row }) => { const r = row.original; const z = tzOf(r.branchId); return r.proposedInAt || r.proposedOutAt ? <div className="text-xs tnum" dir="ltr">{r.proposedInAt ? <p>{t('regs.proposedIn', { time: fmtTime(r.proposedInAt, z) })}</p> : null}{r.proposedOutAt ? <p>{t('regs.proposedOut', { time: fmtTime(r.proposedOutAt, z) })}</p> : null}</div> : <span className="text-xs text-muted-foreground">{t('regs.noTimes')}</span>; } },
    { id: 'reason', header: t('regs.columns.reason'), cell: ({ row }) => <p className="max-w-[240px] truncate text-sm" title={row.original.reason} dir="auto">{row.original.reason}</p> },
    { id: 'status', header: t('regs.columns.status'), enableSorting: true, cell: ({ row }) => { const r = row.original; return <div className="space-y-0.5"><Badge variant={STATUS_TONE[r.status]} dot>{t(`regs.status.${r.status}`)}</Badge>{r.decidedByName && r.decidedAt ? <p className="text-[11px] text-muted-foreground">{t('regs.decidedBy', { name: r.decidedByName, date: fmtDateTime(r.decidedAt, tz, 'dd MMM, HH:mm') })}</p> : null}</div>; } },
    { id: 'level', header: t('regs.columns.level'), cell: ({ row }) => { const a = row.original.approval; if (!a) return <span className="text-xs text-muted-foreground">—</span>; const waiting = a.approvers.filter((x) => x.decision === 'PENDING').map((x) => x.name); return (
      <div className="min-w-[150px] space-y-0.5 text-xs">
        {a.currentStep ? <p className="font-medium tnum">{t('regs.level', { n: a.currentStep, count: a.stepCount })}</p> : null}
        {a.status === 'PENDING' && a.approverType ? <p className="text-muted-foreground">{t(`regs.approverType.${a.approverType}`)}</p> : null}
        {a.status === 'PENDING' && waiting.length ? <p className="text-muted-foreground">{t('regs.waitingOn', { names: waiting.join(', ') })}</p> : null}
        {a.infoRequested ? <Badge variant="info" className="text-[10px]">{t('regs.infoRequested')}</Badge> : null}
      </div>
    ); } },
    { id: 'applied', header: t('regs.columns.applied'), cell: ({ row }) => { const r = row.original; if (!r.appliedCorrectionId) return <span className="text-xs text-muted-foreground">—</span>; return <div className="text-xs"><p className="tnum">{r.appliedAt ? t('regs.applied', { date: fmtDateTime(r.appliedAt, tz, 'dd MMM yyyy') }) : null}</p>{can('attendance.view') ? <Link to={`/corrections?employeeId=${r.employeeId}&from=${r.attendanceDate}&to=${r.attendanceDate}`} className="font-medium text-primary hover:underline" onClick={(e) => e.stopPropagation()}>{t('regs.appliedLink')}</Link> : null}</div>; } },
    { id: 'actions', header: '', cell: ({ row }) => { const r = row.original; return (
      <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
        {decidable(r) ? (
          <>
            <Button size="sm" variant="outline" onClick={() => setDeciding({ kind: 'reject', rows: [r] })}><X /> {t('regs.actions.reject')}</Button>
            <Button size="sm" onClick={() => setDeciding({ kind: 'approve', rows: [r] })}><Check /> {t('regs.actions.approve')}</Button>
          </>
        ) : r.status === 'pending' ? <span className="text-xs text-muted-foreground">{t('regs.notYourLevel')}</span> : null}
      </div>
    ); } },
  ], [t, tz, tzOf, can]);

  return (
    <div className="page-container space-y-4">
      <PageHeader title={t('regs.title')} description={t('regs.subtitle')} actions={access.exportCsv ? <Button size="sm" variant="outline" loading={exporting} onClick={exportCsv}><Download /> {t('regs.actions.export')}</Button> : undefined} />
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} sort={table.state.sort} order={table.state.order} onSort={table.toggleSort}
        isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="attendance-regularisations" getRowId={(r) => r.id}
        selection={selection} onSelectionChange={setSelection}
        bulkActions={(ids) => (
          <>
            <Button size="sm" variant="outline" onClick={() => setDeciding({ kind: 'reject', rows: pickRows(ids) })}><X /> {t('regs.actions.rejectSelected')}</Button>
            <Button size="sm" onClick={() => setDeciding({ kind: 'approve', rows: pickRows(ids) })}><Check /> {t('regs.actions.approveSelected')}</Button>
          </>
        )}
        emptyTitle={t('regs.empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('regs.emptyHint')}
        toolbar={
          <>
            <Select value={f['status'] ?? ALL} onValueChange={(v) => table.setFilter('status', v === ALL ? undefined : v)}>
              <SelectTrigger className="h-8 w-40" aria-label={t('regs.filters.status')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>{t('regs.filters.allStatuses')}</SelectItem>{REGULARISATION_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`regs.status.${s}`)}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={f['type'] ?? ALL} onValueChange={(v) => table.setFilter('type', v === ALL ? undefined : v)}>
              <SelectTrigger className="h-8 w-44" aria-label={t('regs.filters.type')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>{t('regs.filters.allTypes')}</SelectItem>{REGULARISATION_TYPES.map((s) => <SelectItem key={s} value={s}>{t(`regs.types.${s}`)}</SelectItem>)}</SelectContent>
            </Select>
            <Combobox value={f['branchId'] ?? null} onChange={(v) => table.update({ filters: { branchId: v ?? '', departmentId: '' } })} options={branches.options} loading={branches.isLoading} clearable placeholder={t('regs.filters.branch')} className="h-8 w-40" />
            <Combobox value={f['departmentId'] ?? null} onChange={(v) => table.setFilter('departmentId', v ?? undefined)} options={departments.options} loading={departments.isLoading} clearable placeholder={t('regs.filters.department')} className="h-8 w-40" />
            <DateRange idPrefix="reg" from={f['from']} to={f['to']} onChange={({ from, to }) => table.update({ filters: { from: from ?? '', to: to ?? '' } })} />
            <SearchBox id="reg-search" value={f['search']} onChange={(v) => table.setFilter('search', v)} placeholder={t('regs.filters.search')} className="relative w-full sm:w-56" />
            {hasFilters ? <Button variant="ghost" size="sm" onClick={table.clearFilters}><X /> {t('regs.filters.clear')}</Button> : null}
          </>
        }
        renderCard={(r) => (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{r.employeeName}</span><Badge variant={STATUS_TONE[r.status]} dot>{t(`regs.status.${r.status}`)}</Badge></div>
            <p className="text-xs text-muted-foreground tnum">{fmtDate(r.attendanceDate)} · {t(`regs.types.${r.type}`)}</p>
            <p className="truncate text-xs" dir="auto">{r.reason}</p>
            {decidable(r) ? <div className="flex gap-2"><Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setDeciding({ kind: 'reject', rows: [r] }); }}><X /> {t('regs.actions.reject')}</Button><Button size="sm" onClick={(e) => { e.stopPropagation(); setDeciding({ kind: 'approve', rows: [r] }); }}><Check /> {t('regs.actions.approve')}</Button></div> : null}
          </div>
        )}
      />
      <DecideDialog key={`${deciding?.kind ?? ''}:${deciding?.rows.map((r) => r.id).join(',') ?? ''}`} deciding={deciding} onClose={() => setDeciding(null)} onBulkResult={(res, rows) => { setSelection({}); setBulkResult({ res, rows }); }} />
      <BulkResultDialog result={bulkResult} onClose={() => setBulkResult(null)} />
    </div>
  );
}
