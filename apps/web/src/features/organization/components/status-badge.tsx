import { useTranslation } from 'react-i18next';
import type { RecordStatus } from '@flowza/contracts';
import { Badge } from '@/components/ui';

const TONE: Record<RecordStatus, 'success' | 'neutral' | 'warning'> = { active: 'success', inactive: 'warning', archived: 'neutral' };

export function RecordStatusBadge({ status }: { status: RecordStatus }) {
  const { t } = useTranslation('organization');
  return <Badge variant={TONE[status]} dot>{t(`status.${status}`)}</Badge>;
}
