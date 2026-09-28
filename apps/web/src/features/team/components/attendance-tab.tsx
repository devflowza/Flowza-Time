import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button, EmptyState, ErrorState, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDate, fmtMinutes, fmtTime, todayIso } from '@/lib/format';
import { useActiveMembership, useOrgTimezone } from '@/features/me/use-me';
import { MonthlyGrid, MonthlyLegend } from '@/features/attendance/components/monthly-grid';
import { AttendanceStatusBadge, FlagChips } from '@/features/attendance/components/badges';
import { monthDates, shiftLeaveMonth } from '@/features/leave/model';
import { useTeamAttendance, useTeamSummary } from '../api';
import { TEAM_NS } from '../i18n';
import { monthBounds, monthlyRowsFrom } from '../model';

type View = 'month' | 'day';
const PAGE_SIZE = 50;

/**
 * The team's daily records through the HR register's own month grid (Prompt 6a component), fed by /team/attendance: every
 * row is a direct report, a cell opens the record dialog (read-only unless the caller may file corrections). The Day view
 * lists one date for the whole team.
 */
export function AttendanceTab({ canCorrect, onOpenRecord }: { canCorrect: boolean; onOpenRecord: (recordId: string) => void }) {
  const { t } = useTranslation(TEAM_NS);
  const tz = useOrgTimezone();
  const weeklyOff = useActiveMembership()?.organization.weeklyOffDays ?? [];
  const [view, setView] = useState<View>('month');
  const [month, setMonth] = useState(() => todayIso(tz).slice(0, 7));
  const [date, setDate] = useState(() => todayIso(tz));
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const range = view === 'month' ? monthBounds(month) : { from: date, to: date };
  const q = useTeamAttendance({ ...range, employeeId: employeeId ?? undefined, page, pageSize: PAGE_SIZE }, !!range.from);
  // the report picker lists the whole team (today's board is cached and cheap), whatever page of rows is shown
  const members = useTeamSummary(undefined);
  const options = useMemo(() => (members.data?.members ?? []).map((m) => ({ value: m.employeeId, label: m.employeeName, description: m.employeeNumber })), [members.data]);
  const days = useMemo(() => monthDates(month), [month]);
  const rows = useMemo(() => monthlyRowsFrom(q.data?.data ?? [], days), [q.data, days]);
  const meta = q.data?.meta;
  const reset = () => setPage(1);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border bg-card p-0.5 shadow-card" role="group" aria-label={t('tabs.attendance')}>
          {(['month', 'day'] as const).map((v) => <Button key={v} size="sm" variant={view === v ? 'default' : 'ghost'} aria-pressed={view === v} onClick={() => { setView(v); reset(); }}>{t(`attendance.${v}`)}</Button>)}
        </div>
        {view === 'month' ? (
          <div className="flex items-center gap-1">
            <Button size="icon" variant="outline" className="size-8" aria-label={t('attendance.previous')} onClick={() => { setMonth((m) => shiftLeaveMonth(m, -1)); reset(); }}><ChevronLeft className="rtl:rotate-180" /></Button>
            <span className="min-w-36 text-center text-sm font-semibold tnum" aria-live="polite">{fmtDate(`${month}-01`, 'MMMM yyyy')}</span>
            <Button size="icon" variant="outline" className="size-8" aria-label={t('attendance.next')} onClick={() => { setMonth((m) => shiftLeaveMonth(m, 1)); reset(); }}><ChevronRight className="rtl:rotate-180" /></Button>
          </div>
        ) : (
          <Input type="date" aria-label={t('attendance.date')} value={date} max={todayIso(tz)} onChange={(e) => { if (e.target.value) { setDate(e.target.value); reset(); } }} className="h-8 w-44" />
        )}
        <Label htmlFor="team-att-employee" className="sr-only">{t('attendance.employee')}</Label>
        <Combobox id="team-att-employee" value={employeeId} onChange={(v) => { setEmployeeId(v); reset(); }} options={options} loading={members.isLoading} clearable placeholder={t('attendance.allReports')} className="h-8 w-56" />
        {!canCorrect ? <span className="text-xs text-muted-foreground sm:ms-auto">{t('attendance.readOnly')}</span> : null}
      </div>
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        : q.isLoading ? <TableSkeleton cols={8} rows={5} />
        : (q.data?.data.length ?? 0) === 0 ? <EmptyState icon={CalendarDays} title={t('attendance.empty')} description={t('attendance.emptyHint')} />
        : view === 'month' ? (
          <div className="space-y-2">
            <MonthlyGrid rows={rows} days={days} weeklyOffDays={weeklyOff} onOpenRecord={onOpenRecord} onOpenEmployee={(id) => { setEmployeeId(id); reset(); }} />
            <MonthlyLegend />
          </div>
        ) : (
          <div className="rounded-lg border bg-card shadow-card">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow>{(['employee', 'status', 'in', 'out', 'worked', 'late'] as const).map((c) => <TableHead key={c}>{t(`attendance.columns.${c}`)}</TableHead>)}</TableRow></TableHeader>
                <TableBody>
                  {(q.data?.data ?? []).map((r) => {
                    const rec = r.records[0];
                    return (
                      <TableRow key={r.employeeId} data-testid="team-day-row" className={rec ? 'cursor-pointer' : undefined} onClick={rec ? () => onOpenRecord(rec.id) : undefined}>
                        <TableCell><span className="block font-medium">{r.employeeName}</span><span className="font-mono text-xs text-muted-foreground" dir="ltr">{r.employeeNumber}</span></TableCell>
                        <TableCell>{rec ? <span className="flex flex-wrap items-center gap-1"><AttendanceStatusBadge status={rec.status} /><FlagChips flags={rec.flags} max={2} size="xs" /></span> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
                        <TableCell className="tnum" dir="ltr">{fmtTime(rec?.firstInAt, rec?.timezone ?? tz)}</TableCell>
                        <TableCell className="tnum" dir="ltr">{fmtTime(rec?.lastOutAt, rec?.timezone ?? tz)}</TableCell>
                        <TableCell className="tnum">{rec ? fmtMinutes(rec.workedMinutes) : '—'}</TableCell>
                        <TableCell className="tnum">{rec && rec.lateMinutes > 0 ? fmtMinutes(rec.lateMinutes) : '—'}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      {meta && meta.totalPages > 1 ? (
        <div className="flex items-center justify-end gap-2 text-xs">
          <span className="tnum text-muted-foreground">{t('attendance.page', { page: meta.page, pages: meta.totalPages, total: meta.total })}</span>
          <Button size="icon" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label={t('attendance.prevPage')}><ChevronLeft className="rtl:rotate-180" /></Button>
          <Button size="icon" variant="ghost" disabled={page >= meta.totalPages} onClick={() => setPage((p) => p + 1)} aria-label={t('attendance.nextPage')}><ChevronRight className="rtl:rotate-180" /></Button>
        </div>
      ) : null}
    </div>
  );
}
