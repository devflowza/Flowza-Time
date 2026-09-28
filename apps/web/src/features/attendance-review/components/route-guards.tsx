import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldOff } from 'lucide-react';
import { EmptyState, Skeleton } from '@/components/ui';
import { useReviewAccess } from '../api';

const NotesReviewPage = lazy(() => import('../pages/notes-review-page'));
const GeofencesPage = lazy(() => import('../pages/geofences-page'));

function PageFallback() { return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>; }

/** Guard by a predicate (any of several keys, or line-manager status) — RequirePermission requires all of its keys. */
function Guard({ allowed, children }: { allowed: boolean; children: React.ReactNode }) {
  const { t } = useTranslation();
  if (!allowed) return <div className="page-container"><EmptyState icon={ShieldOff} title={t('common.permissionDenied')} /></div>;
  return <Suspense fallback={<PageFallback />}>{children}</Suspense>;
}

/** /attendance/notes: organisation-wide reviewers (review_notes / approve) and line managers. */
export function NotesRoute() { return <Guard allowed={useReviewAccess().notes}><NotesReviewPage /></Guard>; }
/** /attendance/geofences: attendance.manage_geofences. */
export function GeofencesRoute() { return <Guard allowed={useReviewAccess().geofences}><GeofencesPage /></Guard>; }
