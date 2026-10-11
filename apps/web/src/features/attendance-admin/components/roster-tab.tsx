import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import type { RosterDayDto, RosterRowDto, SelfShiftSummaryDto } from '@flowza/contracts';
import { Button, EmptyState, ErrorState, Input, TableSkeleton } from '@/components/ui';
import { Combobox, useDebounced } from '@/components/forms';
import { fmtDate, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useActiveMembership, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions, useDepartmentOptions } from '@/features/organization/lookups';
import { shiftLeaveMonth, weekdayOf } from '@/features/leave/model';
import { AA_NS } from '../i18n';
import { useShiftRoster } from '../api';
import { rosterCode } from '../model';

const PAGE_SIZE = 50;

type T = (k: string, o?: Record<string, unknown>) => string;
function cellLabel(t: T, date: string, day: RosterDayDto | undefined, shift: SelfShiftSummaryDto | undefined): string {
  const parts: string[] = [];
  if (!day) return fmtDate(date, 'EEE dd MMM');
  if (day.holidayName) parts.push(`${t('roster.holiday')}: ${day.holidayName}`);
  if (day.onLeave) parts.push(t('roster.leave'));
  if (day.isOff) parts.push(t('roster.off'));
  if (shift) parts.push(`${shift.name}${shift.startTime && shift.endTime ? ` ${shift.startTime}–${shift.endTime}` : ''} (${t(`roster.source.${day.source}`)})`);
  else if (!day.isOff) parts.push(t('roster.none'));
  return `${fmtDate(date, 'EEE dd MMM')}: ${parts.join(' · ')}`;
}

/** One day cell: the shift code in the shift's colour, "Off", a holiday or leave marker, or a dash. Memoised per row. */
const Row = memo(function Row({ row, dates, shifts, weeklyOff, today }: { row: RosterRowDto; dates: string[]; shifts: Map<string, SelfShiftSummaryDto>; weeklyOff: number[]; today: string }) {
  const { t } = useTranslation(AA_NS);
  return (
    <tr className="border-b last:border-0" data-testid="roster-row">
      <th scope="row" className="sticky start-0 z-10 bg-card px-3 py-1.5 text-start font-normal">
        <span className="block max-w-[180px] truncate font-medium">{row.employeeName}</span>
        <span className="font-mono text-[11px] text-muted-foreground" dir="ltr">{row.employeeNumber}</span>
      </th>
      {dates.map((d) => {
        const day = row.days[d];
        const shift = day?.shiftId ? shifts.get(day.shiftId) : undefined;
        const label = cellLabel(t, d, day, shift);
        const text = !day ? '' : day.holidayName ? 'H' : day.onLeave ? 'L' : day.isOff ? t('roster.off') : shift ? rosterCode(shift.code) : '–';
        const tone = !day ? '' : day.holidayName ? 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200' : day.onLeave ? 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200' : day.isOff ? 'bg-muted text-muted-foreground' : shift ? 'text-white' : 'text-muted-foreground';
        return (
          <td key={d} className={cn('px-0.5 py-1 text-center', weeklyOff.includes(weekdayOf(d)) && 'bg-muted/40', d === today && 'bg-primary/5')}>
            <span className={cn('mx-auto flex h-6 min-w-7 items-center justify-center rounded px-0.5 text-[10px] font-semibold', tone)} style={shift && !day?.isOff && !day?.holidayName && !day?.onLeave ? { backgroundColor: shift.color ?? '#64748b' } : undefined}
              title={label} aria-label={label} data-date={d} data-shift={shift?.code ?? ''} data-off={day?.isOff ? 'true' : undefined}>{text}</span>
          </td>
        );
      })}
    </tr>
  );
});

/**
 * The monthly shift roster (HR portal Prompt 6b, Finance ATT-105) on /shifts?tab=roster: employees × days, each cell the shift
 * the ENGINE resolves (assignment, rotation, organisation default), "Off" on weekly off / rotation off days, holidays (H) and
 * approved leave (L); legend, weekly-off shading, today highlighted. Read-only (shift.view; RLS keeps a branch-scoped member to
 * their branches).
 */
export function RosterTab() {
  const { t } = useTranslation(AA_NS);
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const weeklyOff = useActiveMembership()?.organization.weeklyOffDays ?? [];
  const [month, setMonth] = useState(() => todayIso(tz).slice(0, 7));
  const [branchId, setBranchId] = useState<string | null>(null);
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const search = useDebounced(searchText.trim(), 300);
  const [page, setPage] = useState(1);
  const branches = useBranchOptions();
  const departments = useDepartmentOptions(branchId);
  const q = useShiftRoster({ month, page, pageSize: PAGE_SIZE, branchId: branchId ?? undefined, departmentId: departmentId ?? undefined, search: search || undefined });
  const data = q.data?.data;
  const shifts = useMemo(() => new Map((data?.shifts ?? []).map((s) => [s.id, s])), [data]);
  const today = todayIso(tz);
  const meta = q.data?.meta;
  const reset = () => setPage(1);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('roster.hint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button size="icon" variant="outline" className="size-8" aria-label={t('roster.previous')} onClick={() => { setMonth((m) => shiftLeaveMonth(m, -1)); reset(); }}><ChevronLeft className="rtl:rotate-180" /></Button>
          <span className="min-w-36 text-center text-sm font-semibold tnum" aria-live="polite">{fmtDate(`${month}-01`, 'MMMM yyyy')}</span>
          <Button size="icon" variant="outline" className="size-8" aria-label={t('roster.next')} onClick={() => { setMonth((m) => shiftLeaveMonth(m, 1)); reset(); }}><ChevronRight className="rtl:rotate-180" /></Button>
        </div>
        <Combobox value={branchId} onChange={(v) => { setBranchId(v); setDepartmentId(null); reset(); }} options={branches.options} loading={branches.isLoading} clearable placeholder={t('roster.branch')} className="h-8 w-44" />
        <Combobox value={departmentId} onChange={(v) => { setDepartmentId(v); reset(); }} options={departments.options} loading={departments.isLoading} clearable placeholder={t('roster.department')} className="h-8 w-44" />
        <Input type="search" value={searchText} onChange={(e) => { setSearchText(e.target.value); reset(); }} placeholder={t('roster.search')} aria-label={t('roster.search')} className="h-8 w-52" />
      </div>
      <ul className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground" aria-label={t('roster.title')}>
        {(data?.shifts ?? []).map((s) => <li key={s.id} className="flex items-center gap-1.5"><span className="flex h-5 min-w-6 items-center justify-center rounded px-0.5 text-[10px] font-semibold text-white" style={{ backgroundColor: s.color ?? '#64748b' }}>{rosterCode(s.code)}</span>{s.name}{s.startTime && s.endTime ? <span dir="ltr" className="tnum">{s.startTime}–{s.endTime}</span> : null}</li>)}
        <li className="flex items-center gap-1.5"><span className="flex h-5 min-w-6 items-center justify-center rounded bg-muted px-0.5 text-[10px] font-semibold">{t('roster.off')}</span>{t('roster.legendOff')}</li>
        <li className="flex items-center gap-1.5"><span className="flex h-5 min-w-6 items-center justify-center rounded bg-violet-100 px-0.5 text-[10px] font-semibold text-violet-800 dark:bg-violet-950 dark:text-violet-200">H</span>{t('roster.legendHoliday')}</li>
        <li className="flex items-center gap-1.5"><span className="flex h-5 min-w-6 items-center justify-center rounded bg-blue-100 px-0.5 text-[10px] font-semibold text-blue-800 dark:bg-blue-950 dark:text-blue-200">L</span>{t('roster.legendLeave')}</li>
        <li className="flex items-center gap-1.5"><span className="flex h-5 min-w-6 items-center justify-center text-[10px] font-semibold">–</span>{t('roster.legendNone')}</li>
      </ul>
      <div className="rounded-xl border bg-card shadow-card">
        {q.isError ? <div className="p-4"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>
          : q.isLoading || !data ? <TableSkeleton cols={10} rows={5} />
          : data.rows.length === 0 ? <div className="p-4"><EmptyState icon={CalendarDays} title={t('roster.empty')} description={search ? tc('common.noResultsHint') : t('roster.emptyHint')} /></div>
          : (
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-max min-w-full border-collapse text-xs" aria-label={t('roster.title')} data-testid="roster-grid">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th scope="col" className="sticky start-0 z-20 min-w-44 bg-muted/50 px-3 py-2 text-start font-semibold">{t('roster.employee')}</th>
                    {data.dates.map((d) => <th key={d} scope="col" className={cn('min-w-8 px-0.5 py-1 text-center font-medium tnum leading-tight', weeklyOff.includes(weekdayOf(d)) && 'bg-muted', d === today && 'text-primary')}><span className="block">{d.slice(8)}</span><span className="block text-[9px] uppercase">{fmtDate(d, 'ccc')}</span></th>)}
                  </tr>
                </thead>
                <tbody>{data.rows.map((r) => <Row key={r.employeeId} row={r} dates={data.dates} shifts={shifts} weeklyOff={weeklyOff} today={today} />)}</tbody>
              </table>
            </div>
          )}
      </div>
      {meta && meta.totalPages > 1 ? (
        <div className="flex items-center justify-end gap-2 text-xs">
          <span className="tnum text-muted-foreground">{t('roster.page', { page: meta.page, pages: meta.totalPages, total: meta.total })}</span>
          <Button size="icon" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label={t('roster.prevPage')}><ChevronLeft className="rtl:rotate-180" /></Button>
          <Button size="icon" variant="ghost" disabled={page >= meta.totalPages} onClick={() => setPage((p) => p + 1)} aria-label={t('roster.nextPage')}><ChevronRight className="rtl:rotate-180" /></Button>
        </div>
      ) : null}
    </div>
  );
}
