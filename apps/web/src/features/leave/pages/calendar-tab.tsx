import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import type { TeamLeaveDto } from '@flowza/contracts';
import { Button, EmptyState, ErrorState, Label, Switch, TableSkeleton } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDate, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useActiveMembership, useCan, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { useLeaveCalendar } from '../api';
import { fmtLeaveDays, monthDates, shiftLeaveMonth, weekdayOf } from '../model';
import { LeaveTypeDot } from '../components/leave-status';

/** The leave covering a date for one employee (a first + second half pair can share a date). */
function entriesOn(entries: TeamLeaveDto[], date: string): TeamLeaveDto[] {
  return entries.filter((e) => e.startDate <= date && e.endDate >= date);
}

function Cell({ items, date }: { items: TeamLeaveDto[]; date: string }) {
  const { t } = useTranslation('leave');
  if (!items.length) return null;
  const label = items.map((e) => `${e.leaveTypeName} · ${t(`status.${e.status}`, { defaultValue: e.status })}${e.isHalfDay && e.halfDayPart ? ` · ${t(`halfDayParts.${e.halfDayPart}`)}` : ''}`).join('\n');
  return (
    <span className="flex h-6 w-full flex-col gap-px" title={`${fmtDate(date)}\n${label}`} aria-label={label}>
      {items.map((e) => (
        <span key={e.id} className={cn('min-h-0 flex-1 rounded-sm', e.status !== 'APPROVED' && 'border border-dashed border-foreground/40 opacity-60')} style={{ backgroundColor: e.color ?? '#94a3b8' }} data-status={e.status} />
      ))}
    </span>
  );
}

/**
 * Team calendar: one row per employee with leave in the month, a cell per day coloured by the leave type (pending and info
 * requested drawn dashed). HR (leave.view) sees the branches in scope; a manager with leave.view_team their team.
 */
export function LeaveCalendarTab() {
  const { t } = useTranslation('leave');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const can = useCan();
  const membership = useActiveMembership();
  const weeklyOff = membership?.organization.weeklyOffDays ?? [];
  const [month, setMonth] = useState(() => todayIso(tz).slice(0, 7));
  const [branchId, setBranchId] = useState<string | null>(null);
  const [includePending, setIncludePending] = useState(true);
  const q = useLeaveCalendar({ month, branchId: branchId ?? undefined, includePending });
  const branches = useBranchOptions();
  const dates = useMemo(() => monthDates(month), [month]);
  const byEmployee = useMemo(() => {
    const out = new Map<string, TeamLeaveDto[]>();
    for (const e of q.data?.entries ?? []) out.set(e.employeeId, [...(out.get(e.employeeId) ?? []), e]);
    return out;
  }, [q.data]);
  const legend = useMemo(() => [...new Map((q.data?.entries ?? []).map((e) => [e.leaveTypeId, e])).values()], [q.data]);
  const today = todayIso(tz);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button size="icon" variant="outline" className="size-8" aria-label={t('calendar.previous')} onClick={() => setMonth((m) => shiftLeaveMonth(m, -1))}><ChevronLeft className="rtl:rotate-180" /></Button>
          <span className="min-w-36 text-center text-sm font-semibold tnum" aria-live="polite">{fmtDate(`${month}-01`, 'MMMM yyyy')}</span>
          <Button size="icon" variant="outline" className="size-8" aria-label={t('calendar.next')} onClick={() => setMonth((m) => shiftLeaveMonth(m, 1))}><ChevronRight className="rtl:rotate-180" /></Button>
        </div>
        {can('leave.view') ? <Combobox value={branchId} onChange={setBranchId} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-44" /> : null}
        <div className="flex items-center gap-2"><Switch id="leave-cal-pending" checked={includePending} onCheckedChange={setIncludePending} /><Label htmlFor="leave-cal-pending" className="text-sm">{t('calendar.includePending')}</Label></div>
        {legend.length ? <ul className="ms-auto flex flex-wrap gap-3 text-xs">{legend.map((e) => <li key={e.leaveTypeId} className="flex items-center gap-1.5"><LeaveTypeDot color={e.color} />{e.leaveTypeName}</li>)}</ul> : null}
      </div>
      <div className="rounded-lg border bg-card shadow-card">
        {q.isError ? <div className="p-4"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>
          : q.isLoading ? <TableSkeleton cols={8} rows={5} />
          : !q.data || q.data.employees.length === 0 ? <div className="p-4"><EmptyState icon={CalendarDays} title={t('calendar.empty')} description={t('calendar.emptyHint')} /></div>
          : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs" aria-label={t('tabs.calendar')}>
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th scope="col" className="sticky start-0 z-10 min-w-44 bg-muted/50 px-3 py-2 text-start font-semibold">{t('fields.employee')}</th>
                    {dates.map((d) => <th key={d} scope="col" className={cn('min-w-7 px-0.5 py-2 text-center font-medium tnum', weeklyOff.includes(weekdayOf(d)) && 'bg-muted', d === today && 'text-primary')}>{d.slice(8)}</th>)}
                    <th scope="col" className="px-2 py-2 text-end font-semibold">{t('calendar.days')}</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.employees.map((emp) => {
                    const own = byEmployee.get(emp.employeeId) ?? [];
                    const total = own.reduce((a, e) => a + (e.days ?? 0), 0);
                    return (
                      <tr key={emp.employeeId} className="border-b last:border-0">
                        <th scope="row" className="sticky start-0 z-10 bg-card px-3 py-1.5 text-start font-normal"><span className="block truncate font-medium">{emp.employeeName}</span><span className="font-mono text-[11px] text-muted-foreground" dir="ltr">{emp.employeeNumber}</span></th>
                        {dates.map((d) => <td key={d} className={cn('px-0.5 py-1', weeklyOff.includes(weekdayOf(d)) && 'bg-muted/60')}><Cell items={entriesOn(own, d)} date={d} /></td>)}
                        <td className="px-2 text-end tnum">{fmtLeaveDays(total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </div>
      {q.data?.truncated ? <p className="text-xs text-muted-foreground">{t('calendar.truncated')}</p> : null}
    </div>
  );
}
