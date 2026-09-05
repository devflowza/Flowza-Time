import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Textarea } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { CorrectionSummary } from '@/features/attendance/components/record-dialog';
import { CorrectionTypeBadge } from '@/features/attendance/components/badges';
import { useApprovalMutations, type InboxItem } from '../api';

export type Decision = 'approve' | 'reject';

/** Approve / reject one pending step. Rejecting requires a comment (the API enforces it too). */
export function DecisionDialog({ item, decision, timezone, onClose }: { item: InboxItem | null; decision: Decision; timezone: string; onClose: () => void }) {
  const { t } = useTranslation('approvals');
  const { t: tc } = useTranslation();
  const { decide } = useApprovalMutations();
  const [comment, setComment] = useState('');
  const reject = decision === 'reject';
  const missing = reject && comment.trim().length === 0;
  const submit = () => {
    if (!item || missing) return;
    decide.mutate({ requestId: item.requestId, decision, comment: comment.trim() || undefined }, {
      onSuccess: (res) => { toast.success(reject ? t('decision.rejected') : res.status === 'APPROVED' ? t('decision.approved') : t('decision.stepApproved')); onClose(); },
      onError: toastError,
    });
  };
  const c = item?.correction;
  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{reject ? t('decision.rejectTitle') : t('decision.approveTitle')}</DialogTitle>
          <DialogDescription>{reject ? t('decision.rejectHint') : t('decision.approveHint')}</DialogDescription>
        </DialogHeader>
        {c ? (
          <div className="space-y-1.5 rounded-md border bg-muted/30 p-3 text-sm">
            <p className="font-medium">{c.employeeName ?? c.employeeId} <span className="font-mono text-xs text-muted-foreground" dir="ltr">{c.employeeNumber}</span></p>
            <p className="flex flex-wrap items-center gap-2"><span className="tnum">{fmtDate(c.attendanceDate)}</span><CorrectionTypeBadge type={c.type} /><CorrectionSummary c={c} timezone={timezone} /></p>
            <p className="text-xs text-muted-foreground">{c.reason}</p>
          </div>
        ) : null}
        <FormField label={t('decision.comment')} htmlFor="dec-comment" required={reject} optional={!reject} error={missing && comment.length === 0 && decide.isError ? t('decision.commentRequired') : undefined}>
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
