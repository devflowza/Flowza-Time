import { useTranslation } from 'react-i18next';
import type { ConnectionStatus, DeviceCapabilities, DeviceEmployeeSyncStatus, DeviceStatus, IntegrationType, ProviderStatus, VerificationStatus } from '@flowza/contracts';
import { CAPABILITY_KEYS } from '@flowza/contracts';
import { Badge, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui';
import { fmtRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

type Tone = 'success' | 'info' | 'warning' | 'neutral' | 'danger';
const CONN_TONE: Record<ConnectionStatus, Tone> = { online: 'success', offline: 'danger', degraded: 'warning', vendor_degraded: 'warning', error: 'danger', unknown: 'neutral' };
const STATUS_TONE: Record<DeviceStatus, Tone> = { active: 'success', disabled: 'warning', decommissioned: 'neutral' };
const PROVIDER_TONE: Record<ProviderStatus, Tone> = { available: 'success', beta: 'info', placeholder: 'neutral', deprecated: 'danger' };
const VERIFY_TONE: Record<VerificationStatus, Tone> = { VERIFIED: 'success', REPORTED: 'info', UNVERIFIED: 'neutral' };
const SYNC_TONE: Record<DeviceEmployeeSyncStatus, Tone> = { IN_SYNC: 'success', PENDING: 'info', OUT_OF_SYNC: 'warning', FAILED: 'danger', OFFLINE: 'warning', UNSUPPORTED: 'neutral', REMOVING: 'neutral', REMOVED: 'neutral' };

export function ConnectionBadge({ status, lastHeartbeatAt, showRelative = true }: { status: ConnectionStatus; lastHeartbeatAt?: string | null; showRelative?: boolean }) {
  const { t } = useTranslation('devices');
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge variant={CONN_TONE[status]} dot className={cn(status === 'online' && '[&>span]:animate-pulse')}>{t(`connection.${status}`)}</Badge>
      {showRelative && lastHeartbeatAt ? <span className="text-xs text-muted-foreground tnum" title={lastHeartbeatAt}>{fmtRelative(lastHeartbeatAt)}</span> : null}
    </span>
  );
}
export function DeviceStatusBadge({ status }: { status: DeviceStatus }) {
  const { t } = useTranslation('devices');
  return <Badge variant={STATUS_TONE[status]}>{t(`deviceStatus.${status}`)}</Badge>;
}
export function ProviderStatusBadge({ status }: { status: ProviderStatus }) {
  const { t } = useTranslation('devices');
  return <Badge variant={PROVIDER_TONE[status]}>{t(`providerStatus.${status}`)}</Badge>;
}
export function VerificationBadge({ status }: { status: VerificationStatus }) {
  const { t } = useTranslation('devices');
  return <Badge variant={VERIFY_TONE[status]} className="font-normal">{t(`verification.${status}`)}</Badge>;
}
export function IntegrationBadge({ type }: { type: IntegrationType }) {
  const { t } = useTranslation('devices');
  return <Badge variant="outline" className="font-normal">{t(`integration.${type}`)}</Badge>;
}
export function EmployeeSyncBadge({ status }: { status: DeviceEmployeeSyncStatus }) {
  const { t } = useTranslation('devices');
  return <Badge variant={SYNC_TONE[status]} dot>{t(`syncStatus.${status}`)}</Badge>;
}
export function TagChips({ tags, max = 3 }: { tags: string[]; max?: number }) {
  if (!tags.length) return <span className="text-muted-foreground">—</span>;
  const shown = tags.slice(0, max);
  const rest = tags.length - shown.length;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {shown.map((tag) => <Badge key={tag} variant="secondary" className="font-normal">{tag}</Badge>)}
      {rest > 0 ? (
        <Tooltip><TooltipTrigger asChild><Badge variant="outline" className="font-normal tnum">+{rest}</Badge></TooltipTrigger><TooltipContent>{tags.slice(max).join(', ')}</TooltipContent></Tooltip>
      ) : null}
    </span>
  );
}

/** Capability matrix rendered as chips; only enabled capabilities are shown unless `all` is set. */
export function CapabilityChips({ capabilities, all = false, className }: { capabilities: Partial<DeviceCapabilities>; all?: boolean; className?: string }) {
  const { t } = useTranslation('devices');
  const keys = CAPABILITY_KEYS.filter((k) => all || capabilities[k]);
  if (keys.length === 0) return <span className="text-xs text-muted-foreground">{t('capabilities.none')}</span>;
  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      {keys.map((k) => <Badge key={k} variant={capabilities[k] ? 'info' : 'outline'} className={cn('font-normal', !capabilities[k] && 'text-muted-foreground line-through')}>{t(`capabilities.${k}`)}</Badge>)}
    </div>
  );
}
