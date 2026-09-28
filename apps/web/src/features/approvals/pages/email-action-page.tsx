import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check, MailCheck, X } from 'lucide-react';
import type { ApprovalDecideResultDto, ApprovalEmailPreviewDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Button, Card, CardContent, EmptyState, ErrorState, FormField, Skeleton, Textarea } from '@/components/ui';
import { buttonVariants } from '@/components/ui/button';
import { fmtDate } from '@/lib/format';
import { toastError } from '@/lib/toast';
import { useEmailAction, useEmailPreview, type DecisionKind } from '../api';

/** The request a link is about, as the API read it from the request (never from the e-mail). */
function RequestSummary({ p }: { p: ApprovalEmailPreviewDto }) {
  const { t, i18n } = useTranslation('approvals');
  const leaveType = (i18n.language.startsWith('ar') ? p.leaveTypeNameAr : null) ?? p.leaveTypeName;
  const dates = p.date ? (p.endDate && p.endDate !== p.date ? `${fmtDate(p.date)} → ${fmtDate(p.endDate)}` : fmtDate(p.date)) : null;
  const rows: Array<[string, string]> = [
    [t('columns.request'), t(`entity.${p.entityType}`, { defaultValue: p.entityType })],
    ...(p.employeeName ? [[t('columns.employee'), p.employeeName] as [string, string]] : []),
    ...(leaveType ? [[t('email.leaveType'), leaveType] as [string, string]] : []),
    ...(dates ? [[t('email.dates'), dates] as [string, string]] : []),
    [t('columns.level'), t('level', { n: p.stepNo, count: p.stepCount })],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm" data-testid="email-action-summary">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words font-medium">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * /approvals/email-action?org=…&action=APPROVE|REJECT&token=… — the landing page of a one-click e-mail link. Nothing
 * happens on load (mail scanners follow links): the page first shows what the request IS — read by the API from the request
 * itself through a read-only preview of the token (notifications review 8-P0-1: the e-mail's own words are never the basis of
 * a decision) — then the signed-in approver confirms and the token is POSTed once. The API checks that the token belongs to
 * this account, is unused and unexpired, and applies every decision rule.
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
  const preview = useEmailPreview({ orgId, token, action });
  const mutation = useEmailAction();
  if (!orgId || !token || !action) return <div className="page-container"><EmptyState icon={MailCheck} title={t('email.invalid')} /></div>;
  const reject = action === 'REJECT';
  const missing = reject && comment.trim().length === 0;
  const p = preview.data;
  const links = (requestId: string | null) => (
    <div className="flex gap-2">
      {requestId ? <Link to={`/approvals/requests/${requestId}`} className={buttonVariants({ size: 'sm' })}>{t('email.open')}</Link> : null}
      <Link to="/approvals" className={buttonVariants({ size: 'sm', variant: 'outline' })}>{t('email.inbox')}</Link>
    </div>
  );
  return (
    <div className="page-container max-w-xl space-y-4">
      <PageHeader title={t('email.title')} description={reject ? t('email.rejectHint') : t('email.approveHint')} />
      <Card>
        <CardContent className="space-y-4 pt-5">
          {result ? (
            <div className="space-y-3" role="status">
              <p className="text-sm">{t('email.done', { status: t(`status.${result.status}`) })}</p>
              {links(result.id)}
            </div>
          ) : preview.isError ? (
            <div className="space-y-3">
              <ErrorState error={preview.error} />
              {links(null)}
            </div>
          ) : !p ? (
            <div className="space-y-2" aria-busy="true"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-5 w-1/2" /><Skeleton className="h-5 w-1/3" /></div>
          ) : (
            <>
              <RequestSummary p={p} />
              {p.actionable ? (
                <>
                  <FormField label={t('email.comment')} htmlFor="email-comment" required={reject} optional={!reject}>
                    <Textarea id="email-comment" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={reject ? t('decision.rejectPlaceholder') : t('decision.approvePlaceholder')} />
                  </FormField>
                  <Button variant={reject ? 'destructive' : 'default'} disabled={missing} loading={mutation.isPending}
                    onClick={() => mutation.mutate({ orgId, token, action, comment: comment.trim() || undefined }, { onSuccess: setResult, onError: toastError })}>
                    {reject ? <><X /> {t('email.confirmReject')}</> : <><Check /> {t('email.confirmApprove')}</>}
                  </Button>
                </>
              ) : (
                <div className="space-y-3" role="status">
                  <p className="text-sm text-muted-foreground">{t('email.notWaiting', { status: t(`status.${p.status}`) })}</p>
                  {links(p.requestId)}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
