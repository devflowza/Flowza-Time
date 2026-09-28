import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui';
import { useApprovalAccess } from '../api';
import { RequestDetail } from '../components/request-detail';

/**
 * /approvals/requests/:id — one request with its levels and timeline. Open to any member: the API decides visibility
 * (approvers, the requester, the person concerned, their manager, organisation-wide readers). Notification links land here.
 */
export default function ApprovalRequestPage() {
  const { t } = useTranslation('approvals');
  const { id = '' } = useParams();
  const access = useApprovalAccess();
  return (
    <div className="page-container space-y-4">
      <PageHeader title={t('detail.title')} breadcrumbs={access.inbox ? <Link to="/approvals" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="size-3 rtl:rotate-180" /> {t('detail.back')}</Link> : undefined} />
      <Card><CardContent className="pt-5"><RequestDetail requestId={id} /></CardContent></Card>
    </div>
  );
}
