import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check, MailCheck, X } from 'lucide-react';
import type { ApprovalDecideResultDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Button, Card, CardContent, EmptyState, FormField, Textarea } from '@/components/ui';
import { buttonVariants } from '@/components/ui/button';
import { toastError } from '@/lib/toast';
import { useEmailAction, type DecisionKind } from '../api';

/**
 * /approvals/email-action?org=…&action=APPROVE|REJECT&token=… — the landing page of a one-click e-mail link. Nothing
 * happens on load (mail scanners follow links): the signed-in approver confirms, then the token is POSTed once. The API
 * checks that the token belongs to this account, is unused and unexpired, and applies every decision rule.
 */
export default function EmailActionPage() {
  const { t } = useTranslation('approvals');
  const [params] = useSearchParams();
  const orgId = params.get('org') ?? '';
  const token = params.get('token') ?? '';
  const actionParam = params.get('action');
  const action: DecisionKind | null = actionParam === 'APPROVE' || actionParam === 'REJECT' ? actionParam : null;
  const [comment, setComment] = useState('');
  const [result, setResult] = useState<ApprovalDecideResultDto | null>(null);
  const mutation = useEmailAction();
  if (!orgId || !token || !action) return <div className="page-container"><EmptyState icon={MailCheck} title={t('email.invalid')} /></div>;
  const reject = action === 'REJECT';
  const missing = reject && comment.trim().length === 0;
  return (
    <div className="page-container max-w-xl space-y-4">
      <PageHeader title={t('email.title')} description={reject ? t('email.rejectHint') : t('email.approveHint')} />
      <Card>
        <CardContent className="space-y-4 pt-5">
          {result ? (
            <div className="space-y-3" role="status">
              <p className="text-sm">{t('email.done', { status: t(`status.${result.status}`) })}</p>
              <div className="flex gap-2"><Link to={`/approvals/requests/${result.id}`} className={buttonVariants({ size: 'sm' })}>{t('email.open')}</Link><Link to="/approvals" className={buttonVariants({ size: 'sm', variant: 'outline' })}>{t('email.inbox')}</Link></div>
            </div>
          ) : (
            <>
              <FormField label={t('email.comment')} htmlFor="email-comment" required={reject} optional={!reject}>
                <Textarea id="email-comment" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={reject ? t('decision.rejectPlaceholder') : t('decision.approvePlaceholder')} />
              </FormField>
              <Button variant={reject ? 'destructive' : 'default'} disabled={missing} loading={mutation.isPending}
                onClick={() => mutation.mutate({ orgId, token, action, comment: comment.trim() || undefined }, { onSuccess: setResult, onError: toastError })}>
                {reject ? <><X /> {t('email.confirmReject')}</> : <><Check /> {t('email.confirmApprove')}</>}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
