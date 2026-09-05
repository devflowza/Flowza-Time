import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui';
import { CORRECTION_TONE, FLAG_TONE, JOB_TONE, RAW_TONE, statusTone } from '../status';

export function AttendanceStatusBadge({ status, className }: { status: string; className?: string }) {
  const { t } = useTranslation('attendance');
  return <Badge variant={statusTone(status)} dot className={className}>{t(`status.${status}`, { defaultValue: status })}</Badge>;
}

/** Flag chips: the first `max` flags inline, the rest as a "+n" chip with a title tooltip. */
export function FlagChips({ flags, max = 3, size = 'sm' }: { flags: string[] | null | undefined; max?: number; size?: 'sm' | 'xs' }) {
  const { t } = useTranslation('attendance');
  if (!flags || flags.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  const shown = flags.slice(0, max);
  const rest = flags.slice(max);
  const cls = size === 'xs' ? 'text-[10px] px-1.5 py-0' : undefined;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {shown.map((f) => <Badge key={f} variant={FLAG_TONE[f] ?? 'neutral'} className={cls}>{t(`flags.${f}`, { defaultValue: f })}</Badge>)}
      {rest.length ? <Badge variant="outline" className={cls} title={rest.map((f) => t(`flags.${f}`, { defaultValue: f })).join(', ')}>+{rest.length}</Badge> : null}
    </span>
  );
}

export function CorrectionStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('attendance');
  return <Badge variant={CORRECTION_TONE[status] ?? 'neutral'} dot>{t(`correctionStatus.${status}`, { defaultValue: status })}</Badge>;
}
export function CorrectionTypeBadge({ type }: { type: string }) {
  const { t } = useTranslation('attendance');
  return <Badge variant="secondary">{t(`correctionType.${type}`, { defaultValue: type })}</Badge>;
}
export function RawStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('attendance');
  return <Badge variant={RAW_TONE[status] ?? 'neutral'} dot>{t(`rawStatus.${status}`, { defaultValue: status })}</Badge>;
}
export function JobStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('attendance');
  return <Badge variant={JOB_TONE[status] ?? 'neutral'} dot>{t(`jobStatus.${status}`, { defaultValue: status })}</Badge>;
}
