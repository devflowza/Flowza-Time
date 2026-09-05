import { useTranslation } from 'react-i18next';
import type { OrgStatus } from '@flowza/contracts';
import { Badge } from '@/components/ui';

const STATUS_TONE: Record<OrgStatus, 'success' | 'info' | 'warning' | 'neutral'> = { active: 'success', trial: 'info', suspended: 'warning', closed: 'neutral' };

export function OrgStatusBadge({ status }: { status: OrgStatus }) {
  const { t } = useTranslation('platform');
  return <Badge variant={STATUS_TONE[status]} dot>{t(`status.${status}`)}</Badge>;
}

