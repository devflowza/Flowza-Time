import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { DateTime } from 'luxon';
import { CalendarCheck, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { ATTENDANCE_FLAGS, ATTENDANCE_STATUSES } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, StatCard } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDate, fmtMinutes, fmtNumber, fmtTime, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions, useDepartmentOptions } from '@/features/organization/lookups';
import { SearchBox } from '@/features/organization/components/search-box';
import { useTabTable } from '@/features/organization/use-tab-table';
import { useShiftOptions } from '@/features/schedule/api';
import { useDailyAttendance } from '../api';
import type { DailyRecord } from '../types';
import { AttendanceStatusBadge, FlagChips } from './badges';
import { RecordDialog, type CorrectionPreset } from './record-dialog';

const ALL = '__all__';
const STAT_KEYS = ['PRESENT', 'ABSENT', 'LEAVE', 'HALF_DAY', 'MISSING_PUNCH'] as const;
const STAT_TONE: Record<(typeof STAT_KEYS)[number], 'success' | 'danger' | 'info' | 'warning'> = { PRESENT: 'success', ABSENT: 'danger', LEAVE: 'info', HALF_DAY: 'warning', MISSING_PUNCH: 'warning' };

export function DailyView({ onRequestCorrection }: { onRequestCorrection?: (preset: CorrectionPreset) => void }) {
  const { t } = useTranslation('attendance');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const table = useTabTable();
  const f = table.state.filters;
  const date = f['date'] && DateTime.fromISO(f['date']).isValid ? f['date'] : todayIso(tz);
  const query = useMemo(() => ({ page: table.state.page, pageSize: table.state.pageSize, sort: table.state.sort, order: table.state.order, date, branchId: f['branchId'], departmentId: f['departmentId'], shiftId: f['shiftId'], status: f['status'], flag: f['flag'], search: f['search'] }), [table.state, date, f]);
  const q = useDailyAttendance(query);
  const branches = useBranchOptions();
  const departments = useDepartmentOptions(f['branchId']);
  const shifts = useShiftOptions();
  const [recordId, setRecordId] = useState<string | null>(null);
  const hasFilters = Object.keys(f).some((k) => k !== 'date');
  const setDate = (d: string) => table.update({ filters: { date: d === todayIso(tz) ? '' : d } });
  const byStatus = q.data?.meta.byStatus ?? {};

  const columns = useMemo<ColumnDef<DailyRecord, unknown>[]>(() => [
    { id: 'displayName', header: t('columns.employee'), enableSorting: false, cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.employeeName}</p><p className="truncate font-mono text-xs text-muted-foreground" dir="ltr">{row.original.employeeNumber}{row.original.branchName ? ` · ${row.original.branchName}` : ''}</p></div> },
    { id: 'shift', header: t('columns.shift'), enableSorting: false, cell: ({ row }) => row.original.shiftName ?? <span className="text-xs text-muted-foreground">{t('record.noShift')}</span> },
    { id: 'firstInAt', header: t('columns.firstIn'), cell: ({ row }) => <span className="tnum">{fmtTime(row.original.firstInAt, row.original.timezone || tz)}</span> },
    { id: 'lastOut', header: t('columns.lastOut'), enableSorting: false, cell: ({ row }) => <span className="tnum">{fmtTime(row.original.lastOutAt, row.original.timezone || tz)}</span> },
    { id: 'workedMinutes', header: t('columns.worked'), cell: ({ row }) => <span className="tnum">{fmtMinutes(row.original.workedMinutes)}</span> },
    { id: 'lateMinutes', header: t('columns.late'), cell: ({ row }) => <span className={cn('tnum', row.original.lateMinutes > 0 && 'text-amber-700 dark:text-amber-300')}>{row.original.lateMinutes ? fmtMinutes(row.original.lateMinutes) : '—'}</span> },
    { id: 'early', header: t('columns.early'), enableSorting: false, cell: ({ row }) => <span className={cn('tnum', row.original.earlyDepartureMinutes > 0 && 'text-amber-700 dark:text-amber-300')}>{row.original.earlyDepartureMinutes ? fmtMinutes(row.original.earlyDepartureMinutes) : '—'}</span> },
    { id: 'overtime', header: t('columns.overtime'), enableSorting: false, cell: ({ row }) => <span className={cn('tnum', row.original.overtimeMinutes > 0 && 'text-blue-700 dark:text-blue-300')}>{row.original.overtimeMinutes ? fmtMinutes(row.original.overtimeMinutes) : '—'}</span> },
    { id: 'status', header: tc('common.status'), cell: ({ row }) => <AttendanceStatusBadge status={row.original.status} /> },
    { id: 'flags', header: t('columns.flags'), enableSorting: false, cell: ({ row }) => <FlagChips flags={row.original.flags} size="xs" /> },
  ], [t, tc, tz]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border bg-card p-0.5">
          <Button variant="ghost" size="icon" className="size-8" aria-label={t('daily.previousDay')} onClick={() => setDate(DateTime.fromISO(date).minus({ days: 1 }).toISODate()!)}><ChevronLeft className="rtl:rotate-180" /></Button>
          <Input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="h-8 w-[150px] border-0 shadow-none" dir="ltr" aria-label={tc('common.date')} />
          <Button variant="ghost" size="icon" className="size-8" aria-label={t('daily.nextDay')} onClick={() => setDate(DateTime.fromISO(date).plus({ days: 1 }).toISODate()!)}><ChevronRight className="rtl:rotate-180" /></Button>
        </div>
        <Button variant="outline" size="sm" onClick={() => setDate(todayIso(tz))} disabled={date === todayIso(tz)}><CalendarCheck /> {tc('common.today')}</Button>
        <p className="text-sm text-muted-foreground">{fmtDate(date, 'EEEE, dd MMMM yyyy')}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {STAT_KEYS.map((k) => <StatCard key={k} label={t(`status.${k}`)} value={fmtNumber(byStatus[k] ?? 0)} tone={STAT_TONE[k]} loading={q.isLoading} onClick={() => table.setFilter('status', f['status'] === k ? undefined : k)} />)}
      </div>
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} sort={table.state.sort} order={table.state.order} onSort={table.toggleSort}
        isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="attendance-daily"
        onRowClick={(r) => setRecordId(r.id)}
        emptyTitle={t('daily.empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('daily.emptyHint')}
        toolbar={
          <>
            <SearchBox id="att-search" value={f['search']} onChange={(v) => table.setFilter('search', v)} placeholder={t('daily.searchPlaceholder')} />
            <Combobox value={f['branchId'] ?? null} onChange={(v) => table.update({ filters: { branchId: v ?? '', departmentId: '' } })} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-40" />
            <Combobox value={f['departmentId'] ?? null} onChange={(v) => table.setFilter('departmentId', v ?? undefined)} options={departments.options} loading={departments.isLoading} clearable placeholder={tc('common.department')} className="h-8 w-40" />
            <Combobox value={f['shiftId'] ?? null} onChange={(v) => table.setFilter('shiftId', v ?? undefined)} options={shifts.options} loading={shifts.isLoading} clearable placeholder={t('columns.shift')} className="h-8 w-36" />
            <Select value={f['status'] ?? ALL} onValueChange={(v) => table.setFilter('status', v === ALL ? undefined : v)}>
              <SelectTrigger className="h-8 w-40" aria-label={tc('common.status')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>{t('filters.allStatuses')}</SelectItem>{ATTENDANCE_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`status.${s}`)}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={f['flag'] ?? ALL} onValueChange={(v) => table.setFilter('flag', v === ALL ? undefined : v)}>
              <SelectTrigger className="h-8 w-44" aria-label={t('columns.flags')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>{t('filters.anyFlag')}</SelectItem>{ATTENDANCE_FLAGS.map((s) => <SelectItem key={s} value={s}>{t(`flags.${s}`)}</SelectItem>)}</SelectContent>
            </Select>
            {hasFilters ? <Button variant="ghost" size="sm" onClick={() => table.update({ filters: Object.fromEntries(Object.keys(f).filter((k) => k !== 'date' && k !== 'tab').map((k) => [k, ''])) })}><X /> {tc('common.clearFilters')}</Button> : null}
          </>
        }
        renderCard={(r) => (
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1"><p className="truncate font-medium">{r.employeeName}</p><p className="text-xs text-muted-foreground tnum">{fmtTime(r.firstInAt, r.timezone || tz)} – {fmtTime(r.lastOutAt, r.timezone || tz)} · {fmtMinutes(r.workedMinutes)}</p></div>
            <AttendanceStatusBadge status={r.status} />
          </div>
        )}
      />
      <RecordDialog recordId={recordId} onClose={() => setRecordId(null)} onRequestCorrection={onRequestCorrection ? (p) => { setRecordId(null); onRequestCorrection(p); } : undefined} />
    </div>
  );
}
