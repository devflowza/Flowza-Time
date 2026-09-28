import { useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { ArrowLeft, CalendarRange, ChevronLeft, ChevronRight, FileSpreadsheet, Printer, X } from 'lucide-react';
import type { AttendanceSummaryRowDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Badge, Button, Input, StatCard } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { useServerTable } from '@/hooks/use-server-table';
import { fmtDate, fmtDateTime, todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions, useDepartmentOptions } from '@/features/organization/lookups';
import { SearchBox } from '@/features/organization/components/search-box';
import { useEmployeeOptions } from '@/features/employees/api';
import '../workspace-i18n';
import { saveTextFile, useAttendanceSummary, useWorkspaceMutations } from '../workspace-api';
import { fmtDays, fmtHm, shiftMonth } from '../status';

const num = (n: number) => <span className="tnum">{fmtDays(n)}</span>;

/**
 * /attendance/summary (HR portal Prompt 6a): one row per employee for a month — present (a half day counts ½), late, half days,
 * leave, absent, missing punch, holidays, weekly offs, days worked, hours, average per worked day, overtime and loss of pay.
 * Figures come from the daily records the caller may read (attendance.view, or their team with attendance.view_team); a month
 * whose payroll period is finalised shows the finalised day counts. The CSV export needs report.export.
 */
export default function AttendanceSummaryPage() {
  const { t } = useTranslation('attendanceWorkspace');
  const { t: ta } = useTranslation('attendance');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const can = useCan();
  const navigate = useNavigate();
  const table = useServerTable({ pageSize: 50 });
  const f = table.state.filters;
  const currentMonth = todayIso(tz).slice(0, 7);
  const month = f['month'] && /^\d{4}-\d{2}$/.test(f['month']) ? f['month'] : currentMonth;
  const pageSize = Math.min(table.state.pageSize, 200);
  const filters = useMemo(() => ({ month, employeeId: f['employeeId'], branchId: f['branchId'], departmentId: f['departmentId'], search: f['search'] }), [month, f]);
  const q = useAttendanceSummary({ ...filters, page: table.state.page, pageSize });
  const { exportSummary } = useWorkspaceMutations();
  const branches = useBranchOptions();
  const departments = useDepartmentOptions(f['branchId']);
  const employees = useEmployeeOptions();
  const canExport = can('report.export');
  const hasFilters = ['employeeId', 'branchId', 'departmentId', 'search'].some((k) => !!f[k]);
  const totals = q.data?.meta.totals;
  const setMonth = (m: string) => table.update({ filters: { month: m === currentMonth ? '' : m } });
  const employeeOptions = useMemo(() => {
    const id = f['employeeId'];
    return id && !employees.options.some((o) => o.value === id) ? [{ value: id, label: ta('monthly.selectedEmployee') }, ...employees.options] : employees.options;
  }, [employees.options, f, ta]);
  const doExport = () => exportSummary.mutate(filters, {
    onSuccess: (file) => { saveTextFile(file); toast.success(t('summary.exported', { count: file.rowCount })); },
    onError: toastError,
  });

  const columns = useMemo<ColumnDef<AttendanceSummaryRowDto, unknown>[]>(() => [
    { id: 'employee', header: ta('columns.employee'), enableSorting: false, cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.employeeName}</p><p className="truncate text-xs text-muted-foreground"><span className="font-mono" dir="ltr">{row.original.employeeNumber}</span>{row.original.departmentName ? ` · ${row.original.departmentName}` : row.original.branchName ? ` · ${row.original.branchName}` : ''}</p></div> },
    { id: 'present', header: t('summary.columns.present'), enableSorting: false, cell: ({ row }) => num(row.original.presentDays) },
    { id: 'late', header: t('summary.columns.late'), enableSorting: false, cell: ({ row }) => <span className={row.original.lateDays ? 'tnum text-amber-700 dark:text-amber-300' : 'tnum'}>{fmtDays(row.original.lateDays)}</span> },
    { id: 'half', header: t('summary.columns.half'), enableSorting: false, cell: ({ row }) => num(row.original.halfDays) },
    { id: 'leave', header: t('summary.columns.leave'), enableSorting: false, cell: ({ row }) => num(row.original.leaveDays) },
    { id: 'absent', header: t('summary.columns.absent'), enableSorting: false, cell: ({ row }) => <span className={row.original.absentDays ? 'tnum text-red-700 dark:text-red-300' : 'tnum'}>{fmtDays(row.original.absentDays)}</span> },
    { id: 'missing', header: t('summary.columns.missing'), enableSorting: false, cell: ({ row }) => num(row.original.missingPunchDays) },
    { id: 'holiday', header: t('summary.columns.holiday'), enableSorting: false, cell: ({ row }) => num(row.original.holidayDays) },
    { id: 'weeklyOff', header: t('summary.columns.weeklyOff'), enableSorting: false, cell: ({ row }) => num(row.original.weeklyOffDays) },
    { id: 'daysWorked', header: t('summary.columns.daysWorked'), enableSorting: false, cell: ({ row }) => num(row.original.daysWorked) },
    { id: 'worked', header: t('summary.columns.worked'), enableSorting: false, cell: ({ row }) => <span className="tnum">{fmtHm(row.original.workedMinutes)}</span> },
    { id: 'average', header: t('summary.columns.average'), enableSorting: false, cell: ({ row }) => <span className="tnum">{fmtHm(row.original.averageWorkedMinutes)}</span> },
    { id: 'overtime', header: t('summary.columns.overtime'), enableSorting: false, cell: ({ row }) => <span className={row.original.overtimeMinutes ? 'tnum text-blue-700 dark:text-blue-300' : 'tnum'}>{fmtHm(row.original.overtimeMinutes)}</span> },
    { id: 'lop', header: t('summary.columns.lop'), enableSorting: false, cell: ({ row }) => num(row.original.lopDays) },
    { id: 'source', header: t('summary.columns.source'), enableSorting: false, cell: ({ row }) => row.original.source === 'FINALIZED' ? <Badge variant="success" title={row.original.finalizedAt ? fmtDateTime(row.original.finalizedAt, tz) : undefined}>{t('summary.finalized')}</Badge> : <Badge variant="outline">{t('summary.live')}</Badge> },
    { id: 'actions', header: '', enableSorting: false, enableHiding: false, cell: ({ row }) => <Button asChild variant="ghost" size="icon" className="size-7"><Link to={`/attendance/print?employeeId=${row.original.employeeId}&month=${month}`} onClick={(e) => e.stopPropagation()} aria-label={t('print.open')} title={t('print.open')}><Printer /></Link></Button> },
  ], [t, ta, tz, month]);

  return (
    <div className="page-container space-y-4">
      <PageHeader
        title={t('summary.title')} description={t('summary.subtitle')}
        breadcrumbs={<Link to="/attendance" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3 rtl:rotate-180" /> {ta('title')}</Link>}
        actions={canExport ? <Button variant="outline" size="sm" onClick={doExport} loading={exportSummary.isPending} data-testid="summary-export"><FileSpreadsheet /> {t('summary.export')}</Button> : null}
      />
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border bg-card p-0.5">
          <Button variant="ghost" size="icon" className="size-8" aria-label={ta('monthly.previousMonth')} onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft className="rtl:rotate-180" /></Button>
          <Input type="month" value={month} onChange={(e) => /^\d{4}-\d{2}$/.test(e.target.value) && setMonth(e.target.value)} className="h-8 w-[150px] border-0 shadow-none" dir="ltr" aria-label={ta('monthly.month')} />
          <Button variant="ghost" size="icon" className="size-8" aria-label={ta('monthly.nextMonth')} onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight className="rtl:rotate-180" /></Button>
        </div>
        <Button variant="outline" size="sm" onClick={() => setMonth(currentMonth)} disabled={month === currentMonth}><CalendarRange /> {ta('monthly.thisMonth')}</Button>
        <p className="text-sm text-muted-foreground">{q.data?.meta.from && q.data.meta.to ? `${fmtDate(q.data.meta.from)} → ${fmtDate(q.data.meta.to)}` : fmtDate(`${month}-01`, 'MMMM yyyy')}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8" data-testid="summary-totals">
        <StatCard label={t('summary.columns.present')} value={fmtDays(totals?.presentDays ?? 0)} tone="success" loading={q.isLoading} />
        <StatCard label={t('summary.columns.late')} value={fmtDays(totals?.lateDays ?? 0)} tone="warning" loading={q.isLoading} />
        <StatCard label={t('summary.columns.absent')} value={fmtDays(totals?.absentDays ?? 0)} tone="danger" loading={q.isLoading} />
        <StatCard label={t('summary.columns.leave')} value={fmtDays(totals?.leaveDays ?? 0)} tone="info" loading={q.isLoading} />
        <StatCard label={t('summary.columns.missing')} value={fmtDays(totals?.missingPunchDays ?? 0)} tone="warning" loading={q.isLoading} />
        <StatCard label={t('summary.columns.worked')} value={fmtHm(totals?.workedMinutes ?? 0)} loading={q.isLoading} />
        <StatCard label={t('summary.columns.overtime')} value={fmtHm(totals?.overtimeMinutes ?? 0)} tone="info" loading={q.isLoading} />
        <StatCard label={t('summary.columns.lop')} value={fmtDays(totals?.lopDays ?? 0)} tone="danger" loading={q.isLoading} />
      </div>
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="attendance-summary"
        onRowClick={(r) => navigate(`/attendance?tab=calendar&employeeId=${r.employeeId}&month=${month}`)}
        emptyTitle={t('summary.empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('summary.emptyHint')}
        toolbar={
          <>
            <SearchBox id="att-summary-search" value={f['search']} onChange={(v) => table.setFilter('search', v)} placeholder={ta('daily.searchPlaceholder')} />
            <Combobox value={f['employeeId'] ?? null} onChange={(v) => table.setFilter('employeeId', v ?? undefined)} options={employeeOptions} onSearch={employees.setSearch} loading={employees.isLoading} clearable placeholder={ta('columns.employee')} className="h-8 w-48" />
            <Combobox value={f['branchId'] ?? null} onChange={(v) => table.update({ filters: { branchId: v ?? '', departmentId: '' } })} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-40" />
            <Combobox value={f['departmentId'] ?? null} onChange={(v) => table.setFilter('departmentId', v ?? undefined)} options={departments.options} loading={departments.isLoading} clearable placeholder={tc('common.department')} className="h-8 w-40" />
            {hasFilters ? <Button variant="ghost" size="sm" onClick={() => table.update({ filters: { employeeId: '', branchId: '', departmentId: '', search: '' } })}><X /> {tc('common.clearFilters')}</Button> : null}
          </>
        }
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{r.employeeName}</span>{r.source === 'FINALIZED' ? <Badge variant="success">{t('summary.finalized')}</Badge> : null}</div>
            <p className="text-xs text-muted-foreground tnum">{t('summary.card', { present: fmtDays(r.presentDays), late: fmtDays(r.lateDays), absent: fmtDays(r.absentDays), leave: fmtDays(r.leaveDays), worked: fmtHm(r.workedMinutes) })}</p>
          </div>
        )}
      />
      <p className="text-xs text-muted-foreground">{t('summary.footnote')}</p>
    </div>
  );
}
