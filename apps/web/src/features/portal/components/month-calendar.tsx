import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { SelfAttendanceMonthDto, SelfDayDto } from '@flowza/contracts';
import { fmtMinutes, fmtTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { cellClass } from '@/features/attendance/status';
import { monthWeeks, weekdayOrder } from '../model';

/**
 * One month of the employee's own days as a calendar. Each day shows the engine's status, first-in / last-out and the
 * worked time; approved leave and holidays label days that have no record yet (future dates). Days with a record open
 * the record detail.
 */
export function MonthCalendar({ data, firstDayOfWeek, today, onSelect }: { data: SelfAttendanceMonthDto; firstDayOfWeek: number; today: string; onSelect: (day: SelfDayDto) => void }) {
  const { t } = useTranslation('portal');
  const { t: ta } = useTranslation('attendance');
  const weeks = useMemo(() => monthWeeks(data.month, firstDayOfWeek), [data.month, firstDayOfWeek]);
  const byDate = useMemo(() => new Map(data.days.map((d) => [d.attendanceDate, d])), [data.days]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] table-fixed border-separate border-spacing-1" aria-label={data.month}>
        <thead>
          <tr>{weekdayOrder(firstDayOfWeek).map((d) => <th key={d} scope="col" className="pb-1 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t(`weekdays.${d}`)}</th>)}</tr>
        </thead>
        <tbody>
          {weeks.map((week, wi) => (
            <tr key={wi}>
              {week.map((date, di) => {
                if (!date) return <td key={di} aria-hidden />;
                const r = byDate.get(date);
                const leave = data.leaveByDate[date];
                const holiday = data.holidaysByDate[date];
                const label = r ? ta(`status.${r.status}`, { defaultValue: r.status }) : leave?.leaveTypeName ?? holiday ?? null;
                const body = (
                  <>
                    <span className="flex items-center justify-between gap-1">
                      <span className={cn('tnum text-xs font-semibold', date === today && 'rounded-full bg-primary px-1.5 text-primary-foreground')}>{Number(date.slice(8))}</span>
                      {r?.flags.includes('LATE') ? <span className="size-1.5 rounded-full bg-amber-500" title={ta('flags.LATE')} aria-hidden /> : null}
                    </span>
                    {label ? <span className={cn('mt-1 block truncate rounded px-1 py-0.5 text-[10px] font-medium', r ? cellClass(r.status) : 'bg-muted text-muted-foreground')} style={!r && leave?.color ? { backgroundColor: `${leave.color}22`, color: leave.color } : undefined}>{label}</span> : null}
                    {r && (r.firstInAt || r.lastOutAt) ? <span className="mt-1 block truncate text-[10px] text-muted-foreground tnum" dir="ltr">{fmtTime(r.firstInAt, r.timezone)} – {fmtTime(r.lastOutAt, r.timezone)}</span> : null}
                    {r && r.workedMinutes > 0 ? <span className="block truncate text-[10px] text-muted-foreground tnum">{fmtMinutes(r.workedMinutes)}</span> : null}
                  </>
                );
                return (
                  <td key={di} className="h-24 align-top">
                    {r ? (
                      <button type="button" onClick={() => onSelect(r)} className="flex h-full w-full flex-col rounded-md border bg-card p-1.5 text-start transition-colors hover:border-brand-300 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${date} · ${label ?? ''}`}>{body}</button>
                    ) : (
                      <div className={cn('flex h-full w-full flex-col rounded-md border border-dashed p-1.5', date > today ? 'bg-transparent' : 'bg-muted/30')}>{body}</div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
