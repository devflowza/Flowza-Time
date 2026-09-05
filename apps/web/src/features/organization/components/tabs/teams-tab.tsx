import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { Pencil, Archive, Plus, Users } from 'lucide-react';
import type { TeamDto, teamInputSchema } from '@flowza/contracts';
import type { z } from 'zod';
import { DataTable } from '@/components/data-table';
import { Button } from '@/components/ui';
import { fmtNumber } from '@/lib/format';
import { useCan } from '@/features/me/use-me';
import { useStructureMutations, useTeams } from '../../api';
import { useTabTable } from '../../use-tab-table';
import { TeamDialog } from '../team-dialog';
import { ArchiveDialog } from '../archive-dialog';
import { RowActions } from '../row-actions';
import { RecordStatusBadge } from '../status-badge';
import { StructureToolbar } from './toolbar';

export function TeamsTab() {
  const { t } = useTranslation('organization');
  const { t: tc } = useTranslation();
  const can = useCan();
  const canManage = can('department.manage');
  const table = useTabTable({ sort: 'name' });
  const q = useTeams(table.query);
  const { archive } = useStructureMutations<TeamDto, z.output<typeof teamInputSchema>>('teams');
  const [dialog, setDialog] = useState<{ open: boolean; team: TeamDto | null }>({ open: false, team: null });
  const [archiving, setArchiving] = useState<TeamDto | null>(null);

  const columns = useMemo<ColumnDef<TeamDto, unknown>[]>(() => [
    { id: 'code', accessorKey: 'code', header: tc('common.code'), cell: ({ row }) => <span className="font-mono text-xs" dir="ltr">{row.original.code}</span> },
    { id: 'name', accessorKey: 'name', header: tc('common.name'), cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
    { id: 'branch', header: tc('common.branch'), enableSorting: false, cell: ({ row }) => row.original.branchName ?? <span className="text-xs text-muted-foreground">{t('departments.allBranches')}</span> },
    { id: 'lead', header: t('teams.lead'), enableSorting: false, cell: ({ row }) => row.original.leadName ?? '—' },
    { id: 'members', header: t('teams.members'), enableSorting: false, cell: ({ row }) => <span className="tnum">{fmtNumber(row.original.memberCount)}</span> },
    { id: 'status', accessorKey: 'status', header: tc('common.status'), cell: ({ row }) => <RecordStatusBadge status={row.original.status} /> },
    { id: 'actions', header: '', enableHiding: false, cell: ({ row }) => canManage ? <RowActions actions={[
      { key: 'edit', label: tc('common.edit'), icon: <Pencil />, onSelect: () => setDialog({ open: true, team: row.original }) },
      { key: 'archive', label: t('actions.archive'), icon: <Archive />, destructive: true, disabled: row.original.status === 'archived', onSelect: () => setArchiving(row.original) },
    ]} /> : null },
  ], [t, tc, canManage]);

  return (
    <>
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} sort={table.state.sort} order={table.state.order} onSort={table.toggleSort}
        isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="teams"
        onRowClick={canManage ? (tm) => setDialog({ open: true, team: tm }) : undefined}
        emptyTitle={t('teams.empty')} emptyDescription={t('teams.emptyHint')}
        emptyAction={canManage ? <Button size="sm" onClick={() => setDialog({ open: true, team: null })}><Plus /> {t('teams.add')}</Button> : undefined}
        toolbar={<StructureToolbar filters={table.state.filters} setFilter={table.setFilter} clearFilters={table.clearFilters}>
          {canManage ? <Button size="sm" className="ms-auto" onClick={() => setDialog({ open: true, team: null })}><Plus /> {t('teams.add')}</Button> : null}
        </StructureToolbar>}
        renderCard={(tm) => <div className="flex items-start gap-3"><Users className="mt-0.5 size-4 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="font-medium">{tm.name}</p><p className="text-xs text-muted-foreground">{t('teams.memberCount', { count: tm.memberCount })}</p></div><RecordStatusBadge status={tm.status} /></div>}
      />
      {dialog.open ? <TeamDialog key={dialog.team?.id ?? 'new'} open={dialog.open} onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))} team={dialog.team} /> : null}
      <ArchiveDialog target={archiving} onClose={() => setArchiving(null)} archive={archive} title={t('teams.archiveTitle', { name: archiving?.name ?? '' })} description={t('teams.archiveHint')} successMessage={t('teams.archived')} />
    </>
  );
}
