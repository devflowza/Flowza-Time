import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldOff } from 'lucide-react';
import { EmptyState, Skeleton } from '@/components/ui';
import { useRegularisationAccess } from '../api';

const RegularisationsPage = lazy(() => import('../pages/regularisations-page'));

function PageFallback() { return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>; }

/** /attendance/regularisations: attendance.approve or attendance.review_notes (any one); the API re-checks and RLS scopes the rows. */
export function RegularisationsRoute() {
  const { t } = useTranslation();
  if (!useRegularisationAccess().page) return <div className="page-container"><EmptyState icon={ShieldOff} title={t('common.permissionDenied')} /></div>;
  return <Suspense fallback={<PageFallback />}><RegularisationsPage /></Suspense>;
}
