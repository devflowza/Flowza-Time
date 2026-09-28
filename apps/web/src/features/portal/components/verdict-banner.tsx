import { useTranslation } from 'react-i18next';
import { CircleAlert, CircleCheck, Info, MapPinOff, ShieldAlert, TriangleAlert } from 'lucide-react';
import type { GeofenceVerdict, GeofenceVerdictDto } from '@flowza/contracts';
import { cn } from '@/lib/utils';
import { PA_NS } from '../attendance-i18n';
import { fmtDistance } from '../geo';

const STYLE: Record<GeofenceVerdict, { tone: string; icon: typeof Info }> = {
  no_fence: { tone: 'border-slate-200 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100', icon: Info },
  allowed: { tone: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100', icon: CircleCheck },
  flagged: { tone: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-100', icon: TriangleAlert },
  logged: { tone: 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/50 dark:text-blue-100', icon: Info },
  denied_outside: { tone: 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-100', icon: MapPinOff },
  denied_mock: { tone: 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-100', icon: ShieldAlert },
};

/**
 * What the server's geofence evaluation says about punching from here, in one of six sentences (no zone applies, inside,
 * outside but recorded + flagged, outside and only logged, outside and refused, simulated location refused). A mock
 * location always carries the note that spoofing is detected and recorded.
 */
export function VerdictBanner({ verdict, className }: { verdict: GeofenceVerdictDto; className?: string }) {
  const { t } = useTranslation(PA_NS);
  const style = STYLE[verdict.verdict] ?? STYLE.no_fence;
  const Icon = style.icon;
  const vars = { zone: verdict.geofenceName ?? t('checkin.workZone'), distance: fmtDistance(verdict.distanceM) };
  // the sentence explains WHY the location was judged the way it was when it is not simply inside / outside
  const body = verdict.reason === 'gps_accuracy_too_low' ? t('checkin.verdict.lowAccuracy', vars)
    : verdict.reason === 'location_missing' ? t('checkin.verdict.locationMissing', vars)
    : t(`checkin.verdict.${verdict.verdict}.body`, vars);
  return (
    <div role="status" data-testid="verdict-banner" data-verdict={verdict.verdict} className={cn('flex gap-3 rounded-lg border p-3 text-sm', style.tone, className)}>
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <p className="font-semibold">{t(`checkin.verdict.${verdict.verdict}.title`, vars)}</p>
        <p>{body}</p>
        {verdict.verdict === 'denied_mock' ? <p className="text-xs opacity-90">{t('checkin.mockNote')}</p> : null}
      </div>
    </div>
  );
}

/** Inline error for a location that could not be read (denied / unavailable / timeout / unsupported). */
export function LocationProblem({ kind }: { kind: 'denied' | 'unavailable' | 'timeout' | 'unsupported' }) {
  const { t } = useTranslation(PA_NS);
  return (
    <div role="alert" className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-100">
      <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
      <p>{t(`checkin.geo.${kind}`)}</p>
    </div>
  );
}
