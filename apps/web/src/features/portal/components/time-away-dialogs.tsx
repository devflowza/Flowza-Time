import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DateTime } from 'luxon';
import { TIME_AWAY_KINDS, type TimeAwayKind, type TimeAwayPolicyDto } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Textarea } from '@/components/ui';
import { fmtMinutes, fmtTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { PA_NS } from '../attendance-i18n';
import { useTimeAwayMutations } from '../time-away-api';
import { useTimeAwayErrorToast } from '../use-time-away-error';
import { STEP_OUT_MAX_MINUTES, STEP_OUT_MIN_MINUTES, WINDOW_MAX_MINUTES, backInstant, defaultBackTime, minutesBetween, personalLeft, windowInstants } from '../time-away-model';

/**
 * Official duty or personal permission, as two native radio cards (keyboard and screen-reader friendly). The personal card
 * shows what is left of the month's quota and the longest single permission.
 */
function KindChoice({ value, onChange, policy, name }: { value: TimeAwayKind; onChange: (k: TimeAwayKind) => void; policy: TimeAwayPolicyDto | undefined; name: string }) {
  const { t } = useTranslation(PA_NS);
  const left = policy ? personalLeft(policy) : null;
  const hint = (k: TimeAwayKind) => (k === 'OFFICIAL' ? t(policy && !policy.officialCountsAsWorked ? 'timeAway.kindHints.OFFICIAL_UNPAID' : 'timeAway.kindHints.OFFICIAL') : t('timeAway.kindHints.PERSONAL'));
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">{t('timeAway.kindLabel')}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {TIME_AWAY_KINDS.map((k) => (
          <label key={k} className={cn('flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring', value === k ? 'border-primary bg-accent' : 'hover:bg-accent/40')}>
            <span className="flex items-center gap-2 font-medium">
              <input type="radio" name={name} value={k} checked={value === k} onChange={() => onChange(k)} className="size-4 accent-primary" />
              {t(`timeAway.kinds.${k}`)}
            </span>
            <span className="text-xs text-muted-foreground">{hint(k)}</span>
            {k === 'PERSONAL' && policy ? (
              <span className="text-xs font-medium tnum" data-testid="personal-quota">
                {left === null ? t('timeAway.quotaNone') : t('timeAway.quotaLeft', { left: fmtMinutes(left), quota: fmtMinutes(policy.personalMonthlyQuotaMinutes) })}
                {policy.personalMaxMinutes !== null ? ` · ${t('timeAway.maxPerRequest', { max: fmtMinutes(policy.personalMaxMinutes) })}` : ''}
              </span>
            ) : null}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Personal-permission limits of the policy, checked before the API does (it refuses with TIME_AWAY_QUOTA / _TOO_LONG). The
 * quota left is this month's, so a window in another month is checked against the longest permission only.
 */
function personalError(t: (k: string, o?: Record<string, unknown>) => string, kind: TimeAwayKind, minutes: number | null, policy: TimeAwayPolicyDto | undefined, thisMonth = true): string | undefined {
  if (kind !== 'PERSONAL' || !policy || minutes === null || minutes <= 0) return undefined;
  if (policy.personalMaxMinutes !== null && minutes > policy.personalMaxMinutes) return t('timeAway.personalTooLong', { max: fmtMinutes(policy.personalMaxMinutes) });
  if (!thisMonth) return undefined;
  const left = personalLeft(policy);
  if (left !== null && minutes > left) return t('timeAway.quotaExceeded', { left: fmtMinutes(left) });
  return undefined;
}

/**
 * Step out now: a break-out punch on the self-service device plus a time-away request for the expected window, decided by the
 * line manager. The expected return is typed in the employee's zone (an hour from now by default). One idempotency key per
 * dialog, so a retried submit after a dropped connection replays instead of stepping out twice.
 */
export function StepOutDialog({ open, onOpenChange, date, timezone, nowMs, policy }: { open: boolean; onOpenChange: (o: boolean) => void; date: string; timezone: string; nowMs: number; policy: TimeAwayPolicyDto }) {
  const { t } = useTranslation(PA_NS);
  const { t: tc } = useTranslation();
  const { stepOut } = useTimeAwayMutations();
  const toastError = useTimeAwayErrorToast();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<TimeAwayKind>('OFFICIAL');
  const [backTime, setBackTime] = useState(() => defaultBackTime(nowMs, timezone));
  const [reason, setReason] = useState('');
  const [destination, setDestination] = useState('');
  const [touched, setTouched] = useState(false);
  const expectedBackAt = backInstant(date, backTime, timezone, nowMs);
  const minutes = expectedBackAt ? minutesBetween(nowMs, expectedBackAt) : null;
  const errors = {
    back: minutes === null || minutes < STEP_OUT_MIN_MINUTES || minutes > STEP_OUT_MAX_MINUTES ? t('timeAway.expectedBackInvalid') : personalError(t, kind, minutes, policy),
    reason: reason.trim().length < 3 ? t('timeAway.reasonTooShort') : undefined,
  };
  const invalid = Object.values(errors).some(Boolean);

  const submit = () => {
    setTouched(true);
    if (invalid || !expectedBackAt) return;
    stepOut.mutate({ kind, expectedBackAt, reason: reason.trim(), ...(destination.trim() ? { destination: destination.trim() } : {}), idempotencyKey }, {
      onSuccess: (r) => { toast.success(t('timeAway.steppedOut', { time: fmtTime(r.startsAt, timezone), back: fmtTime(r.endsAt, timezone) })); onOpenChange(false); },
      onError: toastError,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('timeAway.stepOutTitle')}</DialogTitle>
          <DialogDescription>{t(policy.returnBy === 'device_or_portal' ? 'timeAway.stepOutHintPortal' : 'timeAway.stepOutHint')}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <KindChoice value={kind} onChange={setKind} policy={policy} name="step-out-kind" />
          <FormField label={t('timeAway.expectedBack', { zone: timezone })} htmlFor="step-out-back" required hint={minutes !== null && minutes > 0 ? t('timeAway.duration', { duration: fmtMinutes(minutes) }) : t('timeAway.expectedBackHint')} error={touched ? errors.back : undefined}>
            <Input id="step-out-back" type="time" step={60} dir="ltr" className="tnum sm:max-w-40" value={backTime} onChange={(e) => setBackTime(e.target.value)} aria-invalid={touched && !!errors.back} />
          </FormField>
          <FormField label={t('timeAway.reason')} htmlFor="step-out-reason" required hint={t('timeAway.reasonHint')} error={touched ? errors.reason : undefined}>
            <Textarea id="step-out-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={touched && !!errors.reason} />
          </FormField>
          <FormField label={t('timeAway.destination')} htmlFor="step-out-destination" optional>
            <Input id="step-out-destination" maxLength={200} dir="auto" value={destination} placeholder={t('timeAway.destinationPlaceholder')} onChange={(e) => setDestination(e.target.value)} />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={stepOut.isPending}>{t('timeAway.submitStepOut')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Plan a time-away window of one working day (up to 7 days back, 60 ahead — the API's bounds): the day and two times in the
 * employee's zone become UTC instants; an end before the start runs past midnight. Goes to the line manager's approvals inbox.
 */
export function RequestTimeAwayDialog({ open, onOpenChange, timezone, today, policy }: { open: boolean; onOpenChange: (o: boolean) => void; timezone: string; today: string; policy: TimeAwayPolicyDto | undefined }) {
  const { t } = useTranslation(PA_NS);
  const { t: tc } = useTranslation();
  const { request } = useTimeAwayMutations();
  const toastError = useTimeAwayErrorToast();
  const [day, setDay] = useState(today);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState<TimeAwayKind>('OFFICIAL');
  const [reason, setReason] = useState('');
  const [destination, setDestination] = useState('');
  const [touched, setTouched] = useState(false);
  const span = day ? windowInstants(day, from, to, timezone) : null;
  const errors = {
    day: !day ? t('timeAway.dateRequired') : undefined,
    window: !span ? t('timeAway.timesRequired') : span.minutes > WINDOW_MAX_MINUTES ? t('timeAway.windowTooLong') : personalError(t, kind, span.minutes, policy, day.slice(0, 7) === today.slice(0, 7)),
    reason: reason.trim().length < 3 ? t('timeAway.reasonTooShort') : undefined,
  };
  const invalid = Object.values(errors).some(Boolean);
  const base = DateTime.fromISO(today);
  const minDate = base.minus({ days: 7 }).toISODate() ?? today;
  const maxDate = base.plus({ days: 60 }).toISODate() ?? today;

  const submit = () => {
    setTouched(true);
    if (invalid || !span) return;
    request.mutate({ kind, startsAt: span.startsAt, endsAt: span.endsAt, reason: reason.trim(), ...(destination.trim() ? { destination: destination.trim() } : {}) }, {
      onSuccess: () => { toast.success(t('timeAway.submitted')); onOpenChange(false); },
      onError: toastError,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('timeAway.requestTitle')}</DialogTitle><DialogDescription>{t('timeAway.requestHint')}</DialogDescription></DialogHeader>
        <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <KindChoice value={kind} onChange={setKind} policy={policy} name="time-away-kind" />
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label={t('timeAway.date')} htmlFor="ta-date" required error={touched ? errors.day : undefined}>
              <Input id="ta-date" type="date" dir="ltr" className="tnum" value={day} min={minDate} max={maxDate} onChange={(e) => setDay(e.target.value)} />
            </FormField>
            <FormField label={t('timeAway.from', { zone: timezone })} htmlFor="ta-from" required>
              <Input id="ta-from" type="time" step={60} dir="ltr" className="tnum" value={from} onChange={(e) => setFrom(e.target.value)} aria-invalid={touched && !!errors.window} />
            </FormField>
            <FormField label={t('timeAway.to', { zone: timezone })} htmlFor="ta-to" required>
              <Input id="ta-to" type="time" step={60} dir="ltr" className="tnum" value={to} onChange={(e) => setTo(e.target.value)} aria-invalid={touched && !!errors.window} />
            </FormField>
          </div>
          {touched && errors.window ? <p className="-mt-2 text-xs text-destructive" role="alert">{errors.window}</p>
            : span ? <p className="-mt-2 text-xs text-muted-foreground tnum" data-testid="ta-duration">{t('timeAway.duration', { duration: fmtMinutes(span.minutes) })}</p> : null}
          <FormField label={t('timeAway.reason')} htmlFor="ta-reason" required hint={t('timeAway.reasonHint')} error={touched ? errors.reason : undefined}>
            <Textarea id="ta-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={touched && !!errors.reason} />
          </FormField>
          <FormField label={t('timeAway.destination')} htmlFor="ta-destination" optional>
            <Input id="ta-destination" maxLength={200} dir="auto" value={destination} placeholder={t('timeAway.destinationPlaceholder')} onChange={(e) => setDestination(e.target.value)} />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={request.isPending}>{t('timeAway.submit')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
