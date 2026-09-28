import { useTranslation } from 'react-i18next';
import type { AttendanceNoteStatus, GeofenceVerdict, RegularisationStatus, SelfieCheckinStatus, ShiftSwapStatus } from '@flowza/contracts';
import { Badge } from '@/components/ui';
import { PA_NS } from '../attendance-i18n';

type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';
const NOTE_TONE: Record<AttendanceNoteStatus, Tone> = { pending: 'warning', info_requested: 'info', approved: 'success', excused: 'success', rejected: 'danger' };
const REQUEST_TONE: Record<RegularisationStatus | ShiftSwapStatus, Tone> = { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'neutral' };
const SELFIE_TONE: Record<SelfieCheckinStatus, Tone> = { pending: 'warning', approved: 'success', rejected: 'danger' };
const VERDICT_TONE: Record<GeofenceVerdict, Tone> = { no_fence: 'neutral', allowed: 'success', flagged: 'warning', logged: 'info', denied_outside: 'danger', denied_mock: 'danger' };

export function NoteStatusBadge({ status }: { status: AttendanceNoteStatus }) {
  const { t } = useTranslation(PA_NS);
  return <Badge variant={NOTE_TONE[status] ?? 'neutral'} dot>{t(`notes.status.${status}`)}</Badge>;
}
export function RegularisationStatusBadge({ status }: { status: RegularisationStatus }) {
  const { t } = useTranslation(PA_NS);
  return <Badge variant={REQUEST_TONE[status] ?? 'neutral'} dot>{t(`regularisation.status.${status}`)}</Badge>;
}
export function SwapStatusBadge({ status }: { status: ShiftSwapStatus }) {
  const { t } = useTranslation(PA_NS);
  return <Badge variant={REQUEST_TONE[status] ?? 'neutral'} dot>{t(`swap.status.${status}`)}</Badge>;
}
export function SelfieStatusBadge({ status }: { status: SelfieCheckinStatus }) {
  const { t } = useTranslation(PA_NS);
  return <Badge variant={SELFIE_TONE[status] ?? 'neutral'} dot>{t(`selfies.status.${status}`)}</Badge>;
}
/** Geofence verdict of a punch (a short chip; the check-in page's banner carries the full sentence). */
export function VerdictChip({ verdict }: { verdict: GeofenceVerdict | null | undefined }) {
  const { t } = useTranslation(PA_NS);
  if (!verdict) return null;
  return <Badge variant={VERDICT_TONE[verdict] ?? 'neutral'}>{t(`checkin.verdictChip.${verdict}`)}</Badge>;
}
