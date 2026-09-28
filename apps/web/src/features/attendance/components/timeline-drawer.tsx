import { useTranslation } from 'react-i18next';
import { AlertTriangle, Fingerprint, MapPin, PencilLine, Smartphone } from 'lucide-react';
import type { PunchFactsDto, TimelineEventDto, TimelineRawDto } from '@flowza/contracts';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import '../workspace-i18n';
import { useAttendanceTimeline } from '../workspace-api';
import { AttendanceStatusBadge, RawStatusBadge } from './badges';
import type { DayRef } from './record-dialog';

/** Verdicts the engine reads as "not inside a fence it should have been in" (packages/domain calculate.ts). */
const OUTSIDE_VERDICTS = new Set(['flagged', 'logged', 'denied_outside', 'denied_mock', 'outside', 'denied']);
const ROLE_TONE: Record<string, 'success' | 'info' | 'neutral' | 'warning'> = { IN: 'success', OUT: 'info', BREAK_START: 'neutral', BREAK_END: 'neutral', IGNORED: 'warning', DUPLICATE: 'warning', OUT_OF_WINDOW: 'neutral' };

function EventRow({ e, zone }: { e: TimelineEventDto; zone: string }) {
  const { t } = useTranslation('attendance');
  const { t: tw } = useTranslation('attendanceWorkspace');
  return (
    <li className={cn('relative flex gap-3 ps-5', e.voidedAt && 'text-muted-foreground')} data-testid="timeline-event">
      <span className={cn('absolute start-0 top-1.5 size-2.5 rounded-full ring-2 ring-card', e.voidedAt ? 'bg-muted-foreground/40' : e.role === 'IN' ? 'bg-emerald-500' : e.role === 'OUT' ? 'bg-blue-500' : 'bg-slate-400')} aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={cn('font-mono text-sm tnum', e.voidedAt && 'line-through')} dir="ltr">{fmtDateTime(e.punchedAt, zone, 'HH:mm:ss')}</span>
          <Badge variant="secondary" className="text-[10px]">{t(`eventType.${e.eventType}`, { defaultValue: e.eventType })}</Badge>
          {e.role ? <Badge variant={ROLE_TONE[e.role] ?? 'neutral'} className="text-[10px]">{t(`trace.roles.${e.role}`, { defaultValue: e.role })}</Badge> : <Badge variant="outline" className="text-[10px]">{tw('timeline.notAttributed')}</Badge>}
          {e.voidedAt ? <Badge variant="neutral" className="text-[10px]">{t('record.voided')}</Badge> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {t(`eventSource.${e.source}`, { defaultValue: e.source })}{e.deviceName ? ` · ${e.deviceName}` : ''}{e.verificationMethod ? ` · ${e.verificationMethod}` : ''}{e.correctionId ? ` · ${t('record.viaCorrection')}` : ''}
        </p>
        {e.note ? <p className="text-xs">{e.note}</p> : null}
      </div>
    </li>
  );
}

function Facts({ f }: { f: PunchFactsDto }) {
  const { t } = useTranslation('attendanceWorkspace');
  const items: Array<{ key: string; node: React.ReactNode; warn?: boolean }> = [];
  if (f.channel) items.push({ key: 'channel', node: <><Smartphone className="size-3" /> {t(`timeline.channel.${f.channel}`, { defaultValue: f.channel })}</> });
  if (f.geofenceVerdict) items.push({ key: 'geo', warn: OUTSIDE_VERDICTS.has(f.geofenceVerdict.toLowerCase()), node: <><MapPin className="size-3" /> {t(`timeline.geofence.${f.geofenceVerdict.toLowerCase()}`, { defaultValue: f.geofenceVerdict })}{typeof f.distanceM === 'number' ? ` · ${t('timeline.distance', { meters: Math.round(f.distanceM) })}` : ''}</> });
  if (typeof f.accuracy === 'number') items.push({ key: 'acc', node: t('timeline.accuracy', { meters: Math.round(f.accuracy) }) });
  if (f.isMock) items.push({ key: 'mock', warn: true, node: <><AlertTriangle className="size-3" /> {t('timeline.mock')}</> });
  if (f.outOfWindow) items.push({ key: 'window', warn: true, node: t('timeline.outOfWindow') });
  if (!items.length) return null;
  return <span className="flex flex-wrap gap-1">{items.map((i) => <Badge key={i.key} variant={i.warn ? 'warning' : 'outline'} className="text-[10px]">{i.node}</Badge>)}</span>;
}

function RawRow({ r, zone }: { r: TimelineRawDto; zone: string }) {
  const { t } = useTranslation('attendance');
  return (
    <li className="space-y-1 rounded-md border p-2" data-testid="timeline-raw">
      <div className="flex flex-wrap items-center gap-1.5">
        <Fingerprint className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="font-mono text-sm tnum" dir="ltr">{fmtDateTime(r.punchedAt, zone, 'HH:mm:ss')}</span>
        <RawStatusBadge status={r.processingStatus} />
        {r.direction ? <Badge variant="outline" className="text-[10px]">{r.direction}</Badge> : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {r.deviceName ?? t(`eventSource.${r.source}`, { defaultValue: r.source })}{r.deviceEmployeeId ? <> · <span dir="ltr" className="font-mono">{r.deviceEmployeeId}</span></> : null}{r.verificationMethod ? ` · ${r.verificationMethod}` : ''}
        {r.clockSkewSeconds ? ` · ${t('raw.skew', { seconds: r.clockSkewSeconds })}` : ''}
      </p>
      {r.processingError ? <p className="text-xs text-destructive">{r.processingError}</p> : null}
      <Facts f={r.facts} />
    </li>
  );
}

/**
 * Punch timeline of one employee-day (HR portal Prompt 6a): every attendance event of the day's window with the engine's role for
 * it (IN, OUT, ignored, duplicate…), voided punches and corrections — and, for `attendance.view_raw` holders, the raw device
 * transactions behind them with the self-service facts (channel, geofence verdict, accuracy, mock location).
 */
export function TimelineDrawer({ day, onClose, onEdit }: { day: DayRef | null; onClose: () => void; onEdit?: (day: DayRef) => void }) {
  const { t } = useTranslation('attendanceWorkspace');
  const { t: tc } = useTranslation();
  const q = useAttendanceTimeline(day ? { employeeId: day.employeeId, date: day.date } : null);
  const d = q.data;
  const zone = d?.timezone ?? 'UTC';
  return (
    <Dialog open={!!day} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="start-auto end-0 top-0 h-full max-h-none w-full max-w-md translate-x-0 translate-y-0 content-start rounded-none rtl:translate-x-0 sm:max-w-md" data-testid="timeline-drawer">
        <DialogHeader>
          <DialogTitle>{t('timeline.title')}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-foreground">{d?.employeeName ?? day?.employeeName ?? ''}</span>
            {d ? <span className="font-mono text-xs" dir="ltr">{d.employeeNumber}</span> : null}
            {day ? <span className="tnum">· {fmtDate(day.date, 'EEE dd MMM yyyy')}</span> : null}
            {d?.status ? <AttendanceStatusBadge status={d.status} /> : null}
          </DialogDescription>
        </DialogHeader>
        {q.isLoading ? <div className="space-y-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
          : q.isError || !d ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          : (
            <div className="space-y-5">
              <p className="text-xs text-muted-foreground">{t('timeline.window', { from: fmtDateTime(d.window.from, zone, 'dd MMM HH:mm'), to: fmtDateTime(d.window.to, zone, 'dd MMM HH:mm'), zone })}</p>
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">{t('timeline.events', { count: d.events.length })}</h3>
                {d.events.length === 0 ? <EmptyState title={t('timeline.noEvents')} className="py-6" /> : <ol className="space-y-3 border-s ps-0">{d.events.map((e) => <EventRow key={e.id} e={e} zone={zone} />)}</ol>}
              </section>
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">{t('timeline.raw', { count: d.raw?.length ?? 0 })}</h3>
                {d.raw === null ? <p className="text-xs text-muted-foreground">{t('timeline.rawHidden')}</p>
                  : d.raw.length === 0 ? <p className="text-xs text-muted-foreground">{t('timeline.noRaw')}</p>
                  : <ul className="space-y-2">{d.raw.map((r) => <RawRow key={r.id} r={r} zone={zone} />)}</ul>}
              </section>
            </div>
          )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc('common.close')}</Button>
          {day && onEdit ? <Button type="button" onClick={() => onEdit(day.employeeName || !d ? day : { ...day, employeeName: d.employeeName })}><PencilLine /> {t('edit.titleEdit')}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
