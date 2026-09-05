import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { CalendarDays, Pencil, Plus, Trash2, X } from 'lucide-react';
import { RECORD_STATUSES } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { Badge, Button, ConfirmDialog, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { fmtMinutes } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { SearchBox } from '@/features/organization/components/search-box';
import { RowActions } from '@/features/organization/components/row-actions';
import { useTabTable } from '@/features/organization/use-tab-table';
import { useShiftMutations, useShifts } from '../../api';
import type { ShiftDto } from '../../types';
import { ShiftDialog } from '../shift-dialog';

const ALL = '__all__';

export function ShiftsTab() {
  const { t } = useTranslation('schedule');
  const { t: tc } = useTranslation();
  const can = useCan();
  const canManage = can('shift.manage');
  const table = useTabTable();
  const f = table.state.filters;
  const query = useMemo(() => ({ page: table.state.page, pageSize: table.state.pageSize, status: f['status'], search: f['search'] }), [table.state.page, table.state.pageSize, f]);
  const q = useShifts(query);
  const { remove } = useShiftMutations();
  const [dialog, setDialog] = useState<{ open: boolean; shift: ShiftDto | null }>({ open: false, shift: null });
  const [deleting, setDeleting] = useState<ShiftDto | null>(null);
  const hasFilters = !!f['status'] || !!f['search'];

  const columns = useMemo<ColumnDef<ShiftDto, unknown>[]>(() => [
    { id: 'code', header: tc('common.code'), enableSorting: false, cell: ({ row }) => <span className="flex items-center gap-2 font-mono text-xs" dir="ltr"><span className="size-2.5 rounded-full" style={{ backgroundColor: row.original.color ?? '#94a3b8' }} aria-hidden />{row.original.code}</span> },
    { id: 'name', header: tc('common.name'), enableSorting: false, cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.name}</p>{row.original.nameAr ? <p className="truncate text-xs text-muted-foreground" dir="rtl">{row.original.nameAr}</p> : null}</div> },
    { id: 'type', header: t('shifts.type'), enableSorting: false, cell: ({ row }) => <Badge variant={row.original.type === 'FIXED' ? 'secondary' : 'info'}>{t(`shifts.types.${row.original.type}`, { defaultValue: row.original.type })}</Badge> },
    { id: 'hours', header: t('shifts.hours'), enableSorting: false, cell: ({ row }) => { const s = row.original; return s.type === 'FIXED' ? <span className="font-mono text-xs tnum" dir="ltr">{s.startTime} – {s.endTime}{s.crossesMidnight ? <span className="ms-1 text-muted-foreground" title={t('shifts.crossesMidnight')}>+1</span> : null}</span> : <span className="text-xs tnum">{t('shifts.required', { value: fmtMinutes(s.requiredMinutes ?? 0) })}{s.coreStart && s.coreEnd ? <span className="text-muted-foreground" dir="ltr"> · {s.coreStart}–{s.coreEnd}</span> : null}</span>; } },
    { id: 'breaks', header: t('shifts.breaks'), enableSorting: false, cell: ({ row }) => <span className="text-xs tnum">{row.original.breaks.length ? t('shifts.breakCount', { count: row.original.breaks.length }) : '—'}</span> },
    { id: 'windows', header: t('shifts.windows'), enableSorting: false, cell: ({ row }) => <span className="text-xs tnum text-muted-foreground" dir="ltr">−{row.original.punchInWindowBeforeMinutes}m / +{row.original.punchOutWindowAfterMinutes}m</span> },
    { id: 'assignments', header: t('shifts.assignments'), enableSorting: false, cell: ({ row }) => <span className="tnum">{row.original.assignmentCount ?? 0}</span> },
    { id: 'status', header: tc('common.status'), enableSorting: false, cell: ({ row }) => <Badge variant={row.original.status === 'active' ? 'success' : row.original.status === 'inactive' ? 'warning' : 'neutral'} dot>{t(`recordStatus.${row.original.status}`, { defaultValue: row.original.status })}</Badge> },
    { id: 'actions', header: '', enableSorting: false, cell: ({ row }) => canManage ? <RowActions actions={[{ key: 'edit', label: tc('common.edit'), icon: <Pencil />, onSelect: () => setDialog({ open: true, shift: row.original }) }, { key: 'delete', label: tc('common.delete'), icon: <Trash2 />, destructive: true, disabled: (row.original.assignmentCount ?? 0) > 0, onSelect: () => setDeleting(row.original) }]} /> : null },
  ], [t, tc, canManage]);

  return (
    <div className="space-y-3">
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize}
        isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="shifts"
        onRowClick={canManage ? (s) => setDialog({ open: true, shift: s }) : undefined}
        emptyTitle={t('shifts.empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('shifts.emptyHint')}
        emptyAction={!hasFilters && canManage ? <Button onClick={() => setDialog({ open: true, shift: null })}><Plus /> {t('shifts.add')}</Button> : undefined}
        toolbar={
          <>
            <SearchBox id="shift-search" value={f['search']} onChange={(v) => table.setFilter('search', v)} />
            <Select value={f['status'] ?? ALL} onValueChange={(v) => table.setFilter('status', v === ALL ? undefined : v)}>
              <SelectTrigger className="h-8 w-36" aria-label={tc('common.status')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>{t('filters.allStatuses')}</SelectItem>{RECORD_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`recordStatus.${s}`)}</SelectItem>)}</SelectContent>
            </Select>
            {hasFilters ? <Button variant="ghost" size="sm" onClick={() => table.update({ filters: { status: '', search: '' } })}><X /> {tc('common.clearFilters')}</Button> : null}
            {canManage ? <Button size="sm" className="ms-auto" onClick={() => setDialog({ open: true, shift: null })}><Plus /> {t('shifts.add')}</Button> : null}
          </>
        }
        renderCard={(s) => <div className="flex items-center gap-3"><CalendarDays className="size-4 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="truncate font-medium">{s.name}</p><p className="font-mono text-xs text-muted-foreground" dir="ltr">{s.type === 'FIXED' ? `${s.startTime} – ${s.endTime}` : fmtMinutes(s.requiredMinutes ?? 0)}</p></div><Badge variant="secondary">{t(`shifts.types.${s.type}`)}</Badge></div>}
      />
      <ShiftDialog key={`${dialog.open}-${dialog.shift?.id ?? 'new'}`} open={dialog.open} onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))} shift={dialog.shift} />
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={t('shifts.deleteTitle', { name: deleting?.name ?? '' })} description={t('shifts.deleteHint')} confirmLabel={tc('common.delete')} destructive loading={remove.isPending}
        onConfirm={() => { if (!deleting) return; remove.mutate(deleting.id, { onSuccess: () => { toast.success(t('shifts.deleted')); setDeleting(null); }, onError: toastError }); }} />
    </div>
  );
}
