import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Ban, Clock, DoorOpen, UserRound } from 'lucide-react';
import type { MeetingAttendeeDto, MeetingDetailDto } from '@flowza/contracts';
import { Badge, Button, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, ErrorState, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { fmtDateTime, fmtMinutes, fmtTime } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { useMeeting, useMeetingMutations } from '../api';
import { MEETINGS_NS } from '../i18n';
import { useBranchZone } from '../use-zone';
import { AttendeeStatusBadge, MeetingPhaseBadge, UnauthorizedBadge } from './badges';

/**
 * One meeting: when and where, who was invited and how each of them came (on time / late by n minutes / absent / not yet, the
 * first entry and how many times they entered), and who walked in uninvited — unauthorised when the room is restricted and
 * they are not allowed in. Without a reader in the room nothing can be measured, which the dialog says first.
 */
export function MeetingDetailDialog({ meetingId, onClose }: { meetingId: string | null; onClose: () => void }) {
  const { t } = useTranslation(MEETINGS_NS);
  const { t: tc } = useTranslation();
  const q = useMeeting(meetingId);
  const m = q.data;
  return (
    <Dialog open={!!meetingId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl" {...(m ? {} : { 'aria-describedby': undefined })}>
        {q.isError ? (
          <>
            <DialogHeader><DialogTitle>{t('title')}</DialogTitle></DialogHeader>
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          </>
        ) : !m ? (
          <>
            <DialogHeader><DialogTitle className="sr-only">{t('detail.loading')}</DialogTitle></DialogHeader>
            <div className="space-y-3" aria-busy><Skeleton className="h-7 w-72" /><Skeleton className="h-16 w-full" /><Skeleton className="h-48 w-full" /></div>
          </>
        ) : <MeetingDetail meeting={m} onClose={onClose} />}
        {!m ? <DialogFooter><Button type="button" variant="outline" onClick={onClose}>{tc('common.close')}</Button></DialogFooter> : null}
      </DialogContent>
    </Dialog>
  );
}

function MeetingDetail({ meeting: m, onClose }: { meeting: MeetingDetailDto; onClose: () => void }) {
  const { t } = useTranslation(MEETINGS_NS);
  const { t: tc } = useTranslation();
  const can = useCan();
  const zone = useBranchZone()(m.branchId);
  const { cancel } = useMeetingMutations();
  const [confirming, setConfirming] = useState(false);
  const canCancel = can('meeting.manage') && m.status === 'scheduled' && m.phase !== 'over';
  const when = t('detail.when', { date: fmtDateTime(m.startsAt, zone, 'cccc dd MMM yyyy'), from: fmtTime(m.startsAt, zone), to: fmtTime(m.endsAt, zone) });
  const stats = [
    { key: 'invited', value: m.invitedCount, tone: '' },
    { key: 'attended', value: m.attendedCount, tone: 'text-emerald-700 dark:text-emerald-300' },
    { key: 'late', value: m.lateCount, tone: m.lateCount ? 'text-amber-700 dark:text-amber-300' : '' },
    { key: 'absent', value: m.absentCount, tone: m.absentCount ? 'text-red-700 dark:text-red-300' : '' },
    { key: 'walkIns', value: m.walkInCount, tone: '' },
  ] as const;
  const onCancel = () => cancel.mutate(m.id, { onSuccess: () => { toast.success(t('detail.cancelled')); setConfirming(false); }, onError: (e) => { toastError(e); setConfirming(false); } });

  return (
    <>
      <DialogHeader>
        <div className="flex flex-wrap items-center gap-2 pe-6">
          <DialogTitle className={m.status === 'cancelled' ? 'line-through decoration-1' : undefined}>{m.title}</DialogTitle>
          <MeetingPhaseBadge meeting={m} />
        </div>
        <DialogDescription asChild>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-1.5"><Clock className="size-3.5" aria-hidden /><span className="tnum">{when}</span></span>
            <span className="inline-flex items-center gap-1.5"><DoorOpen className="size-3.5" aria-hidden />{m.roomName}</span>
            {m.organizerName ? <span className="inline-flex items-center gap-1.5"><UserRound className="size-3.5" aria-hidden />{t('meetings.organizer', { name: m.organizerName })}</span> : null}
            <span className="tnum">{t('detail.lateAfter', { minutes: m.lateAfterMinutes })}</span>
          </div>
        </DialogDescription>
      </DialogHeader>
      {m.description ? <p className="whitespace-pre-line text-sm text-muted-foreground">{m.description}</p> : null}
      {m.noReader ? (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200" data-testid="meeting-no-reader">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {t('detail.noReader')}
        </p>
      ) : null}
      <dl className="grid grid-cols-3 gap-2 sm:grid-cols-5" data-testid="meeting-stats">
        {stats.map((s) => (
          <div key={s.key} className="rounded-lg border bg-muted/30 px-3 py-2">
            <dt className="text-xs text-muted-foreground">{t(`detail.summary.${s.key}`)}</dt>
            <dd className={`tnum text-lg font-semibold ${s.tone}`} data-testid={`meeting-stat-${s.key}`}>{s.value}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="mtg-attendees" className="space-y-2">
        <h3 id="mtg-attendees" className="text-sm font-semibold">{t('detail.attendees')}</h3>
        <AttendeesTable attendees={m.attendees} zone={zone} />
      </section>

      <section aria-labelledby="mtg-walkins" className="space-y-2">
        <h3 id="mtg-walkins" className="text-sm font-semibold">{t('detail.walkIns')}</h3>
        {m.walkIns.length === 0 ? <p className="text-sm text-muted-foreground">{t('detail.noWalkIns')}</p> : (
          <ul className="divide-y rounded-md border" data-testid="meeting-walk-ins">
            {m.walkIns.map((w, i) => (
              <li key={`${w.deviceEmployeeId}-${w.enteredAt}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium">{w.employeeName ?? <span className="font-mono text-xs text-muted-foreground" dir="ltr">{t('detail.unknownCard', { id: w.deviceEmployeeId })}</span>}</span>
                <span className="tnum text-xs text-muted-foreground">{fmtTime(w.enteredAt, zone)}</span>
                {w.unauthorized ? <UnauthorizedBadge /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <DialogFooter>
        {canCancel ? <Button type="button" variant="outline" className="text-destructive sm:me-auto" onClick={() => setConfirming(true)}><Ban /> {t('detail.cancel')}</Button> : null}
        <Button type="button" variant="outline" onClick={onClose}>{tc('common.close')}</Button>
      </DialogFooter>
      <ConfirmDialog open={confirming} onOpenChange={setConfirming} title={t('detail.cancelTitle', { title: m.title })} description={t('detail.cancelHint')} confirmLabel={t('detail.cancel')} destructive loading={cancel.isPending} onConfirm={onCancel} />
    </>
  );
}

/** A table on a wide screen, a list of cards on a phone (both are rendered; CSS shows one). */
function AttendeesTable({ attendees, zone }: { attendees: MeetingAttendeeDto[]; zone: string }) {
  const { t } = useTranslation(MEETINGS_NS);
  const late = (a: MeetingAttendeeDto) => (a.status === 'LATE' && a.lateMinutes > 0 ? t('detail.lateBy', { duration: fmtMinutes(a.lateMinutes) }) : '—');
  return (
    <>
      <div className="hidden rounded-md border sm:block">
        <Table data-testid="meeting-attendees">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t('detail.columns.employee')}</TableHead><TableHead>{t('detail.columns.department')}</TableHead><TableHead>{t('detail.columns.required')}</TableHead>
              <TableHead>{t('detail.columns.status')}</TableHead><TableHead>{t('detail.columns.enteredAt')}</TableHead><TableHead>{t('detail.columns.late')}</TableHead><TableHead className="text-end">{t('detail.columns.entries')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {attendees.map((a) => (
              <TableRow key={a.employeeId} data-testid={`attendee-${a.employeeId}`}>
                <TableCell><p className="font-medium">{a.employeeName}</p>{a.employeeNumber ? <p className="font-mono text-xs text-muted-foreground" dir="ltr">{a.employeeNumber}</p> : null}</TableCell>
                <TableCell className="text-sm">{a.departmentName ?? '—'}</TableCell>
                <TableCell>{a.required ? <span className="text-sm">{t('detail.required')}</span> : <Badge variant="outline" className="font-normal">{t('detail.optional')}</Badge>}</TableCell>
                <TableCell><AttendeeStatusBadge status={a.status} /></TableCell>
                <TableCell className="tnum">{fmtTime(a.enteredAt, zone)}</TableCell>
                <TableCell className={a.status === 'LATE' ? 'tnum text-amber-700 dark:text-amber-300' : 'tnum text-muted-foreground'}>{late(a)}</TableCell>
                <TableCell className="tnum text-end">{a.entries}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="divide-y rounded-md border sm:hidden">
        {attendees.map((a) => (
          <li key={a.employeeId} className="space-y-1 px-3 py-2">
            <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{a.employeeName}</span><AttendeeStatusBadge status={a.status} /></div>
            <p className="text-xs text-muted-foreground tnum">
              {[a.departmentName, a.required ? t('detail.required') : t('detail.optional'), a.enteredAt ? fmtTime(a.enteredAt, zone) : null, a.status === 'LATE' ? late(a) : null, t('detail.entries', { count: a.entries })].filter(Boolean).join(' · ')}
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}
