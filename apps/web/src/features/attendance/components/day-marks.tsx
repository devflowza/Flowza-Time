import { useTranslation } from 'react-i18next';
import type { DayMarkDto } from '@flowza/contracts';
import { Badge, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { fmtDays, MARK_TONE } from '../status';

/**
 * The reviewed verdicts on an employee-day (HR portal Prompt 3): one badge per day mark — unexcused, excused, charged to
 * leave, loss of pay — with a tooltip naming who / what wrote it, when and why; revoked marks stay visible struck
 * through, because the trail matters as much as the verdict in force. Plus the loss-of-pay badge of the record itself.
 */
export function DayMarks({ marks, lopDays, timezone }: { marks: DayMarkDto[] | undefined; lopDays: number | undefined; timezone: string }) {
  const { t } = useTranslation('attendance');
  const list = marks ?? [];
  const lop = lopDays ?? 0;
  if (list.length === 0 && lop <= 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/20 p-2" role="group" aria-label={t('record.marks.title')}>
      <span className="me-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('record.marks.title')}</span>
      {lop > 0 ? <MarkTip label={t('record.marks.lop', { days: fmtDays(lop) })} tone="danger" lines={[t('record.marks.lopHint')]} /> : null}
      {list.map((m) => {
        const revoked = m.revokedAt !== null;
        const label = m.kind === 'LOP' || m.kind === 'PAY_EFFECT' ? t(`record.marks.kinds.${m.kind}`, { days: fmtDays(m.payEffectDays) }) : t(`record.marks.kinds.${m.kind}`, { defaultValue: m.kind });
        const lines = [
          t('record.marks.created', { source: t(`record.marks.sources.${m.source}`, { defaultValue: m.source }), at: fmtDateTime(m.createdAt, timezone) }),
          ...(m.reason ? [m.reason] : []),
          ...(revoked ? [t('record.marks.revoked', { at: fmtDateTime(m.revokedAt, timezone), reason: m.revokeReason ?? '—' })] : []),
        ];
        return <MarkTip key={m.id} label={revoked ? `${label} (${t('record.marks.revokedShort')})` : label} tone={revoked ? 'outline' : MARK_TONE[m.kind] ?? 'neutral'} lines={lines} revoked={revoked} />;
      })}
    </div>
  );
}

function MarkTip({ label, tone, lines, revoked }: { label: string; tone: React.ComponentProps<typeof Badge>['variant']; lines: string[]; revoked?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={[label, ...lines].join(' — ')}>
          <Badge variant={tone} className={cn(revoked && 'line-through opacity-70')}>{label}</Badge>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs space-y-0.5">{lines.map((l, i) => <p key={i}>{l}</p>)}</TooltipContent>
    </Tooltip>
  );
}
