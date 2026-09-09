import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { AlertTriangle, CheckCircle2, Cpu, RefreshCw } from 'lucide-react';
import type { DashboardSummary } from '@flowza/contracts';
import { Button, Skeleton } from '@/components/ui';
import { fmtNumber } from '@/lib/format';
import { toastError } from '@/lib/toast';
import { useSyncMutations } from '@/features/sync/api';
import { toastJobAccepted } from '@/features/sync/job-toast';
import { Donut, type DonutSlice } from '../charts';
import { pct } from '../model';
import { ViewAllLink, WidgetCard, WidgetEmpty } from './widget-card';

/** Fleet health from the summary counts, with a one-click attendance pull for operators who may sync. */
export function DevicesCard({ summary, loading, canView, canSync, className }: { summary: DashboardSummary | undefined; loading: boolean; canView: boolean; canSync: boolean; className?: string }) {
  const { t } = useTranslation('dashboard');
  const navigate = useNavigate();
  const { syncAttendance } = useSyncMutations();
  const online = summary?.devicesOnline ?? 0;
  const offline = summary?.devicesOffline ?? 0;
  const unknown = summary?.devicesUnknown ?? 0;
  const total = online + offline + unknown;
  const slices = useMemo<DonutSlice[]>(() => [
    { key: 'online', label: t('devices.online'), value: online, color: '#10b981' },
    { key: 'offline', label: t('devices.offline'), value: offline, color: 'var(--color-chart-absent)' },
    { key: 'unknown', label: t('devices.unknown'), value: unknown, color: 'var(--color-muted-foreground)' },
  ], [online, offline, unknown, t]);
  const notReporting = offline + unknown;
  const syncNow = async () => {
    try { toastJobAccepted(await syncAttendance.mutateAsync({ all: true, fullResync: false }), navigate); } catch (e) { toastError(e); }
  };
  return (
    <WidgetCard title={t('devices.title')} icon={Cpu} className={className} action={canView ? <ViewAllLink to="/devices" label={t('devices.viewAll')} /> : null}>
      {loading && !summary ? (
        <div className="flex items-center gap-6" aria-busy><Skeleton className="size-36 shrink-0 rounded-full" /><div className="flex-1 space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-4 w-full" />)}</div></div>
      ) : total === 0 ? (
        <WidgetEmpty icon={Cpu} title={t('devices.empty')} hint={t('devices.emptyHint')} />
      ) : (
        <>
          <div className="flex flex-col items-center gap-4 sm:flex-row">
            <Donut slices={slices} height={160} center={{ value: fmtNumber(total), label: t('devices.devices') }} className="w-full max-w-[160px] shrink-0 sm:w-[160px]" />
            <ul className="w-full min-w-0 flex-1 space-y-2 text-sm">
              {slices.map((s) => (
                <li key={s.key} className="flex items-center gap-2">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{s.label}</span>
                  <span className="tnum w-8 text-end font-medium">{fmtNumber(s.value)}</span>
                  <span className="tnum w-10 text-end text-xs text-muted-foreground">{pct(s.value, total)}%</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
            <span className={notReporting > 0 ? 'inline-flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-300' : 'inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300'}>
              {notReporting > 0 ? <AlertTriangle className="size-4" aria-hidden /> : <CheckCircle2 className="size-4" aria-hidden />}
              {notReporting > 0 ? t('devices.someOffline', { count: notReporting }) : t('devices.allOnline')}
              {summary && summary.syncFailures24h > 0 ? <span className="text-muted-foreground"> · {t('devices.syncFailures', { count: summary.syncFailures24h })}</span> : null}
            </span>
            {canSync ? <Button size="sm" variant="ghost" onClick={() => void syncNow()} loading={syncAttendance.isPending}><RefreshCw /> {t('devices.syncNow')}</Button> : null}
          </div>
        </>
      )}
    </WidgetCard>
  );
}
