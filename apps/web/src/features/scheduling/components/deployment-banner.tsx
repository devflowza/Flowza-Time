import { useTranslation } from 'react-i18next';
import { MapPinned } from 'lucide-react';
import { fmtDate } from '@/lib/format';
import { SCHED_NS } from '../i18n';

/** The portal check-in page's note while a temporary deployment covers today: the host branch's zone is accepted too. */
export function DeploymentBanner({ deployment }: { deployment: { branchId: string; branchName: string | null; toDate: string } }) {
  const { t } = useTranslation(SCHED_NS);
  return (
    <div role="status" data-testid="deployment-banner" className="flex items-start gap-3 rounded-lg border border-info/30 bg-info/10 p-3 text-sm">
      <MapPinned className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div>
        <p className="font-medium">{t('banner.deployed', { branch: deployment.branchName ?? t('banner.anotherBranch'), date: fmtDate(deployment.toDate) })}</p>
        <p className="text-muted-foreground">{t('banner.hint')}</p>
      </div>
    </div>
  );
}
