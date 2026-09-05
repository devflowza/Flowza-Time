import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Ban, CalendarOff, Pencil, Plus, Trash2, X } from 'lucide-react';
import { LEAVE_STATUSES } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { Combobox, DateRange } from '@/components/forms';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { RowActions } from '@/features/organization/components/row-actions';
import { useTabTable } from '@/features/organization/use-tab-table';
import { useEmployeeOptions } from '@/features/employees/api';
import { toastJobQueued } from '@/features/employees/job-toast';
import { toastMutationError } from '@/features/attendance/period-locked';
import { useLeaveMutations, useLeaveRecords, useLeaveTypeOptions, useLeaveTypes } from '../api';
import type { LeaveRecordDto, LeaveTypeDto } from '../types';
import { LeaveRecordDialog } from '../components/leave-record-dialog';
import { LeaveTypeDialog } from '../components/leave-type-dialog';

const ALL = '__all__';
const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { APPROVED: 'success', PENDING: 'warning', REJECTED: 'danger', CANCELLED: 'neutral' };
const TABS = ['records', 'types'] as const;
type Tab = (typeof TABS)[number];

function RecordsTab() {
  const { t } = useTranslation('leave');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const can = useCan();
  const canManage = can('leave.manage');
  const table = useTabTable();
  const f = table.state.filters;
  const query = useMemo(() => ({ page: table.state.page, pageSize: table.state.pageSize, employeeId: f['employeeId'], branchId: f['branchId'], leaveTypeId: f['leaveTypeId'], status: f['status'], from: f['from'], to: f['to'] }), [table.state.page, table.state.pageSize, f]);
  const q = useLeaveRecords(query);
  const employees = useEmployeeOptions();
  const branches = useBranchOptions();
  const types = useLeaveTypeOptions();
  const { cancelRecord } = useLeaveMutations();
  const [createOpen, setCreateOpen] = useState(false);
  const [cancelling, setCancelling] = useState<LeaveRecordDto | null>(null);
  const hasFilters = ['employeeId', 'branchId', 'leaveTypeId', 'status', 'from', 'to'].some((k) => !!f[k]);
  const employeeOptions = useMemo(() => (f['employeeId'] && !employees.options.some((o) => o.value === f['employeeId']) ? [{ value: f['employeeId'], label: t('records.selectedEmployee') }, ...employees.options] : employees.options), [employees.options, f, t]);

  const columns = useMemo<ColumnDef<LeaveRecordDto, unknown>[]>(() => [
    { id: 'employee', header: t('fields.employee'), cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.employeeName ?? '—'}</p><p className="font-mono text-xs text-muted-foreground" dir="ltr">{row.original.employeeNumber}</p></div> },
    { id: 'type', header: t('fields.leaveType'), cell: ({ row }) => { const lt = types.byId.get(row.original.leaveTypeId); return <span className="flex items-center gap-2"><span className="size-2.5 rounded-full" style={{ backgroundColor: lt?.color ?? '#94a3b8' }} aria-hidden />{row.original.leaveTypeName ?? lt?.name ?? '—'}{lt && !lt.isPaid ? <Badge variant="outline">{t('types.unpaid')}</Badge> : null}</span>; } },
    { id: 'range', header: t('records.range'), cell: ({ row }) => { const r = row.original; return <span className="whitespace-nowrap text-xs tnum">{r.startDate === r.endDate ? fmtDate(r.startDate) : `${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}`}{r.isHalfDay ? <Badge variant="outline" className="ms-2">{r.halfDayPart ? t(`halfDayParts.${r.halfDayPart}`, { defaultValue: r.halfDayPart }) : t('fields.halfDay')}</Badge> : null}</span>; } },
    { id: 'reason', header: t('fields.reason'), cell: ({ row }) => <span className="block max-w-[240px] truncate text-xs" title={row.original.reason ?? undefined}>{row.original.reason ?? '—'}</span> },
    { id: 'status', header: tc('common.status'), cell: ({ row }) => <Badge variant={STATUS_TONE[row.original.status] ?? 'neutral'} dot>{t(`status.${row.original.status}`, { defaultValue: row.original.status })}</Badge> },
    { id: 'source', header: t('records.source'), cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.source}</span> },
    { id: 'createdAt', header: tc('common.createdAt'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDateTime(row.original.createdAt, tz)}</span> },
    { id: 'actions', header: '', cell: ({ row }) => canManage && row.original.status !== 'CANCELLED' ? <div className="flex justify-end"><Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setCancelling(row.original); }}><Ban /> {t('records.cancel')}</Button></div> : null },
  ], [t, tc, tz, types.byId, canManage]);

  return (
    <>
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="leave-records"
        emptyTitle={t('records.empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('records.emptyHint')}
        emptyAction={!hasFilters && canManage ? <Button onClick={() => setCreateOpen(true)}><Plus /> {t('records.add')}</Button> : undefined}
        toolbar={
          <>
            <Combobox value={f['employeeId'] ?? null} onChange={(v) => table.setFilter('employeeId', v ?? undefined)} options={employeeOptions} onSearch={employees.setSearch} loading={employees.isLoading} clearable placeholder={t('fields.employee')} className="h-8 w-48" />
            <Combobox value={f['branchId'] ?? null} onChange={(v) => table.setFilter('branchId', v ?? undefined)} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-40" />
            <Combobox value={f['leaveTypeId'] ?? null} onChange={(v) => table.setFilter('leaveTypeId', v ?? undefined)} options={types.options} loading={types.isLoading} clearable placeholder={t('fields.leaveType')} className="h-8 w-40" />
            <Select value={f['status'] ?? ALL} onValueChange={(v) => table.setFilter('status', v === ALL ? undefined : v)}>
              <SelectTrigger className="h-8 w-36" aria-label={tc('common.status')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>{t('filters.allStatuses')}</SelectItem>{LEAVE_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`status.${s}`)}</SelectItem>)}</SelectContent>
            </Select>
            <DateRange idPrefix="leave" from={f['from']} to={f['to']} onChange={({ from, to }) => table.update({ filters: { from: from ?? '', to: to ?? '' } })} />
            {hasFilters ? <Button variant="ghost" size="sm" onClick={() => table.update({ filters: { employeeId: '', branchId: '', leaveTypeId: '', status: '', from: '', to: '' } })}><X /> {tc('common.clearFilters')}</Button> : null}
            {canManage ? <Button size="sm" className="ms-auto" onClick={() => setCreateOpen(true)}><Plus /> {t('records.add')}</Button> : null}
          </>
        }
        renderCard={(r) => <div className="space-y-1"><div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{r.employeeName}</span><Badge variant={STATUS_TONE[r.status] ?? 'neutral'}>{t(`status.${r.status}`)}</Badge></div><p className="text-xs text-muted-foreground tnum">{r.leaveTypeName} · {fmtDate(r.startDate)} → {fmtDate(r.endDate)}</p></div>}
      />
      <LeaveRecordDialog key={String(createOpen)} open={createOpen} onOpenChange={setCreateOpen} />
      <ConfirmDialog open={!!cancelling} onOpenChange={(o) => !o && setCancelling(null)} title={t('records.cancelTitle')} description={t('records.cancelHint')} confirmLabel={t('records.cancel')} destructive loading={cancelRecord.isPending}
        onConfirm={() => { if (!cancelling) return; cancelRecord.mutate(cancelling.id, { onSuccess: (r) => { if (r.recalculationJobId) toastJobQueued(r.recalculationJobId, navigate, t('records.recalcHint'), { to: '/attendance?tab=recalc' }); else toast.success(t('records.cancelled')); setCancelling(null); }, onError: (e) => toastMutationError(e, navigate) }); }} />
    </>
  );
}

function TypesTab() {
  const { t } = useTranslation('leave');
  const { t: tc } = useTranslation();
  const can = useCan();
  const canManage = can('leave.manage');
  const q = useLeaveTypes();
  const { updateType, removeType } = useLeaveMutations();
  const [dialog, setDialog] = useState<{ open: boolean; leaveType: LeaveTypeDto | null }>({ open: false, leaveType: null });
  const [deleting, setDeleting] = useState<LeaveTypeDto | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2"><p className="text-sm text-muted-foreground">{t('types.hint')}</p>{canManage ? <Button size="sm" onClick={() => setDialog({ open: true, leaveType: null })}><Plus /> {t('types.add')}</Button> : null}</div>
      <div className="rounded-lg border bg-card shadow-card">
        {q.isError ? <div className="p-4"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>
          : q.isLoading ? <TableSkeleton cols={4} rows={3} />
          : !q.data || q.data.length === 0 ? <div className="p-4"><EmptyState icon={CalendarOff} title={t('types.empty')} description={t('types.emptyHint')} action={canManage ? <Button onClick={() => setDialog({ open: true, leaveType: null })}><Plus /> {t('types.add')}</Button> : undefined} /></div>
          : (
            <Table>
              <TableHeader><TableRow><TableHead>{tc('common.code')}</TableHead><TableHead>{tc('common.name')}</TableHead><TableHead>{t('fields.isPaid')}</TableHead><TableHead>{tc('common.status')}</TableHead><TableHead className="text-end">{tc('common.actions')}</TableHead></TableRow></TableHeader>
              <TableBody>
                {q.data.map((lt) => (
                  <TableRow key={lt.id}>
                    <TableCell><span className="flex items-center gap-2 font-mono text-xs" dir="ltr"><span className="size-2.5 rounded-full" style={{ backgroundColor: lt.color ?? '#94a3b8' }} aria-hidden />{lt.code}</span></TableCell>
                    <TableCell><p className="font-medium">{lt.name}</p>{lt.nameAr ? <p className="text-xs text-muted-foreground" dir="rtl">{lt.nameAr}</p> : null}</TableCell>
                    <TableCell>{lt.isPaid ? <Badge variant="success">{t('types.paid')}</Badge> : <Badge variant="outline">{t('types.unpaid')}</Badge>}</TableCell>
                    <TableCell><Badge variant={lt.status === 'active' ? 'success' : 'neutral'} dot>{t(`recordStatus.${lt.status}`, { defaultValue: lt.status })}</Badge></TableCell>
                    <TableCell>{canManage ? <RowActions actions={[{ key: 'edit', label: tc('common.edit'), icon: <Pencil />, onSelect: () => setDialog({ open: true, leaveType: lt }) }, { key: 'toggle', label: lt.status === 'active' ? t('types.deactivate') : t('types.activate'), onSelect: () => updateType.mutate({ id: lt.id, input: { status: lt.status === 'active' ? 'inactive' : 'active' } }, { onSuccess: () => toast.success(t('types.updated')), onError: toastError }) }, { key: 'delete', label: tc('common.delete'), icon: <Trash2 />, destructive: true, onSelect: () => setDeleting(lt) }]} /> : null}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </div>
      <LeaveTypeDialog key={`${dialog.open}-${dialog.leaveType?.id ?? 'new'}`} open={dialog.open} onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))} leaveType={dialog.leaveType} />
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={t('types.deleteTitle', { name: deleting?.name ?? '' })} description={t('types.deleteHint')} confirmLabel={tc('common.delete')} destructive loading={removeType.isPending}
        onConfirm={() => { if (!deleting) return; removeType.mutate(deleting.id, { onSuccess: () => { toast.success(t('types.deleted')); setDeleting(null); }, onError: toastError }); }} />
    </div>
  );
}

/** /leave?tab=records|types */
export default function LeavePage() {
  const { t } = useTranslation('leave');
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'records';
  return (
    <div className="page-container">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList aria-label={t('title')}>{TABS.map((tb) => <TabsTrigger key={tb} value={tb}>{t(`tabs.${tb}`)}</TabsTrigger>)}</TabsList>
        <TabsContent value="records">{tab === 'records' ? <RecordsTab /> : null}</TabsContent>
        <TabsContent value="types">{tab === 'types' ? <TypesTab /> : null}</TabsContent>
      </Tabs>
    </div>
  );
}
