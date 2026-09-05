import { useMemo, useState } from 'react';
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Building2, CalendarClock, Download, FileUp, Network, Plus, RefreshCw, UserCog, X, Users } from 'lucide-react';
import { EMPLOYMENT_STATUSES, EMPLOYMENT_TYPES, type EmployeeDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Avatar, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, EmptyState, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { useServerTable } from '@/hooks/use-server-table';
import { fmtDate } from '@/lib/format';
import { useCan } from '@/features/me/use-me';
import { useBranchOptions, useDepartmentOptions } from '@/features/organization/lookups';
import { SearchBox } from '@/features/organization/components/search-box';
import { useEmployees } from '../api';
import { DeviceSyncSummary, EmploymentStatusBadge } from '../components/employee-badges';
import { BulkActionDialog, type BulkKind } from '../components/bulk-dialogs';

const ALL = '__all__';

export default function EmployeesListPage() {
  const { t } = useTranslation('employees');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const can = useCan();
  const table = useServerTable({ sort: 'displayName' });
  const q = useEmployees(table.query);
  const branches = useBranchOptions();
  const departments = useDepartmentOptions(table.state.filters['branchId']);
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [bulk, setBulk] = useState<BulkKind | null>(null);
  const [bulkIds, setBulkIds] = useState<string[]>([]);
  const filters = table.state.filters;
  const hasFilters = Object.keys(filters).length > 0;

  const columns = useMemo<ColumnDef<EmployeeDto, unknown>[]>(() => [
    { id: 'employeeNumber', accessorKey: 'employeeNumber', header: t('fields.employeeNumber'), cell: ({ row }) => <span className="font-mono text-xs tnum" dir="ltr">{row.original.employeeNumber}</span>, size: 110 },
    { id: 'displayName', accessorKey: 'displayName', header: tc('common.name'), cell: ({ row }) => (
      <div className="flex min-w-0 items-center gap-2.5">
        <Avatar name={row.original.displayName} src={row.original.photoUrl} />
        <div className="min-w-0"><p className="truncate font-medium">{row.original.displayName}</p><p className="truncate text-xs text-muted-foreground" dir="ltr">{row.original.email ?? row.original.deviceUserId}</p></div>
      </div>
    ) },
    { id: 'branch', header: tc('common.branch'), cell: ({ row }) => row.original.branchName ?? '—' },
    { id: 'department', header: tc('common.department'), cell: ({ row }) => row.original.departmentName ?? '—' },
    { id: 'designation', header: t('fields.designation'), cell: ({ row }) => row.original.designationName ?? '—' },
    { id: 'employmentStatus', accessorKey: 'employmentStatus', header: tc('common.status'), cell: ({ row }) => <EmploymentStatusBadge status={row.original.employmentStatus} /> },
    { id: 'joiningDate', accessorKey: 'joiningDate', header: t('fields.joiningDate'), cell: ({ row }) => <span className="tnum">{fmtDate(row.original.joiningDate)}</span> },
    { id: 'devices', header: t('sync.devices'), enableSorting: false, cell: ({ row }) => <DeviceSyncSummary summary={row.original.deviceSyncSummary} /> },
  ], [t, tc]);

  const openBulk = (kind: BulkKind, ids: string[]) => { setBulkIds(ids); setBulk(kind); };
  const canBulkEdit = can('employee.update');

  const toolbar = (
    <>
      <SearchBox value={filters['search']} onChange={(v) => table.setFilter('search', v)} placeholder={t('list.searchPlaceholder')} />
      <Combobox value={filters['branchId'] ?? null} onChange={(v) => table.update({ filters: { branchId: v ?? '', departmentId: '' } })} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-44" />
      <Combobox value={filters['departmentId'] ?? null} onChange={(v) => table.setFilter('departmentId', v ?? undefined)} options={departments.options} loading={departments.isLoading} clearable placeholder={tc('common.department')} className="h-8 w-44" />
      <Select value={filters['employmentStatus'] ?? ALL} onValueChange={(v) => table.setFilter('employmentStatus', v === ALL ? undefined : v)}>
        <SelectTrigger className="h-8 w-40" aria-label={t('fields.employmentStatus')}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value={ALL}>{t('list.allStatuses')}</SelectItem>{EMPLOYMENT_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`employmentStatus.${s}`)}</SelectItem>)}</SelectContent>
      </Select>
      <Select value={filters['employmentType'] ?? ALL} onValueChange={(v) => table.setFilter('employmentType', v === ALL ? undefined : v)}>
        <SelectTrigger className="h-8 w-40" aria-label={t('fields.employmentType')}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value={ALL}>{t('list.allTypes')}</SelectItem>{EMPLOYMENT_TYPES.map((s) => <SelectItem key={s} value={s}>{t(`employmentType.${s}`)}</SelectItem>)}</SelectContent>
      </Select>
      {hasFilters ? <Button variant="ghost" size="sm" onClick={table.clearFilters}><X /> {tc('common.clearFilters')}</Button> : null}
    </>
  );

  const isTrulyEmpty = q.data?.meta.total === 0 && !hasFilters;

  return (
    <div className="page-container">
      <PageHeader title={t('title')} description={q.data ? t('list.subtitle', { count: q.data.meta.total }) : undefined} actions={
        <>
          {can('employee.export') ? <Button variant="outline" size="sm" onClick={() => openBulk('export', [])}><Download /> {tc('common.export')}</Button> : null}
          {can('employee.import') ? <Button variant="outline" size="sm" onClick={() => navigate('/employees/import')}><FileUp /> {tc('common.import')}</Button> : null}
          {can('employee.create') ? <Button size="sm" onClick={() => navigate('/employees/new')}><Plus /> {t('list.add')}</Button> : null}
        </>
      } />
      {isTrulyEmpty ? (
        <EmptyState icon={Users} title={t('list.empty')} description={t('list.emptyHint')} action={
          <div className="flex flex-wrap justify-center gap-2">
            {can('employee.create') ? <Button onClick={() => navigate('/employees/new')}><Plus /> {t('list.add')}</Button> : null}
            {can('employee.import') ? <Button variant="outline" onClick={() => navigate('/employees/import')}><FileUp /> {t('list.import')}</Button> : null}
          </div>
        } />
      ) : (
        <DataTable
          columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
          onPageChange={table.setPage} onPageSizeChange={table.setPageSize} sort={table.state.sort} order={table.state.order} onSort={table.toggleSort}
          isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()}
          storageKey="employees" getRowId={(e) => e.id} selection={selection} onSelectionChange={setSelection}
          onRowClick={(e) => navigate(`/employees/${e.id}`)} toolbar={toolbar}
          emptyTitle={tc('common.noResults')} emptyDescription={tc('common.noResultsHint')}
          bulkActions={(ids) => (
            <>
              {canBulkEdit ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button size="sm" variant="outline"><UserCog /> {t('bulk.assign')}</Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => openBulk('assign_branch', ids)}><Building2 /> {t('bulk.assign_branch.title', { count: ids.length })}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openBulk('assign_department', ids)}><Network /> {t('bulk.assign_department.title', { count: ids.length })}</DropdownMenuItem>
                    {can('shift.assign') ? <DropdownMenuItem onSelect={() => openBulk('assign_shift', ids)}><CalendarClock /> {t('bulk.assign_shift.title', { count: ids.length })}</DropdownMenuItem> : null}
                    <DropdownMenuItem onSelect={() => openBulk('set_status', ids)}><UserCog /> {t('bulk.set_status.title', { count: ids.length })}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              {can('device.sync') ? <Button size="sm" variant="outline" onClick={() => openBulk('sync_devices', ids)}><RefreshCw /> {t('bulk.syncToDevices')}</Button> : null}
              {can('employee.export') ? <Button size="sm" variant="outline" onClick={() => openBulk('export', ids)}><Download /> {tc('common.export')}</Button> : null}
              <Button size="sm" variant="ghost" onClick={() => setSelection({})}><X /> {t('bulk.clearSelection')}</Button>
            </>
          )}
          renderCard={(e) => (
            <div className="flex items-center gap-3">
              <Avatar name={e.displayName} src={e.photoUrl} />
              <div className="min-w-0 flex-1"><p className="truncate font-medium">{e.displayName}</p><p className="truncate text-xs text-muted-foreground">{e.employeeNumber} · {e.branchName ?? '—'}</p></div>
              <EmploymentStatusBadge status={e.employmentStatus} />
            </div>
          )}
        />
      )}
      <BulkActionDialog key={`${bulk ?? ''}-${bulkIds.length}`} kind={bulk} employeeIds={bulkIds} onClose={() => setBulk(null)} onDone={() => setSelection({})} />
    </div>
  );
}
