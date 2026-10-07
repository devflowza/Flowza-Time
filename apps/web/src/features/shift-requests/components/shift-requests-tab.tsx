import { useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Inbox, X } from 'lucide-react';
import { SHIFT_CHANGE_KINDS, SHIFT_CHANGE_STATUSES, type ShiftChangeRequestDto } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { useEmployeeOptions } from '@/features/employees/api';
import { useBranchOptions } from '@/features/organization/lookups';
import { useTabTable } from '@/features/organization/use-tab-table';
import { SR_NS } from '../i18n';
import { useShiftChangeRequests } from '../api';
import { RangeText, ShiftChangeKindBadge, ShiftChangeStatusBadge, ShiftsText } from './parts';

const ALL = '__all__';
const FILTERS = ['status', 'kind', 'employeeId', 'from', 'to'] as const;

/**
 * Shifts → Shift requests (Enterprise, module shift_requests; attendance.view): the employees' shift change and additional shift
 * requests, filtered by status, kind, employee and dates (the API reads them under the caller's branch scope). Deciding happens in
 * the approvals inbox — every row links to its request there.
 */
export function ShiftRequestsTab() {
  const { t } = useTranslation(SR_NS);
  const { t: tc } = useTranslation();
  const table = useTabTable();
  const f = table.state.filters;
  const query = useMemo(() => ({ page: table.state.page, pageSize: table.state.pageSize, status: f['status'], kind: f['kind'], employeeId: f['employeeId'], from: f['from'], to: f['to'] }), [table.state.page, table.state.pageSize, f]);
  const q = useShiftChangeRequests(query);
  const employees = useEmployeeOptions();
  const branches = useBranchOptions();
  const hasFilters = FILTERS.some((k) => !!f[k]);
  // the selected employee keeps its label while the search lists others
  const employeeOptions = useMemo(() => {
    const selected = f['employeeId'] ? (q.data?.data ?? []).find((r) => r.employeeId === f['employeeId']) : undefined;
    const base = employees.options;
    return selected && !base.some((o) => o.value === selected.employeeId) ? [{ value: selected.employeeId, label: selected.employeeName ?? '—', description: selected.employeeNumber ?? undefined }, ...base] : base;
  }, [employees.options, f, q.data]);

  const columns = useMemo<ColumnDef<ShiftChangeRequestDto, unknown>[]>(() => [
    { id: 'employee', header: t('columns.employee'), cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium" dir="auto">{row.original.employeeName ?? '—'}</p><p className="font-mono text-xs text-muted-foreground" dir="ltr">{row.original.employeeNumber ?? ''}{row.original.branchId ? ` · ${branches.byId.get(row.original.branchId)?.name ?? ''}` : ''}</p></div> },
    { id: 'dates', header: t('columns.dates'), cell: ({ row }) => <RangeText from={row.original.fromDate} to={row.original.toDate} /> },
    { id: 'kind', header: t('columns.kind'), cell: ({ row }) => <ShiftChangeKindBadge kind={row.original.kind} /> },
    { id: 'shifts', header: t('columns.shifts'), cell: ({ row }) => <span className="text-xs"><ShiftsText r={row.original} /></span> },
    { id: 'status', header: t('columns.status'), cell: ({ row }) => <ShiftChangeStatusBadge status={row.original.status} /> },
    { id: 'decision', header: t('columns.decision'), cell: ({ row }) => <div className="max-w-[260px] text-xs"><span className="block truncate" title={row.original.reason} dir="auto">{row.original.reason}</span>{row.original.decisionNote ? <span className="block truncate text-muted-foreground" title={row.original.decisionNote} dir="auto">{row.original.decisionNote}</span> : null}</div> },
    { id: 'actions', header: '', cell: ({ row }) => row.original.approvalRequestId ? <Button variant="ghost" size="sm" asChild><Link to={`/approvals/requests/${row.original.approvalRequestId}`}><ExternalLink /> {t('hr.openRequest')}</Link></Button> : null },
  ], [t, branches.byId]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('hr.description')}</p>
        <Button variant="outline" size="sm" asChild><Link to="/approvals"><Inbox /> {t('hr.openInbox')}</Link></Button>
      </div>
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="shift-change-requests"
        emptyTitle={t('empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('hr.emptyHint')}
        toolbar={
          <>
            <Select value={f['status'] ?? ALL} onValueChange={(v) => table.setFilter('status', v === ALL ? undefined : v)}>
              <SelectTrigger className="h-8 w-36" aria-label={t('columns.status')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>{t('hr.allStatuses')}</SelectItem>{SHIFT_CHANGE_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`status.${s}`)}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={f['kind'] ?? ALL} onValueChange={(v) => table.setFilter('kind', v === ALL ? undefined : v)}>
              <SelectTrigger className="h-8 w-40" aria-label={t('columns.kind')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>{t('hr.allKinds')}</SelectItem>{SHIFT_CHANGE_KINDS.map((k) => <SelectItem key={k} value={k}>{t(`kinds.${k}`)}</SelectItem>)}</SelectContent>
            </Select>
            <Combobox value={f['employeeId'] ?? null} onChange={(v) => table.setFilter('employeeId', v ?? undefined)} onSearch={employees.setSearch} options={employeeOptions} loading={employees.isLoading} clearable placeholder={t('hr.employee')} className="h-8 w-48" />
            <div className="flex items-center gap-1"><Label htmlFor="sr-from" className="text-xs text-muted-foreground">{t('hr.from')}</Label><Input id="sr-from" type="date" dir="ltr" className="h-8 w-[150px]" value={f['from'] ?? ''} onChange={(e) => table.setFilter('from', e.target.value || undefined)} /></div>
            <div className="flex items-center gap-1"><Label htmlFor="sr-to" className="text-xs text-muted-foreground">{t('hr.to')}</Label><Input id="sr-to" type="date" dir="ltr" className="h-8 w-[150px]" value={f['to'] ?? ''} onChange={(e) => table.setFilter('to', e.target.value || undefined)} /></div>
            {hasFilters ? <Button variant="ghost" size="sm" onClick={() => table.update({ filters: { status: '', kind: '', employeeId: '', from: '', to: '' } })}><X /> {tc('common.clearFilters')}</Button> : null}
          </>
        }
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2"><span className="truncate font-medium" dir="auto">{r.employeeName ?? '—'}</span><ShiftChangeStatusBadge status={r.status} /></div>
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><RangeText from={r.fromDate} to={r.toDate} /><ShiftChangeKindBadge kind={r.kind} /><ShiftsText r={r} /></p>
          </div>
        )}
      />
    </div>
  );
}
