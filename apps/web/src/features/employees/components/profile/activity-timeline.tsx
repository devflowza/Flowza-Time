import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { AttendanceActivityDayDto } from '@flowza/contracts';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui';
import { fmtDate, fmtMinutes, fmtTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { buildTimeline, datesOf, tickLabel, type TimelineBar, type TimelineRow } from './activity-model';

/**
 * The heartbeat: one row per day of the period, every row on the same clock window. Green is time inside — the spans
 * the engine counted as worked — and blue is the time between two of those spans, when the employee was out of the
 * office between the first and the last punch of the day (field work, a client visit or a break).
 */
export function ActivityTimeline({ from, to, days, timezone }: { from: string; to: string; days: AttendanceActivityDayDto[]; timezone: string }) {
  const { t } = useTranslation('employees');
  const timeline = useMemo(() => buildTimeline(datesOf(from, to), days, timezone), [from, to, days, timezone]);
  const width = timeline.toMinute - timeline.fromMinute;

  return (
    <div className="space-y-1">
      <div className="flex items-stretch gap-3 text-xs text-muted-foreground">
        <span className="w-24 shrink-0" />
        <div className="relative h-4 flex-1">
          {timeline.ticks.map((m) => (
            <span key={m} className="absolute -translate-x-1/2 tnum rtl:translate-x-1/2" style={{ insetInlineStart: `${((m - timeline.fromMinute) / width) * 100}%` }} dir="ltr">{tickLabel(m)}</span>
          ))}
        </div>
      </div>
      <ol className="space-y-1">
        {timeline.rows.map((row) => (
          <li key={row.date} className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-xs text-muted-foreground tnum">{fmtDate(row.date, 'EEE dd MMM')}</span>
            <div className="relative h-6 flex-1 overflow-hidden rounded-md bg-muted" role="img" aria-label={rowLabel(row, t)}>
              {timeline.ticks.map((m) => (
                <span key={m} className="absolute inset-y-0 w-px bg-border" style={{ insetInlineStart: `${((m - timeline.fromMinute) / width) * 100}%` }} aria-hidden />
              ))}
              {row.bars.length === 0 ? (
                <span className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground">{row.day ? t(`activity.status.${row.status}`, { defaultValue: row.status }) : t('activity.timeline.noRecord')}</span>
              ) : row.bars.map((bar, i) => <Bar key={`${bar.startAt}-${i}`} bar={bar} date={row.date} timezone={timezone} />)}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The bars are visual; this is what a screen reader hears instead of them (the details table carries the rest). */
function rowLabel(row: TimelineRow, t: TFunction): string {
  if (!row.day) return t('activity.timeline.noRecord');
  return `${t(`activity.status.${row.day.status}`, { defaultValue: row.day.status })} · ${t('activity.legend.office')} ${fmtMinutes(row.day.officeMinutes)} · ${t('activity.legend.field')} ${fmtMinutes(row.day.fieldMinutes)}`;
}

function Bar({ bar, date, timezone }: { bar: TimelineBar; date: string; timezone: string }) {
  const { t } = useTranslation('employees');
  const label = t(bar.kind === 'OFFICE' ? 'activity.legend.office' : 'activity.legend.field');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn('absolute inset-y-1 rounded-sm', bar.kind === 'OFFICE' ? 'bg-chart-office' : 'bg-chart-field', bar.open && 'opacity-60')}
          style={{ insetInlineStart: `${bar.startPct}%`, width: `${bar.widthPct}%` }}
        />
      </TooltipTrigger>
      <TooltipContent>
        <span className="tnum" dir="ltr">
          {fmtTime(bar.startAt, timezone)} – {bar.endAt ? fmtTime(bar.endAt, timezone) : t('activity.timeline.open')}
        </span>
        <span className="ms-2">{label}{bar.endAt ? ` · ${fmtMinutes(bar.minutes)}` : ''}</span>
        <span className="ms-2 opacity-70">{fmtDate(date, 'dd MMM')}</span>
      </TooltipContent>
    </Tooltip>
  );
}
