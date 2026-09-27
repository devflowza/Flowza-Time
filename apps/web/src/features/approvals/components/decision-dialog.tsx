import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X } from 'lucide-react';
import type { ApprovalRequestDto } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Textarea } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { useApprovalMutations, type DecisionKind } from '../api';
import { decisionToast } from '../labels';
import { ApprovalContext, EntityIcon } from './parts';

export type Decision = DecisionKind;

/** Approve / reject the current level of one request. Rejecting requires a comment (the API enforces it too). */
export function DecisionDialog({ request, decision, timezone, onClose }: { request: ApprovalRequestDto | null; decision: Decision; timezone: string; onClose: () => void }) {
  const { t } = useTranslation('approvals');
  const { t: tc } = useTranslation();
  const { decide } = useApprovalMutations();
  const [comment, setComment] = useState('');
  const reject = decision === 'REJECT';
  const missing = reject && comment.trim().length === 0;
  const submit = () => {
    if (!request || missing) return;
    decide.mutate({ requestId: request.id, stepNo: request.currentStep, decision, comment: comment.trim() || undefined }, {
      onSuccess: (res) => { toast.success(decisionToast(t, res, decision, request.currentStep)); onClose(); },
      onError: toastError,
    });
  };
  return (
    <Dialog open={!!request} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{reject ? t('decision.rejectTitle') : t('decision.approveTitle')}</DialogTitle>
          <DialogDescription>{reject ? t('decision.rejectHint') : t('decision.approveHint')}</DialogDescription>
        </DialogHeader>
        {request ? (
          <div className="flex gap-3 rounded-md border bg-muted/30 p-3">
            <EntityIcon entityType={request.entityType} />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium">{request.employeeName ?? request.requestedByName ?? '—'} <span className="font-mono text-xs text-muted-foreground" dir="ltr">{request.employeeNumber}</span></p>
              <p className="text-xs text-muted-foreground">{t(`entity.${request.entityType}`)} · {t('level', { n: request.currentStep, count: request.stepCount })}</p>
              <ApprovalContext context={request.context} timezone={timezone} />
            </div>
          </div>
        ) : null}
        <FormField label={t('decision.comment')} htmlFor="dec-comment" required={reject} optional={!reject}>
          <Textarea id="dec-comment" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={reject ? t('decision.rejectPlaceholder') : t('decision.approvePlaceholder')} aria-invalid={missing || undefined} />
          {missing ? <p className="text-xs text-muted-foreground">{t('decision.commentRequired')}</p> : null}
        </FormField>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
          <Button type="button" variant={reject ? 'destructive' : 'default'} disabled={missing} loading={decide.isPending} onClick={submit}>{reject ? <><X /> {t('actions.reject')}</> : <><Check /> {t('actions.approve')}</>}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
