import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { CalendarRange, ChevronLeft, ChevronRight, PencilLine, X } from 'lucide-react';
import type { AttendanceCalendarDayDto, AttendanceCalendarRowDto } from '@flowza/contracts';
import { Button, EmptyState, ErrorState, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDate, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useActiveMembership, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions, useDepartmentOptions } from '@/features/organization/lookups';
import { SearchBox } from '@/features/organization/components/search-box';
import { useTabTable } from '@/features/organization/use-tab-table';
import { useEmployeeOptions } from '@/features/employees/api';
import '../workspace-i18n';
import { useAttendanceCalendar } from '../workspace-api';
import { cellClass, shiftMonth, STATUS_LETTER } from '../status';
import { calendarDayLabel, dotsOf, FINANCE_STATUS_MAPPING, FLAG_DOT, monthWeeks, weekdayOrder, type T } from '../workspace-utils';
import { AttendanceStatusBadge } from './badges';
import { RecordDialog, type CorrectionPreset } from './record-dialog';
import { useWorkspaceDialogs } from './workspace-dialogs';

const PAGE_SIZES = [12, 24, 48];
const LEGEND_STATUSES = ['PRESENT', 'ABSENT', 'LEAVE', 'HALF_DAY', 'HOLIDAY', 'WEEKLY_OFF', 'PENDING'] as const;
/** One legend entry per dot colour (MISSING_IN / MISSING_OUT share red, the two non-working-day flags share violet …). */
const LEGEND_DOTS: Array<{ flag: string; ns: 'attendance' | 'attendanceWorkspace'; key: string }> = [
  { flag: 'LATE', ns: 'attendance', key: 'flags.LATE' },
  { flag: 'EARLY_DEPARTURE', ns: 'attendance', key: 'flags.EARLY_DEPARTURE' },
  { flag: 'MISSING_IN', ns: 'attendance', key: 'monthly.legendMissing' },
  { flag: 'OVERTIME', ns: 'attendance', key: 'flags.OVERTIME' },
  { flag: 'WORKED_ON_HOLIDAY', ns: 'attendance', key: 'flags.NON_WORKING_DAY_WORK' },
  { flag: 'HALF_DAY_LEAVE', ns: 'attendance', key: 'flags.HALF_DAY_LEAVE' },
  { flag: 'UNEXCUSED', ns: 'attendanceWorkspace', key: 'calendar.legendUnexcused' },
  { flag: 'OUTSIDE_GEOFENCE', ns: 'attendance', key: 'flags.OUTSIDE_GEOFENCE' },
];

interface DayProps { date: string; day: AttendanceCalendarDayDto | undefined; label: string; today: boolean; outside: boolean; onOpen?: (recordId: string) => void; onAdd?: (date: string) => void; addLabel: string }

/** One day of an employee's month. Memoised: a page of 12 employees × 31 days re-renders only the cells that changed. */
const CalendarDay = memo(function CalendarDay({ date, day, label, today, outside, onOpen, onAdd, addLabel }: DayProps) {
  const dots = dotsOf(day);
  const body = (
    <span
      className={cn('relative flex h-11 w-full flex-col justify-between rounded-md p-1 text-[11px] leading-none', day ? cellClass(day.status) : 'bg-muted/30 text-muted-foreground', outside && 'opacity-40', today && 'ring-2 ring-primary ring-offset-1 ring-offset-card')}
      data-status={day?.status ?? 'none'} data-day={date} data-source={day?.statusSource ?? undefined} data-today={today || undefined}
    >
      <span className="flex items-start justify-between gap-0.5">
        <span className="font-semibold tnum">{Number(date.slice(8))}</span>
        {day?.statusSource === 'MANUAL' ? <PencilLine className="size-2.5 shrink-0" aria-hidden data-testid="manual-marker" /> : null}
      </span>
      <span className="flex items-end justify-between gap-0.5">
        <span className="flex gap-0.5">{dots.map((c) => <span key={c} className={cn('size-1.5 rounded-full ring-1 ring-card', c)} aria-hidden />)}</span>
        {day ? <span className="text-[10px] font-semibold">{STATUS_LETTER[day.status] ?? ''}</span> : null}
      </span>
    </span>
  );
  const focus = 'block w-full rounded-md text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  if (day && onOpen) return <button type="button" className={cn(focus, 'hover:opacity-85')} title={label} aria-label={label} onClick={() => onOpen(day.recordId)}>{body}</button>;
  if (!day && !outside && onAdd) return <button type="button" className={cn(focus, 'hover:bg-accent')} title={`${label} — ${addLabel}`} aria-label={`${label} — ${addLabel}`} onClick={() => onAdd(date)}>{body}</button>;
  return <div title={label} aria-label={label} role="img">{body}</div>;
});

function EmployeeMonth({ row, weeks, order, today, onOpen, onAdd, onEmployee }: { row: AttendanceCalendarRowDto; weeks: Array<Array<string | null>>; order: number[]; today: string; onOpen: (recordId: string) => void; onAdd?: (employee: AttendanceCalendarRowDto, date: string) => void; onEmployee: (id: string) => void }) {
  const { t } = useTranslation('attendance');
  const { t: tw } = useTranslation('attendanceWorkspace');
  const zone = useOrgTimezone();
  const counts = useMemo(() => {
    const c = { present: 0, absent: 0, leave: 0, late: 0 };
    for (const d of Object.values(row.days)) {
      if (d.status === 'PRESENT') c.present += 1; else if (d.status === 'HALF_DAY') c.present += 0.5;
      if (d.status === 'ABSENT') c.absent += 1;
      if (d.status === 'LEAVE') c.leave += 1;
      if (d.flags.includes('LATE')) c.late += 1;
    }
    return c;
  }, [row.days]);
  const addFor = onAdd ? (date: string) => onAdd(row, date) : undefined;
  return (
    <div className="rounded-lg border bg-card p-3 shadow-card" data-testid="calendar-employee" data-employee={row.employeeId}>
      <div className="mb-2 flex items-start justify-between gap-2">
        <button type="button" className="min-w-0 text-start hover:underline" onClick={() => onEmployee(row.employeeId)}>
          <span className="block truncate text-sm font-medium">{row.employeeName}</span>
          <span className="block font-mono text-[11px] text-muted-foreground" dir="ltr">{row.employeeNumber}</span>
        </button>
        <span className="shrink-0 text-end text-[11px] leading-tight text-muted-foreground tnum">
          {tw('calendar.counts', { present: counts.present, absent: counts.absent, leave: counts.leave })}
          {counts.late ? <span className="block text-amber-700 dark:text-amber-300">{tw('calendar.lateCount', { count: counts.late })}</span> : null}
        </span>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {order.map((dow) => <span key={`h${dow}`} className="text-center text-[10px] font-medium uppercase text-muted-foreground">{fmtDate(`2024-01-${String(7 + dow).padStart(2, '0')}`, 'ccc')}</span>)}
        {weeks.flat().map((date, i) => {
          if (!date) return <span key={`p${i}`} aria-hidden />;
          const day = row.days[date];
          const outside = date > today || date < row.joiningDate || (!!row.exitDate && date > row.exitDate);
          return <CalendarDay key={date} date={date} day={day} label={calendarDayLabel(t as unknown as T, tw as unknown as T, date, day, zone)} today={date === today} outside={outside} onOpen={onOpen} onAdd={addFor} addLabel={tw('calendar.addHint')} />;
        })}
      </div>
    </div>
  );
}

/** Colour legend (statuses, flag dots, manual marker, today ring) and how Flowza Finance's ten statuses map onto them. */
export function CalendarLegend() {
  const { t } = useTranslation('attendance');
  const { t: tw } = useTranslation('attendanceWorkspace');
  return (
    <div className="space-y-2 text-xs text-muted-foreground" data-testid="calendar-legend">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {LEGEND_STATUSES.map((s) => <span key={s} className="inline-flex items-center gap-1.5"><span className={cn('flex size-4 items-center justify-center rounded text-[9px] font-semibold', cellClass(s))}>{STATUS_LETTER[s]}</span>{t(`status.${s}`)}</span>)}
        {LEGEND_DOTS.map((d) => <span key={d.flag} className="inline-flex items-center gap-1.5"><span className={cn('size-2 rounded-full', FLAG_DOT[d.flag])} />{d.ns === 'attendance' ? t(d.key) : tw(d.key)}</span>)}
        <span className="inline-flex items-center gap-1.5"><PencilLine className="size-3" />{tw('calendar.legendManual')}</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded ring-2 ring-primary" />{tw('calendar.legendToday')}</span>
      </div>
      <details className="rounded-md border bg-card/60 px-3 py-2">
        <summary className="cursor-pointer select-none text-foreground">{tw('mapping.title')}</summary>
        <p className="mt-1">{tw('mapping.hint')}</p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-start text-xs" data-testid="finance-mapping">
            <thead><tr className="border-b text-muted-foreground"><th className="py-1 pe-3 text-start font-medium">{tw('mapping.finance')}</th><th className="py-1 pe-3 text-start font-medium">{tw('mapping.status')}</th><th className="py-1 pe-3 text-start font-medium">{tw('mapping.flags')}</th><th className="py-1 text-start font-medium">{tw('mapping.note')}</th></tr></thead>
            <tbody>
              {FINANCE_STATUS_MAPPING.map((m) => (
                <tr key={m.finance} className="border-b last:border-0 align-top">
                  <td className="py-1 pe-3 font-mono text-foreground" dir="ltr">{m.finance}</td>
                  <td className="py-1 pe-3"><span className="flex flex-wrap gap-1">{m.statuses.map((s) => <AttendanceStatusBadge key={s} status={s} />)}</span></td>
                  <td className="py-1 pe-3">{m.flags.length ? m.flags.map((f) => t(`flags.${f}`)).join(', ') : '—'}</td>
                  <td className="py-1">{m.note ? tw(`mapping.notes.${m.note}`) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/**
 * Calendar register (HR portal Prompt 6a): one month grid per employee — status colour, flag dots, a tooltip with in / out /
 * worked / late / overtime, the `Manual` marker and today's ring. A day with a record opens the record dialog; an empty past day
 * opens HR's Add record for that employee and date.
 */
export function CalendarView({ onRequestCorrection }: { onRequestCorrection?: (preset: CorrectionPreset) => void }) {
  const { t } = useTranslation('attendance');
  const { t: tw } = useTranslation('attendanceWorkspace');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const firstDay = useActiveMembership()?.settings.general?.firstDayOfWeek ?? 0;
  const table = useTabTable({ pageSize: 12 });
  const f = table.state.filters;
  const currentMonth = todayIso(tz).slice(0, 7);
  const month = f['month'] && /^\d{4}-\d{2}$/.test(f['month']) ? f['month'] : currentMonth;
  const pageSize = PAGE_SIZES.includes(table.state.pageSize) ? table.state.pageSize : 12;
  const query = useMemo(() => ({ month, page: table.state.page, pageSize, employeeId: f['employeeId'], branchId: f['branchId'], departmentId: f['departmentId'], search: f['search'] }), [month, table.state.page, pageSize, f]);
  const q = useAttendanceCalendar(query);
  const branches = useBranchOptions();
  const departments = useDepartmentOptions(f['branchId']);
  const employees = useEmployeeOptions();
  const { openEdit, openTimeline, dialogs } = useWorkspaceDialogs();
  const [recordId, setRecordId] = useState<string | null>(null);
  const weeks = useMemo(() => monthWeeks(month, firstDay), [month, firstDay]);
  const order = useMemo(() => weekdayOrder(firstDay), [firstDay]);
  const today = q.data?.meta.today ?? todayIso(tz);
  const hasFilters = ['employeeId', 'branchId', 'departmentId', 'search'].some((k) => !!f[k]);
  const setMonth = (m: string) => table.update({ filters: { month: m === currentMonth ? '' : m } });
  const total = q.data?.meta.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const employeeOptions = useMemo(() => {
    const id = f['employeeId'];
    return id && !employees.options.some((o) => o.value === id) ? [{ value: id, label: t('monthly.selectedEmployee') }, ...employees.options] : employees.options;
  }, [employees.options, f, t]);
  const onAdd = openEdit ? (row: AttendanceCalendarRowDto, date: string) => openEdit({ employeeId: row.employeeId, employeeName: row.employeeName, date }) : undefined;

  return (
    <div className="space-y-4" data-testid="calendar-view">
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
        <SearchBox id="att-calendar-search" value={f['search']} onChange={(v) => table.setFilter('search', v)} placeholder={t('daily.searchPlaceholder')} />
        <Combobox value={f['employeeId'] ?? null} onChange={(v) => table.setFilter('employeeId', v ?? undefined)} options={employeeOptions} onSearch={employees.setSearch} loading={employees.isLoading} clearable placeholder={t('columns.employee')} className="h-8 w-48" />
        <Combobox value={f['branchId'] ?? null} onChange={(v) => table.update({ filters: { branchId: v ?? '', departmentId: '' } })} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-40" />
        <Combobox value={f['departmentId'] ?? null} onChange={(v) => table.setFilter('departmentId', v ?? undefined)} options={departments.options} loading={departments.isLoading} clearable placeholder={tc('common.department')} className="h-8 w-40" />
        {hasFilters ? <Button variant="ghost" size="sm" onClick={() => table.update({ filters: { employeeId: '', branchId: '', departmentId: '', search: '' } })}><X /> {tc('common.clearFilters')}</Button> : null}
      </div>
      <CalendarLegend />
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        : q.isLoading && !q.data ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-busy>{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-72 w-full" />)}</div>
        : q.data && q.data.data.length === 0 ? <EmptyState title={t('monthly.empty')} description={hasFilters ? tc('common.noResultsHint') : tw('calendar.emptyHint')} />
        : q.data ? (
          <div className={cn('grid gap-3 sm:grid-cols-2 xl:grid-cols-3', q.isFetching && 'opacity-70 transition-opacity')}>
            {q.data.data.map((row) => <EmployeeMonth key={row.employeeId} row={row} weeks={weeks} order={order} today={today} onOpen={setRecordId} onAdd={onAdd} onEmployee={(id) => navigate(`/employees/${id}`)} />)}
          </div>
        ) : null}
      <div className="flex flex-col items-center justify-between gap-2 text-sm text-muted-foreground sm:flex-row">
        <div className="flex items-center gap-2">
          <span>{tc('common.rowsPerPage')}</span>
          <Select value={String(pageSize)} onValueChange={(v) => table.setPageSize(Number(v))}>
            <SelectTrigger className="h-8 w-[76px]" aria-label={tc('common.rowsPerPage')}><SelectValue /></SelectTrigger>
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
      <RecordDialog
        recordId={recordId} onClose={() => setRecordId(null)}
        onRequestCorrection={onRequestCorrection ? (p) => { setRecordId(null); onRequestCorrection(p); } : undefined}
        onOpenTimeline={(d) => { setRecordId(null); openTimeline(d); }}
        onEditRecord={openEdit ? (p) => { setRecordId(null); openEdit(p); } : undefined}
      />
      {dialogs}
    </div>
  );
}
