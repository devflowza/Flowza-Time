import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui';
import { fmtDate, fmtMinutes } from '@/lib/format';
import { cn } from '@/lib/utils';

interface CompOffContext { workedOn: string; workedOnType: string; workedMinutes: number; recordedMinutes: number | null; daysEarned: number; location: string; summary: string }

/**
 * What a comp-off credit request is about, for the approver: the day worked (weekly off / holiday), the hours claimed next
 * to what the attendance record shows, the days it earns, where and what.
 */
export function CompOffApprovalContext({ c, compact = false }: { c: CompOffContext; compact?: boolean }) {
  const { t } = useTranslation('leave');
  const differs = c.recordedMinutes !== null && Math.abs(c.recordedMinutes - c.workedMinutes) >= 30;
  return (
    <div className="min-w-0 space-y-1 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t('compOff.typeName')}</span>
        <span className="tnum text-xs">{fmtDate(c.workedOn)}</span>
        <Badge variant="secondary">{t(`compOff.dayType.${c.workedOnType}`, { defaultValue: c.workedOnType })}</Badge>
        <Badge variant="outline" className="tnum">{t('compOff.earned', { days: c.daysEarned })}</Badge>
      </p>
      <p className={cn('text-xs tnum', differs ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>
        {t('compOff.claimed', { time: fmtMinutes(c.workedMinutes) })} · {c.recordedMinutes === null ? t('compOff.noRecord') : t('compOff.recorded', { time: fmtMinutes(c.recordedMinutes) })}
      </p>
      {compact ? <p className="max-w-[260px] truncate text-xs text-muted-foreground" title={`${c.location} — ${c.summary}`}>{c.location} — {c.summary}</p> : <p className="text-xs text-muted-foreground"><span className="font-medium">{c.location}</span> — <span dir="auto">{c.summary}</span></p>}
    </div>
  );
}
