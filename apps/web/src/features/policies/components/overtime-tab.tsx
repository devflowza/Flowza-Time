import { useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import type { OvertimeSummaryRowDto } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { Input } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtMinutes, todayIso } from '@/lib/format';
import { useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions, useDepartmentOptions } from '@/features/organization/lookups';
import { useTabTable } from '@/features/organization/use-tab-table';
import { POLICIES_NS } from '../i18n';
import { useEmployeeGroupOptions, useOvertimeSummary } from '../api';

const minutes = (m: number) => (m === 0 ? '—' : fmtMinutes(m));

/**
 * The overtime summary of a month under each employee's policy: overtime by category, weekly overtime (ISO weeks whose Sunday
 * is in the month, net of the daily overtime) and the weighted minutes the payroll export multiplies by the hourly wage.
 */
export function OvertimeTab() {
  const { t } = useTranslation(POLICIES_NS);
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const table = useTabTable();
  const f = table.state.filters;
  const month = f['month'] && /^\d{4}-\d{2}$/.test(f['month']) ? f['month'] : todayIso(tz).slice(0, 7);
  const branches = useBranchOptions();
  const departments = useDepartmentOptions(f['branchId'] ?? null);
  const groups = useEmployeeGroupOptions();
  const query = useMemo(() => ({ page: table.state.page, pageSize: table.state.pageSize, month, branchId: f['branchId'], departmentId: f['departmentId'], employeeGroupId: f['employeeGroupId'], search: f['search'] }), [table.state.page, table.state.pageSize, month, f]);
  const q = useOvertimeSummary(query);

  const columns = useMemo<ColumnDef<OvertimeSummaryRowDto, unknown>[]>(() => [
    { id: 'employee', header: t('overtime.employee'), cell: ({ row }) => <div><p className="font-medium">{row.original.displayName}</p><p className="text-xs text-muted-foreground tnum">{row.original.employeeNumber}</p></div> },
    { id: 'policy', header: t('overtime.policy'), cell: ({ row }) => <span className="text-xs">{row.original.policyName ?? t('overtime.defaults')}</span> },
    { id: 'worked', header: t('overtime.worked'), cell: ({ row }) => <span className="tnum">{minutes(row.original.workedMinutes)}</span> },
    { id: 'regular', header: t('overtime.regular'), cell: ({ row }) => <span className="tnum">{minutes(row.original.regularOvertimeMinutes)}</span> },
    { id: 'weekly', header: t('overtime.weekly'), cell: ({ row }) => <span className="tnum">{minutes(row.original.weeklyOvertimeMinutes)}</span> },
    { id: 'weeklyOff', header: t('overtime.weeklyOff'), cell: ({ row }) => <span className="tnum">{minutes(row.original.weeklyOffOvertimeMinutes)}</span> },
    { id: 'holiday', header: t('overtime.holiday'), cell: ({ row }) => <span className="tnum">{minutes(row.original.holidayOvertimeMinutes)}</span> },
    { id: 'weighted', header: t('overtime.weighted'), cell: ({ row }) => <span className="font-semibold tnum">{minutes(row.original.weightedOvertimeMinutes)}</span> },
    { id: 'overMax', header: t('overtime.daysOverMax'), cell: ({ row }) => <span className={row.original.daysOverDailyMaximum ? 'font-medium text-amber-700 tnum dark:text-amber-300' : 'tnum text-muted-foreground'}>{row.original.daysOverDailyMaximum}</span> },
  ], [t]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('overtime.hint')}</p>
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()}
        getRowId={(r) => r.employeeId} emptyTitle={t('overtime.empty')} emptyDescription={t('overtime.emptyHint')}
        toolbar={
          <>
            <Input type="month" dir="ltr" value={month} onChange={(e) => /^\d{4}-\d{2}$/.test(e.target.value) && table.setFilter('month', e.target.value)} className="h-8 w-40" aria-label={t('overtime.month')} />
            <Combobox value={f['branchId'] ?? null} onChange={(v) => table.setFilter('branchId', v ?? undefined)} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-40" />
            <Combobox value={f['departmentId'] ?? null} onChange={(v) => table.setFilter('departmentId', v ?? undefined)} options={departments.options} loading={departments.isLoading} clearable placeholder={tc('common.department')} className="h-8 w-40" />
            <Combobox value={f['employeeGroupId'] ?? null} onChange={(v) => table.setFilter('employeeGroupId', v ?? undefined)} options={groups.options} loading={groups.isLoading} clearable placeholder={t('overtime.group')} className="h-8 w-40" />
            <Input value={f['search'] ?? ''} onChange={(e) => table.setFilter('search', e.target.value || undefined)} placeholder={tc('common.searchPlaceholder')} aria-label={tc('common.search')} className="h-8 w-44" />
          </>
        }
        renderCard={(r) => <div className="flex items-center justify-between gap-2"><div className="min-w-0"><p className="truncate text-sm font-medium">{r.displayName}</p><p className="text-xs text-muted-foreground">{r.policyName ?? t('overtime.defaults')}</p></div><span className="font-semibold tnum">{minutes(r.weightedOvertimeMinutes)}</span></div>}
      />
    </div>
  );
}
