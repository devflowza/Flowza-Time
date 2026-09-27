import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, BadgeCheck, Ban, Mail, MailWarning, Send } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, ConfirmDialog, ErrorState, Skeleton, Textarea } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useMe, useOrgTimezone } from '@/features/me/use-me';
import { StatementDocument } from '../components/statement-document';
import { useStatement, useStatementMutations } from '../api';
import { STATUS_BADGE } from '../status';

/** /statements/:id — the signed document, the employee's comments, and the approve / resend / void actions. */
export default function StatementDetailPage() {
  const { t } = useTranslation('statements');
  const { id } = useParams<{ id: string }>();
  const tz = useOrgTimezone();
  const can = useCan();
  const { data: me } = useMe();
  const detail = useStatement(id);
  const { approve, resend, voidStatement } = useStatementMutations();
  const [approveOpen, setApproveOpen] = useState(false);
  const [approveNote, setApproveNote] = useState('');
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');

  if (detail.isLoading) return <div className="page-container space-y-4"><Skeleton className="h-8 w-72" /><Skeleton className="h-96 w-full" /></div>;
  if (detail.isError || !detail.data) return <div className="page-container"><ErrorState error={detail.error} onRetry={() => void detail.refetch()} /></div>;
  const s = detail.data;

  const isApprover = s.approverUserId !== null && s.approverUserId === me?.user.id;
  const canApprove = s.status === 'PENDING_APPROVAL' && (isApprover || can('statement.approve'));
  const canManage = can('statement.issue');

  return (
    <div className="page-container space-y-5">
      <PageHeader
        title={t('detail.title', { period: s.snapshot.period.label })}
        description={`${s.employeeName} · ${s.employeeNumber}${s.departmentName ? ` · ${s.departmentName}` : ''}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canApprove ? (
              <Button onClick={() => { setApproveNote(''); setApproveOpen(true); }}><BadgeCheck className="size-4" aria-hidden /> {t('detail.approve')}</Button>
            ) : null}
            {canManage && (s.status === 'ISSUED' || s.status === 'PENDING_APPROVAL') ? (
              <Button
                variant="outline"
                loading={resend.isPending}
                onClick={() => resend.mutate(s.id, { onSuccess: () => toast.success(t('detail.resendQueued')), onError: toastError })}
              >
                <Send className="size-4" aria-hidden /> {t('detail.resend')}
              </Button>
            ) : null}
            {canManage && s.status !== 'FINALIZED' && s.status !== 'VOID' ? (
              <Button variant="outline" className="text-red-700 dark:text-red-300" onClick={() => { setVoidReason(''); setVoidOpen(true); }}>
                <Ban className="size-4" aria-hidden /> {t('detail.void')}
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <Badge variant={STATUS_BADGE[s.status]} dot>{t(`status.${s.status}`)}</Badge>
        {s.emailError ? (
          <span className="flex items-center gap-1.5 text-red-700 dark:text-red-300"><MailWarning className="size-4" aria-hidden />{s.emailError === 'NO_EMAIL' ? t('list.noEmail') : `${t('list.emailFailed')}: ${s.emailError}`}</span>
        ) : s.emailSentAt ? (
          <span className="flex items-center gap-1.5 text-muted-foreground"><Mail className="size-4" aria-hidden />{t('detail.emailedTo', { email: s.emailTo ?? '', at: fmtDateTime(s.emailSentAt, tz) })}</span>
        ) : null}
        {s.firstViewedAt ? <span className="text-muted-foreground">{t('detail.viewedAt', { at: fmtDateTime(s.firstViewedAt, tz) })}</span> : null}
        {s.signedName ? <span className="text-muted-foreground">{t('detail.signedBy', { name: s.signedName, at: s.submittedAt ? fmtDateTime(s.submittedAt, tz) : '' })}</span> : null}
        {s.status === 'PENDING_APPROVAL' && s.approverName ? <span className="text-muted-foreground">{t('detail.waitingOn', { name: s.approverName })}</span> : null}
        {s.finalizedReason === 'MANAGER_APPROVED' && s.approvedByName ? <span className="text-emerald-700 dark:text-emerald-300">{t('detail.approvedBy', { name: s.approvedByName, at: s.approvedAt ? fmtDateTime(s.approvedAt, tz) : '' })}</span> : null}
        {s.status === 'VOID' && s.voidReason ? <span className="text-red-700 dark:text-red-300">{t('detail.voidReason', { reason: s.voidReason })}</span> : null}
      </div>

      {s.approvalNote ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3.5 py-2.5 text-sm dark:border-emerald-900 dark:bg-emerald-950/30">
          <p className="text-xs font-medium uppercase tracking-wide text-emerald-800 dark:text-emerald-200">{t('detail.approvalNote')}</p>
          <p className="mt-0.5">{s.approvalNote}</p>
        </div>
      ) : null}

      <StatementDocument snapshot={s.snapshot} comments={s.comments} t={t} />

      <p className="text-xs text-muted-foreground"><Link className="hover:underline" to="/statements"><ArrowLeft className="me-1 inline size-3.5 rtl:rotate-180" aria-hidden />{t('detail.back')}</Link></p>

      <ConfirmDialog
        open={approveOpen}
        onOpenChange={setApproveOpen}
        title={t('detail.approveTitle')}
        description={t('detail.approveDescription', { count: s.commentCount })}
        confirmLabel={t('detail.approve')}
        loading={approve.isPending}
        onConfirm={() => approve.mutate({ id: s.id, note: approveNote.trim() || undefined }, {
          onSuccess: () => { setApproveOpen(false); toast.success(t('detail.approved')); },
          onError: toastError,
        })}
      >
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{t('detail.approveNoteLabel')}</p>
          <Textarea rows={3} maxLength={1000} value={approveNote} onChange={(e) => setApproveNote(e.target.value)} placeholder={t('detail.approveNotePlaceholder')} />
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={voidOpen}
        onOpenChange={setVoidOpen}
        title={t('detail.voidTitle')}
        description={t('detail.voidDescription')}
        confirmLabel={t('detail.void')}
        destructive
        loading={voidStatement.isPending}
        onConfirm={() => {
          if (voidReason.trim().length < 3) return;
          voidStatement.mutate({ id: s.id, reason: voidReason.trim() }, {
            onSuccess: () => { setVoidOpen(false); toast.success(t('detail.voided')); },
            onError: toastError,
          });
        }}
      >
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{t('detail.voidReasonLabel')}</p>
          <Textarea rows={2} maxLength={500} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder={t('detail.voidReasonPlaceholder')} />
        </div>
      </ConfirmDialog>
    </div>
  );
}
