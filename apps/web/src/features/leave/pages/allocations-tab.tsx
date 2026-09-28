import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CalendarClock, Pencil, Plus, Sparkles, X } from 'lucide-react';
import { DataTable } from '@/components/data-table';
import { Button, ConfirmDialog, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDate, fmtDateTime, todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useTabTable } from '@/features/organization/use-tab-table';
import { SearchBox } from '@/features/organization/components/search-box';
import { toastJobQueued } from '@/features/employees/job-toast';
import { useLeaveAllocationMutations, useLeaveAllocations, useLeaveTypes } from '../api';
import type { LeaveAllocationDto } from '../types';
import { fmtLeaveDays } from '../model';
import { AllocationDialog } from '../components/allocation-dialog';

/**
 * Allocation rows of a year (the entitlement source of truth): edit a row, create the missing rows of the year from each
 * type's yearly allowance (prorated for joiners; existing rows are never overwritten), and close the previous year — the
 * worker carries unused days forward into this year (capped, with the type's expiry), idempotently.
 */
export function AllocationsTab() {
  const { t } = useTranslation('leave');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const canManage = useCan()('leave.manage');
  const thisYear = Number(todayIso(tz).slice(0, 4));
  const table = useTabTable();
  const f = table.state.filters;
  const year = Number(f['year']) || thisYear;
  const query = useMemo(() => ({ page: table.state.page, pageSize: table.state.pageSize, year, leaveTypeId: f['leaveTypeId'], search: f['search'] }), [table.state.page, table.state.pageSize, year, f]);
  const q = useLeaveAllocations(query);
  const types = useLeaveTypes();
  const typeOptions = useMemo(() => (types.data ?? []).filter((x) => !x.compOff).map((x) => ({ value: x.id, label: x.name, description: x.code })), [types.data]);
  const { generate, closeYear } = useLeaveAllocationMutations();
  const [dialog, setDialog] = useState<{ open: boolean; allocation: LeaveAllocationDto | null }>({ open: false, allocation: null });
  const [confirm, setConfirm] = useState<'generate' | 'close' | null>(null);
  const fromYear = year - 1;

  const columns = useMemo<ColumnDef<LeaveAllocationDto, unknown>[]>(() => [
    { id: 'employee', header: t('fields.employee'), cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.employeeName}</p><p className="font-mono text-xs text-muted-foreground" dir="ltr">{row.original.employeeNumber}</p></div> },
    { id: 'type', header: t('fields.leaveType'), cell: ({ row }) => <span className="text-sm">{row.original.leaveTypeName} <span className="font-mono text-xs text-muted-foreground" dir="ltr">{row.original.leaveTypeCode}</span></span> },
    { id: 'allocated', header: t('allocations.allocated'), cell: ({ row }) => <span className="tnum">{fmtLeaveDays(row.original.allocatedDays)}</span> },
    { id: 'carried', header: t('allocations.carriedForward'), cell: ({ row }) => row.original.carriedForwardDays > 0 ? <span className="text-xs tnum">{fmtLeaveDays(row.original.carriedForwardDays)}{row.original.carriedForwardExpiresOn ? <span className="block text-muted-foreground">{t('allocations.expires', { date: fmtDate(row.original.carriedForwardExpiresOn) })}</span> : null}</span> : <span className="text-muted-foreground">—</span> },
    { id: 'opening', header: t('allocations.opening'), cell: ({ row }) => <span className="tnum">{row.original.openingBalanceDays ? fmtLeaveDays(row.original.openingBalanceDays) : '—'}</span> },
    { id: 'adjustment', header: t('allocations.adjustment'), cell: ({ row }) => <span className="tnum">{row.original.adjustmentDays ? fmtLeaveDays(row.original.adjustmentDays) : '—'}</span> },
    { id: 'notes', header: t('allocations.notes'), cell: ({ row }) => <span className="block max-w-[200px] truncate text-xs" title={row.original.notes ?? undefined}>{row.original.notes ?? '—'}</span> },
    { id: 'updated', header: tc('common.updatedAt'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDateTime(row.original.updatedAt, tz)}</span> },
    { id: 'actions', header: '', cell: ({ row }) => canManage ? <div className="flex justify-end"><Button size="sm" variant="ghost" aria-label={tc('common.edit')} onClick={(e) => { e.stopPropagation(); setDialog({ open: true, allocation: row.original }); }}><Pencil /></Button></div> : null },
  ], [t, tc, tz, canManage]);

  const years = [thisYear + 1, thisYear, thisYear - 1, thisYear - 2];
  const hasFilters = !!f['leaveTypeId'] || !!f['search'];
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{t('allocations.hint')}</p>
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()}
        emptyTitle={t('allocations.empty', { year })} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('allocations.emptyHint')}
        emptyAction={!hasFilters && canManage ? <Button onClick={() => setConfirm('generate')}><Sparkles /> {t('allocations.generate', { year })}</Button> : undefined}
        toolbar={
          <>
            <Select value={String(year)} onValueChange={(v) => table.setFilter('year', v)}>
              <SelectTrigger className="h-8 w-28" aria-label={t('balances.year')}><SelectValue /></SelectTrigger>
              <SelectContent>{years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
            </Select>
            <SearchBox id="leave-allocations-search" value={f['search']} onChange={(v) => table.setFilter('search', v)} placeholder={t('balances.search')} className="relative w-full sm:w-56" />
            <Combobox value={f['leaveTypeId'] ?? null} onChange={(v) => table.setFilter('leaveTypeId', v ?? undefined)} options={typeOptions} loading={types.isLoading} clearable placeholder={t('fields.leaveType')} className="h-8 w-40" />
            {hasFilters ? <Button variant="ghost" size="sm" onClick={() => table.update({ filters: { leaveTypeId: '', search: '' } })}><X /> {tc('common.clearFilters')}</Button> : null}
            {canManage ? (
              <div className="ms-auto flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setConfirm('close')}><CalendarClock /> {t('allocations.closeYear', { from: fromYear, to: year })}</Button>
                <Button size="sm" variant="outline" onClick={() => setConfirm('generate')}><Sparkles /> {t('allocations.generate', { year })}</Button>
                <Button size="sm" onClick={() => setDialog({ open: true, allocation: null })}><Plus /> {t('allocations.add')}</Button>
              </div>
            ) : null}
          </>
        }
        renderCard={(a) => <div className="space-y-1"><p className="font-medium">{a.employeeName}</p><p className="text-xs text-muted-foreground tnum">{a.leaveTypeName} · {fmtLeaveDays(a.allocatedDays)}{a.carriedForwardDays > 0 ? ` + ${fmtLeaveDays(a.carriedForwardDays)}` : ''}</p></div>}
      />
      <AllocationDialog key={`${dialog.open}-${dialog.allocation?.id ?? 'new'}-${year}`} open={dialog.open} onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))} year={year} allocation={dialog.allocation} />
      <ConfirmDialog open={confirm === 'generate'} onOpenChange={(o) => !o && setConfirm(null)} title={t('allocations.generateTitle', { year })} description={t('allocations.generateHint')} confirmLabel={t('allocations.generate', { year })} loading={generate.isPending}
        onConfirm={() => generate.mutate({ year }, { onSuccess: (r) => { toast.success(t('allocations.generated', { created: r.created, skipped: r.skipped })); setConfirm(null); }, onError: toastError })} />
      <ConfirmDialog open={confirm === 'close'} onOpenChange={(o) => !o && setConfirm(null)} title={t('allocations.closeTitle', { from: fromYear, to: year })} description={t('allocations.closeHint', { from: fromYear, to: year })} confirmLabel={t('allocations.closeYear', { from: fromYear, to: year })} loading={closeYear.isPending}
        onConfirm={() => closeYear.mutate(fromYear, { onSuccess: (r) => { toastJobQueued(r.jobId, navigate, t('allocations.closeQueued', { from: r.fromYear, to: r.toYear })); setConfirm(null); }, onError: toastError })} />
    </div>
  );
}
