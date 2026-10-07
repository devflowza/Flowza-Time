import { useTranslation } from 'react-i18next';
import type { ApprovalContextDto } from '@flowza/contracts';
import { cn } from '@/lib/utils';
import { SR_NS } from '../i18n';
import { RangeText, ShiftChangeKindBadge } from './parts';

type ShiftChangeContext = Extract<ApprovalContextDto, { kind: 'SHIFT_CHANGE' }>;

/** The approvals inbox / detail context of a shift change request: kind, range, current → requested shift (or the shift added), reason. */
export function ShiftChangeApprovalContext({ context, compact }: { context: ShiftChangeContext; compact: boolean }) {
  const { t } = useTranslation(SR_NS);
  const c = context.change;
  const clip = cn('text-xs text-muted-foreground', compact && 'max-w-[260px] truncate');
  return (
    <div className="min-w-0 space-y-1 text-sm" data-testid="context-shift-change">
      <p className="flex flex-wrap items-center gap-2"><RangeText from={c.fromDate} to={c.toDate} fmt="dd MMM yyyy" /><ShiftChangeKindBadge kind={c.kind} /></p>
      <p className="text-xs" dir="auto">{c.kind === 'ADDITIONAL' ? t('approval.adds', { shift: c.requestedShiftName ?? '—' }) : t('shiftChange', { from: c.currentShiftName ?? '—', to: c.requestedShiftName ?? '—' })}</p>
      <p className={clip} title={c.reason} dir="auto">{c.reason}</p>
    </div>
  );
}
