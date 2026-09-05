import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardPlus, Lock } from 'lucide-react';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, ErrorState, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtMinutes, fmtTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useAttendanceRecord } from '../api';
import type { RecordDetail } from '../types';
import { AttendanceStatusBadge, CorrectionStatusBadge, CorrectionTypeBadge, FlagChips } from './badges';
import { TraceView } from './trace-view';

export interface CorrectionPreset { employeeId: string; employeeName?: string; attendanceDate: string; timezone?: string }

function Stat({ label, value, sub, className }: { label: string; value: React.ReactNode; sub?: string; className?: string }) {
  return <div className={cn('min-w-0 rounded-md border bg-muted/30 p-2.5', className)}><p className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p><p className="truncate text-sm font-semibold tnum">{value}</p>{sub ? <p className="truncate text-xs text-muted-foreground">{sub}</p> : null}</div>;
}

function Summary({ r }: { r: RecordDetail }) {
  const { t } = useTranslation('attendance');
  const tz = r.timezone;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
      <Stat label={t('record.shift')} value={r.shiftName ?? t('record.noShift')} sub={r.expectedStartAt && r.expectedEndAt ? `${fmtTime(r.expectedStartAt, tz)} – ${fmtTime(r.expectedEndAt, tz)}` : undefined} />
      <Stat label={t('columns.firstIn')} value={fmtTime(r.firstInAt, tz)} />
      <Stat label={t('columns.lastOut')} value={fmtTime(r.lastOutAt, tz)} />
      <Stat label={t('columns.worked')} value={fmtMinutes(r.workedMinutes)} sub={r.breakMinutes ? t('record.break', { value: fmtMinutes(r.breakMinutes) }) : undefined} />
      <Stat label={t('record.scheduled')} value={fmtMinutes(r.scheduledMinutes)} />
      <Stat label={t('columns.late')} value={fmtMinutes(r.lateMinutes)} className={r.lateMinutes > 0 ? 'border-amber-300' : undefined} />
      <Stat label={t('columns.early')} value={fmtMinutes(r.earlyDepartureMinutes)} className={r.earlyDepartureMinutes > 0 ? 'border-amber-300' : undefined} />
      <Stat label={t('columns.overtime')} value={fmtMinutes(r.overtimeMinutes)} sub={r.overtimeCategory ? t(`overtimeCategory.${r.overtimeCategory}`, { defaultValue: r.overtimeCategory }) : undefined} />
      <Stat label={t('record.punches')} value={r.punchCount} />
      <Stat label={t('record.version')} value={`v${r.calculationVersion}`} sub={fmtDateTime(r.computedAt, tz)} />
    </div>
  );
}

function EventsTab({ r }: { r: RecordDetail }) {
  const { t } = useTranslation('attendance');
  if (r.events.length === 0) return <EmptyState title={t('record.noEvents')} description={t('record.noEventsHint')} className="py-8" />;
  return (
    <Table>
      <TableHeader><TableRow><TableHead>{t('record.eventTime')}</TableHead><TableHead>{t('record.eventType')}</TableHead><TableHead>{t('record.source')}</TableHead><TableHead>{t('record.device')}</TableHead><TableHead>{t('record.verification')}</TableHead><TableHead>{t('record.attributed')}</TableHead></TableRow></TableHeader>
      <TableBody>
        {r.events.map((e) => (
          <TableRow key={e.id} className={cn(e.voidedAt && 'text-muted-foreground line-through')}>
            <TableCell className="font-mono text-xs tnum" dir="ltr">{fmtDateTime(e.punchedAt, r.timezone, 'dd MMM HH:mm:ss')}</TableCell>
            <TableCell><Badge variant="secondary">{t(`eventType.${e.eventType}`, { defaultValue: e.eventType })}</Badge></TableCell>
            <TableCell className="text-xs">{t(`eventSource.${e.source}`, { defaultValue: e.source })}{e.correctionId ? <span className="ms-1 text-muted-foreground">({t('record.viaCorrection')})</span> : null}</TableCell>
            <TableCell className="text-xs">{e.deviceName ?? '—'}</TableCell>
            <TableCell className="text-xs">{e.verificationMethod ?? '—'}</TableCell>
            <TableCell>{e.voidedAt ? <Badge variant="neutral">{t('record.voided')}</Badge> : e.attributed === null ? <span className="text-xs text-muted-foreground">—</span> : e.attributed ? <Badge variant="success">{t('record.yes')}</Badge> : <Badge variant="outline">{t('record.otherDay')}</Badge>}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const SNAPSHOT_KEYS = ['status', 'workedMinutes', 'lateMinutes', 'earlyDepartureMinutes', 'overtimeMinutes', 'punchCount'] as const;
function HistoryTab({ r }: { r: RecordDetail }) {
  const { t } = useTranslation('attendance');
  if (r.history.length === 0) return <EmptyState title={t('record.noHistory')} description={t('record.noHistoryHint')} className="py-8" />;
  return (
    <ol className="space-y-3">
      {r.history.map((h) => (
        <li key={h.id} className="rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm"><Badge variant="outline">v{h.calculationVersion}</Badge><span className="font-medium">{h.reason ?? t('record.recomputed')}</span><span className="ms-auto text-xs text-muted-foreground tnum">{fmtDateTime(h.createdAt, r.timezone)}</span></div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {SNAPSHOT_KEYS.filter((k) => h.snapshot[k] !== undefined).map((k) => <span key={k} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] tnum" dir="ltr">{k}={k === 'status' ? String(h.snapshot[k]) : fmtMinutes(Number(h.snapshot[k]))}</span>)}
            {h.triggeredBy ? <span className="text-xs text-muted-foreground">{t('record.triggeredBy', { by: h.triggeredBy })}</span> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function CorrectionSummary({ c, timezone }: { c: RecordDetail['corrections'][number]; timezone: string }) {
  const { t } = useTranslation('attendance');
  if (c.type === 'SET_STATUS') return <span className="text-xs">→ <AttendanceStatusBadge status={c.proposedStatus ?? ''} /></span>;
  return <span className="font-mono text-xs tnum" dir="ltr">{c.originalPunchedAt ? fmtTime(c.originalPunchedAt, timezone, 'dd MMM HH:mm') : t('record.newPunch')} → {c.type === 'REMOVE_PUNCH' ? t('record.removed') : c.proposedPunchedAt ? fmtTime(c.proposedPunchedAt, timezone, 'dd MMM HH:mm') : '—'}</span>;
}

function CorrectionsTab({ r }: { r: RecordDetail }) {
  const { t } = useTranslation('attendance');
  if (r.corrections.length === 0) return <EmptyState title={t('record.noCorrections')} description={t('record.noCorrectionsHint')} className="py-8" />;
  return (
    <Table>
      <TableHeader><TableRow><TableHead>{t('record.correctionType')}</TableHead><TableHead>{t('record.change')}</TableHead><TableHead>{t('record.reason')}</TableHead><TableHead>{t('common:common.status')}</TableHead><TableHead>{t('common:common.createdAt')}</TableHead></TableRow></TableHeader>
      <TableBody>
        {r.corrections.map((c) => (
          <TableRow key={c.id}>
            <TableCell><CorrectionTypeBadge type={c.type} /></TableCell>
            <TableCell><CorrectionSummary c={c} timezone={r.timezone} /></TableCell>
            <TableCell className="max-w-[240px] truncate text-xs" title={c.reason}>{c.reason}</TableCell>
            <TableCell><CorrectionStatusBadge status={c.status} /></TableCell>
            <TableCell className="text-xs tnum">{fmtDateTime(c.createdAt, r.timezone)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Daily record detail: summary, calculation trace, events, history and corrections. */
export function RecordDialog({ recordId, onClose, onRequestCorrection }: { recordId: string | null; onClose: () => void; onRequestCorrection?: (preset: CorrectionPreset) => void }) {
  const { t } = useTranslation('attendance');
  const { t: tc } = useTranslation();
  const orgTz = useOrgTimezone();
  const can = useCan();
  const q = useAttendanceRecord(recordId);
  const [tab, setTab] = useState('trace');
  const r = q.data;
  return (
    <Dialog open={!!recordId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {r ? <>{r.employeeName ?? t('record.title')} <span className="font-mono text-sm font-normal text-muted-foreground" dir="ltr">{r.employeeNumber}</span></> : t('record.title')}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            {r ? <><span className="tnum">{fmtDate(r.attendanceDate, 'EEEE, dd MMM yyyy')}</span> · <span dir="ltr">{r.timezone}</span> <AttendanceStatusBadge status={r.status} /> <FlagChips flags={r.flags} max={6} size="xs" /> {r.lockedAt ? <Badge variant="neutral"><Lock className="size-3" /> {t('record.locked')}</Badge> : null}</> : t('record.subtitle')}
          </DialogDescription>
        </DialogHeader>
        {q.isLoading ? <div className="space-y-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-8 w-64" /><Skeleton className="h-48 w-full" /></div>
          : q.isError || !r ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          : (
            <div className="space-y-4">
              <Summary r={r} />
              <Tabs value={tab} onValueChange={setTab}>
                <TabsList aria-label={t('record.title')} className="max-w-full overflow-x-auto">
                  <TabsTrigger value="trace">{t('record.tabs.trace')}</TabsTrigger>
                  <TabsTrigger value="events">{t('record.tabs.events', { count: r.events.length })}</TabsTrigger>
                  <TabsTrigger value="history">{t('record.tabs.history', { count: r.history.length })}</TabsTrigger>
                  <TabsTrigger value="corrections">{t('record.tabs.corrections', { count: r.corrections.length })}</TabsTrigger>
                </TabsList>
                <TabsContent value="trace"><TraceView trace={r.trace} timezone={r.timezone || orgTz} /></TabsContent>
                <TabsContent value="events"><EventsTab r={r} /></TabsContent>
                <TabsContent value="history"><HistoryTab r={r} /></TabsContent>
                <TabsContent value="corrections"><CorrectionsTab r={r} /></TabsContent>
              </Tabs>
            </div>
          )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc('common.close')}</Button>
          {r && onRequestCorrection && can('attendance.correct') ? (
            <Button type="button" disabled={!!r.lockedAt} title={r.lockedAt ? t('record.lockedHint') : undefined} onClick={() => onRequestCorrection({ employeeId: r.employeeId, employeeName: r.employeeName, attendanceDate: r.attendanceDate, timezone: r.timezone })}><ClipboardPlus /> {t('record.requestCorrection')}</Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
