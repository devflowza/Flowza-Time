import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { DateTime } from 'luxon';
import { AlertTriangle, Camera, CloudOff, Crosshair, LogIn, LogOut, MapPin, RefreshCw, ShieldOff, Trash2 } from 'lucide-react';
import type { SelfPunchDirection, SelfPunchPreviewDto, SelfPunchRefusal, SelfPunchStatusDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, Card, CardContent, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { fmtDateTime, fmtTime } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useOrgId } from '@/features/me/use-me';
import { AttendanceStatusBadge, FlagChips } from '@/features/attendance/components/badges';
import { PA_NS } from '../attendance-i18n';
import { usePunchMutations, usePunchStatus } from '../attendance-api';
import { fmtDistance, getCurrentFix, GeoFailure, nearestFence, type GeoFailureKind, type GeoFix } from '../geo';
import { useOfflinePunches } from '../use-offline-punches';
import { VerdictChip } from '../components/attendance-badges';
import { LocationProblem, VerdictBanner } from '../components/verdict-banner';
import { SelfieDialog } from '../components/selfie-dialog';
import { SectionTitle } from '../components/parts';

/** The server's clock, ticking locally from the offset measured when the status was read (display only; the API stamps punches). */
function useServerClock(serverTime: string | undefined, receivedAt: number, timezone: string) {
  // offset between the server's clock and this device's, measured when the status arrived (React Query's dataUpdatedAt)
  const offset = serverTime && receivedAt ? Date.parse(serverTime) - receivedAt : 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(id); }, []);
  return DateTime.fromMillis(now + offset).setZone(timezone);
}

const refusalOf = (e: unknown): { reason: SelfPunchRefusal | string; message: string } | null =>
  e instanceof ApiError && typeof e.details?.['reason'] === 'string' ? { reason: e.details['reason'], message: e.message } : null;

/** A fix less precise than this is worth a warning before punching (Finance B-31): the zone check may not be able to place it. */
const ACCURACY_WARNING_M = 50;

function nextDirection(status: SelfPunchStatusDto | undefined, queued: ReadonlyArray<{ direction: SelfPunchDirection }>): SelfPunchDirection {
  const last = queued.length ? queued[queued.length - 1]!.direction : status?.lastDirection ?? null;
  return last === 'in' ? 'out' : 'in';
}

/**
 * /my/checkin — check in / out from the browser. The location is read here and judged by the server (geofences, windows,
 * the IP allow-list, the selfie requirement); the punch time is always the server's. Without a connection a punch is kept
 * on the device and sent when the connection returns. Employees with an open-attendance grant can check in with a selfie
 * that a manager reviews.
 */
export default function CheckInPage() {
  const { t, i18n } = useTranslation(PA_NS);
  const orgId = useOrgId();
  const status = usePunchStatus('web');
  const { preview, punch } = usePunchMutations();
  const offline = useOfflinePunches(orgId);
  const [geo, setGeo] = useState<{ fix: GeoFix | null; error: GeoFailureKind | null; locating: boolean }>({ fix: null, error: null, locating: true });
  const { fix, error: geoError, locating } = geo;
  const [previewResult, setPreviewResult] = useState<SelfPunchPreviewDto | null>(null);
  const [refusal, setRefusal] = useState<{ reason: string; message: string } | null>(null);
  const [selfieOpen, setSelfieOpen] = useState(false);
  const s = status.data;
  const tz = s?.timezone ?? 'UTC';
  const clock = useServerClock(s?.serverTime, status.dataUpdatedAt, tz);
  const direction = nextDirection(s, offline.items);
  const selfieOnly = !!s?.blockers.includes('SELFIE_REQUIRED');
  const hardBlockers = (s?.blockers ?? []).filter((b) => b !== 'SELFIE_REQUIRED');
  const previewMutate = preview.mutate;
  const previewSeq = useRef(0);

  const runPreview = useCallback((f: GeoFix | null, dir: SelfPunchDirection) => {
    const seq = ++previewSeq.current;
    previewMutate({ direction: dir, channel: 'web', ...(f ? { lat: f.lat, lng: f.lng, accuracy: f.accuracy } : {}) }, {
      onSuccess: (r) => { if (seq === previewSeq.current) setPreviewResult(r); },
      onError: () => { if (seq === previewSeq.current) setPreviewResult(null); },
    });
  }, [previewMutate]);

  const failure = (e: unknown): GeoFailureKind => (e instanceof GeoFailure ? e.kind : 'unavailable');
  /** "Refresh location" (and after a punch): keeps the last fix while the new one is read. */
  const locate = useCallback(async () => {
    setGeo((g) => ({ ...g, error: null, locating: true }));
    try {
      const f = await getCurrentFix();
      setGeo({ fix: f, error: null, locating: false });
    } catch (e) {
      setGeo((g) => ({ fix: g.fix, error: failure(e), locating: false }));
    }
  }, []);

  // read the location once on arrival; re-judge whenever the fix or the direction changes
  useEffect(() => {
    let alive = true;
    getCurrentFix().then((f) => { if (alive) setGeo({ fix: f, error: null, locating: false }); }, (e: unknown) => { if (alive) setGeo({ fix: null, error: failure(e), locating: false }); });
    return () => { alive = false; };
  }, []);
  const ready = !!s && !locating;
  useEffect(() => { if (ready) runPreview(fix, direction); }, [ready, fix, direction, runPreview]);

  const doPunch = () => {
    const key = crypto.randomUUID();
    setRefusal(null);
    const input = { direction, channel: 'web' as const, ...(fix ? { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy } : {}), idempotencyKey: key };
    punch.mutate(input, {
      onSuccess: (r) => {
        if (r.replayed) toast.info(t('checkin.replayed'));
        else toast.success(t(`checkin.recorded.${direction}`, { time: fmtTime(r.punch.punchedAt, tz) }), r.flagged ? { description: t('checkin.flaggedHint') } : undefined);
        void locate();
      },
      onError: (e) => {
        // no response at all (offline, DNS, a dropped connection): keep the punch on the device and send it later
        if (!(e instanceof ApiError) || e.status === 0) {
          void offline.enqueue({ key, direction, lat: fix?.lat, lng: fix?.lng, accuracy: fix?.accuracy, clientQueuedAt: new Date().toISOString() })
            .then((queued) => (queued ? toast.warning(t('checkin.offline.queued')) : toastError(e)));
          return;
        }
        const r = refusalOf(e);
        if (r) setRefusal(r);
        else toastError(e);
      },
    });
  };

  if (status.isError && !s) return <div className="page-container"><ErrorState error={status.error} onRetry={() => void status.refetch()} /></div>;

  const refusals = previewResult?.refusals ?? [];
  const blocked = hardBlockers.length > 0 || refusals.length > 0;
  const near = fix && s && s.fences.length ? nearestFence(fix, s.fences) : null;
  const lastPunch = s?.punches.length ? s.punches[s.punches.length - 1] : null;
  const punchWindow = direction === 'in' ? s?.policy.checkInWindow : s?.policy.checkOutWindow;

  return (
    <div className="page-container space-y-5">
      <PageHeader title={t('checkin.title')} description={t('checkin.subtitle')} />

      <div className="grid gap-5 lg:grid-cols-5">
        <Card className="p-5 lg:col-span-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('checkin.serverTime')}</p>
              {s ? <p className="text-4xl font-semibold tracking-tight tnum" dir="ltr" data-testid="server-clock">{clock.toFormat('HH:mm:ss')}</p> : <Skeleton className="h-10 w-40" />}
              {s ? <p className="text-sm text-muted-foreground">{clock.setLocale(i18n.language).toFormat('EEEE, dd MMMM yyyy')} · {tz}</p> : null}
            </div>
            <div className="text-end text-sm">
              {status.isLoading ? <Skeleton className="h-5 w-40" /> : lastPunch ? (
                <p data-testid="punch-state">{t(lastPunch.direction === 'out' ? 'checkin.checkedOutAt' : 'checkin.checkedInAt', { time: fmtTime(lastPunch.punchedAt, tz) })}</p>
              ) : <p data-testid="punch-state" className="text-muted-foreground">{t('checkin.notYet')}</p>}
              {s?.today ? <span className="mt-1 inline-flex flex-wrap items-center justify-end gap-1.5"><AttendanceStatusBadge status={s.today.status} /><FlagChips flags={s.today.flags} max={2} size="xs" /></span> : null}
            </div>
          </div>

          <div className="mt-5 space-y-3">
            {hardBlockers.length > 0 ? (
              <div role="alert" className="flex gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-100">
                <ShieldOff className="mt-0.5 size-5 shrink-0" aria-hidden />
                <div><p className="font-semibold">{t('checkin.blockedTitle')}</p><ul className="list-disc ps-4">{hardBlockers.map((b) => <li key={b}>{t(`checkin.refusal.${b}`, { defaultValue: b })}</li>)}</ul></div>
              </div>
            ) : null}
            {geoError ? <LocationProblem kind={geoError} /> : null}
            {previewResult ? <VerdictBanner verdict={previewResult.verdict} /> : locating ? <Skeleton className="h-16 w-full" /> : null}
            {previewResult?.outOfWindow && punchWindow ? <p className="text-sm text-amber-800 dark:text-amber-200">{t('checkin.outOfWindow', { start: punchWindow.start, end: punchWindow.end })}</p> : null}
            {refusals.filter((r) => r !== 'OUTSIDE_GEOFENCE' && r !== 'MOCK_LOCATION').map((r) => <p key={r} role="alert" className="text-sm text-destructive">{t(`checkin.refusal.${r}`, { defaultValue: r })}</p>)}
            {refusal ? <p role="alert" data-testid="punch-refusal" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{t(`checkin.refusal.${refusal.reason}`, { defaultValue: refusal.message })}</p> : null}

            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <MapPin className="size-4" aria-hidden />
              {locating ? <span>{t('checkin.locating')}</span> : fix ? <span className="tnum" dir="ltr">{fix.lat.toFixed(5)}, {fix.lng.toFixed(5)} · {t('checkin.accuracy', { meters: fix.accuracy })}</span> : <span>{t('checkin.noLocation')}</span>}
              {near ? <span>· {t('checkin.nearest', { name: near.fence.name, distance: fmtDistance(near.edgeDistanceM) })}</span> : s && s.fences.length === 0 ? <span>· {t('checkin.noFences')}</span> : null}
              <Button variant="ghost" size="sm" onClick={() => void locate()} disabled={locating}>{fix ? <RefreshCw /> : <Crosshair />} {fix ? t('checkin.relocate') : t('checkin.locate')}</Button>
            </div>
            {fix && fix.accuracy > ACCURACY_WARNING_M ? (
              <p role="status" data-testid="accuracy-warning" className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-100">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{t('checkin.accuracyWarning', { meters: Math.round(fix.accuracy), limit: ACCURACY_WARNING_M })}</span>
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2 pt-1">
              {!selfieOnly ? (
                <Button size="lg" className="min-w-40" disabled={!s || blocked || locating} loading={punch.isPending} onClick={doPunch} data-testid="punch-button">
                  {direction === 'in' ? <LogIn /> : <LogOut />} {direction === 'in' ? t('checkin.checkIn') : t('checkin.checkOut')}
                </Button>
              ) : <p className="w-full text-sm text-muted-foreground">{t('checkin.selfie.required')}</p>}
              {s?.selfieAvailable ? <Button size="lg" variant={selfieOnly ? 'default' : 'outline'} onClick={() => setSelfieOpen(true)} disabled={hardBlockers.length > 0}><Camera /> {direction === 'in' ? t('checkin.selfie.buttonIn') : t('checkin.selfie.buttonOut')}</Button> : null}
            </div>
            {punchWindow ? <p className="text-xs text-muted-foreground">{t(direction === 'in' ? 'checkin.windowIn' : 'checkin.windowOut', { start: punchWindow.start, end: punchWindow.end })}</p> : null}
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <SectionTitle title={t('checkin.todayPunches')} to="/my/attendance?tab=recent" linkLabel={t('checkin.seeAttendance')} />
          <CardContent>
            {status.isLoading ? <Skeleton className="h-24 w-full" /> : s && s.punches.length ? (
              <ul className="divide-y" data-testid="today-punches">
                {s.punches.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                    <span className="flex items-center gap-2 text-sm"><span className="font-semibold tnum" dir="ltr">{fmtTime(p.punchedAt, tz)}</span><Badge variant="outline">{t(`checkin.direction.${p.direction === 'in' || p.direction === 'out' ? p.direction : 'unknown'}`)}</Badge></span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><VerdictChip verdict={p.verdict} />{p.source === 'SELF_SERVICE' ? t('checkin.viaPortal') : p.deviceName ?? t('checkin.viaTerminal')}</span>
                  </li>
                ))}
              </ul>
            ) : <EmptyState icon={LogIn} title={t('checkin.noPunches')} className="py-6" />}
          </CardContent>
        </Card>
      </div>

      {offline.items.length > 0 ? (
        <Card className="border-amber-200 dark:border-amber-900" data-testid="offline-queue">
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><CloudOff className="size-4 text-amber-600" aria-hidden />{t('checkin.offline.title', { count: offline.items.length })}</h2>
            <Button size="sm" variant="outline" loading={offline.syncing} onClick={() => void offline.sync()}><RefreshCw /> {t('checkin.offline.syncNow')}</Button>
          </div>
          <CardContent className="space-y-2 pt-2">
            <p className="text-xs text-muted-foreground">{t('checkin.offline.hint')}</p>
            <ul className="divide-y">
              {offline.items.map((p) => (
                <li key={p.key} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span className="min-w-0">
                    <Badge variant="outline">{t(`checkin.direction.${p.direction}`)}</Badge> <span className="tnum">{t('checkin.offline.takenAt', { time: fmtDateTime(p.clientQueuedAt, tz, 'dd MMM HH:mm') })}</span>{p.attempts > 0 ? <span className="ms-2 text-xs text-muted-foreground">{t('checkin.offline.attempts', { count: p.attempts })}</span> : null}
                    {p.lastError ? <span className="block break-words text-xs text-muted-foreground" data-testid="offline-last-error">{t('checkin.offline.lastError', { message: p.lastError })}</span> : null}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => void offline.discard(p.key)} aria-label={t('checkin.offline.discard')}><Trash2 /> {t('checkin.offline.discard')}</Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <p className="text-xs text-muted-foreground">{t('checkin.footer')} <Link to="/my/requests" className="font-medium text-primary hover:underline">{t('checkin.footerLink')}</Link></p>

      {selfieOpen ? <SelfieDialog open onOpenChange={setSelfieOpen} direction={direction} fix={fix} onSent={() => void status.refetch()} /> : null}
    </div>
  );
}
