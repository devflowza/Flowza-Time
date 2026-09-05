import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, CalendarOff, Clock, Cpu, LogOut, Timer, UserCheck, Users, WifiOff, ClipboardCheck } from 'lucide-react';
import type { DashboardSummary } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { ErrorState, StatCard } from '@/components/ui';
import { api, type Envelope } from '@/lib/api-client';
import { fmtDate, fmtMinutes, fmtNumber, todayIso } from '@/lib/format';
import { useOrgId, useOrgTimezone } from '@/features/me/use-me';

export function DashboardPage() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const tz = useOrgTimezone();
  const date = todayIso(tz);
  const q = useQuery({ queryKey: ['dashboard', orgId, date], queryFn: async () => (await api.get<Envelope<DashboardSummary>>(`/orgs/${orgId}/dashboard/summary`, { date })).data, refetchInterval: 60_000 });
  const d = q.data;
  const loading = q.isLoading;
  return (
    <div className="page-container">
      <PageHeader title={t('dashboard.title')} description={t('dashboard.subtitle', { date: fmtDate(date) })} />
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-6">
            <StatCard label={t('dashboard.employees')} value={d ? fmtNumber(d.employees) : '—'} icon={Users} loading={loading} />
            <StatCard label={t('dashboard.presentToday')} value={d ? fmtNumber(d.presentToday) : '—'} icon={UserCheck} tone="success" loading={loading} />
            <StatCard label={t('dashboard.absent')} value={d ? fmtNumber(d.absent) : '—'} icon={LogOut} tone="danger" loading={loading} />
            <StatCard label={t('dashboard.late')} value={d ? fmtNumber(d.late) : '—'} icon={Clock} tone="warning" loading={loading} />
            <StatCard label={t('dashboard.onLeave')} value={d ? fmtNumber(d.onLeave) : '—'} icon={CalendarOff} tone="info" loading={loading} />
            <StatCard label={t('dashboard.earlyDeparture')} value={d ? fmtNumber(d.earlyDeparture) : '—'} icon={Activity} tone="warning" loading={loading} />
            <StatCard label={t('dashboard.overtime')} value={d ? fmtMinutes(d.overtimeMinutes) : '—'} icon={Timer} loading={loading} />
            <StatCard label={t('dashboard.missingPunch')} value={d ? fmtNumber(d.missingPunch) : '—'} icon={AlertTriangle} tone="warning" loading={loading} />
            <StatCard label={t('dashboard.devicesOnline')} value={d ? fmtNumber(d.devicesOnline) : '—'} icon={Cpu} tone="success" loading={loading} />
            <StatCard label={t('dashboard.devicesOffline')} value={d ? fmtNumber(d.devicesOffline) : '—'} icon={WifiOff} tone={d && d.devicesOffline > 0 ? 'danger' : 'default'} loading={loading} />
            <StatCard label={t('dashboard.syncFailures')} value={d ? fmtNumber(d.syncFailures24h) : '—'} icon={AlertTriangle} tone={d && d.syncFailures24h > 0 ? 'danger' : 'default'} loading={loading} />
            <StatCard label={t('dashboard.pendingApprovals')} value={d ? fmtNumber(d.pendingApprovals) : '—'} icon={ClipboardCheck} tone="info" loading={loading} />
          </div>
          <div id="dashboard-charts" className="mt-6 grid gap-4 lg:grid-cols-2" />
        </>
      )}
    </div>
  );
}
