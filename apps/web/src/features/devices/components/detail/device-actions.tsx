import { useTranslation } from 'react-i18next';
import { HeartPulse, KeyRound, MoreHorizontal, Pencil, Plug, Power, PowerOff, RefreshCw, RotateCcw, Trash2, Users } from 'lucide-react';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui';
import { useCan } from '@/features/me/use-me';
import type { DeviceDetail } from '../../api';

export type DeviceActionKind = 'sync-attendance' | 'sync-employees' | 'health-check' | 'restart' | 'test-connection' | 'rotate-token' | 'edit' | 'disable' | 'enable' | 'decommission';

/**
 * Header actions of the device page. Only actions the device actually supports are rendered: the capability matrix and the
 * integration type decide what is shown, permissions decide what is enabled (the API re-checks both).
 */
export function DeviceActions({ device, busy, onAction }: { device: DeviceDetail; busy?: DeviceActionKind | null; onAction: (kind: DeviceActionKind) => void }) {
  const { t } = useTranslation('devices');
  const can = useCan();
  const caps = device.capabilities;
  const active = device.status === 'active';
  const isPush = device.integrationType === 'DEVICE_PUSH';
  const canSync = can('device.sync') && active;
  const canTest = (can('device.update') || can('device.manage')) && active && !isPush;
  // mirrors the API's needsToken(): push terminals, vendor webhooks and providers with a webhook handler authenticate with a token
  const hasPushAuth = isPush || device.integrationType === 'VENDOR_WEBHOOK' || device.hasPushToken || caps.webhooks;
  const showMore = can('device.update') || can('device.manage');
  const isBusy = (k: DeviceActionKind) => busy === k;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canSync && caps.attendancePull ? <Button size="sm" variant="outline" onClick={() => onAction('sync-attendance')} loading={isBusy('sync-attendance')}><RefreshCw /> {t('actions.syncAttendance')}</Button> : null}
      {canSync && caps.employeePush ? <Button size="sm" variant="outline" onClick={() => onAction('sync-employees')} loading={isBusy('sync-employees')}><Users /> {t('actions.syncEmployees')}</Button> : null}
      {canSync ? <Button size="sm" variant="outline" onClick={() => onAction('health-check')} loading={isBusy('health-check')}><HeartPulse /> {t('actions.healthCheck')}</Button> : null}
      {canTest ? <Button size="sm" variant="outline" onClick={() => onAction('test-connection')} loading={isBusy('test-connection')}><Plug /> {t('actions.testConnection')}</Button> : null}
      {canSync && caps.remoteRestart ? <Button size="sm" variant="outline" onClick={() => onAction('restart')} loading={isBusy('restart')}><RotateCcw /> {t('actions.restart')}</Button> : null}
      {showMore ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="sm" variant="outline" aria-label={t('actions.more')}><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {can('device.update') && device.status !== 'decommissioned' ? <DropdownMenuItem onSelect={() => onAction('edit')}><Pencil /> {t('actions.edit')}</DropdownMenuItem> : null}
            {can('device.manage') && hasPushAuth && active ? <DropdownMenuItem onSelect={() => onAction('rotate-token')}><KeyRound /> {t('actions.rotateToken')}</DropdownMenuItem> : null}
            {can('device.manage') && device.status !== 'decommissioned' ? (
              <>
                <DropdownMenuSeparator />
                {active
                  ? <DropdownMenuItem onSelect={() => onAction('disable')}><PowerOff /> {t('actions.disable')}</DropdownMenuItem>
                  : <DropdownMenuItem onSelect={() => onAction('enable')}><Power /> {t('actions.enable')}</DropdownMenuItem>}
                <DropdownMenuItem destructive onSelect={() => onAction('decommission')}><Trash2 /> {t('actions.decommission')}</DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
