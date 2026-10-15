import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MEETING_BACKDATE_GRACE_MINUTES, meetingInputSchema, type MeetingDetailDto, type MeetingRoomDto } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Textarea } from '@/components/ui';
import { Combobox, type ComboboxOption } from '@/components/forms';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useMeetingMutations } from '../api';
import { MEETINGS_NS } from '../i18n';
import { defaultSlot, zonedInstant } from '../model';
import { InviteePicker, type Invitee } from './invitee-picker';

const MAX_MINUTES = 12 * 60;

/**
 * Book a room: title, room, the day and the window in the ROOM's local time (its branch's zone, `room.timezone` from the API —
 * sent as instants; never converted in a fallback zone), when an entry counts as late, and the invitees (each required unless
 * unticked). The API refuses a clash with another booking of the room, more invitees than its capacity and — unless the caller
 * administers the rooms — a start in the past; the capacity and the start are checked here first.
 */
export function MeetingDialog({ open, onOpenChange, rooms, roomId: initialRoomId, day, onCreated }: {
  open: boolean; onOpenChange: (open: boolean) => void; rooms: MeetingRoomDto[]; roomId?: string | null; day?: string | null; onCreated?: (meeting: MeetingDetailDto) => void;
}) {
  const { t } = useTranslation(MEETINGS_NS);
  const { t: tc } = useTranslation();
  const orgTz = useOrgTimezone();
  const can = useCan();
  const { create } = useMeetingMutations();
  const bookable = useMemo(() => rooms.filter((r) => r.status === 'active'), [rooms]);
  const [roomId, setRoomId] = useState<string | null>(() => (initialRoomId && bookable.some((r) => r.id === initialRoomId) ? initialRoomId : bookable.length === 1 ? bookable[0]!.id : null));
  const room = bookable.find((r) => r.id === roomId) ?? null;
  // the window is read in the room's zone only; before a room is picked the organisation's zone merely seeds the default slot
  const zone = room?.timezone ?? null;
  const [slot] = useState(() => defaultSlot(zone ?? orgTz, day ?? null));
  // the clock when the dialog opened (it mounts per booking): "in the past" is judged against it, the API re-checks on save
  const [openedAt] = useState(() => Date.now());
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(slot.date);
  const [start, setStart] = useState(slot.start);
  const [end, setEnd] = useState(slot.end);
  const [lateAfter, setLateAfter] = useState('5');
  const [invitees, setInvitees] = useState<Invitee[]>([]);
  const [touched, setTouched] = useState(false);

  const roomOptions = useMemo<ComboboxOption[]>(() => bookable.map((r) => ({ value: r.id, label: r.name, description: [r.branchName, r.locationName].filter(Boolean).join(' › '), keywords: [r.locationName ?? '', r.branchName ?? ''] })), [bookable]);
  const startsAt = zone ? zonedInstant(date, start, zone) : null;
  const endsAt = zone ? zonedInstant(date, end, zone) : null;
  const minutes = startsAt && endsAt ? (Date.parse(endsAt) - Date.parse(startsAt)) / 60_000 : null;
  const timeError = minutes === null ? undefined : minutes <= 0 ? t('form.endBeforeStart') : minutes > MAX_MINUTES ? t('form.tooLong') : undefined;
  // a booking after the fact would show who entered the room then: only the room administrators (meeting.rooms) may backdate
  const inPast = !can('meeting.rooms') && startsAt !== null && Date.parse(startsAt) < openedAt - MEETING_BACKDATE_GRACE_MINUTES * 60_000;
  const overCapacity = room?.capacity !== null && room?.capacity !== undefined && invitees.length > room.capacity;
  const lateMinutes = lateAfter.trim() === '' ? undefined : Number(lateAfter);
  const parsed = meetingInputSchema.safeParse({
    roomId, title, description: description.trim() || undefined, startsAt, endsAt, lateAfterMinutes: lateMinutes,
    invitees: invitees.map((i) => ({ employeeId: i.employeeId, required: i.required })),
  });
  const issue = (path: string) => (parsed.success ? undefined : parsed.error.issues.find((i) => i.path[0] === path));
  const ready = parsed.success && !timeError && !overCapacity && !inPast;

  const onSave = () => {
    setTouched(true);
    if (!parsed.success || !ready) return;
    create.mutate(parsed.data, {
      onSuccess: (m) => { toast.success(t('form.created')); onOpenChange(false); onCreated?.(m); },
      onError: toastError,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>{t('form.title')}</DialogTitle><DialogDescription>{zone ? t('form.hint', { zone }) : t('form.hintNoRoom')}</DialogDescription></DialogHeader>
        <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); onSave(); }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('form.meetingTitle')} htmlFor="mtg-title" required error={touched && issue('title') ? tc('common.required') : undefined}>
              <Input id="mtg-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} aria-invalid={touched && !!issue('title')} />
            </FormField>
            <FormField label={t('form.room')} htmlFor="mtg-room" required error={touched && !roomId ? tc('common.required') : undefined}>
              <Combobox id="mtg-room" value={roomId} onChange={setRoomId} options={roomOptions} placeholder={t('form.selectRoom')} emptyText={t('form.noRooms')} aria-invalid={touched && !roomId} />
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <FormField label={t('form.date')} htmlFor="mtg-date" required>
              <Input id="mtg-date" type="date" dir="ltr" value={date} onChange={(e) => setDate(e.target.value)} />
            </FormField>
            <FormField label={t('form.start')} htmlFor="mtg-start" required error={inPast ? t('form.inPast') : undefined}>
              <Input id="mtg-start" type="time" dir="ltr" value={start} onChange={(e) => setStart(e.target.value)} aria-invalid={inPast} />
            </FormField>
            <FormField label={t('form.end')} htmlFor="mtg-end" required error={timeError}>
              <Input id="mtg-end" type="time" dir="ltr" value={end} onChange={(e) => setEnd(e.target.value)} aria-invalid={!!timeError} />
            </FormField>
            <FormField label={t('form.lateAfter')} htmlFor="mtg-late" error={issue('lateAfterMinutes') ? t('form.lateAfterRange') : undefined}>
              <Input id="mtg-late" type="number" inputMode="numeric" min={0} max={120} dir="ltr" className="tnum" value={lateAfter} onChange={(e) => setLateAfter(e.target.value)} aria-invalid={!!issue('lateAfterMinutes')} />
            </FormField>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">{t('form.lateAfterHint')}</p>
          <FormField label={t('form.invitees')} htmlFor="mtg-invitees" required hint={t('form.requiredHint')}
            error={overCapacity ? t('form.overCapacity', { capacity: room?.capacity ?? 0, count: invitees.length }) : touched && invitees.length === 0 ? t('form.noInvitees') : undefined}>
            <InviteePicker id="mtg-invitees" value={invitees} onChange={setInvitees} invalid={overCapacity || (touched && invitees.length === 0)} />
          </FormField>
          <FormField label={t('form.description')} htmlFor="mtg-description" optional>
            <Textarea id="mtg-description" rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" disabled={touched && !ready} loading={create.isPending} data-testid="meeting-save">{t('form.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
