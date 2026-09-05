import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { CornerDownRight, Network, Pencil, Archive, Plus } from 'lucide-react';
import type { DepartmentDto } from '@flowza/contracts';
import type { z } from 'zod';
import type { departmentInputSchema } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { Button, Switch } from '@/components/ui';
import { fmtNumber } from '@/lib/format';
import { toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { useDepartments, useStructureMutations } from '../../api';
import { useTabTable } from '../../use-tab-table';
import { orderAsTree } from '../../tree';
import { DepartmentDialog } from '../department-dialog';
import { ArchiveDialog } from '../archive-dialog';
import { RowActions } from '../row-actions';
import { RecordStatusBadge } from '../status-badge';
import { StructureToolbar } from './toolbar';

type Row = DepartmentDto & { depth: number };

export function DepartmentsTab() {
  const { t } = useTranslation('organization');
  const { t: tc } = useTranslation();
  const can = useCan();
  const canManage = can('department.manage');
  const table = useTabTable({ sort: 'name', pageSize: 50 });
  const q = useDepartments(table.query);
  const { update, archive } = useStructureMutations<DepartmentDto, z.output<typeof departmentInputSchema>>('departments');
  const [dialog, setDialog] = useState<{ open: boolean; department: DepartmentDto | null; parentId?: string | null }>({ open: false, department: null });
  const [archiving, setArchiving] = useState<DepartmentDto | null>(null);
  const rows = useMemo<Row[] | undefined>(() => q.data ? orderAsTree(q.data.data).map((n) => ({ ...n.row, depth: n.depth })) : undefined, [q.data]);

  const columns = useMemo<ColumnDef<Row, unknown>[]>(() => [
    { id: 'name', accessorKey: 'name', header: tc('common.name'), cell: ({ row }) => (
      <div className="flex min-w-0 items-center gap-1" style={{ paddingInlineStart: `${row.original.depth * 1.25}rem` }}>
        {row.original.depth > 0 ? <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground rtl:-scale-x-100" aria-hidden /> : null}
        <div className="min-w-0"><p className="truncate font-medium">{row.original.name}</p><p className="truncate font-mono text-xs text-muted-foreground" dir="ltr">{row.original.code}</p></div>
      </div>
    ) },
    { id: 'branch', header: tc('common.branch'), enableSorting: false, cell: ({ row }) => row.original.branchName ?? <span className="text-xs text-muted-foreground">{t('departments.allBranches')}</span> },
    { id: 'manager', header: t('departments.manager'), enableSorting: false, cell: ({ row }) => row.original.managerName ?? '—' },
    { id: 'employees', header: t('fields.employees'), enableSorting: false, cell: ({ row }) => <span className="tnum">{row.original.employeeCount !== undefined ? fmtNumber(row.original.employeeCount) : '—'}</span> },
    { id: 'status', accessorKey: 'status', header: tc('common.status'), cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <RecordStatusBadge status={row.original.status} />
        {canManage && row.original.status !== 'archived' ? <Switch aria-label={t('actions.toggleActive')} checked={row.original.status === 'active'} disabled={update.isPending} onClick={(e) => e.stopPropagation()} onCheckedChange={(on) => update.mutate({ id: row.original.id, input: { status: on ? 'active' : 'inactive' } }, { onError: toastError })} /> : null}
      </div>
    ) },
    { id: 'actions', header: '', enableHiding: false, cell: ({ row }) => canManage ? <RowActions actions={[
      { key: 'edit', label: tc('common.edit'), icon: <Pencil />, onSelect: () => setDialog({ open: true, department: row.original }) },
      { key: 'child', label: t('departments.addChild'), icon: <Plus />, onSelect: () => setDialog({ open: true, department: null, parentId: row.original.id }) },
      { key: 'archive', label: t('actions.archive'), icon: <Archive />, destructive: true, disabled: row.original.status === 'archived', onSelect: () => setArchiving(row.original) },
    ]} /> : null },
  ], [t, tc, canManage, update]);

  return (
    <>
      <DataTable
        columns={columns} data={rows} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} sort={table.state.sort} order={table.state.order} onSort={table.toggleSort}
        isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="departments"
        onRowClick={canManage ? (d) => setDialog({ open: true, department: d }) : undefined}
        emptyTitle={t('departments.empty')} emptyDescription={t('departments.emptyHint')}
        emptyAction={canManage ? <Button size="sm" onClick={() => setDialog({ open: true, department: null })}><Plus /> {t('departments.add')}</Button> : undefined}
        toolbar={<StructureToolbar filters={table.state.filters} setFilter={table.setFilter} clearFilters={table.clearFilters}>
          {canManage ? <Button size="sm" className="ms-auto" onClick={() => setDialog({ open: true, department: null })}><Plus /> {t('departments.add')}</Button> : null}
        </StructureToolbar>}
        renderCard={(d) => <div className="flex items-start gap-3"><Network className="mt-0.5 size-4 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="font-medium">{d.name}</p><p className="text-xs text-muted-foreground">{d.branchName ?? t('departments.allBranches')}</p></div><RecordStatusBadge status={d.status} /></div>}
      />
      {dialog.open ? <DepartmentDialog key={dialog.department?.id ?? `new-${dialog.parentId ?? ''}`} open={dialog.open} onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))} department={dialog.department} parentId={dialog.parentId} /> : null}
      <ArchiveDialog target={archiving} onClose={() => setArchiving(null)} archive={archive} title={t('departments.archiveTitle', { name: archiving?.name ?? '' })} description={t('departments.archiveHint')} successMessage={t('departments.archived')} />
    </>
  );
}
