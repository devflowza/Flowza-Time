import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Ban, ExternalLink, Plus, X } from 'lucide-react';
import { TIME_OFF_STATUSES, type TimeOffRequestDto, type TimeOffStatus } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { Badge, Button, ConfirmDialog, FormField, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '@/components/ui';
import { Combobox, DateRange } from '@/components/forms';
import { fmtDate } from '@/lib/format';
import { useLocalName } from '@/lib/local-name';
import { toast } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { useEmployeeOptions } from '@/features/employees/api';
import { toastJobQueued } from '@/features/employees/job-toast';
import { toastMutationError } from '@/features/attendance/period-locked';
import { useTimeOffRequestMutations, useTimeOffRequests, useTimeOffTypes } from '../api';
import { SL_NS } from '../i18n';
import { STATUS_TONE, fmtDuration } from '../model';
import { RecordShortLeaveDialog } from './request-dialog';

const ALL = '__all__';

export function ShortLeaveStatusBadge({ status }: { status: TimeOffStatus }) {
  const { t } = useTranslation(SL_NS);
  return <Badge variant={STATUS_TONE[status]} dot data-status={status}>{t(`status.${status}`)}</Badge>;
}

/** Cancel a pending or approved short leave (HR): the reason is required and shown to the employee. */
function CancelDialog({ request, onClose }: { request: TimeOffRequestDto | null; onClose: () => void }) {
  const { t } = useTranslation(SL_NS);
  const navigate = useNavigate();
  const { cancel } = useTimeOffRequestMutations();
  const [reason, setReason] = useState('');
  const close = () => { setReason(''); onClose(); };
  return (
    <ConfirmDialog open={!!request} onOpenChange={(o) => !o && close()} title={t('requests.cancelTitle')} description={t('requests.cancelHint')} confirmLabel={t('requests.cancel')} destructive loading={cancel.isPending}
      onConfirm={() => {
        if (!request || reason.trim().length < 3) return;
        cancel.mutate({ id: request.id, reason: reason.trim() }, {
          onSuccess: (r) => { if (r.recalculationJobId) toastJobQueued(r.recalculationJobId, navigate, t('requests.recalcHint'), { to: '/attendance?tab=recalc' }); else toast.success(t('requests.cancelled')); close(); },
          onError: (e) => toastMutationError(e, navigate),
        });
      }}>
      <FormField label={t('fields.cancelReason')} htmlFor="slc-reason" required>
        <Textarea id="slc-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} dir="auto" />
      </FormField>
    </ConfirmDialog>
  );
}

/**
 * Leave → Short leave: every request (portal and HR-recorded) with its status and approval level, filterable by employee,
 * type, status and dates. HR (leave.manage) records a short leave for an employee and cancels one; a pending request is decided
 * in Approvals (the row links to its request).
 */
export function ShortLeaveRequestsTab() {
  const { t } = useTranslation(SL_NS);
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const can = useCan();
  const canManage = can('leave.manage');
  const ln = useLocalName();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [filters, setFilters] = useState<{ employeeId?: string; typeId?: string; status?: string; from?: string; to?: string }>({});
  const set = (patch: Partial<typeof filters>) => { setFilters((f) => ({ ...f, ...patch })); setPage(1); };
  const query = useMemo(() => ({ page, pageSize, ...filters }), [page, pageSize, filters]);
  const q = useTimeOffRequests(query);
  const types = useTimeOffTypes();
  const employees = useEmployeeOptions();
  const typeOptions = useMemo(() => (types.data ?? []).map((x) => ({ value: x.id, label: ln(x.name, x.nameAr), description: x.code })), [types.data, ln]);
  const [recordOpen, setRecordOpen] = useState(false);
  const [cancelling, setCancelling] = useState<TimeOffRequestDto | null>(null);
  const hasFilters = Object.values(filters).some((v) => !!v);

  const columns = useMemo<ColumnDef<TimeOffRequestDto, unknown>[]>(() => [
    { id: 'employee', header: t('requests.columns.employee'), cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.employeeName ?? '—'}</p><p className="font-mono text-xs text-muted-foreground" dir="ltr">{row.original.employeeNumber}</p></div> },
    { id: 'type', header: t('requests.columns.type'), cell: ({ row }) => <span className="flex flex-wrap items-center gap-1.5">{ln(row.original.typeName, row.original.typeNameAr)}{row.original.countsAsWork ? <Badge variant="secondary" className="font-normal">{t('context.work')}</Badge> : null}{row.original.recordedByHr ? <Badge variant="outline" className="font-normal">{t('requests.recordedByHr')}</Badge> : null}</span> },
    { id: 'date', header: t('requests.columns.date'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDate(row.original.date, 'EEE dd MMM yyyy')}</span> },
    { id: 'time', header: t('requests.columns.time'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum" dir="ltr">{row.original.startTime}–{row.original.endTime}</span> },
    { id: 'minutes', header: t('requests.columns.minutes'), cell: ({ row }) => <span className="text-xs tnum">{fmtDuration(row.original.minutes)}</span> },
    { id: 'reason', header: t('requests.columns.reason'), cell: ({ row }) => <div className="max-w-[240px] text-xs"><span className="block truncate" title={row.original.reason} dir="auto">{row.original.reason}</span>{row.original.decisionNote || row.original.cancelReason ? <span className="block truncate text-muted-foreground" dir="auto">{row.original.decisionNote ?? row.original.cancelReason}</span> : null}</div> },
    { id: 'status', header: t('requests.columns.status'), cell: ({ row }) => <span className="flex flex-wrap items-center gap-1"><ShortLeaveStatusBadge status={row.original.status} />{row.original.infoRequested ? <Badge variant="info">{t('requests.infoRequested')}</Badge> : null}</span> },
    { id: 'approval', header: t('requests.columns.approval'), cell: ({ row }) => (row.original.approvalRequestId && row.original.status === 'PENDING'
      ? <Button size="sm" variant="link" className="h-auto p-0 text-xs" onClick={(e) => { e.stopPropagation(); navigate(`/approvals/requests/${row.original.approvalRequestId}`); }}><ExternalLink className="size-3.5" /> {t('requests.review')}</Button>
      : <span className="text-xs text-muted-foreground">—</span>) },
    { id: 'actions', header: '', cell: ({ row }) => (canManage && (row.original.status === 'PENDING' || row.original.status === 'APPROVED')
      ? <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setCancelling(row.original); }}><Ban /> {t('requests.cancel')}</Button> : null) },
  ], [t, ln, navigate, canManage]);

  return (
    <div className="space-y-3" data-testid="short-leave-requests">
      <p className="text-sm text-muted-foreground">{t('requests.hint')}</p>
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
        isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="short-leave-requests"
        emptyTitle={t('requests.empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('requests.emptyHint')}
        emptyAction={!hasFilters && canManage ? <Button onClick={() => setRecordOpen(true)}><Plus /> {t('requests.add')}</Button> : undefined}
        toolbar={
          <>
            <Combobox value={filters.employeeId ?? null} onChange={(v) => set({ employeeId: v ?? undefined })} options={employees.options} onSearch={employees.setSearch} loading={employees.isLoading} clearable placeholder={t('fields.employee')} className="h-8 w-48" />
            <Combobox value={filters.typeId ?? null} onChange={(v) => set({ typeId: v ?? undefined })} options={typeOptions} loading={types.isLoading} clearable placeholder={t('fields.type')} className="h-8 w-44" />
            <Select value={filters.status ?? ALL} onValueChange={(v) => set({ status: v === ALL ? undefined : v })}>
              <SelectTrigger className="h-8 w-40" aria-label={tc('common.status')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>{t('requests.allStatuses')}</SelectItem>{TIME_OFF_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`status.${s}`)}</SelectItem>)}</SelectContent>
            </Select>
            <DateRange idPrefix="short-leave" from={filters.from} to={filters.to} onChange={({ from, to }) => set({ from: from || undefined, to: to || undefined })} />
            {hasFilters ? <Button variant="ghost" size="sm" onClick={() => { setFilters({}); setPage(1); }}><X /> {tc('common.clearFilters')}</Button> : null}
            {canManage ? <Button size="sm" className="ms-auto" onClick={() => setRecordOpen(true)}><Plus /> {t('requests.add')}</Button> : null}
          </>
        }
        renderCard={(r) => <div className="space-y-1"><div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{r.employeeName}</span><ShortLeaveStatusBadge status={r.status} /></div><p className="text-xs text-muted-foreground tnum">{ln(r.typeName, r.typeNameAr)} · {fmtDate(r.date)} · <span dir="ltr">{r.startTime}–{r.endTime}</span></p></div>}
      />
      <RecordShortLeaveDialog key={String(recordOpen)} open={recordOpen} onOpenChange={setRecordOpen} />
      <CancelDialog key={cancelling?.id ?? 'none'} request={cancelling} onClose={() => setCancelling(null)} />
    </div>
  );
}
