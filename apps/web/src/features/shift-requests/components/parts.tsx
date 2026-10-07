import { useTranslation } from 'react-i18next';
import type { ShiftChangeKind, ShiftChangeRequestDto, ShiftChangeStatus } from '@flowza/contracts';
import { Badge } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { SR_NS } from '../i18n';

const TONE: Record<ShiftChangeStatus, 'warning' | 'success' | 'danger' | 'neutral'> = { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'neutral' };

export function ShiftChangeStatusBadge({ status }: { status: ShiftChangeStatus }) {
  const { t } = useTranslation(SR_NS);
  return <Badge variant={TONE[status] ?? 'neutral'} dot>{t(`status.${status}`)}</Badge>;
}

export function ShiftChangeKindBadge({ kind }: { kind: ShiftChangeKind }) {
  const { t } = useTranslation(SR_NS);
  return <Badge variant={kind === 'ADDITIONAL' ? 'info' : 'outline'}>{t(`kinds.${kind}`)}</Badge>;
}

/** "12 Oct" for one day, "12 Oct → 14 Oct" for a range. */
export function RangeText({ from, to, fmt = 'EEE dd MMM' }: { from: string; to: string; fmt?: string }) {
  const { t } = useTranslation(SR_NS);
  return <span className="whitespace-nowrap tnum">{from === to ? fmtDate(from, fmt) : t('range', { from: fmtDate(from, fmt), to: fmtDate(to, fmt) })}</span>;
}

/** "Morning → Day" for a change, "+ Evening" for an additional shift. */
export function ShiftsText({ r }: { r: Pick<ShiftChangeRequestDto, 'kind' | 'currentShift' | 'requestedShift'> }) {
  const { t } = useTranslation(SR_NS);
  const requested = r.requestedShift?.name ?? '—';
  if (r.kind === 'ADDITIONAL') return <span dir="auto">{t('plus', { shift: requested })}</span>;
  return <span dir="auto">{t('shiftChange', { from: r.currentShift?.name ?? '—', to: requested })}</span>;
}
