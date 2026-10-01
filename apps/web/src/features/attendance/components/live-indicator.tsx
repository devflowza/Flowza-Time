import { useTranslation } from 'react-i18next';
import { Badge, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { LiveMode } from '../live';
import '../workspace-i18n';

/** "Live" while realtime signals arrive, "Auto-refresh" while the register falls back to polling (useAttendanceLive). */
export function LiveIndicator({ mode }: { mode: LiveMode }) {
  const { t } = useTranslation('attendanceWorkspace');
  const live = mode === 'live';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={live ? 'success' : 'neutral'} dot tabIndex={0} role="status" data-testid="attendance-live" data-mode={mode} className={cn('cursor-default', live && '[&>span]:animate-pulse')}>
          {live ? t('live.on') : t('live.polling')}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{live ? t('live.onHint') : t('live.pollingHint')}</TooltipContent>
    </Tooltip>
  );
}
