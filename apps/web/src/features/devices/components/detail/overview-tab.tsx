import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { AlertTriangle } from 'lucide-react';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui';
import { fmtDateTime, fmtNumber, fmtRelative } from '@/lib/format';
import type { DeviceDetail } from '../../api';
import { CapabilityChips, ConnectionBadge, DeviceStatusBadge, IntegrationBadge, TagChips } from '../device-badges';

function Item({ label, children, ltr }: { label: string; children: React.ReactNode; ltr?: boolean }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-0.5 truncate text-sm" dir={ltr ? 'ltr' : undefined}>{children}</dd></div>;
}

export function OverviewTab({ device, tz }: { device: DeviceDetail; tz: string }) {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation();
  const when = (iso: string | null) => (iso ? <span title={fmtDateTime(iso, tz)} className="tnum">{fmtRelative(iso)}</span> : '—');
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader><CardTitle>{t('detail.status')}</CardTitle></CardHeader>
        <CardContent>
          {device.lastError ? (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50/60 p-3 text-sm dark:border-red-900 dark:bg-red-950/30" role="alert">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-600" aria-hidden />
              <div><p className="font-medium">{device.lastErrorCode ?? t('detail.lastError')}</p><p className="text-muted-foreground">{device.lastError}</p>{device.consecutiveFailures > 0 ? <p className="mt-1 text-xs text-muted-foreground tnum">{t('detail.consecutiveFailures', { count: device.consecutiveFailures })}</p> : null}</div>
            </div>
          ) : null}
          <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <Item label={t('columns.connection')}><ConnectionBadge status={device.connectionStatus} lastHeartbeatAt={device.lastHeartbeatAt} /></Item>
            <Item label={tc('common.status')}><DeviceStatusBadge status={device.status} /></Item>
            <Item label={t('fields.integration')}><IntegrationBadge type={device.integrationType} /></Item>
            <Item label={t('detail.lastHeartbeat')}>{when(device.lastHeartbeatAt)}</Item>
            <Item label={t('columns.lastAttendanceSync')}>{when(device.lastAttendanceSyncAt)}</Item>
            <Item label={t('columns.lastEmployeeSync')}>{when(device.lastEmployeeSyncAt)}</Item>
            <Item label={t('detail.lastSuccess')}>{when(device.lastSuccessfulCommunicationAt)}</Item>
            <Item label={t('columns.employees')}><span className="tnum">{fmtNumber(device.employeeCount ?? 0)}</span></Item>
            <Item label={t('detail.autoSync')}>{device.autoSyncEnabled ? t('detail.autoSyncEvery', { minutes: device.syncIntervalMinutes }) : tc('common.no')}</Item>
            <Item label={t('fields.offlineThreshold')}><span className="tnum">{device.offlineThresholdMinutes} {tc('common.minutes')}</span></Item>
            <Item label={t('detail.generation')}><span className="tnum">{device.generation}</span></Item>
            <Item label={t('detail.pushToken')}>{device.hasPushToken ? <Badge variant="success">{t('detail.tokenSet')}</Badge> : <Badge variant="neutral">{tc('common.none')}</Badge>}</Item>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('detail.identity')}</CardTitle></CardHeader>
        <CardContent>
          <dl className="grid gap-3">
            <Item label={tc('common.code')} ltr><span className="font-mono">{device.code}</span></Item>
            <Item label={tc('common.branch')}>{device.branchName ?? device.branchId}</Item>
            <Item label={t('columns.provider')}>{device.providerName ?? device.providerKey}</Item>
            <Item label={t('columns.model')}>{device.manufacturer}{device.modelName ? ` · ${device.modelName}` : ''}</Item>
            <Item label={t('fields.serialNumber')} ltr><span className="font-mono">{device.serialNumber ?? '—'}</span></Item>
            <Item label={t('detail.firmware')} ltr>{device.firmwareVersion ?? '—'}</Item>
            <Item label={tc('common.timezone')} ltr>{device.timezone}</Item>
            <Item label={t('fields.endpointUrl')} ltr>{device.endpointUrl ?? '—'}</Item>
            <Item label={t('fields.tags')}><TagChips tags={device.tags} max={6} /></Item>
            <Item label={t('groups.title')}>{device.groupIds.length ? <Link to="/devices/groups" className="text-primary hover:underline tnum">{t('detail.inGroups', { count: device.groupIds.length })}</Link> : '—'}</Item>
            <Item label={tc('common.createdAt')}>{fmtDateTime(device.createdAt, tz)}</Item>
          </dl>
        </CardContent>
      </Card>
      <Card className="lg:col-span-3">
        <CardHeader><CardTitle>{t('detail.capabilities')}</CardTitle></CardHeader>
        <CardContent><CapabilityChips capabilities={device.capabilities} all /></CardContent>
      </Card>
      {device.notes ? <Card className="lg:col-span-3"><CardHeader><CardTitle>{t('fields.notes')}</CardTitle></CardHeader><CardContent><p className="whitespace-pre-wrap text-sm">{device.notes}</p></CardContent></Card> : null}
    </div>
  );
}
