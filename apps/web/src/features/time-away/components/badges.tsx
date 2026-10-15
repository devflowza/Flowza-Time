import { useTranslation } from 'react-i18next';
import type { TimeAwayKind, TimeAwayStatus } from '@flowza/contracts';
import { Badge } from '@/components/ui';
import { fmtMinutes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { TIME_AWAY_NS } from '../i18n';
import { KIND_TONE, STATUS_TONE, type AwayBreakdown } from '../model';

export function TimeAwayStatusBadge({ status }: { status: TimeAwayStatus }) {
  const { t } = useTranslation(TIME_AWAY_NS);
  return <Badge variant={STATUS_TONE[status]} data-status={status}>{t(`statuses.${status}`)}</Badge>;
}

export function TimeAwayKindBadge({ kind }: { kind: TimeAwayKind }) {
  const { t } = useTranslation(TIME_AWAY_NS);
  return <Badge variant={KIND_TONE[kind]} className="font-normal">{t(`kinds.${kind}`)}</Badge>;
}

/**
 * The series of the breakdown, coloured with the tenant's chart palette (docs/design.md §11) — the same tokens as the
 * Activity chart's away series (features/employees/components/profile/away-model.ts), so a kind has one colour everywhere.
 */
const SEGMENTS = [
  { key: 'official', className: 'bg-chart-field' },
  { key: 'permission', className: 'bg-chart-permission' },
  { key: 'unapproved', className: 'bg-chart-unapproved' },
  { key: 'other', className: 'bg-muted-foreground/40' },
] as const;

/**
 * A small stacked bar of one employee's month: official duty, permission, unapproved and other away time. `scale` is the
 * largest total on screen, so the bars of different employees compare at a glance.
 */
export function AwayBar({ breakdown, scale, className }: { breakdown: AwayBreakdown; scale: number; className?: string }) {
  const { t } = useTranslation(TIME_AWAY_NS);
  const label = t('summary.breakdownLabel', { official: fmtMinutes(breakdown.official), permission: fmtMinutes(breakdown.permission), unapproved: fmtMinutes(breakdown.unapproved), other: fmtMinutes(breakdown.other) });
  const width = (n: number) => `${scale > 0 ? (n / scale) * 100 : 0}%`;
  return (
    <div role="img" aria-label={label} title={label} className={cn('flex h-2 w-full min-w-24 overflow-hidden rounded-full bg-muted', className)}>
      {SEGMENTS.map((s) => (breakdown[s.key] > 0 ? <span key={s.key} className={cn('h-full', s.className)} style={{ width: width(breakdown[s.key]) }} data-segment={s.key} /> : null))}
    </div>
  );
}

export function AwayLegend() {
  const { t } = useTranslation(TIME_AWAY_NS);
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {SEGMENTS.map((s) => <li key={s.key} className="inline-flex items-center gap-1.5"><span className={cn('size-2.5 rounded-sm', s.className)} aria-hidden />{t(`legend.${s.key}`)}</li>)}
    </ul>
  );
}
