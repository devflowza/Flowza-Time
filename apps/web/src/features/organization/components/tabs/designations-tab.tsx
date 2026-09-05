import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { Pencil, Archive, Plus, BadgeCheck } from 'lucide-react';
import type { DesignationDto, designationInputSchema } from '@flowza/contracts';
import type { z } from 'zod';
import { DataTable } from '@/components/data-table';
import { Button, Switch } from '@/components/ui';
import { toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { useDesignations, useStructureMutations } from '../../api';
import { useTabTable } from '../../use-tab-table';
import { DesignationDialog } from '../designation-dialog';
import { ArchiveDialog } from '../archive-dialog';
import { RowActions } from '../row-actions';
import { RecordStatusBadge } from '../status-badge';
import { StructureToolbar } from './toolbar';

export function DesignationsTab() {
  const { t } = useTranslation('organization');
  const { t: tc } = useTranslation();
  const can = useCan();
  const canManage = can('department.manage');
  const table = useTabTable({ sort: 'level' });
  const q = useDesignations(table.query);
  const { update, archive } = useStructureMutations<DesignationDto, z.output<typeof designationInputSchema>>('designations');
  const [dialog, setDialog] = useState<{ open: boolean; designation: DesignationDto | null }>({ open: false, designation: null });
  const [archiving, setArchiving] = useState<DesignationDto | null>(null);

  const columns = useMemo<ColumnDef<DesignationDto, unknown>[]>(() => [
    { id: 'level', accessorKey: 'level', header: t('designations.level'), cell: ({ row }) => <span className="tnum">{row.original.level}</span>, size: 80 },
    { id: 'code', accessorKey: 'code', header: tc('common.code'), cell: ({ row }) => <span className="font-mono text-xs" dir="ltr">{row.original.code}</span> },
    { id: 'name', accessorKey: 'name', header: tc('common.name'), cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.name}</p>{row.original.nameAr ? <p className="truncate text-xs text-muted-foreground" dir="rtl">{row.original.nameAr}</p> : null}</div> },
    { id: 'status', accessorKey: 'status', header: tc('common.status'), cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <RecordStatusBadge status={row.original.status} />
        {canManage && row.original.status !== 'archived' ? <Switch aria-label={t('actions.toggleActive')} checked={row.original.status === 'active'} disabled={update.isPending} onClick={(e) => e.stopPropagation()} onCheckedChange={(on) => update.mutate({ id: row.original.id, input: { status: on ? 'active' : 'inactive' } }, { onError: toastError })} /> : null}
      </div>
    ) },
    { id: 'actions', header: '', enableHiding: false, cell: ({ row }) => canManage ? <RowActions actions={[
      { key: 'edit', label: tc('common.edit'), icon: <Pencil />, onSelect: () => setDialog({ open: true, designation: row.original }) },
      { key: 'archive', label: t('actions.archive'), icon: <Archive />, destructive: true, disabled: row.original.status === 'archived', onSelect: () => setArchiving(row.original) },
    ]} /> : null },
  ], [t, tc, canManage, update]);

  return (
    <>
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} sort={table.state.sort} order={table.state.order} onSort={table.toggleSort}
        isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="designations"
        onRowClick={canManage ? (d) => setDialog({ open: true, designation: d }) : undefined}
        emptyTitle={t('designations.empty')} emptyDescription={t('designations.emptyHint')}
        emptyAction={canManage ? <Button size="sm" onClick={() => setDialog({ open: true, designation: null })}><Plus /> {t('designations.add')}</Button> : undefined}
        toolbar={<StructureToolbar filters={table.state.filters} setFilter={table.setFilter} clearFilters={table.clearFilters}>
          {canManage ? <Button size="sm" className="ms-auto" onClick={() => setDialog({ open: true, designation: null })}><Plus /> {t('designations.add')}</Button> : null}
        </StructureToolbar>}
        renderCard={(d) => <div className="flex items-start gap-3"><BadgeCheck className="mt-0.5 size-4 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="font-medium">{d.name}</p><p className="text-xs text-muted-foreground" dir="ltr">{d.code} · L{d.level}</p></div><RecordStatusBadge status={d.status} /></div>}
      />
      {dialog.open ? <DesignationDialog key={dialog.designation?.id ?? 'new'} open={dialog.open} onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))} designation={dialog.designation} /> : null}
      <ArchiveDialog target={archiving} onClose={() => setArchiving(null)} archive={archive} title={t('designations.archiveTitle', { name: archiving?.name ?? '' })} description={t('designations.archiveHint')} successMessage={t('designations.archived')} />
    </>
  );
}
