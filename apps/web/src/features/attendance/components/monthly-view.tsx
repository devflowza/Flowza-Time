import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { CalendarRange, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Button, EmptyState, ErrorState, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDate, todayIso } from '@/lib/format';
import { useActiveMembership, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions, useDepartmentOptions } from '@/features/organization/lookups';
import { SearchBox } from '@/features/organization/components/search-box';
import { useTabTable } from '@/features/organization/use-tab-table';
import { useEmployeeOptions } from '@/features/employees/api';
import { useMonthlyAttendance } from '../api';
import { shiftMonth } from '../status';
import { MonthlyGrid, MonthlyLegend } from './monthly-grid';
import { RecordDialog, type CorrectionPreset } from './record-dialog';

const PAGE_SIZES = [25, 50, 100];

export function MonthlyView({ onRequestCorrection }: { onRequestCorrection?: (preset: CorrectionPreset) => void }) {
  const { t } = useTranslation('attendance');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const weeklyOff = useActiveMembership()?.organization.weeklyOffDays ?? [];
  const table = useTabTable({ pageSize: 50 });
  const f = table.state.filters;
  const currentMonth = todayIso(tz).slice(0, 7);
  const month = f['month'] && /^\d{4}-\d{2}$/.test(f['month']) ? f['month'] : currentMonth;
  const pageSize = Math.min(table.state.pageSize, 100);
  const query = useMemo(() => ({ month, page: table.state.page, pageSize, employeeId: f['employeeId'], branchId: f['branchId'], departmentId: f['departmentId'], search: f['search'] }), [month, table.state.page, pageSize, f]);
  const q = useMonthlyAttendance(query);
  const branches = useBranchOptions();
  const departments = useDepartmentOptions(f['branchId']);
  const employees = useEmployeeOptions();
  const [recordId, setRecordId] = useState<string | null>(null);
  const hasFilters = ['employeeId', 'branchId', 'departmentId', 'search'].some((k) => !!f[k]);
  const setMonth = (m: string) => table.update({ filters: { month: m === currentMonth ? '' : m } });
  const days = q.data?.meta.days ?? [];
  const total = q.data?.meta.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const employeeOptions = useMemo(() => {
    const id = f['employeeId'];
    return id && !employees.options.some((o) => o.value === id) ? [{ value: id, label: t('monthly.selectedEmployee') }, ...employees.options] : employees.options;
  }, [employees.options, f, t]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border bg-card p-0.5">
          <Button variant="ghost" size="icon" className="size-8" aria-label={t('monthly.previousMonth')} onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft className="rtl:rotate-180" /></Button>
          <Input type="month" value={month} onChange={(e) => /^\d{4}-\d{2}$/.test(e.target.value) && setMonth(e.target.value)} className="h-8 w-[150px] border-0 shadow-none" dir="ltr" aria-label={t('monthly.month')} />
          <Button variant="ghost" size="icon" className="size-8" aria-label={t('monthly.nextMonth')} onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight className="rtl:rotate-180" /></Button>
        </div>
        <Button variant="outline" size="sm" onClick={() => setMonth(currentMonth)} disabled={month === currentMonth}><CalendarRange /> {t('monthly.thisMonth')}</Button>
        <p className="text-sm text-muted-foreground">{fmtDate(`${month}-01`, 'MMMM yyyy')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox id="att-monthly-search" value={f['search']} onChange={(v) => table.setFilter('search', v)} placeholder={t('daily.searchPlaceholder')} />
        <Combobox value={f['employeeId'] ?? null} onChange={(v) => table.setFilter('employeeId', v ?? undefined)} options={employeeOptions} onSearch={employees.setSearch} loading={employees.isLoading} clearable placeholder={t('columns.employee')} className="h-8 w-48" />
        <Combobox value={f['branchId'] ?? null} onChange={(v) => table.update({ filters: { branchId: v ?? '', departmentId: '' } })} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-40" />
        <Combobox value={f['departmentId'] ?? null} onChange={(v) => table.setFilter('departmentId', v ?? undefined)} options={departments.options} loading={departments.isLoading} clearable placeholder={tc('common.department')} className="h-8 w-40" />
        {hasFilters ? <Button variant="ghost" size="sm" onClick={() => table.update({ filters: { employeeId: '', branchId: '', departmentId: '', search: '' } })}><X /> {tc('common.clearFilters')}</Button> : null}
      </div>
      <MonthlyLegend />
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        : q.isLoading && !q.data ? <div className="space-y-2 rounded-lg border bg-card p-4" aria-busy>{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
        : q.data && q.data.data.length === 0 ? <EmptyState title={t('monthly.empty')} description={hasFilters ? tc('common.noResultsHint') : t('monthly.emptyHint')} />
        : q.data ? (
          <div className={q.isFetching ? 'opacity-70 transition-opacity' : undefined}>
            <MonthlyGrid rows={q.data.data} days={days} weeklyOffDays={weeklyOff} onOpenRecord={setRecordId} onOpenEmployee={(id) => navigate(`/employees/${id}`)} />
          </div>
        ) : null}
      <div className="flex flex-col items-center justify-between gap-2 text-sm text-muted-foreground sm:flex-row">
        <div className="flex items-center gap-2">
          <span>{tc('common.rowsPerPage')}</span>
          <Select value={String(pageSize)} onValueChange={(v) => table.setPageSize(Number(v))}>
            <SelectTrigger className="h-8 w-[76px]"><SelectValue /></SelectTrigger>
            <SelectContent>{PAGE_SIZES.map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
          </Select>
          <span className="tnum">{t('monthly.employeeCount', { count: total })}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={table.state.page <= 1} onClick={() => table.setPage(table.state.page - 1)}>{tc('common.previous')}</Button>
          <span className="tnum">{tc('common.pageOf', { page: table.state.page, total: totalPages })}</span>
          <Button variant="outline" size="sm" disabled={table.state.page >= totalPages} onClick={() => table.setPage(table.state.page + 1)}>{tc('common.next')}</Button>
        </div>
      </div>
      <RecordDialog recordId={recordId} onClose={() => setRecordId(null)} onRequestCorrection={onRequestCorrection ? (p) => { setRecordId(null); onRequestCorrection(p); } : undefined} />
    </div>
  );
}

