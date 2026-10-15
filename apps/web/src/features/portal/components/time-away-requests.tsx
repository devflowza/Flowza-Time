import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DoorOpen, Plus, Undo2 } from 'lucide-react';
import type { TimeAwayRequestDto } from '@flowza/contracts';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton } from '@/components/ui';
import { fmtDate, fmtMinutes, fmtTime, todayIso } from '@/lib/format';
import { toast } from '@/lib/toast';
import { PA_NS } from '../attendance-i18n';
import { useMyTimeAway, useTimeAwayMutations, useTimeAwayStatus } from '../time-away-api';
import { useTimeAwayErrorToast } from '../use-time-away-error';
import { TimeAwayStatusBadge } from './attendance-badges';
import { RequestTimeAwayDialog } from './time-away-dialogs';

/** The window in the employee's zone; a step-out also says when the employee came back (or that they have not yet). */
function WindowCell({ r, timezone }: { r: TimeAwayRequestDto; timezone: string }) {
  const { t } = useTranslation(PA_NS);
  return (
    <TableCell className="whitespace-nowrap text-xs">
      <span className="block font-medium tnum" dir="ltr">{fmtTime(r.startsAt, timezone)} – {fmtTime(r.endsAt, timezone)}</span>
      {r.source === 'step_out' ? <span className="block text-muted-foreground tnum">{r.returnedAt ? t('timeAway.returnedAt', { time: fmtTime(r.returnedAt, timezone) }) : t('timeAway.notBack')}</span> : null}
    </TableCell>
  );
}

/**
 * /my/requests?tab=time-away — the employee's time-away requests (planned windows and step-outs) with their approval, a
 * "Request time away" dialog, and Withdraw for a pending one. Times are shown in the employee's zone (the status endpoint's,
 * else the organisation's).
 */
export function TimeAwayTab({ fallbackTimezone }: { fallbackTimezone: string }) {
  const { t } = useTranslation(PA_NS);
  const status = useTimeAwayStatus();
  const q = useMyTimeAway();
  const { cancel } = useTimeAwayMutations();
  const toastError = useTimeAwayErrorToast();
  const [requesting, setRequesting] = useState(false);
  const [withdrawing, setWithdrawing] = useState<TimeAwayRequestDto | null>(null);
  const tz = status.data?.timezone ?? fallbackTimezone;
  const today = status.data?.date ?? todayIso(tz);
  const rows = q.data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('timeAway.requestHint')}</p>
        <Button onClick={() => setRequesting(true)} data-testid="time-away-request"><Plus /> {t('timeAway.request')}</Button>
      </div>
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        : q.isLoading ? <TableSkeleton cols={6} rows={3} />
        : rows.length === 0 ? <EmptyState icon={DoorOpen} title={t('timeAway.empty')} description={t('timeAway.emptyHint')} />
        : (
          <div className="rounded-xl border bg-card shadow-card">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('requests.columns.date')}</TableHead>
                    <TableHead>{t('timeAway.columns.window')}</TableHead>
                    <TableHead>{t('timeAway.columns.kind')}</TableHead>
                    <TableHead className="text-end">{t('timeAway.columns.minutes')}</TableHead>
                    <TableHead>{t('requests.columns.status')}</TableHead>
                    <TableHead>{t('requests.columns.decision')}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id} data-testid="time-away-row">
                      <TableCell className="whitespace-nowrap font-medium tnum">{fmtDate(r.attendanceDate, 'EEE dd MMM')}</TableCell>
                      <WindowCell r={r} timezone={tz} />
                      <TableCell className="max-w-[280px] text-xs">
                        <span className="flex flex-wrap items-center gap-1.5"><span className="font-medium">{t(`timeAway.kinds.${r.kind}`)}</span><Badge variant="outline">{t(`timeAway.source.${r.source}`)}</Badge></span>
                        <span className="block truncate text-muted-foreground" title={r.reason} dir="auto">{r.reason}</span>
                        {r.destination ? <span className="block truncate text-muted-foreground" title={r.destination} dir="auto">{r.destination}</span> : null}
                      </TableCell>
                      <TableCell className="text-end tnum">{fmtMinutes(r.minutes)}</TableCell>
                      <TableCell><TimeAwayStatusBadge status={r.status} /></TableCell>
                      <TableCell className="max-w-[240px] text-xs">
                        {r.decidedByName ? <span className="block">{t('notes.reviewedBy', { name: r.decidedByName })}</span> : null}
                        {r.decisionNote ? <span className="block truncate text-muted-foreground" title={r.decisionNote} dir="auto">{r.decisionNote}</span> : null}
                      </TableCell>
                      <TableCell className="text-end">{r.status === 'pending' ? <Button size="sm" variant="ghost" onClick={() => setWithdrawing(r)}><Undo2 /> {t('timeAway.withdraw')}</Button> : null}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      <ConfirmDialog open={!!withdrawing} onOpenChange={(o) => !o && setWithdrawing(null)} title={t('timeAway.withdrawTitle')} description={t('timeAway.withdrawHint')} confirmLabel={t('timeAway.withdraw')} destructive loading={cancel.isPending}
        onConfirm={() => { if (!withdrawing) return; cancel.mutate(withdrawing.id, { onSuccess: () => { toast.success(t('timeAway.withdrawn')); setWithdrawing(null); }, onError: toastError }); }} />
      {requesting ? <RequestTimeAwayDialog open onOpenChange={setRequesting} timezone={tz} today={today} policy={status.data?.policy} /> : null}
    </div>
  );
}
