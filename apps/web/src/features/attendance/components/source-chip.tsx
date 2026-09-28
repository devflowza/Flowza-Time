import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui';
import '../workspace-i18n';

/** `Auto` = the engine decided the status; `Manual` = an applied SET_STATUS correction overrides it (HR portal Prompt 6a). */
export function StatusSourceChip({ source, className }: { source: 'AUTO' | 'MANUAL'; className?: string }) {
  const { t } = useTranslation('attendanceWorkspace');
  return (
    <Badge variant={source === 'MANUAL' ? 'secondary' : 'outline'} className={className ?? 'text-[10px] px-1.5 py-0'} title={t(`source.${source}Hint`)} data-testid={`status-source-${source}`}>
      {t(`source.${source}`)}
    </Badge>
  );
}
