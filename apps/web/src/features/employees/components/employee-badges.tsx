import { useTranslation } from 'react-i18next';
import type { DeviceEmployeeSyncStatus, EmployeeDto, EmploymentStatus } from '@flowza/contracts';
import { Badge, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui';

const STATUS_TONE: Record<EmploymentStatus, 'success' | 'info' | 'warning' | 'neutral' | 'danger'> = { active: 'success', on_leave: 'info', suspended: 'warning', terminated: 'neutral', resigned: 'neutral' };
export function EmploymentStatusBadge({ status }: { status: EmploymentStatus }) {
  const { t } = useTranslation('employees');
  return <Badge variant={STATUS_TONE[status]} dot>{t(`employmentStatus.${status}`)}</Badge>;
}

const SYNC_TONE: Record<DeviceEmployeeSyncStatus, 'success' | 'info' | 'warning' | 'neutral' | 'danger'> = { IN_SYNC: 'success', PENDING: 'info', OUT_OF_SYNC: 'warning', FAILED: 'danger', OFFLINE: 'warning', UNSUPPORTED: 'neutral', REMOVING: 'neutral', REMOVED: 'neutral' };
export function SyncStatusBadge({ status }: { status: DeviceEmployeeSyncStatus }) {
  const { t } = useTranslation('employees');
  return <Badge variant={SYNC_TONE[status]} dot>{t(`syncStatus.${status}`)}</Badge>;
}

/** Compact "3 ✓ · 1 pending · 1 failed" summary of device_employee_states for the list table. */
export function DeviceSyncSummary({ summary }: { summary: EmployeeDto['deviceSyncSummary'] }) {
  const { t } = useTranslation('employees');
  if (!summary || summary.total === 0) return <span className="text-xs text-muted-foreground">{t('sync.noDevices')}</span>;
  const items: { key: string; n: number; tone: 'success' | 'info' | 'danger' | 'warning' }[] = [
    { key: 'inSync', n: summary.inSync, tone: 'success' }, { key: 'pending', n: summary.pending, tone: 'info' }, { key: 'failed', n: summary.failed, tone: 'danger' }, { key: 'offline', n: summary.offline, tone: 'warning' },
  ];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex flex-wrap gap-1 tnum">
          {items.filter((i) => i.n > 0).map((i) => <Badge key={i.key} variant={i.tone}>{i.n} {t(`sync.${i.key}`)}</Badge>)}
        </span>
      </TooltipTrigger>
      <TooltipContent>{t('sync.summaryTooltip', { total: summary.total, inSync: summary.inSync })}</TooltipContent>
    </Tooltip>
  );
}
