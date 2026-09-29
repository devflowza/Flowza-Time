import { useTranslation } from 'react-i18next';
import { UserRound } from 'lucide-react';
import { EmptyState } from '@/components/ui';
import { useActiveMembership } from '@/features/me/use-me';

/**
 * `/` for a member with neither the dashboard nor an employee link (e.g. invited as an Employee without choosing their
 * record): the dashboard would only answer 403 "Missing permission: dashboard.view", and self-service has no record to
 * scope to — say what is missing and who can fix it.
 */
export function UnlinkedHome() {
  const { t } = useTranslation();
  const org = useActiveMembership()?.organization.displayName ?? '';
  return <div className="page-container"><EmptyState icon={UserRound} title={t('common.unlinkedHomeTitle', { org })} description={t('common.unlinkedHomeHint')} /></div>;
}
