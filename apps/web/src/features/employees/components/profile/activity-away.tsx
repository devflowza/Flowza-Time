import { useTranslation } from 'react-i18next';
import { BriefcaseBusiness, CircleAlert, DoorOpen, Hourglass } from 'lucide-react';
import type { AttendanceAwayFiguresDto, AttendanceAwayIntervalDto, AwayIntervalKind } from '@flowza/contracts';
import { Badge, StatCard } from '@/components/ui';
import { fmtMinutes, fmtTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AWAY_KIND_BG } from './away-model';

/** The kind of a classified away interval as a chip with its chart colour (the label comes from the caller's namespace). */
export function AwayKindBadge({ kind, label }: { kind: AwayIntervalKind; label: string }) {
  return (
    <Badge variant="outline" data-kind={kind}>
      <span className={cn('size-2 shrink-0 rounded-full', AWAY_KIND_BG[kind])} aria-hidden />{label}
    </Badge>
  );
}

/**
 * A day's classified away intervals, one row each: the kind, the clock times in the day's zone and the minutes. Shared by the
 * activity view (HR and the employee's own) and the portal's check-in page, which pass the kind labels of their namespace.
 */
export function AwayIntervalList({ intervals, timezone, labelOf, className }: { intervals: readonly AttendanceAwayIntervalDto[]; timezone: string; labelOf: (kind: AwayIntervalKind) => string; className?: string }) {
  return (
    <ul className={cn('divide-y', className)}>
      {intervals.map((i, n) => (
        <li key={`${i.startAt}-${n}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2" data-testid="away-interval">
          <AwayKindBadge kind={i.kind} label={labelOf(i.kind)} />
          <span className="flex items-center gap-3 text-xs tnum">
            <span className="text-muted-foreground" dir="ltr">{fmtTime(i.startAt, timezone)} – {fmtTime(i.endAt, timezone)}</span>
            <span className="min-w-12 text-end font-medium">{fmtMinutes(i.minutes)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The period's time away next to the productive figures: the total, official duty, personal permission and the unapproved rest. */
export function AwayStatCards({ away, spanMinutes }: { away: AttendanceAwayFiguresDto; spanMinutes: number }) {
  const { t } = useTranslation('employees');
  const percent = spanMinutes <= 0 ? 0 : Math.round((away.awayMinutes / spanMinutes) * 100);
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="away-stats">
      <StatCard icon={DoorOpen} tone="info" label={t('activity.away.stats.away')} value={fmtMinutes(away.awayMinutes)} hint={t('activity.away.stats.awayHint', { percent })} />
      <StatCard icon={BriefcaseBusiness} tone="default" label={t('activity.away.stats.official')} value={fmtMinutes(away.officialDutyMinutes)} hint={t('activity.away.stats.officialHint')} />
      <StatCard icon={Hourglass} tone="default" label={t('activity.away.stats.permission')} value={fmtMinutes(away.permissionMinutes)} hint={t('activity.away.stats.permissionHint')} />
      <StatCard icon={CircleAlert} tone={away.unapprovedAwayMinutes > 0 ? 'danger' : 'default'} label={t('activity.away.stats.unapproved')} value={fmtMinutes(away.unapprovedAwayMinutes)} hint={t('activity.away.stats.unapprovedHint')} />
    </div>
  );
}
