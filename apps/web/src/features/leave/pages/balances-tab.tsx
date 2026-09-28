import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { Download, X } from 'lucide-react';
import type { LeaveBalanceDto } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { todayIso } from '@/lib/format';
import { toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useCan, useOrgId, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { useTabTable } from '@/features/organization/use-tab-table';
import { SearchBox } from '@/features/organization/components/search-box';
import { downloadLeaveBalances, useLeaveBalances } from '../api';
import type { EmployeeLeaveBalancesDto } from '../types';
import { fmtLeaveDays } from '../model';
import { LeaveTypeDot } from '../components/leave-status';

/** One balance cell: available of the entitlement, with pending and an expiring carry-forward underneath. */
function BalanceCell({ b }: { b: LeaveBalanceDto | undefined }) {
  const { t } = useTranslation('leave');
  if (!b) return <span className="text-xs text-muted-foreground">—</span>;
  if (!b.tracked) return <span className="text-xs text-muted-foreground tnum">{b.takenDays > 0 ? t('balances.takenOnly', { days: fmtLeaveDays(b.takenDays) }) : '—'}</span>;
  const low = b.availableAfterPendingDays !== null && b.availableAfterPendingDays < 0;
  return (
    <div className="text-xs tnum">
      <span className={cn('font-semibold', low && 'text-destructive')}>{fmtLeaveDays(b.availableDays)}</span>
      <span className="text-muted-foreground"> / {fmtLeaveDays(b.entitlementDays)}</span>
      {b.pendingDays > 0 ? <span className="block text-amber-700 dark:text-amber-300">{t('balances.pendingShort', { days: fmtLeaveDays(b.pendingDays) })}</span> : null}
      {b.carriedForwardDays > 0 && b.carriedForwardExpiresOn ? <span className="block text-muted-foreground">{t('balances.cfShort', { days: fmtLeaveDays(b.carriedForwardDays), date: b.carriedForwardExpiresOn })}</span> : null}
    </div>
  );
}

/**
 * Balances of every employee in scope for a year, computed by the one balance function (allocation rows, the types' yearly
 * allowance, accrual, carry-forward and its expiry, taken and pending leave). CSV export for report.export holders.
 */
export function BalancesTab() {
  const { t } = useTranslation('leave');
  const { t: tc } = useTranslation();
  const orgId = useOrgId();
  const tz = useOrgTimezone();
  const can = useCan();
  const thisYear = Number(todayIso(tz).slice(0, 4));
  const table = useTabTable();
  const f = table.state.filters;
  const year = Number(f['year']) || thisYear;
  const query = useMemo(() => ({ page: table.state.page, pageSize: table.state.pageSize, year, branchId: f['branchId'], search: f['search'] }), [table.state.page, table.state.pageSize, year, f]);
  const q = useLeaveBalances(query);
  const branches = useBranchOptions();
  const [exporting, setExporting] = useState(false);
  const rows = q.data?.data;
  // a column per type that someone on the page tracks or used (the type catalogue order: as the API returns it)
  const typeColumns = useMemo(() => {
    const seen = new Map<string, LeaveBalanceDto>();
    for (const e of rows ?? []) for (const b of e.balances) if ((b.tracked || b.takenDays > 0 || b.pendingDays > 0) && !seen.has(b.leaveTypeId)) seen.set(b.leaveTypeId, b);
    return [...seen.values()];
  }, [rows]);
  const columns = useMemo<ColumnDef<EmployeeLeaveBalancesDto, unknown>[]>(() => [
    { id: 'employee', header: t('fields.employee'), cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.employeeName}</p><p className="font-mono text-xs text-muted-foreground" dir="ltr">{row.original.employeeNumber}</p></div> },
    ...typeColumns.map<ColumnDef<EmployeeLeaveBalancesDto, unknown>>((tc0) => ({
      id: tc0.leaveTypeId,
      header: () => <span className="flex items-center gap-1.5" title={tc0.name}><LeaveTypeDot color={tc0.color} />{tc0.code}</span>,
      cell: ({ row }) => <BalanceCell b={row.original.balances.find((b) => b.leaveTypeId === tc0.leaveTypeId)} />,
    })),
  ], [t, typeColumns]);
  const years = [thisYear + 1, thisYear, thisYear - 1, thisYear - 2];
  const hasFilters = !!f['branchId'] || !!f['search'];
  const exportCsv = async () => {
    setExporting(true);
    try { await downloadLeaveBalances(orgId, { year, branchId: f['branchId'], search: f['search'] }); } catch (e) { toastError(e); } finally { setExporting(false); }
  };
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{t('balances.hint')}</p>
      <DataTable
        columns={columns} data={rows} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()}
        emptyTitle={t('balances.empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('balances.emptyHint')}
        toolbar={
          <>
            <Select value={String(year)} onValueChange={(v) => table.setFilter('year', v)}>
              <SelectTrigger className="h-8 w-28" aria-label={t('balances.year')}><SelectValue /></SelectTrigger>
              <SelectContent>{years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
            </Select>
            <SearchBox id="leave-balances-search" value={f['search']} onChange={(v) => table.setFilter('search', v)} placeholder={t('balances.search')} className="relative w-full sm:w-56" />
            <Combobox value={f['branchId'] ?? null} onChange={(v) => table.setFilter('branchId', v ?? undefined)} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-40" />
            {hasFilters ? <Button variant="ghost" size="sm" onClick={() => table.update({ filters: { branchId: '', search: '' } })}><X /> {tc('common.clearFilters')}</Button> : null}
            {can('report.export') ? <Button size="sm" variant="outline" className="ms-auto" loading={exporting} onClick={() => void exportCsv()}><Download /> {t('balances.export')}</Button> : null}
          </>
        }
        renderCard={(e) => (
          <div className="space-y-1.5">
            <p className="font-medium">{e.employeeName} <span className="font-mono text-xs text-muted-foreground" dir="ltr">{e.employeeNumber}</span></p>
            <div className="grid grid-cols-2 gap-2">{typeColumns.map((c) => <div key={c.leaveTypeId} className="rounded-md border p-2"><p className="flex items-center gap-1.5 text-xs font-medium"><LeaveTypeDot color={c.color} />{c.name}</p><BalanceCell b={e.balances.find((b) => b.leaveTypeId === c.leaveTypeId)} /></div>)}</div>
          </div>
        )}
      />
    </div>
  );
}
