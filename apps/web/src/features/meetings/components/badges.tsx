import { useTranslation } from 'react-i18next';
import { ShieldAlert } from 'lucide-react';
import type { AttendeeStatus, MeetingDto, MeetingRoomDto } from '@flowza/contracts';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/utils';
import { MEETINGS_NS } from '../i18n';
import { ATTENDEE_TONE, PHASE_TONE, readerDotClass } from '../model';

/** Upcoming / in progress / over — or Cancelled, which outranks the phase. */
export function MeetingPhaseBadge({ meeting }: { meeting: Pick<MeetingDto, 'phase' | 'status'> }) {
  const { t } = useTranslation(MEETINGS_NS);
  if (meeting.status === 'cancelled') return <Badge variant="neutral" className="line-through decoration-1">{t('phase.cancelled')}</Badge>;
  return <Badge variant={PHASE_TONE[meeting.phase]} dot={meeting.phase === 'in_progress'}>{t(`phase.${meeting.phase}`)}</Badge>;
}

export function AttendeeStatusBadge({ status }: { status: AttendeeStatus }) {
  const { t } = useTranslation(MEETINGS_NS);
  return <Badge variant={ATTENDEE_TONE[status]} data-status={status}>{t(`attendeeStatus.${status}`)}</Badge>;
}

export function UnauthorizedBadge() {
  const { t } = useTranslation(MEETINGS_NS);
  return <Badge variant="danger"><ShieldAlert className="size-3" aria-hidden />{t('access.unauthorized')}</Badge>;
}

/** One dot per reader of the room, coloured by its connection; "No reader" when attendance cannot be measured. */
export function ReaderDots({ readers }: { readers: MeetingRoomDto['readers'] }) {
  const { t } = useTranslation(MEETINGS_NS);
  if (readers.length === 0) return <Badge variant="warning">{t('rooms.noReaders')}</Badge>;
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {readers.map((r) => {
        const status = t(`connection.${r.connectionStatus}`, { defaultValue: r.connectionStatus });
        return (
          <li key={r.id} className="inline-flex items-center gap-1.5 text-xs" title={`${r.name} (${r.code}) — ${status}`}>
            <span className={cn('size-2 shrink-0 rounded-full', readerDotClass(r.connectionStatus))} aria-hidden />
            <span className="max-w-32 truncate">{r.name}</span>
            <span className="sr-only">— {status}</span>
          </li>
        );
      })}
    </ul>
  );
}
