import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { Ban, ClipboardPlus, X } from 'lucide-react';
import { CORRECTION_STATUSES } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Button, ConfirmDialog, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '@/components/ui';
import { Combobox, DateRange } from '@/components/forms';
import { useServerTable } from '@/hooks/use-server-table';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useMe, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { useEmployeeOptions } from '@/features/employees/api';
import type { CorrectionDto } from '@/features/attendance/types';
import { CorrectionStatusBadge, CorrectionTypeBadge } from '@/features/attendance/components/badges';
import { CorrectionSummary } from '@/features/attendance/components/record-dialog';
import { useCorrectionMutations, useCorrections } from '../api';
import { CorrectionDialog } from '../components/correction-dialog';

const ALL = '__all__';

export default function CorrectionsPage() {
  const { t } = useTranslation('corrections');
  const { t: ta } = useTranslation('attendance');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const can = useCan();
  const me = useMe();
  const table = useServerTable();
  const f = table.state.filters;
  const query = useMemo(() => ({ page: table.state.page, pageSize: table.state.pageSize, status: f['status'], employeeId: f['employeeId'], branchId: f['branchId'], from: f['from'], to: f['to'] }), [table.state.page, table.state.pageSize, f]);
  const q = useCorrections(query);
  const branches = useBranchOptions();
  const employees = useEmployeeOptions();
  const { cancel } = useCorrectionMutations();
  const [createOpen, setCreateOpen] = useState(false);
  const [cancelling, setCancelling] = useState<CorrectionDto | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const hasFilters = Object.keys(f).length > 0;
  const canApprove = can('attendance.approve');
  const myId = me.data?.user.id;
  const employeeOptions = useMemo(() => (f['employeeId'] && !employees.options.some((o) => o.value === f['employeeId']) ? [{ value: f['employeeId'], label: t('list.selectedEmployee') }, ...employees.options] : employees.options), [employees.options, f, t]);

  const columns = useMemo<ColumnDef<CorrectionDto, unknown>[]>(() => {
    const canCancel = (c: CorrectionDto) => c.status === 'PENDING' && (canApprove || c.requestedBy === myId);
    return [
    { id: 'employee', header: t('fields.employee'), enableSorting: false, cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.employeeName ?? '—'}</p><p className="font-mono text-xs text-muted-foreground" dir="ltr">{row.original.employeeNumber}</p></div> },
    { id: 'attendanceDate', header: t('fields.attendanceDate'), enableSorting: false, cell: ({ row }) => <span className="tnum">{fmtDate(row.original.attendanceDate)}</span> },
    { id: 'type', header: t('fields.type'), enableSorting: false, cell: ({ row }) => <CorrectionTypeBadge type={row.original.type} /> },
    { id: 'change', header: t('list.change'), enableSorting: false, cell: ({ row }) => <CorrectionSummary c={row.original} timezone={branches.byId.get(row.original.branchId)?.timezone ?? tz} /> },
    { id: 'reason', header: t('fields.reason'), enableSorting: false, cell: ({ row }) => <span className="block max-w-[260px] truncate text-xs" title={row.original.reason}>{row.original.reason}</span> },
    { id: 'status', header: tc('common.status'), enableSorting: false, cell: ({ row }) => <div className="flex flex-col gap-0.5"><CorrectionStatusBadge status={row.original.status} />{row.original.rejectionReason ? <span className="max-w-[200px] truncate text-[11px] text-muted-foreground" title={row.original.rejectionReason}>{row.original.rejectionReason}</span> : null}</div> },
    { id: 'createdAt', header: tc('common.createdAt'), enableSorting: false, cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDateTime(row.original.createdAt, tz)}</span> },
    { id: 'actions', header: '', enableSorting: false, cell: ({ row }) => canCancel(row.original) ? <div className="flex justify-end"><Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setCancelReason(''); setCancelling(row.original); }}><Ban /> {t('list.cancel')}</Button></div> : null },
    ];
  }, [t, tc, tz, branches.byId, canApprove, myId]);

  return (
    <div className="page-container">
      <PageHeader title={t('title')} description={t('subtitle')} actions={can('attendance.correct') ? <Button size="sm" onClick={() => setCreateOpen(true)}><ClipboardPlus /> {t('list.new')}</Button> : undefined} />
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="corrections"
        emptyTitle={t('list.empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('list.emptyHint')}
        emptyAction={!hasFilters && can('attendance.correct') ? <Button onClick={() => setCreateOpen(true)}><ClipboardPlus /> {t('list.new')}</Button> : undefined}
        toolbar={
          <>
            <Select value={f['status'] ?? ALL} onValueChange={(v) => table.setFilter('status', v === ALL ? undefined : v)}>
              <SelectTrigger className="h-8 w-40" aria-label={tc('common.status')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>{ta('filters.allStatuses')}</SelectItem>{CORRECTION_STATUSES.map((s) => <SelectItem key={s} value={s}>{ta(`correctionStatus.${s}`)}</SelectItem>)}</SelectContent>
            </Select>
            <Combobox value={f['employeeId'] ?? null} onChange={(v) => table.setFilter('employeeId', v ?? undefined)} options={employeeOptions} onSearch={employees.setSearch} loading={employees.isLoading} clearable placeholder={t('fields.employee')} className="h-8 w-48" />
            <Combobox value={f['branchId'] ?? null} onChange={(v) => table.setFilter('branchId', v ?? undefined)} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-40" />
            <DateRange idPrefix="cor" from={f['from']} to={f['to']} onChange={({ from, to }) => table.update({ filters: { from: from ?? '', to: to ?? '' } })} />
            {hasFilters ? <Button variant="ghost" size="sm" onClick={table.clearFilters}><X /> {tc('common.clearFilters')}</Button> : null}
          </>
        }
        renderCard={(c) => <div className="space-y-1"><div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{c.employeeName}</span><CorrectionStatusBadge status={c.status} /></div><p className="text-xs text-muted-foreground tnum">{fmtDate(c.attendanceDate)} · {ta(`correctionType.${c.type}`)}</p><p className="truncate text-xs">{c.reason}</p></div>}
      />
      <CorrectionDialog key={String(createOpen)} open={createOpen} onOpenChange={setCreateOpen} />
      <ConfirmDialog open={!!cancelling} onOpenChange={(o) => !o && setCancelling(null)} title={t('cancel.title')} description={t('cancel.hint')} confirmLabel={t('cancel.confirm')} destructive loading={cancel.isPending}
        onConfirm={() => { if (!cancelling) return; cancel.mutate({ id: cancelling.id, reason: cancelReason.trim() || undefined }, { onSuccess: () => { toast.success(t('cancel.done')); setCancelling(null); }, onError: toastError }); }}>
        <Textarea aria-label={t('cancel.reason')} placeholder={t('cancel.reason')} rows={2} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
      </ConfirmDialog>
    </div>
  );
}
