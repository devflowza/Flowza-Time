import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { Building2, Pencil, Archive, Plus } from 'lucide-react';
import type { BranchDto, BranchInput } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { Badge, Button, Switch } from '@/components/ui';
import { fmtNumber } from '@/lib/format';
import { toastError } from '@/lib/toast';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useBranches, useStructureMutations } from '../../api';
import { useTabTable } from '../../use-tab-table';
import { BranchDialog } from '../branch-dialog';
import { ArchiveDialog } from '../archive-dialog';
import { RowActions } from '../row-actions';
import { RecordStatusBadge } from '../status-badge';
import { StructureToolbar } from './toolbar';

export function BranchesTab() {
  const { t } = useTranslation('organization');
  const { t: tc } = useTranslation();
  const can = useCan();
  const canManage = can('branch.manage');
  const tz = useOrgTimezone();
  const table = useTabTable({ sort: 'name' });
  const q = useBranches(table.query);
  const { update, archive } = useStructureMutations<BranchDto, BranchInput>('branches');
  const [dialog, setDialog] = useState<{ open: boolean; branch: BranchDto | null }>({ open: false, branch: null });
  const [archiving, setArchiving] = useState<BranchDto | null>(null);

  const columns = useMemo<ColumnDef<BranchDto, unknown>[]>(() => [
    { id: 'code', accessorKey: 'code', header: tc('common.code'), cell: ({ row }) => <span className="font-mono text-xs" dir="ltr">{row.original.code}</span> },
    { id: 'name', accessorKey: 'name', header: tc('common.name'), cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.name}</p>{row.original.nameAr ? <p className="truncate text-xs text-muted-foreground" dir="rtl">{row.original.nameAr}</p> : null}</div> },
    { id: 'city', accessorKey: 'city', header: t('fields.city'), cell: ({ row }) => row.original.city ?? '—' },
    { id: 'timezone', accessorKey: 'timezone', header: tc('common.timezone'), enableSorting: false, cell: ({ row }) => <span className="font-mono text-xs" dir="ltr">{row.original.timezone}</span> },
    { id: 'employees', header: t('fields.employees'), enableSorting: false, cell: ({ row }) => <span className="tnum">{row.original.employeeCount !== undefined ? fmtNumber(row.original.employeeCount) : '—'}</span> },
    { id: 'weeklyOff', header: t('fields.weeklyOffDays'), enableSorting: false, cell: ({ row }) => row.original.weeklyOffDays ? <span className="flex flex-wrap gap-1">{row.original.weeklyOffDays.map((d) => <Badge key={d} variant="outline">{t(`days.${d}`)}</Badge>)}</span> : <span className="text-xs text-muted-foreground">{t('branches.inherited')}</span> },
    { id: 'status', accessorKey: 'status', header: tc('common.status'), cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <RecordStatusBadge status={row.original.status} />
        {canManage && row.original.status !== 'archived' ? <Switch aria-label={t('actions.toggleActive')} checked={row.original.status === 'active'} disabled={update.isPending} onClick={(e) => e.stopPropagation()} onCheckedChange={(on) => update.mutate({ id: row.original.id, input: { status: on ? 'active' : 'inactive' } }, { onError: toastError })} /> : null}
      </div>
    ) },
    { id: 'actions', header: '', enableHiding: false, cell: ({ row }) => canManage ? <RowActions actions={[
      { key: 'edit', label: tc('common.edit'), icon: <Pencil />, onSelect: () => setDialog({ open: true, branch: row.original }) },
      { key: 'archive', label: t('actions.archive'), icon: <Archive />, destructive: true, disabled: row.original.status === 'archived', onSelect: () => setArchiving(row.original) },
    ]} /> : null },
  ], [t, tc, canManage, update]);

  return (
    <>
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} sort={table.state.sort} order={table.state.order} onSort={table.toggleSort}
        isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="branches"
        onRowClick={canManage ? (b) => setDialog({ open: true, branch: b }) : undefined}
        emptyTitle={t('branches.empty')} emptyDescription={t('branches.emptyHint')}
        emptyAction={canManage ? <Button size="sm" onClick={() => setDialog({ open: true, branch: null })}><Plus /> {t('branches.add')}</Button> : undefined}
        toolbar={<StructureToolbar filters={table.state.filters} setFilter={table.setFilter} clearFilters={table.clearFilters}>
          {canManage ? <Button size="sm" className="ms-auto" onClick={() => setDialog({ open: true, branch: null })}><Plus /> {t('branches.add')}</Button> : null}
        </StructureToolbar>}
        renderCard={(b) => <div className="flex items-start gap-3"><Building2 className="mt-0.5 size-4 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="font-medium">{b.name}</p><p className="text-xs text-muted-foreground" dir="ltr">{b.code} · {b.timezone}</p></div><RecordStatusBadge status={b.status} /></div>}
      />
      {dialog.open ? <BranchDialog key={dialog.branch?.id ?? 'new'} open={dialog.open} onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))} branch={dialog.branch} orgTimezone={tz} /> : null}
      <ArchiveDialog target={archiving} onClose={() => setArchiving(null)} archive={archive} title={t('branches.archiveTitle', { name: archiving?.name ?? '' })} description={t('branches.archiveHint')} successMessage={t('branches.archived')} />
    </>
  );
}
