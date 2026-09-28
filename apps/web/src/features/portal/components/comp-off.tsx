import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CalendarPlus, GitCommitVertical, Repeat } from 'lucide-react';
import type { CompOffCreditDto, CompOffStatus } from '@flowza/contracts';
import { Badge, Button, Card, CardContent, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Skeleton, Textarea } from '@/components/ui';
import { fmtDate, fmtMinutes, todayIso } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useOrgTimezone } from '@/features/me/use-me';
import { toastMutationError } from '@/features/attendance/period-locked';
import { compOffDaysEarned } from '@/features/leave/model';
import { useCompOffPreview, useRequestCompOff, useSelfCompOff } from '../leave-api';
import { fmtDays } from '../model';
import { SectionTitle } from './parts';

const CREDIT_TONE: Record<CompOffStatus, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = { pending_approval: 'warning', approved: 'success', partially_used: 'info', used: 'neutral', rejected: 'danger', expired: 'neutral', cancelled: 'neutral' };

function CreditRow({ c, onTimeline }: { c: CompOffCreditDto; onTimeline: (id: string) => void }) {
  const { t } = useTranslation('leave');
  return (
    <li className="flex items-start justify-between gap-2 py-2.5 first:pt-0">
      <div className="min-w-0 text-sm">
        <p className="font-medium tnum">{fmtDate(c.workedOn, 'EEE dd MMM yyyy')} <span className="text-xs font-normal text-muted-foreground">· {t(`compOff.dayType.${c.workedOnType}`)}</span></p>
        <p className="text-xs text-muted-foreground tnum">{t('compOff.earned', { days: fmtDays(c.daysEarned) })}{c.remainingDays > 0 ? ` · ${t('compOff.left', { days: fmtDays(c.remainingDays) })}` : ''}{c.expiresOn && (c.status === 'approved' || c.status === 'partially_used') ? ` · ${t('compOff.expires', { date: fmtDate(c.expiresOn) })}` : ''}</p>
        {c.decisionNote && c.status === 'rejected' ? <p className="text-xs text-muted-foreground">{c.decisionNote}</p> : null}
        {c.approvalRequestId ? <Button size="sm" variant="link" className="h-auto p-0 text-xs" onClick={() => onTimeline(c.approvalRequestId!)}><GitCommitVertical className="size-3.5" /> {t('compOff.timeline')}</Button> : null}
      </div>
      <Badge variant={CREDIT_TONE[c.status] ?? 'neutral'} dot>{t(`compOff.status.${c.status}`, { defaultValue: c.status })}</Badge>
    </li>
  );
}

/**
 * Comp-off on /my/leave: the credits earned for work on weekly off days and holidays (approved through the engine, usable
 * until their expiry), a request for a new one, and "Use comp-off" — a leave of the comp-off type, consumed on approval.
 */
export function CompOffCard({ onUse, onTimeline, canUse }: { onUse: () => void; onTimeline: (requestId: string) => void; canUse: boolean }) {
  const { t } = useTranslation('leave');
  const q = useSelfCompOff();
  const [requestOpen, setRequestOpen] = useState(false);
  const b = q.data?.balance;
  const credits = q.data?.credits ?? [];
  return (
    <Card>
      <SectionTitle title={t('compOff.title')} />
      <CardContent className="space-y-4">
        {q.isLoading ? <Skeleton className="h-20 w-full" /> : (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <p><span className="text-2xl font-semibold tnum" data-testid="comp-off-available">{fmtDays(b?.availableDays ?? 0)}</span> <span className="text-xs text-muted-foreground">{t('compOff.availableLabel')}</span></p>
              {b && b.pendingDays > 0 ? <span className="text-xs text-muted-foreground tnum">{t('compOff.reserved', { days: fmtDays(b.pendingDays) })}</span> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setRequestOpen(true)}><CalendarPlus /> {t('compOff.request')}</Button>
              <Button size="sm" onClick={onUse} disabled={!canUse || !b || b.availableAfterPendingDays <= 0}><Repeat /> {t('compOff.use')}</Button>
            </div>
            {credits.length ? <ul className="divide-y">{credits.slice(0, 6).map((c) => <CreditRow key={c.id} c={c} onTimeline={onTimeline} />)}</ul> : <p className="text-sm text-muted-foreground">{t('compOff.empty')}</p>}
          </>
        )}
      </CardContent>
      <CompOffRequestDialog key={String(requestOpen)} open={requestOpen} onOpenChange={setRequestOpen} rules={q.data?.rules ?? { fullDayHours: 8, halfDayHours: 4, expiryDays: 90 }} />
    </Card>
  );
}

/**
 * Request a comp-off credit for a worked day. The preview says what the date is (weekly off or which holiday), what the
 * attendance record shows and why it cannot earn a credit; the days follow the minutes claimed (a full day from the
 * organisation's full-day hours, half a day from half of them). The approver sees the recorded minutes next to the claim.
 */
export function CompOffRequestDialog({ open, onOpenChange, rules }: { open: boolean; onOpenChange: (o: boolean) => void; rules: { fullDayHours: number; halfDayHours: number; expiryDays: number } }) {
  const { t } = useTranslation('leave');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const today = todayIso(tz);
  const [workedOn, setWorkedOn] = useState('');
  const [hours, setHours] = useState<string | null>(null);
  const [location, setLocation] = useState('');
  const [summary, setSummary] = useState('');
  const preview = useCompOffPreview(workedOn || null);
  const request = useRequestCompOff();
  const p = preview.data;
  // until the employee types a figure, the claim follows what the attendance record shows
  const recordedHours = p?.recordedMinutes ? String(Math.round((p.recordedMinutes / 60) * 100) / 100) : '';
  const hoursText = hours ?? recordedHours;
  const minutes = Math.round(Number(hoursText || 0) * 60);
  const days = compOffDaysEarned(minutes, rules.fullDayHours);
  const ready = !!p && p.eligible && !!p.workedOnType && days > 0 && location.trim().length > 0 && summary.trim().length > 0 && minutes > 0 && minutes <= 1440;
  const submit = () => {
    if (!ready || !p?.workedOnType) return;
    request.mutate({ workedOn, workedOnType: p.workedOnType, workedMinutes: minutes, location: location.trim(), summary: summary.trim() }, {
      onSuccess: () => { toast.success(t('compOff.requested')); onOpenChange(false); },
      onError: (e) => toastMutationError(e, navigate),
    });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('compOff.requestTitle')}</DialogTitle><DialogDescription>{t('compOff.requestHint', { full: rules.fullDayHours, half: rules.halfDayHours, days: rules.expiryDays })}</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('compOff.workedOn')} htmlFor="co-date" required>
              <Input id="co-date" type="date" dir="ltr" max={today} value={workedOn} onChange={(e) => { setWorkedOn(e.target.value); setHours(null); }} />
            </FormField>
            <FormField label={t('compOff.hours')} htmlFor="co-hours" required hint={p?.recordedMinutes !== null && p?.recordedMinutes !== undefined ? t('compOff.recorded', { time: fmtMinutes(p.recordedMinutes) }) : t('compOff.noRecord')}>
              <Input id="co-hours" type="number" inputMode="decimal" min={0} max={24} step={0.25} dir="ltr" className="w-32 tnum" value={hoursText} onChange={(e) => setHours(e.target.value)} />
            </FormField>
          </div>
          {workedOn ? (
            preview.isLoading ? <Skeleton className="h-12 w-full" /> : p ? (
              <div className={cn('flex gap-2.5 rounded-md border p-3 text-sm', p.eligible ? 'bg-muted/40' : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100')} data-testid="comp-off-preview" aria-live="polite">
                {p.eligible ? null : <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />}
                <div className="space-y-0.5">
                  {p.workedOnType ? <p>{p.workedOnType === 'holiday' ? t('compOff.onHoliday', { name: p.holidayName ?? '' }) : t('compOff.onWeeklyOff')}</p> : null}
                  {p.eligible ? <p className="font-medium">{days > 0 ? t('compOff.willEarn', { days: fmtDays(days) }) : t('compOff.belowHalf', { hours: rules.halfDayHours })}</p> : <p className="font-medium">{t(`compOff.reasons.${p.reason ?? 'working_day'}`, { defaultValue: p.reason ?? '' })}</p>}
                </div>
              </div>
            ) : null
          ) : null}
          <FormField label={t('compOff.location')} htmlFor="co-location" required><Input id="co-location" maxLength={200} value={location} onChange={(e) => setLocation(e.target.value)} /></FormField>
          <FormField label={t('compOff.summary')} htmlFor="co-summary" required hint={t('compOff.summaryHint')}><Textarea id="co-summary" rows={3} maxLength={1000} value={summary} onChange={(e) => setSummary(e.target.value)} /></FormField>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
          <Button type="button" disabled={!ready} loading={request.isPending} onClick={submit}>{t('compOff.send')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
