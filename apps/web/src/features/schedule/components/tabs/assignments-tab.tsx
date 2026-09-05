import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CalendarX2, Plus, Trash2, X } from 'lucide-react';
import { ASSIGNMENT_TARGETS } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { Badge, Button, ConfirmDialog, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDate, todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { RowActions } from '@/features/organization/components/row-actions';
import { useTabTable } from '@/features/organization/use-tab-table';
import { toastJobQueued } from '@/features/employees/job-toast';
import { useAssignmentMutations, useAssignments, useShiftOptions } from '../../api';
import type { ShiftAssignmentDto } from '../../types';
import { AssignmentDialog } from '../assignment-dialog';
import { ResolveShiftCard } from '../resolve-shift-card';

const ALL = '__all__';

export function AssignmentsTab() {
  const { t } = useTranslation('schedule');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const can = useCan();
  const canAssign = can('shift.assign');
  const table = useTabTable();
  const f = table.state.filters;
  const query = useMemo(() => ({ page: table.state.page, pageSize: table.state.pageSize, targetType: f['targetType'], shiftId: f['shiftId'], branchId: f['branchId'], activeOn: f['activeOn'] }), [table.state.page, table.state.pageSize, f]);
  const q = useAssignments(query);
  const shifts = useShiftOptions(true);
  const branches = useBranchOptions();
  const { end, remove } = useAssignmentMutations();
  const [createOpen, setCreateOpen] = useState(false);
  const [ending, setEnding] = useState<ShiftAssignmentDto | null>(null);
  const [endDate, setEndDate] = useState('');
  const [deleting, setDeleting] = useState<ShiftAssignmentDto | null>(null);
  const hasFilters = ['targetType', 'shiftId', 'branchId', 'activeOn'].some((k) => !!f[k]);
  const afterMutation = (jobId: string | null, msg: string) => { if (jobId) toastJobQueued(jobId, navigate, t('assignments.recalcHint')); else toast.success(msg); };

  const columns = useMemo<ColumnDef<ShiftAssignmentDto, unknown>[]>(() => [
    { id: 'target', header: t('assignments.target'), cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.targetName ?? row.original.targetId.slice(0, 8)}</p><Badge variant="outline" className="mt-0.5">{t(`assignments.targets.${row.original.targetType}`, { defaultValue: row.original.targetType })}</Badge></div> },
    { id: 'shift', header: t('assignments.shiftOrPattern'), cell: ({ row }) => row.original.shiftId ? <span className="flex items-center gap-2"><span className="size-2.5 rounded-full" style={{ backgroundColor: shifts.byId.get(row.original.shiftId)?.color ?? '#94a3b8' }} aria-hidden />{row.original.shiftName ?? '—'}</span> : <span className="flex items-center gap-1.5"><Badge variant="info">{t('assignments.modes.pattern')}</Badge>{row.original.patternName ?? '—'}</span> },
    { id: 'branch', header: tc('common.branch'), cell: ({ row }) => row.original.branchId ? branches.byId.get(row.original.branchId)?.name ?? '—' : <span className="text-xs text-muted-foreground">{t('assignments.allBranches')}</span> },
    { id: 'range', header: t('assignments.effective'), cell: ({ row }) => { const a = row.original; const today = todayIso(tz); const active = a.effectiveFrom <= today && (!a.effectiveTo || a.effectiveTo > today); return <span className={`whitespace-nowrap text-xs tnum ${active ? '' : 'text-muted-foreground'}`}>{fmtDate(a.effectiveFrom)} → {a.effectiveTo ? fmtDate(a.effectiveTo) : t('assignments.openEnded')}{active ? <Badge variant="success" className="ms-2">{t('assignments.active')}</Badge> : null}</span>; } },
    { id: 'actions', header: '', cell: ({ row }) => canAssign ? <RowActions actions={[{ key: 'end', label: t('assignments.end'), icon: <CalendarX2 />, disabled: !!row.original.effectiveTo && row.original.effectiveTo <= todayIso(tz), onSelect: () => { setEndDate(todayIso(tz)); setEnding(row.original); } }, { key: 'delete', label: tc('common.delete'), icon: <Trash2 />, destructive: true, onSelect: () => setDeleting(row.original) }]} /> : null },
  ], [t, tc, tz, shifts.byId, branches.byId, canAssign]);

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <div className="min-w-0">
        <DataTable
          columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
          onPageChange={table.setPage} onPageSizeChange={table.setPageSize} isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="shift-assignments"
          emptyTitle={t('assignments.empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('assignments.emptyHint')}
          emptyAction={!hasFilters && canAssign ? <Button onClick={() => setCreateOpen(true)}><Plus /> {t('assignments.add')}</Button> : undefined}
          toolbar={
            <>
              <Select value={f['targetType'] ?? ALL} onValueChange={(v) => table.setFilter('targetType', v === ALL ? undefined : v)}>
                <SelectTrigger className="h-8 w-40" aria-label={t('assignments.targetType')}><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value={ALL}>{t('assignments.allTargets')}</SelectItem>{ASSIGNMENT_TARGETS.map((s) => <SelectItem key={s} value={s}>{t(`assignments.targets.${s}`)}</SelectItem>)}</SelectContent>
              </Select>
              <Combobox value={f['shiftId'] ?? null} onChange={(v) => table.setFilter('shiftId', v ?? undefined)} options={shifts.options} loading={shifts.isLoading} clearable placeholder={t('assignments.shift')} className="h-8 w-40" />
              <Combobox value={f['branchId'] ?? null} onChange={(v) => table.setFilter('branchId', v ?? undefined)} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-40" />
              <div className="flex items-center gap-1"><Label htmlFor="as-activeOn" className="text-xs text-muted-foreground">{t('assignments.activeOn')}</Label><Input id="as-activeOn" type="date" dir="ltr" className="h-8 w-[150px]" value={f['activeOn'] ?? ''} onChange={(e) => table.setFilter('activeOn', e.target.value || undefined)} /></div>
              {hasFilters ? <Button variant="ghost" size="sm" onClick={() => table.update({ filters: { targetType: '', shiftId: '', branchId: '', activeOn: '' } })}><X /> {tc('common.clearFilters')}</Button> : null}
              {canAssign ? <Button size="sm" className="ms-auto" onClick={() => setCreateOpen(true)}><Plus /> {t('assignments.add')}</Button> : null}
            </>
          }
          renderCard={(a) => <div className="space-y-1"><div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{a.targetName ?? a.targetType}</span><Badge variant="outline">{t(`assignments.targets.${a.targetType}`)}</Badge></div><p className="text-xs text-muted-foreground">{a.shiftName ?? a.patternName} · <span className="tnum">{fmtDate(a.effectiveFrom)} → {a.effectiveTo ? fmtDate(a.effectiveTo) : '∞'}</span></p></div>}
        />
      </div>
      <ResolveShiftCard />
      <AssignmentDialog key={String(createOpen)} open={createOpen} onOpenChange={setCreateOpen} />
      <ConfirmDialog open={!!ending} onOpenChange={(o) => !o && setEnding(null)} title={t('assignments.endTitle')} description={t('assignments.endHint')} confirmLabel={t('assignments.end')} loading={end.isPending}
        onConfirm={() => { if (!ending || !endDate) return; end.mutate({ id: ending.id, effectiveTo: endDate }, { onSuccess: (r) => { afterMutation(r.recalculationJobId, t('assignments.ended')); setEnding(null); }, onError: toastError }); }}>
        <div className="space-y-1.5"><Label htmlFor="as-end-date">{t('assignments.effectiveTo')}</Label><Input id="as-end-date" type="date" dir="ltr" value={endDate} min={ending?.effectiveFrom} onChange={(e) => setEndDate(e.target.value)} /></div>
      </ConfirmDialog>
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={t('assignments.deleteTitle')} description={t('assignments.deleteHint')} confirmLabel={tc('common.delete')} destructive loading={remove.isPending}
        onConfirm={() => { if (!deleting) return; remove.mutate(deleting.id, { onSuccess: (r) => { afterMutation(r.recalculationJobId, t('assignments.deleted')); setDeleting(null); }, onError: toastError }); }} />
    </div>
  );
}
