import { useTranslation } from 'react-i18next';
import { BellOff } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui';
import { useActiveMembership } from '@/features/me/use-me';
import { NotificationPreferencesCard } from './preferences/notification-preferences-card';

/**
 * /account/notifications — the member's own notification preferences, reachable by EVERY active member (notifications review
 * 8-P1-4). Settings needs `organization.view` and /my needs an employee link, so a member with neither (a device technician,
 * an HR assistant without a profile) could receive notices and e-mails with nowhere to switch them off — the e-mail footer
 * sent them to a page they were refused. The footer of a member without an employee link points here; employees keep
 * /my/profile, staff also Settings → Notifications (the same card everywhere).
 */
export default function AccountNotificationsPage() {
  const { t } = useTranslation();
  const membership = useActiveMembership();
  return (
    <div className="page-container max-w-3xl space-y-4">
      <PageHeader title={t('notifications.settingsTitle')} description={t('notifications.settingsDescription')} />
      {membership ? <NotificationPreferencesCard /> : <EmptyState icon={BellOff} title={t('notifications.settingsNoMembership')} />}
    </div>
  );
}
