import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CornerDownLeft, DoorOpen, Info, MapPin } from 'lucide-react';
import type { TimeAwayStatusDto } from '@flowza/contracts';
import { Badge, Button, Card, CardContent } from '@/components/ui';
import { fmtMinutes, fmtTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { AwayIntervalList } from '@/features/employees/components/profile/activity-away';
import { PA_NS } from '../attendance-i18n';
import { useTimeAwayMutations, useTimeAwayStatus } from '../time-away-api';
import { intervalTotals, minutesBetween, personalLeft } from '../time-away-model';
import { useTimeAwayErrorToast } from '../use-time-away-error';
import { TimeAwayStatusBadge } from './attendance-badges';
import { SectionTitle } from './parts';
import { StepOutDialog } from './time-away-dialogs';

/**
 * The open step-out: since when, for what, the expected return (overdue once passed) and how the return is recorded. Mounted
 * per step-out (keyed by its request), so "I'm back" carries one idempotency key for it: a retry after a lost response
 * replays the recorded return instead of being refused as "not stepped out".
 */
function AwayBanner({ s, away, nowMs }: { s: TimeAwayStatusDto; away: NonNullable<TimeAwayStatusDto['away']>; nowMs: number }) {
  const { t } = useTranslation(PA_NS);
  const { back } = useTimeAwayMutations();
  const toastError = useTimeAwayErrorToast();
  const [backKey] = useState(() => crypto.randomUUID());
  const tz = s.timezone;
  const overdue = minutesBetween(away.expectedBackAt, nowMs);
  const comeBack = () => back.mutate(backKey, {
    onSuccess: (r) => toast.success(t('timeAway.backDone', { time: fmtTime(r.returnedAt ?? new Date(nowMs).toISOString(), tz) })),
    onError: toastError,
  });
  return (
    <div data-testid="time-away-away" className="space-y-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
      <p className="flex flex-wrap items-center gap-2 font-semibold">
        <DoorOpen className="size-4 shrink-0" aria-hidden />
        <span className="tnum">{t('timeAway.awayNow', { since: fmtTime(away.since, tz), kind: t(`timeAway.kinds.${away.kind}`) })}</span>
        <TimeAwayStatusBadge status={away.status} />
      </p>
      <p className="tnum">
        {t('timeAway.expectedBackAt', { time: fmtTime(away.expectedBackAt, tz) })}
        {overdue > 0 ? <span className="ms-2 font-medium text-amber-800 dark:text-amber-200" data-testid="time-away-overdue">· {t('timeAway.overdue', { duration: fmtMinutes(overdue) })}</span> : null}
      </p>
      {away.destination ? <p className="flex items-center gap-1.5 text-xs"><MapPin className="size-3.5 shrink-0" aria-hidden /><span dir="auto">{away.destination}</span></p> : null}
      {s.canComeBack
        ? <Button size="lg" className="w-full sm:w-auto" loading={back.isPending} onClick={comeBack} data-testid="time-away-back"><CornerDownLeft className="rtl:-scale-x-100" /> {t('timeAway.back')}</Button>
        : <p className="text-xs font-medium" data-testid="time-away-back-on-device">{t('timeAway.backOnDevice')}</p>}
    </div>
  );
}

/**
 * The check-in page's "Time away" card (docs/time-away.md): step out (a break-out punch + a request for the expected window),
 * the open step-out with "I'm back" when the policy lets the portal record the return, today's away time as the engine
 * classified it, and today's requests. Hidden while the status loads or fails, and for an employee whose policy does not
 * measure time away and who has nothing open today.
 */
export function TimeAwayCard({ nowMs }: { nowMs: number }) {
  const { t } = useTranslation(PA_NS);
  const q = useTimeAwayStatus();
  const [stepOutOpen, setStepOutOpen] = useState(false);
  const s = q.data;
  if (!s || (!s.policy.enabled && !s.away && s.requests.length === 0)) return null;
  const { policy } = s;
  const tz = s.timezone;
  const left = personalLeft(policy);
  const active = policy.inactiveReason === null;

  return (
    <Card data-testid="time-away-card">
      <SectionTitle title={t('timeAway.title')} to="/my/requests?tab=time-away" linkLabel={t('timeAway.seeRequests')} />
      <CardContent className="space-y-4">
        {policy.inactiveReason ? (
          <p role="note" data-testid="time-away-inactive" className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden /><span>{t(`timeAway.inactive.${policy.inactiveReason}`)}</span>
          </p>
        ) : null}

        {s.away ? <AwayBanner key={s.away.requestId} s={s} away={s.away} nowMs={nowMs} />
          : s.canStepOut ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button size="lg" variant="outline" className="w-full sm:w-auto" onClick={() => setStepOutOpen(true)} data-testid="time-away-step-out"><DoorOpen /> {t('timeAway.stepOut')}</Button>
              <p className="text-xs text-muted-foreground tnum">
                {t('timeAway.kinds.PERSONAL')}: {left === null ? t('timeAway.quotaNone') : t('timeAway.quotaLeft', { left: fmtMinutes(left), quota: fmtMinutes(policy.personalMonthlyQuotaMinutes) })}
              </p>
            </div>
          )
          : active && (!policy.stepOutFromPortal || !s.onSite) ? <p className="text-sm text-muted-foreground" data-testid="time-away-unavailable">{t(policy.stepOutFromPortal ? 'timeAway.checkInFirst' : 'timeAway.stepOutDisabled')}</p> : null}

        {active ? (
          <section className="space-y-1.5" aria-labelledby="time-away-measured">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 id="time-away-measured" className="text-sm font-medium">{t('timeAway.measured')}</h3>
              <p className="text-xs text-muted-foreground">{t('timeAway.measuredHint')}</p>
            </div>
            {s.intervals.length ? <AwayIntervalList intervals={s.intervals} timezone={tz} labelOf={(k) => t(`timeAway.intervalKinds.${k}`)} />
              : <p className="text-sm text-muted-foreground">{t('timeAway.noIntervals')}</p>}
          </section>
        ) : null}

        {s.requests.length ? (
          <section className="space-y-1.5" aria-labelledby="time-away-requests">
            <h3 id="time-away-requests" className="text-sm font-medium">{t('timeAway.todayRequests')}</h3>
            <ul className="divide-y" data-testid="time-away-today-requests">
              {s.requests.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="font-medium">{t(`timeAway.kinds.${r.kind}`)}</span>
                    <span className="text-xs text-muted-foreground tnum" dir="ltr">{fmtTime(r.startsAt, tz)} – {fmtTime(r.endsAt, tz)}</span>
                    <Badge variant="outline">{t(`timeAway.source.${r.source}`)}</Badge>
                  </span>
                  <TimeAwayStatusBadge status={r.status} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </CardContent>
      {stepOutOpen ? <StepOutDialog open onOpenChange={setStepOutOpen} date={s.date} timezone={tz} nowMs={nowMs} policy={policy} /> : null}
    </Card>
  );
}

/** The portal home's "Time away today": the away total and its official / permission / unapproved parts, for a policy that measures it. */
export function TimeAwayToday() {
  const { t } = useTranslation(PA_NS);
  const q = useTimeAwayStatus();
  const s = q.data;
  if (!s || !s.policy.enabled) return null;
  const totals = intervalTotals(s.intervals);
  const items = [
    { key: 'away', value: totals.away, tone: '' },
    { key: 'official', value: totals.official, tone: '' },
    { key: 'permission', value: totals.permission, tone: '' },
    { key: 'unapproved', value: totals.unapproved, tone: totals.unapproved > 0 ? 'text-destructive' : '' },
  ] as const;
  return (
    <Card className="p-4" data-testid="home-time-away">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          <DoorOpen className="size-4 text-muted-foreground" aria-hidden />{t('timeAway.home.title')}
          {s.away ? <Badge variant="info" dot className="tnum">{t('timeAway.home.awaySince', { time: fmtTime(s.away.since, s.timezone) })}</Badge> : null}
        </h2>
        <Link to="/my/checkin" className="text-xs font-medium text-primary hover:underline">{t('timeAway.home.link')}</Link>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {items.map((i) => (
          <div key={i.key} className="min-w-0 rounded-md border bg-muted/30 p-2.5">
            <dt className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t(`timeAway.totals.${i.key}`)}</dt>
            <dd className={cn('text-sm font-semibold tnum', i.tone)}>{fmtMinutes(i.value)}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
