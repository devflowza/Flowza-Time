import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CalendarX2, Plus, Trash2, X } from 'lucide-react';
import type { AdditionalShiftAssignmentDto } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { Badge, Button, ConfirmDialog, Input, Label } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDate, todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { RowActions } from '@/features/organization/components/row-actions';
import { useTabTable } from '@/features/organization/use-tab-table';
import { toastJobQueued } from '@/features/employees/job-toast';
import { useShiftOptions } from '@/features/schedule/api';
import { useAdditionalShiftMutations, useAdditionalShifts } from '../api';
import { SCHED_NS } from '../i18n';
import { AdditionalShiftDialog } from './additional-shift-dialog';

/** Shifts → Double shifts (Enterprise): additional shift assignments — list with filters, assign, end, delete. */
export function DoubleShiftsTab() {
  const { t } = useTranslation(SCHED_NS);
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const can = useCan();
  const canAssign = can('shift.assign');
  const table = useTabTable();
  const f = table.state.filters;
  const query = useMemo(() => ({ page: table.state.page, pageSize: table.state.pageSize, shiftId: f['shiftId'], branchId: f['branchId'], activeOn: f['activeOn'] }), [table.state.page, table.state.pageSize, f]);
  const q = useAdditionalShifts(query);
  const shifts = useShiftOptions(true);
  const branches = useBranchOptions();
  const { end, remove } = useAdditionalShiftMutations();
  const [createOpen, setCreateOpen] = useState(false);
  const [ending, setEnding] = useState<AdditionalShiftAssignmentDto | null>(null);
  const [endDate, setEndDate] = useState('');
  const [deleting, setDeleting] = useState<AdditionalShiftAssignmentDto | null>(null);
  const hasFilters = ['shiftId', 'branchId', 'activeOn'].some((k) => !!f[k]);
  const afterMutation = (jobId: string | null, msg: string) => { if (jobId) toastJobQueued(jobId, navigate, t('double.recalcHint'), { to: '/attendance?tab=recalc' }); else toast.success(msg); };

  const columns = useMemo<ColumnDef<AdditionalShiftAssignmentDto, unknown>[]>(() => [
    { id: 'employee', header: t('double.employee'), cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.employeeName ?? row.original.employeeId.slice(0, 8)}</p><p className="text-xs text-muted-foreground">{row.original.employeeNumber ?? ''}</p></div> },
    { id: 'shift', header: t('double.shift'), cell: ({ row }) => <span className="flex items-center gap-2"><span className="size-2.5 rounded-full" style={{ backgroundColor: shifts.byId.get(row.original.shift.id)?.color ?? '#94a3b8' }} aria-hidden /><span>{row.original.shift.name}</span><span className="text-xs text-muted-foreground tnum" dir="ltr">{row.original.shift.startTime}–{row.original.shift.endTime}</span></span> },
    { id: 'branch', header: tc('common.branch'), cell: ({ row }) => (row.original.branchId ? branches.byId.get(row.original.branchId)?.name ?? '—' : '—') },
    { id: 'range', header: t('double.range'), cell: ({ row }) => { const a = row.original; const today = todayIso(tz); const active = a.effectiveFrom <= today && (!a.effectiveTo || a.effectiveTo >= today); return <span className={`whitespace-nowrap text-xs tnum ${active ? '' : 'text-muted-foreground'}`}>{fmtDate(a.effectiveFrom)} → {a.effectiveTo ? fmtDate(a.effectiveTo) : t('double.openEnded')}{active ? <Badge variant="success" className="ms-2">{t('double.active')}</Badge> : null}{a.shiftChangeRequestId ? <Badge variant="outline" className="ms-2">{t('double.fromRequest')}</Badge> : null}</span>; } },
    { id: 'actions', header: '', cell: ({ row }) => canAssign ? <RowActions actions={[{ key: 'end', label: t('double.end'), icon: <CalendarX2 />, disabled: !!row.original.effectiveTo && row.original.effectiveTo < todayIso(tz), onSelect: () => { setEndDate(todayIso(tz)); setEnding(row.original); } }, { key: 'delete', label: tc('common.delete'), icon: <Trash2 />, destructive: true, onSelect: () => setDeleting(row.original) }]} /> : null },
  ], [t, tc, tz, shifts.byId, branches.byId, canAssign]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('double.hint')}</p>
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="additional-shifts"
        emptyTitle={t('double.empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('double.emptyHint')}
        emptyAction={!hasFilters && canAssign ? <Button onClick={() => setCreateOpen(true)}><Plus /> {t('double.add')}</Button> : undefined}
        toolbar={
          <>
            <Combobox value={f['shiftId'] ?? null} onChange={(v) => table.setFilter('shiftId', v ?? undefined)} options={shifts.options} loading={shifts.isLoading} clearable placeholder={t('double.shift')} className="h-8 w-40" />
            <Combobox value={f['branchId'] ?? null} onChange={(v) => table.setFilter('branchId', v ?? undefined)} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-40" />
            <div className="flex items-center gap-1"><Label htmlFor="dbl-activeOn" className="text-xs text-muted-foreground">{t('double.activeOn')}</Label><Input id="dbl-activeOn" type="date" dir="ltr" className="h-8 w-[150px]" value={f['activeOn'] ?? ''} onChange={(e) => table.setFilter('activeOn', e.target.value || undefined)} /></div>
            {hasFilters ? <Button variant="ghost" size="sm" onClick={() => table.update({ filters: { shiftId: '', branchId: '', activeOn: '' } })}><X /> {tc('common.clearFilters')}</Button> : null}
            {canAssign ? <Button size="sm" className="ms-auto" onClick={() => setCreateOpen(true)}><Plus /> {t('double.add')}</Button> : null}
          </>
        }
        renderCard={(a) => <div className="space-y-1"><p className="truncate font-medium">{a.employeeName ?? a.employeeId.slice(0, 8)}</p><p className="text-xs text-muted-foreground">{a.shift.name} · <span className="tnum">{fmtDate(a.effectiveFrom)} → {a.effectiveTo ? fmtDate(a.effectiveTo) : '∞'}</span></p></div>}
      />
      <AdditionalShiftDialog key={String(createOpen)} open={createOpen} onOpenChange={setCreateOpen} />
      <ConfirmDialog open={!!ending} onOpenChange={(o) => !o && setEnding(null)} title={t('double.endTitle')} description={t('double.endHint')} confirmLabel={t('double.end')} loading={end.isPending}
        onConfirm={() => { if (!ending || !endDate) return; end.mutate({ id: ending.id, effectiveTo: endDate }, { onSuccess: (r) => { afterMutation(r.recalculationJobId, t('double.ended')); setEnding(null); }, onError: toastError }); }}>
        <div className="space-y-1.5"><Label htmlFor="dbl-end-date">{t('double.to')}</Label><Input id="dbl-end-date" type="date" dir="ltr" value={endDate} min={ending?.effectiveFrom} onChange={(e) => setEndDate(e.target.value)} /></div>
      </ConfirmDialog>
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={t('double.deleteTitle')} description={t('double.deleteHint')} confirmLabel={tc('common.delete')} destructive loading={remove.isPending}
        onConfirm={() => { if (!deleting) return; remove.mutate(deleting.id, { onSuccess: (r) => { afterMutation(r.recalculationJobId, t('double.deleted')); setDeleting(null); }, onError: toastError }); }} />
    </div>
  );
}
