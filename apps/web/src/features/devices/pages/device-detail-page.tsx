import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import type { DevicePushCredentials, TestConnectionResultDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, ConfirmDialog, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, ErrorState, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { useOrgTimezone } from '@/features/me/use-me';
import { toastJobQueued } from '@/features/sync/job-toast';
import { useDevice, useDeviceMutations, type DeviceAction } from '../api';
import { ConnectionBadge, DeviceStatusBadge, IntegrationBadge } from '../components/device-badges';
import { PushCredentialsDialog } from '../components/push-credentials-dialog';
import { TestConnectionResult } from '../components/test-connection-result';
import { DeviceActions, type DeviceActionKind } from '../components/detail/device-actions';
import { OverviewTab } from '../components/detail/overview-tab';
import { EmployeesTab } from '../components/detail/employees-tab';
import { CommandsTab, LogsTab } from '../components/detail/logs-tab';
import { SyncHistoryTab } from '../components/detail/sync-history-tab';
import { SettingsTab } from '../components/detail/settings-tab';

const TABS = ['overview', 'employees', 'logs', 'commands', 'sync', 'settings'] as const;
type Tab = (typeof TABS)[number];
type Confirm = 'disable' | 'decommission' | 'rotate-token' | null;

export default function DeviceDetailPage() {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const tz = useOrgTimezone();
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'overview';
  const q = useDevice(id);
  const { runAction, testConnection, rotatePushToken, remove, update } = useDeviceMutations();
  const [busy, setBusy] = useState<DeviceActionKind | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [testResult, setTestResult] = useState<TestConnectionResultDto | null>(null);
  const [rotated, setRotated] = useState<DevicePushCredentials | null>(null);
  const d = q.data;
  const isPush = d?.integrationType === 'DEVICE_PUSH';
  const tabs = TABS.filter((tb) => tb !== 'commands' || isPush);

  const run = (action: DeviceAction, kind: DeviceActionKind) => {
    setBusy(kind);
    runAction.mutate({ id, action }, { onSuccess: (r) => toastJobQueued(r.jobId, navigate), onError: toastError, onSettled: () => setBusy(null) });
  };

  const onAction = (kind: DeviceActionKind) => {
    if (!d) return;
    switch (kind) {
      case 'sync-attendance': return run('sync-attendance', kind);
      case 'sync-employees': return run('sync-employees', kind);
      case 'health-check': return run('health-check', kind);
      case 'test-connection':
        setBusy(kind);
        return testConnection.mutate({ providerKey: d.providerKey, config: {}, deviceId: d.id }, { onSuccess: setTestResult, onError: toastError, onSettled: () => setBusy(null) });
      case 'edit': return setParams({ tab: 'settings' });
      case 'enable': return update.mutate({ id, input: { status: 'active' } }, { onSuccess: () => toast.success(t('detail.enabled')), onError: toastError });
      case 'disable': case 'decommission': case 'rotate-token': return setConfirm(kind);
    }
  };

  const onConfirm = () => {
    if (confirm === 'rotate-token') rotatePushToken.mutate(id, { onSuccess: (creds) => { setConfirm(null); toast.success(t('push.rotated')); setRotated(creds); }, onError: toastError });
    else if (confirm) {
      const decommission = confirm === 'decommission';
      remove.mutate({ id, decommission }, { onSuccess: () => { setConfirm(null); toast.success(t(decommission ? 'detail.decommissioned' : 'detail.disabled')); }, onError: toastError });
    }
  };
  const confirming = rotatePushToken.isPending || remove.isPending;

  return (
    <div className="page-container">
      {q.isLoading ? <div className="space-y-4"><Skeleton className="h-8 w-72" /><Skeleton className="h-10 w-96" /><Skeleton className="h-96 w-full" /></div>
        : q.isError || !d ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
          <>
            <PageHeader
              breadcrumbs={<Link to="/devices" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="size-3 rtl:rotate-180" /> {t('title')}</Link>}
              title={d.name}
              description={[d.code, d.branchName, d.providerName ?? d.providerKey, d.modelName].filter(Boolean).join(' · ')}
              actions={<DeviceActions device={d} busy={busy} onAction={onAction} />}
            />
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <ConnectionBadge status={d.connectionStatus} lastHeartbeatAt={d.lastHeartbeatAt} />
              <DeviceStatusBadge status={d.status} />
              <IntegrationBadge type={d.integrationType} />
              {d.serialNumber ? <Badge variant="outline" className="font-mono" dir="ltr">SN {d.serialNumber}</Badge> : null}
              {d.status !== 'active' ? <span className="text-xs text-muted-foreground">{t('detail.notActiveHint', { status: t(`deviceStatus.${d.status}`) })}</span> : null}
            </div>
            <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
              <TabsList className="max-w-full overflow-x-auto">{tabs.map((tb) => <TabsTrigger key={tb} value={tb}>{t(`detail.tabs.${tb}`)}</TabsTrigger>)}</TabsList>
              <TabsContent value="overview"><OverviewTab device={d} tz={tz} /></TabsContent>
              <TabsContent value="employees">{tab === 'employees' ? <EmployeesTab deviceId={d.id} tz={tz} canPush={d.capabilities.employeePush && d.status === 'active'} /> : null}</TabsContent>
              <TabsContent value="logs">{tab === 'logs' ? <LogsTab deviceId={d.id} tz={tz} /> : null}</TabsContent>
              {isPush ? <TabsContent value="commands">{tab === 'commands' ? <CommandsTab deviceId={d.id} tz={tz} /> : null}</TabsContent> : null}
              <TabsContent value="sync">{tab === 'sync' ? <SyncHistoryTab deviceId={d.id} tz={tz} /> : null}</TabsContent>
              <TabsContent value="settings">{tab === 'settings' ? <SettingsTab device={d} /> : null}</TabsContent>
            </Tabs>

            <ConfirmDialog open={confirm === 'disable'} onOpenChange={(o) => !o && setConfirm(null)} title={t('detail.disableTitle', { name: d.name })} description={t('detail.disableHint')} confirmLabel={t('actions.disable')} loading={confirming} onConfirm={onConfirm} />
            <ConfirmDialog open={confirm === 'decommission'} onOpenChange={(o) => !o && setConfirm(null)} title={t('detail.decommissionTitle', { name: d.name })} description={t('detail.decommissionHint')} confirmLabel={t('actions.decommission')} destructive loading={confirming} onConfirm={onConfirm} />
            <ConfirmDialog open={confirm === 'rotate-token'} onOpenChange={(o) => !o && setConfirm(null)} title={t('detail.rotateTitle')} description={t('detail.rotateHint')} confirmLabel={t('actions.rotateToken')} destructive loading={confirming} onConfirm={onConfirm} />
            <PushCredentialsDialog credentials={rotated} onClose={() => setRotated(null)} title={t('push.rotated')} />
            <Dialog open={!!testResult} onOpenChange={(o) => !o && setTestResult(null)}>
              <DialogContent size="lg">
                <DialogHeader><DialogTitle>{t('test.title')}</DialogTitle></DialogHeader>
                {testResult ? <TestConnectionResult result={testResult} /> : null}
                <DialogFooter><Button type="button" onClick={() => setTestResult(null)}>{tc('common.close')}</Button></DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        )}
    </div>
  );
}
